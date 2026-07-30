import {
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  keccak256,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
} from "viem";

import { standingOrderAbi } from "./abi.js";
import { nextBlockBaseFeePerGas } from "./base-fee.js";
import { quoteCompetitiveFees } from "./bidding.js";
import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
  type KeeperConfig,
} from "./config.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import {
  FlashbotsRelay,
  simulatedGasUsed,
  submitBundleToRelays,
  successfulPrefixLength,
} from "./flashbots.js";
import { errorMessage, eth, gwei, log } from "./format.js";
import type { PrivateBatchOutcome } from "./keeper.js";
import type { ValidatedPendingFundingPrerequisite } from "./pending-funding.js";
import {
  SignerSubmissionCoordinator,
  signerNonceIsUsable,
} from "./signer-coordinator.js";

export type PendingFundingBackrunStatus =
  | "confirmed"
  | "expired"
  | "skipped";

export interface PendingFundingBackrunResult {
  readonly status: PendingFundingBackrunStatus;
  readonly reason: string;
  readonly targetBlock?: bigint;
  readonly crankHash?: Hash;
  readonly realizedProfitWei?: bigint;
}

type OrderFundingPrerequisite = Extract<
  ValidatedPendingFundingPrerequisite,
  { action: "order_funding" }
>;

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface ExactCrankSimulation {
  readonly signedCrank: `0x${string}`;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly effectiveBuilderBidBps: bigint;
  readonly expectedProfit: bigint;
}

export function pendingFundingBundleTransactions(
  prerequisite: Hex,
  crank: Hex,
): readonly [Hex, Hex] {
  if (prerequisite === "0x" || crank === "0x") {
    throw new Error(
      "pending funding bundle transactions cannot be empty",
    );
  }
  return [prerequisite, crank];
}

export function shouldObservePendingFundingMiss(parameters: {
  readonly prerequisiteIncluded: boolean;
  readonly competitorCranked: boolean;
}): boolean {
  return (
    parameters.prerequisiteIncluded &&
    parameters.competitorCranked
  );
}

export function receiptSucceededInTarget(parameters: {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly targetBlock: bigint;
}): boolean {
  return (
    parameters.status === "success" &&
    parameters.blockNumber === parameters.targetBlock
  );
}

function decodedCrankedFee(
  order: Address,
  caller: Address,
  logs: readonly {
    readonly address: Address;
    readonly data: `0x${string}`;
    readonly topics: [] | [`0x${string}`, ...`0x${string}`[]];
  }[],
): bigint | undefined {
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== order.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: standingOrderAbi,
        data: entry.data,
        topics: entry.topics,
      });
      if (
        decoded.eventName === "Cranked" &&
        decoded.args.caller.toLowerCase() === caller.toLowerCase()
      ) {
        return decoded.args.fee;
      }
    } catch {
      // A known order may emit unrelated events in the same receipt.
    }
  }
  return undefined;
}

