import {
  BaseError,
  BlockNotFoundError,
  ContractFunctionRevertedError,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  InvalidParamsRpcError,
  RpcRequestError,
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
  erc20Abi,
  factoryAbi,
  firmDbrAbi,
  firmMarketAbi,
  fwaAbi,
  fwaTokenAbi,
  liquityPriceFeedAbi,
  liquityTroveManagerAbi,
  liveBidAdapterAbi,
  multicall3BalanceAbi,
  poolAbi,
  stakeDaoAccountantAbi,
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
  FIRM_DBR_ADDRESS,
  FIRM_DOLA_ADDRESS,
  FIRM_DOLA_USD_FEED_ADDRESS,
  LIQUITY_BRANCHES,
  LIQUITY_ETH_GAS_COMPENSATION,
  MULTICALL3_ADDRESS,
  STAKE_DAO_ACCOUNTANT_ADDRESS,
  STAKE_DAO_CURVE_LOCKER_ADDRESS,
} from "./constants.js";
import {
  assessProfit,
  bufferedGas,
  requiredProfit,
} from "./economics.js";
import {
  accountFirmReceipt,
  conservativeDolaToEthWei,
  discoverFirmCandidates,
  firmForceReplenishCalldata,
  firmOracleRoundsAreFresh,
  firmReplenishmentAmounts,
  type FirmReceiptAccounting,
} from "./firm.js";
import { errorMessage, eth, gwei, log } from "./format.js";
import { retryTransientRead } from "./heads.js";
import {
  ACQUISITION_STATUS,
  ROUND_STATE,
  acquisitionProcessCount,
  acquisitionStatusName,
  buybackCallerReward,
  estimatePoolBounty,
  lifecycleFundingSuperset,
  liveBidSweepRewardFromSimulation,
  routeRoundIds,
  selectOrdersForCoverage,
  type LifecycleFundingSuffix,
  type PoolBountyTerms,
} from "./lifecycle.js";
import type { PrivateBatchOutcome } from "./keeper.js";
import { buildNoncePlan } from "./nonces.js";
import {
  conservativeCrvToEthWei,
  conservativeStakeDaoHarvesterFee,
  discoverStakeDaoCurveGauges,
  isFreshChainlinkRound,
  stakeDaoGaugePrefixes,
} from "./stakedao.js";

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
  | "convex_kick"
  | "stakedao_curve_harvest"
  | "firm_replenish";

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
  readonly stakeDaoCrvReward?: bigint;
  readonly stakeDaoCrvUsd?: bigint;
  readonly stakeDaoEthUsd?: bigint;
  readonly stakeDaoRewardHaircutBps?: bigint;
  readonly firmAccount?: Address;
  readonly firmReplenisher?: Address;
  readonly firmFixedDeficit?: bigint;
  readonly firmReplenishmentCostDola?: bigint;
  readonly firmDolaReward?: bigint;
  readonly firmDolaBalanceBefore?: bigint;
  readonly firmDolaUsd?: bigint;
  readonly firmDolaUsdDecimals?: number;
  readonly firmEthUsd?: bigint;
  readonly firmEthUsdDecimals?: number;
  readonly firmRewardHaircutBps?: bigint;
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

export interface KeeperPassResult {
  readonly orders: number;
  readonly viable: number;
  readonly sent: number;
  readonly confirmed: number;
}

export interface StrategyContext {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly discoveryClient?: PublicClient<Transport, Chain>;
  readonly headBlockNumber: bigint;
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
  readonly waitForTargetBlock:
    | ((
        targetBlock: bigint,
        timeoutMs: number,
      ) => Promise<boolean>)
    | undefined;
  readonly observePrivateBatch:
    | ((outcome: PrivateBatchOutcome) => Promise<void>)
    | undefined;
}

interface OrderCandidate {
  readonly address: Address;
  readonly crankFee: bigint;
  readonly ticketsPerRound: bigint;
  readonly requiresNativeBalance: boolean;
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
let cachedOrderCandidates: readonly OrderCandidate[] = [];
const LIFECYCLE_FUNDING_CANDIDATE_LIMIT = 12;
const LIFECYCLE_FUNDING_WAIT_MS = 75;

interface SubmittedJob {
  readonly request: KeeperTransactionRequest;
  readonly hash: Hash;
}

interface PoolRoundSnapshot {
  readonly ticketPrice: bigint;
  readonly crankBountyCap: bigint;
  readonly bountyTipWei: bigint;
  readonly fwaRequestId: bigint;
  readonly state: number;
}

interface ConvexPool {
  readonly pid: bigint;
  readonly gauge: Address;
}

interface ConvexCandidateSnapshot {
  readonly requestedAtBlock: bigint;
  readonly poolsScanned: number;
  readonly pools: readonly ConvexPool[];
}

interface ConvexPoolRegistrySnapshot {
  readonly requestedAtBlock: bigint;
  readonly pools: readonly ConvexPool[];
}

let convexPoolRegistrySnapshot: ConvexPoolRegistrySnapshot | undefined;
let convexCandidateSnapshot: ConvexCandidateSnapshot | undefined;
let convexCandidateRefreshPromise: Promise<void> | undefined;
const CONVEX_CANDIDATE_CACHE_SIZE = 32;
const CONVEX_CANDIDATE_REFRESH_BLOCKS = 4n;
const CONVEX_POOL_REGISTRY_REFRESH_BLOCKS = 128n;

async function getConvexPools(
  client: PublicClient<Transport, Chain>,
  blockNumber: bigint,
): Promise<readonly ConvexPool[]> {
  const cached = convexPoolRegistrySnapshot;
  if (
    cached !== undefined &&
    blockNumber >= cached.requestedAtBlock &&
    blockNumber - cached.requestedAtBlock <
      CONVEX_POOL_REGISTRY_REFRESH_BLOCKS
  ) {
    return cached.pools;
  }
  const count = await client.readContract({
    address: CONVEX_BOOSTER_ADDRESS,
    abi: convexBoosterAbi,
    functionName: "poolLength",
    blockNumber,
  });
  if (count > 2_000n) {
    throw new Error(`Convex pool count ${count} exceeds safety limit`);
  }
  const results = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    blockNumber,
    contracts: Array.from({ length: Number(count) }, (_, pid) => ({
      address: CONVEX_BOOSTER_ADDRESS,
      abi: convexBoosterAbi,
      functionName: "poolInfo" as const,
      args: [BigInt(pid)] as const,
    })),
  });
  const pools = results.flatMap((result, pid) =>
    result.status === "success" && !result.result[5]
      ? [{ pid: BigInt(pid), gauge: result.result[2] }]
      : [],
  );
  convexPoolRegistrySnapshot = {
    requestedAtBlock: blockNumber,
    pools,
  };
  return pools;
}

export function highestPositiveClaimableIndexes(
  claimables: readonly (bigint | undefined)[],
  limit: number,
): readonly number[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("claimable candidate limit must be positive");
  }
  return claimables
    .flatMap((claimable, index) =>
      claimable !== undefined && claimable > 0n
        ? [{ index, claimable }]
        : [],
    )
    .sort((left, right) =>
      left.claimable === right.claimable
        ? left.index - right.index
        : left.claimable > right.claimable
          ? -1
          : 1,
    )
    .slice(0, limit)
    .map(({ index }) => index);
}

async function loadConvexCandidateSnapshot(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly requestedAtBlock: bigint;
}): Promise<ConvexCandidateSnapshot> {
  const pools = await getConvexPools(
    parameters.client,
    parameters.requestedAtBlock,
  );
  const staker = await parameters.client.readContract({
    address: CONVEX_BOOSTER_ADDRESS,
    abi: convexBoosterAbi,
    functionName: "staker",
    blockNumber: parameters.requestedAtBlock,
  });
  const claimableResults = await parameters.client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    blockNumber: parameters.requestedAtBlock,
    contracts: pools.map((pool) => ({
      address: pool.gauge,
      abi: curveGaugeAbi,
      functionName: "claimable_tokens" as const,
      args: [staker] as const,
    })),
  });
  const indexes = highestPositiveClaimableIndexes(
    claimableResults.map((result) =>
      result.status === "success" ? result.result : undefined,
    ),
    CONVEX_CANDIDATE_CACHE_SIZE,
  );
  return {
    requestedAtBlock: parameters.requestedAtBlock,
    poolsScanned: pools.length,
    pools: indexes.flatMap((index) => {
      const pool = pools[index];
      return pool === undefined ? [] : [pool];
    }),
  };
}

