import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import {
  fwairDropRequestCalls,
  fwairDropSyncSettleCalls,
} from "../src/fwair-drop.js";
import { fwairDropRoundAbi } from "../src/fwair-drop-keeper-executor.js";

describe("FWAIR drop same-block follow-on composition", () => {
  it("keeps sync and settlement in the first exactly metered transaction", () => {
    const calls = fwairDropSyncSettleCalls({
      count: 1n,
      index: 0n,
    });

    expect(
      calls.map(
        (data) => decodeFunctionData({ abi: fwairDropRoundAbi, data }).functionName,
      ),
    ).toEqual(["syncReveals", "settleBackstop"]);
  });

  it("encodes the newly unlocked request as a separate transaction", () => {
    const calls = fwairDropRequestCalls({
      witness: 182_966n,
    });

    expect(
      calls.map(
        (data) => decodeFunctionData({ abi: fwairDropRoundAbi, data }).functionName,
      ),
    ).toEqual(["requestPull"]);
  });
});
