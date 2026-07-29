import { getAddress, parseEther, parseGwei } from "viem";
import { describe, expect, it } from "vitest";

import {
  acquisitionProcessCount,
  acquisitionStatusName,
  buybackCallerReward,
  estimatePoolBounty,
  lifecycleFundingSuperset,
  liveBidSweepRewardFromSimulation,
  quoteLiveBidSweep,
  routeRoundIds,
  selectOrdersForCoverage,
} from "../src/lifecycle.js";

const address = (suffix: number) =>
  getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);

describe("acquisitionStatusName", () => {
  it("logs stable names for ready and fulfilled acquisitions", () => {
    expect(acquisitionStatusName(2)).toBe("fulfilled");
    expect(acquisitionStatusName(5)).toBe("ready");
  });

  it("preserves unknown status codes for diagnosis", () => {
    expect(acquisitionStatusName(99)).toBe("unknown_99");
  });
});

describe("acquisitionProcessCount", () => {
  it("returns the prefix length needed to reach a request", () => {
    expect(
      acquisitionProcessCount(33n, [11n, 22n, 33n, 44n]),
    ).toBe(3n);
  });

  it("returns undefined outside the bounded window", () => {
    expect(acquisitionProcessCount(55n, [11n, 22n])).toBeUndefined();
  });
});

describe("estimatePoolBounty", () => {
  it("prices reimbursed gas at base fee plus the snapshotted tip", () => {
    expect(
      estimatePoolBounty({
        gasUsed: 200_000n,
        baseFeePerGas: parseGwei("0.2"),
        terms: {
          crankBountyCap: parseEther("0.0015"),
          bountyTipWei: parseGwei("2"),
        },
        estimateBps: 9_000n,
      }),
    ).toBe(parseEther("0.000396"));
  });

  it("never values a crank above its round bounty cap", () => {
    expect(
      estimatePoolBounty({
        gasUsed: 1_000_000n,
        baseFeePerGas: parseGwei("2"),
        terms: {
          crankBountyCap: parseEther("0.0015"),
          bountyTipWei: parseGwei("2"),
        },
        estimateBps: 10_000n,
      }),
    ).toBe(parseEther("0.0015"));
  });
});

describe("buybackCallerReward", () => {
  it("uses the smaller of the token balance and one buyback slice", () => {
    expect(
      buybackCallerReward({
        tokenEthBalance: parseEther("3"),
        buybackIncrement: parseEther("1"),
        callerRewardBps: 50n,
      }),
    ).toBe(parseEther("0.005"));
    expect(
      buybackCallerReward({
        tokenEthBalance: parseEther("0.2"),
        buybackIncrement: parseEther("1"),
        callerRewardBps: 50n,
      }),
    ).toBe(parseEther("0.001"));
  });
});

describe("quoteLiveBidSweep", () => {
  const base = {
    adapterBalanceWei: parseEther("1"),
    patronBalanceWei: parseEther("10"),
    activationThresholdWei: parseEther("30"),
    currentBlock: 1_000n,
    lastSweepBlock: 900n,
    minBlocksBetweenSweeps: 150n,
    maxSweepWei: parseEther("2"),
    keeperRewardBps: 50n,
    keeperRewardCapWei: parseEther("0.01"),
  } as const;

  it("quotes the exact warm-up reward below the threshold", () => {
    expect(quoteLiveBidSweep(base)).toEqual({
      eligible: true,
      rewardWei: parseEther("0.005"),
      toForwardWei: parseEther("1"),
    });
  });

  it("pays an exact-threshold reward only from the remainder", () => {
    expect(
      quoteLiveBidSweep({
        ...base,
        adapterBalanceWei: parseEther("1.001"),
        patronBalanceWei: parseEther("29"),
      }),
    ).toEqual({
      eligible: true,
      rewardWei: parseEther("0.001"),
      toForwardWei: parseEther("1"),
    });
  });

  it("enforces cooldown and the throttled step cap", () => {
    expect(
      quoteLiveBidSweep({
        ...base,
        patronBalanceWei: parseEther("30"),
      }),
    ).toEqual({
      eligible: false,
      rewardWei: 0n,
      toForwardWei: 0n,
      reason: "cooldown",
    });
    expect(
      quoteLiveBidSweep({
        ...base,
        adapterBalanceWei: parseEther("3"),
        patronBalanceWei: parseEther("30"),
        currentBlock: 1_050n,
      }),
    ).toEqual({
      eligible: true,
      rewardWei: parseEther("0.01"),
      toForwardWei: parseEther("2"),
    });
  });
});

