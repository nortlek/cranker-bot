import { describe, expect, it } from "vitest";

import {
  assessProfit,
  bufferedGas,
  selectMostProfitableEstimatedPrefix,
} from "../src/economics.js";
import { rankByFee } from "../src/keeper.js";
import { buildNoncePlan } from "../src/nonces.js";

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
    });

    expect(decision.gasLimit).toBe(240_000n);
    expect(decision.maxGasCost).toBe(96_000_000_000_000n);
    expect(decision.maxProfit).toBe(204_000_000_000_000n);
    expect(decision.profitable).toBe(true);
  });

  it("rejects a fee that does not clear the absolute floor", () => {
    const decision = assessProfit({
      crankFee: 100n,
      estimatedGas: 1n,
      maxFeePerGas: 80n,
      gasLimitMultiplierBps: 10_000n,
      minProfitWei: 25n,
    });

    expect(decision.maxProfit).toBe(20n);
    expect(decision.requiredProfit).toBe(25n);
    expect(decision.profitable).toBe(false);
  });

  it("accepts any strictly positive profit when floors are disabled", () => {
    const decision = assessProfit({
      crankFee: 101n,
      estimatedGas: 1n,
      maxFeePerGas: 100n,
      gasLimitMultiplierBps: 10_000n,
      minProfitWei: 0n,
    });

    expect(decision.maxProfit).toBe(1n);
    expect(decision.requiredProfit).toBe(1n);
    expect(decision.profitable).toBe(true);
  });

  it("rejects break-even execution when floors are disabled", () => {
    const decision = assessProfit({
      crankFee: 100n,
      estimatedGas: 1n,
      maxFeePerGas: 100n,
      gasLimitMultiplierBps: 10_000n,
      minProfitWei: 0n,
    });

    expect(decision.maxProfit).toBe(0n);
    expect(decision.requiredProfit).toBe(1n);
    expect(decision.profitable).toBe(false);
  });
});

describe("selectMostProfitableEstimatedPrefix", () => {
  it("preserves a profitable base when an optional suffix is unprofitable", () => {
    expect(
      selectMostProfitableEstimatedPrefix({
        components: [
          { rewardWei: 300n, maxGasCostWei: 100n },
          { rewardWei: 200n, maxGasCostWei: 100n },
          { rewardWei: 0n, maxGasCostWei: 400n },
        ],
        minimumViablePrefix: 2,
        minProfitWei: 0n,
      }),
    ).toEqual({
      length: 2,
      grossRewardWei: 500n,
      maxGasCostWei: 200n,
      expectedProfitWei: 300n,
    });
  });

  it("rejects every prefix below the dependency floor", () => {
    expect(
      selectMostProfitableEstimatedPrefix({
        components: [
          { rewardWei: 300n, maxGasCostWei: 100n },
          { rewardWei: 0n, maxGasCostWei: 300n },
        ],
        minimumViablePrefix: 2,
        minProfitWei: 0n,
      }),
    ).toBeUndefined();
  });

  it("keeps the shorter prefix when retained profit ties", () => {
    expect(
      selectMostProfitableEstimatedPrefix({
        components: [
          { rewardWei: 300n, maxGasCostWei: 100n },
          { rewardWei: 100n, maxGasCostWei: 100n },
        ],
        minimumViablePrefix: 1,
        minProfitWei: 0n,
      })?.length,
    ).toBe(1);
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

describe("buildNoncePlan", () => {
  it("allocates an explicit contiguous nonce range", () => {
    expect(
      buildNoncePlan({ latest: 42, pending: 42 }, 4),
    ).toEqual({
      latest: 42,
      pending: 42,
      blocked: false,
      nonces: [42, 43, 44, 45],
    });
  });

  it("blocks a new batch while account transactions are pending", () => {
    expect(
      buildNoncePlan({ latest: 42, pending: 44 }, 4),
    ).toEqual({
      latest: 42,
      pending: 44,
      blocked: true,
      nonces: [],
    });
  });
});
