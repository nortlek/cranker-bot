import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import {
  chainlinkPriceFeedAbi,
  convexBoosterAbi,
  convexLockerAbi,
  curveGaugeAbi,
  factoryAbi,
  fwaAbi,
  fwaTokenAbi,
  liquityPriceFeedAbi,
  liquityTroveManagerAbi,
  liveBidAdapterAbi,
  poolAbi,
  standingOrderAbi,
  vaultFactoryAbi,
} from "./abi.js";
import { quoteCompetitiveFees } from "./bidding.js";
import { mapConcurrent } from "./concurrency.js";
import type { KeeperConfig } from "./config.js";
import {
  CONVEX_BOOSTER_ADDRESS,
  CONVEX_KICK_CANDIDATES,
  CONVEX_LOCKER_ADDRESS,
  CRV_USD_FEED_ADDRESS,
  CVX_USD_FEED_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  LIQUITY_BRANCHES,
  LIQUITY_ETH_GAS_COMPENSATION,
} from "./constants.js";
import {
  assessProfit,
  bufferedGas,
  requiredProfit,
} from "./economics.js";
import { errorMessage, eth, gwei, log } from "./format.js";
import {
  ACQUISITION_STATUS,
  ROUND_STATE,
  acquisitionProcessCount,
  acquisitionStatusName,
  buybackCallerReward,
  estimatePoolBounty,
  liveBidSweepRewardFromSimulation,
  routeRoundIds,
  selectOrdersForCoverage,
  type PoolBountyTerms,
} from "./lifecycle.js";
import type { PrivateBatchOutcome } from "./keeper.js";
import { buildNoncePlan } from "./nonces.js";

export type KeeperJobKind =
  | "standing_order"
  | "fwa_process"
  | "pool_pull"
  | "pool_sync"
  | "pool_settle"
  | "pool_settle_forced_eth"
  | "fwa_buyback"
  | "live_bid_sweep"
  | "liquity_liquidation"
  | "convex_earmark"
  | "convex_kick";

export type PoolBuilderBidPolicy =
  | "pool_pull"
  | "pool_ready"
  | "pool_fulfilled";

export type JobReward =
  | {
      readonly kind: "fixed";
      readonly amountWei: bigint;
    }
  | {
      readonly kind: "pool_bounty";
      readonly terms: PoolBountyTerms;
    };

export interface KeeperJob {
  readonly kind: KeeperJobKind;
  readonly label: string;
  readonly target: Address;
  readonly data: Hex;
  readonly gas: bigint;
  readonly reward: JobReward;
  readonly poolBuilderBidPolicy?: PoolBuilderBidPolicy;
  readonly order?: Address;
  readonly roundId?: bigint;
}

export interface KeeperTransactionRequest extends KeeperJob {
  readonly nonce: number;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface KeeperBatchResult {
  readonly hashes: readonly Hash[];
  readonly targetBlock: bigint;
  readonly relayCount: number;
  readonly bundleCount?: number;
  readonly bundleHashes?: readonly Hash[];
  readonly bundles?: readonly {
    readonly bundleHash: Hash;
    readonly relayIndex: number;
    readonly smart: boolean;
    readonly transactionCount: number;
  }[];
}

export interface KeeperPassResult {
  readonly orders: number;
  readonly viable: number;
  readonly sent: number;
  readonly confirmed: number;
}

export interface StrategyContext {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly sendTransaction:
    | ((request: KeeperTransactionRequest) => Promise<Hash>)
    | undefined;
  readonly sendBatch:
    | ((parameters: {
      readonly requests: readonly KeeperTransactionRequest[];
      readonly targetBlock: bigint;
      readonly minimumViablePrefix: number;
      readonly bountyBaseFeePerGas: bigint;
    }) => Promise<KeeperBatchResult>)
    | undefined;
  readonly observePrivateBatch:
    | ((outcome: PrivateBatchOutcome) => Promise<void>)
    | undefined;
}

interface OrderCandidate {
  readonly address: Address;
  readonly crankFee: bigint;
  readonly ticketsPerRound: bigint;
}

interface EligibleOrder extends OrderCandidate {
  readonly estimatedGas: bigint;
  readonly gasLimit: bigint;
  readonly maxGasCost: bigint;
  readonly independentlyProfitable: boolean;
}

interface PlannedJobs {
  readonly jobs: readonly KeeperJob[];
  readonly minimumViablePrefix: number;
  readonly orders: number;
  readonly skipped: Map<string, number>;
}

let lastKnownOrderCount = 0;

interface SubmittedJob {
  readonly request: KeeperTransactionRequest;
  readonly hash: Hash;
}

interface PoolRoundSnapshot {
  readonly crankBountyCap: bigint;
  readonly bountyTipWei: bigint;
  readonly fwaRequestId: bigint;
  readonly state: number;
}

interface ConvexPool {
  readonly pid: bigint;
  readonly gauge: Address;
}

let convexPoolsPromise: Promise<readonly ConvexPool[]> | undefined;

function getConvexPools(
  client: PublicClient<Transport, Chain>,
): Promise<readonly ConvexPool[]> {
  if (convexPoolsPromise !== undefined) return convexPoolsPromise;
  convexPoolsPromise = (async () => {
    const count = await client.readContract({
      address: CONVEX_BOOSTER_ADDRESS,
      abi: convexBoosterAbi,
      functionName: "poolLength",
    });
    if (count > 2_000n) {
      throw new Error(`Convex pool count ${count} exceeds safety limit`);
    }
    const results = await client.multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: Array.from({ length: Number(count) }, (_, pid) => ({
        address: CONVEX_BOOSTER_ADDRESS,
        abi: convexBoosterAbi,
        functionName: "poolInfo" as const,
        args: [BigInt(pid)] as const,
      })),
    });
    return results.flatMap((result, pid) =>
      result.status === "success" && !result.result[5]
        ? [{ pid: BigInt(pid), gauge: result.result[2] }]
        : [],
    );
  })().catch((error: unknown) => {
    convexPoolsPromise = undefined;
    throw error;
  });
  return convexPoolsPromise;
}

async function getRoundSnapshot(
  client: PublicClient<Transport, Chain>,
  pool: Address,
  roundId: bigint,
): Promise<PoolRoundSnapshot> {
  const round = await client.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "getRound",
    args: [roundId],
  });
  return {
    crankBountyCap: round.crankBountyCap,
    bountyTipWei: round.bountyTipWei,
    fwaRequestId: round.fwaRequestId,
    state: round.state,
  };
}

function incrementReason(reasons: Map<string, number>, reason: string): void {
  reasons.set(reason, 1 + (reasons.get(reason) ?? 0));
}

function revertedErrorName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(
    (candidate) => candidate instanceof ContractFunctionRevertedError,
  );
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  return reverted.data?.errorName;
}

async function getOrderCandidates(
  client: PublicClient<Transport, Chain>,
  factoryAddress: Address,
  vaultFactoryAddress: Address | undefined,
): Promise<OrderCandidate[]> {
  const [orders, vaults] = await Promise.all([
    client.readContract({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "allOrders",
    }),
    vaultFactoryAddress === undefined
      ? Promise.resolve([])
      : client.readContract({
          address: vaultFactoryAddress,
          abi: vaultFactoryAbi,
          functionName: "allVaults",
        }),
  ]);
  const subscriptions = [...new Set([...orders, ...vaults])];
  const [feeResults, ticketResults] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: subscriptions.map((address) => ({
        address,
        abi: standingOrderAbi,
        functionName: "crankFee" as const,
      })),
    }),
    client.multicall({
      allowFailure: true,
      contracts: subscriptions.map((address) => ({
        address,
        abi: standingOrderAbi,
        functionName: "ticketsPerRound" as const,
      })),
    }),
  ]);

  const candidates: OrderCandidate[] = [];
  for (let index = 0; index < subscriptions.length; index += 1) {
    const address = subscriptions[index];
    const fee = feeResults[index];
    const tickets = ticketResults[index];
    if (
      address !== undefined &&
      fee?.status === "success" &&
      tickets?.status === "success"
    ) {
      candidates.push({
        address,
        crankFee: fee.result,
        ticketsPerRound: BigInt(tickets.result),
      });
    }
  }
  return candidates.sort((a, b) => {
    if (a.crankFee === b.crankFee) {
      return a.address.localeCompare(b.address);
    }
    return a.crankFee > b.crankFee ? -1 : 1;
  });
}

