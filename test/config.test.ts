import { afterEach, describe, expect, it } from "vitest";

import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
  loadConfig,
} from "../src/config.js";

const originalFwaProcessGasLimit =
  process.env.FWA_PROCESS_GAS_LIMIT;

afterEach(() => {
  if (originalFwaProcessGasLimit === undefined) {
    delete process.env.FWA_PROCESS_GAS_LIMIT;
  } else {
    process.env.FWA_PROCESS_GAS_LIMIT =
      originalFwaProcessGasLimit;
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
