import { afterEach, describe, expect, it } from "vitest";

import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
  FWA_PROCESS_DISCOVERY_MAX_COUNT,
  loadConfig,
  pendingFwaFulfillmentExecutionEnabled,
  pendingFundingExecutionEnabled,
} from "../src/config.js";

const originalFwaProcessGasLimit =
  process.env.FWA_PROCESS_GAS_LIMIT;
const originalFwaProcessMaxCount =
  process.env.FWA_PROCESS_MAX_COUNT;
const originalPendingFundingBackruns =
  process.env.ENABLE_PENDING_FUNDING_BACKRUNS;
const originalPendingFwaFulfillmentBackruns =
  process.env.ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS;
const originalDirectCoinbasePayments =
  process.env.ENABLE_DIRECT_COINBASE_PAYMENTS;
const originalLiveBidSweep =
  process.env.ENABLE_LIVE_BID_SWEEP;
const originalLiquityLiquidations =
  process.env.ENABLE_LIQUITY_LIQUIDATIONS;
const originalGachaTable = process.env.ENABLE_GACHA_TABLE;
const originalGachaTableDefaultBuilderBidBps =
  process.env.GACHA_TABLE_DEFAULT_BUILDER_BID_BPS;
const originalGachaTableLifecycleBuilderBidBps =
  process.env.GACHA_TABLE_LIFECYCLE_BUILDER_BID_BPS;
const originalPendingFundingBuilderBidBps =
  process.env.PENDING_FUNDING_BUILDER_BID_BPS;
const originalBuybackBuilderBidBps =
  process.env.BUYBACK_BUILDER_BID_BPS;
const originalBuilderBidBps = process.env.BUILDER_BID_BPS;
const originalPoolBuilderBidBps =
  process.env.POOL_BUILDER_BID_BPS;
const originalPoolPullBuilderBidBps =
  process.env.POOL_PULL_BUILDER_BID_BPS;
const originalPoolPullBountyEstimateBps =
  process.env.POOL_PULL_BOUNTY_ESTIMATE_BPS;
const originalWsUrl = process.env.WS_URL;
const originalSubmissionMode = process.env.SUBMISSION_MODE;
const originalFlashbotsRelayUrls =
  process.env.FLASHBOTS_RELAY_URLS;
const originalFlashbotsBuilders =
  process.env.FLASHBOTS_BUILDERS;
const originalHourlyStatsDiscordWebhookUrl =
  process.env.HOURLY_STATS_DISCORD_WEBHOOK_URL;

