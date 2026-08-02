import { describe, expect, it } from "vitest";

import {
  effectiveEip1559GasPrice,
  nextBlockBaseFeePerGas,
  relayCompatibleMaxFeePerGas,
} from "../src/base-fee.js";

describe("nextBlockBaseFeePerGas", () => {
  it("matches a historical Ethereum child exactly", () => {
    expect(
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: 2_692_350_705n,
        parentGasUsed: 22_028_152n,
        parentGasLimit: 60_000_000n,
      }),
    ).toBe(2_602_921_495n);
  });

  it("handles the target, maximum increase, and empty-block decrease", () => {
    expect(
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: 800n,
        parentGasUsed: 100n,
        parentGasLimit: 200n,
      }),
    ).toBe(800n);
    expect(
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: 800n,
        parentGasUsed: 200n,
        parentGasLimit: 200n,
      }),
    ).toBe(900n);
    expect(
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: 800n,
        parentGasUsed: 0n,
        parentGasLimit: 200n,
      }),
    ).toBe(700n);
  });

  it("uses the protocol one-wei minimum increase", () => {
    expect(
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: 7n,
        parentGasUsed: 101n,
        parentGasLimit: 200n,
      }),
    ).toBe(8n);
  });

  it("rejects invalid parent fields", () => {
    expect(() =>
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: 0n,
        parentGasUsed: 0n,
        parentGasLimit: 200n,
      }),
    ).toThrow("base fee must be positive");
    expect(() =>
      nextBlockBaseFeePerGas({
        parentBaseFeePerGas: 1n,
        parentGasUsed: 201n,
        parentGasLimit: 200n,
      }),
    ).toThrow("cannot exceed");
  });
});

describe("relayCompatibleMaxFeePerGas", () => {
  it("adds one wei of private relay capacity below the configured maximum", () => {
    expect(
      relayCompatibleMaxFeePerGas({
        expectedMaxFeePerGas: 100n,
        configuredMaximum: 200n,
      }),
    ).toBe(101n);
  });

  it("preserves a saturated configured maximum", () => {
    expect(
      relayCompatibleMaxFeePerGas({
        expectedMaxFeePerGas: 200n,
        configuredMaximum: 200n,
      }),
    ).toBe(200n);
  });

  it("adds one wei when profitability is the only boundary", () => {
    expect(
      relayCompatibleMaxFeePerGas({
        expectedMaxFeePerGas: 200n,
      }),
    ).toBe(201n);
  });

  it("rejects negative fee inputs", () => {
    expect(() =>
      relayCompatibleMaxFeePerGas({
        expectedMaxFeePerGas: -1n,
      }),
    ).toThrow("cannot be negative");
    expect(() =>
      relayCompatibleMaxFeePerGas({
        expectedMaxFeePerGas: 1n,
        configuredMaximum: -1n,
      }),
    ).toThrow("cannot be negative");
  });
});

describe("effectiveEip1559GasPrice", () => {
  it("does not charge unused relay-compatible max-fee capacity", () => {
    const baseFeePerGas = 80n;
    const maxPriorityFeePerGas = 20n;
    const maxFeePerGas = relayCompatibleMaxFeePerGas({
      expectedMaxFeePerGas:
        baseFeePerGas + maxPriorityFeePerGas,
    });

    expect(maxFeePerGas).toBe(101n);
    expect(
      effectiveEip1559GasPrice({
        baseFeePerGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      }),
    ).toBe(100n);
  });

  it("respects a max-fee cap below base fee plus priority fee", () => {
    expect(
      effectiveEip1559GasPrice({
        baseFeePerGas: 80n,
        maxFeePerGas: 95n,
        maxPriorityFeePerGas: 20n,
      }),
    ).toBe(95n);
  });

  it("rejects an envelope below the known base fee", () => {
    expect(() =>
      effectiveEip1559GasPrice({
        baseFeePerGas: 80n,
        maxFeePerGas: 79n,
        maxPriorityFeePerGas: 20n,
      }),
    ).toThrow("max fee cannot be below base fee");
  });
});