describe("liveBidSweepRewardFromSimulation", () => {
  const quote = (parameters: {
    balance: string;
    forwarded: string;
    maxSweep?: string;
  }) =>
    liveBidSweepRewardFromSimulation({
      adapterBalanceWei: parseEther(parameters.balance),
      ethForwardedWei: parseEther(parameters.forwarded),
      maxSweepWei: parseEther(parameters.maxSweep ?? "2"),
      keeperRewardBps: 50n,
      keeperRewardCapWei: parseEther("0.01"),
    });

  it("recovers warm-up and throttled rewards", () => {
    expect(quote({ balance: "1", forwarded: "0.995" })).toBe(
      parseEther("0.005"),
    );
    expect(
      quote({
        balance: "3",
        forwarded: "1.99",
      }),
    ).toBe(parseEther("0.01"));
  });

  it("recovers rewards paid from exact-threshold remainder", () => {
    expect(
      quote({
        balance: "1.001",
        forwarded: "1",
      }),
    ).toBe(parseEther("0.001"));
  });
});

describe("routeRoundIds", () => {
  it("keeps an older pending lifecycle round separate from funding", () => {
    expect(
      routeRoundIds({
        roundCount: 140n,
        ethPendingRound: 139n,
      }),
    ).toEqual({
      fundingRoundId: 140n,
      lifecycleRoundId: 139n,
    });
  });

  it("uses the same round for both roles immediately after pull", () => {
    expect(
      routeRoundIds({
        roundCount: 139n,
        ethPendingRound: 139n,
      }),
    ).toEqual({
      fundingRoundId: 139n,
      lifecycleRoundId: 139n,
    });
  });

  it("omits a lifecycle round when no ETH is pending", () => {
    expect(
      routeRoundIds({
        roundCount: 140n,
        ethPendingRound: 0n,
      }),
    ).toEqual({ fundingRoundId: 140n });
  });
});