function getConvexCandidatePools(parameters: {
  readonly headBlockNumber: bigint;
}): ConvexCandidateSnapshot | undefined {
  const snapshot = convexCandidateSnapshot;
  if (
    snapshot === undefined ||
    snapshot.requestedAtBlock > parameters.headBlockNumber
  ) {
    return undefined;
  }
  return snapshot;
}

export function scheduleColdPlannerRefresh(parameters: {
  readonly discoveryClient: PublicClient<Transport, Chain>;
  readonly config: KeeperConfig;
  readonly headBlockNumber: bigint;
}): void {
  if (
    !parameters.config.enableConvexEarmarks ||
    convexCandidateRefreshPromise !== undefined
  ) {
    return;
  }
  const snapshot = convexCandidateSnapshot;
  if (
    snapshot !== undefined &&
    parameters.headBlockNumber >= snapshot.requestedAtBlock &&
    parameters.headBlockNumber - snapshot.requestedAtBlock <
      CONVEX_CANDIDATE_REFRESH_BLOCKS
  ) {
    return;
  }
  const requestedAtBlock = parameters.headBlockNumber;
  const startedAt = performance.now();
  const refresh = loadConvexCandidateSnapshot({
    client: parameters.discoveryClient,
    requestedAtBlock,
  })
    .then((nextSnapshot) => {
      if (
        convexCandidateSnapshot === undefined ||
        nextSnapshot.requestedAtBlock >=
          convexCandidateSnapshot.requestedAtBlock
      ) {
        convexCandidateSnapshot = nextSnapshot;
      }
      log("info", "convex_candidate_cache_refreshed", {
        requestedAtBlock: nextSnapshot.requestedAtBlock.toString(),
        poolsScanned: nextSnapshot.poolsScanned,
        candidates: nextSnapshot.pools.length,
        durationMs: performance.now() - startedAt,
      });
    })
    .catch((error: unknown) => {
      log("warn", "convex_candidate_cache_refresh_failed", {
        requestedAtBlock: requestedAtBlock.toString(),
        durationMs: performance.now() - startedAt,
        reason: errorMessage(error),
      });
    });
  const tracked = refresh.finally(() => {
    if (convexCandidateRefreshPromise === tracked) {
      convexCandidateRefreshPromise = undefined;
    }
  });
  convexCandidateRefreshPromise = tracked;
}

async function getRoundSnapshot(
  client: PublicClient<Transport, Chain>,
  pool: Address,
  roundId: bigint,
  blockNumber?: bigint,
): Promise<PoolRoundSnapshot> {
  const round = await client.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "getRound",
    args: [roundId],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return {
    ticketPrice: round.ticketPrice,
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

function isBlockNotFound(error: unknown): boolean {
  if (error instanceof BlockNotFoundError) return true;
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (candidate) => candidate instanceof BlockNotFoundError,
    ) instanceof BlockNotFoundError
  );
}

export function isFreshBlockStateUnavailable(
  error: unknown,
): boolean {
  if (!(error instanceof BaseError)) return false;
  const invalidParams = error.walk(
    (candidate) =>
      candidate instanceof InvalidParamsRpcError ||
      (candidate instanceof RpcRequestError &&
        candidate.code === InvalidParamsRpcError.code),
  );
  return (
    invalidParams instanceof BaseError &&
    /^Missing or invalid parameters\.?$/i.test(
      invalidParams.details ?? "",
    )
  );
}

async function getOrderCandidates(
  client: PublicClient<Transport, Chain>,
  factoryAddress: Address,
  vaultFactoryAddress: Address | undefined,
  blockNumber: bigint,
): Promise<OrderCandidate[]> {
  const [orders, vaults] = await Promise.all([
    client.readContract({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "allOrders",
      blockNumber,
    }),
    vaultFactoryAddress === undefined
      ? Promise.resolve([])
      : client.readContract({
          address: vaultFactoryAddress,
          abi: vaultFactoryAbi,
          functionName: "allVaults",
          blockNumber,
        }),
  ]);
  const subscriptions = [...new Set([...orders, ...vaults])];
  const standingOrders = new Set(
    orders.map((address) => address.toLowerCase()),
  );
  const [feeResults, ticketResults] = await Promise.all([
    client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: subscriptions.map((address) => ({
        address,
        abi: standingOrderAbi,
        functionName: "crankFee" as const,
      })),
    }),
    client.multicall({
      allowFailure: true,
      blockNumber,
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
        requiresNativeBalance: standingOrders.has(
          address.toLowerCase(),
        ),
      });
    }
  }
  const sorted = candidates.sort((a, b) => {
    if (a.crankFee === b.crankFee) {
      return a.address.localeCompare(b.address);
    }
    return a.crankFee > b.crankFee ? -1 : 1;
  });
  cachedOrderCandidates = sorted;
  return sorted;
}

async function refreshCachedOrderCandidates(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly candidates: readonly OrderCandidate[];
  readonly blockNumber: bigint;
}): Promise<readonly OrderCandidate[]> {
  if (parameters.candidates.length === 0) return [];
  const [feeResults, ticketResults] = await Promise.all([
    parameters.client.multicall({
      allowFailure: true,
      blockNumber: parameters.blockNumber,
      contracts: parameters.candidates.map((candidate) => ({
        address: candidate.address,
        abi: standingOrderAbi,
        functionName: "crankFee" as const,
      })),
    }),
    parameters.client.multicall({
      allowFailure: true,
      blockNumber: parameters.blockNumber,
      contracts: parameters.candidates.map((candidate) => ({
        address: candidate.address,
        abi: standingOrderAbi,
        functionName: "ticketsPerRound" as const,
      })),
    }),
  ]);
  return parameters.candidates.flatMap((candidate, index) => {
    const fee = feeResults[index];
    const tickets = ticketResults[index];
    return fee?.status === "success" && tickets?.status === "success"
      ? [
          {
            address: candidate.address,
            crankFee: fee.result,
            ticketsPerRound: BigInt(tickets.result),
            requiresNativeBalance:
              candidate.requiresNativeBalance,
          },
        ]
      : [];
  });
}