afterEach(() => {
  if (originalFwaProcessGasLimit === undefined) {
    delete process.env.FWA_PROCESS_GAS_LIMIT;
  } else {
    process.env.FWA_PROCESS_GAS_LIMIT =
      originalFwaProcessGasLimit;
  }
  if (originalFwaProcessMaxCount === undefined) {
    delete process.env.FWA_PROCESS_MAX_COUNT;
  } else {
    process.env.FWA_PROCESS_MAX_COUNT =
      originalFwaProcessMaxCount;
  }
  if (originalPendingFundingBackruns === undefined) {
    delete process.env.ENABLE_PENDING_FUNDING_BACKRUNS;
  } else {
    process.env.ENABLE_PENDING_FUNDING_BACKRUNS =
      originalPendingFundingBackruns;
  }
  if (
    originalPendingFwaFulfillmentBackruns === undefined
  ) {
    delete process.env
      .ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS;
  } else {
    process.env.ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS =
      originalPendingFwaFulfillmentBackruns;
  }
  if (originalDirectCoinbasePayments === undefined) {
    delete process.env.ENABLE_DIRECT_COINBASE_PAYMENTS;
  } else {
    process.env.ENABLE_DIRECT_COINBASE_PAYMENTS =
      originalDirectCoinbasePayments;
  }
  if (originalLiveBidSweep === undefined) {
    delete process.env.ENABLE_LIVE_BID_SWEEP;
  } else {
    process.env.ENABLE_LIVE_BID_SWEEP =
      originalLiveBidSweep;
  }
  if (originalLiquityLiquidations === undefined) {
    delete process.env.ENABLE_LIQUITY_LIQUIDATIONS;
  } else {
    process.env.ENABLE_LIQUITY_LIQUIDATIONS =
      originalLiquityLiquidations;
  }
  if (originalGachaTable === undefined) {
    delete process.env.ENABLE_GACHA_TABLE;
  } else {
    process.env.ENABLE_GACHA_TABLE = originalGachaTable;
  }
  if (originalGachaTableDefaultBuilderBidBps === undefined) {
    delete process.env.GACHA_TABLE_DEFAULT_BUILDER_BID_BPS;
  } else {
    process.env.GACHA_TABLE_DEFAULT_BUILDER_BID_BPS =
      originalGachaTableDefaultBuilderBidBps;
  }
  if (originalGachaTableLifecycleBuilderBidBps === undefined) {
    delete process.env.GACHA_TABLE_LIFECYCLE_BUILDER_BID_BPS;
  } else {
    process.env.GACHA_TABLE_LIFECYCLE_BUILDER_BID_BPS =
      originalGachaTableLifecycleBuilderBidBps;
  }
  if (originalPendingFundingBuilderBidBps === undefined) {
    delete process.env.PENDING_FUNDING_BUILDER_BID_BPS;
  } else {
    process.env.PENDING_FUNDING_BUILDER_BID_BPS =
      originalPendingFundingBuilderBidBps;
  }
  if (originalBuybackBuilderBidBps === undefined) {
    delete process.env.BUYBACK_BUILDER_BID_BPS;
  } else {
    process.env.BUYBACK_BUILDER_BID_BPS =
      originalBuybackBuilderBidBps;
  }
  if (originalBuilderBidBps === undefined) {
    delete process.env.BUILDER_BID_BPS;
  } else {
    process.env.BUILDER_BID_BPS = originalBuilderBidBps;
  }
  if (originalPoolBuilderBidBps === undefined) {
    delete process.env.POOL_BUILDER_BID_BPS;
  } else {
    process.env.POOL_BUILDER_BID_BPS =
      originalPoolBuilderBidBps;
  }
  if (originalPoolPullBuilderBidBps === undefined) {
    delete process.env.POOL_PULL_BUILDER_BID_BPS;
  } else {
    process.env.POOL_PULL_BUILDER_BID_BPS =
      originalPoolPullBuilderBidBps;
  }
  if (originalPoolPullBountyEstimateBps === undefined) {
    delete process.env.POOL_PULL_BOUNTY_ESTIMATE_BPS;
  } else {
    process.env.POOL_PULL_BOUNTY_ESTIMATE_BPS =
      originalPoolPullBountyEstimateBps;
  }
  if (originalWsUrl === undefined) delete process.env.WS_URL;
  else process.env.WS_URL = originalWsUrl;
  if (originalSubmissionMode === undefined) {
    delete process.env.SUBMISSION_MODE;
  } else {
    process.env.SUBMISSION_MODE = originalSubmissionMode;
  }
  if (originalFlashbotsRelayUrls === undefined) {
    delete process.env.FLASHBOTS_RELAY_URLS;
  } else {
    process.env.FLASHBOTS_RELAY_URLS =
      originalFlashbotsRelayUrls;
  }
  if (originalFlashbotsBuilders === undefined) {
    delete process.env.FLASHBOTS_BUILDERS;
  } else {
    process.env.FLASHBOTS_BUILDERS =
      originalFlashbotsBuilders;
  }
  if (originalHourlyStatsDiscordWebhookUrl === undefined) {
    delete process.env.HOURLY_STATS_DISCORD_WEBHOOK_URL;
  } else {
    process.env.HOURLY_STATS_DISCORD_WEBHOOK_URL =
      originalHourlyStatsDiscordWebhookUrl;
  }
});

describe("hourly stats Discord webhook", () => {
  it("is optional and accepts only Discord HTTPS webhook URLs", () => {
    delete process.env.HOURLY_STATS_DISCORD_WEBHOOK_URL;
    expect(loadConfig().hourlyStatsDiscordWebhookUrl).toBeUndefined();

    process.env.HOURLY_STATS_DISCORD_WEBHOOK_URL =
      "https://discord.com/api/webhooks/example/token";
    expect(loadConfig().hourlyStatsDiscordWebhookUrl).toBe(
      process.env.HOURLY_STATS_DISCORD_WEBHOOK_URL,
    );

    process.env.HOURLY_STATS_DISCORD_WEBHOOK_URL =
      "https://example.com/api/webhooks/example/token";
    expect(() => loadConfig()).toThrow(
      "HOURLY_STATS_DISCORD_WEBHOOK_URL",
    );
  });
});

