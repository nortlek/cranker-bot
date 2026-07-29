import { describe, expect, it } from "vitest";

import { calculateWinningBidBps } from "../src/competition.js";

describe("calculateWinningBidBps", () => {
  it("includes direct block-beneficiary payments", () => {
    const result = calculateWinningBidBps({
      totalCrankFees: 300_000_000_000_000n,
      gasUsed: 208_714n,
      effectiveGasPrice: 153_718_129n,
      baseFeePerGas: 153_718_129n,
      directBeneficiaryPayment: 257_883_747_012_408n,
    });

    expect(result.priorityPayment).toBe(0n);
    expect(result.winningBidBps).toBe(8_597n);
  });

  it("adds priority fees to a direct payment", () => {
    const result = calculateWinningBidBps({
      totalCrankFees: 1_000n,
      gasUsed: 10n,
      effectiveGasPrice: 12n,
      baseFeePerGas: 10n,
      directBeneficiaryPayment: 500n,
    });

    expect(result.priorityPayment).toBe(20n);
    expect(result.totalBuilderPayment).toBe(520n);
    expect(result.winningBidBps).toBe(5_200n);
  });
});