async function getEligibleOrders(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly candidates: readonly OrderCandidate[];
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly skipped: Map<string, number>;
  readonly blockNumber?: bigint;
  readonly roundId?: bigint;
  readonly minimumTicketCost?: bigint;
}): Promise<EligibleOrder[]> {
  const candidateCount = parameters.candidates.length;
  const prefilterResults = await parameters.client.multicall({
    allowFailure: true,
    contracts: [
      ...parameters.candidates.map((candidate) => ({
        address: MULTICALL3_ADDRESS,
        abi: multicall3BalanceAbi,
        functionName: "getEthBalance" as const,
        args: [candidate.address] as const,
      })),
      ...(parameters.roundId === undefined
        ? []
        : parameters.candidates.map((candidate) => ({
            address: candidate.address,
            abi: standingOrderAbi,
            functionName: "lastRoundBought" as const,
          }))),
    ],
    ...(parameters.blockNumber === undefined
      ? {}
      : { blockNumber: parameters.blockNumber }),
  });
  const balanceResults = prefilterResults.slice(0, candidateCount);
  const lastRoundResults =
    parameters.roundId === undefined
      ? undefined
      : prefilterResults.slice(candidateCount);
  const candidates = parameters.candidates.filter((candidate, index) => {
    const balance = balanceResults[index];
    if (
      balance?.status === "success" &&
      candidate.requiresNativeBalance &&
      !orderHasMinimumBalance(
        balance.result,
        candidate.crankFee,
        parameters.minimumTicketCost ?? 0n,
      )
    ) {
      incrementReason(parameters.skipped, "InsufficientBalance");
      return false;
    }
    const lastRound = lastRoundResults?.[index];
    if (
      lastRound?.status === "success" &&
      parameters.roundId !== undefined &&
      orderAlreadyBought(lastRound.result, parameters.roundId)
    ) {
      incrementReason(parameters.skipped, "AlreadyBought");
      return false;
    }
    return true;
  });
  log("debug", "order_balance_prefilter", {
    candidates: parameters.candidates.length,
    retained: candidates.length,
    filtered: parameters.candidates.length - candidates.length,
  });
  const evaluations = await mapConcurrent(
    candidates,
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
          ...(parameters.blockNumber === undefined
            ? {}
            : { blockNumber: parameters.blockNumber }),
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

export function orderHasMinimumBalance(
  balance: bigint,
  crankFee: bigint,
  minimumTicketCost = 0n,
): boolean {
  if (balance < 0n || crankFee < 0n || minimumTicketCost < 0n) {
    throw new Error("order balance and costs cannot be negative");
  }
  return balance >= crankFee + minimumTicketCost;
}

export function orderAlreadyBought(
  lastRoundBought: bigint,
  roundId: bigint,
): boolean {
  if (lastRoundBought < 0n || roundId < 0n) {
    throw new Error("order round identifiers cannot be negative");
  }
  return lastRoundBought >= roundId;
}

export function planningHeadIsStale(
  plannedBlock: bigint,
  observedBlock: bigint,
): boolean {
  if (plannedBlock < 0n || observedBlock < 0n) {
    throw new Error("block numbers cannot be negative");
  }
  return observedBlock > plannedBlock;
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
  readonly blockNumber?: bigint;
}): Promise<bigint> {
  const estimate = await parameters.client.estimateContractGas({
    account: parameters.account,
    address: parameters.pool,
    abi: poolAbi,
    functionName: parameters.functionName,
    args: [parameters.roundId],
    ...(parameters.blockNumber === undefined
      ? {}
      : { blockNumber: parameters.blockNumber }),
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
  readonly blockNumber?: bigint;
  readonly jobLimit?: number;
  readonly allowBlockedPull?: boolean;
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
  const configuredLimit = maxJobs(config);
  const limit =
    parameters.jobLimit === undefined
      ? configuredLimit
      : Math.min(configuredLimit, parameters.jobLimit);
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
      ...(parameters.blockNumber === undefined
        ? {}
        : { blockNumber: parameters.blockNumber }),
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
              ...(parameters.blockNumber === undefined
                ? {}
                : { blockNumber: parameters.blockNumber }),
            }),
            client.readContract({
              address: fwa,
              abi: fwaAbi,
              functionName: "lastIssuedSequence",
              ...(parameters.blockNumber === undefined
                ? {}
                : { blockNumber: parameters.blockNumber }),
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
          ...(parameters.blockNumber === undefined
            ? {}
            : { blockNumber: parameters.blockNumber }),
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
              ...(parameters.blockNumber === undefined
                ? {}
                : { blockNumber: parameters.blockNumber }),
            }),
            client.estimateContractGas({
              account,
              address: fwa,
              abi: fwaAbi,
              functionName: "processAcquisitions",
              args: [processCount],
              ...(parameters.blockNumber === undefined
                ? {}
                : { blockNumber: parameters.blockNumber }),
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
        ...(parameters.blockNumber === undefined
          ? {}
          : { blockNumber: parameters.blockNumber }),
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
          ...(parameters.blockNumber === undefined
            ? {}
            : { blockNumber: parameters.blockNumber }),
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
      ...(parameters.blockNumber === undefined
        ? {}
        : { blockNumber: parameters.blockNumber }),
    });
    if (needed === 0n) {
      if (parameters.allowBlockedPull) {
        return {
          jobs: [
            poolJob({
              kind: "pool_pull",
              pool,
              roundId: roundCount,
              gas: config.poolPullGasLimit,
              terms,
              bidPolicy: "pool_pull",
            }),
          ],
          minimumViablePrefix: 1,
        };
      }
      try {
        const gas = await estimatePoolCall({
          client,
          account,
          pool,
          functionName: "pull",
          roundId: roundCount,
          config,
          ...(parameters.blockNumber === undefined
            ? {}
            : { blockNumber: parameters.blockNumber }),
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
      roundId: roundCount,
      minimumTicketCost: round.ticketPrice,
      ...(parameters.blockNumber === undefined
        ? {}
        : { blockNumber: parameters.blockNumber }),
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
    ...(parameters.blockNumber === undefined
      ? {}
      : { blockNumber: parameters.blockNumber }),
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
  readonly headBlockNumber: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableConvexEarmarks) return undefined;
  try {
    const candidateSnapshot = getConvexCandidatePools({
      headBlockNumber: parameters.headBlockNumber,
    });
    if (candidateSnapshot === undefined) {
      incrementReason(
        parameters.skipped,
        "convex_earmark_cache_cold",
      );
      return undefined;
    }
    const pools = candidateSnapshot.pools;
    log("debug", "convex_candidate_cache_used", {
      snapshotBlock:
        candidateSnapshot.requestedAtBlock.toString(),
      ageBlocks:
        (
          parameters.headBlockNumber -
          candidateSnapshot.requestedAtBlock
        ).toString(),
      candidates: pools.length,
    });
    const [staker, incentiveBps, crvRound, ethRound] =
      await Promise.all([
        parameters.client.readContract({
          address: CONVEX_BOOSTER_ADDRESS,
          abi: convexBoosterAbi,
          functionName: "staker",
          blockNumber: parameters.headBlockNumber,
        }),
        parameters.client.readContract({
          address: CONVEX_BOOSTER_ADDRESS,
          abi: convexBoosterAbi,
          functionName: "earmarkIncentive",
          blockNumber: parameters.headBlockNumber,
        }),
        parameters.client.readContract({
          address: CRV_USD_FEED_ADDRESS,
          abi: chainlinkPriceFeedAbi,
          functionName: "latestRoundData",
          blockNumber: parameters.headBlockNumber,
        }),
        parameters.client.readContract({
          address: ETH_USD_FEED_ADDRESS,
          abi: chainlinkPriceFeedAbi,
          functionName: "latestRoundData",
          blockNumber: parameters.headBlockNumber,
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
      blockNumber: parameters.headBlockNumber,
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
              blockNumber: parameters.headBlockNumber,
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

async function planStakeDaoCurveHarvest(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly discoveryClient: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableStakeDaoCurveHarvests) return undefined;
  if (parameters.config.submissionMode !== "flashbots") {
    incrementReason(parameters.skipped, "stakedao_curve_private_only");
    return undefined;
  }
  try {
    const gauges = await discoverStakeDaoCurveGauges({
      client: parameters.discoveryClient,
      stateClient: parameters.client,
      maximumBlockRange: BigInt(
        parameters.config.stakeDaoDiscoveryBlockRange,
      ),
      concurrency: parameters.config.simulationConcurrency,
    });
    const [
      harvestFeePercent,
      crvRound,
      ethRound,
      claimableResults,
      accountingResults,
    ] = await Promise.all([
      parameters.client.readContract({
        address: STAKE_DAO_ACCOUNTANT_ADDRESS,
        abi: stakeDaoAccountantAbi,
        functionName: "getHarvestFeePercent",
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
      parameters.client.multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: gauges.map(({ gauge }) => ({
          address: gauge,
          abi: curveGaugeAbi,
          functionName: "claimable_tokens" as const,
          args: [STAKE_DAO_CURVE_LOCKER_ADDRESS] as const,
        })),
      }),
      parameters.client.multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: gauges.map(({ vault }) => ({
          address: STAKE_DAO_ACCOUNTANT_ADDRESS,
          abi: stakeDaoAccountantAbi,
          functionName: "vaults" as const,
          args: [vault] as const,
        })),
      }),
    ]);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
    const maximumAgeSeconds = BigInt(
      parameters.config.stakeDaoOracleMaxAgeSeconds,
    );
    if (
      harvestFeePercent <= 0n ||
      harvestFeePercent > 1_000_000_000_000_000_000n ||
      !isFreshChainlinkRound({
        roundId: crvRound[0],
        answer: crvRound[1],
        updatedAt: crvRound[3],
        answeredInRound: crvRound[4],
        nowSeconds,
        maximumAgeSeconds,
      }) ||
      !isFreshChainlinkRound({
        roundId: ethRound[0],
        answer: ethRound[1],
        updatedAt: ethRound[3],
        answeredInRound: ethRound[4],
        nowSeconds,
        maximumAgeSeconds,
      })
    ) {
      incrementReason(
        parameters.skipped,
        "stakedao_curve_invalid_fee_or_oracle",
      );
      return undefined;
    }

    const crvUsd = crvRound[1];
    const ethUsd = ethRound[1];
    const candidates = gauges
      .flatMap((entry, index) => {
        const claimable = claimableResults[index];
        const accounting = accountingResults[index];
        if (
          claimable?.status !== "success" ||
          claimable.result === 0n ||
          accounting?.status !== "success"
        ) {
          return [];
        }
        const [, supply, , , netCredited, reservedHarvestFee, reservedProtocolFee] =
          accounting.result;
        const harvesterFeeCrv =
          conservativeStakeDaoHarvesterFee({
            claimableCrv: claimable.result,
            harvestFeePercent,
            accounting: {
              supply,
              netCredited,
              reservedHarvestFee,
              reservedProtocolFee,
            },
          });
        if (harvesterFeeCrv === 0n) return [];
        const rewardEthEquivalent = conservativeCrvToEthWei({
          crvAmount: harvesterFeeCrv,
          crvUsd,
          ethUsd,
          haircutBps:
            parameters.config.stakeDaoHarvestRewardHaircutBps,
        });
        if (rewardEthEquivalent === 0n) return [];
        return [{
          ...entry,
          harvesterFeeCrv,
          rewardEthEquivalent,
        }];
      })
      .sort((left, right) =>
        left.rewardEthEquivalent === right.rewardEthEquivalent
          ? left.gauge.localeCompare(right.gauge)
          : left.rewardEthEquivalent > right.rewardEthEquivalent
            ? -1
            : 1,
      )
      .slice(0, parameters.config.stakeDaoHarvestMaxCandidates);

    const prefixBatches = stakeDaoGaugePrefixes(
      candidates,
      parameters.config.stakeDaoHarvestMaxBatchSize,
    );
    const batches = [
      ...candidates.map((candidate) => [candidate] as const),
      ...prefixBatches.filter((batch) => batch.length > 1),
    ];
    const estimates = await mapConcurrent(
      batches,
      parameters.config.simulationConcurrency,
      async (batch): Promise<KeeperJob | undefined> => {
        const gaugeAddresses = batch.map(({ gauge }) => gauge);
        const harvesterFeeCrv = batch.reduce(
          (total, candidate) =>
            total + candidate.harvesterFeeCrv,
          0n,
        );
        const rewardEthEquivalent = batch.reduce(
          (total, candidate) =>
            total + candidate.rewardEthEquivalent,
          0n,
        );
        try {
          // This is the final calldata, including one empty harvestData entry
          // per gauge and the actual receiver. A reverting gauge rejects only
          // this atomic candidate; single-gauge alternatives remain eligible.
          const estimatedGas =
            await parameters.client.estimateContractGas({
              account: parameters.account,
              address: STAKE_DAO_ACCOUNTANT_ADDRESS,
              abi: stakeDaoAccountantAbi,
              functionName: "harvest",
              args: [
                gaugeAddresses,
                gaugeAddresses.map(() => "0x" as const),
                typeof parameters.account === "string"
                  ? parameters.account
                  : parameters.account.address,
              ],
            });
          const decision = assessProfit({
            crankFee: rewardEthEquivalent,
            estimatedGas,
            maxFeePerGas: parameters.maxFeePerGas,
            gasLimitMultiplierBps:
              parameters.config.gasLimitMultiplierBps,
            minProfitWei: parameters.config.minProfitWei,
          });
          if (
            !decision.profitable ||
            decision.gasLimit >
              parameters.config.stakeDaoHarvestGasLimit
          ) {
            return undefined;
          }
          return {
            kind: "stakedao_curve_harvest",
            label:
              `stakedao_curve_harvest:${gaugeAddresses.length}:` +
              gaugeAddresses[0],
            target: STAKE_DAO_ACCOUNTANT_ADDRESS,
            data: encodeFunctionData({
              abi: stakeDaoAccountantAbi,
              functionName: "harvest",
              args: [
                gaugeAddresses,
                gaugeAddresses.map(() => "0x" as const),
                typeof parameters.account === "string"
                  ? parameters.account
                  : parameters.account.address,
              ],
            }),
            gas: decision.gasLimit,
            reward: {
              kind: "fixed",
              amountWei: rewardEthEquivalent,
            },
            stakeDaoCrvReward: harvesterFeeCrv,
            stakeDaoCrvUsd: crvUsd,
            stakeDaoEthUsd: ethUsd,
            stakeDaoRewardHaircutBps:
              parameters.config.stakeDaoHarvestRewardHaircutBps,
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
        "stakedao_curve_none_profitable",
      );
      log("debug", "stakedao_curve_scan", {
        activeGauges: gauges.length,
        rewardCandidates: candidates.length,
        exactSimulations: batches.length,
        selected: false,
      });
      return undefined;
    }
    log("info", "stakedao_curve_opportunity", {
      label: selected.label,
      activeGauges: gauges.length,
      rewardCandidates: candidates.length,
      exactSimulations: batches.length,
      gaugeCount: selected.label.split(":")[1] ?? "",
      estimatedHarvesterFee:
        `${formatUnits(selected.stakeDaoCrvReward ?? 0n, 18)} CRV`,
      conservativeReward:
        selected.reward.kind === "fixed"
          ? eth(selected.reward.amountWei)
          : eth(0n),
      gasLimit: selected.gas.toString(),
      privateOnly: true,
    });
    return selected;
  } catch (error) {
    incrementReason(
      parameters.skipped,
      revertedErrorName(error) ??
        "stakedao_curve_scan_failed",
    );
    log("warn", "stakedao_curve_scan_failed", {
      reason: errorMessage(error),
    });
    return undefined;
  }
}

export async function planFirmReplenishment(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly discoveryClient: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly headBlockNumber: bigint;
  readonly headTimestamp: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableFirmReplenishments) return undefined;
  if (parameters.config.submissionMode !== "flashbots") {
    incrementReason(parameters.skipped, "firm_replenish_private_only");
    return undefined;
  }
  const replenisher =
    typeof parameters.account === "string"
      ? parameters.account
      : parameters.account.address;
  try {
    const discovery = await discoverFirmCandidates({
      client: parameters.discoveryClient,
      latestBlock: parameters.headBlockNumber,
      borrowerLookbackBlocks: BigInt(
        parameters.config.firmBorrowerLookbackBlocks,
      ),
      maximumBlockRange: BigInt(
        parameters.config.firmDiscoveryBlockRange,
      ),
      concurrency: parameters.config.simulationConcurrency,
    });
    const candidates = discovery.candidates.slice(
      0,
      parameters.config.firmMaxCandidates,
    );
    const [
      replenishmentPriceBps,
      dolaRound,
      ethRound,
      dolaUsdDecimals,
      ethUsdDecimals,
      dolaBalanceBefore,
    ] = await Promise.all([
      parameters.client.readContract({
        address: FIRM_DBR_ADDRESS,
        abi: firmDbrAbi,
        functionName: "replenishmentPriceBps",
        blockNumber: parameters.headBlockNumber,
      }),
      parameters.client.readContract({
        address: FIRM_DOLA_USD_FEED_ADDRESS,
        abi: chainlinkPriceFeedAbi,
        functionName: "latestRoundData",
        blockNumber: parameters.headBlockNumber,
      }),
      parameters.client.readContract({
        address: ETH_USD_FEED_ADDRESS,
        abi: chainlinkPriceFeedAbi,
        functionName: "latestRoundData",
        blockNumber: parameters.headBlockNumber,
      }),
      parameters.client.readContract({
        address: FIRM_DOLA_USD_FEED_ADDRESS,
        abi: chainlinkPriceFeedAbi,
        functionName: "decimals",
        blockNumber: parameters.headBlockNumber,
      }),
      parameters.client.readContract({
        address: ETH_USD_FEED_ADDRESS,
        abi: chainlinkPriceFeedAbi,
        functionName: "decimals",
        blockNumber: parameters.headBlockNumber,
      }),
      parameters.client.readContract({
        address: FIRM_DOLA_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [replenisher],
        blockNumber: parameters.headBlockNumber,
      }),
    ]);
    if (
      !firmOracleRoundsAreFresh({
        dolaRound: {
          roundId: dolaRound[0],
          answer: dolaRound[1],
          updatedAt: dolaRound[3],
          answeredInRound: dolaRound[4],
        },
        ethRound: {
          roundId: ethRound[0],
          answer: ethRound[1],
          updatedAt: ethRound[3],
          answeredInRound: ethRound[4],
        },
        nowSeconds: parameters.headTimestamp,
        dolaMaximumAgeSeconds: BigInt(
          parameters.config.firmDolaOracleMaxAgeSeconds,
        ),
        ethMaximumAgeSeconds: BigInt(
          parameters.config.firmEthOracleMaxAgeSeconds,
        ),
      })
    ) {
      incrementReason(
        parameters.skipped,
        "firm_replenish_stale_oracle",
      );
      return undefined;
    }

    type Evaluation =
      | {
          readonly job: KeeperJob;
          readonly deficit: bigint;
          readonly rewardDola: bigint;
          readonly rewardEth: bigint;
          readonly estimatedGas: bigint;
        }
      | { readonly reason: string };
    const evaluations = await mapConcurrent(
      candidates,
      parameters.config.simulationConcurrency,
      async (candidate): Promise<Evaluation> => {
        try {
          const [
            marketDbr,
            marketDola,
            activeMarket,
            replenishmentIncentiveBps,
            deficit,
          ] = await Promise.all([
            parameters.client.readContract({
              address: candidate.market,
              abi: firmMarketAbi,
              functionName: "dbr",
              blockNumber: parameters.headBlockNumber,
            }),
            parameters.client.readContract({
              address: candidate.market,
              abi: firmMarketAbi,
              functionName: "dola",
              blockNumber: parameters.headBlockNumber,
            }),
            parameters.client.readContract({
              address: FIRM_DBR_ADDRESS,
              abi: firmDbrAbi,
              functionName: "markets",
              args: [candidate.market],
              blockNumber: parameters.headBlockNumber,
            }),
            parameters.client.readContract({
              address: candidate.market,
              abi: firmMarketAbi,
              functionName: "replenishmentIncentiveBps",
              blockNumber: parameters.headBlockNumber,
            }),
            parameters.client.readContract({
              address: FIRM_DBR_ADDRESS,
              abi: firmDbrAbi,
              functionName: "deficitOf",
              args: [candidate.account],
              blockNumber: parameters.headBlockNumber,
            }),
          ]);
          if (
            getAddress(marketDbr) !== FIRM_DBR_ADDRESS ||
            getAddress(marketDola) !== FIRM_DOLA_ADDRESS ||
            !activeMarket
          ) {
            return { reason: "firm_replenish_relationship_mismatch" };
          }
          if (deficit === 0n) {
            return { reason: "firm_replenish_zero_deficit" };
          }
          const { replenishmentCostDola, replenisherRewardDola } =
            firmReplenishmentAmounts({
              deficit,
              replenishmentPriceBps,
              replenishmentIncentiveBps,
            });
          if (replenisherRewardDola === 0n) {
            return { reason: "firm_replenish_zero_reward" };
          }
          const rewardEth = conservativeDolaToEthWei({
            dolaAmount: replenisherRewardDola,
            dolaUsd: dolaRound[1],
            dolaUsdDecimals,
            ethUsd: ethRound[1],
            ethUsdDecimals,
            haircutBps: parameters.config.firmRewardHaircutBps,
          });
          if (rewardEth === 0n) {
            return { reason: "firm_replenish_zero_reward_value" };
          }
          const data = firmForceReplenishCalldata({
            account: candidate.account,
            fixedObservedDeficit: deficit,
          });
          const [, estimatedGas] = await Promise.all([
            parameters.client.simulateContract({
              account: parameters.account,
              address: candidate.market,
              abi: firmMarketAbi,
              functionName: "forceReplenish",
              args: [candidate.account, deficit],
            }),
            parameters.client.estimateContractGas({
              account: parameters.account,
              address: candidate.market,
              abi: firmMarketAbi,
              functionName: "forceReplenish",
              args: [candidate.account, deficit],
            }),
          ]);
          const decision = assessProfit({
            crankFee: rewardEth,
            estimatedGas,
            maxFeePerGas: parameters.maxFeePerGas,
            gasLimitMultiplierBps:
              parameters.config.gasLimitMultiplierBps,
            minProfitWei: parameters.config.minProfitWei,
          });
          if (!decision.profitable) {
            return { reason: "firm_replenish_unprofitable" };
          }
          if (
            decision.gasLimit >
            parameters.config.firmReplenishGasLimit
          ) {
            return { reason: "firm_replenish_gas_above_limit" };
          }
          return {
            deficit,
            rewardDola: replenisherRewardDola,
            rewardEth,
            estimatedGas,
            job: {
              kind: "firm_replenish",
              label:
                `firm_replenish:${candidate.market}:` +
                candidate.account,
              target: candidate.market,
              data,
              gas: decision.gasLimit,
              reward: { kind: "fixed", amountWei: rewardEth },
              firmAccount: candidate.account,
              firmReplenisher: replenisher,
              firmFixedDeficit: deficit,
              firmReplenishmentCostDola: replenishmentCostDola,
              firmDolaReward: replenisherRewardDola,
              firmDolaBalanceBefore: dolaBalanceBefore,
              firmDolaUsd: dolaRound[1],
              firmDolaUsdDecimals: dolaUsdDecimals,
              firmEthUsd: ethRound[1],
              firmEthUsdDecimals: ethUsdDecimals,
              firmRewardHaircutBps:
                parameters.config.firmRewardHaircutBps,
            },
          };
        } catch (error) {
          return {
            reason:
              revertedErrorName(error) ??
              "firm_replenish_simulation_failed",
          };
        }
      },
    );
    const viable = evaluations.flatMap((evaluation) => {
      if ("reason" in evaluation) {
        incrementReason(parameters.skipped, evaluation.reason);
        return [];
      }
      return [evaluation];
    });
    viable.sort((left, right) => {
      const leftProfit =
        left.rewardEth - left.job.gas * parameters.maxFeePerGas;
      const rightProfit =
        right.rewardEth - right.job.gas * parameters.maxFeePerGas;
      return leftProfit === rightProfit
        ? left.job.label.localeCompare(right.job.label)
        : leftProfit > rightProfit
          ? -1
          : 1;
    });
    const selected = viable[0];
    log(selected === undefined ? "debug" : "info", "firm_replenish_scan", {
      registeredMarkets: discovery.registeredMarkets,
      recentPairs: discovery.candidates.length,
      evaluatedPairs: candidates.length,
      viable: viable.length,
      selected: selected !== undefined,
      scannedThrough: discovery.scannedThrough.toString(),
    });
    if (selected === undefined) return undefined;
    log("info", "firm_replenish_opportunity", {
      label: selected.job.label,
      market: selected.job.target,
      account: selected.job.firmAccount ?? "",
      replenisher: selected.job.firmReplenisher ?? "",
      fixedObservedDeficit:
        `${formatUnits(selected.deficit, 18)} DBR`,
      replenishmentCost:
        `${formatUnits(
          selected.job.firmReplenishmentCostDola ?? 0n,
          18,
        )} DOLA`,
      deterministicReward:
        `${formatUnits(selected.rewardDola, 18)} DOLA`,
      conservativeReward: eth(selected.rewardEth),
      estimatedGas: selected.estimatedGas.toString(),
      gasLimit: selected.job.gas.toString(),
      privateOnly: true,
    });
    return selected.job;
  } catch (error) {
    incrementReason(
      parameters.skipped,
      revertedErrorName(error) ?? "firm_replenish_scan_failed",
    );
    log("warn", "firm_replenish_scan_failed", {
      reason: errorMessage(error),
    });
    return undefined;
  }
}

async function planLifecycleFundingSuffix(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly pool: Address;
  readonly fwa: Address;
  readonly fundingRoundId: bigint;
  readonly fundingRound: Promise<PoolRoundSnapshot | undefined>;
  readonly headBlockNumber: bigint;
  readonly maxFeePerGas: bigint;
  readonly bountyBaseFeePerGas: bigint;
  readonly skipped: Map<string, number>;
}): Promise<LifecycleFundingSuffix<KeeperJob> | undefined> {
  // Ready lifecycle uses three transactions. Reserving all three keeps the
  // suffix within the configured batch cap before the lifecycle plan resolves.
  const availableJobs = maxJobs(parameters.config) - 3;
  if (availableJobs < 1) return undefined;
  const fundingRound = await parameters.fundingRound;
  if (
    fundingRound === undefined ||
    fundingRound.state !== ROUND_STATE.open
  ) {
    return undefined;
  }
  const cached = cachedOrderCandidates.slice(
    0,
    LIFECYCLE_FUNDING_CANDIDATE_LIMIT,
  );
  const candidates = await refreshCachedOrderCandidates({
    client: parameters.client,
    candidates: cached,
    blockNumber: parameters.headBlockNumber,
  });
  const plan = await planPrimaryJobs({
    client: parameters.client,
    account: parameters.account,
    config: parameters.config,
    pool: parameters.pool,
    fwa: parameters.fwa,
    candidates,
    roundCount: parameters.fundingRoundId,
    round: fundingRound,
    maxFeePerGas: parameters.maxFeePerGas,
    bountyBaseFeePerGas: parameters.bountyBaseFeePerGas,
    skipped: parameters.skipped,
    blockNumber: parameters.headBlockNumber,
    jobLimit: availableJobs,
    allowBlockedPull: true,
  });
  return {
    source: "cache",
    headBlockNumber: parameters.headBlockNumber,
    fundingRoundId: parameters.fundingRoundId,
    coverageSatisfied: plan.jobs.at(-1)?.kind === "pool_pull",
    jobs: plan.jobs,
  };
}

async function planJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly discoveryClient: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly maxFeePerGas: bigint;
  readonly convexMaxFeePerGas: bigint;
  readonly stakeDaoMaxFeePerGas: bigint;
  readonly firmMaxFeePerGas: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly bountyBaseFeePerGas: bigint;
  readonly headBlockNumber: bigint;
  readonly headTimestamp: bigint;
}): Promise<PlannedJobs> {
  const skipped = new Map<string, number>();
  const [roundCount, ethPendingRound, fwa, token] = await Promise.all([
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "roundCount",
      blockNumber: parameters.headBlockNumber,
    }),
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "ethPendingRound",
      blockNumber: parameters.headBlockNumber,
    }),
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "FWA",
      blockNumber: parameters.headBlockNumber,
    }),
    parameters.client.readContract({
      address: parameters.config.expectedPoolAddress,
      abi: poolAbi,
      functionName: "FWA_TOKEN",
      blockNumber: parameters.headBlockNumber,
    }),
  ]);
  const tokenAddress = getAddress(token);
  if (tokenAddress !== parameters.config.expectedFwaTokenAddress) {
    throw new Error(
      `pool FWA token ${tokenAddress} does not match expected token ${parameters.config.expectedFwaTokenAddress}`,
    );
  }
  const routing = routeRoundIds({ roundCount, ethPendingRound });
  const fundingRoundPromise =
    routing.fundingRoundId === undefined ||
    routing.fundingRoundId === routing.lifecycleRoundId
      ? Promise.resolve(undefined)
      : getRoundSnapshot(
          parameters.client,
          parameters.config.expectedPoolAddress,
          routing.fundingRoundId,
          parameters.headBlockNumber,
        );
  const plannerBase = {
    client: parameters.client,
    account: parameters.account,
    config: parameters.config,
    pool: parameters.config.expectedPoolAddress,
    fwa: getAddress(fwa),
    maxFeePerGas: parameters.maxFeePerGas,
    bountyBaseFeePerGas: parameters.bountyBaseFeePerGas,
    skipped,
    blockNumber: parameters.headBlockNumber,
  } as const;
  const lifecycleFundingSkipped = new Map<string, number>();
  const lifecycleFundingPromise =
    routing.fundingRoundId === undefined ||
    routing.lifecycleRoundId === undefined ||
    routing.fundingRoundId === routing.lifecycleRoundId
      ? undefined
      : planLifecycleFundingSuffix({
          client: parameters.client,
          account: parameters.account,
          config: parameters.config,
          pool: parameters.config.expectedPoolAddress,
          fwa: getAddress(fwa),
          fundingRoundId: routing.fundingRoundId,
          fundingRound: fundingRoundPromise,
          headBlockNumber: parameters.headBlockNumber,
          maxFeePerGas: parameters.maxFeePerGas,
          bountyBaseFeePerGas: parameters.bountyBaseFeePerGas,
          skipped: lifecycleFundingSkipped,
        }).catch((error: unknown) => {
          log("debug", "lifecycle_funding_enrichment_failed", {
            reason: errorMessage(error),
          });
          return undefined;
        });

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
      parameters.headBlockNumber,
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
      const enriched =
        routing.fundingRoundId === undefined
          ? {
              jobs: lifecyclePrimary.jobs,
              minimumViablePrefix:
                lifecyclePrimary.minimumViablePrefix,
              enriched: false,
              reason: "funding_unavailable" as const,
            }
          : await lifecycleFundingSuperset({
              lifecycleJobs: lifecyclePrimary.jobs,
              lifecycleMinimumViablePrefix:
                lifecyclePrimary.minimumViablePrefix,
              headBlockNumber: parameters.headBlockNumber,
              fundingRoundId: routing.fundingRoundId,
              funding: lifecycleFundingPromise,
              timeoutMs: LIFECYCLE_FUNDING_WAIT_MS,
            });
      log("debug", "lifecycle_fast_path_selected", {
        round: routing.lifecycleRoundId.toString(),
        jobs: enriched.jobs.length,
        baseJobs: lifecyclePrimary.jobs.length,
        fundingEnriched: enriched.enriched,
        ...(enriched.reason === undefined
          ? {}
          : { fundingFallback: enriched.reason }),
        estimatedProfit: eth(profit),
      });
      return {
        jobs: enriched.jobs,
        minimumViablePrefix:
          enriched.minimumViablePrefix,
        orders: lastKnownOrderCount,
        skipped,
      };
    }
  }

  const plannerDurations: Record<string, number> = {};
  const trackPlanner = async <Result>(
    name: string,
    task: () => Promise<Result>,
  ): Promise<Result> => {
    const startedAt = performance.now();
    try {
      return await task();
    } finally {
      plannerDurations[`${name}Ms`] =
        performance.now() - startedAt;
    }
  };
  const candidatesPromise = trackPlanner(
    "orderCandidates",
    () =>
      getOrderCandidates(
        parameters.client,
        parameters.config.factoryAddress,
        parameters.config.enableVaults
          ? parameters.config.vaultFactoryAddress
          : undefined,
        parameters.headBlockNumber,
      ),
  );
  const liquityPromise = trackPlanner(
    "liquity",
    () =>
      planLiquityLiquidation({
        client: parameters.client,
        account: parameters.account,
        config: parameters.config,
        maxFeePerGas: parameters.maxFeePerGas,
        skipped,
      }),
  );
  const convexPromise = trackPlanner(
    "convexEarmark",
    () =>
      planConvexEarmark({
        client: parameters.client,
        account: parameters.account,
        config: parameters.config,
        maxFeePerGas: parameters.convexMaxFeePerGas,
        headBlockNumber: parameters.headBlockNumber,
        skipped,
      }),
  );
  const convexKickPromise = trackPlanner(
    "convexKick",
    () =>
      planConvexKick({
        client: parameters.client,
        account: parameters.account,
        config: parameters.config,
        maxFeePerGas: parameters.convexMaxFeePerGas,
        skipped,
      }),
  );
  const stakeDaoPromise = trackPlanner(
    "stakeDao",
    () =>
      planStakeDaoCurveHarvest({
        client: parameters.client,
        discoveryClient: parameters.discoveryClient,
        account: parameters.account,
        config: parameters.config,
        maxFeePerGas: parameters.stakeDaoMaxFeePerGas,
        skipped,
      }),
  );
  const firmPromise = trackPlanner(
    "firm",
    () =>
      planFirmReplenishment({
        client: parameters.client,
        discoveryClient: parameters.discoveryClient,
        account: parameters.account,
        config: parameters.config,
        maxFeePerGas: parameters.firmMaxFeePerGas,
        headBlockNumber: parameters.headBlockNumber,
        headTimestamp: parameters.headTimestamp,
        skipped,
      }),
  );
  const [
    candidates,
    fundingRound,
    liquity,
    convex,
    convexKick,
    stakeDao,
    firm,
    buyback,
    liveBidSweep,
  ] = await Promise.all([
      candidatesPromise,
      fundingRoundPromise,
      liquityPromise,
      convexPromise,
      convexKickPromise,
      stakeDaoPromise,
      firmPromise,
      trackPlanner("buyback", () =>
        planBuyback({
          client: parameters.client,
          account: parameters.account,
          config: parameters.config,
          token: tokenAddress,
          maxFeePerGas: parameters.maxFeePerGas,
          skipped,
        }),
      ),
      trackPlanner("liveBidSweep", () =>
        planLiveBidSweep({
          client: parameters.client,
          account: parameters.account,
          config: parameters.config,
          baseFeeAllowancePerGas:
            parameters.baseFeeAllowancePerGas,
          skipped,
        }),
      ),
    ]);
  log("info", "keeper_planner_timing", {
    planningBlock: parameters.headBlockNumber.toString(),
    ...plannerDurations,
  });
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
    stakeDao,
    firm,
    buyback,
    liveBidSweep,
  ]) {
    if (job === undefined || job.reward.kind !== "fixed") continue;
    const planningMaxFeePerGas =
      job.kind === "convex_earmark" || job.kind === "convex_kick"
        ? parameters.convexMaxFeePerGas
        : job.kind === "stakedao_curve_harvest"
          ? parameters.stakeDaoMaxFeePerGas
          : job.kind === "firm_replenish"
            ? parameters.firmMaxFeePerGas
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

type ReceiptLog = {
  readonly address: Address;
  readonly data: Hex;
  readonly topics: [] | [Hex, ...Hex[]];
};

function actualStakeDaoCrvReward(
  request: KeeperTransactionRequest,
  logs: readonly ReceiptLog[],
): bigint {
  if (request.kind !== "stakedao_curve_harvest") return 0n;
  let total = 0n;
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== request.target.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: stakeDaoAccountantAbi,
        data: entry.data,
        topics: entry.topics,
      });
      if (decoded.eventName === "Harvest") {
        total += decoded.args.harvesterFee;
      }
    } catch {
      // Ignore unrelated Accountant events.
    }
  }
  return total;
}