async function getEligibleOrders(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly candidates: readonly OrderCandidate[];
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<EligibleOrder[]> {
  const evaluations = await mapConcurrent(
    parameters.candidates,
    parameters.config.simulationConcurrency,
    async (candidate): Promise<
      | { readonly candidate: OrderCandidate; readonly gas: bigint }
      | { readonly reason: string }
    > => {
      try {
        const gas = await parameters.client.estimateContractGas({
          account: parameters.account,
          address: candidate.address,
          abi: standingOrderAbi,
          functionName: "crank",
        });
        return { candidate, gas };
      } catch (error) {
        return {
          reason: revertedErrorName(error) ?? "order_simulation_failed",
        };
      }
    },
  );

  const eligible: EligibleOrder[] = [];
  for (const evaluation of evaluations) {
    if ("reason" in evaluation) {
      incrementReason(parameters.skipped, evaluation.reason);
      continue;
    }
    const decision = assessProfit({
      crankFee: evaluation.candidate.crankFee,
      estimatedGas: evaluation.gas,
      maxFeePerGas: parameters.maxFeePerGas,
      gasLimitMultiplierBps:
        parameters.config.gasLimitMultiplierBps,
      minProfitWei: parameters.config.minProfitWei,
    });
    eligible.push({
      ...evaluation.candidate,
      estimatedGas: evaluation.gas,
      gasLimit: decision.gasLimit,
      maxGasCost: decision.maxGasCost,
      independentlyProfitable: decision.profitable,
    });
  }
  return eligible;
}

function orderJob(order: EligibleOrder): KeeperJob {
  return {
    kind: "standing_order",
    label: `standing_order:${order.address}`,
    target: order.address,
    data: encodeFunctionData({
      abi: standingOrderAbi,
      functionName: "crank",
    }),
    gas: order.gasLimit,
    reward: { kind: "fixed", amountWei: order.crankFee },
    order: order.address,
  };
}

function poolJob(parameters: {
  readonly kind:
    | "pool_pull"
    | "pool_sync"
    | "pool_settle"
    | "pool_settle_forced_eth";
  readonly pool: Address;
  readonly roundId: bigint;
  readonly gas: bigint;
  readonly terms: PoolBountyTerms;
  readonly bidPolicy: PoolBuilderBidPolicy;
}): KeeperJob {
  const functionName = {
    pool_pull: "pull",
    pool_sync: "syncFwaResult",
    pool_settle: "settle",
    pool_settle_forced_eth: "settleForcedEth",
  }[parameters.kind] as
    | "pull"
    | "syncFwaResult"
    | "settle"
    | "settleForcedEth";
  return {
    kind: parameters.kind,
    label: `${functionName}:${parameters.roundId}`,
    target: parameters.pool,
    data: encodeFunctionData({
      abi: poolAbi,
      functionName,
      args: [parameters.roundId],
    }),
    gas: parameters.gas,
    reward: {
      kind: "pool_bounty",
      terms: parameters.terms,
    },
    poolBuilderBidPolicy: parameters.bidPolicy,
    roundId: parameters.roundId,
  };
}

function fwaProcessJob(parameters: {
  readonly fwa: Address;
  readonly gas: bigint;
  readonly count: bigint;
}): KeeperJob {
  return {
    kind: "fwa_process",
    label: `fwa_process:${parameters.count}`,
    target: parameters.fwa,
    data: encodeFunctionData({
      abi: fwaAbi,
      functionName: "processAcquisitions",
      args: [parameters.count],
    }),
    gas: parameters.gas,
    reward: { kind: "fixed", amountWei: 0n },
    poolBuilderBidPolicy: "pool_ready",
  };
}

async function estimatePoolCall(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly pool: Address;
  readonly functionName:
    | "pull"
    | "syncFwaResult"
    | "settle"
    | "settleForcedEth";
  readonly roundId: bigint;
  readonly config: KeeperConfig;
}): Promise<bigint> {
  const estimate = await parameters.client.estimateContractGas({
    account: parameters.account,
    address: parameters.pool,
    abi: poolAbi,
    functionName: parameters.functionName,
    args: [parameters.roundId],
  });
  return bufferedGas(
    estimate,
    parameters.config.gasLimitMultiplierBps,
  );
}

function maxJobs(config: KeeperConfig): number {
  if (config.maxTransactionsPerPass === 0) return 100;
  return Math.min(config.maxTransactionsPerPass, 100);
}

