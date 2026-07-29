import { afterEach, describe, expect, it } from "vitest";

import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
  FWA_PROCESS_DISCOVERY_MAX_COUNT,
  loadConfig,
} from "../src/config.js";

const originalFwaProcessGasLimit =
  process.env.FWA_PROCESS_GAS_LIMIT;
const originalFwaProcessMaxCount =
  process.env.FWA_PROCESS_MAX_COUNT;

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
