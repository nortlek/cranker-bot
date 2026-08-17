import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  buildDashboardData,
  createDashboardDataReader,
  createDashboardEthUsdReader,
} from "../src/dashboard.js";

describe("dashboard refresh resilience", () => {
  it("bounds and coalesces a slow ETH/USD refresh while retaining its result", async () => {
    vi.useFakeTimers();
    try {
      let resolvePrice: ((value: number) => void) | undefined;
      const resolver = vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolvePrice = resolve;
          }),
      );
      const onRefreshTimedOut = vi.fn();
      const readEthUsd = createDashboardEthUsdReader({
        configuredValue: 1_800,
        refreshTimeoutMs: 50,
        resolver,
        onRefreshTimedOut,
      });

      const first = readEthUsd();
      const second = readEthUsd();
      await vi.advanceTimersByTimeAsync(50);

      await expect(Promise.all([first, second])).resolves.toEqual([
        1_800,
        1_800,
      ]);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(onRefreshTimedOut).toHaveBeenCalledTimes(1);

      resolvePrice?.(2_100);
      await Promise.resolve();
      await Promise.resolve();
      await expect(readEthUsd()).resolves.toBe(2_100);
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces cold data reads and serves stale data during one refresh", async () => {
    let currentTime = 1_000;
    let resolveCold: ((value: Record<string, unknown>) => void) | undefined;
    let resolveRefresh: ((value: Record<string, unknown>) => void) | undefined;
    const read = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCold = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const readData = createDashboardDataReader({
      cacheIntervalMs: 100,
      now: () => currentTime,
      read,
    });

    const first = readData();
    const second = readData();
    await Promise.resolve();
    resolveCold?.({ version: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      '{"version":1}',
      '{"version":1}',
    ]);
    expect(read).toHaveBeenCalledTimes(1);

    currentTime = 1_101;
    await expect(readData()).resolves.toBe('{"version":1}');
    await expect(readData()).resolves.toBe('{"version":1}');
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);

    resolveRefresh?.({ version: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(readData()).resolves.toBe('{"version":2}');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("dashboard telemetry", () => {
  it("reports live lane, batch, relay, and signer health metrics", async () => {
    const lastPassAt = new Date("2026-08-02T06:00:00.000Z");
    const responses = [
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{ total_profit_eth: "0.04", receipt_count: "3" }] },
      {
        rows: [
          { job_kind: "standing_order", profit_eth: "0.03" },
          { job_kind: "pool_sync", profit_eth: "0.02" },
          { job_kind: "fwa_process", profit_eth: "-0.01" },
          { job_kind: "group_pull_submit", profit_eth: "0.01" },
        ],
      },
      {
        rows: [{
          batch_attempts: "5",
          batch_wins: "3",
          last_pass_at: lastPassAt,
          last_block: "25665274",
          last_viable: "2",
          last_sent: "1",
          last_confirmed: "1",
        }],
      },
      {
        rows: [
          { relay_index: "0", attempted: "5", accepted: "4" },
          { relay_index: "1", attempted: "5", accepted: "5" },
        ],
      },
      {
        rows: [{
          active_runs: "1",
          signer_leases: "1",
          pass_failures_24h: "0",
        }],
      },
    ];
    const query = vi.fn(async () => responses.shift());
    const pool = { query } as unknown as Pool;

    const data = await buildDashboardData(pool, 2_000);

    expect(query).toHaveBeenCalledTimes(8);
    const queryCalls = query.mock.calls as unknown as Array<[string]>;
    expect(queryCalls[0]?.[0]).toContain("UNION ALL");
    expect(queryCalls[0]?.[0]).toContain(
      "event_name = 'keeper_transaction_expired'",
    );
    expect(queryCalls[7]?.[0]).toContain(
      "COUNT(DISTINCT run_id)",
    );
    expect(queryCalls[7]?.[0]).toContain(
      "pull-pool-keeper:signer-lease",
    );
    expect(data.summary).toEqual({
      receiptProfitUsd: 80,
      receiptProfitEth: 0.04,
      receiptCount: 3,
      batchAttempts: 5,
      batchWins: 3,
      batchWinRate: 60,
      relayAttempts: 10,
      relayAccepted: 9,
      relayDeliveryRate: 90,
    });
    expect(data.execution).toEqual({
      lastPassAt: lastPassAt.toISOString(),
      lastBlock: "25665274",
      viable: 2,
      sent: 1,
      confirmed: 1,
      activeRuns: 1,
      signerLeases: 1,
      passFailures24h: 0,
    });
    expect(data.lanes).toEqual([
      { key: "orders", value: 60, chartValue: 60 },
      { key: "lifecycle", value: 40, chartValue: 40 },
      { key: "fwa", value: -20, chartValue: 0 },
      { key: "pull", value: 0, chartValue: 0 },
      { key: "group_pull", value: 20, chartValue: 20 },
      { key: "other", value: 0, chartValue: 0 },
    ]);
    expect(data.relays).toEqual([
      { relayIndex: 0, attempted: 5, accepted: 4 },
      { relayIndex: 1, attempted: 5, accepted: 5 },
    ]);
  });

  it("builds a 24-point hourly P&L series for the last 24 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:34:00.000Z"));
    try {
      const responses = [
        { rows: [] },
        { rows: [] },
        {
          rows: [{
            bucket: new Date("2026-08-03T11:00:00.000Z"),
            job_kind: "group_pull_submit",
            profit_eth: "0.01",
          }],
        },
        { rows: [{ total_profit_eth: "0.01", receipt_count: "1" }] },
        { rows: [{ job_kind: "group_pull_submit", profit_eth: "0.01" }] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
      ];
      const query = vi.fn(async () => responses.shift());
      const pool = { query } as unknown as Pool;

      const data = await buildDashboardData(pool, 2_000);
      const hourly = data.pnlHourly as Array<Record<string, unknown>>;

      expect(hourly).toHaveLength(24);
      expect(hourly.find((point) => point.short === "11:00")).toMatchObject({
        group_pull: 20,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