describe("LiveBid sweep", () => {
  it("defaults off because a same-block winner can make sweep a no-op", () => {
    delete process.env.ENABLE_LIVE_BID_SWEEP;

    expect(loadConfig().enableLiveBidSweep).toBe(false);
  });

  it("can only be enabled explicitly", () => {
    process.env.ENABLE_LIVE_BID_SWEEP = "true";

    expect(loadConfig().enableLiveBidSweep).toBe(true);
  });
});

describe("Liquity liquidations", () => {
  it("defaults off after sustained zero-opportunity production scans", () => {
    delete process.env.ENABLE_LIQUITY_LIQUIDATIONS;

    expect(loadConfig().enableLiquityLiquidations).toBe(false);
  });

  it("can only be enabled explicitly", () => {
    process.env.ENABLE_LIQUITY_LIQUIDATIONS = "true";

    expect(loadConfig().enableLiquityLiquidations).toBe(true);
  });
});

describe("GachaTable keeper lane", () => {
  it("defaults off with evidence-backed independent bids", () => {
    delete process.env.ENABLE_GACHA_TABLE;
    delete process.env.GACHA_TABLE_DEFAULT_BUILDER_BID_BPS;
    delete process.env.GACHA_TABLE_LIFECYCLE_BUILDER_BID_BPS;

    const config = loadConfig();
    expect(config.enableGachaTable).toBe(false);
    expect(config.gachaTableDefaultBuilderBidBps).toBe(5_001n);
    expect(config.gachaTableLifecycleBuilderBidBps).toBe(8_100n);
  });

  it("requires private bundle submission when enabled", () => {
    process.env.ENABLE_GACHA_TABLE = "true";
    process.env.SUBMISSION_MODE = "public";

    expect(() => loadConfig()).toThrow(
      "ENABLE_GACHA_TABLE requires SUBMISSION_MODE=flashbots",
    );
  });
});

describe("standing-order builder bid", () => {
  it("starts new targets at ten percent", () => {
    delete process.env.BUILDER_BID_BPS;

    expect(loadConfig().builderBidBps).toBe(1_000n);
  });
});

describe("FWA buyback builder bid", () => {
  it("uses the newest exact profitable clearing floor", () => {
    delete process.env.BUYBACK_BUILDER_BID_BPS;

    expect(loadConfig().buybackBuilderBidBps).toBe(9_858n);
  });
});

describe("FWA processor gas limit", () => {
  it("defaults to Ethereum's per-transaction protocol cap", () => {
    delete process.env.FWA_PROCESS_GAS_LIMIT;

    expect(loadConfig().fwaProcessGasLimit).toBe(
      BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
    );
  });

  it("rejects a configured limit above the protocol cap", () => {
    process.env.FWA_PROCESS_GAS_LIMIT = String(
      ETHEREUM_TRANSACTION_GAS_LIMIT + 1,
    );

    expect(() => loadConfig()).toThrow(
      "FWA_PROCESS_GAS_LIMIT",
    );
  });
});

describe("FWA processor discovery window", () => {
  it("defaults to the bounded maximum discovery window", () => {
    delete process.env.FWA_PROCESS_MAX_COUNT;

    expect(loadConfig().fwaProcessMaxCount).toBe(
      FWA_PROCESS_DISCOVERY_MAX_COUNT,
    );
  });

  it("rejects a configured count above the discovery maximum", () => {
    process.env.FWA_PROCESS_MAX_COUNT = String(
      FWA_PROCESS_DISCOVERY_MAX_COUNT + 1,
    );

    expect(() => loadConfig()).toThrow(
      "FWA_PROCESS_MAX_COUNT",
    );
  });
});

