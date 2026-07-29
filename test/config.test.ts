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
const originalPendingFundingBuilderBidBps =
  process.env.PENDING_FUNDING_BUILDER_BID_BPS;
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
  if (originalPendingFundingBuilderBidBps === undefined) {
    delete process.env.PENDING_FUNDING_BUILDER_BID_BPS;
  } else {
    process.env.PENDING_FUNDING_BUILDER_BID_BPS =
      originalPendingFundingBuilderBidBps;
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
