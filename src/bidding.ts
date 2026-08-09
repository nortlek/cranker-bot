import { requiredProfit } from "./economics.js";

export interface CompetitiveFeeQuote {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly desiredBuilderPayment: bigint;
  readonly priorityBuilderPayment: bigint;
  readonly directBuilderPayment: bigint;
  readonly directPaymentGasUsed: bigint;
  readonly builderPayment: bigint;
  readonly expectedGasCost: bigint;
  readonly expectedProfit: bigint;
  readonly requiredProfit: bigint;
  readonly effectiveBuilderBidBps: bigint;
  readonly cappedByProfit: boolean;
  readonly cappedByFeeCap: boolean;
  readonly profitable: boolean;
  readonly reason?: "fee_cap" | "profit_floor";
}

export interface CompetitivePrefixComponent {
  readonly rewardWei: bigint;
  readonly gasUsed: bigint;
  readonly builderBidBps: bigint;
  readonly minimumPriorityFeePerGas: bigint;
  /**
   * A lane-specific floor against the aggregate reward of every prefix that
   * contains this component. This lets a pull controller price a mixed
   * lifecycle/pull bundle against the same total payment a builder observes
   * without rewriting the lifecycle components' independent policies.
   */
  readonly minimumAggregateBuilderBidBps?: bigint;
  /** Ignore the configured fee ceiling and retain only the profit floor. */
  readonly profitabilityOnly?: boolean;
}

export interface CompetitivePrefixSelection {
  readonly length: number;
  readonly grossReward: bigint;
  readonly totalGasUsed: bigint;
  readonly builderBidBps: bigint;
  readonly minimumPriorityFeePerGas: bigint;
  readonly quote: CompetitiveFeeQuote;
}

export interface ObservedBuilderPaymentComparison {
  readonly requiredBuilderPayment: bigint;
  readonly additionalBuilderPaymentRequired: bigint;
  readonly requiredBidBpsAgainstPlannedGross: bigint;
  readonly counterfactualExpectedProfit: bigint;
  readonly requiredProfit: bigint;
  readonly profitable: boolean;
}

