import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildHourlyStatsEmbed,
  DiscordHourlyStatsSender,
  HourlyStatsReporter,
  PostgresHourlyStatsSource,
  type HourlyStatsSnapshot,
  type HourlyStatsSource,
} from "../src/hourly-stats.js";

function snapshot(
  generatedAt = new Date("2026-08-02T18:00:00.000Z"),
): HourlyStatsSnapshot {
  return {
    generatedAt,
    oneHour: {
      transactions: 4,
      successes: 3,
      failures: 1,
      realizedProfitWei: 12_500_000_000_000_000n,
      grossRewardWei: 20_000_000_000_000_000n,
      gasCostWei: 7_500_000_000_000_000n,
    },
    twentyFourHours: {
      transactions: 20,
      successes: 17,
      failures: 3,
      realizedProfitWei: 50_000_000_000_000_000n,
      grossRewardWei: 100_000_000_000_000_000n,
      gasCostWei: 50_000_000_000_000_000n,
    },
    lanes24h: [
      {
        kind: "standing_order",
        transactions: 12,
        successes: 11,
        failures: 1,
        realizedProfitWei: 40_000_000_000_000_000n,
        grossRewardWei: 70_000_000_000_000_000n,
        gasCostWei: 30_000_000_000_000_000n,
      },
      {
        kind: "pool_sync",
        transactions: 8,
        successes: 6,
        failures: 2,
        realizedProfitWei: 10_000_000_000_000_000n,
        grossRewardWei: 30_000_000_000_000_000n,
        gasCostWei: 20_000_000_000_000_000n,
      },
    ],
    health: {
      submissions1h: 4,
      submissions24h: 20,
      passes1h: 295,
      passes24h: 7_100,
      passFailures1h: 0,
      passFailures24h: 2,
      lastPassAt: new Date("2026-08-02T17:59:55.000Z"),
      lastPassBlock: "25670000",
      lastSuccessAt: new Date("2026-08-02T17:42:00.000Z"),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hourly stats embed", () => {
  it("renders rolling P&L, outcomes, health, USD, and lane results", () => {
    const embed = buildHourlyStatsEmbed(snapshot(), 2_000);

    expect(embed.title).toBe("Hourly keeper stats");
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.footer.text).toContain("ETH/USD $2,000.00");
    expect(
      embed.fields?.find((field) => field.name === "Last 1 hour")
        ?.value,
    ).toContain("+0.0125 ETH (+$25.00)");
    expect(
      embed.fields?.find((field) => field.name === "Last 1 hour")
        ?.value,
    ).toContain("3 / 1 (75.0%)");
    expect(
      embed.fields?.find((field) => field.name === "Operations")
        ?.value,
    ).toContain("block 25670000");
    expect(
      embed.fields?.find((field) =>
        field.name.startsWith("24h by lane"),
      )?.value,
    ).toContain("Standing Order");
  });
});

describe("PostgresHourlyStatsSource", () => {
  it("parses deduplicated terminal outcomes and operational health", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            window_name: "1h",
            transactions: "2",
            successes: "1",
            failures: "1",
            realized_profit_eth: "0.001",
            gross_reward_eth: "0.003",
            gas_cost_eth: "0.002",
          },
          {
            window_name: "24h",
            transactions: "5",
            successes: "4",
            failures: "1",
            realized_profit_eth: "0.01",
            gross_reward_eth: "0.02",
            gas_cost_eth: "0.01",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            kind: "pool_settle",
            transactions: "5",
            successes: "4",
            failures: "1",
            realized_profit_eth: "0.01",
            gross_reward_eth: "0.02",
            gas_cost_eth: "0.01",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            submissions_1h: "2",
            submissions_24h: "5",
            passes_1h: "300",
            passes_24h: "7200",
            pass_failures_1h: "0",
            pass_failures_24h: "1",
            last_pass_at: "2026-08-02T17:59:55.000Z",
            last_pass_block: "25670000",
            last_success_at: "2026-08-02T17:30:00.000Z",
          },
        ],
      });
    const end = vi.fn(async () => undefined);
    const pool = { query, end } as unknown as Pool;
    const source = new PostgresHourlyStatsSource(
      "postgresql://unused.invalid/database",
      pool,
    );
    const now = new Date("2026-08-02T18:00:00.000Z");

    const result = await source.load(now);
    await source.close();

    expect(result.oneHour).toMatchObject({
      transactions: 2,
      successes: 1,
      failures: 1,
      realizedProfitWei: 1_000_000_000_000_000n,
    });
    expect(result.lanes24h[0]).toMatchObject({
      kind: "pool_settle",
      successes: 4,
    });
    expect(result.health.lastPassAt?.toISOString()).toBe(
      "2026-08-02T17:59:55.000Z",
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "DISTINCT ON (transaction_hash)",
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      now.toISOString(),
    ]);
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("DiscordHourlyStatsSender", () => {
  it("posts a mention-safe embed without exposing its URL in the payload", async () => {
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sender = new DiscordHourlyStatsSender({
      url: "https://discord.com/api/webhooks/example/secret-token",
      timeoutMs: 2_000,
    });

    await sender.send(buildHourlyStatsEmbed(snapshot()));

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0];
    const payload = JSON.parse(
      String(request?.[1]?.body),
    ) as {
      readonly username: string;
      readonly allowed_mentions: { readonly parse: unknown[] };
      readonly embeds: unknown[];
    };
    expect(payload.username).toBe("FWA Keeper Stats");
    expect(payload.allowed_mentions.parse).toEqual([]);
    expect(payload.embeds).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });
});

describe("HourlyStatsReporter", () => {
  it("aligns delivery to the next interval and sends ETH-only if pricing fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-02T18:30:00.000Z");
    const load = vi.fn(async (now: Date) => snapshot(now));
    const close = vi.fn(async () => undefined);
    const source = { load, close } satisfies HourlyStatsSource;
    const send = vi.fn(
      async (_embed: ReturnType<typeof buildHourlyStatsEmbed>) =>
        undefined,
    );
    const report = vi.fn();
    const reporter = new HourlyStatsReporter({
      source,
      sender: { send },
      ethUsd: async () => {
        throw new Error("provider details that must not be logged");
      },
      report,
    });

    reporter.start();
    await vi.advanceTimersByTimeAsync(29 * 60 * 1_000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1_000);

    expect(load).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(
      send.mock.calls[0]![0].footer.text,
    ).not.toContain("ETH/USD");
    expect(report).toHaveBeenCalledWith(
      "warn",
      "hourly_stats_price_failed",
      expect.not.objectContaining({
        reason: expect.anything(),
      }),
    );
    expect(report).toHaveBeenCalledWith(
      "info",
      "hourly_stats_report_sent",
      expect.objectContaining({ transactions1h: 4 }),
    );

    await reporter.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
