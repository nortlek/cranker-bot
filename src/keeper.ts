import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
} from "viem";

import { factoryAbi, standingOrderAbi } from "./abi.js";
import { mapConcurrent } from "./concurrency.js";
import type { KeeperConfig } from "./config.js";
import { assessProfit } from "./economics.js";
import { errorMessage, eth, gwei, log } from "./format.js";
import { buildNoncePlan } from "./nonces.js";

interface OrderCandidate {
  readonly address: Address;
  readonly crankFee: bigint;
}

interface CrankOpportunity {
  readonly candidate: OrderCandidate;
  readonly gasLimit: bigint;
  readonly maxGasCost: bigint;
}

type CandidateEvaluation =
  | {
      readonly candidate: OrderCandidate;
      readonly estimatedGas: bigint;
      readonly opportunity: CrankOpportunity;
      readonly reason?: never;
    }
  | {
      readonly candidate: OrderCandidate;
      readonly reason: string;
      readonly estimatedGas?: never;
      readonly opportunity?: never;
    };

interface SubmittedCrank extends CrankOpportunity {
  readonly hash: Hash;
  readonly nonce: number;
}

export interface CrankTransactionRequest {
  readonly order: Address;
  readonly crankFee: bigint;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly nonce: number;
}

export interface CrankBatchResult {
  readonly hashes: readonly Hash[];
  readonly targetBlock: bigint;
  readonly relayCount: number;
  readonly effectiveBuilderBidBps?: bigint;
  readonly bundleCount?: number;
  readonly bundleHashes?: readonly Hash[];
  readonly bundles?: readonly {
    readonly bundleHash: Hash;
    readonly relayIndex: number;
    readonly smart: boolean;
    readonly transactionCount: number;
  }[];
}

export interface PrivateBatchOutcome {
  readonly targetBlock: bigint;
  readonly bidScope?: "standing_order" | "pending_funding_backrun";
  readonly poolVersion?: KeeperConfig["poolVersion"];
  readonly factoryAddress?: Address;
  readonly vaultFactoryAddress?: Address;
  readonly attempts: readonly {
    readonly order: Address;
    readonly crankFee: bigint;
    readonly hash: Hash;
    readonly included: boolean;
    readonly effectiveBidBps?: bigint;
  }[];
}

export interface PassResult {
  readonly orders: number;
  readonly viable: number;
  readonly sent: number;
  readonly confirmed: number;
}

export interface KeeperContext {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly sendCrank:
    | ((parameters: {
        readonly order: Address;
        readonly gas: bigint;
        readonly maxFeePerGas: bigint;
        readonly maxPriorityFeePerGas: bigint;
        readonly nonce: number;
      }) => Promise<Hash>)
    | undefined;
  readonly sendCrankBatch:
    | ((parameters: {
        readonly requests: readonly CrankTransactionRequest[];
        readonly targetBlock: bigint;
      }) => Promise<CrankBatchResult>)
    | undefined;
  readonly observePrivateBatch:
    | ((outcome: PrivateBatchOutcome) => Promise<void>)
    | undefined;
}

export function rankByFee(
  candidates: readonly OrderCandidate[],
): OrderCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.crankFee === b.crankFee) {
      return a.address.localeCompare(b.address);
    }
    return a.crankFee > b.crankFee ? -1 : 1;
  });
}

function revertedErrorName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(
    (candidate) => candidate instanceof ContractFunctionRevertedError,
  );
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  return reverted.data?.errorName;
}

async function getCandidates(
  client: PublicClient<Transport, Chain>,
  factoryAddress: Address,
): Promise<OrderCandidate[]> {
  const orders = await client.readContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "allOrders",
  });
  const feeResults = await client.multicall({
    allowFailure: true,
    contracts: orders.map((address) => ({
      address,
      abi: standingOrderAbi,
      functionName: "crankFee" as const,
    })),
  });

  const candidates: OrderCandidate[] = [];
  for (let index = 0; index < orders.length; index += 1) {
    const address = orders[index];
    const result = feeResults[index];
    if (address !== undefined && result?.status === "success") {
      candidates.push({ address, crankFee: result.result });
    }
  }
  return rankByFee(candidates);
}

