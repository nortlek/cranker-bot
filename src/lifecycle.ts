import type { Address } from "viem";

const BPS = 10_000n;

export const ROUND_STATE = {
  none: 0,
  open: 1,
  pulling: 2,
  claimable: 3,
  settled: 4,
  refunding: 5,
} as const;

export const ACQUISITION_STATUS = {
  none: 0,
  pending: 1,
  fulfilled: 2,
  expired: 3,
  refunded: 4,
  ready: 5,
  timedOut: 6,
} as const;

export function acquisitionStatusName(status: number): string {
  switch (status) {
    case ACQUISITION_STATUS.none:
      return "none";
    case ACQUISITION_STATUS.pending:
      return "pending";
    case ACQUISITION_STATUS.fulfilled:
      return "fulfilled";
    case ACQUISITION_STATUS.expired:
      return "expired";
    case ACQUISITION_STATUS.refunded:
      return "refunded";
    case ACQUISITION_STATUS.ready:
      return "ready";
    case ACQUISITION_STATUS.timedOut:
      return "timed_out";
    default:
      return `unknown_${status}`;
  }
}

export function acquisitionProcessCount(
  targetRequestId: bigint,
  queuedRequestIds: readonly bigint[],
): bigint | undefined {
  const index = queuedRequestIds.findIndex(
    (requestId) => requestId === targetRequestId,
  );
  return index < 0 ? undefined : BigInt(index + 1);
}

export interface RoundRouting {
  readonly fundingRoundId?: bigint;
  readonly lifecycleRoundId?: bigint;
}

export interface LifecycleFundingJob {
  readonly kind: string;
  readonly roundId?: bigint;
}

/**
 * Once an exact-simulated lifecycle prefix includes settlement, do not offer
 * builders an alternative that stops before settlement. Those alternatives
 * share nonces, so a builder can otherwise select a profitable process/sync
 * prefix and discard the also-profitable settlement transaction.
 *
 * Optional work after settlement still keeps its prefix ladder: a lifecycle
 * bundle enriched with standing orders or a covered pull may submit the
 * settled core and every longer prefix.
 */
export function minimumLifecycleSubmissionPrefix(
  jobs: readonly LifecycleFundingJob[],
  minimumEconomicPrefix: number,
): number {
  if (
    !Number.isSafeInteger(minimumEconomicPrefix) ||
    minimumEconomicPrefix < 1 ||
    minimumEconomicPrefix > jobs.length
  ) {
    throw new Error(
      "minimum economic prefix must select a non-empty job prefix",
    );
  }

  let minimumSubmissionPrefix = minimumEconomicPrefix;
  for (let index = 0; index < jobs.length; index += 1) {
    const kind = jobs[index]?.kind;
    if (
      kind === "pool_settle" ||
      kind === "pool_settle_forced_eth"
    ) {
      minimumSubmissionPrefix = Math.max(
        minimumSubmissionPrefix,
        index + 1,
      );
    }
  }
  return minimumSubmissionPrefix;
}

export interface LifecycleFundingSuffix<TJob extends LifecycleFundingJob> {
  readonly source: "cache";
  readonly headBlockNumber: bigint;
  readonly fundingRoundId: bigint;
  readonly coverageSatisfied: boolean;
  readonly jobs: readonly TJob[];
}

export interface LifecycleFundingSuperset<TJob extends LifecycleFundingJob> {
  readonly jobs: readonly TJob[];
  readonly minimumViablePrefix: number;
  readonly enriched: boolean;
  readonly reason?:
    | "lifecycle_settle_missing"
    | "funding_unavailable"
    | "funding_stale"
    | "funding_suffix_invalid"
    | "funding_empty";
}

/**
 * Adds a timeout-bounded funding suffix without changing the lifecycle-safe
 * prefix. The suffix is deliberately narrow: exactly simulated order cranks
 * followed by, at most, one covered pull for the current funding round.
 */
export async function lifecycleFundingSuperset<
  TJob extends LifecycleFundingJob,