async function planPrimaryJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly pool: Address;
  readonly fwa: Address;
  readonly candidates: readonly OrderCandidate[];
  readonly roundCount: bigint;
  readonly round: PoolRoundSnapshot | undefined;
  readonly maxFeePerGas: bigint;
  readonly bountyBaseFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<{
  readonly jobs: KeeperJob[];
  readonly minimumViablePrefix: number;
}> {
  const {
    client,
    account,
    config,
    pool,
    fwa,
    candidates,
    roundCount,
    maxFeePerGas,
    bountyBaseFeePerGas,
    skipped,
  } = parameters;
  const limit = maxJobs(config);
  if (limit === 0) return { jobs: [], minimumViablePrefix: 0 };

  const round = parameters.round;
  const state =
    round === undefined ? ROUND_STATE.none : round.state;
  const terms: PoolBountyTerms | undefined =
    round === undefined
      ? undefined
      : {
          crankBountyCap: round.crankBountyCap,
          bountyTipWei: round.bountyTipWei,
        };

  if (
    config.enablePoolLifecycle &&
    round !== undefined &&
    terms !== undefined &&
    state === ROUND_STATE.pulling
  ) {
    const requestId = round.fwaRequestId;
    const acquisition = await client.readContract({
      address: fwa,
      abi: fwaAbi,
      functionName: "acquisitions",
      args: [requestId],
    });
    const acquisitionStatus = Number(acquisition[4]);
    const acquisitionStatusLabel =
      acquisitionStatusName(acquisitionStatus);
    log("debug", "acquisition_status", {
      round: roundCount.toString(),
      requestId: requestId.toString(),
      status: acquisitionStatusLabel,
      statusCode: acquisitionStatus,
    });
    if (acquisitionStatus === ACQUISITION_STATUS.ready) {
      if (config.submissionMode !== "flashbots") {
        incrementReason(
          skipped,
          "acquisition_ready_private_sequence_required",
        );
        return { jobs: [], minimumViablePrefix: 0 };
      }
      if (limit < 2) {
        incrementReason(
          skipped,
          "acquisition_ready_transaction_limit",
        );
        return { jobs: [], minimumViablePrefix: 0 };
      }
      try {
        const [nextSequence, lastIssuedSequence] =
          await Promise.all([
            client.readContract({
              address: fwa,
              abi: fwaAbi,
              functionName: "nextSequenceToProcess",
            }),
            client.readContract({
              address: fwa,
              abi: fwaAbi,
              functionName: "lastIssuedSequence",
            }),
          ]);
        const availableSequenceCount =
          lastIssuedSequence < nextSequence
            ? 0
            : Number(
                lastIssuedSequence - nextSequence + 1n <
                  BigInt(config.fwaProcessMaxCount)
                  ? lastIssuedSequence - nextSequence + 1n
                  : BigInt(config.fwaProcessMaxCount),
              );
        const processSequences = Array.from(
          { length: availableSequenceCount },
          (_, index) => nextSequence + BigInt(index),
        );
        const queuedRequestIds = await client.multicall({
          allowFailure: false,
          contracts: processSequences.map((sequence) => ({
            address: fwa,
            abi: fwaAbi,
            functionName: "requestIdAtSequence" as const,
            args: [sequence] as const,
          })),
        });
        const processCount = acquisitionProcessCount(
          requestId,
          queuedRequestIds,
        );
        if (processCount === undefined) {
          incrementReason(
            skipped,
            "acquisition_ready_outside_process_window",
          );
          return { jobs: [], minimumViablePrefix: 0 };
        }
        const [processSimulation, processEstimate] =
          await Promise.all([
            client.simulateContract({
              account,
              address: fwa,
              abi: fwaAbi,
              functionName: "processAcquisitions",
              args: [processCount],
            }),
            client.estimateContractGas({
              account,
              address: fwa,
              abi: fwaAbi,
              functionName: "processAcquisitions",
              args: [processCount],
            }),
          ]);
        if (processSimulation.result < processCount) {
          incrementReason(
            skipped,
            "fwa_process_incomplete_window",
          );
          return { jobs: [], minimumViablePrefix: 0 };
        }
        const processGas = bufferedGas(
          processEstimate,
          config.gasLimitMultiplierBps,
        );
        if (processGas > config.fwaProcessGasLimit) {
          incrementReason(
            skipped,
            "fwa_process_gas_above_limit",
          );
          return { jobs: [], minimumViablePrefix: 0 };
        }
        const jobs = [
          fwaProcessJob({
            fwa,
            gas: processGas,
            count: processCount,
          }),
          poolJob({
            kind: "pool_sync",
            pool,
            roundId: roundCount,
            gas: config.poolSyncGasLimit,
            terms,
            bidPolicy: "pool_ready",
          }),
        ];
        if (jobs.length < limit) {
          jobs.push(
            poolJob({
              kind: "pool_settle",
              pool,
              roundId: roundCount,
              gas: config.poolSettleGasLimit,
              terms,
              bidPolicy: "pool_ready",
            }),
          );
        }
        return { jobs, minimumViablePrefix: 2 };
      } catch (error) {
        incrementReason(
          skipped,
          revertedErrorName(error) ??
            "fwa_process_simulation_failed",
        );
        return { jobs: [], minimumViablePrefix: 0 };
      }
    }
    if (acquisitionStatus !== ACQUISITION_STATUS.fulfilled) {
      incrementReason(
        skipped,
        `acquisition_status_${acquisitionStatusLabel}`,
      );
      return { jobs: [], minimumViablePrefix: 0 };
    }
    try {
      const syncGas = await estimatePoolCall({
        client,
        account,
        pool,
        functionName: "syncFwaResult",
        roundId: roundCount,
        config,
      });
      const jobs = [
        poolJob({
          kind: "pool_sync",
          pool,
          roundId: roundCount,
          gas: syncGas,
          terms,
          bidPolicy: "pool_fulfilled",
        }),
      ];
      if (
        config.submissionMode === "flashbots" &&
        jobs.length < limit
      ) {
        jobs.push(
          poolJob({
            kind: "pool_settle",
            pool,
            roundId: roundCount,
            gas: config.poolSettleGasLimit,
            terms,
            bidPolicy: "pool_fulfilled",
          }),
        );
      }
      return { jobs, minimumViablePrefix: 1 };
    } catch (error) {
      incrementReason(
        skipped,
        revertedErrorName(error) ?? "pool_sync_simulation_failed",
      );
      return { jobs: [], minimumViablePrefix: 0 };
    }
  }

  if (
    config.enablePoolLifecycle &&
    round !== undefined &&
    terms !== undefined &&
    state === ROUND_STATE.claimable
  ) {
    for (const [kind, functionName] of [
      ["pool_settle", "settle"],
      ["pool_settle_forced_eth", "settleForcedEth"],
    ] as const) {
      try {
        const gas = await estimatePoolCall({
          client,
          account,
          pool,
          functionName,
          roundId: roundCount,
          config,
        });
        return {
          jobs: [
            poolJob({
              kind,
              pool,
              roundId: roundCount,
              gas,
              terms,
              bidPolicy: "pool_fulfilled",
            }),
          ],
          minimumViablePrefix: 1,
        };
      } catch (error) {
        incrementReason(
          skipped,
          revertedErrorName(error) ??
            `${functionName}_simulation_failed`,
        );
      }
    }
    return { jobs: [], minimumViablePrefix: 0 };
  }

  const mayCrankOrders =
    round === undefined ||
    state === ROUND_STATE.none ||
    state === ROUND_STATE.open ||
    state === ROUND_STATE.settled ||
    state === ROUND_STATE.refunding;
  if (!mayCrankOrders) return { jobs: [], minimumViablePrefix: 0 };

  if (
    config.enablePoolLifecycle &&
    round !== undefined &&
    terms !== undefined &&
    state === ROUND_STATE.open
  ) {
    const needed = await client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "ticketsNeeded",
      args: [roundCount],
    });
    if (needed === 0n) {
      try {
        const gas = await estimatePoolCall({
          client,
          account,
          pool,
          functionName: "pull",
          roundId: roundCount,
          config,
        });
        return {
          jobs: [
            poolJob({
              kind: "pool_pull",
              pool,
              roundId: roundCount,
              gas,
              terms,
              bidPolicy: "pool_pull",
            }),
          ],
          minimumViablePrefix: 1,
        };
      } catch (error) {
        incrementReason(
          skipped,
          revertedErrorName(error) ?? "pool_pull_simulation_failed",
        );
        return { jobs: [], minimumViablePrefix: 0 };
      }
    }

    const eligible = await getEligibleOrders({
      client,
      account,
      candidates,
      config,
      maxFeePerGas,
      skipped,
    });
    if (config.submissionMode === "flashbots" && limit >= 2) {
      const selected = selectOrdersForCoverage({
        orders: eligible.map((order) => ({
          address: order.address,
          tickets: order.ticketsPerRound,
          rewardWei: order.crankFee,
          gasCostWei: order.maxGasCost,
        })),
        ticketsNeeded: needed,
        maxOrders: limit - 1,
      });
      if (selected !== undefined) {
        const selectedAddresses = new Set(
          selected.map((order) => order.address.toLowerCase()),
        );
        const selectedOrders = eligible.filter((order) =>
          selectedAddresses.has(order.address.toLowerCase()),
        );
        const jobs = selectedOrders.map(orderJob);
        jobs.push(
          poolJob({
            kind: "pool_pull",
            pool,
            roundId: roundCount,
            gas: config.poolPullGasLimit,
            terms,
            bidPolicy: "pool_pull",
          }),
        );
        const grossReward = jobs.reduce(
          (total, job) =>
            total +
            estimatedJobReward({
              job,
              gasUsed: job.gas,
              baseFeePerGas: bountyBaseFeePerGas,
              poolBountyEstimateBps:
                config.poolBountyEstimateBps,
            }),
          0n,
        );
        const gasCost = jobs.reduce(
          (total, job) => total + job.gas * maxFeePerGas,
          0n,
        );
        if (
          grossReward - gasCost >= requiredProfit(config.minProfitWei)
        ) {
          return {
            jobs,
            minimumViablePrefix: jobs.length,
          };
        }
        incrementReason(
          skipped,
          "coverage_bundle_unprofitable",
        );
      } else {
        incrementReason(
          skipped,
          "insufficient_crankable_ticket_coverage",
        );
      }
    }

    return {
      jobs: eligible
        .filter((order) => order.independentlyProfitable)
        .slice(0, limit)
        .map(orderJob),
      minimumViablePrefix: 1,
    };
  }

  const eligible = await getEligibleOrders({
    client,
    account,
    candidates,
    config,
    maxFeePerGas,
    skipped,
  });
  return {
    jobs: eligible
      .filter((order) => order.independentlyProfitable)
      .slice(0, limit)
      .map(orderJob),
    minimumViablePrefix: 1,
  };
}