export interface IndependentPriorityFeeAllocation {
  readonly priorityFeesPerGas: readonly bigint[];
  readonly priorityBuilderPayment: bigint;
  readonly expectedGasCost: bigint;
  readonly expectedProfit: bigint;
  readonly requiredProfit: bigint;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function effectiveBuilderBidBps(
  builderPayment: bigint,
  grossReward: bigint,
): bigint {
  if (builderPayment < 0n || grossReward < 0n) {
    throw new Error(
      "builder payment and gross reward cannot be negative",
    );
  }
  return grossReward === 0n
    ? 0n
    : ceilDivide(builderPayment * 10_000n, grossReward);
}

/**
 * Attributes a shared priority fee to each standing order using that
 * transaction's exact simulated gas and reward. A bundle-wide effective bid
 * is not valid per-target evidence when rewards or gas differ.
 */
export function attributePriorityBidsByOrder(
  components: readonly {
    readonly order: string;
    readonly rewardWei: bigint;
    readonly gasUsed: bigint;
    readonly priorityFeePerGas?: bigint;
  }[],
  priorityFeePerGas: bigint,
): ReadonlyMap<string, bigint> {
  if (priorityFeePerGas < 0n) {
    throw new Error("priorityFeePerGas cannot be negative");
  }
  const attributed = new Map<string, bigint>();
  for (const component of components) {
    if (component.rewardWei <= 0n) {
      throw new Error("order rewardWei must be positive");
    }
    if (component.gasUsed <= 0n) {
      throw new Error("order gasUsed must be positive");
    }
    const componentPriorityFeePerGas =
      component.priorityFeePerGas ?? priorityFeePerGas;
    if (componentPriorityFeePerGas < 0n) {
      throw new Error("order priorityFeePerGas cannot be negative");
    }
    const key = component.order.toLowerCase();
    if (attributed.has(key)) {
      throw new Error(`duplicate standing order ${component.order}`);
    }
    attributed.set(
      key,
      effectiveBuilderBidBps(
        component.gasUsed * componentPriorityFeePerGas,
        component.rewardWei,
      ),
    );
  }
  return attributed;
}

/**
 * Prices independent transactions against their own reward-normalized bid.
 * A shared priority fee preserves only the aggregate payment and can
 * accidentally move value from a highly contested order to cheap orders in
 * the same batch. Return undefined when the exact per-component targets would
 * cross the configured fee boundary or the aggregate retained-profit floor;
 * callers can then use the ordinary aggregate profitability clamp.
 */
export function allocateIndependentPriorityFees(parameters: {
  readonly components: readonly {
    readonly rewardWei: bigint;
    readonly gasUsed: bigint;
    readonly builderBidBps: bigint;
    readonly minimumPriorityFeePerGas: bigint;
  }[];
  readonly baseFeeAllowancePerGas: bigint;
  readonly maxFeePerGasCap?: bigint;
  readonly minProfitWei: bigint;
}): IndependentPriorityFeeAllocation | undefined {
  if (parameters.components.length === 0) return undefined;
  if (parameters.baseFeeAllowancePerGas < 0n) {
    throw new Error("baseFeeAllowancePerGas cannot be negative");
  }

  const priorityFeesPerGas: bigint[] = [];
  let grossReward = 0n;
  let expectedGasCost = 0n;
  let priorityBuilderPayment = 0n;
  for (const component of parameters.components) {
    if (component.rewardWei <= 0n) {
      throw new Error("component rewardWei must be positive");
    }
    if (component.gasUsed <= 0n) {
      throw new Error("component gasUsed must be positive");
    }
    if (
      component.builderBidBps < 0n ||
      component.builderBidBps > 10_000n
    ) {
      throw new Error("component builderBidBps must be between 0 and 10000");
    }
    if (component.minimumPriorityFeePerGas < 0n) {
      throw new Error(
        "component minimumPriorityFeePerGas cannot be negative",
      );
    }
    const desiredBuilderPayment =
      (component.rewardWei * component.builderBidBps) / 10_000n;
    const requestedPriorityFeePerGas =
      desiredBuilderPayment === 0n
        ? component.minimumPriorityFeePerGas
        : ceilDivide(desiredBuilderPayment, component.gasUsed) >
            component.minimumPriorityFeePerGas
          ? ceilDivide(desiredBuilderPayment, component.gasUsed)
          : component.minimumPriorityFeePerGas;
    const maxFeePerGas =
      parameters.baseFeeAllowancePerGas + requestedPriorityFeePerGas;
    if (
      parameters.maxFeePerGasCap !== undefined &&
      maxFeePerGas > parameters.maxFeePerGasCap
    ) {
      return undefined;
    }
    priorityFeesPerGas.push(requestedPriorityFeePerGas);
    grossReward += component.rewardWei;
    priorityBuilderPayment +=
      requestedPriorityFeePerGas * component.gasUsed;
    expectedGasCost += maxFeePerGas * component.gasUsed;
  }

  const profitFloor = requiredProfit(parameters.minProfitWei);
  const expectedProfit = grossReward - expectedGasCost;
  if (expectedProfit < profitFloor) return undefined;
  return {
    priorityFeesPerGas,
    priorityBuilderPayment,
    expectedGasCost,
    expectedProfit,
    requiredProfit: profitFloor,
  };
}

/**
 * Re-prices our already simulated bundle against an observed absolute builder
 * payment. Competitor-normalized bid percentages are not comparable when its
 * realized pool reimbursement differs from our simulated reimbursement.
 */
export function compareObservedBuilderPayment(parameters: {
  readonly observedBuilderPayment: bigint;
  readonly plannedGrossReward: bigint;
  readonly plannedBuilderPayment: bigint;
  readonly plannedExpectedProfit: bigint;
  readonly minProfitWei: bigint;
}): ObservedBuilderPaymentComparison {
  if (
    parameters.observedBuilderPayment < 0n ||
    parameters.plannedGrossReward <= 0n ||
    parameters.plannedBuilderPayment < 0n ||
    parameters.minProfitWei < 0n
  ) {
    throw new Error(
      "observed-payment comparison requires nonnegative payments and a positive gross reward",
    );
  }
  const requiredBuilderPayment =
    parameters.observedBuilderPayment + 1n;
  const additionalBuilderPaymentRequired =
    requiredBuilderPayment > parameters.plannedBuilderPayment
      ? requiredBuilderPayment - parameters.plannedBuilderPayment
      : 0n;
  const counterfactualExpectedProfit =
    parameters.plannedExpectedProfit -
    additionalBuilderPaymentRequired;
  const profitFloor = requiredProfit(parameters.minProfitWei);
  return {
    requiredBuilderPayment,
    additionalBuilderPaymentRequired,
    requiredBidBpsAgainstPlannedGross:
      effectiveBuilderBidBps(
        requiredBuilderPayment,
        parameters.plannedGrossReward,
      ),
    counterfactualExpectedProfit,
    requiredProfit: profitFloor,
    profitable: counterfactualExpectedProfit >= profitFloor,
  };
}

/**
 * Produces one reward-weighted bid target for a bundle while preserving
 * distinct order and lifecycle policies. Zero-reward dependency calls add gas
 * but never inflate the desired builder payment.
 */
export function aggregateBuilderBidBps(
  components: readonly {
    readonly rewardWei: bigint;
    readonly builderBidBps: bigint;
    readonly minimumAggregateBuilderBidBps?: bigint;
  }[],
): bigint {
  let totalReward = 0n;
  let desiredBuilderPayment = 0n;
  let minimumAggregateBuilderBidBps = 0n;
  for (const component of components) {
    if (component.rewardWei < 0n) {
      throw new Error("rewardWei cannot be negative");
    }
    if (
      component.builderBidBps < 0n ||
      component.builderBidBps > 10_000n
    ) {
      throw new Error("builderBidBps must be between 0 and 10000");
    }
    totalReward += component.rewardWei;
    desiredBuilderPayment +=
      (component.rewardWei * component.builderBidBps) / 10_000n;
    const aggregateFloor =
      component.minimumAggregateBuilderBidBps ?? 0n;
    if (aggregateFloor < 0n || aggregateFloor > 10_000n) {
      throw new Error(
        "minimumAggregateBuilderBidBps must be between 0 and 10000",
      );
    }
    if (aggregateFloor > minimumAggregateBuilderBidBps) {
      minimumAggregateBuilderBidBps = aggregateFloor;
    }
  }
  if (totalReward === 0n) return 0n;
  const weightedBidBps = ceilDivide(
    desiredBuilderPayment * 10_000n,
    totalReward,
  );
  return weightedBidBps > minimumAggregateBuilderBidBps
    ? weightedBidBps
    : minimumAggregateBuilderBidBps;
}

/**
 * Converts a percentage of the successful crank fee into an EIP-1559 tip.
 * Flashbots builders compare the value they receive, not the keeper's gross
 * profit, so a static sub-gwei floor is rarely a competitive bid.
 */
function quotePriorityFees(parameters: {
  readonly crankFee: bigint;
  readonly simulatedGasUsed: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly minimumPriorityFeePerGas: bigint;
  readonly builderBidBps: bigint;
  readonly maxFeePerGasCap?: bigint;
  readonly minProfitWei: bigint;
}): Omit<
  CompetitiveFeeQuote,
  | "priorityBuilderPayment"
  | "directBuilderPayment"
  | "directPaymentGasUsed"
> {
  if (parameters.simulatedGasUsed <= 0n) {
    throw new Error("simulatedGasUsed must be positive");
  }

  const profitFloor = requiredProfit(parameters.minProfitWei);
  const baseGasCost =
    parameters.baseFeeAllowancePerGas * parameters.simulatedGasUsed;
  const desiredBuilderPayment =
    (parameters.crankFee * parameters.builderBidBps) / 10_000n;
  const bidPriorityFee = ceilDivide(
    desiredBuilderPayment,
    parameters.simulatedGasUsed,
  );
  const requestedPriorityFeePerGas =
    bidPriorityFee > parameters.minimumPriorityFeePerGas
      ? bidPriorityFee
      : parameters.minimumPriorityFeePerGas;

  const profitBudget =
    parameters.crankFee - baseGasCost - profitFloor;
  const profitCappedPriorityFeePerGas =
    profitBudget < 0n
      ? -1n
      : profitBudget / parameters.simulatedGasUsed;
  const feeCappedPriorityFeePerGas =
    parameters.maxFeePerGasCap === undefined
      ? undefined
      : parameters.maxFeePerGasCap -
        parameters.baseFeeAllowancePerGas;
  const maximumPriorityFeePerGas =
    feeCappedPriorityFeePerGas === undefined ||
    profitCappedPriorityFeePerGas < feeCappedPriorityFeePerGas
      ? profitCappedPriorityFeePerGas
      : feeCappedPriorityFeePerGas;

  if (
    maximumPriorityFeePerGas <
    parameters.minimumPriorityFeePerGas
  ) {
    const cappedByFeeCap =
      feeCappedPriorityFeePerGas !== undefined &&
      feeCappedPriorityFeePerGas < parameters.minimumPriorityFeePerGas;
    const maxPriorityFeePerGas =
      maximumPriorityFeePerGas > 0n ? maximumPriorityFeePerGas : 0n;
    const maxFeePerGas =
      parameters.baseFeeAllowancePerGas + maxPriorityFeePerGas;
    const builderPayment =
      maxPriorityFeePerGas * parameters.simulatedGasUsed;
    const expectedGasCost =
      maxFeePerGas * parameters.simulatedGasUsed;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      desiredBuilderPayment,
      builderPayment,
      expectedGasCost,
      expectedProfit: parameters.crankFee - expectedGasCost,
      requiredProfit: profitFloor,
      effectiveBuilderBidBps: effectiveBuilderBidBps(
        builderPayment,
        parameters.crankFee,
      ),
      cappedByProfit: !cappedByFeeCap,
      cappedByFeeCap,
      profitable: false,
      reason: cappedByFeeCap ? "fee_cap" : "profit_floor",
    };
  }