>(parameters: {
  readonly lifecycleJobs: readonly TJob[];
  readonly lifecycleMinimumViablePrefix: number;
  readonly headBlockNumber: bigint;
  readonly fundingRoundId: bigint;
  readonly funding:
    | Promise<LifecycleFundingSuffix<TJob> | undefined>
    | undefined;
  readonly timeoutMs: number;
}): Promise<LifecycleFundingSuperset<TJob>> {
  const fallback = (
    reason: NonNullable<LifecycleFundingSuperset<TJob>["reason"]>,
  ): LifecycleFundingSuperset<TJob> => ({
    jobs: parameters.lifecycleJobs,
    minimumViablePrefix: parameters.lifecycleMinimumViablePrefix,
    enriched: false,
    reason,
  });
  const finalLifecycleJob = parameters.lifecycleJobs.at(-1);
  const settlesLifecycle =
    finalLifecycleJob?.kind === "pool_settle" ||
    finalLifecycleJob?.kind === "pool_settle_forced_eth";
  if (!settlesLifecycle) {
    return fallback("lifecycle_settle_missing");
  }
  if (parameters.funding === undefined || parameters.timeoutMs < 0) {
    return fallback("funding_unavailable");
  }

  let timeout: number | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timeout = setTimeout(resolve, parameters.timeoutMs);
  });
  let funding: LifecycleFundingSuffix<TJob> | undefined;
  try {
    funding = await Promise.race([
      parameters.funding.catch(() => undefined),
      timedOut,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (funding === undefined) {
    return fallback("funding_unavailable");
  }
  if (
    funding.headBlockNumber !== parameters.headBlockNumber ||
    funding.fundingRoundId !== parameters.fundingRoundId
  ) {
    return fallback("funding_stale");
  }

  const cranks: TJob[] = [];
  let pull: TJob | undefined;
  for (let index = 0; index < funding.jobs.length; index += 1) {
    const job = funding.jobs[index]!;
    if (job.kind === "standing_order" && pull === undefined) {
      cranks.push(job);
      continue;
    }
    if (
      job.kind === "pool_pull" &&
      pull === undefined &&
      index === funding.jobs.length - 1 &&
      job.roundId === parameters.fundingRoundId
    ) {
      pull = job;
      continue;
    }
    return fallback("funding_suffix_invalid");
  }
  const safePull = funding.coverageSatisfied ? pull : undefined;
  const suffix = [...cranks, ...(safePull === undefined ? [] : [safePull])];
  if (suffix.length === 0) {
    return fallback("funding_empty");
  }
  return {
    jobs: [...parameters.lifecycleJobs, ...suffix],
    minimumViablePrefix: parameters.lifecycleMinimumViablePrefix,
    enriched: true,
  };
}

/**
 * PullPool may open and fund a newer round while one earlier acquisition is
 * still resolving. `roundCount` identifies the funding round, while
 * `ethPendingRound` is the authoritative lifecycle pointer.
 */
export function routeRoundIds(parameters: {
  readonly roundCount: bigint;
  readonly ethPendingRound: bigint;
}): RoundRouting {
  if (parameters.roundCount < 0n || parameters.ethPendingRound < 0n) {
    throw new Error("round identifiers cannot be negative");
  }
  return {
    ...(parameters.roundCount === 0n
      ? {}
      : { fundingRoundId: parameters.roundCount }),
    ...(parameters.ethPendingRound === 0n
      ? {}
      : { lifecycleRoundId: parameters.ethPendingRound }),
  };
}

export interface PoolBountyTerms {
  readonly crankBountyCap: bigint;
  readonly bountyTipWei: bigint;
}

export function estimatePoolBounty(parameters: {
  readonly gasUsed: bigint;
  readonly baseFeePerGas: bigint;
  readonly terms: PoolBountyTerms;
  readonly estimateBps: bigint;
}): bigint {
  if (parameters.gasUsed < 0n) {
    throw new Error("gasUsed cannot be negative");
  }
  if (
    parameters.estimateBps < 0n ||
    parameters.estimateBps > BPS
  ) {
    throw new Error("estimateBps must be between 0 and 10000");
  }

  const reimbursedGas =
    (parameters.gasUsed * parameters.estimateBps) / BPS;
  const due =
    reimbursedGas *
    (parameters.baseFeePerGas + parameters.terms.bountyTipWei);
  return due < parameters.terms.crankBountyCap
    ? due
    : parameters.terms.crankBountyCap;
}

export function buybackCallerReward(parameters: {
  readonly tokenEthBalance: bigint;
  readonly buybackIncrement: bigint;
  readonly callerRewardBps: bigint;
}): bigint {
  if (
    parameters.tokenEthBalance < 0n ||
    parameters.buybackIncrement < 0n ||
    parameters.callerRewardBps < 0n ||
    parameters.callerRewardBps > BPS
  ) {
    throw new Error("invalid buyback reward parameters");
  }
  const slice =
    parameters.tokenEthBalance < parameters.buybackIncrement
      ? parameters.tokenEthBalance
      : parameters.buybackIncrement;
  return (slice * parameters.callerRewardBps) / BPS;
}

export interface LiveBidSweepQuote {
  readonly eligible: boolean;
  readonly rewardWei: bigint;
  readonly toForwardWei: bigint;
  readonly reason?: "cooldown" | "no_eth" | "no_reward";
}

/**
 * Mirrors LiveBidAdapter.sweep(): below the activation threshold it fills as
 * quickly as possible, while at/above the threshold it applies a block
 * cooldown and per-call cap. The caller reward is either carved from the
 * forward or, on an exact threshold landing, paid from the remaining buffer.
 */
export function quoteLiveBidSweep(parameters: {
  readonly adapterBalanceWei: bigint;
  readonly patronBalanceWei: bigint;
  readonly activationThresholdWei: bigint;
  readonly currentBlock: bigint;
  readonly lastSweepBlock: bigint;
  readonly minBlocksBetweenSweeps: bigint;
  readonly maxSweepWei: bigint;
  readonly keeperRewardBps: bigint;
  readonly keeperRewardCapWei: bigint;
}): LiveBidSweepQuote {
  const values = [
    parameters.adapterBalanceWei,
    parameters.patronBalanceWei,
    parameters.activationThresholdWei,
    parameters.currentBlock,
    parameters.lastSweepBlock,
    parameters.minBlocksBetweenSweeps,
    parameters.maxSweepWei,
    parameters.keeperRewardBps,
    parameters.keeperRewardCapWei,
  ];
  if (
    values.some((value) => value < 0n) ||
    parameters.keeperRewardBps > BPS
  ) {
    throw new Error("invalid live bid sweep parameters");
  }
  if (parameters.adapterBalanceWei === 0n) {
    return {
      eligible: false,
      rewardWei: 0n,
      toForwardWei: 0n,
      reason: "no_eth",
    };
  }

  const throttled =
    parameters.patronBalanceWei >=
    parameters.activationThresholdWei;
  let toForwardWei: bigint;
  let fillToThreshold = false;
  if (throttled) {
    const nextBlock =
      parameters.lastSweepBlock +
      parameters.minBlocksBetweenSweeps;
    if (parameters.currentBlock < nextBlock) {
      return {
        eligible: false,
        rewardWei: 0n,
        toForwardWei: 0n,
        reason: "cooldown",
      };
    }
    toForwardWei =
      parameters.adapterBalanceWei < parameters.maxSweepWei
        ? parameters.adapterBalanceWei
        : parameters.maxSweepWei;
  } else {
    const room =
      parameters.activationThresholdWei -
      parameters.patronBalanceWei;
    if (parameters.adapterBalanceWei < room) {
      toForwardWei = parameters.adapterBalanceWei;
    } else {
      toForwardWei = room;
      fillToThreshold = true;
    }
  }

  let rewardWei =
    (toForwardWei * parameters.keeperRewardBps) / BPS;
  if (rewardWei > parameters.keeperRewardCapWei) {
    rewardWei = parameters.keeperRewardCapWei;
  }
  if (fillToThreshold) {
    const remainder =
      parameters.adapterBalanceWei - toForwardWei;
    if (rewardWei > remainder) rewardWei = remainder;
  } else if (rewardWei >= toForwardWei) {
    rewardWei = 0n;
  }

  return rewardWei === 0n
    ? {
        eligible: false,
        rewardWei,
        toForwardWei,
        reason: "no_reward",
      }
    : { eligible: true, rewardWei, toForwardWei };
}

/**
 * Recovers the caller reward from a successful eth_call simulation. `sweep`
 * returns the actual ETH forwarded after its internal threshold sync, which
 * makes this safer than predicting that sync from separately read state.
 */
export function liveBidSweepRewardFromSimulation(parameters: {
  readonly adapterBalanceWei: bigint;
  readonly ethForwardedWei: bigint;
  readonly maxSweepWei: bigint;
  readonly keeperRewardBps: bigint;
  readonly keeperRewardCapWei: bigint;
}): bigint {
  if (
    parameters.adapterBalanceWei < 0n ||
    parameters.ethForwardedWei < 0n ||
    parameters.maxSweepWei < 0n ||
    parameters.keeperRewardBps < 0n ||
    parameters.keeperRewardBps > BPS ||
    parameters.keeperRewardCapWei < 0n ||
    parameters.ethForwardedWei > parameters.adapterBalanceWei
  ) {
    throw new Error("invalid live bid sweep simulation");
  }

  const possibleToForward = [
    parameters.adapterBalanceWei,
    parameters.adapterBalanceWei < parameters.maxSweepWei
      ? parameters.adapterBalanceWei
      : parameters.maxSweepWei,
  ];
  for (const toForwardWei of possibleToForward) {
    let rewardWei =
      (toForwardWei * parameters.keeperRewardBps) / BPS;
    if (rewardWei > parameters.keeperRewardCapWei) {
      rewardWei = parameters.keeperRewardCapWei;
    }
    if (rewardWei >= toForwardWei) rewardWei = 0n;
    if (
      toForwardWei - rewardWei ===
      parameters.ethForwardedWei
    ) {
      return rewardWei;
    }
  }

  let fillRewardWei =
    (parameters.ethForwardedWei *
      parameters.keeperRewardBps) /
    BPS;
  if (fillRewardWei > parameters.keeperRewardCapWei) {
    fillRewardWei = parameters.keeperRewardCapWei;
  }
  const remainderWei =
    parameters.adapterBalanceWei -
    parameters.ethForwardedWei;
  if (fillRewardWei > remainderWei) {
    fillRewardWei = remainderWei;
  }
  return fillRewardWei;
}

export interface CoverageOrder {
  readonly address: Address;
  readonly tickets: bigint;
  readonly rewardWei: bigint;
  readonly gasCostWei: bigint;
}

interface CoverageState {
  readonly coverage: bigint;
  readonly netCostWei: bigint;
  readonly selected: readonly CoverageOrder[];
}

function betterCoverageState(
  candidate: CoverageState,
  existing: CoverageState | undefined,
): boolean {
  if (existing === undefined) return true;
  if (candidate.netCostWei !== existing.netCostWei) {
    return candidate.netCostWei < existing.netCostWei;
  }
  const candidateAddresses = candidate.selected
    .map((order) => order.address)
    .join(",");
  const existingAddresses = existing.selected
    .map((order) => order.address)
    .join(",");
  return candidateAddresses < existingAddresses;
}

/**
 * Finds the least net-cost subset that reaches the current round's remaining
 * ticket requirement. Coverage is capped at `ticketsNeeded`, keeping the
 * dynamic-programming state bounded even for large orders.
 */
export function selectOrdersForCoverage(parameters: {
  readonly orders: readonly CoverageOrder[];
  readonly ticketsNeeded: bigint;
  readonly maxOrders: number;
}): readonly CoverageOrder[] | undefined {
  if (parameters.ticketsNeeded <= 0n) return [];
  if (parameters.maxOrders <= 0) return undefined;

  let states = new Map<string, CoverageState>();
  states.set("0:0", {
    coverage: 0n,
    netCostWei: 0n,
    selected: [],
  });

  for (const order of parameters.orders) {
    if (order.tickets <= 0n) continue;
    const next = new Map(states);
    for (const state of states.values()) {
      // A covering prefix closes the round. Appending another crank would
      // revert, even when that extra order would look profitable in isolation.
      if (state.coverage === parameters.ticketsNeeded) continue;
      if (state.selected.length >= parameters.maxOrders) continue;
      const coverage =
        state.coverage + order.tickets >= parameters.ticketsNeeded
          ? parameters.ticketsNeeded
          : state.coverage + order.tickets;
      const candidate: CoverageState = {
        coverage,
        netCostWei:
          state.netCostWei + order.gasCostWei - order.rewardWei,
        selected: [...state.selected, order],
      };
      const key = `${coverage}:${candidate.selected.length}`;
      if (betterCoverageState(candidate, next.get(key))) {
        next.set(key, candidate);
      }
    }
    states = next;
  }

  let best: CoverageState | undefined;
  for (const state of states.values()) {
    if (state.coverage !== parameters.ticketsNeeded) continue;
    if (
      best === undefined ||
      state.netCostWei < best.netCostWei ||
      (state.netCostWei === best.netCostWei &&
        state.selected.length < best.selected.length)
    ) {
      best = state;
    }
  }
  return best?.selected;
}
