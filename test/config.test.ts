import { afterEach, describe, expect, it } from "vitest";

import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
  FWA_PROCESS_DISCOVERY_MAX_COUNT,
  loadConfig,
  pendingFundingExecutionEnabled,
} from "../src/config.js";

const originalFwaProcessGasLimit =
  process.env.FWA_PROCESS_GAS_LIMIT;
const originalFwaProcessMaxCount =
  process.env.FWA_PROCESS_MAX_COUNT;
const originalPendingFundingBackruns =
  process.env.ENABLE_PENDING_FUNDING_BACKRUNS;
const originalDirectCoinbasePayments =
  process.env.ENABLE_DIRECT_COINBASE_PAYMENTS;
const originalPendingFundingBuilderBidBps =
  process.env.PENDING_FUNDING_BUILDER_BID_BPS;
const originalPoolBuilderBidBps =
  process.env.POOL_BUILDER_BID_BPS;
const originalPoolPullBuilderBidBps =
  process.env.POOL_PULL_BUILDER_BID_BPS;
const originalPoolPullBountyEstimateBps =
  process.env.POOL_PULL_BOUNTY_ESTIMATE_BPS;
const originalWsUrl = process.env.WS_URL;
const originalSubmissionMode = process.env.SUBMISSION_MODE;

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
  if (originalDirectCoinbasePayments === undefined) {
    delete process.env.ENABLE_DIRECT_COINBASE_PAYMENTS;
  } else {
    process.env.ENABLE_DIRECT_COINBASE_PAYMENTS =
      originalDirectCoinbasePayments;
  }
  if (originalPendingFundingBuilderBidBps === undefined) {
    delete process.env.PENDING_FUNDING_BUILDER_BID_BPS;
  } else {
    process.env.PENDING_FUNDING_BUILDER_BID_BPS =
      originalPendingFundingBuilderBidBps;
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
  it("defaults just above the observed incumbent bid", () => {
    delete process.env.POOL_BUILDER_BID_BPS;
    delete process.env.POOL_FULFILLED_BUILDER_BID_BPS;

    const config = loadConfig();
    expect(config.poolBuilderBidBps).toBe(300n);
    expect(config.poolFulfilledBuilderBidBps).toBe(300n);
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
