import { describe, expect, it } from "vitest";

import { assessStonkPitCrank } from "../src/robinhood.js";

describe("assessStonkPitCrank", () => {
  it("prices the one-percent tip against exact gas", () => {
    const result = assessStonkPitCrank({
      ethTotal: 711_473_512_236_046n,
      tipBps: 100n,
      gas: 221_279n,
      gasPrice: 22_498_000n,
    });

    expect(result.tip).toBe(7_114_735_122_360n);
    expect(result.gasCost).toBe(4_978_334_942_000n);
    expect(result.netProfit).toBe(2_136_400_180_360n);
    expect(result.profitable).toBe(true);
  });

  it("rejects a successful crank whose nonzero tip is below gas", () => {
    const result = assessStonkPitCrank({
      ethTotal: 97_329_576_473_891n,
      tipBps: 100n,
      gas: 221_279n,
      gasPrice: 22_136_000n,
    });

    expect(result.tip).toBe(973_295_764_738n);
    expect(result.gasCost).toBe(4_898_231_944_000n);
    expect(result.netProfit).toBe(-3_924_936_179_262n);
    expect(result.profitable).toBe(false);
  });

  it("rounds the minimum fee inventory up to guarantee the profit floor", () => {
    const result = assessStonkPitCrank({
      ethTotal: 0n,
      tipBps: 100n,
      gas: 1n,
      gasPrice: 101n,
      minProfitWei: 50n,
    });

    expect(result.minimumEthTotal).toBe(15_100n);
    expect(
      assessStonkPitCrank({
        ethTotal: result.minimumEthTotal,
        tipBps: 100n,
        gas: 1n,
        gasPrice: 101n,
        minProfitWei: 50n,
      }).profitable,
    ).toBe(true);
  });

  it("rejects invalid tip policies", () => {
    expect(() =>
      assessStonkPitCrank({
        ethTotal: 0n,
        tipBps: 0n,
        gas: 0n,
        gasPrice: 0n,
      }),
    ).toThrow("tipBps");
  });
});
