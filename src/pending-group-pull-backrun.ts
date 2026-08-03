import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  type Chain,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
} from "viem";

import { groupPullAbi } from "./abi.js";
import { nextBlockBaseFeePerGas } from "./base-fee.js";
import { quoteCompetitiveFees } from "./bidding.js";
import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
  type KeeperConfig,
} from "./config.js";
import { GROUP_PULL_ADDRESS } from "./constants.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import {
  FlashbotsRelay,
  simulatedGasUsed,
  submitBundleToRelays,
  successfulPrefixLength,
} from "./flashbots.js";
import { errorMessage, eth, gwei, log } from "./format.js";
import {
  GROUP_PULL_ROUND_STATE,
  groupPullBountyForCalls,
  readGroupPullRound,
  verifyGroupPullRuntime,
} from "./group-pull.js";
import { receiptSucceededInTarget } from "./pending-funding-backrun.js";
import type { ValidatedPendingFundingPrerequisite } from "./pending-funding.js";
import {
  SignerSubmissionCoordinator,
  signerNonceIsUsable,
} from "./signer-coordinator.js";

type GroupPullEntryPrerequisite = Extract<
  ValidatedPendingFundingPrerequisite,
  { action: "group_pull_entry" }
>;

export interface PendingGroupPullBackrunResult {
  readonly status: "confirmed" | "expired" | "skipped";
  readonly reason: string;
  readonly targetBlock?: bigint;
  readonly submitHash?: Hash;
  readonly realizedProfitWei?: bigint;
}

