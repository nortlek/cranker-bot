import { requiredProfit } from "./economics.js";

export interface CompetitiveFeeQuote {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly desiredBuilderPayment: bigint;
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

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
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
  }[],
): bigint {
  let totalReward = 0n;
  let desiredBuilderPayment = 0n;
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
  }
  if (totalReward === 0n) return 0n;
  return ceilDivide(
    desiredBuilderPayment * 10_000n,
    totalReward,
  );
}

/**
 * Converts a percentage of the successful crank fee into an EIP-1559 tip.
 * Flashbots builders compare the value they receive, not the keeper's gross
 * profit, so a static sub-gwei floor is rarely a competitive bid.
 */
export function quoteCompetitiveFees(parameters: {
  readonly crankFee: bigint;
  readonly simulatedGasUsed: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly minimumPriorityFeePerGas: bigint;
  readonly builderBidBps: bigint;
  readonly maxFeePerGasCap: bigint;
  readonly minProfitWei: bigint;
}): CompetitiveFeeQuote {
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
    parameters.maxFeePerGasCap -
    parameters.baseFeeAllowancePerGas;
  const maximumPriorityFeePerGas =
    profitCappedPriorityFeePerGas < feeCappedPriorityFeePerGas
      ? profitCappedPriorityFeePerGas
      : feeCappedPriorityFeePerGas;

  if (
    maximumPriorityFeePerGas <
    parameters.minimumPriorityFeePerGas
  ) {
    const cappedByFeeCap =
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
      effectiveBuilderBidBps:
        parameters.crankFee === 0n
          ? 0n
          : ceilDivide(builderPayment * 10_000n, parameters.crankFee),
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
    profitCappedPriorityFeePerGas <= feeCappedPriorityFeePerGas;
  const cappedByFeeCap =
    maxPriorityFeePerGas < requestedPriorityFeePerGas &&
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
      effectiveBuilderBidBps:
        parameters.crankFee === 0n
          ? 0n
          : ceilDivide(builderPayment * 10_000n, parameters.crankFee),
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
    effectiveBuilderBidBps:
      parameters.crankFee === 0n
        ? 0n
        : ceilDivide(builderPayment * 10_000n, parameters.crankFee),
    cappedByProfit,
    cappedByFeeCap,
    profitable: true,
  };
}
