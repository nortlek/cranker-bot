import { parseEther, parseGwei } from "viem";
import { describe, expect, it } from "vitest";

import { quoteCompetitiveFees } from "../src/bidding.js";

describe("quoteCompetitiveFees", () => {
  it("turns the configured fee share into a gas-normalized builder tip", () => {
    const quote = quoteCompetitiveFees({
      crankFee: parseEther("0.0003"),
      simulatedGasUsed: 200_000n,
      baseFeeAllowancePerGas: parseGwei("0.12"),
      minimumPriorityFeePerGas: parseGwei("0.1"),
      builderBidBps: 8_100n,
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: parseEther("0.00001"),
      minProfitBps: 500n,
    });

    expect(quote.profitable).toBe(true);
    expect(quote.maxPriorityFeePerGas).toBe(
      parseGwei("1.215"),
    );
    expect(quote.builderPayment).toBe(parseEther("0.000243"));
    expect(quote.expectedProfit).toBe(parseEther("0.000033"));
  });

  it("rejects a bid that violates the retained-profit floor", () => {
    const quote = quoteCompetitiveFees({
      crankFee: parseEther("0.0003"),
      simulatedGasUsed: 350_000n,
      baseFeeAllowancePerGas: parseGwei("0.12"),
      minimumPriorityFeePerGas: parseGwei("0.1"),
      builderBidBps: 8_100n,
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: parseEther("0.00005"),
      minProfitBps: 2_500n,
    });

    expect(quote.profitable).toBe(false);
    expect(quote.reason).toBe("profit_floor");
  });
});
