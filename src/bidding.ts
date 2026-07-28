export interface CompetitiveFeeQuote {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly builderPayment: bigint;
  readonly expectedGasCost: bigint;
  readonly expectedProfit: bigint;
  readonly requiredProfit: bigint;
  readonly profitable: boolean;
  readonly reason?: "fee_cap" | "profit_floor";
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
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
  readonly minProfitBps: bigint;
}): CompetitiveFeeQuote {
  if (parameters.simulatedGasUsed <= 0n) {
    throw new Error("simulatedGasUsed must be positive");
  }

  const desiredBuilderPayment =
    (parameters.crankFee * parameters.builderBidBps) / 10_000n;
  const bidPriorityFee = ceilDivide(
    desiredBuilderPayment,
    parameters.simulatedGasUsed,
  );
  const maxPriorityFeePerGas =
    bidPriorityFee > parameters.minimumPriorityFeePerGas
      ? bidPriorityFee
      : parameters.minimumPriorityFeePerGas;
  const maxFeePerGas =
    parameters.baseFeeAllowancePerGas + maxPriorityFeePerGas;
  const builderPayment =
    maxPriorityFeePerGas * parameters.simulatedGasUsed;
  const expectedGasCost =
    maxFeePerGas * parameters.simulatedGasUsed;
  const relativeProfit =
    (parameters.crankFee * parameters.minProfitBps) / 10_000n;
  const requiredProfit =
    relativeProfit > parameters.minProfitWei
      ? relativeProfit
      : parameters.minProfitWei;
  const expectedProfit = parameters.crankFee - expectedGasCost;

  if (maxFeePerGas > parameters.maxFeePerGasCap) {
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      builderPayment,
      expectedGasCost,
      expectedProfit,
      requiredProfit,
      profitable: false,
      reason: "fee_cap",
    };
  }
  if (expectedProfit < requiredProfit) {
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      builderPayment,
      expectedGasCost,
      expectedProfit,
      requiredProfit,
      profitable: false,
      reason: "profit_floor",
    };
  }
  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
    builderPayment,
    expectedGasCost,
    expectedProfit,
    requiredProfit,
    profitable: true,
  };
}
