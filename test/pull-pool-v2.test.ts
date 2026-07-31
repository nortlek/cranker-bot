import { describe, expect, it } from "vitest";

import type { KeeperConfig } from "../src/config.js";
import {
  PULL_POOL_SUCCESSOR_FACTORY_ADDRESS,
  PULL_POOL_V2_ADDRESS,
  PULL_POOL_V2_FACTORY_ADDRESS,
  PULL_POOL_V2_ORDER_FACTORY_ADDRESSES,
} from "../src/constants.js";
import { ROUND_STATE } from "../src/lifecycle.js";
import {
  activePullPoolV2RoundIds,
  configurePullPoolV2,
  pullPoolV2ShouldBeSelected,
  readPullPoolV2Routing,
} from "../src/pull-pool-v2.js";

describe("temporary PullPool V2 selection", () => {
  it("stays on V1 while V2 is pristine and paused", () => {
    expect(
      pullPoolV2ShouldBeSelected({
        paused: true,
        deprecated: false,
        roundCount: 0n,
        bytecodeValid: true,
        relationshipsValid: true,
      }),
    ).toBe(false);
  });

  it("selects verified V2 on unpause or after its first round", () => {
    for (const state of [
      { paused: false, roundCount: 0n },
      { paused: true, roundCount: 1n },
    ]) {
      expect(
        pullPoolV2ShouldBeSelected({
          ...state,
          deprecated: false,
          bytecodeValid: true,
          relationshipsValid: true,
        }),
      ).toBe(true);
    }
  });

  it("fails selection for deprecated or unverified deployments", () => {
    expect(
      pullPoolV2ShouldBeSelected({
        paused: false,
        deprecated: true,
        roundCount: 1n,
        bytecodeValid: true,
        relationshipsValid: true,
      }),
    ).toBe(false);
    expect(
      pullPoolV2ShouldBeSelected({
        paused: false,
        deprecated: false,
        roundCount: 1n,
        bytecodeValid: false,
        relationshipsValid: true,
      }),
    ).toBe(false);
  });

  it("switches canonical addresses and disarms version-specific pending lanes", () => {
    const selected = configurePullPoolV2({
      enableVaults: true,
      enablePendingFundingBackruns: true,
      enablePendingFwaFulfillmentBackruns: true,
      enableBuyback: true,
      enableLiveBidSweep: true,
      enableLiquityLiquidations: true,
      enableConvexEarmarks: true,
      enableConvexKicks: true,
      enableStakeDaoCurveHarvests: true,
      enableFirmReplenishments: true,
      poolBuilderBidBps: 300n,
      poolFulfilledBuilderBidBps: 7_250n,
    } as KeeperConfig);

    expect(selected.poolVersion).toBe("v2");
    expect(selected.expectedPoolAddress).toBe(
      PULL_POOL_V2_ADDRESS,
    );
    expect(selected.factoryAddress).toBe(
      PULL_POOL_V2_FACTORY_ADDRESS,
    );
    expect(selected.orderFactoryAddresses).toEqual(
      PULL_POOL_V2_ORDER_FACTORY_ADDRESSES,
    );
    expect(selected.orderFactoryAddresses).toContain(
      PULL_POOL_SUCCESSOR_FACTORY_ADDRESS,
    );
    expect(selected.enableVaults).toBe(false);
    expect(selected.enablePendingFundingBackruns).toBe(false);
    expect(
      selected.enablePendingFwaFulfillmentBackruns,
    ).toBe(false);
    expect(selected.poolFulfilledBuilderBidBps).toBe(300n);
    expect(selected.enableBuyback).toBe(false);
    expect(selected.enableLiveBidSweep).toBe(false);
    expect(selected.enableLiquityLiquidations).toBe(false);
    expect(selected.enableConvexEarmarks).toBe(false);
    expect(selected.enableConvexKicks).toBe(false);
    expect(selected.enableStakeDaoCurveHarvests).toBe(false);
    expect(selected.enableFirmReplenishments).toBe(false);
  });
});

describe("PullPool V2 active-round index", () => {
  it("removes settled and voided rounds", () => {
    expect(
      activePullPoolV2RoundIds([
        { eventName: "RoundOpened", args: { roundId: 1n } },
        { eventName: "RoundOpened", args: { roundId: 2n } },
        { eventName: "RoundSettled", args: { roundId: 1n } },
        { eventName: "RoundOpened", args: { roundId: 3n } },
        { eventName: "RoundVoided", args: { roundId: 2n } },
      ]),
    ).toEqual([3n]);
  });

  it("routes one open round and every concurrent lifecycle round", async () => {
    const getLogs = async () => [
      { eventName: "RoundOpened", args: { roundId: 1n } },
      { eventName: "RoundOpened", args: { roundId: 2n } },
      { eventName: "RoundOpened", args: { roundId: 3n } },
      { eventName: "RoundSettled", args: { roundId: 1n } },
    ];
    const readContract = async (request: {
      readonly functionName: string;
      readonly args?: readonly bigint[];
    }) => {
      if (request.functionName === "currentOpenRound") return 2n;
      if (request.functionName === "pendingPullCount") return 1n;
      const roundId = request.args?.[0];
      if (request.functionName === "ticketsNeeded") {
        return roundId === 2n ? 5n : 0n;
      }
      if (request.functionName === "getRound") {
        return {
          ticketPrice: 5_000_000_000_000_000n,
          crankBountyCap: 1_500_000_000_000_000n,
          bountyTipWei: 2_000_000_000n,
          fwaRequestId: roundId === 3n ? 99n : 0n,
          state:
            roundId === 2n
              ? ROUND_STATE.open
              : ROUND_STATE.pulling,
        };
      }
      throw new Error(
        `unexpected read ${request.functionName}`,
      );
    };

    const routing = await readPullPoolV2Routing(
      { getLogs, readContract } as never,
      25_640_000n,
    );

    expect(routing.activeRoundIds).toEqual([2n, 3n]);
    expect(routing.fundingRound?.roundId).toBe(2n);
    expect(
      routing.lifecycleRounds.map((round) => round.roundId),
    ).toEqual([3n]);
  });

  it("counts a claimable round as pending until settlement", async () => {
    const getLogs = async () => [
      { eventName: "RoundOpened", args: { roundId: 1n } },
      { eventName: "RoundOpened", args: { roundId: 2n } },
    ];
    const readContract = async (request: {
      readonly functionName: string;
      readonly args?: readonly bigint[];
    }) => {
      if (request.functionName === "currentOpenRound") return 2n;
      if (request.functionName === "pendingPullCount") return 1n;
      const roundId = request.args?.[0];
      if (request.functionName === "ticketsNeeded") {
        return roundId === 2n ? 4n : 0n;
      }
      if (request.functionName === "getRound") {
        return {
          ticketPrice: 5_000_000_000_000_000n,
          crankBountyCap: 1_500_000_000_000_000n,
          bountyTipWei: 2_000_000_000n,
          fwaRequestId: roundId === 1n ? 100n : 0n,
          state:
            roundId === 1n
              ? ROUND_STATE.claimable
              : ROUND_STATE.open,
        };
      }
      throw new Error(`unexpected read ${request.functionName}`);
    };

    const routing = await readPullPoolV2Routing(
      { getLogs, readContract } as never,
      25_639_999n,
    );

    expect(routing.pendingPullCount).toBe(1n);
    expect(
      routing.lifecycleRounds.map((round) => ({
        roundId: round.roundId,
        state: round.state,
      })),
    ).toEqual([
      { roundId: 1n, state: ROUND_STATE.claimable },
    ]);
  });
});
