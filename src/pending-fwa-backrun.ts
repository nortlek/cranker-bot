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
import { errorMessage, eth, gwei, log } from "./format.js";
import type { TargetBoundReadResult } from "./heads.js";
import {
  ACQUISITION_STATUS,
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
  readonly realizedProfitWei?: bigint;
}

interface ExactPendingFwaLifecycle {
  readonly signedSync: Hex;
  readonly signedSettle: Hex;
  readonly syncGasUsed: bigint;
  readonly settleGasUsed: bigint;
  readonly syncGasLimit: bigint;
  readonly settleGasLimit: bigint;
  readonly grossReward: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly effectiveBuilderBidBps: bigint;
  readonly expectedProfit: bigint;
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function fulfillmentLifecycleBundle(
  prerequisites: readonly Hex[],
  sync: Hex,
  settle: Hex,
): readonly Hex[] {
  if (
    prerequisites.length === 0 ||
    prerequisites.some((transaction) => transaction === "0x") ||
    sync === "0x" ||
    settle === "0x"
  ) {
    throw new Error(
      "pending FWA fulfillment lifecycle bundle cannot contain empty transactions",
    );
  }
  return [...prerequisites, sync, settle];
}

export function pendingFwaLifecycleGasUsed(parameters: {
  readonly simulation: Parameters<typeof simulatedGasUsed>[0];
  readonly prerequisiteCount: number;
}): readonly [bigint, bigint] {
  if (
    !Number.isSafeInteger(parameters.prerequisiteCount) ||
    parameters.prerequisiteCount < 1
  ) {
    throw new Error(
      "pending FWA lifecycle requires at least one prerequisite",
    );
  }
  const transactionCount = parameters.prerequisiteCount + 2;
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
  const syncGas = gas[parameters.prerequisiteCount];
  const settleGas = gas[parameters.prerequisiteCount + 1];
  if (syncGas === undefined || settleGas === undefined) {
    throw new Error(
      "pending FWA lifecycle simulation omitted keeper gas usage",
    );
  }
  return [syncGas, settleGas];
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

async function signLifecycle(parameters: {
  readonly signer: PrivateKeyAccount;
  readonly pool: Address;
  readonly roundId: bigint;
  readonly nonce: number;
  readonly syncGas: bigint;
  readonly settleGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}): Promise<readonly [Hex, Hex]> {
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
      nonce: parameters.nonce,
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
      nonce: parameters.nonce + 1,
      value: 0n,
    }),
  ]);
  return [sync, settle];
}

