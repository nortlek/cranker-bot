import { getAddress, keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import {
  encodeFwairDropExecution,
  FWAIR_DROP_ROUND_ADDRESS,
  fwairDropExecutorDeployment,
  fwairDropKeeperExecutorAbi,
} from "../src/fwair-drop-keeper-executor.js";
import { decodeFunctionData } from "viem";

const OWNER = getAddress("0xeAaf34AEaF4A10F9c5f5400E0bD6f9f5a8Ba2D48");

describe("FWAIR drop reward-gated executor", () => {
  it("derives deterministic owner-bound deployment artifacts", () => {
    const deployment = fwairDropExecutorDeployment(OWNER);
    expect(deployment.initCode).not.toBe("0x");
    expect(deployment.deployData).not.toBe("0x");
    expect(deployment.expectedRuntimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keccak256(deployment.initCode)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("encodes only nonempty reward-gated batches", () => {
    const data = encodeFwairDropExecution(["0xf83d08ba"], 1n);
    const decoded = decodeFunctionData({ abi: fwairDropKeeperExecutorAbi, data });
    expect(decoded.functionName).toBe("executeExact");
    expect(decoded.args?.[0]).toEqual(["0xf83d08ba"]);
    expect(decoded.args?.[1]).toBe(1n);
    expect(FWAIR_DROP_ROUND_ADDRESS).toBe(
      getAddress("0xdbDA2aFB2f824657dc70ED5465d44f0D91EdcdEE"),
    );
    expect(() => encodeFwairDropExecution([], 1n)).toThrow();
    expect(() => encodeFwairDropExecution(["0xf83d08ba"], 0n)).toThrow();
  });
});
