import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  encodeExactFwaSequenceProcessing,
  fwaSequenceExecutorAbi,
  fwaSequenceExecutorDeployment,
} from "../src/fwa-sequence-executor.js";
import { singletonFactoryAbi } from "../src/standing-order-batch-executor.js";

const OWNER = getAddress(
  "0xeAaf34AEaF4A10F9c5f5400E0bD6f9f5a8Ba2D48",
);

describe("FWA exact sequence executor", () => {
  it("derives deterministic owner-bound deployment code", () => {
    const deployment = fwaSequenceExecutorDeployment(OWNER);
    expect(deployment.address).toBe(
      "0x73739a6643FcB8bd8a2d4EA34fdAf68eDDEB344f",
    );
    expect(deployment.expectedRuntimeCodeHash).toBe(
      "0x490f2071ca41b5bc1f42f7bbe3c47316fffd13b5daf3acc6d9c9d3ac6ac97370",
    );
    expect(
      decodeFunctionData({
        abi: singletonFactoryAbi,
        data: deployment.deployData,
      }).functionName,
    ).toBe("deploy");
  });

  it("binds both ends of the planned FIFO interval", () => {
    expect(
      decodeFunctionData({
        abi: fwaSequenceExecutorAbi,
        data: encodeExactFwaSequenceProcessing(120983n, 2n),
      }),
    ).toEqual({
      functionName: "processExact",
      args: [120983n, 120985n],
    });
  });

  it("rejects empty and overflowing intervals", () => {
    expect(() =>
      encodeExactFwaSequenceProcessing(1n, 0n),
    ).toThrow("must be positive");
    expect(() =>
      encodeExactFwaSequenceProcessing(0xffff_ffff_ffff_ffffn, 1n),
    ).toThrow("exceeds uint64");
  });
});
