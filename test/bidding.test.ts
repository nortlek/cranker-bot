import { parseEther, parseGwei } from "viem";
import { describe, expect, it } from "vitest";

import {
  aggregateBuilderBidBps,
  allocateIndependentPriorityFees,
  attributePriorityBidsByOrder,
  compareObservedBuilderPayment,
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

  it("applies a pull clearing-price floor to the aggregate mixed bundle", () => {
    expect(
      aggregateBuilderBidBps([
        { rewardWei: 300n, builderBidBps: 9_000n },
        {
          rewardWei: 700n,
          builderBidBps: 1_000n,
          minimumAggregateBuilderBidBps: 6_243n,
        },
      ]),
    ).toBe(6_243n);
  });
});

describe("effectiveBuilderBidBps", () => {
  it("attributes a shared priority fee to each order's own reward", () => {
    expect(effectiveBuilderBidBps(30n, 300n)).toBe(1_000n);
    expect(effectiveBuilderBidBps(30n, 400n)).toBe(750n);
  });
});

describe("attributePriorityBidsByOrder", () => {
  it("attributes a shared gas price using each order's gas and reward", () => {
    const bids = attributePriorityBidsByOrder(
      [
        {
          order: "0xAAA",
          rewardWei: 200n,
          gasUsed: 10n,
        },
        {
          order: "0xBBB",
          rewardWei: 100n,
          gasUsed: 15n,
        },
      ],
      4n,
    );

    expect(bids.get("0xaaa")).toBe(2_000n);
    expect(bids.get("0xbbb")).toBe(6_000n);
  });

  it("attributes each order's independently priced transaction", () => {
    const bids = attributePriorityBidsByOrder(
      [
        {
          order: "0xAAA",
          rewardWei: 300n,
          gasUsed: 10n,
          priorityFeePerGas: 27n,
        },
        {
          order: "0xBBB",
          rewardWei: 200n,
          gasUsed: 20n,
          priorityFeePerGas: 1n,
        },
      ],
      4n,
    );

    expect(bids.get("0xaaa")).toBe(9_000n);
    expect(bids.get("0xbbb")).toBe(1_000n);
  });

  it("rejects duplicate target attribution", () => {
    expect(() =>
      attributePriorityBidsByOrder(
        [
          { order: "0xAAA", rewardWei: 200n, gasUsed: 10n },
          { order: "0xaaa", rewardWei: 100n, gasUsed: 15n },
        ],
        4n,
      ),
    ).toThrow("duplicate standing order");
  });

  it("does not misclassify the block-25656702 package conflict as an underbid", () => {
    const bids = attributePriorityBidsByOrder(
      [
        {
          order: "0x20537147391a1C6dEe78b1597e9aBf749E761162",
          rewardWei: parseEther("0.0001"),
          gasUsed: 218_313n,
        },
      ],
      414_585_470n,
    );

    expect(
      bids.get(
        "0x20537147391a1c6dee78b1597e9abf749e761162",
      ),
    ).toBe(9_051n);
    expect(
      bids.get(
        "0x20537147391a1c6dee78b1597e9abf749e761162",
      ),
    ).toBeGreaterThan(7_834n);
  });
});

describe("allocateIndependentPriorityFees", () => {
  it("preserves each standalone order's own bid inside a mixed batch", () => {
    const allocation = allocateIndependentPriorityFees({
      components: [
        {
          rewardWei: 300n,
          gasUsed: 10n,
          builderBidBps: 9_000n,
          minimumPriorityFeePerGas: 0n,
        },
        {
          rewardWei: 200n,
          gasUsed: 20n,
          builderBidBps: 1_000n,
          minimumPriorityFeePerGas: 0n,
        },
      ],
      baseFeeAllowancePerGas: 1n,
      maxFeePerGasCap: 100n,
      minProfitWei: 1n,
    });

    expect(allocation).toEqual({
      priorityFeesPerGas: [27n, 1n],
      priorityBuilderPayment: 290n,
      expectedGasCost: 320n,
      expectedProfit: 180n,
      requiredProfit: 1n,
    });
  });

  it("does not dilute a contested order across the block-25665517 batch", () => {
    const components = [
      {
        rewardWei: parseEther("0.0003"),
        gasUsed: 218_313n,
        builderBidBps: 9_409n,
        minimumPriorityFeePerGas: 0n,
      },
      {
        rewardWei: parseEther("0.0002"),
        gasUsed: 218_313n,
        builderBidBps: 1_000n,
        minimumPriorityFeePerGas: 0n,
      },
      {
        rewardWei: parseEther("0.0002"),
        gasUsed: 218_313n,
        builderBidBps: 1_112n,
        minimumPriorityFeePerGas: 0n,
      },
    ] as const;
    const allocation = allocateIndependentPriorityFees({
      components,
      baseFeeAllowancePerGas: 35_969_900n,
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: parseEther("0.000001"),
    });

    expect(allocation).toBeDefined();
    const bids = attributePriorityBidsByOrder(
      components.map((component, index) => ({
        order: `0x${index}`,
        rewardWei: component.rewardWei,
        gasUsed: component.gasUsed,
        priorityFeePerGas: allocation!.priorityFeesPerGas[index]!,
      })),
      0n,
    );
    expect(bids.get("0x0")).toBeGreaterThanOrEqual(9_409n);
    expect(bids.get("0x1")).toBeGreaterThanOrEqual(1_000n);
    expect(bids.get("0x2")).toBeGreaterThanOrEqual(1_112n);
    expect(allocation!.expectedProfit).toBeGreaterThanOrEqual(
      allocation!.requiredProfit,
    );
  });

  it("refuses independent targets that cross the aggregate profit floor", () => {
    expect(
      allocateIndependentPriorityFees({
        components: [
          {
            rewardWei: 300n,
            gasUsed: 10n,
            builderBidBps: 10_000n,
            minimumPriorityFeePerGas: 0n,
          },
        ],
        baseFeeAllowancePerGas: 1n,
        maxFeePerGasCap: 100n,
        minProfitWei: 1n,
      }),
    ).toBeUndefined();
  });
});

