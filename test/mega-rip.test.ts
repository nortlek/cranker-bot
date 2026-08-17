import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  MEGA_RIP_ADDRESS,
  MEGA_RIP_DEPLOYMENT_BLOCK,
  MEGA_RIP_RUNTIME_CODE_HASH,
} from "../src/constants.js";
import {
  MEGA_RIP_ACQUISITION_STATE,
  MEGA_RIP_SETTLEMENT_BUILDER_BID_BPS,
  MEGA_RIP_STATE,
  megaRipAbi,
  megaRipFloorSettlementIsRewarded,
  megaRipFundingCanLockInNextBlock,
  megaRipInitialPullCount,
  megaRipNextBlockRequestCount,
  readMegaRipAcquisitions,
  readMegaRipState,
  megaRipTerminalSettlementIsEligible,
} from "../src/mega-rip.js";

const zero = getAddress("0x0000000000000000000000000000000000000000");

function acquisition(
  overrides: Partial<{
    listingId: bigint;
    highBidder: `0x${string}`;
    deadline: bigint;
    status: number;
    auctionOpen: boolean;
    reserved: boolean;
  }> = {},
) {
  return {
    requestId: 1n,
    listingId: overrides.listingId ?? 9n,
    collection: getAddress("0x0000000000000000000000000000000000000001"),
    tokenId: 2n,
    backing: 3n,
    bidEquiv: 2n,
    reserve: 3n,
    highBid: 0n,
    highBidder: overrides.highBidder ?? zero,
    requestedAt: 1n,
    allocatedAt: 2n,
    deadline: overrides.deadline ?? 100n,
    hardDeadline: 200n,
    discountBps: 8_500,
    status: overrides.status ?? MEGA_RIP_ACQUISITION_STATE.ALLOCATED,
    auctionOpen: overrides.auctionOpen ?? true,
    reserved: overrides.reserved ?? true,
    syncReserved: true,
  } as const;
}