describe("lifecycleFundingSuperset", () => {
  interface TestJob {
    readonly kind: string;
    readonly roundId?: bigint;
  }
  const lifecycle: readonly TestJob[] = [
    { kind: "fwa_process" },
    { kind: "pool_sync", roundId: 191n },
    { kind: "pool_settle", roundId: 191n },
  ];
  const crank: TestJob = { kind: "standing_order" };
  const pull: TestJob = { kind: "pool_pull", roundId: 192n };

  it("appends a cached covered funding suffix in exact dependency order", async () => {
    const result = await lifecycleFundingSuperset({
      lifecycleJobs: lifecycle,
      lifecycleMinimumViablePrefix: 2,
      headBlockNumber: 25_636_285n,
      fundingRoundId: 192n,
      funding: Promise.resolve({
        source: "cache",
        headBlockNumber: 25_636_285n,
        fundingRoundId: 192n,
        coverageSatisfied: true,
        jobs: [crank, pull],
      }),
      timeoutMs: 10,
    });

    expect(result.enriched).toBe(true);
    expect(result.minimumViablePrefix).toBe(2);
    expect(result.jobs.map((job) => job.kind)).toEqual([
      "fwa_process",
      "pool_sync",
      "pool_settle",
      "standing_order",
      "pool_pull",
    ]);
  });

  it("falls back unchanged when funding is unavailable or slow", async () => {
    const unavailable = await lifecycleFundingSuperset({
      lifecycleJobs: lifecycle,
      lifecycleMinimumViablePrefix: 2,
      headBlockNumber: 100n,
      fundingRoundId: 192n,
      funding: undefined,
      timeoutMs: 10,
    });
    const slow = await lifecycleFundingSuperset({
      lifecycleJobs: lifecycle,
      lifecycleMinimumViablePrefix: 2,
      headBlockNumber: 100n,
      fundingRoundId: 192n,
      funding: new Promise<undefined>(() => {}),
      timeoutMs: 1,
    });

    expect(unavailable).toMatchObject({
      jobs: lifecycle,
      minimumViablePrefix: 2,
      enriched: false,
      reason: "funding_unavailable",
    });
    expect(slow).toMatchObject({
      jobs: lifecycle,
      minimumViablePrefix: 2,
      enriched: false,
      reason: "funding_unavailable",
    });
  });

  it("rejects a funding snapshot from a stale head block", async () => {
    const result = await lifecycleFundingSuperset({
      lifecycleJobs: lifecycle,
      lifecycleMinimumViablePrefix: 2,
      headBlockNumber: 101n,
      fundingRoundId: 192n,
      funding: Promise.resolve({
        source: "cache",
        headBlockNumber: 100n,
        fundingRoundId: 192n,
        coverageSatisfied: true,
        jobs: [crank, pull],
      }),
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      jobs: lifecycle,
      minimumViablePrefix: 2,
      enriched: false,
      reason: "funding_stale",
    });
  });

  it("never appends pull without sufficient funding coverage", async () => {
    const result = await lifecycleFundingSuperset({
      lifecycleJobs: lifecycle,
      lifecycleMinimumViablePrefix: 2,
      headBlockNumber: 100n,
      fundingRoundId: 192n,
      funding: Promise.resolve({
        source: "cache",
        headBlockNumber: 100n,
        fundingRoundId: 192n,
        coverageSatisfied: false,
        jobs: [crank, pull],
      }),
      timeoutMs: 10,
    });

    expect(result.minimumViablePrefix).toBe(2);
    expect(result.jobs.map((job) => job.kind)).toEqual([
      "fwa_process",
      "pool_sync",
      "pool_settle",
      "standing_order",
    ]);
  });

  it("does not enrich a lifecycle prefix that cannot settle", async () => {
    const base: readonly TestJob[] = [
      { kind: "fwa_process" },
      { kind: "pool_sync", roundId: 191n },
    ];
    const result = await lifecycleFundingSuperset({
      lifecycleJobs: base,
      lifecycleMinimumViablePrefix: 2,
      headBlockNumber: 100n,
      fundingRoundId: 192n,
      funding: Promise.resolve({
        source: "cache",
        headBlockNumber: 100n,
        fundingRoundId: 192n,
        coverageSatisfied: true,
        jobs: [crank, pull],
      }),
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      jobs: base,
      minimumViablePrefix: 2,
      enriched: false,
      reason: "lifecycle_settle_missing",
    });
  });
});

describe("selectOrdersForCoverage", () => {
  it("can select a zero-fee order when it cheaply unlocks pull", () => {
    const selected = selectOrdersForCoverage({
      ticketsNeeded: 4n,
      maxOrders: 3,
      orders: [
        {
          address: address(1),
          tickets: 1n,
          rewardWei: 300n,
          gasCostWei: 500n,
        },
        {
          address: address(2),
          tickets: 4n,
          rewardWei: 0n,
          gasCostWei: 150n,
        },
        {
          address: address(3),
          tickets: 3n,
          rewardWei: 100n,
          gasCostWei: 400n,
        },
      ],
    });

    expect(selected?.map((order) => order.address)).toEqual([
      address(2),
    ]);
  });

  it("honors the transaction limit when no covering subset fits", () => {
    const selected = selectOrdersForCoverage({
      ticketsNeeded: 3n,
      maxOrders: 2,
      orders: [
        {
          address: address(1),
          tickets: 1n,
          rewardWei: 10n,
          gasCostWei: 1n,
        },
        {
          address: address(2),
          tickets: 1n,
          rewardWei: 10n,
          gasCostWei: 1n,
        },
        {
          address: address(3),
          tickets: 1n,
          rewardWei: 10n,
          gasCostWei: 1n,
        },
      ],
    });

    expect(selected).toBeUndefined();
  });

  it("never appends a profitable order after an earlier order covers", () => {
    const selected = selectOrdersForCoverage({
      ticketsNeeded: 2n,
      maxOrders: 3,
      orders: [
        {
          address: address(1),
          tickets: 2n,
          rewardWei: 10n,
          gasCostWei: 5n,
        },
        {
          address: address(2),
          tickets: 1n,
          rewardWei: 100n,
          gasCostWei: 1n,
        },
      ],
    });

    expect(selected?.map((order) => order.address)).toEqual([
      address(1),
    ]);
  });
});
