import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildDashboardData } from "../src/dashboard.js";

describe("dashboard telemetry", () => {
  it("reports live lane, batch, relay, and signer health metrics", async () => {
    const lastPassAt = new Date("2026-08-02T06:00:00.000Z");
    const responses = [
      { rows: [] },
      { rows: [] },
      { rows: [{ total_profit_eth: "0.04", receipt_count: "3" }] },
      {
        rows: [
          { job_kind: "standing_order", profit_eth: "0.03" },
          { job_kind: "pool_sync", profit_eth: "0.02" },
          { job_kind: "fwa_process", profit_eth: "-0.01" },
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

    expect(query).toHaveBeenCalledTimes(7);
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
      { key: "other", value: 0, chartValue: 0 },
    ]);
    expect(data.relays).toEqual([
      { relayIndex: 0, attempted: 5, accepted: 4 },
      { relayIndex: 1, attempted: 5, accepted: 5 },
    ]);
  });
});
