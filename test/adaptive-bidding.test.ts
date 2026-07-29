import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdaptiveBidController,
  adjustAdaptiveBid,
  initialAdaptiveBidState,
  type AdaptiveBidPolicy,
} from "../src/adaptive-bidding.js";

const policy: AdaptiveBidPolicy = {
  baselineBidBps: 8_100n,
  maximumBidBps: 9_900n,
  lossStepBps: 25n,
  winDecayBps: 10n,
  winsBeforeDecay: 3,
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

  it("holds wins before slowly decaying toward the baseline", () => {
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
    expect(third.currentBidBps).toBe(8_612n);
    expect(third.state.consecutiveFullWins).toBe(0);
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
});
