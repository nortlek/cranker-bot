import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdaptiveBidController,
  adjustAdaptiveBid,
  initialAdaptiveBidState,
  type AdaptiveBidPersistence,
  type AdaptiveBidPolicy,
  type AdaptiveBidState,
} from "../src/adaptive-bidding.js";
import { loadConfig } from "../src/config.js";

const policy: AdaptiveBidPolicy = {
  minimumBidBps: 1_000n,
  baselineBidBps: 8_100n,
  maximumBidBps: 9_900n,
  lossStepBps: 25n,
  winDecayBps: 10n,
  winsBeforeDecay: 3,
  evidenceMaxAgeBlocks: 7_200n,
};

describe("adjustAdaptiveBid", () => {
  it("jumps just above an observed higher winning bid", () => {
    const adjustment = adjustAdaptiveBid(
      initialAdaptiveBidState(policy),
      policy,
      {
        kind: "miss",
        blockNumber: 42n,
        observedWinningBidBps: 8_597n,
      },
    );

    expect(adjustment.action).toBe("increased");
    expect(adjustment.currentBidBps).toBe(8_622n);
    expect(adjustment.state.consecutiveFullWins).toBe(0);
  });

  it("corrects the requested target when shared fees underdeliver its exact bid", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 7_000n,
        consecutiveFullWins: 0,
      },
      policy,
      {
        kind: "miss",
        blockNumber: 43n,
        effectiveBidBps: 6_500n,
        observedWinningBidBps: 7_000n,
      },
    );

    expect(adjustment.action).toBe("increased");
    expect(adjustment.reason).toBe("observed_competitor_price");
    expect(adjustment.currentBidBps).toBe(7_525n);
  });

  it("crosses an observed clearing price hidden below the minimum tip floor", () => {
    const floorPolicy: AdaptiveBidPolicy = {
      ...policy,
      baselineBidBps: 1_000n,
      maximumBidBps: 10_000n,
    };
    const adjustment = adjustAdaptiveBid(
      initialAdaptiveBidState(floorPolicy),
      floorPolicy,
      {
        kind: "miss",
        blockNumber: 25_665_769n,
        effectiveBidBps: 1_461n,
        observedWinningBidBps: 1_547n,
      },
    );

    expect(adjustment.action).toBe("increased");
    expect(adjustment.reason).toBe("observed_competitor_price");
    expect(adjustment.currentBidBps).toBe(1_572n);
  });

  it("does not increase after a cheaper winner or an unmeasured miss", () => {
    const raised = {
      currentBidBps: 8_622n,
      consecutiveFullWins: 2,
    };

    const cheaper = adjustAdaptiveBid(raised, policy, {
      kind: "miss",
      blockNumber: 43n,
      observedWinningBidBps: 6_547n,
    });
    const unknown = adjustAdaptiveBid(raised, policy, {
      kind: "miss",
      blockNumber: 43n,
    });

    expect(cheaper.action).toBe("held");
    expect(cheaper.currentBidBps).toBe(8_622n);
    expect(unknown.action).toBe("held");
    expect(unknown.currentBidBps).toBe(8_622n);
  });

  it("holds a target when its exact per-order bid beats a competing package", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 3_119n,
        consecutiveFullWins: 0,
        highestLosingBidBps: 2_921n,
        highestLosingBidBlock: 25_656_120n,
      },
      policy,
      {
        kind: "miss",
        blockNumber: 25_656_702n,
        effectiveBidBps: 9_051n,
        observedWinningBidBps: 7_834n,
      },
    );

    expect(adjustment.action).toBe("held");
    expect(adjustment.reason).toBe("miss_without_higher_price");
    expect(adjustment.currentBidBps).toBe(3_119n);
    expect(adjustment.state.highestLosingBidBps).toBe(2_921n);
    expect(adjustment.state.highestLosingBidBlock).toBe(
      25_656_120n,
    );
  });

  it("holds wins before bisecting toward the learned minimum", () => {
    let state = {
      currentBidBps: 8_622n,
      consecutiveFullWins: 0,
    };
    const first = adjustAdaptiveBid(state, policy, {
      kind: "full_win",
      blockNumber: 44n,
    });
    state = first.state;
    const second = adjustAdaptiveBid(state, policy, {
      kind: "full_win",
      blockNumber: 45n,
    });
    state = second.state;
    const third = adjustAdaptiveBid(state, policy, {
      kind: "full_win",
      blockNumber: 46n,
    });

    expect(first.action).toBe("held");
    expect(second.action).toBe("held");
    expect(third.action).toBe("decreased");
    expect(third.currentBidBps).toBe(4_811n);
    expect(third.state.consecutiveFullWins).toBe(0);
  });

  it("never raises a requested target while probing down from an overallocated win", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 2_726n,
        consecutiveFullWins: 2,
        lowestWinningBidBps: 10_000n,
      },
      {
        ...policy,
        baselineBidBps: 1_000n,
        maximumBidBps: 10_000n,
      },
      {
        kind: "full_win",
        blockNumber: 47n,
        effectiveBidBps: 11_149n,
      },
    );

    expect(adjustment.action).toBe("decreased");
    expect(adjustment.reason).toBe("sustained_wins_probe");
    expect(adjustment.currentBidBps).toBe(1_000n);
  });

  it("probes below old competitor evidence after sustained wins", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 8_100n,
        consecutiveFullWins: 2,
        lastObservedWinningBidBps: 4_000n,
        lastObservedWinningBlock: 40n,
      },
      policy,
      {
        kind: "full_win",
        blockNumber: 46n,
      },
    );

    expect(adjustment.action).toBe("decreased");
    expect(adjustment.reason).toBe("sustained_wins_probe");
    expect(adjustment.currentBidBps).toBe(4_550n);
    expect(adjustment.state.lastObservedWinningBidBps).toBe(4_000n);
    expect(adjustment.state.activeProbeBidBps).toBe(4_550n);
  });

  it("recovers above retained competitor evidence after a failed downward probe", () => {
    const poolPolicy: AdaptiveBidPolicy = {
      minimumBidBps: 1_000n,
      baselineBidBps: 1_000n,
      maximumBidBps: 10_000n,
      lossStepBps: 1n,
      winDecayBps: 10n,
      winsBeforeDecay: 3,
      evidenceMaxAgeBlocks: 7_200n,
    };
    const probe = adjustAdaptiveBid(
      {
        currentBidBps: 6_851n,
        consecutiveFullWins: 2,
        lastObservedWinningBidBps: 6_850n,
        lastObservedWinningBlock: 100n,
        lowestWinningBidBps: 6_851n,
        highestLosingBidBps: 6_244n,
        highestLosingBidBlock: 100n,
      },
      poolPolicy,
      {
        kind: "full_win",
        blockNumber: 103n,
        effectiveBidBps: 6_851n,
      },
    );

    expect(probe.currentBidBps).toBe(6_548n);
    expect(probe.state.lastObservedWinningBidBps).toBe(6_850n);

    const recovery = adjustAdaptiveBid(
      probe.state,
      poolPolicy,
      {
        kind: "miss",
        blockNumber: 104n,
        effectiveBidBps: 6_548n,
        observedWinningBidBps: 6_850n,
      },
    );

    expect(recovery.action).toBe("increased");
    expect(recovery.reason).toBe("probe_miss_recovery");
    expect(recovery.currentBidBps).toBe(6_851n);
  });

  it("holds an active probe after an unmeasured miss", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 4_000n,
        consecutiveFullWins: 0,
        activeProbeBidBps: 4_000n,
      },
      policy,
      {
        kind: "miss",
        blockNumber: 47n,
      },
    );

    expect(adjustment.action).toBe("held");
    expect(adjustment.reason).toBe(
      "probe_miss_without_higher_price",
    );
    expect(adjustment.currentBidBps).toBe(4_000n);
    expect(adjustment.state.activeProbeBidBps).toBe(4_000n);
  });

  it("holds an active probe when the measured winner bid less", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 4_000n,
        consecutiveFullWins: 0,
        activeProbeBidBps: 4_000n,
      },
      policy,
      {
        kind: "miss",
        blockNumber: 47n,
        observedWinningBidBps: 3_999n,
      },
    );

    expect(adjustment.action).toBe("held");
    expect(adjustment.reason).toBe(
      "probe_miss_without_higher_price",
    );
    expect(adjustment.currentBidBps).toBe(4_000n);
    expect(adjustment.state.activeProbeBidBps).toBe(4_000n);
  });

  it("retires contradicted competitor evidence after repeated cheaper wins", () => {
    const miss = adjustAdaptiveBid(
      {
        currentBidBps: 8_644n,
        consecutiveFullWins: 0,
      },
      {
        ...policy,
        baselineBidBps: 8_644n,
      },
      {
        kind: "miss",
        blockNumber: 48n,
        effectiveBidBps: 3_690n,
        observedWinningBidBps: 3_850n,
      },
    );

    expect(miss.currentBidBps).toBe(8_829n);
    expect(miss.state.highestLosingBidBps).toBe(3_690n);
    expect(miss.state.lastObservedWinningBidBps).toBe(3_850n);

    let state = miss.state;
    for (const blockNumber of [49n, 50n]) {
      state = adjustAdaptiveBid(
        state,
        {
          ...policy,
          baselineBidBps: 8_644n,
        },
        {
          kind: "full_win",
          blockNumber,
          effectiveBidBps: 3_762n,
        },
      ).state;
    }

    expect(state.currentBidBps).toBe(8_829n);
    expect(state.lastObservedWinningBidBps).toBe(3_850n);

    const third = adjustAdaptiveBid(
      state,
      {
        ...policy,
        baselineBidBps: 8_644n,
      },
      {
        kind: "full_win",
        blockNumber: 51n,
        effectiveBidBps: 3_762n,
      },
    );
    state = third.state;

    expect(state.lowestWinningBidBps).toBe(3_762n);
    expect(state.highestLosingBidBps).toBe(3_690n);
    expect(state.lastObservedWinningBidBps).toBeUndefined();
    expect(state.lastObservedWinningBlock).toBeUndefined();
    expect(state.currentBidBps).toBe(8_805n);
    expect(state.activeProbeBidBps).toBe(8_805n);
  });

  it("does not combine an expensive win with a cheaper contradiction streak", () => {
    let state = adjustAdaptiveBid(
      {
        currentBidBps: 8_644n,
        consecutiveFullWins: 0,
      },
      {
        ...policy,
        baselineBidBps: 8_644n,
      },
      {
        kind: "miss",
        blockNumber: 60n,
        effectiveBidBps: 3_690n,
        observedWinningBidBps: 3_850n,
      },
    ).state;

    for (const [blockNumber, effectiveBidBps] of [
      [61n, 3_762n],
      [62n, 8_644n],
      [63n, 3_762n],
      [64n, 3_762n],
    ] as const) {
      state = adjustAdaptiveBid(
        state,
        {
          ...policy,
          baselineBidBps: 8_644n,
        },
        {
          kind: "full_win",
          blockNumber,
          effectiveBidBps,
        },
      ).state;
    }

    expect(state.currentBidBps).toBe(8_805n);
    expect(state.lastObservedWinningBidBps).toBe(3_850n);
    expect(state.consecutiveContradictingWins).toBe(2);

    state = adjustAdaptiveBid(
      state,
      {
        ...policy,
        baselineBidBps: 8_644n,
      },
      {
        kind: "full_win",
        blockNumber: 65n,
        effectiveBidBps: 3_762n,
      },
    ).state;

    expect(state.currentBidBps).toBe(8_805n);
    expect(state.lastObservedWinningBidBps).toBeUndefined();
    expect(state.consecutiveContradictingWins).toBeUndefined();
  });

  it("recovers to a known winning ceiling and keeps the failed probe bracket", () => {
    const miss = adjustAdaptiveBid(
      {
        currentBidBps: 4_000n,
        consecutiveFullWins: 0,
        lowestWinningBidBps: 6_000n,
        activeProbeBidBps: 4_000n,
      },
      policy,
      {
        kind: "miss",
        blockNumber: 52n,
        effectiveBidBps: 4_000n,
        observedWinningBidBps: 5_000n,
      },
    );

    expect(miss.currentBidBps).toBe(6_000n);
    expect(miss.state.highestLosingBidBps).toBe(4_000n);

    let state = miss.state;
    for (const blockNumber of [53n, 54n, 55n]) {
      state = adjustAdaptiveBid(state, policy, {
        kind: "full_win",
        blockNumber,
        effectiveBidBps: 6_000n,
      }).state;
    }

    expect(state.currentBidBps).toBe(5_012n);
    expect(state.currentBidBps).toBeGreaterThan(4_000n);
  });

  it("holds an unmeasured miss at a proven below-baseline ceiling", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 4_000n,
        consecutiveFullWins: 0,
        lowestWinningBidBps: 4_000n,
      },
      policy,
      {
        kind: "miss",
        blockNumber: 56n,
        effectiveBidBps: 4_000n,
      },
    );

    expect(adjustment.action).toBe("held");
    expect(adjustment.currentBidBps).toBe(4_000n);
    expect(adjustment.state.lowestWinningBidBps).toBe(4_000n);
    expect(adjustment.state.highestLosingBidBps).toBeUndefined();
  });

  it("recognizes a downward probe that remains above the starting bid", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 8_500n,
        consecutiveFullWins: 0,
        lowestWinningBidBps: 9_000n,
        activeProbeBidBps: 8_500n,
      },
      {
        ...policy,
        baselineBidBps: 8_100n,
        maximumBidBps: 9_900n,
      },
      {
        kind: "miss",
        blockNumber: 57n,
        effectiveBidBps: 8_500n,
        observedWinningBidBps: 8_500n,
      },
    );

    expect(adjustment.currentBidBps).toBe(9_000n);
    expect(adjustment.state.highestLosingBidBps).toBe(8_500n);
  });

  it("does not revive stale losing evidence with a cheaper failed probe", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 3_000n,
        consecutiveFullWins: 0,
        lowestWinningBidBps: 6_000n,
        highestLosingBidBps: 5_000n,
        highestLosingBidBlock: 1n,
        activeProbeBidBps: 3_000n,
      },
      policy,
      {
        kind: "miss",
        blockNumber: 7_202n,
        effectiveBidBps: 3_000n,
        observedWinningBidBps: 3_000n,
      },
    );

    expect(adjustment.currentBidBps).toBe(6_000n);
    expect(adjustment.state.highestLosingBidBps).toBe(3_000n);
    expect(adjustment.state.highestLosingBidBlock).toBe(7_202n);
  });

  it("caps loss escalation at the configured maximum", () => {
    const adjustment = adjustAdaptiveBid(
      initialAdaptiveBidState(policy),
      policy,
      {
        kind: "miss",
        blockNumber: 47n,
        observedWinningBidBps: 10_500n,
      },
    );

    expect(adjustment.currentBidBps).toBe(9_900n);
  });

  it("persists independent bid state for each order", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "pull-pool-bids-"),
    );
    const statePath = join(directory, "state.json");
    try {
      const controller = await AdaptiveBidController.load(
        policy,
        statePath,
      );
      await controller.observeBatch([
        {
          target: "0x0000000000000000000000000000000000000001",
          outcome: {
            kind: "miss",
            blockNumber: 48n,
            observedWinningBidBps: 8_597n,
          },
        },
        {
          target: "0x0000000000000000000000000000000000000002",
          outcome: {
            kind: "miss",
            blockNumber: 48n,
            observedWinningBidBps: 6_547n,
          },
        },
      ]);

      const reloaded = await AdaptiveBidController.load(
        policy,
        statePath,
      );
      expect(
        reloaded.currentBidBps(
          "0x0000000000000000000000000000000000000001",
        ),
      ).toBe(8_622n);
      expect(
        reloaded.currentBidBps(
          "0x0000000000000000000000000000000000000002",
        ),
      ).toBe(8_100n);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports a durable persistence backend", async () => {
    const saved = new Map<string, AdaptiveBidState>([
      [
        "0x0000000000000000000000000000000000000001",
        {
          currentBidBps: 8_700n,
          consecutiveFullWins: 1,
        },
      ],
    ]);
    let closed = false;
    const persistence: AdaptiveBidPersistence = {
      load: async () => new Map(saved),
      save: async (states) => {
        saved.clear();
        for (const [order, state] of states) {
          saved.set(order, state);
        }
      },
      close: async () => {
        closed = true;
      },
    };
    const controller =
      await AdaptiveBidController.loadWithPersistence(
        policy,
        persistence,
      );

    expect(
      controller.currentBidBps(
        "0x0000000000000000000000000000000000000001",
      ),
    ).toBe(8_700n);
    await controller.observe(
      "0x0000000000000000000000000000000000000002",
      {
        kind: "miss",
        blockNumber: 50n,
        observedWinningBidBps: 8_800n,
      },
    );
    expect(
      saved.get(
        "0x0000000000000000000000000000000000000002",
      )?.currentBidBps,
    ).toBe(8_825n);

    await controller.close();
    expect(closed).toBe(true);
  });

  it("reloads a file-backed learned bid below the starting bid", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "pull-pool-bids-"),
    );
    const statePath = join(directory, "state.json");
    try {
      await writeFile(
        statePath,
        JSON.stringify({
          version: 2,
          orders: {
            "0x0000000000000000000000000000000000000001": {
              currentBidBps: "6000",
              consecutiveFullWins: 2,
              lowestWinningBidBps: "6000",
              highestLosingBidBps: "4000",
            },
          },
        }),
      );
      const controller = await AdaptiveBidController.load(
        policy,
        statePath,
      );
      expect(
        controller.currentBidBps(
          "0x0000000000000000000000000000000000000001",
        ),
      ).toBe(6_000n);
      const probe = await controller.observe(
        "0x0000000000000000000000000000000000000001",
        {
          kind: "full_win",
          blockNumber: 60n,
          effectiveBidBps: 6_000n,
        },
      );
      expect(probe.currentBidBps).toBe(5_012n);
      const reloaded = await AdaptiveBidController.load(
        policy,
        statePath,
      );
      const recovery = await reloaded.observe(
        "0x0000000000000000000000000000000000000001",
        {
          kind: "miss",
          blockNumber: 61n,
          effectiveBidBps: 5_012n,
          observedWinningBidBps: 5_012n,
        },
      );
      expect(recovery.currentBidBps).toBe(6_000n);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("adaptive bid configuration", () => {
  it("defaults the learned maximum to the full gross reward", () => {
    const previousMaximum = process.env.ADAPTIVE_BID_MAX_BPS;
    try {
      delete process.env.ADAPTIVE_BID_MAX_BPS;
      expect(loadConfig().adaptiveBidMaxBps).toBe(10_000n);
    } finally {
      if (previousMaximum === undefined) {
        delete process.env.ADAPTIVE_BID_MAX_BPS;
      } else {
        process.env.ADAPTIVE_BID_MAX_BPS = previousMaximum;
      }
    }
  });

  it("defaults the learned minimum below the starting bid", () => {
    const previousMinimum = process.env.ADAPTIVE_BID_MIN_BPS;
    try {
      delete process.env.ADAPTIVE_BID_MIN_BPS;
      expect(loadConfig().adaptiveBidMinBps).toBe(1_000n);
    } finally {
      if (previousMinimum === undefined) {
        delete process.env.ADAPTIVE_BID_MIN_BPS;
      } else {
        process.env.ADAPTIVE_BID_MIN_BPS = previousMinimum;
      }
    }
  });

  it("rejects a learned minimum above the starting bid", () => {
    const previousMinimum = process.env.ADAPTIVE_BID_MIN_BPS;
    const previousStartingBid = process.env.BUILDER_BID_BPS;
    try {
      process.env.ADAPTIVE_BID_MIN_BPS = "9000";
      process.env.BUILDER_BID_BPS = "8100";
      expect(() => loadConfig()).toThrow(
        "ADAPTIVE_BID_MIN_BPS must be <= BUILDER_BID_BPS",
      );
    } finally {
      if (previousMinimum === undefined) {
        delete process.env.ADAPTIVE_BID_MIN_BPS;
      } else {
        process.env.ADAPTIVE_BID_MIN_BPS = previousMinimum;
      }
      if (previousStartingBid === undefined) {
        delete process.env.BUILDER_BID_BPS;
      } else {
        process.env.BUILDER_BID_BPS = previousStartingBid;
      }
    }
  });
});
