import { describe, expect, it } from "vitest";

import {
  hypertoadzAbi,
  hypertoadzCanFinalizeInNextBlock,
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
});