async function exactPricedLifecycle(parameters: {
  readonly relay: FlashbotsRelay;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: PendingFwaBundlePrerequisite;
  readonly pool: Address;
  readonly roundId: bigint;
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
  const preliminaryReservation =
    (parameters.config.poolSyncGasLimit +
      parameters.config.poolSettleGasLimit) *
    parameters.baseFeeAllowancePerGas;
  if (preliminaryReservation > parameters.accountBalance) {
    return undefined;
  }
  const [preliminarySync, preliminarySettle] =
    await signLifecycle({
      signer: parameters.signer,
      pool: parameters.pool,
      roundId: parameters.roundId,
      nonce: parameters.nonce,
      syncGas: parameters.config.poolSyncGasLimit,
      settleGas: parameters.config.poolSettleGasLimit,
      maxFeePerGas: parameters.baseFeeAllowancePerGas,
      maxPriorityFeePerGas: 0n,
    });
  const preliminarySimulation =
    await parameters.relay.callBundle(
      fulfillmentLifecycleBundle(
        parameters.prerequisite.prerequisiteTransactions.map(
          (transaction) => transaction.rawTransaction,
        ),
        preliminarySync,
        preliminarySettle,
      ),
      parameters.targetBlock,
    );
  let [syncGasUsed, settleGasUsed] =
    pendingFwaLifecycleGasUsed({
      simulation: preliminarySimulation,
      prerequisiteCount:
        parameters.prerequisite.prerequisiteTransactions.length,
    });
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
    simulatedGasUsed: syncGasUsed + settleGasUsed,
    baseFeeAllowancePerGas: parameters.baseFeeAllowancePerGas,
    minimumPriorityFeePerGas:
      parameters.config.poolMinPriorityFeePerGas,
    builderBidBps: parameters.builderBidBps,
    maxFeePerGasCap: parameters.config.maxFeePerGas,
    minProfitWei: parameters.config.minProfitWei,
  });
  if (!quote.profitable) return undefined;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const syncGasLimit = bufferedGas(
      syncGasUsed,
      parameters.config.gasLimitMultiplierBps,
    );
    const settleGasLimit = bufferedGas(
      settleGasUsed,
      parameters.config.gasLimitMultiplierBps,
    );
    if (
      (syncGasLimit + settleGasLimit) *
        quote.maxFeePerGas >
      parameters.accountBalance
    ) {
      return undefined;
    }
    const [signedSync, signedSettle] =
      await signLifecycle({
        signer: parameters.signer,
        pool: parameters.pool,
        roundId: parameters.roundId,
        nonce: parameters.nonce,
        syncGas: syncGasLimit,
        settleGas: settleGasLimit,
        maxFeePerGas: quote.maxFeePerGas,
        maxPriorityFeePerGas:
          quote.maxPriorityFeePerGas,
      });
    const finalSimulation =
      await parameters.relay.callBundle(
        fulfillmentLifecycleBundle(
          parameters.prerequisite.prerequisiteTransactions.map(
            (transaction) => transaction.rawTransaction,
          ),
          signedSync,
          signedSettle,
        ),
        parameters.targetBlock,
      );
    const [finalSyncGas, finalSettleGas] =
      pendingFwaLifecycleGasUsed({
        simulation: finalSimulation,
        prerequisiteCount:
          parameters.prerequisite.prerequisiteTransactions.length,
      });
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
    const totalGasUsed = finalSyncGas + finalSettleGas;
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
        signedSync,
        signedSettle,
        syncGasUsed: finalSyncGas,
        settleGasUsed: finalSettleGas,
        syncGasLimit,
        settleGasLimit,
        grossReward: finalGrossReward,
        maxFeePerGas: repriced.maxFeePerGas,
        maxPriorityFeePerGas:
          repriced.maxPriorityFeePerGas,
        effectiveBuilderBidBps:
          repriced.effectiveBuilderBidBps,
        expectedProfit,
      };
    }
    quote = repriced;
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

  const currentHead =
    await parameters.publicClient.getBlockNumber();
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
    const exact = await exactPricedLifecycle({
      relay: parameters.relays[0]!,
      signer: parameters.signer,
      prerequisite: parameters.prerequisite,
      pool: parameters.pool,
      roundId,
      targetBlock,
      nonce: latestNonce,
      accountBalance,
      baseFeeAllowancePerGas,
      crankBountyCap: round.crankBountyCap,
      bountyTipWei: round.bountyTipWei,
      builderBidBps: parameters.builderBidBps,
      config: parameters.config,
    }).catch((error: unknown) => {
      log("debug", "pending_fwa_backrun_simulation_failed", {
        prerequisiteHash: parameters.prerequisite.hash,
        requestId:
          parameters.prerequisite.requestId.toString(),
        round: roundId.toString(),
        targetBlock: targetBlock.toString(),
        reason: errorMessage(error),
      });
      return undefined;
    });
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
      syncGasUsed: exact.syncGasUsed.toString(),
      settleGasUsed: exact.settleGasUsed.toString(),
      grossReward: eth(exact.grossReward),
      builderBidBps: parameters.builderBidBps.toString(),
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
      maxFeePerGas: gwei(exact.maxFeePerGas),
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
      (exact.syncGasLimit + exact.settleGasLimit) *
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
      (await parameters.publicClient.getBlockNumber()) >=
        targetBlock
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
    const syncHash = keccak256(exact.signedSync);
    const settleHash = keccak256(exact.signedSettle);
    log("info", "pending_fwa_backrun_submitted", {
      prerequisiteHash: parameters.prerequisite.hash,
      requestId: parameters.prerequisite.requestId.toString(),
      round: roundId.toString(),
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
      keeperTransactionCount: 2,
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
    });
    log("info", "keeper_batch_submitted", {
      kinds: JSON.stringify(["pool_sync", "pool_settle"]),
      transactionCount: 2,
      firstNonce: latestNonce,
      lastNonce: latestNonce + 1,
      targetBlock: targetBlock.toString(),
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
      relayCount: new Set(
        submissions.map((submission) => submission.relayUrl),
      ).size,
      prerequisiteHash: parameters.prerequisite.hash,
    });
    for (const [kind, label, hash, nonce] of [
      [
        "pool_sync",
        `pending_fwa_sync:${roundId}`,
        syncHash,
        latestNonce,
      ],
      [
        "pool_settle",
        `pending_fwa_settle:${roundId}`,
        settleHash,
        latestNonce + 1,
      ],
    ] as const) {
      log("info", "keeper_transaction_sent", {
        kind,
        label,
        hash,
        nonce,
        mode: "flashbots",
        targetBlock: targetBlock.toString(),
        prerequisiteHash: parameters.prerequisite.hash,
        batchTransactionCount: 2,
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
        syncHash,
        settleHash,
      };
    }
    const [syncReceipt, settleReceipt] = await Promise.all([
      getReceiptOrUndefined(parameters.publicClient, syncHash),
      getReceiptOrUndefined(parameters.publicClient, settleHash),
    ]);
    let confirmedTransactions = 0;
    let revertedTransactions = 0;
    let expiredTransactions = 0;
    let totalReward = 0n;
    let totalGasCost = 0n;
    for (const [
      kind,
      label,
      hash,
      nonce,
      batchPosition,
      receipt,
    ] of [
      [
        "pool_sync",
        `pending_fwa_sync:${roundId}`,
        syncHash,
        latestNonce,
        1,
        syncReceipt,
      ],
      [
        "pool_settle",
        `pending_fwa_settle:${roundId}`,
        settleHash,
        latestNonce + 1,
        2,
        settleReceipt,
      ],
    ] as const) {
      if (
        receipt === undefined ||
        receipt.blockNumber !== targetBlock
      ) {
        expiredTransactions += 1;
        log("warn", "keeper_transaction_expired", {
          kind,
          label,
          hash,
          nonce,
          targetBlock: targetBlock.toString(),
          prerequisiteHash: parameters.prerequisite.hash,
          reason: "private lifecycle transaction was not included",
          batchTransactionCount: 2,
          batchPosition,
          batchTargetBlock: targetBlock.toString(),
        });
        continue;
      }
      const paidReward =
        receipt.status === "success"
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
        kind,
        label,
        hash,
        nonce,
        block: receipt.blockNumber.toString(),
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        paidReward: eth(paidReward),
        gasCost: eth(gasCost),
        realizedProfit: eth(paidReward - gasCost),
        prerequisiteHash: parameters.prerequisite.hash,
        expectedBlock: targetBlock.toString(),
        targetBlockMatched: true,
        batchTransactionCount: 2,
        batchPosition,
        batchTargetBlock: targetBlock.toString(),
      });
    }
    const realizedProfit = totalReward - totalGasCost;
    log("info", "keeper_batch_result", {
      kind: "pending_fwa_fulfillment_backrun",
      kinds: JSON.stringify(["pool_sync", "pool_settle"]),
      round: roundId.toString(),
      block:
        confirmedTransactions + revertedTransactions > 0
          ? targetBlock.toString()
          : "",
      targetBlock: targetBlock.toString(),
      transactionCount: 2,
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
      confirmedTransactions === 2 &&
      revertedTransactions === 0 &&
      expiredTransactions === 0
    ) {
      return {
        status: "confirmed",
        reason: "confirmed",
        targetBlock,
        syncHash,
        settleHash,
        realizedProfitWei: realizedProfit,
      };
    }
    return {
      status: "expired",
      reason:
        expiredTransactions === 2
          ? "lifecycle_not_included"
          : revertedTransactions > 0
            ? "lifecycle_reverted"
            : "lifecycle_partial",
      targetBlock,
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