  const maxPriorityFeePerGas =
    requestedPriorityFeePerGas < maximumPriorityFeePerGas
      ? requestedPriorityFeePerGas
      : maximumPriorityFeePerGas;
  const cappedByProfit =
    maxPriorityFeePerGas < requestedPriorityFeePerGas &&
    (feeCappedPriorityFeePerGas === undefined ||
      profitCappedPriorityFeePerGas <=
        feeCappedPriorityFeePerGas);
  const cappedByFeeCap =
    maxPriorityFeePerGas < requestedPriorityFeePerGas &&
    feeCappedPriorityFeePerGas !== undefined &&
    feeCappedPriorityFeePerGas < profitCappedPriorityFeePerGas;
  const maxFeePerGas =
    parameters.baseFeeAllowancePerGas + maxPriorityFeePerGas;
  const builderPayment =
    maxPriorityFeePerGas * parameters.simulatedGasUsed;
  const expectedGasCost =
    maxFeePerGas * parameters.simulatedGasUsed;
  const expectedProfit = parameters.crankFee - expectedGasCost;
  if (expectedProfit < profitFloor) {
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      desiredBuilderPayment,
      builderPayment,
      expectedGasCost,
      expectedProfit,
      requiredProfit: profitFloor,
      effectiveBuilderBidBps: effectiveBuilderBidBps(
        builderPayment,
        parameters.crankFee,
      ),
      cappedByProfit,
      cappedByFeeCap,
      profitable: false,
      reason: "profit_floor",
    };
  }
  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
    desiredBuilderPayment,
    builderPayment,
    expectedGasCost,
    expectedProfit,
    requiredProfit: profitFloor,
    effectiveBuilderBidBps: effectiveBuilderBidBps(
      builderPayment,
      parameters.crankFee,
    ),
    cappedByProfit,
    cappedByFeeCap,
    profitable: true,
  };
}