async function planBuyback(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly token: Address;
  readonly maxFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableBuyback) return undefined;
  const [balance, increment, rewardBps] = await Promise.all([
    parameters.client.getBalance({ address: parameters.token }),
    parameters.client.readContract({
      address: parameters.token,
      abi: fwaTokenAbi,
      functionName: "BUYBACK_INCREMENT",
    }),
    parameters.client.readContract({
      address: parameters.token,
      abi: fwaTokenAbi,
      functionName: "CALLER_REWARD_BPS",
    }),
  ]);
  if (balance === 0n) {
    incrementReason(parameters.skipped, "buyback_no_eth");
    return undefined;
  }
  const reward = buybackCallerReward({
    tokenEthBalance: balance,
    buybackIncrement: increment,
    callerRewardBps: rewardBps,
  });
  try {
    const estimatedGas = await parameters.client.estimateContractGas({
      account: parameters.account,
      address: parameters.token,
      abi: fwaTokenAbi,
      functionName: "buyback",
    });
    const decision = assessProfit({
      crankFee: reward,
      estimatedGas,
      maxFeePerGas: parameters.maxFeePerGas,
      gasLimitMultiplierBps:
        parameters.config.gasLimitMultiplierBps,
      minProfitWei: parameters.config.minProfitWei,
    });
    if (!decision.profitable) {
      incrementReason(parameters.skipped, "buyback_unprofitable");
      return undefined;
    }
    if (decision.gasLimit > parameters.config.buybackGasLimit) {
      incrementReason(
        parameters.skipped,
        "buyback_gas_above_limit",
      );
      return undefined;
    }
    return {
      kind: "fwa_buyback",
      label: "fwa_buyback",
      target: parameters.token,
      data: encodeFunctionData({
        abi: fwaTokenAbi,
        functionName: "buyback",
      }),
      gas: decision.gasLimit,
      reward: { kind: "fixed", amountWei: reward },
    };
  } catch (error) {
    incrementReason(
      parameters.skipped,
      revertedErrorName(error) ?? "buyback_simulation_failed",
    );
    return undefined;
  }
}

async function planLiveBidSweep(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly baseFeeAllowancePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableLiveBidSweep) return undefined;
  try {
    const adapter = parameters.config.liveBidAdapterAddress;
    const adapterBalanceWei =
      await parameters.client.readContract({
        address: adapter,
        abi: liveBidAdapterAbi,
        functionName: "bufferedEth",
      });
    if (adapterBalanceWei === 0n) {
      incrementReason(
        parameters.skipped,
        "live_bid_sweep_no_eth",
      );
      return undefined;
    }
    const [
      keeperRewardBps,
      keeperRewardCapWei,
      maxSweepWei,
    ] = await Promise.all([
      parameters.client.readContract({
        address: adapter,
        abi: liveBidAdapterAbi,
        functionName: "KEEPER_REWARD_BPS",
      }),
      parameters.client.readContract({
        address: adapter,
        abi: liveBidAdapterAbi,
        functionName: "KEEPER_REWARD_CAP",
      }),
      parameters.client.readContract({
        address: adapter,
        abi: liveBidAdapterAbi,
        functionName: "maxSweepWei",
      }),
    ]);
    const simulation =
      await parameters.client.simulateContract({
        account: parameters.account,
        address: adapter,
        abi: liveBidAdapterAbi,
        functionName: "sweep",
      });
    const rewardWei = liveBidSweepRewardFromSimulation({
      adapterBalanceWei,
      ethForwardedWei: simulation.result,
      maxSweepWei,
      keeperRewardBps,
      keeperRewardCapWei,
    });
    if (rewardWei === 0n) {
      incrementReason(
        parameters.skipped,
        "live_bid_sweep_no_reward",
      );
      return undefined;
    }

    const estimatedGas =
      await parameters.client.estimateContractGas({
        account: parameters.account,
        address: adapter,
        abi: liveBidAdapterAbi,
        functionName: "sweep",
      });
    const feeQuote = quoteCompetitiveFees({
      crankFee: rewardWei,
      simulatedGasUsed: estimatedGas,
      baseFeeAllowancePerGas:
        parameters.baseFeeAllowancePerGas,
      minimumPriorityFeePerGas:
        parameters.config.liveBidSweepMinPriorityFeePerGas,
      builderBidBps:
        parameters.config.liveBidSweepBuilderBidBps,
      maxFeePerGasCap: parameters.config.maxFeePerGas,
      minProfitWei: parameters.config.minProfitWei,
    });
    if (!feeQuote.profitable) {
      incrementReason(
        parameters.skipped,
        "live_bid_sweep_unprofitable",
      );
      return undefined;
    }
    const gasLimit = bufferedGas(
      estimatedGas,
      parameters.config.gasLimitMultiplierBps,
    );
    if (
      gasLimit >
      parameters.config.liveBidSweepGasLimit
    ) {
      incrementReason(
        parameters.skipped,
        "live_bid_sweep_gas_above_limit",
      );
      return undefined;
    }
    return {
      kind: "live_bid_sweep",
      label: "live_bid_adapter_sweep",
      target: adapter,
      data: encodeFunctionData({
        abi: liveBidAdapterAbi,
        functionName: "sweep",
      }),
      gas: gasLimit,
      reward: { kind: "fixed", amountWei: rewardWei },
    };
  } catch (error) {
    incrementReason(
      parameters.skipped,
      revertedErrorName(error) ??
        "live_bid_sweep_simulation_failed",
    );
    return undefined;
  }
}

async function planLiquityLiquidation(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableLiquityLiquidations) return undefined;

  const branchJobs = await Promise.all(
    LIQUITY_BRANCHES.map(async (branch): Promise<KeeperJob | undefined> => {
      try {
        const [priceResult, count] = await Promise.all([
          parameters.client.readContract({
            address: branch.priceFeed,
            abi: liquityPriceFeedAbi,
            functionName: "fetchPrice",
          }),
          parameters.client.readContract({
            address: branch.troveManager,
            abi: liquityTroveManagerAbi,
            functionName: "getTroveIdsCount",
          }),
        ]);
        const price = priceResult[0];
        if (price === 0n) {
          incrementReason(
            parameters.skipped,
            `liquity_${branch.symbol}_zero_price`,
          );
          return undefined;
        }
        if (count > 10_000n) {
          incrementReason(
            parameters.skipped,
            `liquity_${branch.symbol}_scan_limit`,
          );
          return undefined;
        }
        if (count === 0n) {
          incrementReason(
            parameters.skipped,
            `liquity_${branch.symbol}_no_troves`,
          );
          return undefined;
        }

        const idResults = await parameters.client.multicall({
          allowFailure: true,
          batchSize: 16_384,
          contracts: Array.from(
            { length: Number(count) },
            (_, index) => ({
              address: branch.troveManager,
              abi: liquityTroveManagerAbi,
              functionName: "getTroveFromTroveIdsArray" as const,
              args: [BigInt(index)] as const,
            }),
          ),
        });
        const ids = idResults.flatMap((result) =>
          result.status === "success" ? [result.result] : [],
        );
        const healthResults = await parameters.client.multicall({
          allowFailure: true,
          batchSize: 16_384,
          contracts: ids.flatMap((id) => [
            {
              address: branch.troveManager,
              abi: liquityTroveManagerAbi,
              functionName: "getTroveStatus" as const,
              args: [id] as const,
            },
            {
              address: branch.troveManager,
              abi: liquityTroveManagerAbi,
              functionName: "getCurrentICR" as const,
              args: [id, price] as const,
            },
          ]),
        });
        const liquidatable: Array<{
          readonly id: bigint;
          readonly icr: bigint;
        }> = [];
        for (let index = 0; index < ids.length; index += 1) {
          const status = healthResults[index * 2];
          const icr = healthResults[index * 2 + 1];
          if (
            status?.status !== "success" ||
            icr?.status !== "success" ||
            (status.result !== 1 && status.result !== 4) ||
            icr.result >= branch.mcr
          ) {
            continue;
          }
          liquidatable.push({
            id: ids[index]!,
            icr: BigInt(icr.result),
          });
        }
        if (liquidatable.length === 0) {
          incrementReason(
            parameters.skipped,
            `liquity_${branch.symbol}_none_liquidatable`,
          );
          return undefined;
        }
        liquidatable.sort((left, right) =>
          left.icr === right.icr
            ? left.id < right.id
              ? -1
              : 1
            : left.icr < right.icr
              ? -1
              : 1,
        );
        const selectedIds = liquidatable
          .slice(0, parameters.config.liquityMaxTrovesPerBatch)
          .map((candidate) => candidate.id);
        const estimatedGas =
          await parameters.client.estimateContractGas({
            account: parameters.account,
            address: branch.troveManager,
            abi: liquityTroveManagerAbi,
            functionName: "batchLiquidateTroves",
            args: [selectedIds],
          });
        const guaranteedReward =
          LIQUITY_ETH_GAS_COMPENSATION * BigInt(selectedIds.length);
        const decision = assessProfit({
          crankFee: guaranteedReward,
          estimatedGas,
          maxFeePerGas: parameters.maxFeePerGas,
          gasLimitMultiplierBps:
            parameters.config.gasLimitMultiplierBps,
          minProfitWei: parameters.config.minProfitWei,
        });
        if (!decision.profitable) {
          incrementReason(
            parameters.skipped,
            `liquity_${branch.symbol}_unprofitable`,
          );
          return undefined;
        }
        if (decision.gasLimit > parameters.config.liquityGasLimit) {
          incrementReason(
            parameters.skipped,
            `liquity_${branch.symbol}_gas_above_limit`,
          );
          return undefined;
        }
        return {
          kind: "liquity_liquidation",
          label: `liquity_liquidation:${branch.symbol}:${selectedIds.length}`,
          target: branch.troveManager,
          data: encodeFunctionData({
            abi: liquityTroveManagerAbi,
            functionName: "batchLiquidateTroves",
            args: [selectedIds],
          }),
          gas: decision.gasLimit,
          reward: {
            kind: "fixed",
            amountWei: guaranteedReward,
          },
        };
      } catch (error) {
        incrementReason(
          parameters.skipped,
          revertedErrorName(error) ??
            `liquity_${branch.symbol}_scan_failed`,
        );
        return undefined;
      }
    }),
  );

  return branchJobs
    .filter((job): job is KeeperJob => job !== undefined)
    .sort((left, right) => {
      const leftReward =
        left.reward.kind === "fixed" ? left.reward.amountWei : 0n;
      const rightReward =
        right.reward.kind === "fixed" ? right.reward.amountWei : 0n;
      const leftProfit =
        leftReward - left.gas * parameters.maxFeePerGas;
      const rightProfit =
        rightReward - right.gas * parameters.maxFeePerGas;
      return leftProfit === rightProfit
        ? left.label.localeCompare(right.label)
        : leftProfit > rightProfit
          ? -1
          : 1;
    })[0];
}