describe("compareObservedBuilderPayment", () => {
  it("replays the profitable FWA buyback loss in Titan block 25683818", () => {
    const comparison = compareObservedBuilderPayment({
      observedBuilderPayment: 1_575_408_195_862_322n,
      plannedGrossReward: 3_740_206_223_983_917n,
      plannedBuilderPayment: 374_020_622_494_774n,
      plannedExpectedProfit: 3_338_960_613_955_747n,
      minProfitWei: 1_000_000_000_000n,
    });

    expect(
      comparison.requiredBidBpsAgainstPlannedGross,
    ).toBe(4_213n);
    expect(comparison.counterfactualExpectedProfit).toBe(
      2_137_573_040_588_198n,
    );
    expect(comparison.profitable).toBe(true);
  });

  it("normalizes the absolute competitor payment against our planned reward", () => {
    const comparison = compareObservedBuilderPayment({
      observedBuilderPayment: 914n,
      plannedGrossReward: 1_179n,
      plannedBuilderPayment: 855n,
      plannedExpectedProfit: 152n,
      minProfitWei: 1n,
    });

    expect(comparison.requiredBuilderPayment).toBe(915n);
    expect(comparison.additionalBuilderPaymentRequired).toBe(60n);
    expect(
      comparison.requiredBidBpsAgainstPlannedGross,
    ).toBe(7_761n);
    expect(comparison.counterfactualExpectedProfit).toBe(92n);
    expect(comparison.profitable).toBe(true);
  });

  it("rejects a counterfactual that consumes the retained-profit floor", () => {
    const comparison = compareObservedBuilderPayment({
      observedBuilderPayment: 990n,
      plannedGrossReward: 1_000n,
      plannedBuilderPayment: 100n,
      plannedExpectedProfit: 850n,
      minProfitWei: 10n,
    });

    expect(comparison.additionalBuilderPaymentRequired).toBe(891n);
    expect(comparison.counterfactualExpectedProfit).toBe(-41n);
    expect(comparison.profitable).toBe(false);
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

  it("prices the observed low fulfilled-lifecycle clearing without chasing unprofitable tails", () => {
    const quote = quoteCompetitiveFees({
      crankFee: parseEther("0.00114713205625993"),
      simulatedGasUsed: 554_480n,
      baseFeeAllowancePerGas: 336_058_908n,
      minimumPriorityFeePerGas: 0n,
      builderBidBps: 7_250n,
      maxFeePerGasCap: parseGwei("5"),
      minProfitWei: 0n,
    });

    expect(quote.profitable).toBe(true);
    expect(quote.effectiveBuilderBidBps).toBe(7_251n);
    expect(quote.expectedProfit).toBeGreaterThan(
      parseEther("0.000128"),
    );
    expect(quote.cappedByProfit).toBe(false);
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

  it("uses only the retained-profit boundary when no fee cap is supplied", () => {
    const quote = quoteCompetitiveFees({
      crankFee: 1_000n,
      simulatedGasUsed: 10n,
      baseFeeAllowancePerGas: 10n,
      minimumPriorityFeePerGas: 1n,
      builderBidBps: 9_000n,
      minProfitWei: 100n,
    });

    expect(quote.profitable).toBe(true);
    expect(quote.maxFeePerGas).toBe(90n);
    expect(quote.maxPriorityFeePerGas).toBe(80n);
    expect(quote.expectedProfit).toBe(100n);
    expect(quote.cappedByProfit).toBe(true);
    expect(quote.cappedByFeeCap).toBe(false);
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

  it("prices a mixed pull prefix above the configured fee cap when exact profit remains", () => {
    const selected = selectMostProfitablePrefix({
      components: [
        {
          rewardWei: 700n,
          gasUsed: 10n,
          builderBidBps: 300n,
          minimumPriorityFeePerGas: 0n,
        },
        {
          rewardWei: 300n,
          gasUsed: 10n,
          builderBidBps: 1_000n,
          minimumAggregateBuilderBidBps: 7_000n,
          minimumPriorityFeePerGas: 0n,
          profitabilityOnly: true,
        },
      ],
      minimumViablePrefix: 2,
      baseFeeAllowancePerGas: 10n,
      maxFeePerGasCap: 20n,
      minProfitWei: 100n,
    });

    expect(selected?.builderBidBps).toBe(7_000n);
    expect(selected?.quote.maxFeePerGas).toBe(45n);
    expect(selected?.quote.expectedProfit).toBe(100n);
    expect(selected?.quote.cappedByFeeCap).toBe(false);
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

  it("keeps a profit-floor suffix that increases the absolute builder payment", () => {
    const selected = selectMostProfitablePrefix({
      components: [
        {
          rewardWei: 2_000n,
          gasUsed: 101n,
          builderBidBps: 10_000n,
          minimumPriorityFeePerGas: 0n,
        },
        {
          rewardWei: 1_000n,
          gasUsed: 101n,
          builderBidBps: 10_000n,
          minimumPriorityFeePerGas: 0n,
        },
      ],
      minimumViablePrefix: 1,
      baseFeeAllowancePerGas: 1n,
      maxFeePerGasCap: 100n,
      minProfitWei: 100n,
    });

    expect(selected?.length).toBe(2);
    expect(selected?.quote.cappedByProfit).toBe(true);
    expect(selected?.quote.builderPayment).toBe(2_626n);
    expect(selected?.quote.expectedProfit).toBe(172n);
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
