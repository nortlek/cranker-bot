import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  TransactionReceiptNotFoundError,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
} from "viem";

import { fwaAbi, poolAbi } from "./abi.js";
import { nextBlockBaseFeePerGas } from "./base-fee.js";
import { quoteCompetitiveFees } from "./bidding.js";
import type { KeeperConfig } from "./config.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import {
  FlashbotsRelay,
  simulatedGasUsed,
  submitBundleToRelays,
  successfulPrefixLength,
} from "./flashbots.js";
import {
  errorFingerprint,
  errorMessage,
  eth,
  gwei,
  log,
} from "./format.js";
import type { TargetBoundReadResult } from "./heads.js";
import {
  ACQUISITION_STATUS,
  acquisitionProcessCount,
  estimatePoolBounty,
  ROUND_STATE,
} from "./lifecycle.js";
import type { PendingFwaBundlePrerequisite } from "./pending-fwa-fulfillment.js";
import {
  SignerSubmissionCoordinator,
  signerNonceIsUsable,
} from "./signer-coordinator.js";

export interface PendingFwaBackrunResult {
  readonly status: "confirmed" | "expired" | "skipped";
  readonly reason: string;
  readonly targetBlock?: bigint;
  readonly syncHash?: Hash;
  readonly settleHash?: Hash;
  readonly processHash?: Hash;
  readonly realizedProfitWei?: bigint;
}

export async function executePendingFwaBackrunWithRetargets(
  parameters: {
    readonly execute: (
      parentBlock: bigint,
    ) => Promise<PendingFwaBackrunResult>;
    readonly getAuthoritativeHead: () => bigint;
    readonly isPrerequisiteCurrent: () => boolean;
    readonly isPrerequisitePending: () => Promise<boolean>;
    readonly prerequisiteHash: Hash;
    readonly requestId: bigint;
    readonly maximumTargetAttempts?: number;
    readonly signal?: AbortSignal;
  },
): Promise<PendingFwaBackrunResult> {
  const maximumTargetAttempts =
    parameters.maximumTargetAttempts ?? 3;
  if (
    !Number.isSafeInteger(maximumTargetAttempts) ||
    maximumTargetAttempts < 1 ||
    maximumTargetAttempts > 8
  ) {
    throw new Error(
      "pending FWA maximum target attempts must be between 1 and 8",
    );
  }
  let parentBlock = parameters.getAuthoritativeHead();
  for (
    let attempt = 1;
    attempt <= maximumTargetAttempts;
    attempt += 1
  ) {
    const result = await parameters.execute(parentBlock);
    if (
      result.status !== "skipped" ||
      result.reason !== "target_block_arrived" ||
      attempt === maximumTargetAttempts ||
      abortRequested(parameters.signal) ||
      !parameters.isPrerequisiteCurrent()
    ) {
      return result;
    }
    let stillPending: boolean;
    try {
      stillPending =
        await parameters.isPrerequisitePending();
    } catch (error) {
      log("debug", "pending_fwa_retarget_gate_failed", {
        prerequisiteHash: parameters.prerequisiteHash,
        requestId: parameters.requestId.toString(),
        completedTargetBlock:
          result.targetBlock?.toString() ?? "",
        ...errorFingerprint(error),
      });
      return result;
    }
    if (
      !stillPending ||
      !parameters.isPrerequisiteCurrent()
    ) {
      return result;
    }
    const completedTargetBlock = result.targetBlock;
    if (completedTargetBlock === undefined) {
      log("debug", "pending_fwa_retarget_gate_failed", {
        prerequisiteHash: parameters.prerequisiteHash,
        requestId: parameters.requestId.toString(),
        completedTargetBlock: "",
        reason: "completed_target_block_unavailable",
      });
      return result;
    }
    const retargetParentBlock =
      parameters.getAuthoritativeHead();
    if (
      retargetParentBlock < completedTargetBlock ||
      retargetParentBlock <= parentBlock
    ) {
      log("debug", "pending_fwa_retarget_gate_failed", {
        prerequisiteHash: parameters.prerequisiteHash,
        requestId: parameters.requestId.toString(),
        completedTargetBlock:
          completedTargetBlock.toString(),
        previousParentBlock: parentBlock.toString(),
        authoritativeHead: retargetParentBlock.toString(),
        reason: "authoritative_head_not_advanced",
      });
      return result;
    }
    parentBlock = retargetParentBlock;
    log("info", "pending_fwa_backrun_retargeted", {
      prerequisiteHash: parameters.prerequisiteHash,
      requestId: parameters.requestId.toString(),
      completedTargetBlock:
        completedTargetBlock.toString(),
      retargetParentBlock: parentBlock.toString(),
      nextTargetBlock: (parentBlock + 1n).toString(),
      nextTargetAttempt: attempt + 1,
      maximumTargetAttempts,
      reason: "prerequisite_still_pending",
    });
  }
  throw new Error("unreachable pending FWA retarget state");
}