async function planConvexEarmark(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableConvexEarmarks) return undefined;
  try {
    const [pools, staker, incentiveBps, crvRound, ethRound] =
      await Promise.all([
        getConvexPools(parameters.client),
        parameters.client.readContract({
          address: CONVEX_BOOSTER_ADDRESS,
          abi: convexBoosterAbi,
          functionName: "staker",
        }),
        parameters.client.readContract({
          address: CONVEX_BOOSTER_ADDRESS,
          abi: convexBoosterAbi,
          functionName: "earmarkIncentive",
        }),
        parameters.client.readContract({
          address: CRV_USD_FEED_ADDRESS,
          abi: chainlinkPriceFeedAbi,
          functionName: "latestRoundData",
        }),
        parameters.client.readContract({
          address: ETH_USD_FEED_ADDRESS,
          abi: chainlinkPriceFeedAbi,
          functionName: "latestRoundData",
        }),
      ]);
    const crvUsd = crvRound[1];
    const ethUsd = ethRound[1];
    if (crvUsd <= 0n || ethUsd <= 0n) {
      incrementReason(
        parameters.skipped,
        "convex_earmark_invalid_oracle_price",
      );
      return undefined;
    }
    const claimableResults = await parameters.client.multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: pools.map((pool) => ({
        address: pool.gauge,
        abi: curveGaugeAbi,
        functionName: "claimable_tokens" as const,
        args: [staker] as const,
      })),
    });
    const minimumPlausibleGas = 400_000n;
    const prefiltered = pools
      .flatMap((pool, index) => {
        const claimable = claimableResults[index];
        if (claimable?.status !== "success" || claimable.result === 0n) {
          return [];
        }
        const callerCrv =
          (claimable.result * incentiveBps) / 10_000n;
        // Both Chainlink feeds use 8 decimals, so their ratio directly
        // converts 18-decimal CRV into an 18-decimal ETH equivalent.
        // A 5% haircut covers price movement and CRV exit slippage.
        const rewardEthEquivalent =
          (callerCrv * crvUsd * 9_500n) / ethUsd / 10_000n;
        if (
          rewardEthEquivalent <=
          minimumPlausibleGas * parameters.maxFeePerGas
        ) {
          return [];
        }
        return [{ pool, callerCrv, rewardEthEquivalent }];
      })
      .sort((left, right) =>
        left.rewardEthEquivalent === right.rewardEthEquivalent
          ? left.pool.pid < right.pool.pid
            ? -1
            : 1
          : left.rewardEthEquivalent > right.rewardEthEquivalent
            ? -1
            : 1,
      )
      .slice(0, 20);
    if (prefiltered.length === 0) {
      incrementReason(
        parameters.skipped,
        "convex_earmark_none_profitable",
      );
      return undefined;
    }
    const estimates = await mapConcurrent(
      prefiltered,
      parameters.config.simulationConcurrency,
      async (candidate): Promise<KeeperJob | undefined> => {
        try {
          const estimatedGas =
            await parameters.client.estimateContractGas({
              account: parameters.account,
              address: CONVEX_BOOSTER_ADDRESS,
              abi: convexBoosterAbi,
              functionName: "earmarkRewards",
              args: [candidate.pool.pid],
            });
          const decision = assessProfit({
            crankFee: candidate.rewardEthEquivalent,
            estimatedGas,
            maxFeePerGas: parameters.maxFeePerGas,
            gasLimitMultiplierBps:
              parameters.config.gasLimitMultiplierBps,
            minProfitWei: parameters.config.minProfitWei,
          });
          if (
            !decision.profitable ||
            decision.gasLimit >
              parameters.config.convexEarmarkGasLimit
          ) {
            return undefined;
          }
          return {
            kind: "convex_earmark",
            label: `convex_earmark:${candidate.pool.pid}`,
            target: CONVEX_BOOSTER_ADDRESS,
            data: encodeFunctionData({
              abi: convexBoosterAbi,
              functionName: "earmarkRewards",
              args: [candidate.pool.pid],
            }),
            gas: decision.gasLimit,
            reward: {
              kind: "fixed",
              amountWei: candidate.rewardEthEquivalent,
            },
          };
        } catch {
          return undefined;
        }
      },
    );
    const selected = estimates
      .filter((job): job is KeeperJob => job !== undefined)
      .sort((left, right) => {
        const leftReward =
          left.reward.kind === "fixed" ? left.reward.amountWei : 0n;
        const rightReward =
          right.reward.kind === "fixed" ? right.reward.amountWei : 0n;
        const leftProfit =
          leftReward - left.gas * parameters.maxFeePerGas;
        const rightProfit =
          rightReward - right.gas * parameters.maxFeePerGas;
        return leftProfit === rightProfit
          ? left.label.localeCompare(right.label)
          : leftProfit > rightProfit
            ? -1
            : 1;
      })[0];
    if (selected === undefined) {
      incrementReason(
        parameters.skipped,
        "convex_earmark_none_profitable",
      );
    }
    return selected;
  } catch (error) {
    incrementReason(
      parameters.skipped,
      revertedErrorName(error) ?? "convex_earmark_scan_failed",
    );
    return undefined;
  }
}