interface ExactGroupPullSimulation {
  readonly signedSubmit: Hex;
  readonly calls: number;
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

export function pendingGroupPullGasUsed(parameters: {
  readonly simulation: Parameters<typeof simulatedGasUsed>[0];
}): bigint {
  if (successfulPrefixLength(parameters.simulation, 2) !== 2) {
    throw new Error(
      "pending GroupPull entry plus submit bundle did not simulate both transactions",
    );
  }
  const gas = simulatedGasUsed(parameters.simulation, 2)[1];
  if (gas === undefined) {
    throw new Error("pending GroupPull simulation omitted submit gas usage");
  }
  return gas;
}

export function groupPullSubmitRewardAfterFinalEntry(parameters: {
  readonly bountyPot: bigint;
  readonly pullsPerRound: number;
  readonly incentivePerTicket: bigint;
  readonly quantity: number;
  readonly submitCalls: number;
}): bigint {
  if (parameters.pullsPerRound < 1) {
    throw new Error("GroupPull final entry has no pull rounds");
  }
  const bountyShares = 1 + 2 * parameters.pullsPerRound;
  const potAfterEntry =
    parameters.bountyPot +
    parameters.incentivePerTicket * BigInt(parameters.quantity);
  const closeBounty = potAfterEntry / BigInt(bountyShares);
  return groupPullBountyForCalls({
    bountyPot: potAfterEntry - closeBounty,
    bountyShares: bountyShares - 1,
    calls: parameters.submitCalls,
  });
}

function sameFeeQuote(
  left: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  right: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): boolean {
  return (
    left.maxFeePerGas === right.maxFeePerGas &&
    left.maxPriorityFeePerGas === right.maxPriorityFeePerGas
  );
}

async function exactPricedGroupPullSubmit(parameters: {
  readonly relay: FlashbotsRelay;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: GroupPullEntryPrerequisite;
  readonly targetBlock: bigint;
  readonly nonce: number;
  readonly accountBalance: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly remainingPulls: number;
  readonly bountyPot: bigint;
  readonly pullsPerRound: number;
  readonly incentivePerTicket: bigint;
  readonly builderBidBps: bigint;
  readonly config: KeeperConfig;
}): Promise<ExactGroupPullSimulation | undefined> {
  if (parameters.baseFeeAllowancePerGas <= 0n) return undefined;
  const affordable =
    parameters.accountBalance / parameters.baseFeeAllowancePerGas;
  const preliminaryGas =
    affordable < BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT)
      ? affordable
      : BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT);
  if (preliminaryGas < 21_000n) return undefined;

  for (
    let calls = parameters.remainingPulls;
    calls >= 1;
    calls -= 1
  ) {
    const data = encodeFunctionData({
      abi: groupPullAbi,
      functionName: "submit",
      args: [parameters.prerequisite.roundId, BigInt(calls)],
    });
    try {
      const preliminarySubmit =
        await parameters.signer.signTransaction({
          chainId: 1,
          type: "eip1559",
          to: GROUP_PULL_ADDRESS,
          data,
          gas: preliminaryGas,
          maxFeePerGas: parameters.baseFeeAllowancePerGas,
          maxPriorityFeePerGas: 0n,
          nonce: parameters.nonce,
          value: 0n,
        });
      const preliminarySimulation =
        await parameters.relay.callBundle(
          [
            parameters.prerequisite.rawTransaction,
            preliminarySubmit,
          ],
          parameters.targetBlock,
        );
      let gasUsed = pendingGroupPullGasUsed({
        simulation: preliminarySimulation,
      });
      const grossReward = groupPullSubmitRewardAfterFinalEntry({
        bountyPot: parameters.bountyPot,
        pullsPerRound: parameters.pullsPerRound,
        incentivePerTicket: parameters.incentivePerTicket,
        quantity: parameters.prerequisite.quantity,
        submitCalls: calls,
      });
      let quote = quoteCompetitiveFees({
        crankFee: grossReward,
        simulatedGasUsed: gasUsed,
        baseFeeAllowancePerGas: parameters.baseFeeAllowancePerGas,
        minimumPriorityFeePerGas:
          parameters.config.poolMinPriorityFeePerGas,
        builderBidBps: parameters.builderBidBps,
        maxFeePerGasCap: parameters.config.maxFeePerGas,
        minProfitWei: parameters.config.minProfitWei,
      });
      if (!quote.profitable) continue;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const gasLimit = bufferedGas(
          gasUsed,
          parameters.config.gasLimitMultiplierBps,
        );
        if (
          gasLimit > BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT) ||
          gasLimit * quote.maxFeePerGas > parameters.accountBalance
        ) {
          break;
        }
        const signedSubmit =
          await parameters.signer.signTransaction({
            chainId: 1,
            type: "eip1559",
            to: GROUP_PULL_ADDRESS,
            data,
            gas: gasLimit,
            maxFeePerGas: quote.maxFeePerGas,
            maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
            nonce: parameters.nonce,
            value: 0n,
          });
        const finalSimulation = await parameters.relay.callBundle(
          [parameters.prerequisite.rawTransaction, signedSubmit],
          parameters.targetBlock,
        );
        const finalGasUsed = pendingGroupPullGasUsed({
          simulation: finalSimulation,
        });
        const repriced = quoteCompetitiveFees({
          crankFee: grossReward,
          simulatedGasUsed: finalGasUsed,
          baseFeeAllowancePerGas:
            parameters.baseFeeAllowancePerGas,
          minimumPriorityFeePerGas:
            parameters.config.poolMinPriorityFeePerGas,
          builderBidBps: parameters.builderBidBps,
          maxFeePerGasCap: parameters.config.maxFeePerGas,
          minProfitWei: parameters.config.minProfitWei,
        });
        if (!repriced.profitable) break;
        if (sameFeeQuote(quote, repriced)) {
          const expectedProfit =
            grossReward - finalGasUsed * repriced.maxFeePerGas;
          if (
            expectedProfit <
            requiredProfit(parameters.config.minProfitWei)
          ) {
            break;
          }
          return {
            signedSubmit,
            calls,
            gasUsed: finalGasUsed,
            gasLimit,
            grossReward,
            maxFeePerGas: repriced.maxFeePerGas,
            maxPriorityFeePerGas:
              repriced.maxPriorityFeePerGas,
            effectiveBuilderBidBps:
              repriced.effectiveBuilderBidBps,
            expectedProfit,
          };
        }
        gasUsed = finalGasUsed;
        quote = repriced;
      }
    } catch (error) {
      if (calls === 1) {
        log("debug", "pending_group_pull_simulation_failed", {
          prerequisiteHash: parameters.prerequisite.hash,
          round: parameters.prerequisite.roundId.toString(),
          targetBlock: parameters.targetBlock.toString(),
          reason: errorMessage(error),
        });
      }
    }
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
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  return undefined;
}

function decodedGroupPullBounty(parameters: {
  readonly caller: `0x${string}`;
  readonly roundId: bigint;
  readonly logs: readonly {
    readonly address: `0x${string}`;
    readonly data: Hex;
    readonly topics: [] | [Hex, ...Hex[]];
  }[];
}): bigint {
  let total = 0n;
  for (const entry of parameters.logs) {
    if (entry.address.toLowerCase() !== GROUP_PULL_ADDRESS.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: groupPullAbi,
        data: entry.data,
        topics: entry.topics,
      });
      if (
        decoded.eventName === "BountyPaid" &&
        decoded.args.roundId === parameters.roundId &&
        decoded.args.caller.toLowerCase() ===
          parameters.caller.toLowerCase()
      ) {
        total += decoded.args.amount;
      }
    } catch {
      // Ignore nested PullPool and unrelated GroupPull events.
    }
  }
  return total;
}

