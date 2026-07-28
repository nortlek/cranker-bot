export interface ProfitInputs {
  readonly crankFee: bigint;
  readonly estimatedGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
  readonly minProfitBps: bigint;
}

export interface ProfitDecision {
  readonly profitable: boolean;
  readonly gasLimit: bigint;
  readonly maxGasCost: bigint;
  readonly maxProfit: bigint;
  readonly requiredProfit: bigint;
}

const BPS = 10_000n;

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
  const relativeFloor =
    (inputs.crankFee * inputs.minProfitBps + BPS - 1n) / BPS;
  const requiredProfit =
    relativeFloor > inputs.minProfitWei
      ? relativeFloor
      : inputs.minProfitWei;

  return {
    profitable: maxProfit >= requiredProfit,
    gasLimit,
    maxGasCost,
    maxProfit,
    requiredProfit,
  };
}