/**
 * Prices a reward-producing bundle with an optional direct coinbase-payment
 * transaction. Direct payment is used only to fill a fee-cap-constrained bid;
 * it never raises the configured bid or consumes the retained-profit floor.
 */
export function quoteCompetitiveFees(parameters: {
  readonly crankFee: bigint;
  readonly simulatedGasUsed: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly minimumPriorityFeePerGas: bigint;
  readonly builderBidBps: bigint;
  readonly maxFeePerGasCap?: bigint;
  readonly minProfitWei: bigint;
  readonly directPaymentGasUsed?: bigint;
}): CompetitiveFeeQuote {
  const priorityQuote = quotePriorityFees(parameters);
  const withoutDirectPayment: CompetitiveFeeQuote = {
    ...priorityQuote,
    priorityBuilderPayment: priorityQuote.builderPayment,
    directBuilderPayment: 0n,
    directPaymentGasUsed: 0n,
  };
  const directPaymentGasUsed =
    parameters.directPaymentGasUsed;
  if (
    directPaymentGasUsed === undefined ||
    !priorityQuote.profitable ||
    !priorityQuote.cappedByFeeCap ||
    priorityQuote.builderPayment >=
      priorityQuote.desiredBuilderPayment
  ) {
    return withoutDirectPayment;
  }
  if (directPaymentGasUsed <= 0n) {
    throw new Error("directPaymentGasUsed must be positive");
  }

  const profitFloor = priorityQuote.requiredProfit;
  // Once the exact direct-payment helper is required, leave only the
  // configured minimum in the priority fee and express the rest through the
  // helper value. Some relay simulators price the immediate child against the
  // parent's higher base fee while publishing a decreasing child. A
  // fee-cap-saturated priority payment then appears smaller in coinbaseDiff
  // even though the exact target block would pay the intended priority. The
  // helper's ethSentToCoinbase is base-fee invariant.
  const priorityBuilderPayment =
    parameters.simulatedGasUsed *
    parameters.minimumPriorityFeePerGas;
  const totalBaseGasCost =
    parameters.baseFeeAllowancePerGas *
    (parameters.simulatedGasUsed + directPaymentGasUsed);
  const maximumBuilderPayment =
    parameters.crankFee - totalBaseGasCost - profitFloor;
  if (maximumBuilderPayment <= priorityBuilderPayment) {
    return withoutDirectPayment;
  }
  const requestedBuilderPayment =
    priorityQuote.desiredBuilderPayment > priorityBuilderPayment
      ? priorityQuote.desiredBuilderPayment
      : priorityBuilderPayment;
  const builderPayment =
    requestedBuilderPayment < maximumBuilderPayment
      ? requestedBuilderPayment
      : maximumBuilderPayment;
  const directBuilderPayment =
    builderPayment - priorityBuilderPayment;
  if (directBuilderPayment <= 0n) {
    return withoutDirectPayment;
  }
  const expectedGasCost =
    totalBaseGasCost + builderPayment;
  const expectedProfit =
    parameters.crankFee - expectedGasCost;
  const {
    reason: _priorityReason,
    ...priorityQuoteWithoutReason
  } = priorityQuote;
  const profitable = expectedProfit >= profitFloor;

  return {
    ...priorityQuoteWithoutReason,
    maxPriorityFeePerGas:
      parameters.minimumPriorityFeePerGas,
    priorityBuilderPayment,
    directBuilderPayment,
    directPaymentGasUsed,
    builderPayment,
    expectedGasCost,
    expectedProfit,
    effectiveBuilderBidBps: effectiveBuilderBidBps(
      builderPayment,
      parameters.crankFee,
    ),
    cappedByProfit:
      builderPayment < requestedBuilderPayment,
    cappedByFeeCap: false,
    profitable,
    ...(profitable
      ? {}
      : { reason: "profit_floor" as const }),
  };
}

