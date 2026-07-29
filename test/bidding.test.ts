import { parseEther, parseGwei } from "viem";
import { describe, expect, it } from "vitest";

import {
  aggregateBuilderBidBps,
  effectiveBuilderBidBps,
  quoteCompetitiveFees,
  selectMostProfitablePrefix,
} from "../src/bidding.js";

describe("aggregateBuilderBidBps", () => {
  it("weights standing-order and pool bids by their rewards", () => {
    expect(
      aggregateBuilderBidBps([
        { rewardWei: 300n, builderBidBps: 9_000n },
        { rewardWei: 700n, builderBidBps: 1_000n },
      ]),
    ).toBe(3_400n);
  });

  it("does not charge a bid for an unpaid dependency call", () => {
    expect(
      aggregateBuilderBidBps([
        { rewardWei: 0n, builderBidBps: 1_000n },
        { rewardWei: 900n, builderBidBps: 1_000n },
      ]),
    ).toBe(1_000n);
  });
});

describe("effectiveBuilderBidBps", () => {
  it("attributes a shared priority fee to each order's own reward", () => {
    expect(effectiveBuilderBidBps(30n, 300n)).toBe(1_000n);
    expect(effectiveBuilderBidBps(30n, 400n)).toBe(750n);
  });
});

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
    });

    expect(quote.profitable).toBe(true);
    expect(quote.maxPriorityFeePerGas).toBe(
      parseGwei("1.215"),
    );
    expect(quote.builderPayment).toBe(parseEther("0.000243"));
    expect(quote.expectedProfit).toBe(parseEther("0.000033"));
  });

  it("caps a target bid at the retained-profit floor", () => {
    const quote = quoteCompetitiveFees({
      crankFee: parseEther("0.0003"),
      simulatedGasUsed: 350_000n,
      baseFeeAllowancePerGas: parseGwei("0.12"),
      minimumPriorityFeePerGas: parseGwei("0.1"),
      builderBidBps: 8_100n,
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: parseEther("0.00005"),
    });

    expect(quote.profitable).toBe(true);
    expect(quote.cappedByProfit).toBe(true);
    expect(quote.expectedProfit).toBeGreaterThanOrEqual(
      parseEther("0.00005"),
    );
  });

  it("accepts a one-wei expected profit when floors are disabled", () => {
    const quote = quoteCompetitiveFees({
      crankFee: 101n,
      simulatedGasUsed: 1n,
      baseFeeAllowancePerGas: 100n,
      minimumPriorityFeePerGas: 0n,
      builderBidBps: 0n,
      maxFeePerGasCap: 100n,
      minProfitWei: 0n,
    });

    expect(quote.expectedProfit).toBe(1n);
    expect(quote.requiredProfit).toBe(1n);
    expect(quote.profitable).toBe(true);
  });

  it("rejects break-even execution when floors are disabled", () => {
    const quote = quoteCompetitiveFees({
      crankFee: 100n,
      simulatedGasUsed: 1n,
      baseFeeAllowancePerGas: 100n,
      minimumPriorityFeePerGas: 0n,
      builderBidBps: 0n,
      maxFeePerGasCap: 100n,
      minProfitWei: 0n,
    });

    expect(quote.expectedProfit).toBe(0n);
    expect(quote.requiredProfit).toBe(1n);
    expect(quote.profitable).toBe(false);
    expect(quote.reason).toBe("profit_floor");
  });

  it("caps a target bid at the configured max fee", () => {
    const quote = quoteCompetitiveFees({
      crankFee: 1_000n,
      simulatedGasUsed: 10n,
      baseFeeAllowancePerGas: 10n,
      minimumPriorityFeePerGas: 1n,
      builderBidBps: 9_000n,
      maxFeePerGasCap: 20n,
      minProfitWei: 0n,
    });

    expect(quote.profitable).toBe(true);
    expect(quote.maxFeePerGas).toBe(20n);
    expect(quote.cappedByFeeCap).toBe(true);
  });

  it("fills a fee-capped bid with a profit-bounded direct payment", () => {
    const quote = quoteCompetitiveFees({
      crankFee: parseEther("0.0025"),
      simulatedGasUsed: 183_753n,
      baseFeeAllowancePerGas: parseGwei("0.4"),
      minimumPriorityFeePerGas: parseGwei("0.1"),
      builderBidBps: 8_939n,
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: 1n,
      directPaymentGasUsed: 50_000n,
    });

    expect(quote.profitable).toBe(true);
    expect(quote.maxFeePerGas).toBe(parseGwei("5"));
    expect(quote.priorityBuilderPayment).toBe(
      183_753n * parseGwei("4.6"),
    );
    expect(quote.directBuilderPayment).toBeGreaterThan(0n);
    expect(quote.builderPayment).toBe(
      parseEther("0.0025") * 8_939n / 10_000n,
    );
    expect(quote.cappedByFeeCap).toBe(false);
    expect(quote.expectedProfit).toBeGreaterThan(0n);
  });

  it("does not add a direct payment when its gas would consume the profit budget", () => {
    const quote = quoteCompetitiveFees({
      crankFee: 1_000n,
      simulatedGasUsed: 10n,
      baseFeeAllowancePerGas: 10n,
      minimumPriorityFeePerGas: 1n,
      builderBidBps: 9_000n,
      maxFeePerGasCap: 20n,
      minProfitWei: 1n,
      directPaymentGasUsed: 100n,
    });

    expect(quote.directBuilderPayment).toBe(0n);
    expect(quote.cappedByFeeCap).toBe(true);
  });
});

