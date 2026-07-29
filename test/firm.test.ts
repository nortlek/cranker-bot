import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiParameters,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  erc20Abi,
  firmDbrAbi,
  firmMarketAbi,
} from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import {
  FIRM_DBR_ADDRESS,
  FIRM_DOLA_ADDRESS,
} from "../src/constants.js";
import {
  accountFirmReceipt,
  conservativeDolaToUsd,
  conservativeDolaToEthWei,
  firmBlockRanges,
  firmForceReplenishCalldata,
  firmOracleRoundsAreFresh,
  firmOracleRoundStatus,
  firmReplenishmentAmounts,
} from "../src/firm.js";
import { planFirmReplenishment } from "../src/strategy.js";

const MARKET = getAddress(
  "0x48BA574Edf0bc4E2E40B529863aaA6a67c264E7C",
);
const BORROWER = getAddress(
  "0x52555b437EeE8F55a7897B4E1F8fB3e7Edb2b344",
);
const REPLENISHER = getAddress(
  "0xeAaf34AEaF4A10F9c5f5400E0bD6f9f5a8Ba2D48",
);

describe("FiRM forced-replenishment economics", () => {
  it("matches the contract's two downward-rounded DOLA calculations", () => {
    expect(
      firmReplenishmentAmounts({
        deficit: 100_001n,
        replenishmentPriceBps: 5_475n,
        replenishmentIncentiveBps: 1_000n,
      }),
    ).toEqual({
      replenishmentCostDola: 54_750n,
      replenisherRewardDola: 5_475n,
    });
  });

  it("caps DOLA at one USD and applies a final haircut", () => {
    const oneDola = 10n ** 18n;
    expect(
      conservativeDolaToEthWei({
        dolaAmount: oneDola,
        dolaUsd: 101_000_000n,
        dolaUsdDecimals: 8,
        ethUsd: 250_000_000_000n,
        ethUsdDecimals: 8,
        haircutBps: 9_500n,
      }),
    ).toBe(380_000_000_000_000n);
    expect(
      conservativeDolaToUsd({
        dolaAmount: oneDola,
        dolaUsd: 101_000_000n,
        dolaUsdDecimals: 8,
        outputUsdDecimals: 8,
        haircutBps: 9_500n,
      }),
    ).toBe(95_000_000n);
  });

  it("applies independent DOLA and ETH oracle freshness limits", () => {
    const nowSeconds = 100_000n;
    const dolaRound = {
      roundId: 10n,
      answer: 100_000_000n,
      updatedAt: 10_000n,
      answeredInRound: 10n,
    };
    const staleEthRound = {
      roundId: 20n,
      answer: 250_000_000_000n,
      updatedAt: 92_799n,
      answeredInRound: 20n,
    };
    expect(
      firmOracleRoundsAreFresh({
        dolaRound,
        ethRound: staleEthRound,
        nowSeconds,
        dolaMaximumAgeSeconds: 90_000n,
        ethMaximumAgeSeconds: 7_200n,
      }),
    ).toBe(false);
    expect(
      firmOracleRoundsAreFresh({
        dolaRound,
        ethRound: { ...staleEthRound, updatedAt: 92_800n },
        nowSeconds,
        dolaMaximumAgeSeconds: 90_000n,
        ethMaximumAgeSeconds: 7_200n,
      }),
    ).toBe(true);
  });

  it("rejects incomplete DOLA oracle rounds before valuation", () => {
    expect(
      firmOracleRoundStatus({
        round: {
          roundId: 10n,
          answer: 100_000_000n,
          updatedAt: 99_000n,
          answeredInRound: 9n,
        },
        nowSeconds: 100_000n,
        maximumAgeSeconds: 90_000n,
      }),
    ).toBe("incomplete_round");
  });
});

describe("FiRM race safety", () => {
  it("encodes only forceReplenish with the exact observed positive deficit", () => {
    const observedDeficit = 123_456_789n;
    const data = firmForceReplenishCalldata({
      account: BORROWER,
      fixedObservedDeficit: observedDeficit,
    });
    const decoded = decodeFunctionData({
      abi: firmMarketAbi,
      data,
    });
    expect(decoded.functionName).toBe("forceReplenish");
    expect(decoded.args).toEqual([BORROWER, observedDeficit]);
  });

  it("rejects zero instead of constructing forceReplenishAll behavior", () => {
    expect(() =>
      firmForceReplenishCalldata({
        account: BORROWER,
        fixedObservedDeficit: 0n,
      }),
    ).toThrow("must be positive");
  });

  it("keeps discovery pages bounded and inclusive", () => {
    expect(firmBlockRanges(10n, 20n, 4n)).toEqual([
      { fromBlock: 10n, toBlock: 13n },
      { fromBlock: 14n, toBlock: 17n },
      { fromBlock: 18n, toBlock: 20n },
    ]);
  });
});