async function planConvexKick(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableConvexKicks) return undefined;
  try {
    const [rewardPerEpoch, cvxRound, ethRound, balanceResults] =
      await Promise.all([
        parameters.client.readContract({
          address: CONVEX_LOCKER_ADDRESS,
          abi: convexLockerAbi,
          functionName: "kickRewardPerEpoch",
        }),
        parameters.client.readContract({
          address: CVX_USD_FEED_ADDRESS,
          abi: chainlinkPriceFeedAbi,
          functionName: "latestRoundData",
        }),
        parameters.client.readContract({
          address: ETH_USD_FEED_ADDRESS,
          abi: chainlinkPriceFeedAbi,
          functionName: "latestRoundData",
        }),
        parameters.client.multicall({
          allowFailure: true,
          batchSize: 16_384,
          contracts: CONVEX_KICK_CANDIDATES.map((candidate) => ({
            address: CONVEX_LOCKER_ADDRESS,
            abi: convexLockerAbi,
            functionName: "lockedBalances" as const,
            args: [candidate] as const,
          })),
        }),
      ]);
    const cvxUsd = cvxRound[1];
    const ethUsd = ethRound[1];
    if (
      rewardPerEpoch <= 0n ||
      rewardPerEpoch > 10_000n ||
      cvxUsd <= 0n ||
      ethUsd <= 0n
    ) {
      incrementReason(
        parameters.skipped,
        "convex_kick_invalid_reward_or_oracle",
      );
      return undefined;
    }
    const minimumPlausibleGas = 150_000n;
    const prefiltered = CONVEX_KICK_CANDIDATES.flatMap(
      (candidate, index) => {
        const balances = balanceResults[index];
        if (
          balances?.status !== "success" ||
          balances.result[1] === 0n
        ) {
          return [];
        }
        // An eligible kick pays at least one epoch. Later epochs can only
        // increase the actual CVX reward, so this is a strict reward floor.
        const minimumRewardCvx =
          (balances.result[1] * rewardPerEpoch) / 10_000n;
        // Both Chainlink feeds use 8 decimals. A 5% haircut covers price
        // movement and the cost of exiting the CVX reward.
        const rewardEthEquivalent =
          (minimumRewardCvx * cvxUsd * 9_500n) /
          ethUsd /
          10_000n;
        if (
          rewardEthEquivalent <=
          minimumPlausibleGas * parameters.maxFeePerGas
        ) {
          return [];
        }
        return [{ candidate, rewardEthEquivalent }];
      },
    )
      .sort((left, right) =>
        left.rewardEthEquivalent === right.rewardEthEquivalent
          ? left.candidate.localeCompare(right.candidate)
          : left.rewardEthEquivalent > right.rewardEthEquivalent
            ? -1
            : 1,
      );
    if (prefiltered.length === 0) {
      incrementReason(
        parameters.skipped,
        "convex_kick_none_profitable",
      );
      return undefined;
    }
    const estimates = await mapConcurrent(
      prefiltered,
      parameters.config.simulationConcurrency,
      async (candidate): Promise<KeeperJob | undefined> => {
        try {
          const estimatedGas =
            await parameters.client.estimateContractGas({
              account: parameters.account,
              address: CONVEX_LOCKER_ADDRESS,
              abi: convexLockerAbi,
              functionName: "kickExpiredLocks",
              args: [candidate.candidate],
            });
          const decision = assessProfit({
            crankFee: candidate.rewardEthEquivalent,
            estimatedGas,
            maxFeePerGas: parameters.maxFeePerGas,
            gasLimitMultiplierBps:
              parameters.config.gasLimitMultiplierBps,
            minProfitWei: parameters.config.minProfitWei,
          });
          if (!decision.profitable) return undefined;
          if (
            decision.gasLimit > parameters.config.convexKickGasLimit
          ) {
            return undefined;
          }
          return {
            kind: "convex_kick",
            label: `convex_kick:${candidate.candidate}`,
            target: CONVEX_LOCKER_ADDRESS,
            data: encodeFunctionData({
              abi: convexLockerAbi,
              functionName: "kickExpiredLocks",
              args: [candidate.candidate],
            }),
            gas: decision.gasLimit,
            reward: {
              kind: "fixed",
              amountWei: candidate.rewardEthEquivalent,
            },
          };
        } catch {
          return undefined;
        }
      },
    );
    const selected = estimates
      .filter((job): job is KeeperJob => job !== undefined)
      .sort((left, right) => {
        const leftReward =
          left.reward.kind === "fixed" ? left.reward.amountWei : 0n;
        const rightReward =
          right.reward.kind === "fixed" ? right.reward.amountWei : 0n;
        const leftProfit =
          leftReward - left.gas * parameters.maxFeePerGas;
        const rightProfit =
          rightReward - right.gas * parameters.maxFeePerGas;
        return leftProfit === rightProfit
          ? left.label.localeCompare(right.label)
          : leftProfit > rightProfit
            ? -1
            : 1;
      })[0];
    if (selected === undefined) {
      incrementReason(
        parameters.skipped,
        "convex_kick_none_profitable",
      );
    }
    return selected;
  } catch (error) {
    incrementReason(
      parameters.skipped,
      revertedErrorName(error) ?? "convex_kick_scan_failed",
    );
    return undefined;
  }
}

async function planJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly convexMaxFeePerGas: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly bountyBaseFeePerGas: bigint;
}): Promise<PlannedJobs> {
  const skipped = new Map<string, number>();
  const [roundCount, ethPendingRound, fwa, token] = await Promise.all([
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "roundCount",
    }),
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "ethPendingRound",
    }),
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "FWA",
    }),
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "FWA_TOKEN",
    }),
  ]);
  const tokenAddress = getAddress(token);
  if (tokenAddress !== parameters.config.expectedFwaTokenAddress) {
    throw new Error(
      `pool FWA token ${tokenAddress} does not match expected token ${parameters.config.expectedFwaTokenAddress}`,
    );
  }
  const routing = routeRoundIds({ roundCount, ethPendingRound });
  const plannerBase = {
    client: parameters.client,
    account: parameters.account,
    config: parameters.config,
    pool: parameters.config.expectedPoolAddress,
    fwa: getAddress(fwa),
    maxFeePerGas: parameters.maxFeePerGas,
    bountyBaseFeePerGas: parameters.bountyBaseFeePerGas,
    skipped,
  } as const;

  const primaryProfit = (
    plan: Awaited<ReturnType<typeof planPrimaryJobs>>,
  ): bigint => {
    const grossReward = plan.jobs.reduce(
      (total, job) =>
        total +
        estimatedJobReward({
          job,
          gasUsed: job.gas,
          baseFeePerGas: parameters.bountyBaseFeePerGas,
          poolBountyEstimateBps:
            parameters.config.poolBountyEstimateBps,
        }),
      0n,
    );
    const gasCost = plan.jobs.reduce(
      (total, job) =>
        total + job.gas * parameters.maxFeePerGas,
      0n,
    );
    return grossReward - gasCost;
  };

  let lifecyclePrimary:
    | Awaited<ReturnType<typeof planPrimaryJobs>>
    | undefined;
  if (routing.lifecycleRoundId !== undefined) {
    const lifecycleRound = await getRoundSnapshot(
      parameters.client,
      parameters.config.expectedPoolAddress,
      routing.lifecycleRoundId,
    );
    lifecyclePrimary = await planPrimaryJobs({
      ...plannerBase,
      candidates: [],
      roundCount: routing.lifecycleRoundId,
      round: lifecycleRound,
    });
    const profit = primaryProfit(lifecyclePrimary);
    if (
      lifecyclePrimary.jobs.length > 0 &&
      profit >= requiredProfit(parameters.config.minProfitWei)
    ) {
      log("debug", "lifecycle_fast_path_selected", {
        round: routing.lifecycleRoundId.toString(),
        jobs: lifecyclePrimary.jobs.length,
        estimatedProfit: eth(profit),
      });
      return {
        jobs: lifecyclePrimary.jobs,
        minimumViablePrefix:
          lifecyclePrimary.minimumViablePrefix,
        orders: lastKnownOrderCount,
        skipped,
      };
    }
  }

  const candidatesPromise = getOrderCandidates(
    parameters.client,
    parameters.config.factoryAddress,
    parameters.config.enableVaults
      ? parameters.config.vaultFactoryAddress
      : undefined,
  );
  const fundingRoundPromise =
    routing.fundingRoundId === undefined ||
    routing.fundingRoundId === routing.lifecycleRoundId
      ? Promise.resolve(undefined)
      : getRoundSnapshot(
          parameters.client,
          parameters.config.expectedPoolAddress,
          routing.fundingRoundId,
        );
  const liquityPromise = planLiquityLiquidation({
    client: parameters.client,
    account: parameters.account,
    config: parameters.config,
    maxFeePerGas: parameters.maxFeePerGas,
    skipped,
  });
  const convexPromise = planConvexEarmark({
    client: parameters.client,
    account: parameters.account,
    config: parameters.config,
    maxFeePerGas: parameters.convexMaxFeePerGas,
    skipped,
  });
  const convexKickPromise = planConvexKick({
    client: parameters.client,
    account: parameters.account,
    config: parameters.config,
    maxFeePerGas: parameters.convexMaxFeePerGas,
    skipped,
  });
  const [
    candidates,
    fundingRound,
    liquity,
    convex,
    convexKick,
    buyback,
    liveBidSweep,
  ] = await Promise.all([
      candidatesPromise,
      fundingRoundPromise,
      liquityPromise,
      convexPromise,
      convexKickPromise,
      planBuyback({
        client: parameters.client,
        account: parameters.account,
        config: parameters.config,
        token: tokenAddress,
        maxFeePerGas: parameters.maxFeePerGas,
        skipped,
      }),
      planLiveBidSweep({
        client: parameters.client,
        account: parameters.account,
        config: parameters.config,
        baseFeeAllowancePerGas:
          parameters.baseFeeAllowancePerGas,
        skipped,
      }),
    ]);
  lastKnownOrderCount = candidates.length;

  let fundingPrimary:
    | Awaited<ReturnType<typeof planPrimaryJobs>>
    | undefined;
  if (
    routing.fundingRoundId !== undefined &&
    routing.fundingRoundId !== routing.lifecycleRoundId &&
    fundingRound !== undefined
  ) {
    fundingPrimary = await planPrimaryJobs({
      ...plannerBase,
      candidates,
      roundCount: routing.fundingRoundId,
      round: fundingRound,
    });
  } else if (
    routing.lifecycleRoundId === undefined &&
    routing.fundingRoundId === undefined
  ) {
    fundingPrimary = await planPrimaryJobs({
      ...plannerBase,
      candidates,
      roundCount: 0n,
      round: undefined,
    });
  }

  const alternatives: Array<{
    readonly jobs: readonly KeeperJob[];
    readonly minimumViablePrefix: number;
    readonly profit: bigint;
    readonly label: string;
  }> = [];
  for (const primary of [lifecyclePrimary, fundingPrimary]) {
    if (primary === undefined || primary.jobs.length === 0) continue;
    const profit = primaryProfit(primary);
    if (profit >= requiredProfit(parameters.config.minProfitWei)) {
      alternatives.push({
        jobs: primary.jobs,
        minimumViablePrefix: primary.minimumViablePrefix,
        profit,
        label: primary.jobs[0]?.label ?? "primary",
      });
    } else {
      incrementReason(skipped, "primary_bundle_unprofitable");
    }
  }
  for (const job of [
    liquity,
    convex,
    convexKick,
    buyback,
    liveBidSweep,
  ]) {
    if (job === undefined || job.reward.kind !== "fixed") continue;
    const planningMaxFeePerGas =
      job.kind === "convex_earmark" || job.kind === "convex_kick"
        ? parameters.convexMaxFeePerGas
        : parameters.maxFeePerGas;
    alternatives.push({
      jobs: [job],
      minimumViablePrefix: 1,
      profit:
        job.reward.amountWei - job.gas * planningMaxFeePerGas,
      label: job.label,
    });
  }
  alternatives.sort((left, right) =>
    left.profit === right.profit
      ? left.label.localeCompare(right.label)
      : left.profit > right.profit
        ? -1
        : 1,
  );
  const selected = alternatives[0];
  return {
    jobs: selected?.jobs ?? [],
    minimumViablePrefix: selected?.minimumViablePrefix ?? 0,
    orders: candidates.length,
    skipped,
  };
}

