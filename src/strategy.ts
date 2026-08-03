import {
  BaseError,
  BlockNotFoundError,
  ContractFunctionRevertedError,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  isAddressEqual,
  keccak256,
  RpcRequestError,
  TransactionReceiptNotFoundError,
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
  groupPullAbi,
  liquityPriceFeedAbi,
  liquityTroveManagerAbi,
  liveBidAdapterAbi,
  multicall3BalanceAbi,
  poolAbi,
  poolV2Abi,
  stakeDaoAccountantAbi,
  standingOrderAbi,
  standingOrderV2Abi,
  vaultFactoryAbi,
} from "./abi.js";
import { nextBlockBaseFeePerGas } from "./base-fee.js";
import {
  effectiveBuilderBidBps,
  quoteCompetitiveFees,
  selectMostProfitablePrefix,
} from "./bidding.js";
import { mapConcurrent } from "./concurrency.js";
import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
  type KeeperConfig,
} from "./config.js";
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
  selectMostProfitableEstimatedPrefix,
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
import { planGroupPullJob } from "./group-pull.js";
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
  readPullPoolV2Routing,
  type PullPoolV2RoundSnapshot,
} from "./pull-pool-v2.js";
import {
  conservativeCrvToEthWei,
  conservativeStakeDaoHarvesterFee,
  discoverStakeDaoCurveGauges,
  isFreshChainlinkRound,
  stakeDaoGaugePrefixes,
} from "./stakedao.js";
import {
  encodeStandingOrderBatchExecution,
  SINGLETON_FACTORY_ADDRESS,
  SINGLETON_FACTORY_CODE_HASH,
  STANDING_ORDER_BATCH_DEPLOY_GAS_LIMIT,
  standingOrderBatchEconomics,
  standingOrderBatchExecutorAbi,
  standingOrderBatchExecutorDeployment,
  type StandingOrderBatchMember,
} from "./standing-order-batch-executor.js";

export type KeeperJobKind =
  | "standing_order"
  | "standing_order_batch_deploy"
  | "standing_order_batch"
  | "fwa_process"
  | "pool_pull"
  | "pool_sync"
  | "pool_settle"
  | "pool_settle_forced_eth"
  | "group_pull_close"
  | "group_pull_submit"
  | "group_pull_collect"
  | "fwa_buyback"
  | "live_bid_sweep"
  | "liquity_liquidation"
  | "convex_earmark"
  | "convex_kick"
  | "stakedao_curve_harvest"
  | "firm_replenish"
  | "builder_payment";

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
  readonly poolVersion?: KeeperConfig["poolVersion"];
  readonly configuredBuilderBidBps?: bigint;
  readonly poolBuilderBidPolicy?: PoolBuilderBidPolicy;
  readonly requiresBundleSimulation?: boolean;
  readonly order?: Address;
  readonly standingOrderBatchMembers?: readonly (
    StandingOrderBatchMember & {
      readonly poolVersion: KeeperConfig["poolVersion"];
    }
  )[];
  readonly embeddedGrossReward?: bigint;
  readonly embeddedBuilderPayment?: bigint;
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
  readonly value?: bigint;
}