interface ExactPendingFwaLifecycle {
  readonly signedProcess?: Hex;
  readonly signedSync: Hex;
  readonly signedSettle: Hex;
  readonly processGasUsed?: bigint;
  readonly syncGasUsed: bigint;
  readonly settleGasUsed: bigint;
  readonly processGasLimit?: bigint;
  readonly syncGasLimit: bigint;
  readonly settleGasLimit: bigint;
  readonly processCount?: bigint;
  readonly grossReward: bigint;
  readonly maxFeePerGas: bigint;
  readonly expectedGasPrice: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly effectiveBuilderBidBps: bigint;
  readonly expectedProfit: bigint;
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function fulfillmentLifecycleBundle(
  prerequisites: readonly Hex[],
  process: Hex | undefined,
  sync: Hex,
  settle: Hex,
): readonly Hex[] {
  if (
    prerequisites.length === 0 ||
    prerequisites.some((transaction) => transaction === "0x") ||
    process === "0x" ||
    sync === "0x" ||
    settle === "0x"
  ) {
    throw new Error(
      "pending FWA fulfillment lifecycle bundle cannot contain empty transactions",
    );
  }
  return [
    ...prerequisites,
    ...(process === undefined ? [] : [process]),
    sync,
    settle,
  ];
}

export interface PendingFwaLifecycleGas {
  readonly process?: bigint;
  readonly sync: bigint;
  readonly settle: bigint;
}

export function pendingFwaLifecycleGasUsed(parameters: {
  readonly simulation: Parameters<typeof simulatedGasUsed>[0];
  readonly prerequisiteCount: number;
  readonly includesProcessor: boolean;
}): PendingFwaLifecycleGas {
  if (
    !Number.isSafeInteger(parameters.prerequisiteCount) ||
    parameters.prerequisiteCount < 1
  ) {
    throw new Error(
      "pending FWA lifecycle requires at least one prerequisite",
    );
  }
  const processOffset = parameters.includesProcessor ? 1 : 0;
  const transactionCount =
    parameters.prerequisiteCount + processOffset + 2;
  if (
    successfulPrefixLength(
      parameters.simulation,
      transactionCount,
    ) !== transactionCount
  ) {
    throw new Error(
      "pending FWA fulfillment, sync, and settle did not all simulate",
    );
  }
  const gas = simulatedGasUsed(
    parameters.simulation,
    transactionCount,
  );
  const processGas = parameters.includesProcessor
    ? gas[parameters.prerequisiteCount]
    : undefined;
  const syncGas =
    gas[parameters.prerequisiteCount + processOffset];
  const settleGas =
    gas[parameters.prerequisiteCount + processOffset + 1];
  if (syncGas === undefined || settleGas === undefined) {
    throw new Error(
      "pending FWA lifecycle simulation omitted keeper gas usage",
    );
  }
  if (parameters.includesProcessor && processGas === undefined) {
    throw new Error(
      "pending FWA lifecycle simulation omitted processor gas usage",
    );
  }
  return {
    ...(processGas === undefined ? {} : { process: processGas }),
    sync: syncGas,
    settle: settleGas,
  };
}

function sameFeeQuote(
  left: {
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
  },
  right: {
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
  },
): boolean {
  return (
    left.maxFeePerGas === right.maxFeePerGas &&
    left.maxPriorityFeePerGas === right.maxPriorityFeePerGas
  );
}

function simulationFeeEnvelope(
  expectedGasPrice: bigint,
  configuredMaximum: bigint,
): bigint {
  return expectedGasPrice < configuredMaximum
    ? expectedGasPrice + 1n
    : expectedGasPrice;
}

async function simulatePendingFwaBundle(parameters: {
  readonly relay: FlashbotsRelay;
  readonly transactions: readonly Hex[];
  readonly targetBlock: bigint;
}): Promise<
  Awaited<ReturnType<FlashbotsRelay["callBundle"]>>
> {
  const startedAt = performance.now();
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const result = await parameters.relay.callBundle(
        parameters.transactions,
        parameters.targetBlock,
      );
      if (attempt > 1) {
        log("info", "pending_fwa_simulation_availability_waited", {
          targetBlock: parameters.targetBlock.toString(),
          attempts: attempt,
          waitMs: performance.now() - startedAt,
          reason: "relay_future_base_fee_publication_skew",
        });
      }
      return result;
    } catch (error) {
      if (
        attempt === 6 ||
        !/max fee per gas less than block base fee/i.test(
          errorMessage(error),
        )
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  throw new Error("unreachable pending FWA simulation state");
}

async function signLifecycle(parameters: {
  readonly signer: PrivateKeyAccount;
  readonly fwa: Address;
  readonly pool: Address;
  readonly roundId: bigint;
  readonly nonce: number;
  readonly processCount?: bigint;
  readonly processGas?: bigint;
  readonly syncGas: bigint;
  readonly settleGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}): Promise<{
  readonly process?: Hex;
  readonly sync: Hex;
  readonly settle: Hex;
}> {
  const includesProcessor =
    parameters.processCount !== undefined &&
    parameters.processGas !== undefined;
  if (
    (parameters.processCount === undefined) !==
    (parameters.processGas === undefined)
  ) {
    throw new Error(
      "pending FWA processor count and gas must be provided together",
    );
  }
  const process = includesProcessor
    ? await parameters.signer.signTransaction({
        chainId: 1,
        type: "eip1559",
        to: parameters.fwa,
        data: encodeFunctionData({
          abi: fwaAbi,
          functionName: "processAcquisitions",
          args: [parameters.processCount!],
        }),
        gas: parameters.processGas!,
        maxFeePerGas: parameters.maxFeePerGas,
        maxPriorityFeePerGas:
          parameters.maxPriorityFeePerGas,
        nonce: parameters.nonce,
        value: 0n,
      })
    : undefined;
  const syncNonce =
    parameters.nonce + (includesProcessor ? 1 : 0);
  const [sync, settle] = await Promise.all([
    parameters.signer.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: parameters.pool,
      data: encodeFunctionData({
        abi: poolAbi,
        functionName: "syncFwaResult",
        args: [parameters.roundId],
      }),
      gas: parameters.syncGas,
      maxFeePerGas: parameters.maxFeePerGas,
      maxPriorityFeePerGas: parameters.maxPriorityFeePerGas,
      nonce: syncNonce,
      value: 0n,
    }),
    parameters.signer.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: parameters.pool,
      data: encodeFunctionData({
        abi: poolAbi,
        functionName: "settle",
        args: [parameters.roundId],
      }),
      gas: parameters.settleGas,
      maxFeePerGas: parameters.maxFeePerGas,
      maxPriorityFeePerGas: parameters.maxPriorityFeePerGas,
      nonce: syncNonce + 1,
      value: 0n,
    }),
  ]);
  return {
    ...(process === undefined ? {} : { process }),
    sync,
    settle,
  };
}

