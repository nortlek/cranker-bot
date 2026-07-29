import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
} from "viem";

import { poolAbi } from "./abi.js";
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
import { estimatePoolBounty } from "./lifecycle.js";
import {
  pendingFundingBundleTransactions,
  receiptSucceededInTarget,
} from "./pending-funding-backrun.js";
import type { ValidatedPendingFundingPrerequisite } from "./pending-funding.js";
import {
  SignerSubmissionCoordinator,
  signerNonceIsUsable,
} from "./signer-coordinator.js";

type PoolTicketPrerequisite = Extract<
  ValidatedPendingFundingPrerequisite,
  { action: "pool_ticket_purchase" }
>;

export interface PendingPoolPullBackrunResult {
  readonly status: "confirmed" | "expired" | "skipped";
  readonly reason: string;
  readonly targetBlock?: bigint;
  readonly pullHash?: Hash;
  readonly realizedProfitWei?: bigint;
}

interface ExactPoolPullSimulation {
  readonly signedPull: Hex;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  readonly grossReward: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly effectiveBuilderBidBps: bigint;
  readonly expectedProfit: bigint;
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function pendingPoolPullGasUsed(parameters: {
  readonly simulation: Parameters<typeof simulatedGasUsed>[0];
}): bigint {
  if (successfulPrefixLength(parameters.simulation, 2) !== 2) {
    throw new Error(
      "pending ticket purchase plus pull bundle did not simulate both transactions",
    );
  }
  const gas = simulatedGasUsed(parameters.simulation, 2)[1];
  if (gas === undefined) {
    throw new Error(
      "pending ticket purchase simulation omitted pull gas usage",
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

function conservativeNextBaseFee(baseFeePerGas: bigint): bigint {
  if (baseFeePerGas <= 0n) return 0n;
  return (baseFeePerGas * 7n) / 8n;
}

async function exactPricedPoolPull(parameters: {
  readonly relay: FlashbotsRelay;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: PoolTicketPrerequisite;
  readonly roundId: bigint;
  readonly targetBlock: bigint;
  readonly nonce: number;
  readonly accountBalance: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly bountyBaseFeePerGas: bigint;
  readonly crankBountyCap: bigint;
  readonly bountyTipWei: bigint;
  readonly builderBidBps: bigint;
  readonly config: KeeperConfig;
}): Promise<ExactPoolPullSimulation | undefined> {
  if (
    parameters.baseFeeAllowancePerGas <= 0n ||
    parameters.bountyBaseFeePerGas < 0n
  ) {
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
  if (preliminaryGasLimit < 21_000n) return undefined;

  const pullData = encodeFunctionData({
    abi: poolAbi,
    functionName: "pull",
    args: [parameters.roundId],
  });
  const preliminaryPull =
    await parameters.signer.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: parameters.prerequisite.target,
      data: pullData,
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
        preliminaryPull,
      ),
      parameters.targetBlock,
    );
  let simulatedPullGas = pendingPoolPullGasUsed({
    simulation: preliminarySimulation,
  });
  let grossReward = estimatePoolBounty({
    gasUsed: simulatedPullGas,
    baseFeePerGas: parameters.bountyBaseFeePerGas,
    terms: {
      crankBountyCap: parameters.crankBountyCap,
      bountyTipWei: parameters.bountyTipWei,
    },
    estimateBps:
      parameters.config.poolPullBountyEstimateBps,
  });
  let quote = quoteCompetitiveFees({
    crankFee: grossReward,
    simulatedGasUsed: simulatedPullGas,
    baseFeeAllowancePerGas:
      parameters.baseFeeAllowancePerGas,
    minimumPriorityFeePerGas:
      parameters.config.poolMinPriorityFeePerGas,
    builderBidBps: parameters.builderBidBps,
    maxFeePerGasCap: parameters.config.maxFeePerGas,
    minProfitWei: parameters.config.minProfitWei,
  });
  if (!quote.profitable) return undefined;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const gasLimit = bufferedGas(
      simulatedPullGas,
      parameters.config.gasLimitMultiplierBps,
    );
    if (
      gasLimit > BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT) ||
      gasLimit * quote.maxFeePerGas >
        parameters.accountBalance
    ) {
      return undefined;
    }
    const signedPull =
      await parameters.signer.signTransaction({
        chainId: 1,
        type: "eip1559",
        to: parameters.prerequisite.target,
        data: pullData,
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
          signedPull,
        ),
        parameters.targetBlock,
      );
    const finalGasUsed = pendingPoolPullGasUsed({
      simulation: finalSimulation,
    });
    const finalGrossReward = estimatePoolBounty({
      gasUsed: finalGasUsed,
      baseFeePerGas: parameters.bountyBaseFeePerGas,
      terms: {
        crankBountyCap: parameters.crankBountyCap,
        bountyTipWei: parameters.bountyTipWei,
      },
      estimateBps:
        parameters.config.poolPullBountyEstimateBps,
    });
    const repriced = quoteCompetitiveFees({
      crankFee: finalGrossReward,
      simulatedGasUsed: finalGasUsed,
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
        finalGasUsed * repriced.maxFeePerGas;
      if (
        expectedProfit <
        requiredProfit(parameters.config.minProfitWei)
      ) {
        return undefined;
      }
      return {
        signedPull,
        gasUsed: finalGasUsed,
        gasLimit,
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
    simulatedPullGas = finalGasUsed;
    grossReward = finalGrossReward;
  }
  return undefined;
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

function decodedPoolBounty(parameters: {
  readonly pool: Address;
  readonly caller: Address;
  readonly roundId: bigint;
  readonly logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: [] | [Hex, ...Hex[]];
  }[];
}): bigint | undefined {
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
        return decoded.args.amount;
      }
    } catch {
      // The pool emits several unrelated lifecycle events.
    }
  }
  return undefined;
}

export async function executePendingPoolPullBackrun(parameters: {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly pendingClient: PublicClient<Transport, Chain>;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: PoolTicketPrerequisite;
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
  readonly signal?: AbortSignal;
}): Promise<PendingPoolPullBackrunResult> {
  if (parameters.config.dryRun) {
    return { status: "skipped", reason: "dry_run" };
  }
  if (abortRequested(parameters.signal)) {
    return { status: "skipped", reason: "shutdown" };
  }

  const pool = parameters.prerequisite.target;
  const declaredRoundId =
    parameters.prerequisite.roundId;
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
  const reservation = parameters.coordinator.tryReserve({
    targetBlock,
    nonce: latestNonce,
    lane: "pending_pool_pull_backrun",
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
      feeQuote,
      latestBlock,
      roundCount,
      ethPendingRound,
      accountBalance,
    ] = await Promise.all([
      parameters.publicClient.estimateFeesPerGas({
        type: "eip1559",
      }),
      parameters.publicClient.getBlock({
        blockNumber: currentHead,
      }),
      parameters.publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "roundCount",
        blockNumber: currentHead,
      }),
      parameters.publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "ethPendingRound",
        blockNumber: currentHead,
      }),
      parameters.publicClient.getBalance({
        address: parameters.signer.address,
        blockNumber: currentHead,
      }),
    ]);
    const roundId = declaredRoundId ?? roundCount;
    if (
      (declaredRoundId !== undefined &&
        roundCount !== declaredRoundId) ||
      ethPendingRound !== 0n ||
      roundId <= 0n
    ) {
      return {
        status: "skipped",
        reason: "round_not_open",
        targetBlock,
      };
    }
    const round =
      await parameters.publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "getRound",
        args: [roundId],
        blockNumber: currentHead,
      });
    if (round.state !== 1) {
      return {
        status: "skipped",
        reason: "round_not_open",
        targetBlock,
      };
    }
    const baseFeeAllowancePerGas =
      feeQuote.maxFeePerGas -
      feeQuote.maxPriorityFeePerGas;
    const exact = await exactPricedPoolPull({
      relay: parameters.relays[0]!,
      signer: parameters.signer,
      prerequisite: parameters.prerequisite,
      roundId,
      targetBlock,
      nonce: latestNonce,
      accountBalance,
      baseFeeAllowancePerGas,
      bountyBaseFeePerGas: conservativeNextBaseFee(
        latestBlock.baseFeePerGas ?? 0n,
      ),
      crankBountyCap: round.crankBountyCap,
      bountyTipWei: round.bountyTipWei,
      builderBidBps: parameters.builderBidBps,
      config: parameters.config,
    }).catch((error: unknown) => {
      log("debug", "pending_pool_pull_simulation_failed", {
        prerequisiteHash: parameters.prerequisite.hash,
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
    log("info", "pending_pool_pull_opportunity", {
      prerequisiteHash: parameters.prerequisite.hash,
      round: roundId.toString(),
      tickets: parameters.prerequisite.tickets,
      purchaseValue: eth(parameters.prerequisite.value),
      pullGasUsed: exact.gasUsed.toString(),
      pullGasLimit: exact.gasLimit.toString(),
      grossReward: eth(exact.grossReward),
      builderBidBps:
        parameters.builderBidBps.toString(),
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
    ] = await Promise.all([
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
        exact.signedPull,
      ),
      targetBlock,
      parameters.builders,
    );
    retainReservation = true;
    const pullHash = keccak256(exact.signedPull);
    log("info", "pending_pool_pull_submitted", {
      prerequisiteHash: parameters.prerequisite.hash,
      hash: pullHash,
      round: roundId.toString(),
      nonce: latestNonce,
      targetBlock: targetBlock.toString(),
      relayCount: new Set(
        submissions.map((submission) => submission.relayUrl),
      ).size,
      bundleCount: submissions.length,
      transactionCount: 2,
      prerequisiteCount: 1,
      keeperTransactionCount: 1,
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
    });
    log("info", "keeper_transaction_sent", {
      kind: "pool_pull",
      label: `pending_pool_pull_backrun:${roundId}`,
      hash: pullHash,
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
        kind: "pool_pull",
        label: `pending_pool_pull_backrun:${roundId}`,
        hash: pullHash,
        nonce: latestNonce,
        targetBlock: targetBlock.toString(),
        prerequisiteHash: parameters.prerequisite.hash,
        reason: "target block was not observed",
      });
      return {
        status: "expired",
        reason: "target_block_unobserved",
        targetBlock,
        pullHash,
      };
    }

    const pullReceipt = await getReceiptOrUndefined(
      parameters.publicClient,
      pullHash,
    );
    if (pullReceipt !== undefined) {
      const includedAsPlanned =
        receiptSucceededInTarget({
          status: pullReceipt.status,
          blockNumber: pullReceipt.blockNumber,
          targetBlock,
        });
      const paidReward = includedAsPlanned
        ? (decodedPoolBounty({
            pool,
            caller: parameters.signer.address,
            roundId,
            logs: pullReceipt.logs,
          }) ?? 0n)
        : 0n;
      if (includedAsPlanned && paidReward === 0n) {
        log("warn", "pending_pool_pull_accounting_failed", {
          prerequisiteHash: parameters.prerequisite.hash,
          hash: pullHash,
          round: roundId.toString(),
          reason: "CrankBountyPaid event was missing",
        });
      }
      const gasCost =
        pullReceipt.gasUsed *
        pullReceipt.effectiveGasPrice;
      const realizedProfit = paidReward - gasCost;
      log(
        includedAsPlanned ? "info" : "warn",
        "keeper_receipt",
        {
          kind: "pool_pull",
          label: `pending_pool_pull_backrun:${roundId}`,
          hash: pullHash,
          nonce: latestNonce,
          block: pullReceipt.blockNumber.toString(),
          status: pullReceipt.status,
          gasUsed: pullReceipt.gasUsed.toString(),
          paidReward: eth(paidReward),
          gasCost: eth(gasCost),
          realizedProfit: eth(realizedProfit),
          prerequisiteHash: parameters.prerequisite.hash,
          expectedBlock: targetBlock.toString(),
          targetBlockMatched:
            pullReceipt.blockNumber === targetBlock,
        },
      );
      return {
        status: includedAsPlanned
          ? "confirmed"
          : "expired",
        reason: includedAsPlanned
          ? "confirmed"
          : pullReceipt.blockNumber !== targetBlock
            ? "pull_wrong_block"
            : "pull_reverted",
        targetBlock,
        pullHash,
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
    let competitorPulled = false;
    if (prerequisiteIncluded) {
      const pulledEvent = poolAbi.find(
        (item) =>
          item.type === "event" &&
          item.name === "Pulled",
      ) as Extract<
        (typeof poolAbi)[number],
        { type: "event"; name: "Pulled" }
      >;
      const pulledLogs = await parameters.publicClient.getLogs({
        address: pool,
        event: pulledEvent,
        args: { roundId },
        fromBlock: targetBlock,
        toBlock: targetBlock,
        strict: true,
      });
      competitorPulled = pulledLogs.some(
        (entry) =>
          entry.transactionHash !== null &&
          entry.transactionHash.toLowerCase() !==
            pullHash.toLowerCase(),
      );
    }
    log("warn", "keeper_transaction_expired", {
      kind: "pool_pull",
      label: `pending_pool_pull_backrun:${roundId}`,
      hash: pullHash,
      nonce: latestNonce,
      targetBlock: targetBlock.toString(),
      prerequisiteHash: parameters.prerequisite.hash,
      prerequisiteIncluded,
      competitorPulled,
      reason: "private pull was not included",
    });
    return {
      status: "expired",
      reason: !prerequisiteIncluded
        ? "prerequisite_not_included"
        : competitorPulled
          ? "competitor_won"
          : "pull_not_included",
      targetBlock,
      pullHash,
    };
  } finally {
    if (!retainReservation) {
      parameters.coordinator.release(reservation);
    }
  }
}
