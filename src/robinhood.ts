export const ROBINHOOD_CHAIN_ID = 4_663;
export const STONKPIT_BPS_DENOMINATOR = 10_000n;

export interface StonkPitCrankEconomicsInput {
  readonly ethTotal: bigint;
  readonly tipBps: bigint;
  readonly gas: bigint;
  readonly gasPrice: bigint;
  readonly minProfitWei?: bigint;
}

export interface StonkPitCrankEconomics {
  readonly tip: bigint;
  readonly gasCost: bigint;
  readonly netProfit: bigint;
  readonly requiredProfit: bigint;
  readonly profitable: boolean;
  readonly minimumEthTotal: bigint;
}

function divideCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("denominator must be positive");
  }
  return (numerator + denominator - 1n) / denominator;
}

export function assessStonkPitCrank(
  input: StonkPitCrankEconomicsInput,
): StonkPitCrankEconomics {
  if (input.ethTotal < 0n) throw new Error("ethTotal cannot be negative");
  if (input.tipBps <= 0n || input.tipBps > STONKPIT_BPS_DENOMINATOR) {
    throw new Error("tipBps must be between 1 and 10,000");
  }
  if (input.gas < 0n) throw new Error("gas cannot be negative");
  if (input.gasPrice < 0n) throw new Error("gasPrice cannot be negative");
  const minProfitWei = input.minProfitWei ?? 0n;
  if (minProfitWei < 0n) {
    throw new Error("minProfitWei cannot be negative");
  }

  const tip =
    (input.ethTotal * input.tipBps) / STONKPIT_BPS_DENOMINATOR;
  const gasCost = input.gas * input.gasPrice;
  const netProfit = tip - gasCost;
  const requiredProfit = minProfitWei > 0n ? minProfitWei : 1n;
  const minimumTip = gasCost + requiredProfit;
  const minimumEthTotal = divideCeil(
    minimumTip * STONKPIT_BPS_DENOMINATOR,
    input.tipBps,
  );

  return {
    tip,
    gasCost,
    netProfit,
    requiredProfit,
    profitable: netProfit >= requiredProfit,
    minimumEthTotal,
  };
}