export function estimatedJobReward(parameters: {
  readonly job: KeeperJob;
  readonly gasUsed: bigint;
  readonly baseFeePerGas: bigint;
  readonly poolBountyEstimateBps: bigint;
}): bigint {
  if (parameters.job.reward.kind === "fixed") {
    return parameters.job.reward.amountWei;
  }
  return estimatePoolBounty({
    gasUsed: parameters.gasUsed,
    baseFeePerGas: parameters.baseFeePerGas,
    terms: parameters.job.reward.terms,
    estimateBps: parameters.poolBountyEstimateBps,
  });
}

function actualJobReward(
  request: KeeperTransactionRequest,
  logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: [] | [Hex, ...Hex[]];
  }[],
): bigint {
  if (
    (request.kind === "liquity_liquidation" ||
      request.kind === "convex_earmark" ||
      request.kind === "convex_kick") &&
    request.reward.kind === "fixed"
  ) {
    return request.reward.amountWei;
  }
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== request.target.toLowerCase()) {
      continue;
    }
    try {
      if (request.kind === "standing_order") {
        const decoded = decodeEventLog({
          abi: standingOrderAbi,
          data: entry.data,
          topics: entry.topics,
        });
        if (decoded.eventName === "Cranked") return decoded.args.fee;
      } else if (request.kind === "fwa_buyback") {
        const decoded = decodeEventLog({
          abi: fwaTokenAbi,
          data: entry.data,
          topics: entry.topics,
        });
        if (decoded.eventName === "Bought") {
          return decoded.args.callerReward;
        }
      } else if (request.kind === "live_bid_sweep") {
        const decoded = decodeEventLog({
          abi: liveBidAdapterAbi,
          data: entry.data,
          topics: entry.topics,
        });
        if (decoded.eventName === "KeeperReward") {
          return decoded.args.amount;
        }
      } else if (request.kind !== "fwa_process") {
        const decoded = decodeEventLog({
          abi: poolAbi,
          data: entry.data,
          topics: entry.topics,
        });
        if (
          decoded.eventName === "CrankBountyPaid" &&
          decoded.args.roundId === request.roundId
        ) {
          return decoded.args.amount;
        }
      }
    } catch {
      // Ignore unrelated events emitted by the same contract.
    }
  }
  return 0n;
}