function actualFeeFromReceipt(
  order: Address,
  logs: readonly {
    readonly address: Address;
    readonly data: `0x${string}`;
    readonly topics: [] | [`0x${string}`, ...`0x${string}`[]];
  }[],
  fallback: bigint,
): bigint {
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== order.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: standingOrderAbi,
        data: entry.data,
        topics: entry.topics,
      });
      if (decoded.eventName === "Cranked") return decoded.args.fee;
    } catch {
      // Not every log from the order must be Cranked.
    }
  }
  return fallback;
}

export async function runPass(context: KeeperContext): Promise<PassResult> {
  const {
    publicClient,
    sendCrank,
    sendCrankBatch,
    observePrivateBatch,
    account,
    config,
  } = context;
  const candidates = await getCandidates(
    publicClient,
    config.factoryAddress,
  );
  const feeQuote = await publicClient.estimateFeesPerGas({ type: "eip1559" });
  const maxPriorityFeePerGas =
    feeQuote.maxPriorityFeePerGas > config.minPriorityFeePerGas
      ? feeQuote.maxPriorityFeePerGas
      : config.minPriorityFeePerGas;
  const maxFeePerGas =
    feeQuote.maxFeePerGas +
    (maxPriorityFeePerGas - feeQuote.maxPriorityFeePerGas);

  if (maxFeePerGas > config.maxFeePerGas) {
    log("info", "gas_price_above_cap", {
      estimatedMaxFee: gwei(maxFeePerGas),
      configuredCap: gwei(config.maxFeePerGas),
      orders: candidates.length,
    });
    return { orders: candidates.length, viable: 0, sent: 0, confirmed: 0 };
  }

  const skipped = new Map<string, number>();
  const opportunities: CrankOpportunity[] = [];
  const evaluations = await mapConcurrent(
    candidates,
    config.simulationConcurrency,
    async (candidate): Promise<CandidateEvaluation> => {
      if (candidate.crankFee < config.minProfitWei) {
        return { candidate, reason: "fee_below_absolute_floor" };
      }

      let estimatedGas: bigint;
      try {
        estimatedGas = await publicClient.estimateContractGas({
          account,
          address: candidate.address,
          abi: standingOrderAbi,
          functionName: "crank",
        });
      } catch (error) {
        const reason = revertedErrorName(error) ?? "simulation_failed";
        return { candidate, reason };
      }

      const decision = assessProfit({
        crankFee: candidate.crankFee,
        estimatedGas,
        maxFeePerGas,
        gasLimitMultiplierBps: config.gasLimitMultiplierBps,
        minProfitWei: config.minProfitWei,
      });
      if (!decision.profitable) {
        return { candidate, reason: "unprofitable" };
      }

      return {
        candidate,
        estimatedGas,
        opportunity: {
          candidate,
          gasLimit: decision.gasLimit,
          maxGasCost: decision.maxGasCost,
        },
      };
    },
  );

  for (const evaluation of evaluations) {
    if (evaluation.reason !== undefined) {
      skipped.set(
        evaluation.reason,
        1 + (skipped.get(evaluation.reason) ?? 0),
      );
      continue;
    }
    if (
      config.maxTransactionsPerPass !== 0 &&
      opportunities.length >= config.maxTransactionsPerPass
    ) {
      break;
    }
    opportunities.push(evaluation.opportunity);
    log("info", "crank_opportunity", {
      order: evaluation.candidate.address,
      crankFee: eth(evaluation.candidate.crankFee),
      estimatedGas: evaluation.estimatedGas.toString(),
      gasLimit: evaluation.opportunity.gasLimit.toString(),
      maxFeePerGas: gwei(maxFeePerGas),
      maxPriorityFeePerGas: gwei(maxPriorityFeePerGas),
      worstCaseProfit: eth(
        evaluation.candidate.crankFee -
          evaluation.opportunity.maxGasCost,
      ),
      dryRun: config.dryRun,
    });
  }

  const viable = opportunities.length;
  if (config.dryRun || viable === 0) {
    log("info", "pass_complete", {
      orders: candidates.length,
      viable,
      sent: 0,
      confirmed: 0,
      skipped: JSON.stringify(Object.fromEntries(skipped)),
    });
    return { orders: candidates.length, viable, sent: 0, confirmed: 0 };
  }
  if (sendCrank === undefined && sendCrankBatch === undefined) {
    throw new Error("live mode requires a configured transaction sender");
  }

  const accountAddress =
    typeof account === "string" ? account : account.address;
  const [latestNonce, pendingNonce, accountBalance] = await Promise.all([
    publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: "latest",
    }),
    publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: "pending",
    }),
    publicClient.getBalance({ address: accountAddress }),
  ]);
  const noncePlan = buildNoncePlan(
    { latest: latestNonce, pending: pendingNonce },
    opportunities.length,
  );
  if (noncePlan.blocked) {
    log("warn", "nonce_batch_blocked", {
      account: accountAddress,
      latestNonce,
      pendingNonce,
      inFlight: pendingNonce - latestNonce,
      reason: "account_has_pending_transactions",
    });
    log("info", "pass_complete", {
      orders: candidates.length,
      viable,
      sent: 0,
      confirmed: 0,
      skipped: JSON.stringify(Object.fromEntries(skipped)),
    });
    return { orders: candidates.length, viable, sent: 0, confirmed: 0 };
  }

  const planned: Array<{
    readonly opportunity: CrankOpportunity;
    readonly nonce: number;
  }> = [];
  let reservedGasCost = 0n;
  for (let index = 0; index < opportunities.length; index += 1) {
    const opportunity = opportunities[index];
    const nonce = noncePlan.nonces[planned.length];
    if (opportunity === undefined || nonce === undefined) {
      throw new Error("nonce plan did not cover every opportunity");
    }
    if (reservedGasCost + opportunity.maxGasCost > accountBalance) {
      skipped.set(
        "keeper_balance_reserve",
        1 + (skipped.get("keeper_balance_reserve") ?? 0),
      );
      continue;
    }
    reservedGasCost += opportunity.maxGasCost;
    planned.push({ opportunity, nonce });
  }

  const submitted: SubmittedCrank[] = [];
  let privateTargetBlock: bigint | undefined;
  let relayCount = 0;
  let privateBatchResult: CrankBatchResult | undefined;
  if (sendCrankBatch !== undefined && planned.length > 0) {
    const targetBlock = (await publicClient.getBlockNumber()) + 1n;
    try {
      const result = await sendCrankBatch({
        requests: planned.map(({ opportunity, nonce }) => ({
          order: opportunity.candidate.address,
          crankFee: opportunity.candidate.crankFee,
          gas: opportunity.gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        })),
        targetBlock,
      });
      if (result.hashes.length > planned.length) {
        throw new Error("private sender returned more hashes than requested");
      }
      privateTargetBlock = result.targetBlock;
      relayCount = result.relayCount;
      privateBatchResult = result;
      for (const bundle of result.bundles ?? []) {
        log("info", "flashbots_bundle_accepted", {
          bundleHash: bundle.bundleHash,
          targetBlock: result.targetBlock.toString(),
          relayIndex: bundle.relayIndex,
          smart: bundle.smart,
          transactionCount: bundle.transactionCount,
        });
      }
      for (let index = 0; index < result.hashes.length; index += 1) {
        const hash = result.hashes[index];
        const item = planned[index];
        if (hash === undefined || item === undefined) {
          throw new Error("private sender returned an incomplete hash list");
        }
        submitted.push({
          ...item.opportunity,
          hash,
          nonce: item.nonce,
        });
        log("info", "crank_sent", {
          order: item.opportunity.candidate.address,
          hash,
          nonce: item.nonce,
          mode: "flashbots",
          targetBlock: result.targetBlock.toString(),
        });
      }
      const trimmed = planned.length - submitted.length;
      if (trimmed !== 0) {
        skipped.set(
          "private_batch_trimmed",
          trimmed + (skipped.get("private_batch_trimmed") ?? 0),
        );
      }
    } catch (error) {
      log("warn", "crank_batch_submission_failed", {
        reason: errorMessage(error),
        targetBlock: targetBlock.toString(),
      });
    }
  } else if (sendCrank !== undefined) {
    for (const { opportunity, nonce } of planned) {
      try {
        const hash = await sendCrank({
          order: opportunity.candidate.address,
          gas: opportunity.gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        });
        submitted.push({ ...opportunity, hash, nonce });
        log("info", "crank_sent", {
          order: opportunity.candidate.address,
          hash,
          nonce,
          mode: "public",
        });
      } catch (error) {
        log("warn", "crank_submission_failed", {
          order: opportunity.candidate.address,
          nonce,
          reason: revertedErrorName(error) ?? errorMessage(error),
          action: "stopping_batch_to_avoid_nonce_gap",
        });
        break;
      }
    }
  }

  log("info", "crank_batch_sent", {
    planned: planned.length,
    sent: submitted.length,
    firstNonce: submitted[0]?.nonce ?? pendingNonce,
    lastNonce: submitted.at(-1)?.nonce ?? pendingNonce,
    reservedMaxGasCost: eth(reservedGasCost),
    mode: privateTargetBlock === undefined ? "public" : "flashbots",
    targetBlock: privateTargetBlock?.toString() ?? "",
    relayCount,
    bundleCount: privateBatchResult?.bundleCount ?? 0,
    bundleHashes: JSON.stringify(
      privateBatchResult?.bundleHashes ?? [],
    ),
  });

  if (privateTargetBlock !== undefined) {
    const deadline = Date.now() + config.receiptTimeoutMs;
    while (
      (await publicClient.getBlockNumber()) < privateTargetBlock &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.blockPollMs),
      );
    }
  }

  const receiptResults = await Promise.all(
    submitted.map(async (submission) => {
      try {
        const receipt =
          privateTargetBlock === undefined
            ? await publicClient.waitForTransactionReceipt({
                hash: submission.hash,
                confirmations: config.confirmations,
                timeout: config.receiptTimeoutMs,
              })
            : await publicClient.getTransactionReceipt({
                hash: submission.hash,
              });
        const successful = receipt.status === "success";
        const paidFee = successful
          ? actualFeeFromReceipt(
              submission.candidate.address,
              receipt.logs,
              submission.candidate.crankFee,
            )
          : 0n;
        const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
        const realizedProfit = paidFee - gasCost;
        log(successful ? "info" : "warn", "crank_receipt", {
          order: submission.candidate.address,
          hash: submission.hash,
          nonce: submission.nonce,
          block: receipt.blockNumber.toString(),
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: gwei(receipt.effectiveGasPrice),
          paidFee: eth(paidFee),
          gasCost: eth(gasCost),
          realizedProfit: eth(realizedProfit),
        });
        return successful;
      } catch (error) {
        log(
          "warn",
          privateTargetBlock === undefined
            ? "crank_receipt_unresolved"
            : "crank_expired",
          {
            order: submission.candidate.address,
            hash: submission.hash,
            nonce: submission.nonce,
            targetBlock: privateTargetBlock?.toString() ?? "",
            reason: errorMessage(error),
          },
        );
        return false;
      }
    }),
  );
  const confirmed = receiptResults.filter(Boolean).length;
  const sent = submitted.length;
  if (
    privateTargetBlock !== undefined &&
    submitted.length > 0 &&
    observePrivateBatch !== undefined
  ) {
    try {
      await observePrivateBatch({
        targetBlock: privateTargetBlock,
        attempts: submitted.map((submission, index) => {
          const effectiveBidBps =
            privateBatchResult?.effectiveBuilderBidBps;
          return {
            order: submission.candidate.address,
            crankFee: submission.candidate.crankFee,
            hash: submission.hash,
            included: receiptResults[index] ?? false,
            ...(effectiveBidBps === undefined
              ? {}
              : { effectiveBidBps }),
          };
        }),
      });
    } catch (error) {
      log("warn", "adaptive_bid_observation_failed", {
        targetBlock: privateTargetBlock.toString(),
        reason: errorMessage(error),
      });
    }
  }
  log("info", "pass_complete", {
    orders: candidates.length,
    viable,
    sent,
    confirmed,
    skipped: JSON.stringify(Object.fromEntries(skipped)),
  });
  return { orders: candidates.length, viable, sent, confirmed };
}
