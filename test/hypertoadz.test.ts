import { parseEther, parseGwei } from "viem";
import { describe, expect, it } from "vitest";

import { quoteCompetitiveFees } from "../src/bidding.js";
import {
  hypertoadzAbi,
  hypertoadzCanFinalizeInNextBlock,
  HYPERTOADZ_RECEIPT_GAS_BUFFER,
} from "../src/hypertoadz.js";

describe("Hypertoadz settlement", () => {
  it("targets the first child block that can satisfy the deadline", () => {
    expect(
      hypertoadzCanFinalizeInNextBlock({
        auctionEnd: 1_012n,
        parentTimestamp: 1_000n,
        hasBid: true,
        ended: false,
      }),
    ).toBe(true);
    expect(
      hypertoadzCanFinalizeInNextBlock({
        auctionEnd: 1_013n,
        parentTimestamp: 1_000n,
        hasBid: true,
        ended: false,
      }),
    ).toBe(false);
  });

  it("rejects auctions without a live winning bid", () => {
    expect(
      hypertoadzCanFinalizeInNextBlock({
        auctionEnd: 1_000n,
        parentTimestamp: 1_000n,
        hasBid: false,
        ended: false,
      }),
    ).toBe(false);
    expect(
      hypertoadzCanFinalizeInNextBlock({
        auctionEnd: 1_000n,
        parentTimestamp: 1_000n,
        hasBid: true,
        ended: true,
      }),
    ).toBe(false);
  });

  it("pins the reward-authority event", () => {
    expect(
      hypertoadzAbi.some(
        (entry) =>
          entry.type === "event" &&
          entry.name === "AuctionFinalized",
      ),
    ).toBe(true);
  });

  it("replays the first clearing at the maximum safe retained-profit bid", () => {
    const reward = 17_700_000_000_000_000n;
    const gasUsed = 1_243_686n;
    const baseFeePerGas = 100_725_917n;
    const minimumProfit = 1_000_000_000_000n;
    const observedDirectBuilderPayment =
      17_572_464_110_770_467n;
    const quote = quoteCompetitiveFees({
      crankFee: reward,
      simulatedGasUsed: gasUsed,
      baseFeeAllowancePerGas: baseFeePerGas,
      minimumPriorityFeePerGas: 0n,
      builderBidBps: 10_000n,
      minProfitWei: minimumProfit,
    });

    expect(quote.profitable).toBe(true);
    expect(quote.cappedByProfit).toBe(true);
    expect(quote.expectedProfit).toBeGreaterThanOrEqual(
      minimumProfit,
    );
    expect(quote.expectedProfit).toBeLessThan(
      minimumProfit + gasUsed,
    );
    expect(quote.builderPayment).toBeGreaterThan(
      observedDirectBuilderPayment,
    );
  });

  it("preserves the profit floor across the observed token 4 receipt gas drift", () => {
    const reward = parseEther("0.00111");
    const simulatedGasUsed = 1_374_654n;
    const receiptGasUsed = 1_374_941n;
    const baseFeeAllowancePerGas = 65_960_548n;
    const minimumProfit = parseEther("0.000001");
    const quote = quoteCompetitiveFees({
      crankFee: reward,
      simulatedGasUsed,
      profitGasUsed:
        simulatedGasUsed + HYPERTOADZ_RECEIPT_GAS_BUFFER,
      baseFeeAllowancePerGas,
      minimumPriorityFeePerGas: 0n,
      builderBidBps: 10_000n,
      minProfitWei: minimumProfit,
    });

    expect(quote.profitable).toBe(true);
    expect(quote.cappedByProfit).toBe(true);
    expect(
      reward - receiptGasUsed * quote.maxFeePerGas,
    ).toBeGreaterThanOrEqual(minimumProfit);
    expect(quote.maxPriorityFeePerGas).toBeLessThan(
      parseGwei("0.740787913"),
    );
  });
});