describe("selectMostProfitablePrefix", () => {
  it("drops an aggregate-profitable suffix with negative marginal profit", () => {
    const selected = selectMostProfitablePrefix({
      components: [
        {
          rewardWei: 300n,
          gasUsed: 1n,
          builderBidBps: 0n,
          minimumPriorityFeePerGas: 0n,
        },
        {
          rewardWei: 100n,
          gasUsed: 2n,
          builderBidBps: 0n,
          minimumPriorityFeePerGas: 0n,
        },
      ],
      minimumViablePrefix: 1,
      baseFeeAllowancePerGas: 100n,
      maxFeePerGasCap: 100n,
      minProfitWei: 0n,
    });

    expect(selected?.length).toBe(1);
    expect(selected?.quote.expectedProfit).toBe(200n);
  });

  it("preserves a full dependency floor", () => {
    const selected = selectMostProfitablePrefix({
      components: [
        {
          rewardWei: 300n,
          gasUsed: 1n,
          builderBidBps: 0n,
          minimumPriorityFeePerGas: 0n,
        },
        {
          rewardWei: 100n,
          gasUsed: 2n,
          builderBidBps: 0n,
          minimumPriorityFeePerGas: 0n,
        },
      ],
      minimumViablePrefix: 2,
      baseFeeAllowancePerGas: 100n,
      maxFeePerGasCap: 100n,
      minProfitWei: 0n,
    });

    expect(selected?.length).toBe(2);
    expect(selected?.quote.expectedProfit).toBe(100n);
  });

  it("keeps individually negative receipts when the repriced bundle is more profitable", () => {
    const selected = selectMostProfitablePrefix({
      components: [
        {
          rewardWei: parseEther("0.0003"),
          gasUsed: 183_753n,
          builderBidBps: 8_644n,
          minimumPriorityFeePerGas: 0n,
        },
        {
          rewardWei: parseEther("0.0001"),
          gasUsed: 183_753n,
          builderBidBps: 8_644n,
          minimumPriorityFeePerGas: 0n,
        },
        {
          rewardWei: parseEther("0.0001"),
          gasUsed: 183_753n,
          builderBidBps: 8_644n,
          minimumPriorityFeePerGas: 0n,
        },
      ],
      minimumViablePrefix: 1,
      baseFeeAllowancePerGas: parseGwei("0.049105902"),
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: 0n,
    });

    expect(selected?.length).toBe(3);
    expect(selected?.quote.expectedProfit).toBeGreaterThan(
      parseEther("0.00004"),
    );
  });

  it("returns undefined when no dependency-safe prefix is profitable", () => {
    expect(
      selectMostProfitablePrefix({
        components: [
          {
            rewardWei: 99n,
            gasUsed: 1n,
            builderBidBps: 0n,
            minimumPriorityFeePerGas: 0n,
          },
        ],
        minimumViablePrefix: 1,
        baseFeeAllowancePerGas: 100n,
        maxFeePerGasCap: 100n,
        minProfitWei: 0n,
      }),
    ).toBeUndefined();
  });

  it("accounts for direct-payment gas when selecting a standing-order prefix", () => {
    const selected = selectMostProfitablePrefix({
      components: [
        {
          rewardWei: parseEther("0.0025"),
          gasUsed: 183_753n,
          builderBidBps: 8_939n,
          minimumPriorityFeePerGas: parseGwei("0.1"),
        },
      ],
      minimumViablePrefix: 1,
      baseFeeAllowancePerGas: parseGwei("0.4"),
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: 1n,
      directPaymentGasUsed: 50_000n,
    });

    expect(selected?.quote.directBuilderPayment).toBeGreaterThan(0n);
    expect(selected?.quote.directPaymentGasUsed).toBe(50_000n);
  });
});
