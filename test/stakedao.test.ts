import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  conservativeCrvToEthWei,
  conservativeStakeDaoHarvesterFee,
  isFreshChainlinkRound,
  stakeDaoGaugePrefixes,
} from "../src/stakedao.js";

const ETHER = 1_000_000_000_000_000_000n;

describe("Stake DAO harvest economics", () => {
  it("matches the Accountant order for reserved and new caller fees", () => {
    expect(
      conservativeStakeDaoHarvesterFee({
        claimableCrv: 1_000n * ETHER,
        harvestFeePercent: ETHER / 1_000n,
        accounting: {
          supply: 1n,
          netCredited: 100n * ETHER,
          reservedHarvestFee: 1n * ETHER,
          reservedProtocolFee: 10n * ETHER,
        },
      }),
    ).toBe(1_889_000_000_000_000_000n);
  });

  it("counts only a reserved fee when no vault supply can earn a new fee", () => {
    expect(
      conservativeStakeDaoHarvesterFee({
        claimableCrv: 100n * ETHER,
        harvestFeePercent: ETHER / 1_000n,
        accounting: {
          supply: 0n,
          netCredited: 0n,
          reservedHarvestFee: ETHER / 2n,
          reservedProtocolFee: 0n,
        },
      }),
    ).toBe(ETHER / 2n);
  });

  it("converts CRV to ETH with downward rounding and a haircut", () => {
    expect(
      conservativeCrvToEthWei({
        crvAmount: ETHER,
        crvUsd: 50_000_000n,
        ethUsd: 250_000_000_000n,
        haircutBps: 9_500n,
      }),
    ).toBe(190_000_000_000_000n);
  });
});

describe("Stake DAO safety helpers", () => {
  it("fails closed if the live lane is paired with public submission", () => {
    const previousEnabled =
      process.env.ENABLE_STAKEDAO_CURVE_HARVESTS;
    const previousMode = process.env.SUBMISSION_MODE;
    try {
      process.env.ENABLE_STAKEDAO_CURVE_HARVESTS = "true";
      process.env.SUBMISSION_MODE = "public";
      expect(() => loadConfig()).toThrow(
        "ENABLE_STAKEDAO_CURVE_HARVESTS requires SUBMISSION_MODE=flashbots",
      );
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.ENABLE_STAKEDAO_CURVE_HARVESTS;
      } else {
        process.env.ENABLE_STAKEDAO_CURVE_HARVESTS =
          previousEnabled;
      }
      if (previousMode === undefined) {
        delete process.env.SUBMISSION_MODE;
      } else {
        process.env.SUBMISSION_MODE = previousMode;
      }
    }
  });

  it("requires a complete, current Chainlink round", () => {
    const valid = {
      roundId: 10n,
      answer: 1n,
      updatedAt: 1_000n,
      answeredInRound: 10n,
      nowSeconds: 1_100n,
      maximumAgeSeconds: 200n,
    };
    expect(isFreshChainlinkRound(valid)).toBe(true);
    expect(
      isFreshChainlinkRound({
        ...valid,
        answeredInRound: 9n,
      }),
    ).toBe(false);
    expect(
      isFreshChainlinkRound({
        ...valid,
        nowSeconds: 1_201n,
      }),
    ).toBe(false);
  });

  it("builds only bounded prefixes", () => {
    expect(stakeDaoGaugePrefixes(["a", "b", "c"], 2)).toEqual([
      ["a"],
      ["a", "b"],
    ]);
  });
});