describe("pending funding backruns", () => {
  it("defaults disabled", () => {
    delete process.env.ENABLE_PENDING_FUNDING_BACKRUNS;
    delete process.env.PENDING_FUNDING_BUILDER_BID_BPS;

    const config = loadConfig();
    expect(config.enablePendingFundingBackruns).toBe(false);
    expect(config.pendingFundingBuilderBidBps).toBe(1_000n);
  });

  it("requires a private submission mode and WebSocket source", () => {
    process.env.ENABLE_PENDING_FUNDING_BACKRUNS = "true";
    delete process.env.WS_URL;

    expect(() => loadConfig()).toThrow("requires WS_URL");

    process.env.WS_URL = "wss://example.invalid";
    process.env.SUBMISSION_MODE = "public";

    expect(() => loadConfig()).toThrow(
      "requires SUBMISSION_MODE=flashbots",
    );
  });

  it("cannot execute in dry-run mode even when configured", () => {
    expect(
      pendingFundingExecutionEnabled({
        enablePendingFundingBackruns: true,
        dryRun: true,
      }),
    ).toBe(false);
    expect(
      pendingFundingExecutionEnabled({
        enablePendingFundingBackruns: true,
        dryRun: false,
      }),
    ).toBe(true);
  });
});

describe("pending FWA fulfillment backruns", () => {
  it("defaults disabled and shares the low ready-chain bid", () => {
    delete process.env
      .ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS;
    delete process.env.POOL_BUILDER_BID_BPS;

    const config = loadConfig();
    expect(
      config.enablePendingFwaFulfillmentBackruns,
    ).toBe(false);
    expect(config.poolBuilderBidBps).toBe(1_705n);
  });

  it("requires private submission and a WebSocket source", () => {
    process.env.ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS =
      "true";
    delete process.env.WS_URL;

    expect(() => loadConfig()).toThrow("requires WS_URL");

    process.env.WS_URL = "wss://example.invalid";
    process.env.SUBMISSION_MODE = "public";
    expect(() => loadConfig()).toThrow(
      "ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS requires SUBMISSION_MODE=flashbots",
    );
  });

  it("cannot execute in dry-run mode", () => {
    expect(
      pendingFwaFulfillmentExecutionEnabled({
        enablePendingFwaFulfillmentBackruns: true,
        dryRun: true,
      }),
    ).toBe(false);
    expect(
      pendingFwaFulfillmentExecutionEnabled({
        enablePendingFwaFulfillmentBackruns: true,
        dryRun: false,
      }),
    ).toBe(true);
  });
});

describe("direct coinbase payments", () => {
  it("defaults disabled and requires private bundle submission", () => {
    delete process.env.ENABLE_DIRECT_COINBASE_PAYMENTS;
    expect(loadConfig().enableDirectCoinbasePayments).toBe(false);

    process.env.ENABLE_DIRECT_COINBASE_PAYMENTS = "true";
    process.env.SUBMISSION_MODE = "public";
    expect(() => loadConfig()).toThrow(
      "ENABLE_DIRECT_COINBASE_PAYMENTS requires SUBMISSION_MODE=flashbots",
    );
  });
});

describe("ready acquisition bidding", () => {
  it("defaults just above the observed conflicting processor payment", () => {
    delete process.env.POOL_BUILDER_BID_BPS;
    delete process.env.POOL_FULFILLED_BUILDER_BID_BPS;

    const config = loadConfig();
    expect(config.poolBuilderBidBps).toBe(1_705n);
    expect(config.poolFulfilledBuilderBidBps).toBe(7_250n);
  });
});

describe("pool pull economics", () => {
  it("defaults to the evidence-backed bid and reimbursement estimate", () => {
    delete process.env.POOL_PULL_BUILDER_BID_BPS;
    delete process.env.POOL_PULL_BOUNTY_ESTIMATE_BPS;

    const config = loadConfig();
    expect(config.poolPullBuilderBidBps).toBe(1_000n);
    expect(config.poolPullBountyEstimateBps).toBe(10_000n);
  });
});

describe("private builder coverage", () => {
  it("submits directly to every evidence-backed endpoint by default", () => {
    delete process.env.FLASHBOTS_RELAY_URLS;

    expect(loadConfig().flashbotsRelayUrls).toEqual([
      "https://relay.flashbots.net",
      "https://rpc.quasar.win",
      "https://rpc.titanbuilder.xyz",
      "https://rpc.beaverbuild.org",
      "https://rpc.bombora.build",
      "https://rpc.eurekabuilder.xyz",
      "https://rpc.buildernet.org",
    ]);
  });

  it("multiplexes to every evidence-backed builder by default", () => {
    delete process.env.FLASHBOTS_BUILDERS;

    expect(loadConfig().flashbotsBuilders).toEqual([
      "flashbots",
      "builder0x69",
      "beaverbuild.org",
      "Titan",
      "rsync",
      "bobthebuilder",
      "Bombora",
      "Eureka",
    ]);
  });
});