export function pendingFundingCrankGasUsed(parameters: {
  readonly simulation: Parameters<typeof simulatedGasUsed>[0];
}): bigint {
  if (successfulPrefixLength(parameters.simulation, 2) !== 2) {
    throw new Error(
      "pending funding prerequisite bundle did not simulate both transactions",
    );
  }
  const gas = simulatedGasUsed(parameters.simulation, 2)[1];
  if (gas === undefined) {
    throw new Error(
      "pending funding simulation omitted crank gas usage",
    );
  }
  return gas;
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

async function getReceiptOrUndefined(
  client: PublicClient<Transport, Chain>,
  hash: Hash,
): Promise<
  Awaited<ReturnType<typeof client.getTransactionReceipt>> | undefined
> {
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch {
      if (attempt === 11) return undefined;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  return undefined;
}

async function exactPricedCrank(parameters: {
  readonly relay: FlashbotsRelay;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: OrderFundingPrerequisite;
  readonly targetBlock: bigint;
  readonly nonce: number;
  readonly crankFee: bigint;
  readonly accountBalance: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly builderBidBps: bigint;
  readonly config: KeeperConfig;
}): Promise<ExactCrankSimulation | undefined> {
  if (parameters.baseFeeAllowancePerGas <= 0n) {
    return undefined;
  }
  const maximumAffordableGas =
    parameters.accountBalance /
    parameters.baseFeeAllowancePerGas;
  const preliminaryGasLimit =
    maximumAffordableGas <
    BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT)
      ? maximumAffordableGas
      : BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT);
  if (preliminaryGasLimit < 21_000n) {
    return undefined;
  }
  const crankData = encodeFunctionData({
    abi: standingOrderAbi,
    functionName: "crank",
  });
  const preliminaryCrank =
    await parameters.signer.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: parameters.prerequisite.target,
      data: crankData,
      gas: preliminaryGasLimit,
      maxFeePerGas: parameters.baseFeeAllowancePerGas,
      maxPriorityFeePerGas: 0n,
      nonce: parameters.nonce,
      value: 0n,
    });
  const preliminarySimulation =
    await parameters.relay.callBundle(
      pendingFundingBundleTransactions(
        parameters.prerequisite.rawTransaction,
        preliminaryCrank,
      ),
      parameters.targetBlock,
    );
  let simulatedCrankGas = pendingFundingCrankGasUsed({
    simulation: preliminarySimulation,
  });
  let quote = quoteCompetitiveFees({
    crankFee: parameters.crankFee,
    simulatedGasUsed: simulatedCrankGas,
    baseFeeAllowancePerGas:
      parameters.baseFeeAllowancePerGas,
    minimumPriorityFeePerGas:
      parameters.config.minPriorityFeePerGas,
    builderBidBps: parameters.builderBidBps,
    maxFeePerGasCap: parameters.config.maxFeePerGas,
    minProfitWei: parameters.config.minProfitWei,
  });
  if (!quote.profitable) return undefined;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const gasLimit = bufferedGas(
      simulatedCrankGas,
      parameters.config.gasLimitMultiplierBps,
    );
    if (
      gasLimit > BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT) ||
      gasLimit * quote.maxFeePerGas >
        parameters.accountBalance
    ) {
      return undefined;
    }
    const signedCrank =
      await parameters.signer.signTransaction({
        chainId: 1,
        type: "eip1559",
        to: parameters.prerequisite.target,
        data: crankData,
        gas: gasLimit,
        maxFeePerGas: quote.maxFeePerGas,
        maxPriorityFeePerGas:
          quote.maxPriorityFeePerGas,
        nonce: parameters.nonce,
        value: 0n,
      });
    const finalSimulation =
      await parameters.relay.callBundle(
        pendingFundingBundleTransactions(
          parameters.prerequisite.rawTransaction,
          signedCrank,
        ),
        parameters.targetBlock,
      );
    const finalGasUsed = pendingFundingCrankGasUsed({
      simulation: finalSimulation,
    });
    const repriced = quoteCompetitiveFees({
      crankFee: parameters.crankFee,
      simulatedGasUsed: finalGasUsed,
      baseFeeAllowancePerGas:
        parameters.baseFeeAllowancePerGas,
      minimumPriorityFeePerGas:
        parameters.config.minPriorityFeePerGas,
      builderBidBps: parameters.builderBidBps,
      maxFeePerGasCap: parameters.config.maxFeePerGas,
      minProfitWei: parameters.config.minProfitWei,
    });
    if (!repriced.profitable) return undefined;
    if (sameFeeQuote(quote, repriced)) {
      const expectedProfit =
        parameters.crankFee -
        finalGasUsed * repriced.maxFeePerGas;
      if (
        expectedProfit <
        requiredProfit(parameters.config.minProfitWei)
      ) {
        return undefined;
      }
      return {
        signedCrank,
        gasUsed: finalGasUsed,
        gasLimit,
        maxFeePerGas: repriced.maxFeePerGas,
        maxPriorityFeePerGas:
          repriced.maxPriorityFeePerGas,
        effectiveBuilderBidBps:
          repriced.effectiveBuilderBidBps,
        expectedProfit,
      };
    }
    quote = repriced;
    simulatedCrankGas = finalGasUsed;
  }
  return undefined;
}

