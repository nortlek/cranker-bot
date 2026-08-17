import { decodeFunctionData, getAddress, parseEther } from "viem";
import { describe, expect, it } from "vitest";

import {
  encodeMegaRipExactPull,
  encodeMegaRipExactReveal,
  encodeMegaRipExactRecoveries,
  encodeMegaRipExactSettlements,
  megaRipKeeperExecutorAbi,
  megaRipKeeperExecutorDeployment,
} from "../src/mega-rip-keeper-executor.js";
import { singletonFactoryAbi } from "../src/standing-order-batch-executor.js";

const OWNER = getAddress(
  "0xeAaf34AEaF4A10F9c5f5400E0bD6f9f5a8Ba2D48",
);

describe("MegaRip reward-gated executor", () => {
  it("derives deterministic owner-bound deployment code", () => {
    const deployment = megaRipKeeperExecutorDeployment(OWNER);
    expect(deployment.address).toBe(
      "0xd9FB9e5C7936BB878432E5D22aBe89b295252cC5",
    );
    expect(deployment.expectedRuntimeCodeHash).toBe(
      "0x5ddc5cf8f9ff15407d8d1384d90eed4ea5820cde44f58c5223988417207a9d44",
    );
    expect(
      decodeFunctionData({
        abi: singletonFactoryAbi,
        data: deployment.deployData,
      }).functionName,
    ).toBe("deploy");
  });

  it("binds exact pull count and minimum reward", () => {
    expect(
      decodeFunctionData({
        abi: megaRipKeeperExecutorAbi,
        data: encodeMegaRipExactPull(50n, parseEther("0.015")),
      }),
    ).toEqual({
      functionName: "pullExact",
      args: [50n, parseEther("0.015")],
    });
  });

  it("binds the exact FWA sequence interval and reveal reward", () => {
    expect(
      decodeFunctionData({
        abi: megaRipKeeperExecutorAbi,
        data: encodeMegaRipExactReveal(
          100n,
          3n,
          parseEther("0.0006"),
        ),
      }),
    ).toEqual({
      functionName: "crankRevealExact",
      args: [100n, 103n, parseEther("0.0006")],
    });
  });

  it("binds exact settlement and recovery batches", () => {
    expect(
      decodeFunctionData({
        abi: megaRipKeeperExecutorAbi,
        data: encodeMegaRipExactSettlements(
          [11n, 12n],
          parseEther("0.0006"),
        ),
      }),
    ).toEqual({
      functionName: "settleExact",
      args: [[11n, 12n], parseEther("0.0006")],
    });
    expect(
      decodeFunctionData({
        abi: megaRipKeeperExecutorAbi,
        data: encodeMegaRipExactRecoveries(
          [21n],
          parseEther("0.0003"),
        ),
      }),
    ).toEqual({
      functionName: "syncStuckExact",
      args: [[21n], parseEther("0.0003")],
    });
  });

  it("rejects empty, oversized, and unrewarded calls", () => {
    expect(() => encodeMegaRipExactPull(0n, 1n)).toThrow();
    expect(() => encodeMegaRipExactPull(65n, 1n)).toThrow();
    expect(() => encodeMegaRipExactPull(1n, 0n)).toThrow();
    expect(() => encodeMegaRipExactReveal(1n, 0n, 1n)).toThrow();
    expect(() => encodeMegaRipExactReveal(1n, 65n, 1n)).toThrow();
    expect(() => encodeMegaRipExactSettlements([], 1n)).toThrow();
    expect(() =>
      encodeMegaRipExactRecoveries(
        Array.from({ length: 65 }, (_, index) => BigInt(index + 1)),
        1n,
      ),
    ).toThrow();
  });
});