/**
 * Selects independent jobs whose exact requested bid can be paid while each
 * job retains its own profit floor. Aggregate profitability must never
 * cross-subsidize a losing standalone transaction.
 */
export function fullyAffordableIndependentComponentIndexes(parameters: {
  readonly components: readonly CompetitivePrefixComponent[];
  readonly baseFeeAllowancePerGas: bigint;
  readonly maxFeePerGasCap?: bigint;
  readonly minProfitWei: bigint;
  /** Gas required when a retained component becomes the first transaction. */
  readonly leadingGasUsed?: bigint;
}): readonly number[] {
  const affordableIndexes = parameters.components.flatMap(
    (component, index) => {
      const quote = quoteCompetitiveFees({
        crankFee: component.rewardWei,
        simulatedGasUsed: component.gasUsed,
        baseFeeAllowancePerGas:
          parameters.baseFeeAllowancePerGas,
        minimumPriorityFeePerGas:
          component.minimumPriorityFeePerGas,
        builderBidBps: component.builderBidBps,
        ...(parameters.maxFeePerGasCap === undefined
          ? {}
          : { maxFeePerGasCap: parameters.maxFeePerGasCap }),
        minProfitWei: parameters.minProfitWei,
      });
      return quote.profitable &&
        !quote.cappedByProfit &&
        !quote.cappedByFeeCap
        ? [index]
        : [];
    },
  );

  if (parameters.leadingGasUsed === undefined) {
    return affordableIndexes;
  }

  while (affordableIndexes.length > 0) {
    const leadingIndex = affordableIndexes[0];
    const leadingComponent =
      leadingIndex === undefined
        ? undefined
        : parameters.components[leadingIndex];
    if (leadingComponent === undefined) break;
    const quote = quoteCompetitiveFees({
      crankFee: leadingComponent.rewardWei,
      simulatedGasUsed:
        parameters.leadingGasUsed > leadingComponent.gasUsed
          ? parameters.leadingGasUsed
          : leadingComponent.gasUsed,
      baseFeeAllowancePerGas: parameters.baseFeeAllowancePerGas,
      minimumPriorityFeePerGas:
        leadingComponent.minimumPriorityFeePerGas,
      builderBidBps: leadingComponent.builderBidBps,
      ...(parameters.maxFeePerGasCap === undefined
        ? {}
        : { maxFeePerGasCap: parameters.maxFeePerGasCap }),
      minProfitWei: parameters.minProfitWei,
    });
    if (
      quote.profitable &&
      !quote.cappedByProfit &&
      !quote.cappedByFeeCap
    ) {
      return affordableIndexes;
    }
    affordableIndexes.shift();
  }
  return affordableIndexes;
}

