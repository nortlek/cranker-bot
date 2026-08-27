import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import {
  fwairDropMinimumViablePrefix,
  fwairDropReimbursedGasCap,
  fwairDropRequestCalls,
  fwairDropSyncSettleCalls,
} from "../src/fwair-drop.js";
import { fwairDropRoundAbi } from "../src/fwair-drop-keeper-executor.js";

describe("FWAIR drop same-block follow-on composition", () => {
  it("keeps a profitable first action when the follow-on is optional", () => {
    expect(fwairDropMinimumViablePrefix({
      executorDeploymentRequired: false,
      minimumPlannedJobs: 1,
    })).toBe(1);
    expect(fwairDropMinimumViablePrefix({
      executorDeploymentRequired: true,
      minimumPlannedJobs: 1,
    })).toBe(2);
  });

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
    expect(fwairDropReimbursedGasCap(calls)).toBe(2_200_000n);
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
    expect(fwairDropReimbursedGasCap(calls)).toBe(1_500_000n);
  });
});
