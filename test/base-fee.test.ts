import { describe, expect, it } from "vitest";

import { nextBlockBaseFeePerGas } from "../src/base-fee.js";

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