/**
 * Selects the best contiguous, dependency-safe prefix after exact simulated
 * gas and the prefix's reward-weighted builder policy. Retained profit wins
 * normally. When both candidates are clamped to the retained-profit floor,
 * their tiny profit difference is only integer fee-rate rounding; prefer the
 * larger absolute builder payment so a low-fee suffix strengthens rather than
 * weakens the bundle's auction bid. Shorter prefixes still win exact ties.
 */
export function selectMostProfitablePrefix(parameters: {
  readonly components: readonly CompetitivePrefixComponent[];
  readonly minimumViablePrefix: number;
  readonly baseFeeAllowancePerGas: bigint;
  readonly maxFeePerGasCap: bigint;
  readonly minProfitWei: bigint;
  readonly directPaymentGasUsed?: bigint;
}): CompetitivePrefixSelection | undefined {
  if (
    parameters.minimumViablePrefix < 1 ||
    parameters.minimumViablePrefix > parameters.components.length
  ) {
    return undefined;
  }

  let grossReward = 0n;
  let totalGasUsed = 0n;
  let minimumPriorityFeePerGas = 0n;
  let profitabilityOnly = false;
  const bidComponents: Array<{
    rewardWei: bigint;
    builderBidBps: bigint;
    minimumAggregateBuilderBidBps?: bigint;
  }> = [];
  let best: CompetitivePrefixSelection | undefined;

  for (
    let index = 0;
    index < parameters.components.length;
    index += 1
  ) {
    const component = parameters.components[index]!;
    if (component.gasUsed <= 0n) {
      throw new Error("component gasUsed must be positive");
    }
    if (component.minimumPriorityFeePerGas < 0n) {
      throw new Error(
        "component minimumPriorityFeePerGas cannot be negative",
      );
    }
    grossReward += component.rewardWei;
    totalGasUsed += component.gasUsed;
    bidComponents.push({
      rewardWei: component.rewardWei,
      builderBidBps: component.builderBidBps,
      ...(component.minimumAggregateBuilderBidBps === undefined
        ? {}
        : {
            minimumAggregateBuilderBidBps:
              component.minimumAggregateBuilderBidBps,
          }),
    });
    profitabilityOnly ||= component.profitabilityOnly === true;
    if (
      component.minimumPriorityFeePerGas >
      minimumPriorityFeePerGas
    ) {
      minimumPriorityFeePerGas =
        component.minimumPriorityFeePerGas;
    }

    const length = index + 1;
    if (length < parameters.minimumViablePrefix) continue;
    const builderBidBps = aggregateBuilderBidBps(bidComponents);
    const quote = quoteCompetitiveFees({
      crankFee: grossReward,
      simulatedGasUsed: totalGasUsed,
      baseFeeAllowancePerGas:
        parameters.baseFeeAllowancePerGas,
      minimumPriorityFeePerGas,
      builderBidBps,
      ...(profitabilityOnly
        ? {}
        : { maxFeePerGasCap: parameters.maxFeePerGasCap }),
      minProfitWei: parameters.minProfitWei,
      ...(parameters.directPaymentGasUsed === undefined
        ? {}
        : {
            directPaymentGasUsed:
              parameters.directPaymentGasUsed,
          }),
    });
    if (!quote.profitable) continue;
    const betterThanBest =
      best === undefined ||
      (quote.cappedByProfit && best.quote.cappedByProfit
        ? quote.builderPayment > best.quote.builderPayment ||
          (quote.builderPayment === best.quote.builderPayment &&
            quote.expectedProfit > best.quote.expectedProfit)
        : quote.expectedProfit > best.quote.expectedProfit);
    if (betterThanBest) {
      best = {
        length,
        grossReward,
        totalGasUsed,
        builderBidBps,
        minimumPriorityFeePerGas,
        quote,
      };
    }
  }

  return best;
}
