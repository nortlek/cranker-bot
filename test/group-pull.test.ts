import { parseEther } from "viem";
import { describe, expect, it } from "vitest";

import {
  groupPullAbi,
  groupPullStandingOrderAbi,
  groupPullStandingOrderFactoryAbi,
} from "../src/abi.js";
import {
  GROUP_PULL_ADDRESS,
  GROUP_PULL_DEPLOYMENT_BLOCK,
  GROUP_PULL_RUNTIME_CODE_HASH,
  GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS,
  GROUP_PULL_STANDING_ORDER_FACTORY_RUNTIME_CODE_HASH,
} from "../src/constants.js";
import {
  GROUP_PULL_DEPENDENT_COLLECT_GAS_LIMIT,
  groupPullBountyForCalls,
  groupPullCollectAfterSettlement,
} from "../src/group-pull.js";
import {
  groupPullSubmitRewardAfterFinalEntry,
  pendingGroupPullGasUsed,
} from "../src/pending-group-pull-backrun.js";

describe("GroupPull bounty accounting", () => {
  it("pins the canonical successor deployment", () => {
    expect(GROUP_PULL_ADDRESS).toBe(
      "0xd23DCbfD47E849DAC946689E264AaD3c6bbD4187",
    );
    expect(GROUP_PULL_DEPLOYMENT_BLOCK).toBe(25_671_215n);
    expect(GROUP_PULL_RUNTIME_CODE_HASH).toBe(
      "0x3c53349d2d4b4c59cab54e3844c17ad6dc4c1967c0329801076923fb0e1957a7",
    );
  });

  it("pins the successor round layout and collecting call", () => {
    const getRound = groupPullAbi.find(
      (entry) => entry.type === "function" && entry.name === "getRound",
    );
    expect(getRound?.outputs[0]?.components?.map(({ name }) => name)).toEqual([
      "entryPrice",
      "incentivePerTicket",
      "pullsPerRound",
      "maxParticipants",
      "sellsFrom",
      "sellsUntil",
      "entryDuration",
      "submitWindow",
      "ticketsSold",
      "escrow",
      "bountyPot",
      "ethPool",
      "ethPaid",
      "fwaPot",
      "fwaPaid",
      "surchargePot",
      "escalationThreshold",
      "escalationRateBps",
      "bought",
      "pullsCollected",
      "bountyShares",
      "submitDeadline",
      "aborted",
      "state",
    ]);
    expect(
      groupPullAbi.some(
        (entry) => entry.type === "function" && entry.name === "collect",
      ),
    ).toBe(true);
  });

  it("pins the canonical GroupPull standing-order factory and crank surface", () => {
    expect(GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS).toBe(
      "0x2315F319c0E47AFa26c6167e0e3a4DC46585F605",
    );
    expect(GROUP_PULL_STANDING_ORDER_FACTORY_RUNTIME_CODE_HASH).toBe(
      "0xb2f3058bb25e51e28915a6f0fff1dbbb9adf637a8175bc371d1e220e915b4ba8",
    );
    expect(
      groupPullStandingOrderFactoryAbi.some(
        (entry) =>
          entry.type === "function" && entry.name === "isOrder",
      ),
    ).toBe(true);
    expect(
      groupPullStandingOrderAbi.some(
        (entry) => entry.type === "function" && entry.name === "crank",
      ),
    ).toBe(true);
  });

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

  it("builds an exact-simulation collect unlocked by a pool settlement", () => {
    const job = groupPullCollectAfterSettlement({
      contexts: [
        {
          roundId: 12n,
          bountyPot: parseEther("0.003"),
          bountyShares: 3,
          poolRoundIds: [285n, 286n],
          collected: [false, false],
          rounds: [
            { state: 4, tokenPot: 0n },
            { state: 2, tokenPot: 0n },
          ],
          canPayTokens: false,
          firstCollections: 1,
        },
      ],
      poolRoundId: 286n,
      builderBidBps: 9_100n,
    });

    expect(job).toMatchObject({
      kind: "group_pull_collect",
      label: "group_pull_collect:12:1:after_settle",
      gas: GROUP_PULL_DEPENDENT_COLLECT_GAS_LIMIT,
      configuredBuilderBidBps: 9_100n,
      requiresBundleSimulation: true,
      roundId: 12n,
      reward: { kind: "fixed", amountWei: parseEther("0.001") },
    });
  });

  it("does not speculate on unavailable token settlement proceeds", () => {
    expect(
      groupPullCollectAfterSettlement({
        contexts: [
          {
            roundId: 12n,
            bountyPot: parseEther("0.001"),
            bountyShares: 1,
            poolRoundIds: [286n],
            collected: [false],
            rounds: [{ state: 3, tokenPot: 1n }],
            canPayTokens: false,
            firstCollections: 0,
          },
        ],
        poolRoundId: 286n,
        builderBidBps: 9_100n,
      }),
    ).toBeUndefined();
  });

  it("excludes the final entrant's close bounty from the keeper submit reward", () => {
    expect(
      groupPullSubmitRewardAfterFinalEntry({
        bountyPot: parseEther("0.0018"),
        pullsPerRound: 1,
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
