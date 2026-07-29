export interface ProfitInputs {
  readonly crankFee: bigint;
  readonly estimatedGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
}

export interface ProfitDecision {
  readonly profitable: boolean;
  readonly gasLimit: bigint;
  readonly maxGasCost: bigint;
  readonly maxProfit: bigint;
  readonly requiredProfit: bigint;
}

export interface EstimatedPrefixComponent {
  readonly rewardWei: bigint;
  readonly maxGasCostWei: bigint;
}

export interface EstimatedPrefixSelection {
  readonly length: number;
  readonly grossRewardWei: bigint;
  readonly maxGasCostWei: bigint;
  readonly expectedProfitWei: bigint;
}

const BPS = 10_000n;
const MINIMUM_POSITIVE_PROFIT = 1n;

export function requiredProfit(minProfitWei: bigint): bigint {
  return minProfitWei > MINIMUM_POSITIVE_PROFIT
    ? minProfitWei
    : MINIMUM_POSITIVE_PROFIT;
}

export function bufferedGas(
  estimatedGas: bigint,
  multiplierBps: bigint,
): bigint {
  if (estimatedGas < 0n) throw new Error("estimatedGas cannot be negative");
  if (multiplierBps < BPS) {
    throw new Error("gas multiplier cannot be below 10000 bps");
  }
  return (estimatedGas * multiplierBps + BPS - 1n) / BPS;
}

export function assessProfit(inputs: ProfitInputs): ProfitDecision {
  const gasLimit = bufferedGas(
    inputs.estimatedGas,
    inputs.gasLimitMultiplierBps,
  );
  const maxGasCost = gasLimit * inputs.maxFeePerGas;
  const maxProfit = inputs.crankFee - maxGasCost;
  const profitFloor = requiredProfit(inputs.minProfitWei);

  return {
    profitable: maxProfit >= profitFloor,
    gasLimit,
    maxGasCost,
    maxProfit,
    requiredProfit: profitFloor,
  };
}

/**
 * Selects the dependency-safe prefix with the greatest conservative estimated
 * profit. This is only a preliminary admission gate; private submission still
 * exact-simulates and reprices every safe prefix.
 */
export function selectMostProfitableEstimatedPrefix(parameters: {
  readonly components: readonly EstimatedPrefixComponent[];
  readonly minimumViablePrefix: number;
  readonly minProfitWei: bigint;
}): EstimatedPrefixSelection | undefined {
  if (
    parameters.minimumViablePrefix < 1 ||
    parameters.minimumViablePrefix > parameters.components.length
  ) {
    return undefined;
  }
  const profitFloor = requiredProfit(parameters.minProfitWei);
  let grossRewardWei = 0n;
  let maxGasCostWei = 0n;
  let best: EstimatedPrefixSelection | undefined;

  for (
    let index = 0;
    index < parameters.components.length;
    index += 1
  ) {
    const component = parameters.components[index]!;
    if (component.rewardWei < 0n) {
      throw new Error("prefix reward cannot be negative");
    }
    if (component.maxGasCostWei < 0n) {
      throw new Error("prefix gas cost cannot be negative");
    }
    grossRewardWei += component.rewardWei;
    maxGasCostWei += component.maxGasCostWei;

    const length = index + 1;
    if (length < parameters.minimumViablePrefix) continue;
    const expectedProfitWei = grossRewardWei - maxGasCostWei;
    if (expectedProfitWei < profitFloor) continue;
    if (
      best === undefined ||
      expectedProfitWei > best.expectedProfitWei
    ) {
      best = {
        length,
        grossRewardWei,
        maxGasCostWei,
        expectedProfitWei,
      };
    }
  }
  return best;
}
