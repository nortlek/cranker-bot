import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  MEGA_RIP_ADDRESS,
  MEGA_RIP_DEPLOYMENT_BLOCK,
  MEGA_RIP_RUNTIME_CODE_HASH,
} from "../src/constants.js";
import {
  MEGA_RIP_ACQUISITION_STATE,
  MEGA_RIP_STATE,
  megaRipAbi,
  megaRipFloorSettlementIsRewarded,
  megaRipFundingCanLockInNextBlock,
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
  } as const;
}

describe("MegaRip keeper adapter", () => {
  it("pins the funded canonical successor runtime", () => {
    expect(MEGA_RIP_ADDRESS).toBe(
      "0x68f8E0Bd62eD310F692Ae0D01F7e568948818D25",
    );
    expect(MEGA_RIP_DEPLOYMENT_BLOCK).toBe(25_721_560n);
    expect(MEGA_RIP_RUNTIME_CODE_HASH).toBe(
      "0x7cd2bfa992850e1fb61393852e38f7c48b0e4fc01031ad820f3e3fd95d55ad8b",
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
});