async function exactPricedLifecycle(parameters: {
  readonly relay: FlashbotsRelay;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: PendingFwaBundlePrerequisite;
  readonly fwa: Address;
  readonly pool: Address;
  readonly roundId: bigint;
  readonly processCount?: bigint;
  readonly targetBlock: bigint;
  readonly nonce: number;
  readonly accountBalance: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly crankBountyCap: bigint;
  readonly bountyTipWei: bigint;
  readonly builderBidBps: bigint;
  readonly config: KeeperConfig;
}): Promise<ExactPendingFwaLifecycle | undefined> {
  if (parameters.baseFeeAllowancePerGas <= 0n) return undefined;
  const includesProcessor =
    parameters.processCount !== undefined;
  const preliminaryReservation =
    ((includesProcessor
      ? parameters.config.fwaProcessGasLimit
      : 0n) +
      parameters.config.poolSyncGasLimit +
      parameters.config.poolSettleGasLimit) *
    simulationFeeEnvelope(
      parameters.baseFeeAllowancePerGas,
      parameters.config.maxFeePerGas,
    );
  if (preliminaryReservation > parameters.accountBalance) {
    return undefined;
  }
  const preliminary = await signLifecycle({
    signer: parameters.signer,
    fwa: parameters.fwa,
    pool: parameters.pool,
    roundId: parameters.roundId,
    nonce: parameters.nonce,
    ...(parameters.processCount === undefined
      ? {}
      : {
          processCount: parameters.processCount,
          processGas: parameters.config.fwaProcessGasLimit,
        }),
    syncGas: parameters.config.poolSyncGasLimit,
    settleGas: parameters.config.poolSettleGasLimit,
    maxFeePerGas: simulationFeeEnvelope(
      parameters.baseFeeAllowancePerGas,
      parameters.config.maxFeePerGas,
    ),
    maxPriorityFeePerGas: 0n,
  });
  const preliminarySimulation =
    await simulatePendingFwaBundle({
      relay: parameters.relay,
      transactions: fulfillmentLifecycleBundle(
        parameters.prerequisite.prerequisiteTransactions.map(
          (transaction) => transaction.rawTransaction,
        ),
        preliminary.process,
        preliminary.sync,
        preliminary.settle,
      ),
      targetBlock: parameters.targetBlock,
    });
  let preliminaryGas = pendingFwaLifecycleGasUsed({
    simulation: preliminarySimulation,
    prerequisiteCount:
      parameters.prerequisite.prerequisiteTransactions.length,
    includesProcessor,
  });
  let processGasUsed = preliminaryGas.process;
  let syncGasUsed = preliminaryGas.sync;
  let settleGasUsed = preliminaryGas.settle;
  let grossReward =
    estimatePoolBounty({
      gasUsed: syncGasUsed,
      baseFeePerGas: parameters.baseFeeAllowancePerGas,
      terms: {
        crankBountyCap: parameters.crankBountyCap,
        bountyTipWei: parameters.bountyTipWei,
      },
      estimateBps: parameters.config.poolBountyEstimateBps,
    }) +
    estimatePoolBounty({
      gasUsed: settleGasUsed,
      baseFeePerGas: parameters.baseFeeAllowancePerGas,
      terms: {
        crankBountyCap: parameters.crankBountyCap,
        bountyTipWei: parameters.bountyTipWei,
      },
      estimateBps: parameters.config.poolBountyEstimateBps,
    });
  let quote = quoteCompetitiveFees({
    crankFee: grossReward,
    simulatedGasUsed:
      (processGasUsed ?? 0n) + syncGasUsed + settleGasUsed,
    baseFeeAllowancePerGas: parameters.baseFeeAllowancePerGas,
    minimumPriorityFeePerGas:
      parameters.config.poolMinPriorityFeePerGas,
    builderBidBps: parameters.builderBidBps,
    maxFeePerGasCap: parameters.config.maxFeePerGas,
    minProfitWei: parameters.config.minProfitWei,
  });
  if (!quote.profitable) return undefined;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const bufferedProcessGasLimit =
      processGasUsed === undefined
        ? undefined
        : bufferedGas(
            processGasUsed,
            parameters.config.gasLimitMultiplierBps,
          );
    const processGasLimit =
      bufferedProcessGasLimit === undefined
        ? undefined
        : bufferedProcessGasLimit <
            parameters.config.fwaProcessGasLimit
          ? bufferedProcessGasLimit
          : parameters.config.fwaProcessGasLimit;
    const syncGasLimit = bufferedGas(
      syncGasUsed,
      parameters.config.gasLimitMultiplierBps,
    );
    const settleGasLimit = bufferedGas(
      settleGasUsed,
      parameters.config.gasLimitMultiplierBps,
    );
    const signedMaxFeePerGas = simulationFeeEnvelope(
      quote.maxFeePerGas,
      parameters.config.maxFeePerGas,
    );
    if (
      ((processGasLimit ?? 0n) +
        syncGasLimit +
        settleGasLimit) *
        signedMaxFeePerGas >
      parameters.accountBalance
    ) {
      return undefined;
    }
    const signed = await signLifecycle({
      signer: parameters.signer,
      fwa: parameters.fwa,
      pool: parameters.pool,
      roundId: parameters.roundId,
      nonce: parameters.nonce,
      ...(parameters.processCount === undefined ||
      processGasLimit === undefined
        ? {}
        : {
            processCount: parameters.processCount,
            processGas: processGasLimit,
          }),
      syncGas: syncGasLimit,
      settleGas: settleGasLimit,
      maxFeePerGas: signedMaxFeePerGas,
      maxPriorityFeePerGas:
        quote.maxPriorityFeePerGas,
    });
    const finalSimulation =
      await simulatePendingFwaBundle({
        relay: parameters.relay,
        transactions: fulfillmentLifecycleBundle(
          parameters.prerequisite.prerequisiteTransactions.map(
            (transaction) => transaction.rawTransaction,
          ),
          signed.process,
          signed.sync,
          signed.settle,
        ),
        targetBlock: parameters.targetBlock,
      });
    const finalGas = pendingFwaLifecycleGasUsed({
      simulation: finalSimulation,
      prerequisiteCount:
        parameters.prerequisite.prerequisiteTransactions.length,
      includesProcessor,
    });
    const finalProcessGas = finalGas.process;
    const finalSyncGas = finalGas.sync;
    const finalSettleGas = finalGas.settle;
    const finalGrossReward =
      estimatePoolBounty({
        gasUsed: finalSyncGas,
        baseFeePerGas: parameters.baseFeeAllowancePerGas,
        terms: {
          crankBountyCap: parameters.crankBountyCap,
          bountyTipWei: parameters.bountyTipWei,
        },
        estimateBps: parameters.config.poolBountyEstimateBps,
      }) +
      estimatePoolBounty({
        gasUsed: finalSettleGas,
        baseFeePerGas: parameters.baseFeeAllowancePerGas,
        terms: {
          crankBountyCap: parameters.crankBountyCap,
          bountyTipWei: parameters.bountyTipWei,
        },
        estimateBps: parameters.config.poolBountyEstimateBps,
      });
    const totalGasUsed =
      (finalProcessGas ?? 0n) +
      finalSyncGas +
      finalSettleGas;
    const repriced = quoteCompetitiveFees({
      crankFee: finalGrossReward,
      simulatedGasUsed: totalGasUsed,
      baseFeeAllowancePerGas:
        parameters.baseFeeAllowancePerGas,
      minimumPriorityFeePerGas:
        parameters.config.poolMinPriorityFeePerGas,
      builderBidBps: parameters.builderBidBps,
      maxFeePerGasCap: parameters.config.maxFeePerGas,
      minProfitWei: parameters.config.minProfitWei,
    });
    if (!repriced.profitable) return undefined;
    if (sameFeeQuote(quote, repriced)) {
      const expectedProfit =
        finalGrossReward -
        totalGasUsed * repriced.maxFeePerGas;
      if (
        expectedProfit <
        requiredProfit(parameters.config.minProfitWei)
      ) {
        return undefined;
      }
      return {
        ...(signed.process === undefined
          ? {}
          : { signedProcess: signed.process }),
        signedSync: signed.sync,
        signedSettle: signed.settle,
        ...(finalProcessGas === undefined
          ? {}
          : { processGasUsed: finalProcessGas }),
        syncGasUsed: finalSyncGas,
        settleGasUsed: finalSettleGas,
        ...(processGasLimit === undefined
          ? {}
          : { processGasLimit }),
        syncGasLimit,
        settleGasLimit,
        ...(parameters.processCount === undefined
          ? {}
          : { processCount: parameters.processCount }),
        grossReward: finalGrossReward,
        maxFeePerGas: simulationFeeEnvelope(
          repriced.maxFeePerGas,
          parameters.config.maxFeePerGas,
        ),
        expectedGasPrice: repriced.maxFeePerGas,
        maxPriorityFeePerGas:
          repriced.maxPriorityFeePerGas,
        effectiveBuilderBidBps:
          repriced.effectiveBuilderBidBps,
        expectedProfit,
      };
    }
    quote = repriced;
    processGasUsed = finalProcessGas;
    syncGasUsed = finalSyncGas;
    settleGasUsed = finalSettleGas;
    grossReward = finalGrossReward;
  }
  return undefined;
}