function actualJobReward(
  request: KeeperTransactionRequest,
  logs: readonly ReceiptLog[],
  firmAccounting?: FirmReceiptAccounting,
): bigint {
  if (
    (request.kind === "liquity_liquidation" ||
      request.kind === "convex_earmark" ||
      request.kind === "convex_kick") &&
    request.reward.kind === "fixed"
  ) {
    return request.reward.amountWei;
  }
  if (request.kind === "stakedao_curve_harvest") {
    if (
      request.stakeDaoCrvUsd === undefined ||
      request.stakeDaoEthUsd === undefined ||
      request.stakeDaoRewardHaircutBps === undefined
    ) {
      return 0n;
    }
    return conservativeCrvToEthWei({
      crvAmount: actualStakeDaoCrvReward(request, logs),
      crvUsd: request.stakeDaoCrvUsd,
      ethUsd: request.stakeDaoEthUsd,
      haircutBps: request.stakeDaoRewardHaircutBps,
    });
  }
  if (request.kind === "firm_replenish") {
    if (
      firmAccounting?.valid !== true ||
      request.firmDolaUsd === undefined ||
      request.firmDolaUsdDecimals === undefined ||
      request.firmEthUsd === undefined ||
      request.firmEthUsdDecimals === undefined ||
      request.firmRewardHaircutBps === undefined
    ) {
      return 0n;
    }
    return conservativeDolaToEthWei({
      dolaAmount: firmAccounting.replenisherRewardDola,
      dolaUsd: request.firmDolaUsd,
      dolaUsdDecimals: request.firmDolaUsdDecimals,
      ethUsd: request.firmEthUsd,
      ethUsdDecimals: request.firmEthUsdDecimals,
      haircutBps: request.firmRewardHaircutBps,
    });
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
  const headAndFeesStartedAt = performance.now();
  const [feeQuote, planningBlockRead] = await Promise.all([
    context.publicClient.estimateFeesPerGas({
      type: "eip1559",
    }),
    retryTransientRead({
      read: () =>
        context.publicClient.getBlock({
          blockNumber: context.headBlockNumber,
        }),
      shouldRetry: isBlockNotFound,
      maxAttempts: 11,
      retryDelayMs: 100,
    }),
  ]);
  const latestBlock = planningBlockRead.value;
  log("info", "keeper_pass_stage_timing", {
    stage: "head_and_fees",
    durationMs: performance.now() - headAndFeesStartedAt,
    blockReadAttempts: planningBlockRead.attempts,
    blockAvailabilityWaitMs: planningBlockRead.waitedMs,
    planningBlock: latestBlock.number.toString(),
    planningBlockHash: latestBlock.hash,
    headTimestamp: latestBlock.timestamp.toString(),
    headAgeMs:
      Date.now() - Number(latestBlock.timestamp) * 1_000,
  });
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

  const planningStartedAt = performance.now();
  const planningRead = await retryTransientRead({
    read: () =>
      planJobs({
        client: context.publicClient,
        discoveryClient:
          context.discoveryClient ?? context.publicClient,
        account: context.account,
        config: context.config,
        maxFeePerGas,
        convexMaxFeePerGas:
          context.config.submissionMode === "flashbots"
            ? feeQuote.maxFeePerGas
            : maxFeePerGas,
        stakeDaoMaxFeePerGas:
          context.config.submissionMode === "flashbots"
            ? feeQuote.maxFeePerGas
            : maxFeePerGas,
        firmMaxFeePerGas:
          context.config.submissionMode === "flashbots"
            ? feeQuote.maxFeePerGas
            : maxFeePerGas,
        baseFeeAllowancePerGas:
          maxFeePerGas - maxPriorityFeePerGas,
        bountyBaseFeePerGas:
          latestBlock.baseFeePerGas ??
          (maxFeePerGas - maxPriorityFeePerGas),
        headBlockNumber: latestBlock.number,
        headTimestamp: latestBlock.timestamp,
      }),
    shouldRetry: isFreshBlockStateUnavailable,
    maxAttempts: 11,
    retryDelayMs: 100,
  });
  const plan = planningRead.value;
  if (planningRead.attempts > 1) {
    log("info", "planning_state_availability_waited", {
      planningBlock: latestBlock.number.toString(),
      planningReadAttempts: planningRead.attempts,
      planningAvailabilityWaitMs: planningRead.waitedMs,
    });
  }
  log("info", "keeper_pass_stage_timing", {
    stage: "planning",
    durationMs: performance.now() - planningStartedAt,
    planningBlock: latestBlock.number.toString(),
    planningReadAttempts: planningRead.attempts,
    planningAvailabilityWaitMs: planningRead.waitedMs,
    plannedJobs: plan.jobs.length,
    minimumViablePrefix: plan.minimumViablePrefix,
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
        (job.kind === "convex_earmark" ||
          job.kind === "convex_kick" ||
          job.kind === "stakedao_curve_harvest" ||
          job.kind === "firm_replenish")
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
  const submissionHead = await context.publicClient.getBlockNumber();
  if (
    planningHeadIsStale(
      context.headBlockNumber,
      submissionHead,
    )
  ) {
    log("info", "keeper_plan_stale", {
      plannedBlock: context.headBlockNumber.toString(),
      currentBlock: submissionHead.toString(),
      action: "replan_next_pass",
    });
    return {
      orders: plan.orders,
      viable,
      sent: 0,
      confirmed: 0,
    };
  }

  const accountAddress =
    typeof context.account === "string"
      ? context.account
      : context.account.address;
  const accountGateStartedAt = performance.now();
  const [latestNonce, pendingNonce, accountBalance] = await Promise.all([
    context.publicClient.getTransactionCount({
      address: accountAddress,
      blockNumber: context.headBlockNumber,
    }),
    context.publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: "pending",
    }),
    context.publicClient.getBalance({
      address: accountAddress,
      blockNumber: context.headBlockNumber,
    }),
  ]);
  log("info", "keeper_pass_stage_timing", {
    stage: "account_gate",
    durationMs: performance.now() - accountGateStartedAt,
    latestNonce,
    pendingNonce,
  });
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
    const targetBlock = context.headBlockNumber + 1n;
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

  if (
    privateTargetBlock !== undefined &&
    submitted.length > 1
  ) {
    log("info", "keeper_batch_submitted", {
      kinds: JSON.stringify(
        submitted.map(({ request }) => request.kind),
      ),
      transactionCount: submitted.length,
      targetBlock: privateTargetBlock.toString(),
      firstNonce: submitted[0]?.request.nonce ?? "",
      lastNonce:
        submitted[submitted.length - 1]?.request.nonce ?? "",
      relayCount: batchResult?.relayCount ?? 0,
      effectiveBuilderBidBps:
        batchResult?.effectiveBuilderBidBps?.toString() ?? "",
    });
  }
  for (const [index, submission] of submitted.entries()) {
    log("info", "keeper_transaction_sent", {
      kind: submission.request.kind,
      label: submission.request.label,
      hash: submission.hash,
      nonce: submission.request.nonce,
      mode:
        privateTargetBlock === undefined ? "public" : "flashbots",
      targetBlock: privateTargetBlock?.toString() ?? "",
      ...(privateTargetBlock !== undefined &&
      submitted.length > 1
        ? {
            batchTransactionCount: submitted.length,
            batchPosition: index + 1,
          }
        : {}),
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

  if (
    privateTargetBlock !== undefined &&
    submitted.length > 0
  ) {
    const targetBlockWaitStartedAt = performance.now();
    let targetHeadSource = "http_poll";
    if (context.waitForTargetBlock !== undefined) {
      targetHeadSource = "websocket";
      const observed = await context.waitForTargetBlock(
        privateTargetBlock,
        Math.min(
          context.config.receiptTimeoutMs,
          context.config.headStaleTimeoutMs,
        ),
      );
      if (!observed) {
        throw new Error(
          `target block ${privateTargetBlock} was not observed by the head subscription`,
        );
      }
    } else {
      const deadline =
        Date.now() + context.config.receiptTimeoutMs;
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
    const targetBlockRead = await retryTransientRead({
      read: () =>
        context.publicClient.getBlock({
          blockNumber: privateTargetBlock,
        }),
      shouldRetry: isBlockNotFound,
      maxAttempts: 11,
      retryDelayMs: 100,
    });
    log("info", "bundle_stage_timing", {
      stage: "target_block_availability",
      durationMs:
        performance.now() - targetBlockWaitStartedAt,
      targetBlock: privateTargetBlock.toString(),
      targetHeadSource,
      blockReadAttempts: targetBlockRead.attempts,
      blockAvailabilityWaitMs: targetBlockRead.waitedMs,
    });
  }

  const receiptResults = await Promise.all(
    submitted.map(async (submission, index) => {
      const batchFields =
        privateTargetBlock !== undefined &&
        submitted.length > 1
          ? {
              batchTransactionCount: submitted.length,
              batchPosition: index + 1,
              batchTargetBlock: privateTargetBlock.toString(),
            }
          : {};
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
        let firmAccounting: FirmReceiptAccounting | undefined;
        if (
          successful &&
          submission.request.kind === "firm_replenish"
        ) {
          const request = submission.request;
          const metadataComplete =
            request.firmAccount !== undefined &&
            request.firmReplenisher !== undefined &&
            request.firmFixedDeficit !== undefined &&
            request.firmReplenishmentCostDola !== undefined &&
            request.firmDolaReward !== undefined &&
            request.firmDolaBalanceBefore !== undefined;
          if (!metadataComplete) {
            firmAccounting = {
              valid: false,
              reason: "receipt_metadata_missing",
              fixedDeficit: request.firmFixedDeficit ?? 0n,
              replenishmentCostDola:
                request.firmReplenishmentCostDola ?? 0n,
              replenisherRewardDola:
                request.firmDolaReward ?? 0n,
              dolaBalanceDelta: 0n,
            };
          } else {
            try {
              const dolaBalanceAfter =
                await context.publicClient.readContract({
                  address: FIRM_DOLA_ADDRESS,
                  abi: erc20Abi,
                  functionName: "balanceOf",
                  args: [request.firmReplenisher!],
                  blockNumber: receipt.blockNumber,
                });
              firmAccounting = accountFirmReceipt({
                logs: receipt.logs,
                market: request.target,
                account: request.firmAccount!,
                replenisher: request.firmReplenisher!,
                fixedDeficit: request.firmFixedDeficit!,
                expectedReplenishmentCostDola:
                  request.firmReplenishmentCostDola!,
                expectedReplenisherRewardDola:
                  request.firmDolaReward!,
                dolaBalanceBefore: request.firmDolaBalanceBefore!,
                dolaBalanceAfter,
              });
            } catch (error) {
              firmAccounting = {
                valid: false,
                reason: `balance_read_failed:${errorMessage(error)}`,
                fixedDeficit: request.firmFixedDeficit!,
                replenishmentCostDola:
                  request.firmReplenishmentCostDola!,
                replenisherRewardDola: request.firmDolaReward!,
                dolaBalanceDelta: 0n,
              };
            }
          }
          if (!firmAccounting.valid) {
            log("warn", "firm_replenish_accounting_failed", {
              kind: request.kind,
              label: request.label,
              hash: submission.hash,
              market: request.target,
              account: request.firmAccount ?? "",
              replenisher: request.firmReplenisher ?? "",
              expectedFixedDeficit:
                request.firmFixedDeficit?.toString() ?? "",
              expectedReplenishmentCostDola:
                request.firmReplenishmentCostDola?.toString() ?? "",
              expectedDolaReward:
                request.firmDolaReward?.toString() ?? "",
              dolaBalanceDelta:
                firmAccounting.dolaBalanceDelta.toString(),
              reason: firmAccounting.reason ?? "unknown",
            });
          }
        }
        const paidReward = successful
          ? actualJobReward(
              submission.request,
              receipt.logs,
              firmAccounting,
            )
          : 0n;
        const paidStakeDaoCrv = successful
          ? actualStakeDaoCrvReward(
              submission.request,
              receipt.logs,
            )
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
          ...(submission.request.kind ===
          "stakedao_curve_harvest"
            ? {
                paidTokenReward:
                  `${formatUnits(paidStakeDaoCrv, 18)} CRV`,
              }
            : {}),
          ...(submission.request.kind === "firm_replenish"
            ? {
                paidTokenReward:
                  `${formatUnits(
                    firmAccounting?.valid === true
                      ? firmAccounting.replenisherRewardDola
                      : 0n,
                    18,
                  )} DOLA`,
                fixedObservedDeficit:
                  submission.request.firmFixedDeficit?.toString() ??
                  "",
                firmMarket: submission.request.target,
                firmAccount:
                  submission.request.firmAccount ?? "",
                firmReplenisher:
                  submission.request.firmReplenisher ?? "",
                firmReplenishmentCostDola:
                  submission.request.firmReplenishmentCostDola?.toString() ??
                  "",
                firmDolaReward:
                  submission.request.firmDolaReward?.toString() ??
                  "",
                firmAccountingValid:
                  firmAccounting?.valid ?? false,
                dolaBalanceDelta:
                  firmAccounting?.dolaBalanceDelta.toString() ?? "0",
              }
            : {}),
          gasCost: eth(gasCost),
          realizedProfit: eth(paidReward - gasCost),
          ...batchFields,
        });
        return {
          outcome: "confirmed" as const,
          successful,
          paidReward,
          gasCost,
          blockNumber: receipt.blockNumber,
        };
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
            ...batchFields,
          },
        );
        return {
          outcome: "expired" as const,
          successful: false,
          paidReward: 0n,
          gasCost: 0n,
        };
      }
    }),
  );

  if (
    privateTargetBlock !== undefined &&
    submitted.length > 1
  ) {
    const confirmedResults = receiptResults.filter(
      (result) => result.outcome === "confirmed",
    );
    const confirmedTransactions = confirmedResults.filter(
      (result) => result.successful,
    ).length;
    const revertedTransactions =
      confirmedResults.length - confirmedTransactions;
    const expiredTransactions =
      receiptResults.length - confirmedResults.length;
    const totalReward = receiptResults.reduce(
      (total, result) => total + result.paidReward,
      0n,
    );
    const totalGasCost = receiptResults.reduce(
      (total, result) => total + result.gasCost,
      0n,
    );
    const receiptBlock = confirmedResults.find(
      (result) => result.blockNumber !== undefined,
    )?.blockNumber;
    log(
      revertedTransactions > 0 ? "warn" : "info",
      "keeper_batch_result",
      {
        kinds: JSON.stringify(
          submitted.map(({ request }) => request.kind),
        ),
        transactionCount: submitted.length,
        confirmedTransactions,
        revertedTransactions,
        expiredTransactions,
        targetBlock: privateTargetBlock.toString(),
        block: receiptBlock?.toString() ?? "",
        totalReward: eth(totalReward),
        totalGasCost: eth(totalGasCost),
        realizedProfit: eth(totalReward - totalGasCost),
        effectiveBuilderBidBps:
          batchResult?.effectiveBuilderBidBps?.toString() ?? "",
      },
    );
  }

  const orderAttempts = submitted.flatMap((submission, index) => {
    const order = submission.request.order;
    if (order === undefined) return [];
    const reward = submission.request.reward;
    if (reward.kind !== "fixed") return [];
    const effectiveBidBps =
      batchResult?.effectiveBuilderBidBps;
    return [
      {
        order,
        crankFee: reward.amountWei,
        hash: submission.hash,
        included: receiptResults[index]?.successful ?? false,
        ...(effectiveBidBps === undefined
          ? {}
          : { effectiveBidBps }),
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

  const confirmed = receiptResults.filter(
    (result) => result.successful,
  ).length;
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