export interface KeeperBatchResult {
  readonly hashes: readonly Hash[];
  readonly acceptedRequests?: readonly KeeperTransactionRequest[];
  readonly targetBlock: bigint;
  readonly relayCount: number;
  readonly effectiveBuilderBidBps?: bigint;
  readonly effectiveBuilderBidBpsByOrder?: ReadonlyMap<
    string,
    bigint
  >;
  readonly plannedGrossReward?: bigint;
  readonly plannedBuilderPayment?: bigint;
  readonly plannedExpectedProfit?: bigint;
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

export interface KeeperObservedHead {
  readonly number: bigint;
  readonly hash: Hash;
  readonly timestamp: bigint;
  readonly baseFeePerGas: bigint | null;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
}

export interface PrivateNextBlockFeeQuote {
  readonly baseFeeAllowancePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/**
 * A private bundle targets only the immediate child of the subscribed head.
 * Its EIP-1559 base fee is deterministic from the complete parent header, so
 * neither a provider estimate nor a worst-case 12.5% envelope is necessary.
 */
export function privateNextBlockFeeQuote(parameters: {
  readonly parentBaseFeePerGas: bigint | null;
  readonly parentGasUsed: bigint;
  readonly parentGasLimit: bigint;
  readonly minimumPriorityFeePerGas: bigint;
}): PrivateNextBlockFeeQuote {
  if (
    parameters.parentBaseFeePerGas === null ||
    parameters.parentBaseFeePerGas <= 0n
  ) {
    throw new Error(
      "private next-block planning requires a positive parent base fee",
    );
  }
  if (parameters.minimumPriorityFeePerGas < 0n) {
    throw new Error(
      "minimum priority fee cannot be negative",
    );
  }
  const baseFeeAllowancePerGas =
    nextBlockBaseFeePerGas({
      parentBaseFeePerGas: parameters.parentBaseFeePerGas,
      parentGasUsed: parameters.parentGasUsed,
      parentGasLimit: parameters.parentGasLimit,
    });
  return {
    baseFeeAllowancePerGas,
    maxPriorityFeePerGas:
      parameters.minimumPriorityFeePerGas,
    maxFeePerGas:
      baseFeeAllowancePerGas +
      parameters.minimumPriorityFeePerGas,
  };
}

export async function resolvePlanningFeeQuote(parameters: {
  readonly submissionMode: KeeperConfig["submissionMode"];
  readonly parentBaseFeePerGas: bigint | null;
  readonly parentGasUsed?: bigint;
  readonly parentGasLimit?: bigint;
  readonly minimumPriorityFeePerGas: bigint;
  readonly readProviderFeeQuote: () => Promise<{
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
  }>;
}): Promise<
  PrivateNextBlockFeeQuote & {
    readonly source:
      | "subscribed_header_exact_next_base_fee"
      | "provider_estimate";
  }
> {
  if (parameters.submissionMode === "flashbots") {
    if (
      parameters.parentGasUsed === undefined ||
      parameters.parentGasLimit === undefined
    ) {
      throw new Error(
        "private next-block planning requires complete parent gas fields",
      );
    }
    return {
      ...privateNextBlockFeeQuote({
        parentBaseFeePerGas:
          parameters.parentBaseFeePerGas,
        parentGasUsed: parameters.parentGasUsed,
        parentGasLimit: parameters.parentGasLimit,
        minimumPriorityFeePerGas:
          parameters.minimumPriorityFeePerGas,
      }),
      source: "subscribed_header_exact_next_base_fee",
    };
  }
  const provider = await parameters.readProviderFeeQuote();
  const maxPriorityFeePerGas =
    provider.maxPriorityFeePerGas >
    parameters.minimumPriorityFeePerGas
      ? provider.maxPriorityFeePerGas
      : parameters.minimumPriorityFeePerGas;
  const maxFeePerGas =
    provider.maxFeePerGas +
    (maxPriorityFeePerGas -
      provider.maxPriorityFeePerGas);
  return {
    source: "provider_estimate",
    maxFeePerGas,
    maxPriorityFeePerGas,
    baseFeeAllowancePerGas:
      maxFeePerGas - maxPriorityFeePerGas,
  };
}

export interface PoolPullBatchOutcome {
  readonly targetBlock: bigint;
  readonly pool: Address;
  readonly poolVersion: KeeperConfig["poolVersion"];
  readonly effectiveBuilderBidBps?: bigint;
  readonly plannedGrossReward?: bigint;
  readonly plannedBuilderPayment?: bigint;
  readonly plannedExpectedProfit?: bigint;
  readonly attempts: readonly {
    readonly hash: Hash;
    readonly roundId: bigint;
    readonly included: boolean;
  }[];
}

export interface PoolLifecycleBatchOutcome {
  readonly targetBlock: bigint;
  readonly pool: Address;
  readonly poolVersion: KeeperConfig["poolVersion"];
  readonly effectiveBuilderBidBps?: bigint;
  readonly plannedGrossReward?: bigint;
  readonly plannedBuilderPayment?: bigint;
  readonly plannedExpectedProfit?: bigint;
  readonly pureSingleRoundFulfilledLifecycle: boolean;
  readonly attempts: readonly {
    readonly hash: Hash;
    readonly roundId: bigint;
    readonly kind:
      | "pool_sync"
      | "pool_settle"
      | "pool_settle_forced_eth";
    readonly bidPolicy?: PoolBuilderBidPolicy;
    readonly included: boolean;
  }[];
}

export function isPureSingleRoundFulfilledLifecycleBatch(
  requests: readonly Pick<
    KeeperJob,
    | "kind"
    | "target"
    | "poolVersion"
    | "poolBuilderBidPolicy"
    | "roundId"
  >[],
): boolean {
  const first = requests[0];
  if (
    first === undefined ||
    first.poolVersion !== "v2" ||
    first.poolBuilderBidPolicy !== "pool_fulfilled" ||
    first.roundId === undefined
  ) {
    return false;
  }
  const pool = first.target.toLowerCase();
  const roundId = first.roundId;
  let includesSync = false;
  for (const request of requests) {
    if (
      (request.kind !== "pool_sync" &&
        request.kind !== "pool_settle" &&
        request.kind !== "pool_settle_forced_eth") ||
      request.poolVersion !== "v2" ||
      request.poolBuilderBidPolicy !== "pool_fulfilled" ||
      request.roundId !== roundId ||
      request.target.toLowerCase() !== pool
    ) {
      return false;
    }
    includesSync ||= request.kind === "pool_sync";
  }
  return includesSync;
}

export interface StrategyContext {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly discoveryClient?: PublicClient<Transport, Chain>;
  readonly exactStateTransport?: "http" | "websocket";
  readonly headBlockNumber: bigint;
  readonly observedHead?: KeeperObservedHead;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly standingOrderBidBps?: (
    order: Address,
  ) => bigint;
  /**
   * Additional verified pool adapters are planned inside the same pass. The
   * promise may begin resolving before the primary planner so activation
   * monitoring does not add a serial read to the hot path.
   */
  readonly additionalPoolConfigs?:
    | readonly KeeperConfig[]
    | Promise<readonly KeeperConfig[]>;
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
  readonly observePoolPullBatch:
    | ((outcome: PoolPullBatchOutcome) => Promise<void>)
    | undefined;
  readonly observePoolLifecycleBatch?:
    | ((outcome: PoolLifecycleBatchOutcome) => Promise<void>)
    | undefined;
  /**
   * A read-only check started alongside planning and awaited before any live
   * account gate or submission. It keeps launch monitoring off the critical
   * planning path without allowing an obsolete pool version to submit.
   */
  readonly preSubmissionGate?: (() => Promise<void>) | undefined;
}

interface OrderCandidate {
  readonly address: Address;
  readonly crankFee: bigint;
  readonly ticketsPerRound: bigint;
  readonly requiresNativeBalance: boolean;
  readonly configuredPool?: Address;
  readonly lastPool?: Address;
  readonly recipient?: Address;
  readonly referrer?: Address;
  readonly minSecondsBetweenBuys?: bigint;
  readonly lastBuyAt?: bigint;
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

export interface StandingOrderBatchPlan extends PlannedJobs {
  readonly executor: Address;
  readonly deploymentIncluded: boolean;
  readonly grossReward: bigint;
  readonly builderPayment: bigint;
  readonly ownerReturn: bigint;
  readonly directExpectedProfit: bigint;
  readonly batchExpectedProfit: bigint;
  readonly expectedProfitAdvantage: bigint;
}

/**
 * A nonce-contiguous bundle can only expose prefixes. Put lower-competition
 * standalone orders first so a contested suffix cannot invalidate otherwise
 * winnable work. Equal-price orders retain profit-first ordering.
 */
export function orderStandaloneStandingJobsForAuction(parameters: {
  readonly jobs: readonly KeeperJob[];
  readonly bidBps: (order: Address) => bigint;
  readonly maxFeePerGas: bigint;
}): readonly KeeperJob[] {
  if (
    parameters.jobs.length < 2 ||
    parameters.jobs.some(
      (job) =>
        job.kind !== "standing_order" ||
        job.order === undefined ||
        job.reward.kind !== "fixed",
    )
  ) {
    return parameters.jobs;
  }
  return [...parameters.jobs].sort((left, right) => {
    const leftBid = parameters.bidBps(left.order!);
    const rightBid = parameters.bidBps(right.order!);
    if (leftBid !== rightBid) return leftBid < rightBid ? -1 : 1;
    const leftReward =
      left.reward.kind === "fixed" ? left.reward.amountWei : 0n;
    const rightReward =
      right.reward.kind === "fixed" ? right.reward.amountWei : 0n;
    const leftProfit =
      leftReward - left.gas * parameters.maxFeePerGas;
    const rightProfit =
      rightReward - right.gas * parameters.maxFeePerGas;
    if (leftProfit !== rightProfit) {
      return leftProfit > rightProfit ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });
}

export async function planStandingOrderBatch(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly executionGasPrice: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minimumPriorityFeePerGas: bigint;
  readonly maxFeePerGasCap: bigint;
  readonly minProfitWei: bigint;
  readonly bidBps: (order: Address) => bigint;
  readonly plan: PlannedJobs;
}): Promise<StandingOrderBatchPlan | undefined> {
  if (
    parameters.plan.jobs.length < 2 ||
    parameters.plan.jobs.length > 64 ||
    parameters.plan.jobs.some(
      (job) =>
        job.kind !== "standing_order" ||
        job.order === undefined ||
        job.reward.kind !== "fixed",
    )
  ) {
    return undefined;
  }
  const members = parameters.plan.jobs.map((job) => ({
    order: job.order!,
    crankFee:
      job.reward.kind === "fixed"
        ? job.reward.amountWei
        : 0n,
    builderBidBps: parameters.bidBps(job.order!),
    poolVersion: job.poolVersion ?? "v1",
  }));
  const economics = standingOrderBatchEconomics(members);
  const profitFloor = requiredProfit(parameters.minProfitWei);
  if (economics.ownerReturn <= profitFloor) return undefined;
  const directSelection = selectMostProfitablePrefix({
    components: parameters.plan.jobs.map((job, index) => ({
      rewardWei:
        job.reward.kind === "fixed" ? job.reward.amountWei : 0n,
      gasUsed: job.gas,
      builderBidBps: members[index]!.builderBidBps,
      minimumPriorityFeePerGas:
        parameters.minimumPriorityFeePerGas,
    })),
    minimumViablePrefix: parameters.plan.minimumViablePrefix,
    baseFeeAllowancePerGas: parameters.executionGasPrice,
    maxFeePerGasCap: parameters.maxFeePerGasCap,
    minProfitWei: parameters.minProfitWei,
  });
  const directExpectedProfit =
    directSelection?.quote.expectedProfit ?? 0n;

  const accountAddress =
    typeof parameters.account === "string"
      ? parameters.account
      : parameters.account.address;
  const deployment =
    standingOrderBatchExecutorDeployment(accountAddress);
  const code = await parameters.client.getCode({
    address: deployment.address,
    blockNumber: parameters.blockNumber,
  });
  const executorDeployed = code !== undefined && code !== "0x";
  const metadata = {
    standingOrderBatchMembers: members,
    embeddedGrossReward: economics.grossReward,
    embeddedBuilderPayment: economics.builderPayment,
  } as const;

  if (executorDeployed) {
    if (keccak256(code) !== deployment.expectedRuntimeCodeHash) {
      throw new Error(
        `standing-order batch executor runtime mismatch at ${deployment.address}`,
      );
    }
    let minimumOwnerReturn = 1n;
    let data = encodeStandingOrderBatchExecution(
      members,
      minimumOwnerReturn,
    );
    let estimatedGas = await parameters.client.estimateGas({
      account: parameters.account,
      to: deployment.address,
      data,
      blockNumber: parameters.blockNumber,
    });
    let gas = bufferedGas(
      estimatedGas,
      parameters.gasLimitMultiplierBps,
    );
    minimumOwnerReturn =
      gas * parameters.executionGasPrice + profitFloor;
    if (economics.ownerReturn < minimumOwnerReturn) {
      return undefined;
    }
    data = encodeStandingOrderBatchExecution(
      members,
      minimumOwnerReturn,
    );
    estimatedGas = await parameters.client.estimateGas({
      account: parameters.account,
      to: deployment.address,
      data,
      blockNumber: parameters.blockNumber,
    });
    gas = bufferedGas(
      estimatedGas,
      parameters.gasLimitMultiplierBps,
    );
    const finalMinimumOwnerReturn =
      gas * parameters.executionGasPrice + profitFloor;
    if (economics.ownerReturn < finalMinimumOwnerReturn) {
      return undefined;
    }
    if (finalMinimumOwnerReturn !== minimumOwnerReturn) {
      minimumOwnerReturn = finalMinimumOwnerReturn;
      data = encodeStandingOrderBatchExecution(
        members,
        minimumOwnerReturn,
      );
    }
    const batchExpectedProfit =
      economics.ownerReturn - gas * parameters.executionGasPrice;
    if (batchExpectedProfit <= directExpectedProfit) {
      return undefined;
    }
    return {
      jobs: [
        {
          kind: "standing_order_batch",
          label: `standing_order_batch:${members.length}`,
          target: deployment.address,
          data,
          gas,
          reward: {
            kind: "fixed",
            amountWei: economics.ownerReturn,
          },
          ...metadata,
        },
      ],
      minimumViablePrefix: 1,
      orders: parameters.plan.orders,
      skipped: parameters.plan.skipped,
      executor: deployment.address,
      deploymentIncluded: false,
      directExpectedProfit,
      batchExpectedProfit,
      expectedProfitAdvantage:
        batchExpectedProfit - directExpectedProfit,
      ...economics,
    };
  }

  const singletonCode = await parameters.client.getCode({
    address: SINGLETON_FACTORY_ADDRESS,
    blockNumber: parameters.blockNumber,
  });
  if (
    singletonCode === undefined ||
    singletonCode === "0x" ||
    keccak256(singletonCode) !== SINGLETON_FACTORY_CODE_HASH
  ) {
    throw new Error("singleton factory runtime does not match pinned code");
  }
  const requestedExecutionGas =
    parameters.plan.jobs.reduce(
      (total, job) => total + job.gas,
      200_000n,
    );
  const maximumExecutionGas = BigInt(
    ETHEREUM_TRANSACTION_GAS_LIMIT,
  );
  const executionGas =
    requestedExecutionGas < maximumExecutionGas
      ? requestedExecutionGas
      : maximumExecutionGas;
  const minimumOwnerReturn =
    (STANDING_ORDER_BATCH_DEPLOY_GAS_LIMIT + executionGas) *
      parameters.executionGasPrice +
    profitFloor;
  if (economics.ownerReturn < minimumOwnerReturn) {
    return undefined;
  }
  const batchExpectedProfit =
    economics.ownerReturn -
    (STANDING_ORDER_BATCH_DEPLOY_GAS_LIMIT + executionGas) *
      parameters.executionGasPrice;
  if (batchExpectedProfit <= directExpectedProfit) {
    return undefined;
  }
  return {
    jobs: [
      {
        kind: "standing_order_batch_deploy",
        label: "standing_order_batch_executor_deploy",
        target: SINGLETON_FACTORY_ADDRESS,
        data: deployment.deployData,
        gas: STANDING_ORDER_BATCH_DEPLOY_GAS_LIMIT,
        reward: { kind: "fixed", amountWei: 0n },
        requiresBundleSimulation: true,
      },
      {
        kind: "standing_order_batch",
        label: `standing_order_batch:${members.length}`,
        target: deployment.address,
        data: encodeStandingOrderBatchExecution(
          members,
          minimumOwnerReturn,
        ),
        gas: executionGas,
        reward: {
          kind: "fixed",
          amountWei: economics.ownerReturn,
        },
        requiresBundleSimulation: true,
        ...metadata,
      },
    ],
    minimumViablePrefix: 2,
    orders: parameters.plan.orders,
    skipped: parameters.plan.skipped,
    executor: deployment.address,
    deploymentIncluded: true,
    directExpectedProfit,
    batchExpectedProfit,
    expectedProfitAdvantage:
      batchExpectedProfit - directExpectedProfit,
    ...economics,
  };
}

const lastKnownOrderCountByFactory = new Map<string, number>();
const cachedOrderCandidatesByFactory = new Map<
  string,
  readonly OrderCandidate[]
>();
const LIFECYCLE_FUNDING_CANDIDATE_LIMIT = 12;
const LIFECYCLE_FUNDING_WAIT_MS = 75;

function orderRegistryCacheKey(config: KeeperConfig): string {
  return config.orderFactoryAddresses
    .map((address) => address.toLowerCase())
    .sort()
    .join(":");
}

export async function readOrderFactoryOrders(
  client: PublicClient<Transport, Chain>,
  factoryAddresses: readonly Address[],
  blockNumber: bigint,
): Promise<readonly Address[]> {
  const ordersByFactory = await Promise.all(
    factoryAddresses.map((factoryAddress) =>
      client.readContract({
        address: factoryAddress,
        abi: factoryAbi,
        functionName: "allOrders",
        blockNumber,
      }),
    ),
  );
  const unique = new Map<string, Address>();
  for (const address of ordersByFactory.flat()) {
    unique.set(address.toLowerCase(), address);
  }
  return [...unique.values()];
}

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

function fromPullPoolV2Round(
  round: PullPoolV2RoundSnapshot,
): PoolRoundSnapshot {
  return {
    ticketPrice: round.ticketPrice,
    crankBountyCap: round.crankBountyCap,
    bountyTipWei: round.bountyTipWei,
    fwaRequestId: round.fwaRequestId,
    state: round.state,
  };
}

interface ConvexPool {
  readonly pid: bigint;
  readonly gauge: Address;
}

interface ConvexCandidateSnapshot {
  readonly requestedAtBlock: bigint;
  readonly poolsScanned: number;
  readonly candidateEstimateAttempts: number;
  readonly crvChangeExcluded: number;
  readonly staker: Address;
  readonly pools: readonly ConvexPool[];
}

interface ConvexPoolRegistrySnapshot {
  readonly requestedAtBlock: bigint;
  readonly pools: readonly ConvexPool[];
}

interface ConvexKickCandidateSnapshot {
  readonly requestedAtBlock: bigint;
  readonly candidatesScanned: number;
  readonly unlockableCandidates: number;
  readonly balanceReadFailures: number;
  readonly noExpiredLocksExcluded: number;
  readonly candidates: readonly Address[];
}

let convexPoolRegistrySnapshot: ConvexPoolRegistrySnapshot | undefined;
let convexCandidateSnapshot: ConvexCandidateSnapshot | undefined;
let convexCandidateRefreshPromise: Promise<void> | undefined;
let convexKickCandidateSnapshot:
  | ConvexKickCandidateSnapshot
  | undefined;
let convexKickCandidateRefreshPromise: Promise<void> | undefined;
const CONVEX_CANDIDATE_CACHE_SIZE = 32;
const CONVEX_CANDIDATE_REFRESH_BLOCKS = 4n;
const CONVEX_KICK_CANDIDATE_REFRESH_BLOCKS = 4n;
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
  readonly account: Account | Address;
  readonly simulationConcurrency: number;
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
    pools.length,
  );
  let crvChangeExcluded = 0;
  let candidateEstimateAttempts = 0;
  const executableAtSnapshot: ConvexPool[] = [];
  for (
    let offset = 0;
    offset < indexes.length &&
    executableAtSnapshot.length < CONVEX_CANDIDATE_CACHE_SIZE;
    offset += CONVEX_CANDIDATE_CACHE_SIZE
  ) {
    const candidateBatch = indexes
      .slice(offset, offset + CONVEX_CANDIDATE_CACHE_SIZE)
      .flatMap((index) => {
        const pool = pools[index];
        return pool === undefined ? [] : [pool];
      });
    candidateEstimateAttempts += candidateBatch.length;
    const batchResults = await mapConcurrent(
      candidateBatch,
      parameters.simulationConcurrency,
      async (pool): Promise<ConvexPool | undefined> => {
        try {
          await parameters.client.estimateContractGas({
            account: parameters.account,
            address: CONVEX_BOOSTER_ADDRESS,
            abi: convexBoosterAbi,
            functionName: "earmarkRewards",
            args: [pool.pid],
            blockNumber: parameters.requestedAtBlock,
          });
          return pool;
        } catch (error) {
          if (isConvexCrvChangeRevert(error)) {
            crvChangeExcluded += 1;
            return undefined;
          }
          return pool;
        }
      },
    );
    executableAtSnapshot.push(
      ...batchResults.filter(
        (pool): pool is ConvexPool => pool !== undefined,
      ),
    );
  }
  return {
    requestedAtBlock: parameters.requestedAtBlock,
    poolsScanned: pools.length,
    candidateEstimateAttempts,
    crvChangeExcluded,
    staker,
    pools: executableAtSnapshot.slice(
      0,
      CONVEX_CANDIDATE_CACHE_SIZE,
    ),
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

async function loadConvexKickCandidateSnapshot(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly simulationConcurrency: number;
  readonly requestedAtBlock: bigint;
}): Promise<ConvexKickCandidateSnapshot> {
  const balanceResults = await parameters.client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    blockNumber: parameters.requestedAtBlock,
    contracts: CONVEX_KICK_CANDIDATES.map((candidate) => ({
      address: CONVEX_LOCKER_ADDRESS,
      abi: convexLockerAbi,
      functionName: "lockedBalances" as const,
      args: [candidate] as const,
    })),
  });
  let unlockableCandidates = 0;
  let balanceReadFailures = 0;
  const candidates = CONVEX_KICK_CANDIDATES.filter(
    (_candidate, index) => {
      const result = balanceResults[index];
      if (result?.status !== "success") {
        balanceReadFailures += 1;
        return true;
      }
      if (result.result[1] === 0n) return false;
      unlockableCandidates += 1;
      return true;
    },
  );
  let noExpiredLocksExcluded = 0;
  const estimateResults = await mapConcurrent(
    candidates,
    parameters.simulationConcurrency,
    async (candidate): Promise<Address | undefined> => {
      try {
        await parameters.client.estimateContractGas({
          account: parameters.account,
          address: CONVEX_LOCKER_ADDRESS,
          abi: convexLockerAbi,
          functionName: "kickExpiredLocks",
          args: [candidate],
          blockNumber: parameters.requestedAtBlock,
        });
        return candidate;
      } catch (error) {
        if (isConvexNoExpiredLocksRevert(error)) {
          noExpiredLocksExcluded += 1;
          return undefined;
        }
        return candidate;
      }
    },
  );
  return {
    requestedAtBlock: parameters.requestedAtBlock,
    candidatesScanned: CONVEX_KICK_CANDIDATES.length,
    unlockableCandidates,
    balanceReadFailures,
    noExpiredLocksExcluded,
    candidates: estimateResults.filter(
      (candidate): candidate is Address =>
        candidate !== undefined,
    ),
  };
}