function decodedPoolBounty(parameters: {
  readonly pool: Address;
  readonly caller: Address;
  readonly roundId: bigint;
  readonly logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: [] | [Hex, ...Hex[]];
  }[];
}): bigint {
  let total = 0n;
  for (const entry of parameters.logs) {
    if (
      entry.address.toLowerCase() !==
      parameters.pool.toLowerCase()
    ) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: poolAbi,
        data: entry.data,
        topics: entry.topics,
      });
      if (
        decoded.eventName === "CrankBountyPaid" &&
        decoded.args.roundId === parameters.roundId &&
        decoded.args.cranker.toLowerCase() ===
          parameters.caller.toLowerCase()
      ) {
        total += decoded.args.amount;
      }
    } catch {
      // The pool emits several unrelated lifecycle events.
    }
  }
  return total;
}

async function queuedFwaProcessCount(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly fwa: Address;
  readonly requestId: bigint;
  readonly blockNumber: bigint;
  readonly maximumCount: number;
}): Promise<bigint | undefined> {
  const [nextSequence, lastIssuedSequence] =
    await Promise.all([
      parameters.client.readContract({
        address: parameters.fwa,
        abi: fwaAbi,
        functionName: "nextSequenceToProcess",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: parameters.fwa,
        abi: fwaAbi,
        functionName: "lastIssuedSequence",
        blockNumber: parameters.blockNumber,
      }),
    ]);
  const available =
    lastIssuedSequence < nextSequence
      ? 0n
      : lastIssuedSequence - nextSequence + 1n;
  const bounded =
    available < BigInt(parameters.maximumCount)
      ? available
      : BigInt(parameters.maximumCount);
  const sequences = Array.from(
    { length: Number(bounded) },
    (_, index) => nextSequence + BigInt(index),
  );
  if (sequences.length === 0) return undefined;
  const requestIds = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: sequences.map((sequence) => ({
      address: parameters.fwa,
      abi: fwaAbi,
      functionName: "requestIdAtSequence" as const,
      args: [sequence] as const,
    })),
  });
  return acquisitionProcessCount(
    parameters.requestId,
    requestIds,
  );
}

