import { parseEther } from "viem";
import { describe, expect, it } from "vitest";

import { groupPullBountyForCalls } from "../src/group-pull.js";
import {
  groupPullSubmitRewardAfterFinalEntry,
  pendingGroupPullGasUsed,
} from "../src/pending-group-pull-backrun.js";

describe("GroupPull bounty accounting", () => {
  it("mirrors the contract's shrinking-pot and shrinking-share division", () => {
    expect(
      groupPullBountyForCalls({
        bountyPot: 10n,
        bountyShares: 3,
        calls: 3,
      }),
    ).toBe(10n);
    expect(
      groupPullBountyForCalls({
        bountyPot: 10n,
        bountyShares: 3,
        calls: 2,
      }),
    ).toBe(6n);
  });

  it("excludes the final entrant's close bounty from the keeper submit reward", () => {
    expect(
      groupPullSubmitRewardAfterFinalEntry({
        bountyPot: parseEther("0.0018"),
        bountyShares: 3,
        incentivePerTicket: parseEther("0.0003"),
        quantity: 4,
        submitCalls: 2,
      }),
    ).toBe(parseEther("0.002"));
  });

  it("accounts only for the keeper transaction at bundle index one", () => {
    expect(
      pendingGroupPullGasUsed({
        simulation: {
          results: [
            { gasUsed: "181000" },
            { gasUsed: "2797379" },
          ],
        },
      }),
    ).toBe(2_797_379n);
  });

  it("requires both prerequisite and keeper transactions to simulate", () => {
    expect(() =>
      pendingGroupPullGasUsed({
        simulation: {
          results: [
            { gasUsed: "181000" },
            { gasUsed: "2797379", revert: "WrongState" },
          ],
        },
      }),
    ).toThrow("did not simulate both transactions");
  });
});
