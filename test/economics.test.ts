import { describe, expect, it } from "vitest";

import { assessProfit, bufferedGas } from "../src/economics.js";
import { rankByFee } from "../src/keeper.js";

describe("bufferedGas", () => {
  it("rounds a fractional gas unit up", () => {
    expect(bufferedGas(101n, 12_000n)).toBe(122n);
  });

  it("rejects a multiplier below the estimate", () => {
    expect(() => bufferedGas(100n, 9_999n)).toThrow();
  });
});

describe("assessProfit", () => {
  it("accepts the examined order at observed gas economics", () => {
    const decision = assessProfit({
      crankFee: 300_000_000_000_000n,
      estimatedGas: 200_000n,
      maxFeePerGas: 400_000_000n,
      gasLimitMultiplierBps: 12_000n,
      minProfitWei: 50_000_000_000_000n,
      minProfitBps: 2_500n,
    });

    expect(decision.gasLimit).toBe(240_000n);
    expect(decision.maxGasCost).toBe(96_000_000_000_000n);
    expect(decision.maxProfit).toBe(204_000_000_000_000n);
    expect(decision.profitable).toBe(true);
  });

  it("rejects a fee that does not clear the relative floor", () => {
    const decision = assessProfit({
      crankFee: 100n,
      estimatedGas: 1n,
      maxFeePerGas: 80n,
      gasLimitMultiplierBps: 10_000n,
      minProfitWei: 0n,
      minProfitBps: 2_500n,
    });

    expect(decision.maxProfit).toBe(20n);
    expect(decision.requiredProfit).toBe(25n);
    expect(decision.profitable).toBe(false);
  });
});

describe("rankByFee", () => {
  it("puts the largest keeper fee first", () => {
    const ranked = rankByFee([
      {
        address: "0x0000000000000000000000000000000000000002",
        crankFee: 1n,
      },
      {
        address: "0x0000000000000000000000000000000000000001",
        crankFee: 2n,
      },
    ]);

    expect(ranked.map((candidate) => candidate.crankFee)).toEqual([2n, 1n]);
  });
});