async function getReceiptOrUndefined(
  client: PublicClient<Transport, Chain>,
  hash: Hash,
): Promise<
  Awaited<ReturnType<typeof client.getTransactionReceipt>> | undefined
> {
  const startedAt = performance.now();
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      if (attempt > 1) {
        log("info", "keeper_receipt_availability_waited", {
          hash,
          attempts: attempt,
          waitMs: performance.now() - startedAt,
        });
      }
      return receipt;
    } catch (error) {
      if (
        !(error instanceof TransactionReceiptNotFoundError) ||
        attempt === 11
      ) {
        if (error instanceof TransactionReceiptNotFoundError) {
          return undefined;
        }
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  return undefined;
}

export async function executePendingFwaBackrun(parameters: {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly pendingClient: PublicClient<Transport, Chain>;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: PendingFwaBundlePrerequisite;
  readonly pool: Address;
  readonly fwa: Address;
  readonly relays: readonly FlashbotsRelay[];
  readonly builders: readonly string[];
  readonly config: KeeperConfig;
  readonly builderBidBps: bigint;
  readonly headBlockNumber: bigint;
  readonly targetBlockHasArrived: (
    targetBlock: bigint,
  ) => boolean;
  readonly coordinator: SignerSubmissionCoordinator;
  readonly assertSignerLeaseHeld: () => Promise<void>;
  readonly isPrerequisiteCurrent: () => boolean;
  readonly waitForTargetBlock: (
    targetBlock: bigint,
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly readBeforeTargetBlock: <Value>(parameters: {
    readonly targetBlock: bigint;
    readonly timeoutMs: number;
    readonly read: () => Promise<Value>;
  }) => Promise<TargetBoundReadResult<Value>>;
  readonly signal?: AbortSignal;
}): Promise<PendingFwaBackrunResult> {
  if (parameters.config.dryRun) {
    return { status: "skipped", reason: "dry_run" };
  }
  if (abortRequested(parameters.signal)) {
    return { status: "skipped", reason: "shutdown" };
  }

  const currentHead = parameters.headBlockNumber;
  const targetBlock = currentHead + 1n;
  const [latestNonce, pendingNonce] = await Promise.all([
    parameters.publicClient.getTransactionCount({
      address: parameters.signer.address,
      blockTag: "latest",
    }),
    parameters.publicClient.getTransactionCount({
      address: parameters.signer.address,
      blockTag: "pending",
    }),
  ]);
  if (latestNonce !== pendingNonce) {
    return {
      status: "skipped",
      reason: "signer_nonce_pending",
      targetBlock,
    };
  }
  const reservation = parameters.coordinator.tryReserve({
    targetBlock,
    nonce: latestNonce,
    lane: "pending_fwa_fulfillment_backrun",
  });
  if (reservation === undefined) {
    return {
      status: "skipped",
      reason: "signer_submission_slot_busy",
      targetBlock,
    };
  }

  let retainReservation = false;
  try {
    await parameters.assertSignerLeaseHeld();
    if (
      abortRequested(parameters.signal) ||
      !parameters.isPrerequisiteCurrent()
    ) {
      return {
        status: "skipped",
        reason: abortRequested(parameters.signal)
          ? "shutdown"
          : "prerequisite_replaced",
        targetBlock,
      };
    }
    const [
      parent,
      ethPendingRound,
      acquisition,
      accountBalance,
    ] = await Promise.all([
      parameters.publicClient.getBlock({
        blockNumber: currentHead,
      }),
      parameters.publicClient.readContract({
        address: parameters.pool,
        abi: poolAbi,
        functionName: "ethPendingRound",
        blockNumber: currentHead,
      }),
      parameters.publicClient.readContract({
        address: parameters.fwa,
        abi: fwaAbi,
        functionName: "acquisitions",
        args: [parameters.prerequisite.requestId],
        blockNumber: currentHead,
      }),
      parameters.publicClient.getBalance({
        address: parameters.signer.address,
        blockNumber: currentHead,
      }),
    ]);
    if (
      parent.baseFeePerGas === null ||
      ethPendingRound <= 0n
    ) {
      return {
        status: "skipped",
        reason:
          parent.baseFeePerGas === null
            ? "base_fee_unavailable"
            : "no_pending_lifecycle",
        targetBlock,
      };
    }
    const roundId = ethPendingRound;
    const round =
      await parameters.publicClient.readContract({
        address: parameters.pool,
        abi: poolAbi,
        functionName: "getRound",
        args: [roundId],
        blockNumber: currentHead,
      });
    if (
      round.state !== ROUND_STATE.pulling ||
      round.fwaResolved ||
      round.fwaRequestId !== parameters.prerequisite.requestId ||
      acquisition[0].toLowerCase() !==
        parameters.pool.toLowerCase() ||
      acquisition[4] !== ACQUISITION_STATUS.pending
    ) {
      return {
        status: "skipped",
        reason: "lifecycle_prerequisite_mismatch",
        targetBlock,
      };
    }
    const baseFeeAllowancePerGas =
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: parent.baseFeePerGas,
        parentGasUsed: parent.gasUsed,
        parentGasLimit: parent.gasLimit,
      });
    const processCount = await queuedFwaProcessCount({
      client: parameters.publicClient,
      fwa: parameters.fwa,
      requestId: parameters.prerequisite.requestId,
      blockNumber: currentHead,
      maximumCount: parameters.config.fwaProcessMaxCount,
    }).catch((error: unknown) => {
      log("debug", "pending_fwa_process_count_unavailable", {
        prerequisiteHash: parameters.prerequisite.hash,
        requestId:
          parameters.prerequisite.requestId.toString(),
        targetBlock: targetBlock.toString(),
        ...errorFingerprint(error),
      });
      return undefined;
    });
    const variants = [
      { name: "direct" as const },
      ...(processCount === undefined
        ? []
        : [
            {
              name: "processor" as const,
              processCount,
            },
          ]),
    ];
    const exactCandidates = (
      await Promise.all(
        variants.map(async (variant) =>
          exactPricedLifecycle({
            relay: parameters.relays[0]!,
            signer: parameters.signer,
            prerequisite: parameters.prerequisite,
            fwa: parameters.fwa,
            pool: parameters.pool,
            roundId,
            ...(variant.name === "processor"
              ? { processCount: variant.processCount }
              : {}),
            targetBlock,
            nonce: latestNonce,
            accountBalance,
            baseFeeAllowancePerGas,
            crankBountyCap: round.crankBountyCap,
            bountyTipWei: round.bountyTipWei,
            builderBidBps: parameters.builderBidBps,
            config: parameters.config,
          }).catch((error: unknown) => {
            log(
              "debug",
              "pending_fwa_backrun_simulation_failed",
              {
                prerequisiteHash:
                  parameters.prerequisite.hash,
                requestId:
                  parameters.prerequisite.requestId.toString(),
                round: roundId.toString(),
                targetBlock: targetBlock.toString(),
                variant: variant.name,
                ...errorFingerprint(error),
              },
            );
            return undefined;
          }),
        ),
      )
    ).filter(
      (
        candidate,
      ): candidate is ExactPendingFwaLifecycle =>
        candidate !== undefined,
    );
    exactCandidates.sort((left, right) =>
      left.expectedProfit === right.expectedProfit
        ? Number(
            (left.processCount === undefined ? 0 : 1) -
              (right.processCount === undefined ? 0 : 1),
          )
        : left.expectedProfit > right.expectedProfit
          ? -1
          : 1,
    );
    const exact = exactCandidates[0];
    if (abortRequested(parameters.signal)) {
      return {
        status: "skipped",
        reason: "shutdown",
        targetBlock,
      };
    }
    if (exact === undefined) {
      return {
        status: "skipped",
        reason: "exact_simulation_or_profit_gate",
        targetBlock,
      };
    }
    log("info", "pending_fwa_backrun_opportunity", {
      prerequisiteHash: parameters.prerequisite.hash,
      requestId: parameters.prerequisite.requestId.toString(),
      round: roundId.toString(),
      prerequisiteCount:
        parameters.prerequisite.prerequisiteTransactions.length,
      processorIncluded: exact.processCount !== undefined,
      processCount: exact.processCount?.toString() ?? "",
      processGasUsed:
        exact.processGasUsed?.toString() ?? "",
      syncGasUsed: exact.syncGasUsed.toString(),
      settleGasUsed: exact.settleGasUsed.toString(),
      grossReward: eth(exact.grossReward),
      builderBidBps: parameters.builderBidBps.toString(),
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
      maxFeePerGas: gwei(exact.maxFeePerGas),
      expectedGasPrice: gwei(exact.expectedGasPrice),
      maxPriorityFeePerGas: gwei(
        exact.maxPriorityFeePerGas,
      ),
      expectedProfit: eth(exact.expectedProfit),
      targetBlock: targetBlock.toString(),
    });

    const finalGate = await parameters.readBeforeTargetBlock({
      targetBlock,
      timeoutMs: Math.min(
        parameters.config.receiptTimeoutMs,
        parameters.config.headStaleTimeoutMs,
      ),
      read: () =>
        Promise.all([
          Promise.all(
            parameters.prerequisite.prerequisiteTransactions.map(
              async (prerequisite) => {
                const [transaction, rawTransaction] =
                  await Promise.all([
                    parameters.pendingClient
                      .getTransaction({
                        hash: prerequisite.hash,
                      })
                      .catch(() => undefined),
                    parameters.pendingClient
                      .getRawTransaction({
                        hash: prerequisite.hash,
                      })
                      .catch(() => undefined),
                  ]);
                return {
                  prerequisite,
                  transaction,
                  rawTransaction,
                };
              },
            ),
          ),
          parameters.publicClient.getTransactionCount({
            address: parameters.signer.address,
            blockNumber: currentHead,
          }),
          parameters.publicClient.getTransactionCount({
            address: parameters.signer.address,
            blockTag: "pending",
          }),
          parameters.publicClient.getBalance({
            address: parameters.signer.address,
            blockNumber: currentHead,
          }),
        ]),
    });
    if (finalGate.status === "target_observed") {
      return {
        status: "skipped",
        reason: "target_block_arrived",
        targetBlock,
      };
    }
    const [
      currentPrerequisites,
      finalLatestNonce,
      finalPendingNonce,
      finalBalance,
    ] = finalGate.value;
    const finalRequiredBalance =
      ((exact.processGasLimit ?? 0n) +
        exact.syncGasLimit +
        exact.settleGasLimit) *
      exact.maxFeePerGas;
    if (
      abortRequested(parameters.signal) ||
      currentPrerequisites.some(
        ({ prerequisite, transaction, rawTransaction }) =>
          transaction === undefined ||
          rawTransaction === undefined ||
          rawTransaction.toLowerCase() !==
            prerequisite.rawTransaction.toLowerCase() ||
          transaction.blockNumber !== null,
      ) ||
      !parameters.isPrerequisiteCurrent() ||
      parameters.coordinator.reservationFor(targetBlock)?.id !==
        reservation.id ||
      finalBalance < finalRequiredBalance ||
      !signerNonceIsUsable({
        account: parameters.signer.address,
        expectedNonce: latestNonce,
        latestNonce: finalLatestNonce,
        pendingNonce: finalPendingNonce,
      })
    ) {
      return {
        status: "skipped",
        reason: "final_pending_state_gate",
        targetBlock,
      };
    }
    await parameters.assertSignerLeaseHeld();
    if (
      abortRequested(parameters.signal) ||
      parameters.targetBlockHasArrived(targetBlock)
    ) {
      return {
        status: "skipped",
        reason: abortRequested(parameters.signal)
          ? "shutdown"
          : "target_block_arrived",
        targetBlock,
      };
    }
    const transactions = fulfillmentLifecycleBundle(
      parameters.prerequisite.prerequisiteTransactions.map(
        (transaction) => transaction.rawTransaction,
      ),
      exact.signedProcess,
      exact.signedSync,
      exact.signedSettle,
    );
    const submissions = await submitBundleToRelays(
      parameters.relays,
      transactions,
      targetBlock,
      parameters.builders,
    );
    retainReservation = true;
    const processorIncluded =
      exact.signedProcess !== undefined;
    const syncNonce =
      latestNonce + (processorIncluded ? 1 : 0);
    const processHash =
      exact.signedProcess === undefined
        ? undefined
        : keccak256(exact.signedProcess);
    const syncHash = keccak256(exact.signedSync);
    const settleHash = keccak256(exact.signedSettle);
    const keeperMembers: {
      readonly kind: "fwa_process" | "pool_sync" | "pool_settle";
      readonly label: string;
      readonly hash: Hash;
      readonly nonce: number;
    }[] = [
      ...(processHash === undefined
        ? []
        : [
            {
              kind: "fwa_process" as const,
              label: `pending_fwa_process:${exact.processCount}`,
              hash: processHash,
              nonce: latestNonce,
            },
          ]),
      {
        kind: "pool_sync",
        label: `pending_fwa_sync:${roundId}`,
        hash: syncHash,
        nonce: syncNonce,
      },
      {
        kind: "pool_settle",
        label: `pending_fwa_settle:${roundId}`,
        hash: settleHash,
        nonce: syncNonce + 1,
      },
    ];
    const keeperKinds = keeperMembers.map(
      (member) => member.kind,
    );
    log("info", "pending_fwa_backrun_submitted", {
      prerequisiteHash: parameters.prerequisite.hash,
      requestId: parameters.prerequisite.requestId.toString(),
      round: roundId.toString(),
      processHash: processHash ?? "",
      syncHash,
      settleHash,
      nonce: latestNonce,
      targetBlock: targetBlock.toString(),
      relayCount: new Set(
        submissions.map((submission) => submission.relayUrl),
      ).size,
      bundleCount: submissions.length,
      transactionCount: transactions.length,
      prerequisiteCount:
        parameters.prerequisite.prerequisiteTransactions.length,
      keeperTransactionCount: keeperMembers.length,
      processCount: exact.processCount?.toString() ?? "",
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
    });
    log("info", "keeper_batch_submitted", {
      kinds: JSON.stringify(keeperKinds),
      transactionCount: keeperMembers.length,
      firstNonce: latestNonce,
      lastNonce: latestNonce + keeperMembers.length - 1,
      targetBlock: targetBlock.toString(),
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
      relayCount: new Set(
        submissions.map((submission) => submission.relayUrl),
      ).size,
      prerequisiteHash: parameters.prerequisite.hash,
    });
    for (
      let index = 0;
      index < keeperMembers.length;
      index += 1
    ) {
      const member = keeperMembers[index]!;
      log("info", "keeper_transaction_sent", {
        kind: member.kind,
        label: member.label,
        hash: member.hash,
        nonce: member.nonce,
        mode: "flashbots",
        targetBlock: targetBlock.toString(),
        prerequisiteHash: parameters.prerequisite.hash,
        batchTransactionCount: keeperMembers.length,
        batchPosition: index + 1,
      });
    }

    const observed = await parameters.waitForTargetBlock(
      targetBlock,
      Math.min(
        parameters.config.receiptTimeoutMs,
        parameters.config.headStaleTimeoutMs,
      ),
    );
    if (!observed) {
      return {
        status: "expired",
        reason: "target_block_unobserved",
        targetBlock,
        ...(processHash === undefined ? {} : { processHash }),
        syncHash,
        settleHash,
      };
    }
    const receipts = await Promise.all(
      keeperMembers.map((member) =>
        getReceiptOrUndefined(
          parameters.publicClient,
          member.hash,
        ),
      ),
    );
    let confirmedTransactions = 0;
    let revertedTransactions = 0;
    let expiredTransactions = 0;
    let totalReward = 0n;
    let totalGasCost = 0n;
    for (
      let index = 0;
      index < keeperMembers.length;
      index += 1
    ) {
      const member = keeperMembers[index]!;
      const receipt = receipts[index];
      const batchPosition = index + 1;
      if (
        receipt === undefined ||
        receipt.blockNumber !== targetBlock
      ) {
        expiredTransactions += 1;
        log("warn", "keeper_transaction_expired", {
          kind: member.kind,
          label: member.label,
          hash: member.hash,
          nonce: member.nonce,
          targetBlock: targetBlock.toString(),
          prerequisiteHash: parameters.prerequisite.hash,
          reason: "private lifecycle transaction was not included",
          batchTransactionCount: keeperMembers.length,
          batchPosition,
          batchTargetBlock: targetBlock.toString(),
        });
        continue;
      }
      const paidReward =
        receipt.status === "success" &&
        member.kind !== "fwa_process"
          ? decodedPoolBounty({
              pool: parameters.pool,
              caller: parameters.signer.address,
              roundId,
              logs: receipt.logs,
            })
          : 0n;
      const gasCost =
        receipt.gasUsed * receipt.effectiveGasPrice;
      totalReward += paidReward;
      totalGasCost += gasCost;
      if (receipt.status === "success") {
        confirmedTransactions += 1;
      } else {
        revertedTransactions += 1;
      }
      log("info", "keeper_receipt", {
        kind: member.kind,
        label: member.label,
        hash: member.hash,
        nonce: member.nonce,
        block: receipt.blockNumber.toString(),
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        paidReward: eth(paidReward),
        gasCost: eth(gasCost),
        realizedProfit: eth(paidReward - gasCost),
        prerequisiteHash: parameters.prerequisite.hash,
        expectedBlock: targetBlock.toString(),
        targetBlockMatched: true,
        batchTransactionCount: keeperMembers.length,
        batchPosition,
        batchTargetBlock: targetBlock.toString(),
      });
    }
    const realizedProfit = totalReward - totalGasCost;
    log("info", "keeper_batch_result", {
      kind: "pending_fwa_fulfillment_backrun",
      kinds: JSON.stringify(keeperKinds),
      round: roundId.toString(),
      block:
        confirmedTransactions + revertedTransactions > 0
          ? targetBlock.toString()
          : "",
      targetBlock: targetBlock.toString(),
      transactionCount: keeperMembers.length,
      includedCount:
        confirmedTransactions + revertedTransactions,
      confirmedTransactions,
      revertedTransactions,
      expiredTransactions,
      totalReward: eth(totalReward),
      totalGasCost: eth(totalGasCost),
      totalTransactionValue: eth(0n),
      realizedProfit: eth(realizedProfit),
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
    });
    if (
      confirmedTransactions === keeperMembers.length &&
      revertedTransactions === 0 &&
      expiredTransactions === 0
    ) {
      return {
        status: "confirmed",
        reason: "confirmed",
        targetBlock,
        ...(processHash === undefined ? {} : { processHash }),
        syncHash,
        settleHash,
        realizedProfitWei: realizedProfit,
      };
    }
    return {
      status: "expired",
      reason:
        expiredTransactions === keeperMembers.length
          ? "lifecycle_not_included"
          : revertedTransactions > 0
            ? "lifecycle_reverted"
            : "lifecycle_partial",
      targetBlock,
      ...(processHash === undefined ? {} : { processHash }),
      syncHash,
      settleHash,
      realizedProfitWei: realizedProfit,
    };
  } finally {
    if (!retainReservation) {
      parameters.coordinator.release(reservation);
    }
  }
}