export async function executePendingGroupPullBackrun(parameters: {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly pendingClient: PublicClient<Transport, Chain>;
  readonly signer: PrivateKeyAccount;
  readonly prerequisite: GroupPullEntryPrerequisite;
  readonly relays: readonly FlashbotsRelay[];
  readonly builders: readonly string[];
  readonly config: KeeperConfig;
  readonly builderBidBps: bigint;
  readonly coordinator: SignerSubmissionCoordinator;
  readonly assertSignerLeaseHeld: () => Promise<void>;
  readonly isPrerequisiteCurrent: () => boolean;
  readonly readPlanningHead: () => bigint | undefined;
  readonly targetBlockArrived: (targetBlock: bigint) => boolean;
  readonly waitForTargetBlock: (
    targetBlock: bigint,
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly signal?: AbortSignal;
}): Promise<PendingGroupPullBackrunResult> {
  if (parameters.config.dryRun) {
    return { status: "skipped", reason: "dry_run" };
  }
  if (abortRequested(parameters.signal)) {
    return { status: "skipped", reason: "shutdown" };
  }
  const relay = parameters.relays[0];
  if (relay === undefined) {
    throw new Error("pending GroupPull lane requires a simulation relay");
  }
  const currentHead = parameters.readPlanningHead();
  if (currentHead === undefined) {
    return { status: "skipped", reason: "subscribed_head_unavailable" };
  }
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
    return { status: "skipped", reason: "signer_nonce_pending", targetBlock };
  }
  const reservation = parameters.coordinator.tryReserve({
    targetBlock,
    nonce: latestNonce,
    lane: "pending_group_pull_backrun",
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
    await verifyGroupPullRuntime({
      client: parameters.publicClient,
      blockNumber: currentHead,
    });
    const [block, liveRound, round, currentTarget, accountBalance] =
      await Promise.all([
        parameters.publicClient.getBlock({ blockNumber: currentHead }),
        parameters.publicClient.readContract({
          address: GROUP_PULL_ADDRESS,
          abi: groupPullAbi,
          functionName: "liveRound",
          blockNumber: currentHead,
        }),
        readGroupPullRound({
          client: parameters.publicClient,
          blockNumber: currentHead,
          roundId: parameters.prerequisite.roundId,
        }),
        parameters.publicClient.readContract({
          address: GROUP_PULL_ADDRESS,
          abi: groupPullAbi,
          functionName: "currentTarget",
          args: [parameters.prerequisite.roundId],
          blockNumber: currentHead,
        }),
        parameters.publicClient.getBalance({
          address: parameters.signer.address,
          blockNumber: currentHead,
        }),
      ]);
    if (block.baseFeePerGas === null) {
      return { status: "skipped", reason: "base_fee_unavailable", targetBlock };
    }
    const expectedValue =
      (round.entryPrice + round.incentivePerTicket) *
      BigInt(parameters.prerequisite.quantity);
    const stakeAdded =
      round.entryPrice * BigInt(parameters.prerequisite.quantity);
    const remainingPulls = round.pullsPerRound - round.bought;
    if (
      liveRound !== parameters.prerequisite.roundId ||
      round.state !== GROUP_PULL_ROUND_STATE.SELLING ||
      parameters.prerequisite.value !== expectedValue ||
      currentTarget === 0n ||
      round.escrow + stakeAdded < currentTarget ||
      remainingPulls <= 0 ||
      round.pullsPerRound <= 0
    ) {
      return {
        status: "skipped",
        reason: "entry_does_not_close_live_round",
        targetBlock,
      };
    }
    const baseFeeAllowancePerGas = nextBlockBaseFeePerGas({
      parentBaseFeePerGas: block.baseFeePerGas,
      parentGasUsed: block.gasUsed,
      parentGasLimit: block.gasLimit,
    });
    const exact = await exactPricedGroupPullSubmit({
      relay,
      signer: parameters.signer,
      prerequisite: parameters.prerequisite,
      targetBlock,
      nonce: latestNonce,
      accountBalance,
      baseFeeAllowancePerGas,
      remainingPulls,
      bountyPot: round.bountyPot,
      pullsPerRound: round.pullsPerRound,
      incentivePerTicket: round.incentivePerTicket,
      builderBidBps: parameters.builderBidBps,
      config: parameters.config,
    });
    if (abortRequested(parameters.signal)) {
      return { status: "skipped", reason: "shutdown", targetBlock };
    }
    if (exact === undefined) {
      return {
        status: "skipped",
        reason: "exact_simulation_or_profit_gate",
        targetBlock,
      };
    }
    log("info", "pending_group_pull_opportunity", {
      prerequisiteHash: parameters.prerequisite.hash,
      round: parameters.prerequisite.roundId.toString(),
      quantity: parameters.prerequisite.quantity,
      submitCalls: exact.calls,
      submitGasUsed: exact.gasUsed.toString(),
      grossReward: eth(exact.grossReward),
      builderBidBps: parameters.builderBidBps.toString(),
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
      maxFeePerGas: gwei(exact.maxFeePerGas),
      maxPriorityFeePerGas: gwei(exact.maxPriorityFeePerGas),
      expectedProfit: eth(exact.expectedProfit),
      targetBlock: targetBlock.toString(),
    });

    const [currentTx, currentRaw, finalLatest, finalPending] =
      await Promise.all([
        parameters.pendingClient
          .getTransaction({ hash: parameters.prerequisite.hash })
          .catch(() => undefined),
        parameters.pendingClient
          .getRawTransaction({ hash: parameters.prerequisite.hash })
          .catch(() => undefined),
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
      currentTx === undefined ||
      currentRaw === undefined ||
      currentRaw.toLowerCase() !==
        parameters.prerequisite.rawTransaction.toLowerCase() ||
      currentTx.blockNumber !== null ||
      !parameters.isPrerequisiteCurrent() ||
      parameters.targetBlockArrived(targetBlock) ||
      !signerNonceIsUsable({
        account: parameters.signer.address,
        expectedNonce: latestNonce,
        latestNonce: finalLatest,
        pendingNonce: finalPending,
      })
    ) {
      return {
        status: "skipped",
        reason: "final_pending_state_gate",
        targetBlock,
      };
    }
    await parameters.assertSignerLeaseHeld();
    const submissions = await submitBundleToRelays(
      parameters.relays,
      [parameters.prerequisite.rawTransaction, exact.signedSubmit],
      targetBlock,
      parameters.builders,
    );
    retainReservation = true;
    const submitHash = keccak256(exact.signedSubmit);
    log("info", "pending_group_pull_submitted", {
      prerequisiteHash: parameters.prerequisite.hash,
      hash: submitHash,
      round: parameters.prerequisite.roundId.toString(),
      nonce: latestNonce,
      targetBlock: targetBlock.toString(),
      relayCount: new Set(
        submissions.map((submission) => submission.relayUrl),
      ).size,
      bundleCount: submissions.length,
      transactionCount: 2,
      effectiveBuilderBidBps:
        exact.effectiveBuilderBidBps.toString(),
    });
    log("info", "keeper_transaction_sent", {
      kind: "group_pull_submit",
      label: `pending_group_pull_backrun:${parameters.prerequisite.roundId}`,
      hash: submitHash,
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
      return {
        status: "expired",
        reason: "target_block_unobserved",
        targetBlock,
        submitHash,
      };
    }
    const receipt = await getReceiptOrUndefined(
      parameters.publicClient,
      submitHash,
    );
    if (receipt === undefined) {
      log("warn", "keeper_transaction_expired", {
        kind: "group_pull_submit",
        label: `pending_group_pull_backrun:${parameters.prerequisite.roundId}`,
        hash: submitHash,
        nonce: latestNonce,
        targetBlock: targetBlock.toString(),
        prerequisiteHash: parameters.prerequisite.hash,
        reason: "private submit was not included",
      });
      return {
        status: "expired",
        reason: "submit_not_included",
        targetBlock,
        submitHash,
      };
    }
    const included = receiptSucceededInTarget({
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      targetBlock,
    });
    const paidReward = included
      ? decodedGroupPullBounty({
          caller: parameters.signer.address,
          roundId: parameters.prerequisite.roundId,
          logs: receipt.logs,
        })
      : 0n;
    if (included && paidReward === 0n) {
      log("warn", "pending_group_pull_accounting_failed", {
        prerequisiteHash: parameters.prerequisite.hash,
        hash: submitHash,
        round: parameters.prerequisite.roundId.toString(),
        reason: "BountyPaid event was missing",
      });
    }
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    const realizedProfit = paidReward - gasCost;
    log(included ? "info" : "warn", "keeper_receipt", {
      kind: "group_pull_submit",
      label: `pending_group_pull_backrun:${parameters.prerequisite.roundId}`,
      hash: submitHash,
      nonce: latestNonce,
      block: receipt.blockNumber.toString(),
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      paidReward: eth(paidReward),
      gasCost: eth(gasCost),
      realizedProfit: eth(realizedProfit),
      prerequisiteHash: parameters.prerequisite.hash,
      targetBlockMatched: receipt.blockNumber === targetBlock,
    });
    return {
      status: included ? "confirmed" : "expired",
      reason: included
        ? "confirmed"
        : receipt.blockNumber !== targetBlock
          ? "submit_wrong_block"
          : "submit_reverted",
      targetBlock,
      submitHash,
      realizedProfitWei: realizedProfit,
    };
  } finally {
    if (!retainReservation) parameters.coordinator.release(reservation);
  }
}