describe("FiRM receipt accounting", () => {
  const fixedDeficit = 100_001n;
  const replenishmentCostDola = 54_750n;
  const replenisherRewardDola = 5_475n;
  const forceLog = {
    address: FIRM_DBR_ADDRESS,
    topics: encodeEventTopics({
      abi: firmDbrAbi,
      eventName: "ForceReplenish",
      args: {
        account: BORROWER,
        replenisher: REPLENISHER,
        market: MARKET,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      parseAbiParameters("uint256,uint256,uint256"),
      [
        fixedDeficit,
        replenishmentCostDola,
        replenisherRewardDola,
      ],
    ),
  };
  const transferLog = {
    address: FIRM_DOLA_ADDRESS,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: {
        from: MARKET,
        to: REPLENISHER,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      parseAbiParameters("uint256"),
      [replenisherRewardDola],
    ),
  };

  it("requires the exact DBR event, DOLA transfer, and balance delta", () => {
    expect(
      accountFirmReceipt({
        logs: [forceLog, transferLog],
        market: MARKET,
        account: BORROWER,
        replenisher: REPLENISHER,
        fixedDeficit,
        expectedReplenishmentCostDola: replenishmentCostDola,
        expectedReplenisherRewardDola: replenisherRewardDola,
        dolaBalanceBefore: 1_000n,
        dolaBalanceAfter: 1_000n + replenisherRewardDola,
      }),
    ).toEqual({
      valid: true,
      fixedDeficit,
      replenishmentCostDola,
      replenisherRewardDola,
      dolaBalanceDelta: replenisherRewardDola,
    });
  });

  it("fails closed when the observed DOLA balance delta disagrees", () => {
    const accounting = accountFirmReceipt({
      logs: [forceLog, transferLog],
      market: MARKET,
      account: BORROWER,
      replenisher: REPLENISHER,
      fixedDeficit,
      expectedReplenishmentCostDola: replenishmentCostDola,
      expectedReplenisherRewardDola: replenisherRewardDola,
      dolaBalanceBefore: 1_000n,
      dolaBalanceAfter: 1_001n,
    });
    expect(accounting.valid).toBe(false);
    expect(accounting.reason).toBe("dola_balance_delta_mismatch");
  });
});

describe("FiRM configuration safety", () => {
  it("performs no RPC work while the feature is disabled", async () => {
    const config = {
      ...loadConfig(),
      enableFirmReplenishments: false,
    };
    await expect(
      planFirmReplenishment({
        client: undefined as never,
        discoveryClient: undefined as never,
        account: REPLENISHER,
        config,
        maxFeePerGas: 1n,
        headBlockNumber: 1n,
        headTimestamp: 1n,
        skipped: new Map(),
      }),
    ).resolves.toBeUndefined();
  });

  it("uses separate long-DOLA and short-ETH freshness defaults", () => {
    const previousDola =
      process.env.FIRM_DOLA_ORACLE_MAX_AGE_SECONDS;
    const previousEth =
      process.env.FIRM_ETH_ORACLE_MAX_AGE_SECONDS;
    try {
      delete process.env.FIRM_DOLA_ORACLE_MAX_AGE_SECONDS;
      delete process.env.FIRM_ETH_ORACLE_MAX_AGE_SECONDS;
      const config = loadConfig();
      expect(config.firmDolaOracleMaxAgeSeconds).toBe(90_000);
      expect(config.firmEthOracleMaxAgeSeconds).toBe(7_200);
    } finally {
      if (previousDola === undefined) {
        delete process.env.FIRM_DOLA_ORACLE_MAX_AGE_SECONDS;
      } else {
        process.env.FIRM_DOLA_ORACLE_MAX_AGE_SECONDS =
          previousDola;
      }
      if (previousEth === undefined) {
        delete process.env.FIRM_ETH_ORACLE_MAX_AGE_SECONDS;
      } else {
        process.env.FIRM_ETH_ORACLE_MAX_AGE_SECONDS =
          previousEth;
      }
    }
  });

  it("defaults the live lane off", () => {
    const previous = process.env.ENABLE_FIRM_REPLENISHMENTS;
    try {
      delete process.env.ENABLE_FIRM_REPLENISHMENTS;
      expect(loadConfig().enableFirmReplenishments).toBe(false);
    } finally {
      if (previous !== undefined) {
        process.env.ENABLE_FIRM_REPLENISHMENTS = previous;
      }
    }
  });

  it("fails closed when enabled with public submission", () => {
    const previousEnabled = process.env.ENABLE_FIRM_REPLENISHMENTS;
    const previousMode = process.env.SUBMISSION_MODE;
    try {
      process.env.ENABLE_FIRM_REPLENISHMENTS = "true";
      process.env.SUBMISSION_MODE = "public";
      expect(() => loadConfig()).toThrow(
        "ENABLE_FIRM_REPLENISHMENTS requires SUBMISSION_MODE=flashbots",
      );
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.ENABLE_FIRM_REPLENISHMENTS;
      } else {
        process.env.ENABLE_FIRM_REPLENISHMENTS = previousEnabled;
      }
      if (previousMode === undefined) {
        delete process.env.SUBMISSION_MODE;
      } else {
        process.env.SUBMISSION_MODE = previousMode;
      }
    }
  });
});