describe("MegaRip keeper adapter", () => {
  it("starts terminal settlement at the independent discovery bid", () => {
    expect(MEGA_RIP_SETTLEMENT_BUILDER_BID_BPS).toBe(1_000n);
  });

  it("pins the funded canonical successor runtime", () => {
    expect(MEGA_RIP_ADDRESS).toBe(
      "0x6769944589f5CC96d5F900F06539681Db84AC5c6",
    );
    expect(MEGA_RIP_DEPLOYMENT_BLOCK).toBe(25_771_992n);
    expect(MEGA_RIP_RUNTIME_CODE_HASH).toBe(
      "0x56b1436bab9f9a603fb91de8fea2d10abbb3adfb2d280e3ac71386b2d5e60661",
    );
    expect(
      megaRipAbi.some(
        (entry) => entry.type === "event" && entry.name === "BountyPaid",
      ),
    ).toBe(true);
  });

  it("arms the atomic lock and first pull for the exact next slot", () => {
    expect(
      megaRipFundingCanLockInNextBlock({
        state: MEGA_RIP_STATE.FUNDING,
        totalDeposited: 1n,
        fundingEndsAt: 1_012n,
        parentTimestamp: 1_000n,
      }),
    ).toBe(true);
    expect(
      megaRipFundingCanLockInNextBlock({
        state: MEGA_RIP_STATE.FUNDING,
        totalDeposited: 1n,
        fundingEndsAt: 1_013n,
        parentTimestamp: 1_000n,
      }),
    ).toBe(false);
  });

  it("prices only an expired no-bid allocation with its reserve intact", () => {
    expect(
      megaRipFloorSettlementIsRewarded({
        acquisition: acquisition(),
        blockTimestamp: 100n,
      }),
    ).toBe(true);
    expect(
      megaRipFloorSettlementIsRewarded({
        acquisition: acquisition({ deadline: 101n }),
        blockTimestamp: 100n,
      }),
    ).toBe(false);
    expect(
      megaRipFloorSettlementIsRewarded({
        acquisition: acquisition({
          highBidder: getAddress(
            "0x0000000000000000000000000000000000000002",
          ),
        }),
        blockTimestamp: 100n,
      }),
    ).toBe(false);
    expect(
      megaRipFloorSettlementIsRewarded({
        acquisition: acquisition({ reserved: false }),
        blockTimestamp: 100n,
      }),
    ).toBe(false);
  });

  it("prices three bounty legs and requests one paced pull at the boundary", () => {
    expect(
      megaRipInitialPullCount({
        totalDeposited: 7_497_800_000_000_000_000n,
        acquisitionPrice: 81_800_000_000_000_000n,
        bounty: 300_000_000_000_000n,
      }),
    ).toBe(1n);
    expect(
      megaRipInitialPullCount({
        totalDeposited: 824_000_000_000_000_000n,
        acquisitionPrice: 81_800_000_000_000_000n,
        bounty: 300_000_000_000_000n,
      }),
    ).toBe(1n);
    expect(
      megaRipInitialPullCount({
        totalDeposited: 82_699_999_999_999_999n,
        acquisitionPrice: 81_800_000_000_000_000n,
        bounty: 300_000_000_000_000n,
      }),
    ).toBe(0n);
  });

  it("arms one paced request only when the immediate child is eligible", () => {
    expect(
      megaRipNextBlockRequestCount({
        estimatedPullsRemaining: 9n,
        minRequestInterval: 10n,
        lastRequestAt: 1_000n,
        parentTimestamp: 998n,
      }),
    ).toBe(1n);
    expect(
      megaRipNextBlockRequestCount({
        estimatedPullsRemaining: 9n,
        minRequestInterval: 20n,
        lastRequestAt: 1_000n,
        parentTimestamp: 998n,
      }),
    ).toBe(0n);
    expect(
      megaRipNextBlockRequestCount({
        estimatedPullsRemaining: 0n,
        minRequestInterval: 10n,
        lastRequestAt: 1_000n,
        parentTimestamp: 1_000n,
      }),
    ).toBe(0n);
  });

  it("reads every acquisition through one exact-block multicall", async () => {
    const seen: unknown[] = [];
    const client = {
      multicall: async (parameters: unknown) => {
        seen.push(parameters);
        return [acquisition(), acquisition({ listingId: 10n })];
      },
    };

    const results = await readMegaRipAcquisitions({
      client: client as never,
      blockNumber: 123n,
      count: 2n,
    });

    expect(results).toHaveLength(2);
    expect(seen).toEqual([
      expect.objectContaining({
        allowFailure: false,
        blockNumber: 123n,
        contracts: [
          expect.objectContaining({ args: [0n] }),
          expect.objectContaining({ args: [1n] }),
        ],
      }),
    ]);
  });

  it("skips the acquisition multicall before the first paced request", async () => {
    const client = {
      multicall: async () => {
        throw new Error("unexpected multicall");
      },
    };
    await expect(
      readMegaRipAcquisitions({
        client: client as never,
        blockNumber: 123n,
        count: 0n,
      }),
    ).resolves.toEqual([]);
  });

  it("reads all hot MegaRip state through one exact-block multicall", async () => {
    const seen: unknown[] = [];
    const client = {
      multicall: async (parameters: unknown) => {
        seen.push(parameters);
        return [
          2,
          100n,
          1_000n,
          9n,
          4n,
          300n,
          2n,
          10,
          90n,
        ];
      },
    };

    await expect(
      readMegaRipState({
        client: client as never,
        blockNumber: 456n,
      }),
    ).resolves.toEqual({
      state: 2,
      fundingEndsAt: 100n,
      totalDeposited: 1_000n,
      pullsDone: 9n,
      estimatedPullsRemaining: 4n,
      bounty: 300n,
      pendingSyncCount: 2n,
      minRequestInterval: 10n,
      lastRequestAt: 90n,
    });
    expect(seen).toEqual([
      expect.objectContaining({
        allowFailure: false,
        blockNumber: 456n,
        contracts: expect.arrayContaining([
          expect.objectContaining({ functionName: "state" }),
          expect.objectContaining({ functionName: "crankBounty" }),
        ]),
      }),
    ]);
  });

  it("pursues the terminal bounty after either a no-bid or high-bid auction", () => {
    expect(
      megaRipTerminalSettlementIsEligible({
        acquisition: acquisition(),
        blockTimestamp: 100n,
      }),
    ).toBe(true);
    expect(
      megaRipTerminalSettlementIsEligible({
        acquisition: acquisition({
          highBidder: getAddress(
            "0x0000000000000000000000000000000000000002",
          ),
        }),
        blockTimestamp: 100n,
      }),
    ).toBe(true);
    expect(
      megaRipTerminalSettlementIsEligible({
        acquisition: acquisition({ deadline: 101n }),
        blockTimestamp: 100n,
      }),
    ).toBe(false);
  });
});