export async function runKeeperPass(
  context: StrategyContext,
): Promise<KeeperPassResult> {
  const [feeQuote, latestBlock] = await Promise.all([
    context.publicClient.estimateFeesPerGas({
      type: "eip1559",
    }),
    context.publicClient.getBlock({ blockTag: "latest" }),
  ]);
  const maxPriorityFeePerGas =
    feeQuote.maxPriorityFeePerGas >
    context.config.minPriorityFeePerGas
      ? feeQuote.maxPriorityFeePerGas
      : context.config.minPriorityFeePerGas;
  const maxFeePerGas =
    feeQuote.maxFeePerGas +
    (maxPriorityFeePerGas - feeQuote.maxPriorityFeePerGas);
  if (maxFeePerGas > context.config.maxFeePerGas) {
    log("info", "gas_price_above_cap", {
      estimatedMaxFee: gwei(maxFeePerGas),
      configuredCap: gwei(context.config.maxFeePerGas),
    });
    return { orders: 0, viable: 0, sent: 0, confirmed: 0 };
  }

  const plan = await planJobs({
    client: context.publicClient,
    account: context.account,
    config: context.config,
    maxFeePerGas,
    convexMaxFeePerGas:
      context.config.submissionMode === "flashbots"
        ? feeQuote.maxFeePerGas
        : maxFeePerGas,
    baseFeeAllowancePerGas:
      maxFeePerGas - maxPriorityFeePerGas,
    bountyBaseFeePerGas:
      latestBlock.baseFeePerGas ??
      (maxFeePerGas - maxPriorityFeePerGas),
  });
  const baseFeePerGas = maxFeePerGas - maxPriorityFeePerGas;
  const bountyBaseFeePerGas =
    latestBlock.baseFeePerGas ?? baseFeePerGas;
  const estimatedGrossReward = plan.jobs.reduce(
    (total, job) =>
      total +
      estimatedJobReward({
        job,
        gasUsed: job.gas,
        baseFeePerGas: bountyBaseFeePerGas,
        poolBountyEstimateBps:
          context.config.poolBountyEstimateBps,
      }),
    0n,
  );
  const estimatedMaxGasCost = plan.jobs.reduce(
    (total, job) =>
      total +
      job.gas *
        (context.config.submissionMode === "flashbots" &&
        (job.kind === "convex_earmark" || job.kind === "convex_kick")
          ? feeQuote.maxFeePerGas
          : maxFeePerGas),
    0n,
  );
  const estimatedProfit =
    estimatedGrossReward - estimatedMaxGasCost;
  const planProfitable =
    plan.jobs.length > 0 &&
    estimatedProfit >= requiredProfit(context.config.minProfitWei);
  if (plan.jobs.length > 0) {
    log(planProfitable ? "info" : "warn", "keeper_plan_economics", {
      jobs: plan.jobs.length,
      estimatedGrossReward: eth(estimatedGrossReward),
      estimatedMaxGasCost: eth(estimatedMaxGasCost),
      estimatedProfit: eth(estimatedProfit),
      requiredProfit: eth(requiredProfit(context.config.minProfitWei)),
      accepted: planProfitable,
    });
    if (!planProfitable) {
      incrementReason(plan.skipped, "bundle_unprofitable");
    }
  }
  for (const job of plan.jobs) {
    const reward = estimatedJobReward({
      job,
      gasUsed: job.gas,
      baseFeePerGas:
        maxFeePerGas - maxPriorityFeePerGas,
      poolBountyEstimateBps:
        context.config.poolBountyEstimateBps,
    });
    log("info", "keeper_opportunity", {
      kind: job.kind,
      label: job.label,
      target: job.target,
      gasLimit: job.gas.toString(),
      estimatedReward: eth(reward),
      dependencyFloor: plan.minimumViablePrefix,
      dryRun: context.config.dryRun,
    });
  }

  const viable = planProfitable ? plan.jobs.length : 0;
  if (context.config.dryRun || viable === 0) {
    log("info", "pass_complete", {
      orders: plan.orders,
      viable,
      sent: 0,
      confirmed: 0,
      skipped: JSON.stringify(Object.fromEntries(plan.skipped)),
    });
    return {
      orders: plan.orders,
      viable,
      sent: 0,
      confirmed: 0,
    };
  }
  if (
    context.sendTransaction === undefined &&
    context.sendBatch === undefined
  ) {
    throw new Error("live mode requires a configured transaction sender");
  }

  const accountAddress =
    typeof context.account === "string"
      ? context.account
      : context.account.address;
  const [latestNonce, pendingNonce, accountBalance] = await Promise.all([
    context.publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: "latest",
    }),
    context.publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: "pending",
    }),
    context.publicClient.getBalance({ address: accountAddress }),
  ]);
  const noncePlan = buildNoncePlan(
    { latest: latestNonce, pending: pendingNonce },
    plan.jobs.length,
  );
  if (noncePlan.blocked) {
    log("warn", "nonce_batch_blocked", {
      account: accountAddress,
      latestNonce,
      pendingNonce,
      inFlight: pendingNonce - latestNonce,
    });
    return {
      orders: plan.orders,
      viable,
      sent: 0,
      confirmed: 0,
    };
  }

  const requests: KeeperTransactionRequest[] = [];
  let reservedGasCost = 0n;
  for (let index = 0; index < viable; index += 1) {
    const job = plan.jobs[index];
    const nonce = noncePlan.nonces[index];
    if (job === undefined || nonce === undefined) {
      throw new Error("nonce plan did not cover every keeper job");
    }
    const maxGasCost = job.gas * maxFeePerGas;
    if (reservedGasCost + maxGasCost > accountBalance) {
      incrementReason(
        plan.skipped,
        "keeper_balance_reserve",
      );
      break;
    }
    reservedGasCost += maxGasCost;
    requests.push({
      ...job,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
  }
  if (requests.length < plan.minimumViablePrefix) {
    log("warn", "dependency_batch_unfunded", {
      requiredTransactions: plan.minimumViablePrefix,
      fundedTransactions: requests.length,
      accountBalance: eth(accountBalance),
    });
    return {
      orders: plan.orders,
      viable,
      sent: 0,
      confirmed: 0,
    };
  }

  const submitted: SubmittedJob[] = [];
  let privateTargetBlock: bigint | undefined;
  let batchResult: KeeperBatchResult | undefined;
  if (context.sendBatch !== undefined) {
    const targetBlock = (await context.publicClient.getBlockNumber()) + 1n;
    try {
      batchResult = await context.sendBatch({
        requests,
        targetBlock,
        minimumViablePrefix: plan.minimumViablePrefix,
        bountyBaseFeePerGas,
      });
      privateTargetBlock = batchResult.targetBlock;
      for (let index = 0; index < batchResult.hashes.length; index += 1) {
        const hash = batchResult.hashes[index];
        const request = requests[index];
        if (hash !== undefined && request !== undefined) {
          submitted.push({ request, hash });
        }
      }
    } catch (error) {
      log("warn", "keeper_batch_submission_failed", {
        targetBlock: targetBlock.toString(),
        reason: errorMessage(error),
      });
    }
  } else if (context.sendTransaction !== undefined) {
    for (const request of requests) {
      try {
        const hash = await context.sendTransaction(request);
        submitted.push({ request, hash });
      } catch (error) {
        log("warn", "keeper_submission_failed", {
          kind: request.kind,
          label: request.label,
          nonce: request.nonce,
          reason: revertedErrorName(error) ?? errorMessage(error),
          action: "stopping_batch_to_avoid_nonce_gap",
        });
        break;
      }
    }
  }

  for (const submission of submitted) {
    log("info", "keeper_transaction_sent", {
      kind: submission.request.kind,
      label: submission.request.label,
      hash: submission.hash,
      nonce: submission.request.nonce,
      mode:
        privateTargetBlock === undefined ? "public" : "flashbots",
      targetBlock: privateTargetBlock?.toString() ?? "",
    });
  }
  for (const bundle of batchResult?.bundles ?? []) {
    log("info", "flashbots_bundle_accepted", {
      bundleHash: bundle.bundleHash,
      targetBlock: batchResult?.targetBlock.toString() ?? "",
      relayIndex: bundle.relayIndex,
      smart: bundle.smart,
      transactionCount: bundle.transactionCount,
    });
  }

  if (privateTargetBlock !== undefined) {
    const deadline = Date.now() + context.config.receiptTimeoutMs;
    while (
      (await context.publicClient.getBlockNumber()) <
        privateTargetBlock &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, context.config.blockPollMs),
      );
    }
  }

  const receiptResults = await Promise.all(
    submitted.map(async (submission) => {
      try {
        const receipt =
          privateTargetBlock === undefined
            ? await context.publicClient.waitForTransactionReceipt({
                hash: submission.hash,
                confirmations: context.config.confirmations,
                timeout: context.config.receiptTimeoutMs,
              })
            : await context.publicClient.getTransactionReceipt({
                hash: submission.hash,
              });
        const successful = receipt.status === "success";
        const paidReward = successful
          ? actualJobReward(submission.request, receipt.logs)
          : 0n;
        const gasCost =
          receipt.gasUsed * receipt.effectiveGasPrice;
        log(successful ? "info" : "warn", "keeper_receipt", {
          kind: submission.request.kind,
          label: submission.request.label,
          hash: submission.hash,
          nonce: submission.request.nonce,
          block: receipt.blockNumber.toString(),
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          paidReward: eth(paidReward),
          gasCost: eth(gasCost),
          realizedProfit: eth(paidReward - gasCost),
        });
        return successful;
      } catch (error) {
        log(
          "warn",
          privateTargetBlock === undefined
            ? "keeper_receipt_unresolved"
            : "keeper_transaction_expired",
          {
            kind: submission.request.kind,
            label: submission.request.label,
            hash: submission.hash,
            nonce: submission.request.nonce,
            reason: errorMessage(error),
          },
        );
        return false;
      }
    }),
  );

  const orderAttempts = submitted.flatMap((submission, index) => {
    const order = submission.request.order;
    if (order === undefined) return [];
    const reward = submission.request.reward;
    if (reward.kind !== "fixed") return [];
    return [
      {
        order,
        crankFee: reward.amountWei,
        hash: submission.hash,
        included: receiptResults[index] ?? false,
      },
    ];
  });
  if (
    privateTargetBlock !== undefined &&
    orderAttempts.length > 0 &&
    context.observePrivateBatch !== undefined
  ) {
    try {
      await context.observePrivateBatch({
        targetBlock: privateTargetBlock,
        attempts: orderAttempts,
      });
    } catch (error) {
      log("warn", "adaptive_bid_observation_failed", {
        targetBlock: privateTargetBlock.toString(),
        reason: errorMessage(error),
      });
    }
  }

  const confirmed = receiptResults.filter(Boolean).length;
  log("info", "pass_complete", {
    orders: plan.orders,
    viable,
    sent: submitted.length,
    confirmed,
    skipped: JSON.stringify(Object.fromEntries(plan.skipped)),
  });
  return {
    orders: plan.orders,
    viable,
    sent: submitted.length,
    confirmed,
  };
}