export async function executePendingFundingBackrun(parameters: {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly pendingClient: PublicClient<Transport, Chain>;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: OrderFundingPrerequisite;
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
  readonly observePrivateBatch:
    | ((outcome: PrivateBatchOutcome) => Promise<void>)
    | undefined;
  readonly signal?: AbortSignal;
}): Promise<PendingFundingBackrunResult> {
  if (parameters.config.dryRun) {
    return {
      status: "skipped",
      reason: "dry_run",
    };
  }
  if (abortRequested(parameters.signal)) {
    return {
      status: "skipped",
      reason: "shutdown",
    };
  }
  const order = parameters.prerequisite.target;
  const currentHead = await parameters.publicClient.getBlockNumber();
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
  if (abortRequested(parameters.signal)) {
    return {
      status: "skipped",
      reason: "shutdown",
      targetBlock,
    };
  }
  const reservation = parameters.coordinator.tryReserve({
    targetBlock,
    nonce: latestNonce,
    lane: "pending_funding_backrun",
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
        reason:
          abortRequested(parameters.signal)
            ? "shutdown"
            : "prerequisite_replaced",
        targetBlock,
      };
    }
    const [latestBlock, crankFee, accountBalance] =
      await Promise.all([
        parameters.publicClient.getBlock({
          blockNumber: currentHead,
        }),
        parameters.publicClient.readContract({
          address: order,
          abi: standingOrderAbi,
          functionName: "crankFee",
          blockNumber: currentHead,
        }),
        parameters.publicClient.getBalance({
          address: parameters.signer.address,
          blockNumber: currentHead,
        }),
      ]);
    if (latestBlock.baseFeePerGas === null) {
      return {
        status: "skipped",
        reason: "base_fee_unavailable",
        targetBlock,
      };
    }
    const baseFeeAllowancePerGas =
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas:
          latestBlock.baseFeePerGas,
        parentGasUsed: latestBlock.gasUsed,
        parentGasLimit: latestBlock.gasLimit,
      });
    const builderBidBps = parameters.builderBidBps;
    const exact = await exactPricedCrank({
      relay: parameters.relays[0]!,
      signer: parameters.signer,
      prerequisite: parameters.prerequisite,
      targetBlock,
      nonce: latestNonce,
      crankFee,
      accountBalance,
      baseFeeAllowancePerGas,
      builderBidBps,
      config: parameters.config,
    }).catch((error: unknown) => {
      log("debug", "pending_funding_backrun_simulation_failed", {
        prerequisiteHash: parameters.prerequisite.hash,
        order,
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
    log("info", "pending_funding_backrun_opportunity", {
      prerequisiteHash: parameters.prerequisite.hash,
      order,
      fundingValue: eth(parameters.prerequisite.value),
      crankFee: eth(crankFee),
      crankGasUsed: exact.gasUsed.toString(),
      crankGasLimit: exact.gasLimit.toString(),
      builderBidBps: builderBidBps.toString(),
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
      maxFeePerGas: gwei(exact.maxFeePerGas),
      maxPriorityFeePerGas: gwei(
        exact.maxPriorityFeePerGas,
      ),
      expectedProfit: eth(exact.expectedProfit),
      targetBlock: targetBlock.toString(),
    });

    const [
      currentPendingTransaction,
      currentRawTransaction,
      submissionHead,
      finalLatestNonce,
      finalPendingNonce,
    ] =
      await Promise.all([
        parameters.pendingClient
          .getTransaction({
            hash: parameters.prerequisite.hash,
          })
          .catch(() => undefined),
        parameters.pendingClient
          .getRawTransaction({
            hash: parameters.prerequisite.hash,
          })
          .catch(() => undefined),
        parameters.publicClient.getBlockNumber(),
        parameters.publicClient.getTransactionCount({
          address: parameters.signer.address,
          blockTag: "latest",
        }),
        parameters.publicClient.getTransactionCount({
          address: parameters.signer.address,
          blockTag: "pending",
        }),
      ]);
    if (
      abortRequested(parameters.signal) ||
      currentPendingTransaction === undefined ||
      currentRawTransaction === undefined ||
      currentRawTransaction.toLowerCase() !==
        parameters.prerequisite.rawTransaction.toLowerCase() ||
      currentPendingTransaction.blockNumber !== null ||
      !parameters.isPrerequisiteCurrent() ||
      submissionHead >= targetBlock ||
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
    if (abortRequested(parameters.signal)) {
      return {
        status: "skipped",
        reason: "shutdown",
        targetBlock,
      };
    }
    const submissions = await submitBundleToRelays(
      parameters.relays,
      pendingFundingBundleTransactions(
        parameters.prerequisite.rawTransaction,
        exact.signedCrank,
      ),
      targetBlock,
      parameters.builders,
    );
    retainReservation = true;
    const crankHash = keccak256(exact.signedCrank);
    const relayIndexes = [
      ...new Set(
        submissions.map((submission) =>
          parameters.relays.findIndex(
            (relay) => relay.url === submission.relayUrl,
          ),
        ),
      ),
    ];
    log("info", "pending_funding_backrun_submitted", {
      prerequisiteHash: parameters.prerequisite.hash,
      hash: crankHash,
      order,
      nonce: latestNonce,
      targetBlock: targetBlock.toString(),
      relayCount: relayIndexes.length,
      bundleCount: submissions.length,
      transactionCount: 2,
      prerequisiteCount: 1,
      keeperTransactionCount: 1,
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
    });
    log("info", "keeper_transaction_sent", {
      kind: "standing_order",
      label: `pending_funding_backrun:${order}`,
      hash: crankHash,
      nonce: latestNonce,
      mode: "flashbots",
      targetBlock: targetBlock.toString(),
      prerequisiteHash: parameters.prerequisite.hash,
    });

    const observed = await parameters.waitForTargetBlock(
      targetBlock,
      Math.min(
        parameters.config.receiptTimeoutMs,
        parameters.config.headStaleTimeoutMs,
      ),
    );
    if (!observed) {
      log("warn", "keeper_transaction_expired", {
        kind: "standing_order",
        label: `pending_funding_backrun:${order}`,
        hash: crankHash,
        nonce: latestNonce,
        targetBlock: targetBlock.toString(),
        prerequisiteHash: parameters.prerequisite.hash,
        reason: "target block was not observed",
      });
      return {
        status: "expired",
        reason: "target_block_unobserved",
        targetBlock,
        crankHash,
      };
    }

    const crankReceipt = await getReceiptOrUndefined(
      parameters.publicClient,
      crankHash,
    );
    if (crankReceipt !== undefined) {
      const includedAsPlanned =
        receiptSucceededInTarget({
          status: crankReceipt.status,
          blockNumber: crankReceipt.blockNumber,
          targetBlock,
        });
      const paidReward = includedAsPlanned
        ? (decodedCrankedFee(
            order,
            parameters.signer.address,
            crankReceipt.logs,
          ) ?? 0n)
        : 0n;
      if (includedAsPlanned && paidReward === 0n) {
        log("warn", "pending_funding_accounting_failed", {
          prerequisiteHash: parameters.prerequisite.hash,
          hash: crankHash,
          order,
          reason: "Cranked fee event was missing",
        });
      }
      if (crankReceipt.blockNumber !== targetBlock) {
        log("warn", "pending_funding_accounting_failed", {
          prerequisiteHash: parameters.prerequisite.hash,
          hash: crankHash,
          order,
          reason: "crank receipt landed outside its target block",
          expectedBlock: targetBlock.toString(),
          actualBlock: crankReceipt.blockNumber.toString(),
        });
      }
      const gasCost =
        crankReceipt.gasUsed *
        crankReceipt.effectiveGasPrice;
      const realizedProfit = paidReward - gasCost;
      log(
        includedAsPlanned ? "info" : "warn",
        "keeper_receipt",
        {
          kind: "standing_order",
          label: `pending_funding_backrun:${order}`,
          hash: crankHash,
          nonce: latestNonce,
          block: crankReceipt.blockNumber.toString(),
          status: crankReceipt.status,
          gasUsed: crankReceipt.gasUsed.toString(),
          paidReward: eth(paidReward),
          gasCost: eth(gasCost),
          realizedProfit: eth(realizedProfit),
          prerequisiteHash: parameters.prerequisite.hash,
          expectedBlock: targetBlock.toString(),
          targetBlockMatched:
            crankReceipt.blockNumber === targetBlock,
        },
      );
      if (
        includedAsPlanned &&
        parameters.observePrivateBatch !== undefined
      ) {
        try {
          await parameters.observePrivateBatch({
            targetBlock,
            bidScope: "pending_funding_backrun",
            attempts: [
              {
                order,
                crankFee,
                hash: crankHash,
                included: true,
                effectiveBidBps:
                  exact.effectiveBuilderBidBps,
              },
            ],
          });
        } catch (error) {
          log("warn", "adaptive_bid_observation_failed", {
            targetBlock: targetBlock.toString(),
            bidScope: "pending_funding_backrun",
            reason: errorMessage(error),
          });
        }
      }
      return {
        status: includedAsPlanned ? "confirmed" : "expired",
        reason: includedAsPlanned
          ? "confirmed"
          : crankReceipt.blockNumber !== targetBlock
            ? "crank_wrong_block"
            : "crank_reverted",
        targetBlock,
        crankHash,
        realizedProfitWei: realizedProfit,
      };
    }

    const prerequisiteReceipt = await getReceiptOrUndefined(
      parameters.publicClient,
      parameters.prerequisite.hash,
    );
    const prerequisiteIncluded =
      prerequisiteReceipt !== undefined &&
      receiptSucceededInTarget({
        status: prerequisiteReceipt.status,
        blockNumber: prerequisiteReceipt.blockNumber,
        targetBlock,
      });
    let competitorCranked = false;
    if (prerequisiteIncluded) {
      const orderLogs = await parameters.publicClient.getLogs({
        address: order,
        event: standingOrderAbi.find(
          (item) =>
            item.type === "event" &&
            item.name === "Cranked",
        ) as Extract<
          (typeof standingOrderAbi)[number],
          { type: "event"; name: "Cranked" }
        >,
        fromBlock: targetBlock,
        toBlock: targetBlock,
        strict: true,
      });
      competitorCranked = orderLogs.some(
        (entry) =>
          entry.transactionHash !== null &&
          entry.transactionHash.toLowerCase() !==
            crankHash.toLowerCase(),
      );
    }
    log("warn", "keeper_transaction_expired", {
      kind: "standing_order",
      label: `pending_funding_backrun:${order}`,
      hash: crankHash,
      nonce: latestNonce,
      targetBlock: targetBlock.toString(),
      prerequisiteHash: parameters.prerequisite.hash,
      prerequisiteIncluded,
      competitorCranked,
      reason: "private crank was not included",
    });
    if (
      shouldObservePendingFundingMiss({
        prerequisiteIncluded,
        competitorCranked,
      }) &&
      parameters.observePrivateBatch !== undefined
    ) {
      try {
        await parameters.observePrivateBatch({
          targetBlock,
          bidScope: "pending_funding_backrun",
          attempts: [
            {
              order,
              crankFee,
              hash: crankHash,
              included: false,
              effectiveBidBps:
                exact.effectiveBuilderBidBps,
            },
          ],
        });
      } catch (error) {
        log("warn", "adaptive_bid_observation_failed", {
          targetBlock: targetBlock.toString(),
          bidScope: "pending_funding_backrun",
          reason: errorMessage(error),
        });
      }
    }
    return {
      status: "expired",
      reason: !prerequisiteIncluded
        ? "prerequisite_not_included"
        : competitorCranked
          ? "competitor_won"
          : "crank_not_included",
      targetBlock,
      crankHash,
    };
  } finally {
    if (!retainReservation) {
      parameters.coordinator.release(reservation);
    }
  }
}

export function formatPendingFundingBackrunResult(
  result: PendingFundingBackrunResult,
): string {
  const profit =
    result.realizedProfitWei === undefined
      ? ""
      : `, realized ${formatEther(result.realizedProfitWei)} ETH`;
  return `${result.status}:${result.reason}${profit}`;
}
