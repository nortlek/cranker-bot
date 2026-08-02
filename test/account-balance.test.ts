import type { Chain, PublicClient, Transport } from "viem";
import { parseEther } from "viem";
import { describe, expect, it, vi } from "vitest";

import { readKeeperAccountBalance } from "../src/account-balance.js";

function round(
  answer: bigint,
): readonly [bigint, bigint, bigint, bigint, bigint] {
  return [10n, answer, 0n, 900n, 10n];
}

describe("keeper account balance", () => {
  it("values supported holdings with fresh feeds and the DOLA haircut", async () => {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce(parseEther("0.5"))
      .mockResolvedValueOnce(parseEther("100"))
      .mockResolvedValueOnce(parseEther("10"))
      .mockResolvedValueOnce(parseEther("20"))
      .mockResolvedValueOnce(parseEther("30"))
      .mockResolvedValueOnce(round(200_000_000_000n))
      .mockResolvedValueOnce(round(100_000_000n))
      .mockResolvedValueOnce(round(90_000_000n))
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(round(20_000_000n))
      .mockResolvedValueOnce(round(130_000_000n));
    const client = {
      getBalance: vi.fn(async () => parseEther("1")),
      readContract,
      getBlock: vi.fn(async () => ({ timestamp: 1_000n })),
    } as unknown as PublicClient<Transport, Chain>;

    const balance = await readKeeperAccountBalance({
      client,
      account: `0x${"12".repeat(20)}`,
      ethOracleMaxAgeSeconds: 300,
      dolaOracleMaxAgeSeconds: 300,
      dolaValuationHaircutBps: 9_500n,
    });

    expect(balance).toEqual({
      totalEthEquivalentWei: parseEther("1.575775"),
      totalUsd: 3_151.55,
    });
    expect(readContract).toHaveBeenCalledTimes(11);
  });
});
