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

  it("never probes below the measured winner plus margin", () => {
    const adjustment = adjustAdaptiveBid(
      {
        currentBidBps: 8_100n,
        consecutiveFullWins: 2,
        lastObservedWinningBidBps: 4_000n,
      },
      policy,
      {
        kind: "full_win",
        blockNumber: 46n,
      },
    );

    expect(adjustment.action).toBe("decreased");
    expect(adjustment.currentBidBps).toBe(6_062n);
    expect(adjustment.currentBidBps).toBeGreaterThan(4_000n);
  });

  it("returns to the starting bid after an unmeasured low-bid miss", () => {
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

    expect(adjustment.action).toBe("increased");
    expect(adjustment.currentBidBps).toBe(8_100n);
  });

  it("returns to the starting bid after a non-price probe miss", () => {
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
        observedWinningBidBps: 2_000n,
      },
    );

    expect(adjustment.action).toBe("increased");
    expect(adjustment.currentBidBps).toBe(8_100n);
  });

  it("learns from the effective profit-capped bid", () => {
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

    expect(miss.currentBidBps).toBe(8_644n);
    expect(miss.state.highestLosingBidBps).toBe(3_690n);
    expect(miss.state.lastObservedWinningBidBps).toBe(3_850n);

    let state = miss.state;
    for (const blockNumber of [49n, 50n, 51n]) {
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

    expect(state.lowestWinningBidBps).toBe(3_762n);
    expect(state.highestLosingBidBps).toBe(3_690n);
    expect(state.lastObservedWinningBidBps).toBe(3_850n);
    expect(state.lastObservedWinningBlock).toBe(48n);
    expect(state.currentBidBps).toBe(8_644n);

    const aged = adjustAdaptiveBid(
      state,
      {
        ...policy,
        baselineBidBps: 8_644n,
      },
      {
        kind: "full_win",
        blockNumber: 7_249n,
        effectiveBidBps: 3_762n,
      },
    );
    expect(aged.currentBidBps).toBe(2_381n);
    expect(aged.state.activeProbeBidBps).toBe(2_381n);
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
          order: "0x0000000000000000000000000000000000000001",
          outcome: {
            kind: "miss",
            blockNumber: 48n,
            observedWinningBidBps: 8_597n,
          },
        },
        {
          order: "0x0000000000000000000000000000000000000002",
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
        },
      );
      expect(recovery.currentBidBps).toBe(6_000n);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("adaptive bid configuration", () => {
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