function getConvexKickCandidateAccounts(parameters: {
  readonly headBlockNumber: bigint;
}): ConvexKickCandidateSnapshot | undefined {
  const snapshot = convexKickCandidateSnapshot;
  if (
    snapshot === undefined ||
    snapshot.requestedAtBlock > parameters.headBlockNumber
  ) {
    return undefined;
  }
  return snapshot;
}

interface ColdPlannerRefreshParameters {
  readonly discoveryClient: PublicClient<Transport, Chain>;
  readonly config: KeeperConfig;
  readonly headBlockNumber: bigint;
}

function scheduleConvexEarmarkRefresh(
  parameters: ColdPlannerRefreshParameters,
): void {
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
    account: parameters.config.simulationAccount,
    simulationConcurrency:
      parameters.config.simulationConcurrency,
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
        candidateEstimateAttempts:
          nextSnapshot.candidateEstimateAttempts,
        crvChangeExcluded: nextSnapshot.crvChangeExcluded,
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

function scheduleConvexKickRefresh(
  parameters: ColdPlannerRefreshParameters,
): void {
  if (
    !parameters.config.enableConvexKicks ||
    convexKickCandidateRefreshPromise !== undefined
  ) {
    return;
  }
  const snapshot = convexKickCandidateSnapshot;
  if (
    snapshot !== undefined &&
    parameters.headBlockNumber >= snapshot.requestedAtBlock &&
    parameters.headBlockNumber - snapshot.requestedAtBlock <
      CONVEX_KICK_CANDIDATE_REFRESH_BLOCKS
  ) {
    return;
  }
  const requestedAtBlock = parameters.headBlockNumber;
  const startedAt = performance.now();
  const refresh = loadConvexKickCandidateSnapshot({
    client: parameters.discoveryClient,
    account: parameters.config.simulationAccount,
    simulationConcurrency:
      parameters.config.simulationConcurrency,
    requestedAtBlock,
  })
    .then((nextSnapshot) => {
      if (
        convexKickCandidateSnapshot === undefined ||
        nextSnapshot.requestedAtBlock >=
          convexKickCandidateSnapshot.requestedAtBlock
      ) {
        convexKickCandidateSnapshot = nextSnapshot;
      }
      log("info", "convex_kick_candidate_cache_refreshed", {
        requestedAtBlock: nextSnapshot.requestedAtBlock.toString(),
        candidatesScanned: nextSnapshot.candidatesScanned,
        unlockableCandidates:
          nextSnapshot.unlockableCandidates,
        balanceReadFailures:
          nextSnapshot.balanceReadFailures,
        noExpiredLocksExcluded:
          nextSnapshot.noExpiredLocksExcluded,
        candidates: nextSnapshot.candidates.length,
        durationMs: performance.now() - startedAt,
      });
    })
    .catch((error: unknown) => {
      log("warn", "convex_kick_candidate_cache_refresh_failed", {
        requestedAtBlock: requestedAtBlock.toString(),
        durationMs: performance.now() - startedAt,
        reason: errorMessage(error),
      });
    });
  const tracked = refresh.finally(() => {
    if (convexKickCandidateRefreshPromise === tracked) {
      convexKickCandidateRefreshPromise = undefined;
    }
  });
  convexKickCandidateRefreshPromise = tracked;
}

export function scheduleColdPlannerRefresh(
  parameters: ColdPlannerRefreshParameters,
): void {
  scheduleConvexEarmarkRefresh(parameters);
  scheduleConvexKickRefresh(parameters);
}

async function getRoundSnapshot(
  client: PublicClient<Transport, Chain>,
  pool: Address,
  roundId: bigint,
  poolVersion: KeeperConfig["poolVersion"],
  blockNumber?: bigint,
): Promise<PoolRoundSnapshot> {
  const round =
    poolVersion === "v2"
      ? await client.readContract({
          address: pool,
          abi: poolV2Abi,
          functionName: "getRound",
          args: [roundId],
          ...(blockNumber === undefined ? {} : { blockNumber }),
        })
      : await client.readContract({
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

function contractRevertReason(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(
    (candidate) => candidate instanceof ContractFunctionRevertedError,
  );
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  return reverted.reason;
}

export function isConvexCrvChangeRevert(error: unknown): boolean {
  return contractRevertReason(error) === "crvChange";
}

export function isConvexNoExpiredLocksRevert(error: unknown): boolean {
  return contractRevertReason(error) === "no exp locks";
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
  const invalidInput = error.walk(
    (candidate) => candidate instanceof InvalidInputRpcError,
  );
  if (invalidInput instanceof InvalidInputRpcError) return true;
  const providerError = error.walk(
    (candidate) =>
      candidate instanceof InvalidParamsRpcError ||
      (candidate instanceof RpcRequestError &&
        candidate.code === InvalidParamsRpcError.code),
  );
  if (!(providerError instanceof BaseError)) return false;
  const details = providerError.details ?? "";
  return (
    /^Missing or invalid parameters\.?$/i.test(details) ||
    /^Invalid parameters were provided to the RPC method\.?$/i.test(
      details,
    )
  );
}

export function isFreshBlockReadUnavailable(
  error: unknown,
): boolean {
  return (
    isBlockNotFound(error) ||
    isFreshBlockStateUnavailable(error)
  );
}

export function isTransactionReceiptTemporarilyUnavailable(
  error: unknown,
): boolean {
  if (error instanceof TransactionReceiptNotFoundError) return true;
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (candidate) =>
        candidate instanceof TransactionReceiptNotFoundError,
    ) instanceof TransactionReceiptNotFoundError
  );
}

export async function readPublishedTransactionReceipt<Receipt>(
  read: () => Promise<Receipt>,
): Promise<{
  readonly value: Receipt;
  readonly attempts: number;
  readonly waitedMs: number;
}> {
  return retryTransientRead({
    read,
    shouldRetry:
      isTransactionReceiptTemporarilyUnavailable,
    maxAttempts: 11,
    retryDelayMs: 100,
  });
}

export async function resolvePlanningHead(parameters: {
  readonly headBlockNumber: bigint;
  readonly observedHead?: KeeperObservedHead;
  readonly readExactBlock: () => Promise<KeeperObservedHead>;
}): Promise<{
  readonly value: KeeperObservedHead;
  readonly attempts: number;
  readonly waitedMs: number;
  readonly source:
    | "websocket_subscription"
    | "http_exact_block";
}> {
  if (
    parameters.observedHead !== undefined &&
    parameters.observedHead.number !==
      parameters.headBlockNumber
  ) {
    throw new Error(
      `observed head ${parameters.observedHead.number} does not match planning block ${parameters.headBlockNumber}`,
    );
  }
  if (parameters.observedHead !== undefined) {
    return {
      value: parameters.observedHead,
      attempts: 0,
      waitedMs: 0,
      source: "websocket_subscription",
    };
  }
  const read = await retryTransientRead({
    read: parameters.readExactBlock,
    shouldRetry: isFreshBlockReadUnavailable,
    maxAttempts: 11,
    retryDelayMs: 100,
  });
  return {
    ...read,
    source: "http_exact_block",
  };
}

async function getOrderCandidates(
  client: PublicClient<Transport, Chain>,
  config: KeeperConfig,
  blockNumber: bigint,
): Promise<OrderCandidate[]> {
  const vaultFactoryAddress = config.enableVaults
    ? config.vaultFactoryAddress
    : undefined;
  const [orders, vaults] = await Promise.all([
    readOrderFactoryOrders(
      client,
      config.orderFactoryAddresses,
      blockNumber,
    ),
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
  const [
    feeResults,
    ticketResults,
    poolResults,
    recipientResults,
    referrerResults,
    intervalResults,
    lastBuyAtResults,
    lastPoolResults,
  ] = await Promise.all([
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
    config.poolVersion === "v2"
      ? client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: subscriptions.map((address) => ({
            address,
            abi: standingOrderV2Abi,
            functionName: "pool" as const,
          })),
        })
      : Promise.resolve([]),
    config.poolVersion === "v2"
      ? client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: subscriptions.map((address) => ({
            address,
            abi: standingOrderV2Abi,
            functionName: "recipient" as const,
          })),
        })
      : Promise.resolve([]),
    config.poolVersion === "v2"
      ? client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: subscriptions.map((address) => ({
            address,
            abi: standingOrderV2Abi,
            functionName: "REFERRER" as const,
          })),
        })
      : Promise.resolve([]),
    config.poolVersion === "v2"
      ? client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: subscriptions.map((address) => ({
            address,
            abi: standingOrderV2Abi,
            functionName: "minSecondsBetweenBuys" as const,
          })),
        })
      : Promise.resolve([]),
    config.poolVersion === "v2"
      ? client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: subscriptions.map((address) => ({
            address,
            abi: standingOrderV2Abi,
            functionName: "lastBuyAt" as const,
          })),
        })
      : Promise.resolve([]),
    config.poolVersion === "v2"
      ? client.multicall({
          allowFailure: true,
          blockNumber,
          contracts: subscriptions.map((address) => ({
            address,
            abi: standingOrderV2Abi,
            functionName: "lastPool" as const,
          })),
        })
      : Promise.resolve([]),
  ]);

  const candidates: OrderCandidate[] = [];
  for (let index = 0; index < subscriptions.length; index += 1) {
    const address = subscriptions[index];
    const fee = feeResults[index];
    const tickets = ticketResults[index];
    const configuredPool = poolResults[index];
    const recipient = recipientResults[index];
    const referrer = referrerResults[index];
    const interval = intervalResults[index];
    const lastBuyAt = lastBuyAtResults[index];
    const lastPool = lastPoolResults[index];
    if (
      address === undefined ||
      fee?.status !== "success" ||
      tickets?.status !== "success"
    ) {
      continue;
    }
    const base = {
      address,
      crankFee: fee.result,
      ticketsPerRound: BigInt(tickets.result),
      requiresNativeBalance: standingOrders.has(
        address.toLowerCase(),
      ),
    } satisfies OrderCandidate;
    if (config.poolVersion !== "v2") {
      candidates.push(base);
      continue;
    }
    if (
      configuredPool?.status === "success" &&
      getAddress(configuredPool.result) ===
        config.expectedPoolAddress &&
      recipient?.status === "success" &&
      referrer?.status === "success" &&
      interval?.status === "success" &&
      lastBuyAt?.status === "success" &&
      lastPool?.status === "success"
    ) {
      candidates.push({
        ...base,
        configuredPool: getAddress(configuredPool.result),
        recipient: getAddress(recipient.result),
        referrer: getAddress(referrer.result),
        minSecondsBetweenBuys: interval.result,
        lastBuyAt: lastBuyAt.result,
        lastPool: getAddress(lastPool.result),
      });
    }
  }
  const sorted = candidates.sort((a, b) => {
    if (a.crankFee === b.crankFee) {
      return a.address.localeCompare(b.address);
    }
    return a.crankFee > b.crankFee ? -1 : 1;
  });
  cachedOrderCandidatesByFactory.set(
    orderRegistryCacheKey(config),
    sorted,
  );
  return sorted;
}

