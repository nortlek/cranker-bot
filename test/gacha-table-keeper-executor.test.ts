import { decodeFunctionData, getAddress, parseEther } from "viem";
import { describe, expect, it } from "vitest";

import {
  encodeGachaTableDefaults,
  encodeGachaTableFire,
  encodeGachaTableSettlement,
  gachaTableKeeperExecutorAbi,
  gachaTableKeeperExecutorDeployment,
} from "../src/gacha-table-keeper-executor.js";
import { singletonFactoryAbi } from "../src/standing-order-batch-executor.js";

const OWNER = getAddress(
  "0xeAaf34AEaF4A10F9c5f5400E0bD6f9f5a8Ba2D48",
);

describe("GachaTable reward-gated executor", () => {
  it("derives deterministic owner-bound deployment code", () => {
    const deployment = gachaTableKeeperExecutorDeployment(OWNER);
    expect(deployment.address).toBe(
      "0x7241AFDa2846e352c65AA252E653557ce3D6339b",
    );
    expect(deployment.expectedRuntimeCodeHash).toBe(
      "0x71210a3bcfe72d646b1790c352c0ddc95d08a299ecbff7958389a998ad9dc210",
    );
    expect(
      decodeFunctionData({
        abi: singletonFactoryAbi,
        data: deployment.deployData,
      }).functionName,
    ).toBe("deploy");
  });

  it("binds fire and settlement to an exact battle and reward", () => {
    expect(
      decodeFunctionData({
        abi: gachaTableKeeperExecutorAbi,
        data: encodeGachaTableFire(23n, parseEther("0.001")),
      }),
    ).toEqual({
      functionName: "fireExact",
      args: [23n, parseEther("0.001")],
    });
    expect(
      decodeFunctionData({
        abi: gachaTableKeeperExecutorAbi,
        data: encodeGachaTableSettlement(22n, parseEther("0.001")),
      }),
    ).toEqual({
      functionName: "settleExact",
      args: [22n, parseEther("0.001")],
    });
  });

  it("binds a unique default batch and aggregate reward", () => {
    expect(
      decodeFunctionData({
        abi: gachaTableKeeperExecutorAbi,
        data: encodeGachaTableDefaults(
          21n,
          [0, 1, 2, 3],
          parseEther("0.004"),
        ),
      }),
    ).toEqual({
      functionName: "crankDefaultsExact",
      args: [21n, [0, 1, 2, 3], parseEther("0.004")],
    });
  });

  it("rejects invalid battle, leg, and reward bounds", () => {
    expect(() => encodeGachaTableFire(0n, 1n)).toThrow();
    expect(() => encodeGachaTableSettlement(1n, 0n)).toThrow();
    expect(() => encodeGachaTableDefaults(1n, [], 1n)).toThrow();
    expect(() => encodeGachaTableDefaults(1n, [0, 0], 1n)).toThrow();
    expect(() => encodeGachaTableDefaults(1n, [4], 1n)).toThrow();
  });
});