async function refreshCachedOrderCandidates(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly config: KeeperConfig;
  readonly candidates: readonly OrderCandidate[];
  readonly blockNumber: bigint;
}): Promise<readonly OrderCandidate[]> {
  if (parameters.candidates.length === 0) return [];
  const [feeResults, ticketResults, poolResults, lastPoolResults] =
    await Promise.all([
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
      parameters.config.poolVersion === "v2"
        ? parameters.client.multicall({
            allowFailure: true,
            blockNumber: parameters.blockNumber,
            contracts: parameters.candidates.map((candidate) => ({
              address: candidate.address,
              abi: standingOrderV2Abi,
              functionName: "pool" as const,
            })),
          })
        : Promise.resolve([]),
      parameters.config.poolVersion === "v2"
        ? parameters.client.multicall({
            allowFailure: true,
            blockNumber: parameters.blockNumber,
            contracts: parameters.candidates.map((candidate) => ({
              address: candidate.address,
              abi: standingOrderV2Abi,
              functionName: "lastPool" as const,
            })),
          })
        : Promise.resolve([]),
    ]);
  return parameters.candidates.flatMap((candidate, index) => {
    const fee = feeResults[index];
    const tickets = ticketResults[index];
    const configuredPool = poolResults[index];
    const lastPool = lastPoolResults[index];
    if (
      fee?.status !== "success" ||
      tickets?.status !== "success"
    ) {
      return [];
    }
    if (parameters.config.poolVersion === "v2") {
      if (
        configuredPool?.status !== "success" ||
        lastPool?.status !== "success" ||
        getAddress(configuredPool.result) !==
          parameters.config.expectedPoolAddress
      ) {
        return [];
      }
      return [
        {
          ...candidate,
          crankFee: fee.result,
          ticketsPerRound: BigInt(tickets.result),
          configuredPool: getAddress(configuredPool.result),
          lastPool: getAddress(lastPool.result),
        },
      ];
    }
    return [
      {
        ...candidate,
        crankFee: fee.result,
        ticketsPerRound: BigInt(tickets.result),
      },
    ];
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
      orderAlreadyBought(
        lastRound.result,
        parameters.roundId,
        parameters.config.poolVersion === "v2" &&
          candidate.lastPool !== undefined &&
          candidate.configuredPool !== undefined
          ? {
              lastPool: candidate.lastPool,
              activePool: candidate.configuredPool,
            }
          : undefined,
      )
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
  poolScope?: {
    readonly lastPool: Address;
    readonly activePool: Address;
  },
): boolean {
  if (lastRoundBought < 0n || roundId < 0n) {
    throw new Error("order round identifiers cannot be negative");
  }
  if (poolScope !== undefined) {
    return (
      isAddressEqual(poolScope.lastPool, poolScope.activePool) &&
      lastRoundBought === roundId
    );
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

function orderJob(
  order: EligibleOrder,
  config: KeeperConfig,
): KeeperJob {
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
    poolVersion: config.poolVersion,
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
  readonly config: KeeperConfig;
  readonly requiresBundleSimulation?: boolean;
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
    poolVersion: parameters.config.poolVersion,
    configuredBuilderBidBps:
      parameters.bidPolicy === "pool_pull"
        ? parameters.config.poolPullBuilderBidBps
        : parameters.bidPolicy === "pool_ready"
          ? parameters.config.poolBuilderBidBps
          : parameters.config.poolFulfilledBuilderBidBps,
    poolBuilderBidPolicy: parameters.bidPolicy,
    ...(parameters.requiresBundleSimulation === undefined
      ? {}
      : {
          requiresBundleSimulation:
            parameters.requiresBundleSimulation,
        }),
    roundId: parameters.roundId,
  };
}

export function fwaProcessJob(parameters: {
  readonly fwa: Address;
  readonly gas: bigint;
  readonly count: bigint;
  readonly config?: KeeperConfig;
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
    ...(parameters.config === undefined
      ? {}
      : {
          poolVersion: parameters.config.poolVersion,
          configuredBuilderBidBps:
            parameters.config.poolBuilderBidBps,
        }),
    poolBuilderBidPolicy: "pool_ready",
    requiresBundleSimulation: true,
  };
}

export function exactSimulationPlanIsAdmissible(parameters: {
  readonly jobs: readonly KeeperJob[];
  readonly minimumViablePrefix: number;
}): boolean {
  return (
    parameters.minimumViablePrefix >= 1 &&
    parameters.minimumViablePrefix <= parameters.jobs.length &&
    parameters.jobs.some(
      (job) => job.requiresBundleSimulation === true,
    )
  );
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
        const jobs = [
          fwaProcessJob({
            fwa,
            gas: config.fwaProcessGasLimit,
            count: processCount,
            config,
          }),
          poolJob({
            kind: "pool_sync",
            pool,
            roundId: roundCount,
            gas: config.poolSyncGasLimit,
            terms,
            bidPolicy: "pool_ready",
            config,
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
              config,
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
          config,
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
            config,
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
              bidPolicy: "pool_ready",
              config,
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
              gas: BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
              terms,
              bidPolicy: "pool_pull",
              config,
              requiresBundleSimulation: true,
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
              config,
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
        const jobs = selectedOrders.map((order) =>
          orderJob(order, config),
        );
        jobs.push(
          poolJob({
            kind: "pool_pull",
            pool,
            roundId: roundCount,
            gas: BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
            terms,
            bidPolicy: "pool_pull",
            config,
            requiresBundleSimulation: true,
          }),
        );
        if (jobs.some((job) => job.requiresBundleSimulation)) {
          return {
            jobs,
            minimumViablePrefix: jobs.length,
          };
        }
        const grossReward = jobs.reduce(
          (total, job) =>
            total +
            estimatedJobReward({
              job,
              gasUsed: job.gas,
              baseFeePerGas: bountyBaseFeePerGas,
              poolBountyEstimateBps:
                config.poolBountyEstimateBps,
              poolPullBountyEstimateBps:
                config.poolPullBountyEstimateBps,
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
        .map((order) => orderJob(order, config)),
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
      .map((order) => orderJob(order, config)),
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
    const [
      staker,
      incentiveBps,
      crvRound,
      ethRound,
      claimableResults,
    ] =
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
        parameters.client.multicall({
          allowFailure: true,
          batchSize: 16_384,
          blockNumber: parameters.headBlockNumber,
          contracts: pools.map((pool) => ({
            address: pool.gauge,
            abi: curveGaugeAbi,
            functionName: "claimable_tokens" as const,
            args: [candidateSnapshot.staker] as const,
          })),
        }),
      ]);
    if (!isAddressEqual(staker, candidateSnapshot.staker)) {
      if (convexCandidateSnapshot === candidateSnapshot) {
        convexCandidateSnapshot = undefined;
      }
      incrementReason(
        parameters.skipped,
        "convex_earmark_staker_changed",
      );
      return undefined;
    }
    const crvUsd = crvRound[1];
    const ethUsd = ethRound[1];
    if (crvUsd <= 0n || ethUsd <= 0n) {
      incrementReason(
        parameters.skipped,
        "convex_earmark_invalid_oracle_price",
      );
      return undefined;
    }
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
  readonly headBlockNumber: bigint;
  readonly skipped: Map<string, number>;
}): Promise<KeeperJob | undefined> {
  if (!parameters.config.enableConvexKicks) return undefined;
  try {
    const candidateSnapshot =
      getConvexKickCandidateAccounts({
        headBlockNumber: parameters.headBlockNumber,
      });
    if (candidateSnapshot === undefined) {
      incrementReason(
        parameters.skipped,
        "convex_kick_cache_cold",
      );
      return undefined;
    }
    const candidates = candidateSnapshot.candidates;
    log("debug", "convex_kick_candidate_cache_used", {
      snapshotBlock:
        candidateSnapshot.requestedAtBlock.toString(),
      ageBlocks:
        (
          parameters.headBlockNumber -
          candidateSnapshot.requestedAtBlock
        ).toString(),
      candidates: candidates.length,
    });
    if (candidates.length === 0) {
      incrementReason(
        parameters.skipped,
        "convex_kick_none_profitable",
      );
      return undefined;
    }
    const [rewardPerEpoch, cvxRound, ethRound, balanceResults] =
      await Promise.all([
        parameters.client.readContract({
          address: CONVEX_LOCKER_ADDRESS,
          abi: convexLockerAbi,
          functionName: "kickRewardPerEpoch",
          blockNumber: parameters.headBlockNumber,
        }),
        parameters.client.readContract({
          address: CVX_USD_FEED_ADDRESS,
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
        parameters.client.multicall({
          allowFailure: false,
          batchSize: 16_384,
          blockNumber: parameters.headBlockNumber,
          contracts: candidates.map((candidate) => ({
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
    const prefiltered = candidates.flatMap(
      (candidate, index) => {
        const balances = balanceResults[index];
        if (
          balances === undefined ||
          balances[1] === 0n
        ) {
          return [];
        }
        // An eligible kick pays at least one epoch. Later epochs can only
        // increase the actual CVX reward, so this is a strict reward floor.
        const minimumRewardCvx =
          (balances[1] * rewardPerEpoch) / 10_000n;
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
    if (isFreshBlockReadUnavailable(error)) throw error;
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
  const cached = (
    cachedOrderCandidatesByFactory.get(
      orderRegistryCacheKey(parameters.config),
    ) ?? []
  ).slice(0, LIFECYCLE_FUNDING_CANDIDATE_LIMIT);
  const candidates = await refreshCachedOrderCandidates({
    client: parameters.client,
    config: parameters.config,
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

async function planJobsForPool(parameters: {
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
  const routingRead =
    parameters.config.poolVersion === "v2"
      ? readPullPoolV2Routing(
          parameters.client,
          parameters.headBlockNumber,
        )
      : Promise.all([
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
        ]);
  const [routingReadResult, fwa, token] = await Promise.all([
    routingRead,
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
  let fundingRoundId: bigint | undefined;
  let fundingRoundSnapshot: PoolRoundSnapshot | undefined;
  let lifecycleRounds: readonly {
    readonly roundId: bigint;
    readonly snapshot: PoolRoundSnapshot;
  }[];
  if (parameters.config.poolVersion === "v2") {
    const v2Routing =
      routingReadResult as Awaited<
        ReturnType<typeof readPullPoolV2Routing>
      >;
    fundingRoundId = v2Routing.fundingRound?.roundId;
    fundingRoundSnapshot =
      v2Routing.fundingRound === undefined
        ? undefined
        : fromPullPoolV2Round(v2Routing.fundingRound);
    lifecycleRounds = v2Routing.lifecycleRounds.map((round) => ({
      roundId: round.roundId,
      snapshot: fromPullPoolV2Round(round),
    }));
    log("debug", "pull_pool_v2_routing", {
      activeRounds: JSON.stringify(
        v2Routing.activeRoundIds.map((roundId) =>
          roundId.toString(),
        ),
      ),
      lifecycleRounds: JSON.stringify(
        lifecycleRounds.map((round) =>
          round.roundId.toString(),
        ),
      ),
      fundingRound: fundingRoundId?.toString() ?? "",
      currentOpenRound:
        v2Routing.currentOpenRound.toString(),
      pendingPullCount:
        v2Routing.pendingPullCount.toString(),
    });
  } else {
    const [roundCount, ethPendingRound] =
      routingReadResult as readonly [bigint, bigint];
    const routing = routeRoundIds({
      roundCount,
      ethPendingRound,
    });
    fundingRoundId = routing.fundingRoundId;
    lifecycleRounds =
      routing.lifecycleRoundId === undefined
        ? []
        : [
            {
              roundId: routing.lifecycleRoundId,
              snapshot: await getRoundSnapshot(
                parameters.client,
                parameters.config.expectedPoolAddress,
                routing.lifecycleRoundId,
                parameters.config.poolVersion,
                parameters.headBlockNumber,
              ),
            },
          ];
  }
  const tokenAddress = getAddress(token);
  if (tokenAddress !== parameters.config.expectedFwaTokenAddress) {
    throw new Error(
      `pool FWA token ${tokenAddress} does not match expected token ${parameters.config.expectedFwaTokenAddress}`,
    );
  }
  const fundingRoundPromise =
    fundingRoundId === undefined ||
    lifecycleRounds.some(
      (round) => round.roundId === fundingRoundId,
    )
      ? Promise.resolve(undefined)
      : fundingRoundSnapshot !== undefined
        ? Promise.resolve(fundingRoundSnapshot)
        : getRoundSnapshot(
            parameters.client,
            parameters.config.expectedPoolAddress,
            fundingRoundId,
            parameters.config.poolVersion,
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
    fundingRoundId === undefined ||
    lifecycleRounds.length === 0
      ? undefined
      : planLifecycleFundingSuffix({
          client: parameters.client,
          account: parameters.account,
          config: parameters.config,
          pool: parameters.config.expectedPoolAddress,
          fwa: getAddress(fwa),
          fundingRoundId,
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
          poolPullBountyEstimateBps:
            parameters.config.poolPullBountyEstimateBps,
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

  for (const lifecycleRound of lifecycleRounds) {
    const lifecyclePrimary = await planPrimaryJobs({
      ...plannerBase,
      candidates: [],
      roundCount: lifecycleRound.roundId,
      round: lifecycleRound.snapshot,
    });
    const profit = primaryProfit(lifecyclePrimary);
    const exactSimulationDeferred =
      exactSimulationPlanIsAdmissible(lifecyclePrimary);
    if (
      lifecyclePrimary.jobs.length > 0 &&
      (exactSimulationDeferred ||
        profit >= requiredProfit(parameters.config.minProfitWei))
    ) {
      const enriched =
        fundingRoundId === undefined
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
              fundingRoundId,
              funding: lifecycleFundingPromise,
              timeoutMs: LIFECYCLE_FUNDING_WAIT_MS,
            });
      log("debug", "lifecycle_fast_path_selected", {
        poolVersion: parameters.config.poolVersion,
        round: lifecycleRound.roundId.toString(),
        jobs: enriched.jobs.length,
        baseJobs: lifecyclePrimary.jobs.length,
        fundingEnriched: enriched.enriched,
        exactSimulationDeferred,
        ...(enriched.reason === undefined
          ? {}
          : { fundingFallback: enriched.reason }),
        estimatedProfit: eth(profit),
      });
      return {
        jobs: enriched.jobs,
        minimumViablePrefix:
          enriched.minimumViablePrefix,
        orders:
          lastKnownOrderCountByFactory.get(
            orderRegistryCacheKey(parameters.config),
          ) ?? 0,
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
        parameters.config,
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
        headBlockNumber: parameters.headBlockNumber,
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
  const fundingPrimaryPromise = trackPlanner(
    "fundingPrimary",
    async () => {
      const [candidates, fundingRound] = await Promise.all([
        candidatesPromise,
        fundingRoundPromise,
      ]);
      let fundingPrimary:
        | Awaited<ReturnType<typeof planPrimaryJobs>>
        | undefined;
      if (
        fundingRoundId !== undefined &&
        !lifecycleRounds.some(
          (round) => round.roundId === fundingRoundId,
        ) &&
        fundingRound !== undefined
      ) {
        fundingPrimary = await planPrimaryJobs({
          ...plannerBase,
          candidates,
          roundCount: fundingRoundId,
          round: fundingRound,
        });
      } else if (
        fundingRoundId === undefined &&
        (parameters.config.poolVersion === "v2" ||
          lifecycleRounds.length === 0)
      ) {
        fundingPrimary = await planPrimaryJobs({
          ...plannerBase,
          candidates,
          roundCount: 0n,
          round: undefined,
        });
      }
      return { candidates, fundingPrimary };
    },
  );
  const [
    { candidates, fundingPrimary },
    liquity,
    convex,
    convexKick,
    stakeDao,
    firm,
    buyback,
    liveBidSweep,
  ] = await Promise.all([
      fundingPrimaryPromise,
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
  lastKnownOrderCountByFactory.set(
    orderRegistryCacheKey(parameters.config),
    candidates.length,
  );

  const alternatives: Array<{
    readonly jobs: readonly KeeperJob[];
    readonly minimumViablePrefix: number;
    readonly profit: bigint;
    readonly label: string;
  }> = [];
  for (const primary of [fundingPrimary]) {
    if (primary === undefined || primary.jobs.length === 0) continue;
    const profit = primaryProfit(primary);
    if (
      exactSimulationPlanIsAdmissible(primary) ||
      profit >= requiredProfit(parameters.config.minProfitWei)
    ) {
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

function planContainsLifecycle(plan: PlannedJobs): boolean {
  return plan.jobs.some(
    (job) =>
      job.kind === "fwa_process" ||
      job.kind === "pool_pull" ||
      job.kind === "pool_sync" ||
      job.kind === "pool_settle" ||
      job.kind === "pool_settle_forced_eth",
  );
}

function mergeSkippedReasons(
  plans: readonly PlannedJobs[],
): Map<string, number> {
  const merged = new Map<string, number>();
  for (const plan of plans) {
    for (const [reason, count] of plan.skipped) {
      merged.set(reason, (merged.get(reason) ?? 0) + count);
    }
  }
  return merged;
}

export function mergeConcurrentPoolPlans(parameters: {
  readonly plans: readonly {
    readonly poolVersion: KeeperConfig["poolVersion"];
    readonly plan: PlannedJobs;
    readonly estimatedProfit: bigint;
  }[];
  readonly maxJobs: number;
}): PlannedJobs {
  const populated = parameters.plans.filter(
    ({ plan }) => plan.jobs.length > 0,
  );
  if (populated.length === 0) {
    return {
      jobs: [],
      minimumViablePrefix: 0,
      orders: parameters.plans.reduce(
        (total, { plan }) => total + plan.orders,
        0,
      ),
      skipped: mergeSkippedReasons(
        parameters.plans.map(({ plan }) => plan),
      ),
    };
  }
  populated.sort((left, right) => {
    const leftLifecycle = planContainsLifecycle(left.plan);
    const rightLifecycle = planContainsLifecycle(right.plan);
    if (leftLifecycle !== rightLifecycle) {
      return leftLifecycle ? -1 : 1;
    }
    if (left.estimatedProfit !== right.estimatedProfit) {
      return left.estimatedProfit > right.estimatedProfit ? -1 : 1;
    }
    return left.poolVersion.localeCompare(right.poolVersion);
  });

  // Two lifecycle chains cannot safely share a generic prefix ladder: a
  // reverted second chain could otherwise leave a processor/sync fragment
  // after the first settled chain. Plan both, but retain only the stronger
  // lifecycle alternative for this target block. Independent order-only work
  // from the other adapter can still follow the selected lifecycle atomically.
  let lifecycleSelected = false;
  const selected = populated.filter(({ plan }) => {
    if (!planContainsLifecycle(plan)) return true;
    if (lifecycleSelected) return false;
    lifecycleSelected = true;
    return true;
  });
  const jobs = selected
    .flatMap(({ plan }) => plan.jobs)
    .slice(0, parameters.maxJobs);
  const first = selected[0]?.plan;
  const minimumViablePrefix =
    first === undefined || jobs.length < first.minimumViablePrefix
      ? 0
      : first.minimumViablePrefix;
  return {
    jobs:
      minimumViablePrefix === 0
        ? []
        : jobs,
    minimumViablePrefix,
    orders: parameters.plans.reduce(
      (total, { plan }) => total + plan.orders,
      0,
    ),
    skipped: mergeSkippedReasons(
      parameters.plans.map(({ plan }) => plan),
    ),
  };
}

async function planJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly discoveryClient: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly additionalPoolConfigs?:
    | readonly KeeperConfig[]
    | Promise<readonly KeeperConfig[]>;
  readonly maxFeePerGas: bigint;
  readonly convexMaxFeePerGas: bigint;
  readonly stakeDaoMaxFeePerGas: bigint;
  readonly firmMaxFeePerGas: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly bountyBaseFeePerGas: bigint;
  readonly headBlockNumber: bigint;
  readonly headTimestamp: bigint;
}): Promise<PlannedJobs> {
  const groupPullPromise = parameters.config.enableGroupPull
    ? planGroupPullJob({
        client: parameters.client,
        account: parameters.account,
        blockNumber: parameters.headBlockNumber,
        maxFeePerGas: parameters.maxFeePerGas,
        gasLimitMultiplierBps:
          parameters.config.gasLimitMultiplierBps,
        minProfitWei: parameters.config.minProfitWei,
        builderBidBps:
          parameters.config.groupPullBuilderBidBps,
      })
    : Promise.resolve(undefined);
  const {
    additionalPoolConfigs: additionalPoolConfigsInput,
    ...singlePoolParameters
  } = parameters;
  const primaryPromise =
    planJobsForPool(singlePoolParameters);
  const additionalConfigs = await Promise.resolve(
    additionalPoolConfigsInput ?? [],
  );
  const poolPlans = await Promise.all([
    primaryPromise,
    ...additionalConfigs.map((config) =>
      planJobsForPool({
        ...singlePoolParameters,
        config,
      }),
    ),
  ]);
  const configs = [parameters.config, ...additionalConfigs];
  const plans = poolPlans.map((plan, index) => {
    const config = configs[index]!;
    const estimatedProfit = plan.jobs.reduce(
      (total, job) =>
        total +
        estimatedJobReward({
          job,
          gasUsed: job.gas,
          baseFeePerGas: parameters.bountyBaseFeePerGas,
          poolBountyEstimateBps:
            config.poolBountyEstimateBps,
          poolPullBountyEstimateBps:
            config.poolPullBountyEstimateBps,
        }) -
        job.gas * parameters.maxFeePerGas,
      0n,
    );
    return {
      poolVersion: config.poolVersion,
      plan,
      estimatedProfit,
    };
  });
  const merged = mergeConcurrentPoolPlans({
    plans,
    maxJobs: maxJobs(parameters.config),
  });
  const groupPullPlan = await groupPullPromise;
  const groupPullJob = groupPullPlan?.job;
  const mergedProfit = merged.jobs.reduce(
    (total, job) =>
      total +
      estimatedJobReward({
        job,
        gasUsed: job.gas,
        baseFeePerGas: parameters.bountyBaseFeePerGas,
        poolBountyEstimateBps:
          parameters.config.poolBountyEstimateBps,
        poolPullBountyEstimateBps:
          parameters.config.poolPullBountyEstimateBps,
      }) -
      job.gas * parameters.maxFeePerGas,
    0n,
  );
  const groupPullProfit =
    groupPullJob?.reward.kind === "fixed"
      ? groupPullJob.reward.amountWei -
        groupPullJob.gas * parameters.maxFeePerGas
      : undefined;
  const selected =
    groupPullJob !== undefined &&
    groupPullProfit !== undefined &&
    (merged.jobs.length === 0 || groupPullProfit > mergedProfit)
      ? {
          jobs: [groupPullJob],
          minimumViablePrefix: 1,
          orders: merged.orders,
          skipped: merged.skipped,
        }
      : merged;
  log("info", "pull_pool_adapter_plans_merged", {
    enabledVersions: JSON.stringify(
      configs.map((config) => config.poolVersion),
    ),
    plannedVersions: JSON.stringify(
      plans
        .filter(({ plan }) => plan.jobs.length > 0)
        .map(({ poolVersion }) => poolVersion),
    ),
    selectedVersions: JSON.stringify([
      ...new Set(
        merged.jobs.flatMap((job) =>
          job.poolVersion === undefined
            ? []
            : [job.poolVersion],
        ),
      ),
    ]),
    plannedJobs: plans.reduce(
      (total, { plan }) => total + plan.jobs.length,
      0,
    ),
    selectedJobs: selected.jobs.length,
    groupPullEnabled: parameters.config.enableGroupPull,
    groupPullPaused: groupPullPlan?.paused ?? "",
    groupPullDeprecated: groupPullPlan?.deprecated ?? "",
    groupPullRoundCount:
      groupPullPlan?.roundCount.toString() ?? "",
    groupPullLiveRound:
      groupPullPlan?.liveRound.toString() ?? "",
    groupPullBuyingRounds:
      groupPullPlan?.buyingRounds.toString() ?? "",
    groupPullSelected:
      selected.jobs[0]?.kind === "group_pull_close" ||
      selected.jobs[0]?.kind === "group_pull_submit" ||
      selected.jobs[0]?.kind === "group_pull_collect",
  });
  return selected;
}

export function estimatedJobReward(parameters: {
  readonly job: KeeperJob;
  readonly gasUsed: bigint;
  readonly baseFeePerGas: bigint;
  readonly poolBountyEstimateBps: bigint;
  readonly poolPullBountyEstimateBps: bigint;
}): bigint {
  if (parameters.job.reward.kind === "fixed") {
    return parameters.job.reward.amountWei;
  }
  return estimatePoolBounty({
    gasUsed: parameters.gasUsed,
    baseFeePerGas: parameters.baseFeePerGas,
    terms: parameters.job.reward.terms,
    estimateBps:
      parameters.job.kind === "pool_pull"
        ? parameters.poolPullBountyEstimateBps
        : parameters.poolBountyEstimateBps,
  });
}

export function maximumFundableGasEnvelope(parameters: {
  readonly requestedGas: bigint;
  readonly accountBalance: bigint;
  readonly reservedGasCost: bigint;
  readonly maxFeePerGas: bigint;
}): bigint | undefined {
  if (
    parameters.requestedGas < 0n ||
    parameters.accountBalance < 0n ||
    parameters.reservedGasCost < 0n ||
    parameters.maxFeePerGas <= 0n
  ) {
    throw new Error("invalid gas-envelope parameters");
  }
  const available =
    parameters.accountBalance - parameters.reservedGasCost;
  if (available <= 0n) return undefined;
  const fundableGas = available / parameters.maxFeePerGas;
  const gas =
    parameters.requestedGas < fundableGas
      ? parameters.requestedGas
      : fundableGas;
  return gas >= 21_000n ? gas : undefined;
}

type ReceiptLog = {
  readonly address: Address;
  readonly data: Hex;
  readonly topics: [] | [Hex, ...Hex[]];
};

export interface StandingOrderBatchReceiptAccounting {
  readonly valid: boolean;
  readonly reason?: string;
  readonly attempted: bigint;
  readonly succeeded: bigint;
  readonly grossReward: bigint;
  readonly builderPayment: bigint;
  readonly ownerReturn: bigint;
  readonly includedOrders: readonly Address[];
}

export function accountStandingOrderBatchReceipt(
  request: KeeperTransactionRequest,
  logs: readonly ReceiptLog[],
): StandingOrderBatchReceiptAccounting | undefined {
  if (request.kind !== "standing_order_batch") return undefined;
  const members = request.standingOrderBatchMembers ?? [];
  const byOrder = new Map(
    members.map((member) => [
      member.order.toLowerCase(),
      member,
    ]),
  );
  const paidFees = new Map<string, bigint>();
  let reported:
    | {
        readonly attempted: bigint;
        readonly succeeded: bigint;
        readonly grossReward: bigint;
        readonly builderPayment: bigint;
        readonly ownerReturn: bigint;
      }
    | undefined;
  for (const entry of logs) {
    const key = entry.address.toLowerCase();
    const member = byOrder.get(key);
    if (member !== undefined) {
      try {
        const decoded = decodeEventLog({
          abi: standingOrderAbi,
          data: entry.data,
          topics: entry.topics,
        });
        if (decoded.eventName === "Cranked") {
          if (paidFees.has(key)) {
            return {
              valid: false,
              reason: "duplicate_order_reward",
              attempted: BigInt(members.length),
              succeeded: BigInt(paidFees.size),
              grossReward: 0n,
              builderPayment: 0n,
              ownerReturn: 0n,
              includedOrders: [],
            };
          }
          paidFees.set(key, decoded.args.fee);
        }
      } catch {
        // Ignore unrelated logs emitted by an order.
      }
    }
    if (key === request.target.toLowerCase()) {
      try {
        const decoded = decodeEventLog({
          abi: standingOrderBatchExecutorAbi,
          data: entry.data,
          topics: entry.topics,
        });
        if (decoded.eventName === "BatchExecuted") {
          if (reported !== undefined) {
            return {
              valid: false,
              reason: "duplicate_batch_event",
              attempted: BigInt(members.length),
              succeeded: BigInt(paidFees.size),
              grossReward: 0n,
              builderPayment: 0n,
              ownerReturn: 0n,
              includedOrders: [],
            };
          }
          reported = decoded.args;
        }
      } catch {
        // Ignore unrelated executor logs.
      }
    }
  }
  if (reported === undefined) {
    return {
      valid: false,
      reason: "batch_event_missing",
      attempted: BigInt(members.length),
      succeeded: BigInt(paidFees.size),
      grossReward: 0n,
      builderPayment: 0n,
      ownerReturn: 0n,
      includedOrders: [],
    };
  }
  let grossReward = 0n;
  let builderPayment = 0n;
  const includedOrders: Address[] = [];
  for (const member of members) {
    const paidFee = paidFees.get(member.order.toLowerCase());
    if (paidFee === undefined) continue;
    includedOrders.push(member.order);
    grossReward += paidFee;
    builderPayment +=
      (paidFee * member.builderBidBps) / 10_000n;
  }
  const ownerReturn =
    builderPayment > grossReward
      ? 0n
      : grossReward - builderPayment;
  const valid =
    reported.attempted === BigInt(members.length) &&
    reported.succeeded === BigInt(paidFees.size) &&
    reported.grossReward === grossReward &&
    reported.builderPayment === builderPayment &&
    reported.ownerReturn === ownerReturn;
  return {
    valid,
    ...(valid ? {} : { reason: "batch_event_mismatch" }),
    attempted: reported.attempted,
    succeeded: reported.succeeded,
    grossReward: reported.grossReward,
    builderPayment: reported.builderPayment,
    ownerReturn: reported.ownerReturn,
    includedOrders: valid ? includedOrders : [],
  };
}

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
  batchAccounting?: StandingOrderBatchReceiptAccounting,
): bigint {
  if (request.kind === "builder_payment") return 0n;
  if (
    request.kind === "group_pull_close" ||
    request.kind === "group_pull_submit" ||
    request.kind === "group_pull_collect"
  ) {
    let total = 0n;
    for (const entry of logs) {
      if (entry.address.toLowerCase() !== request.target.toLowerCase()) {
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
          decoded.args.roundId === request.roundId
        ) {
          total += decoded.args.amount;
        }
      } catch {
        // GroupPull emits pool and round events in the same receipt.
      }
    }
    return total;
  }
  if (request.kind === "standing_order_batch") {
    return batchAccounting?.valid === true
      ? batchAccounting.ownerReturn
      : 0n;
  }
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
  const providerFeeQuotePromise =
    context.config.submissionMode === "flashbots"
      ? undefined
      : context.publicClient.estimateFeesPerGas({
          type: "eip1559",
        });
  const planningBlockRead = await resolvePlanningHead({
    headBlockNumber: context.headBlockNumber,
    ...(context.observedHead === undefined
      ? {}
      : { observedHead: context.observedHead }),
    readExactBlock: async () => {
      const block = await context.publicClient.getBlock({
        blockNumber: context.headBlockNumber,
      });
      return {
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
        baseFeePerGas: block.baseFeePerGas,
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
      };
    },
  });
  const latestBlock = planningBlockRead.value;
  const feeQuote = await resolvePlanningFeeQuote({
    submissionMode: context.config.submissionMode,
    parentBaseFeePerGas: latestBlock.baseFeePerGas,
    parentGasUsed: latestBlock.gasUsed,
    parentGasLimit: latestBlock.gasLimit,
    minimumPriorityFeePerGas:
      context.config.minPriorityFeePerGas,
    readProviderFeeQuote: async () =>
      providerFeeQuotePromise!,
  });
  const maxPriorityFeePerGas =
    feeQuote.maxPriorityFeePerGas;
  const maxFeePerGas = feeQuote.maxFeePerGas;
  const baseFeeAllowancePerGas =
    feeQuote.baseFeeAllowancePerGas;
  log("info", "keeper_pass_stage_timing", {
    stage: "head_and_fees",
    durationMs: performance.now() - headAndFeesStartedAt,
    planningHeaderSource: planningBlockRead.source,
    feeQuoteSource: feeQuote.source,
    exactStateTransport:
      context.exactStateTransport ?? "unspecified",
    blockReadAttempts: planningBlockRead.attempts,
    blockAvailabilityWaitMs: planningBlockRead.waitedMs,
    planningBlock: latestBlock.number.toString(),
    planningBlockHash: latestBlock.hash,
    headTimestamp: latestBlock.timestamp.toString(),
    headAgeMs:
      Date.now() - Number(latestBlock.timestamp) * 1_000,
    parentBaseFeePerGas:
      latestBlock.baseFeePerGas?.toString() ?? "",
    parentGasUsed: latestBlock.gasUsed.toString(),
    parentGasLimit: latestBlock.gasLimit.toString(),
    baseFeeAllowancePerGas:
      baseFeeAllowancePerGas.toString(),
  });
  if (maxFeePerGas > context.config.maxFeePerGas) {
    log("info", "gas_price_above_cap", {
      estimatedMaxFee: gwei(maxFeePerGas),
      configuredCap: gwei(context.config.maxFeePerGas),
    });
    return { orders: 0, viable: 0, sent: 0, confirmed: 0 };
  }

  const bountyBaseFeePerGas =
    context.config.submissionMode === "flashbots"
      ? baseFeeAllowancePerGas
      : (latestBlock.baseFeePerGas ??
        baseFeeAllowancePerGas);
  const planningStartedAt = performance.now();
  const planningRead = await retryTransientRead({
    read: () =>
      planJobs({
        client: context.publicClient,
        discoveryClient:
          context.discoveryClient ?? context.publicClient,
        account: context.account,
        config: context.config,
        ...(context.additionalPoolConfigs === undefined
          ? {}
          : {
              additionalPoolConfigs:
                context.additionalPoolConfigs,
            }),
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
        baseFeeAllowancePerGas,
        bountyBaseFeePerGas,
        headBlockNumber: latestBlock.number,
        headTimestamp: latestBlock.timestamp,
      }),
    shouldRetry: isFreshBlockReadUnavailable,
    maxAttempts: 11,
    retryDelayMs: 100,
  });
  let plan = planningRead.value;
  if (
    context.config.submissionMode === "flashbots" &&
    context.standingOrderBidBps !== undefined
  ) {
    const batchPlanningRead = await retryTransientRead({
      read: () =>
        planStandingOrderBatch({
          client: context.publicClient,
          account: context.account,
          blockNumber: latestBlock.number,
          executionGasPrice: baseFeeAllowancePerGas,
          gasLimitMultiplierBps:
            context.config.gasLimitMultiplierBps,
          minimumPriorityFeePerGas:
            context.config.minPriorityFeePerGas,
          maxFeePerGasCap: context.config.maxFeePerGas,
          minProfitWei: context.config.minProfitWei,
          bidBps: context.standingOrderBidBps!,
          plan,
        }),
      shouldRetry: isFreshBlockReadUnavailable,
      maxAttempts: 11,
      retryDelayMs: 100,
    });
    const batchPlan = batchPlanningRead.value;
    if (batchPlan !== undefined) {
      plan = batchPlan;
      log("info", "standing_order_batch_selected", {
        executor: batchPlan.executor,
        deploymentIncluded: batchPlan.deploymentIncluded,
        orders:
          batchPlan.jobs.at(-1)?.standingOrderBatchMembers?.length ??
          0,
        grossReward: eth(batchPlan.grossReward),
        embeddedBuilderPayment: eth(
          batchPlan.builderPayment,
        ),
        ownerReturn: eth(batchPlan.ownerReturn),
        directExpectedProfit: eth(
          batchPlan.directExpectedProfit,
        ),
        batchExpectedProfit: eth(
          batchPlan.batchExpectedProfit,
        ),
        expectedProfitAdvantage: eth(
          batchPlan.expectedProfitAdvantage,
        ),
        minimumViablePrefix: batchPlan.minimumViablePrefix,
      });
    } else if (
      plan.minimumViablePrefix === 1 &&
      plan.jobs.length > 1
    ) {
      const orderedJobs = orderStandaloneStandingJobsForAuction({
        jobs: plan.jobs,
        bidBps: context.standingOrderBidBps,
        maxFeePerGas,
      });
      if (
        orderedJobs.some(
          (job, index) => job !== plan.jobs[index],
        )
      ) {
        plan = { ...plan, jobs: orderedJobs };
        log("info", "standing_order_auction_ordering", {
          jobs: orderedJobs.length,
          orders: JSON.stringify(
            orderedJobs.map((job) => job.order),
          ),
          builderBidBps: JSON.stringify(
            orderedJobs.map((job) =>
              context.standingOrderBidBps!(job.order!).toString(),
            ),
          ),
          policy: "lower_competition_prefix_first",
        });
      }
    }
  }
  if (planningRead.attempts > 1) {
    log("info", "planning_state_availability_waited", {
      planningBlock: latestBlock.number.toString(),
      planningReadAttempts: planningRead.attempts,
      planningAvailabilityWaitMs: planningRead.waitedMs,
      exactStateTransport:
        context.exactStateTransport ?? "unspecified",
    });
  }
  log("info", "keeper_pass_stage_timing", {
    stage: "planning",
    durationMs: performance.now() - planningStartedAt,
    planningBlock: latestBlock.number.toString(),
    planningReadAttempts: planningRead.attempts,
    planningAvailabilityWaitMs: planningRead.waitedMs,
    exactStateTransport:
      context.exactStateTransport ?? "unspecified",
    plannedJobs: plan.jobs.length,
    minimumViablePrefix: plan.minimumViablePrefix,
  });
  const estimatedComponents = plan.jobs.map((job) => {
    if (job.requiresBundleSimulation) {
      return {
        rewardWei: 0n,
        maxGasCostWei: 0n,
      };
    }
    const rewardWei = estimatedJobReward({
      job,
      gasUsed: job.gas,
      baseFeePerGas: bountyBaseFeePerGas,
      poolBountyEstimateBps:
        context.config.poolBountyEstimateBps,
      poolPullBountyEstimateBps:
        context.config.poolPullBountyEstimateBps,
    });
    const planningMaxFeePerGas =
      context.config.submissionMode === "flashbots" &&
      (job.kind === "convex_earmark" ||
        job.kind === "convex_kick" ||
        job.kind === "stakedao_curve_harvest" ||
        job.kind === "firm_replenish")
        ? feeQuote.maxFeePerGas
        : maxFeePerGas;
    return {
      rewardWei,
      maxGasCostWei: job.gas * planningMaxFeePerGas,
    };
  });
  const estimatedGrossReward = estimatedComponents.reduce(
    (total, component) => total + component.rewardWei,
    0n,
  );
  const estimatedMaxGasCost = estimatedComponents.reduce(
    (total, component) => total + component.maxGasCostWei,
    0n,
  );
  const fullEstimatedProfit =
    estimatedGrossReward - estimatedMaxGasCost;
  const estimatedPrefix = selectMostProfitableEstimatedPrefix({
    components: estimatedComponents,
    minimumViablePrefix: plan.minimumViablePrefix,
    minProfitWei: context.config.minProfitWei,
  });
  const exactSimulationDeferred =
    exactSimulationPlanIsAdmissible(plan);
  const planProfitable =
    exactSimulationDeferred || estimatedPrefix !== undefined;
  if (plan.jobs.length > 0) {
    log(planProfitable ? "info" : "warn", "keeper_plan_economics", {
      jobs: plan.jobs.length,
      selectedEstimatedJobs: estimatedPrefix?.length ?? 0,
      estimatedGrossReward: eth(estimatedGrossReward),
      estimatedMaxGasCost: eth(estimatedMaxGasCost),
      estimatedProfit: eth(
        estimatedPrefix?.expectedProfitWei ??
          fullEstimatedProfit,
      ),
      fullEstimatedProfit: eth(fullEstimatedProfit),
      requiredProfit: eth(requiredProfit(context.config.minProfitWei)),
      exactSimulationDeferredJobs: plan.jobs.filter(
        (job) => job.requiresBundleSimulation,
      ).length,
      economicsDeferredToExactSimulation:
        exactSimulationDeferred,
      accepted: planProfitable,
    });
    if (!planProfitable) {
      incrementReason(plan.skipped, "bundle_unprofitable");
    }
  }
  for (const job of plan.jobs) {
    const reward = job.requiresBundleSimulation
      ? undefined
      : estimatedJobReward({
          job,
          gasUsed: job.gas,
          baseFeePerGas: bountyBaseFeePerGas,
          poolBountyEstimateBps:
            context.config.poolBountyEstimateBps,
          poolPullBountyEstimateBps:
            context.config.poolPullBountyEstimateBps,
        });
    log("info", "keeper_opportunity", {
      kind: job.kind,
      label: job.label,
      target: job.target,
      poolVersion: job.poolVersion ?? "",
      gasLimit: job.gas.toString(),
      estimatedReward:
        reward === undefined ? "" : eth(reward),
      exactSimulationRequired:
        job.requiresBundleSimulation === true,
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
  await context.preSubmissionGate?.();
  const accountAddress =
    typeof context.account === "string"
      ? context.account
      : context.account.address;
  const accountGateStartedAt = performance.now();
  const [
    submissionHead,
    latestNonce,
    pendingNonce,
    accountBalance,
  ] = await Promise.all([
    context.publicClient.getBlockNumber(),
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
    submissionHead: submissionHead.toString(),
    latestNonce,
    pendingNonce,
  });
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
    const transactionGas =
      job.requiresBundleSimulation === true
        ? maximumFundableGasEnvelope({
            requestedGas: job.gas,
            accountBalance,
            reservedGasCost,
            maxFeePerGas,
          })
        : job.gas;
    if (transactionGas === undefined) {
      incrementReason(
        plan.skipped,
        "keeper_balance_reserve",
      );
      break;
    }
    if (job.requiresBundleSimulation) {
      log("info", "dependency_gas_envelope_assigned", {
        kind: job.kind,
        label: job.label,
        protocolGasCeiling: job.gas.toString(),
        fundedGasEnvelope: transactionGas.toString(),
        maxFeePerGas: gwei(maxFeePerGas),
        reservedGasCost: eth(reservedGasCost),
        accountBalance: eth(accountBalance),
      });
    }
    const maxGasCost = transactionGas * maxFeePerGas;
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
      gas: transactionGas,
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
      const acceptedRequests =
        batchResult.acceptedRequests ?? requests;
      if (
        batchResult.hashes.length >
        acceptedRequests.length
      ) {
        throw new Error(
          "private sender returned more hashes than accepted requests",
        );
      }
      for (let index = 0; index < batchResult.hashes.length; index += 1) {
        const hash = batchResult.hashes[index];
        const request = acceptedRequests[index];
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
      effectiveBuilderBidBpsByOrder: JSON.stringify(
        Object.fromEntries(
          batchResult?.effectiveBuilderBidBpsByOrder ?? [],
        ),
        (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
      ),
    });
  }
  for (const [index, submission] of submitted.entries()) {
    log("info", "keeper_transaction_sent", {
      kind: submission.request.kind,
      label: submission.request.label,
      poolVersion: submission.request.poolVersion ?? "",
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

  let privateTargetBlockContext:
    | {
        readonly blockHash: Hash | null;
        readonly feeRecipient: Address;
        readonly extraData: Hex;
      }
    | undefined;
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
      shouldRetry: isFreshBlockReadUnavailable,
      maxAttempts: 11,
      retryDelayMs: 100,
    });
    privateTargetBlockContext = {
      blockHash: targetBlockRead.value.hash,
      feeRecipient: targetBlockRead.value.miner,
      extraData: targetBlockRead.value.extraData,
    };
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
        privateTargetBlock !== undefined
          ? {
              targetBlock: privateTargetBlock.toString(),
              ...(submitted.length > 1
                ? {
                    batchTransactionCount: submitted.length,
                    batchPosition: index + 1,
                    batchTargetBlock:
                      privateTargetBlock.toString(),
                  }
                : {}),
            }
          : {};
      try {
        let receipt: Awaited<
          ReturnType<
            typeof context.publicClient.getTransactionReceipt
          >
        >;
        if (privateTargetBlock === undefined) {
          receipt =
            await context.publicClient.waitForTransactionReceipt({
              hash: submission.hash,
              confirmations: context.config.confirmations,
              timeout: context.config.receiptTimeoutMs,
            });
        } else {
          const receiptRead =
            await readPublishedTransactionReceipt(() =>
              context.publicClient.getTransactionReceipt({
                hash: submission.hash,
              }),
            );
          receipt = receiptRead.value;
          if (receiptRead.attempts > 1) {
            log(
              "info",
              "keeper_receipt_availability_waited",
              {
                kind: submission.request.kind,
                label: submission.request.label,
                hash: submission.hash,
                nonce: submission.request.nonce,
                targetBlock:
                  privateTargetBlock.toString(),
                receiptReadAttempts:
                  receiptRead.attempts,
                receiptAvailabilityWaitMs:
                  receiptRead.waitedMs,
                ...batchFields,
              },
            );
          }
        }
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
        const standingOrderBatchAccounting = successful
          ? accountStandingOrderBatchReceipt(
              submission.request,
              receipt.logs,
            )
          : undefined;
        if (
          standingOrderBatchAccounting !== undefined &&
          !standingOrderBatchAccounting.valid
        ) {
          log("warn", "standing_order_batch_accounting_failed", {
            kind: submission.request.kind,
            label: submission.request.label,
            hash: submission.hash,
            executor: submission.request.target,
            reason:
              standingOrderBatchAccounting.reason ?? "unknown",
            attempted:
              standingOrderBatchAccounting.attempted.toString(),
            succeeded:
              standingOrderBatchAccounting.succeeded.toString(),
          });
        }
        const paidReward = successful
          ? actualJobReward(
              submission.request,
              receipt.logs,
              firmAccounting,
              standingOrderBatchAccounting,
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
        const valueCost = successful
          ? (submission.request.value ?? 0n)
          : 0n;
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
          ...(standingOrderBatchAccounting === undefined
            ? {}
            : {
                standingOrderBatchAttempted:
                  standingOrderBatchAccounting.attempted.toString(),
                standingOrderBatchSucceeded:
                  standingOrderBatchAccounting.succeeded.toString(),
                standingOrderBatchGrossReward: eth(
                  standingOrderBatchAccounting.grossReward,
                ),
                standingOrderBatchBuilderPayment: eth(
                  standingOrderBatchAccounting.builderPayment,
                ),
                standingOrderBatchAccountingValid:
                  standingOrderBatchAccounting.valid,
              }),
          gasCost: eth(gasCost),
          transactionValue: eth(valueCost),
          realizedProfit: eth(
            paidReward - gasCost - valueCost,
          ),
          ...batchFields,
        });
        return {
          outcome: "confirmed" as const,
          successful,
          paidReward,
          gasCost,
          valueCost,
          includedOrders:
            standingOrderBatchAccounting?.includedOrders ?? [],
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
          valueCost: 0n,
          includedOrders: [],
        };
      }
    }),
  );

  if (
    privateTargetBlock !== undefined &&
    privateTargetBlockContext !== undefined &&
    submitted.length > 0
  ) {
    const includedTransactions = receiptResults.filter(
      (result) => result.outcome === "confirmed",
    ).length;
    const successfulTransactions = receiptResults.filter(
      (result) =>
        result.outcome === "confirmed" && result.successful,
    ).length;
    const revertedTransactions =
      includedTransactions - successfulTransactions;
    const expiredTransactions =
      receiptResults.length - includedTransactions;
    const outcome =
      successfulTransactions === submitted.length
        ? "full_success"
        : includedTransactions === 0
          ? "miss"
          : "partial_inclusion";
    log(
      outcome === "full_success" ? "info" : "warn",
      "private_target_block_delivery",
      {
        targetBlock: privateTargetBlock.toString(),
        blockHash: privateTargetBlockContext.blockHash ?? "",
        feeRecipient: privateTargetBlockContext.feeRecipient,
        extraData: privateTargetBlockContext.extraData,
        attemptedTransactions: submitted.length,
        includedTransactions,
        successfulTransactions,
        revertedTransactions,
        expiredTransactions,
        outcome,
      },
    );
  }

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
    const totalTransactionValue = receiptResults.reduce(
      (total, result) => total + result.valueCost,
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
        poolVersions: JSON.stringify([
          ...new Set(
            submitted.flatMap(({ request }) =>
              request.poolVersion === undefined
                ? []
                : [request.poolVersion],
            ),
          ),
        ]),
        transactionCount: submitted.length,
        confirmedTransactions,
        revertedTransactions,
        expiredTransactions,
        targetBlock: privateTargetBlock.toString(),
        block: receiptBlock?.toString() ?? "",
        totalReward: eth(totalReward),
        totalGasCost: eth(totalGasCost),
        totalTransactionValue: eth(totalTransactionValue),
        realizedProfit: eth(
          totalReward -
            totalGasCost -
            totalTransactionValue,
        ),
        effectiveBuilderBidBps:
          batchResult?.effectiveBuilderBidBps?.toString() ?? "",
      },
    );
  }

  const orderAttempts = submitted.flatMap((submission, index) => {
    const batchMembers =
      submission.request.standingOrderBatchMembers;
    if (
      submission.request.kind === "standing_order_batch" &&
      batchMembers !== undefined
    ) {
      const includedOrders = new Set(
        (receiptResults[index]?.includedOrders ?? []).map((order) =>
          order.toLowerCase(),
        ),
      );
      return batchMembers.map((member) => ({
        order: member.order,
        poolVersion: member.poolVersion,
        crankFee: member.crankFee,
        hash: submission.hash,
        included: includedOrders.has(
          member.order.toLowerCase(),
        ),
        effectiveBidBps: effectiveBuilderBidBps(
          (member.crankFee * member.builderBidBps) / 10_000n,
          member.crankFee,
        ),
      }));
    }
    const order = submission.request.order;
    if (order === undefined) return [];
    const reward = submission.request.reward;
    if (reward.kind !== "fixed") return [];
    const effectiveBidBps =
      batchResult?.effectiveBuilderBidBpsByOrder?.get(
        order.toLowerCase(),
      ) ?? batchResult?.effectiveBuilderBidBps;
    return [
      {
        order,
        poolVersion:
          submission.request.poolVersion ??
          context.config.poolVersion,
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
    const allPoolConfigs = [
      context.config,
      ...await Promise.resolve(
        context.additionalPoolConfigs ?? [],
      ),
    ];
    for (const poolVersion of [
      ...new Set(
        orderAttempts.map((attempt) => attempt.poolVersion),
      ),
    ]) {
      const poolConfig = allPoolConfigs.find(
        (candidate) =>
          candidate.poolVersion === poolVersion,
      );
      if (poolConfig === undefined) continue;
      try {
        await context.observePrivateBatch({
          targetBlock: privateTargetBlock,
          poolVersion,
          factoryAddress: poolConfig.factoryAddress,
          factoryAddresses:
            poolConfig.orderFactoryAddresses,
          poolAddresses: [poolConfig.expectedPoolAddress],
          ...(poolConfig.enableVaults
            ? {
                vaultFactoryAddress:
                  poolConfig.vaultFactoryAddress,
              }
            : {}),
          attempts: orderAttempts
            .filter(
              (attempt) =>
                attempt.poolVersion === poolVersion,
            )
            .map(({ poolVersion: _, ...attempt }) => attempt),
        });
      } catch (error) {
        log("warn", "adaptive_bid_observation_failed", {
          targetBlock: privateTargetBlock.toString(),
          poolVersion,
          reason: errorMessage(error),
        });
      }
    }
  }

  const poolPullAttempts = submitted.flatMap(
    (submission, index) => {
      if (
        submission.request.kind !== "pool_pull" ||
        submission.request.roundId === undefined
      ) {
        return [];
      }
      return [
        {
          pool: submission.request.target,
          poolVersion:
            submission.request.poolVersion ??
            context.config.poolVersion,
          hash: submission.hash,
          roundId: submission.request.roundId,
          included:
            receiptResults[index]?.successful ?? false,
        },
      ];
    },
  );
  if (
    privateTargetBlock !== undefined &&
    poolPullAttempts.length > 0 &&
    context.observePoolPullBatch !== undefined
  ) {
    const groups = new Map<
      string,
      {
        readonly pool: Address;
        readonly poolVersion: KeeperConfig["poolVersion"];
        readonly attempts: Array<{
          readonly hash: Hash;
          readonly roundId: bigint;
          readonly included: boolean;
        }>;
      }
    >();
    for (const attempt of poolPullAttempts) {
      const key = `${attempt.poolVersion}:${attempt.pool.toLowerCase()}`;
      const group = groups.get(key) ?? {
        pool: attempt.pool,
        poolVersion: attempt.poolVersion,
        attempts: [],
      };
      group.attempts.push({
        hash: attempt.hash,
        roundId: attempt.roundId,
        included: attempt.included,
      });
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      try {
        await context.observePoolPullBatch({
          targetBlock: privateTargetBlock,
          pool: group.pool,
          poolVersion: group.poolVersion,
          ...(batchResult?.effectiveBuilderBidBps === undefined
            ? {}
            : {
                effectiveBuilderBidBps:
                  batchResult.effectiveBuilderBidBps,
              }),
          ...(batchResult?.plannedGrossReward === undefined
            ? {}
            : {
                plannedGrossReward:
                  batchResult.plannedGrossReward,
              }),
          ...(batchResult?.plannedBuilderPayment === undefined
            ? {}
            : {
                plannedBuilderPayment:
                  batchResult.plannedBuilderPayment,
              }),
          ...(batchResult?.plannedExpectedProfit === undefined
            ? {}
            : {
                plannedExpectedProfit:
                  batchResult.plannedExpectedProfit,
              }),
          attempts: group.attempts,
        });
      } catch (error) {
        log("warn", "pool_pull_bid_observation_failed", {
          targetBlock: privateTargetBlock.toString(),
          poolVersion: group.poolVersion,
          pool: group.pool,
          reason: errorMessage(error),
        });
      }
    }
  }

  const poolLifecycleAttempts = submitted.flatMap(
    (submission, index) => {
      const kind = submission.request.kind;
      if (
        (kind !== "pool_sync" &&
          kind !== "pool_settle" &&
          kind !== "pool_settle_forced_eth") ||
        submission.request.roundId === undefined
      ) {
        return [];
      }
      return [
        {
          hash: submission.hash,
          roundId: submission.request.roundId,
          kind,
          ...(submission.request.poolBuilderBidPolicy === undefined
            ? {}
            : {
                bidPolicy:
                  submission.request.poolBuilderBidPolicy,
              }),
          included:
            receiptResults[index]?.successful ?? false,
        },
      ];
    },
  );
  if (
    privateTargetBlock !== undefined &&
    poolLifecycleAttempts.length > 0 &&
    context.observePoolLifecycleBatch !== undefined
  ) {
    const lifecycleRequest = submitted.find(
      ({ request }) =>
        request.kind === "pool_sync" ||
        request.kind === "pool_settle" ||
        request.kind === "pool_settle_forced_eth",
    )?.request;
    const pureSingleRoundFulfilledLifecycle =
      isPureSingleRoundFulfilledLifecycleBatch(
        submitted.map(({ request }) => request),
      );
    try {
      await context.observePoolLifecycleBatch({
        targetBlock: privateTargetBlock,
        pool:
          lifecycleRequest?.target ??
          context.config.expectedPoolAddress,
        poolVersion:
          lifecycleRequest?.poolVersion ??
          context.config.poolVersion,
        ...(batchResult?.effectiveBuilderBidBps === undefined
          ? {}
          : {
              effectiveBuilderBidBps:
                batchResult.effectiveBuilderBidBps,
            }),
        ...(batchResult?.plannedGrossReward === undefined
          ? {}
          : {
              plannedGrossReward:
                batchResult.plannedGrossReward,
            }),
        ...(batchResult?.plannedBuilderPayment === undefined
          ? {}
          : {
              plannedBuilderPayment:
                batchResult.plannedBuilderPayment,
            }),
        ...(batchResult?.plannedExpectedProfit === undefined
          ? {}
          : {
              plannedExpectedProfit:
                batchResult.plannedExpectedProfit,
            }),
        pureSingleRoundFulfilledLifecycle,
        attempts: poolLifecycleAttempts,
      });
    } catch (error) {
      log("warn", "pool_lifecycle_bid_observation_failed", {
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
