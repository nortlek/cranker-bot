import { Pool } from "pg";
import { formatEther, parseEther } from "viem";

import type { DiscordEmbed } from "./discord.js";
import {
  errorFingerprint,
  type LogFieldValue,
  type LogLevel,
} from "./format.js";

const HOUR_MS = 60 * 60 * 1_000;

export interface HourlyStatsWindow {
  readonly transactions: number;
  readonly successes: number;
  readonly failures: number;
  readonly realizedProfitWei: bigint;
  readonly grossRewardWei: bigint;
  readonly gasCostWei: bigint;
}

export interface HourlyStatsLane extends HourlyStatsWindow {
  readonly kind: string;
}

export interface HourlyStatsHealth {
  readonly submissions1h: number;
  readonly submissions24h: number;
  readonly passes1h: number;
  readonly passes24h: number;
  readonly passFailures1h: number;
  readonly passFailures24h: number;
  readonly lastPassAt: Date | undefined;
  readonly lastPassBlock: string | undefined;
  readonly lastSuccessAt: Date | undefined;
}

export interface HourlyStatsSnapshot {
  readonly generatedAt: Date;
  readonly oneHour: HourlyStatsWindow;
  readonly twentyFourHours: HourlyStatsWindow;
  readonly lanes24h: readonly HourlyStatsLane[];
  readonly health: HourlyStatsHealth;
}

export interface HourlyStatsSource {
  load(now: Date): Promise<HourlyStatsSnapshot>;
  close(): Promise<void>;
}

export interface HourlyStatsSender {
  send(embed: DiscordEmbed): Promise<void>;
}

interface WindowRow {
  readonly window_name: "1h" | "24h";
  readonly transactions: string;
  readonly successes: string;
  readonly failures: string;
  readonly realized_profit_eth: string;
  readonly gross_reward_eth: string;
  readonly gas_cost_eth: string;
}

interface LaneRow {
  readonly kind: string;
  readonly transactions: string;
  readonly successes: string;
  readonly failures: string;
  readonly realized_profit_eth: string;
  readonly gross_reward_eth: string;
  readonly gas_cost_eth: string;
}

interface HealthRow {
  readonly submissions_1h: string;
  readonly submissions_24h: string;
  readonly passes_1h: string;
  readonly passes_24h: string;
  readonly pass_failures_1h: string;
  readonly pass_failures_24h: string;
  readonly last_pass_at: Date | string | null;
  readonly last_pass_block: string | null;
  readonly last_success_at: Date | string | null;
}

const LATEST_OUTCOMES_SQL = `
  SELECT DISTINCT ON (transaction_hash)
    event_id,
    occurred_at,
    event_name,
    transaction_hash,
    job_kind,
    payload
  FROM keeper_events
  WHERE event_name IN (
    'keeper_receipt',
    'keeper_transaction_expired',
    'keeper_receipt_unresolved'
  )
    AND transaction_hash IS NOT NULL
    AND occurred_at >= $1::timestamptz - INTERVAL '24 hours'
  ORDER BY transaction_hash, occurred_at DESC, event_id DESC
`;

const SUCCESS_SQL = `
  event_name = 'keeper_receipt'
  AND payload->>'status' = 'success'
  AND COALESCE(payload->>'targetBlockMatched', 'true') <> 'false'
`;

const VALID_ETH_SQL =
  `'^-?[0-9]+([.][0-9]+)? ETH$'`;

function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("hourly stats query returned an invalid count");
  }
  return parsed;
}

function wei(value: string): bigint {
  try {
    return parseEther(value);
  } catch (error) {
    throw new Error(
      "hourly stats query returned an invalid ETH amount",
      { cause: error },
    );
  }
}

function optionalDate(
  value: Date | string | null,
): Date | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("hourly stats query returned an invalid date");
  }
  return date;
}

function windowFromRow(
  row: WindowRow | LaneRow,
): HourlyStatsWindow {
  return {
    transactions: count(row.transactions),
    successes: count(row.successes),
    failures: count(row.failures),
    realizedProfitWei: wei(row.realized_profit_eth),
    grossRewardWei: wei(row.gross_reward_eth),
    gasCostWei: wei(row.gas_cost_eth),
  };
}

export class PostgresHourlyStatsSource
  implements HourlyStatsSource
{
  readonly #pool: Pool;

  constructor(connectionString: string, poolOverride?: Pool) {
    this.#pool =
      poolOverride ??
      new Pool({
        connectionString,
        max: 2,
        allowExitOnIdle: true,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 10_000,
        query_timeout: 5_000,
        statement_timeout: 4_000,
        application_name: "keeper-hourly-stats",
      });
  }

  async load(now: Date): Promise<HourlyStatsSnapshot> {
    const [windowsResult, lanesResult, healthResult] =
      await Promise.all([
        this.#pool.query<WindowRow>(
          `
            WITH latest_outcomes AS (
              ${LATEST_OUTCOMES_SQL}
            ), windows(window_name, duration) AS (
              VALUES
                ('1h', INTERVAL '1 hour'),
                ('24h', INTERVAL '24 hours')
            )
            SELECT
              windows.window_name,
              COUNT(latest_outcomes.event_id)::text AS transactions,
              COUNT(latest_outcomes.event_id) FILTER (
                WHERE ${SUCCESS_SQL}
              )::text AS successes,
              COUNT(latest_outcomes.event_id) FILTER (
                WHERE latest_outcomes.event_id IS NOT NULL
                  AND NOT (${SUCCESS_SQL})
              )::text AS failures,
              COALESCE(SUM(
                CASE
                  WHEN event_name = 'keeper_receipt'
                    AND payload->>'realizedProfit' ~ ${VALID_ETH_SQL}
                  THEN REPLACE(payload->>'realizedProfit', ' ETH', '')::numeric
                  ELSE 0
                END
              ), 0)::text AS realized_profit_eth,
              COALESCE(SUM(
                CASE
                  WHEN event_name = 'keeper_receipt'
                    AND payload->>'paidReward' ~ ${VALID_ETH_SQL}
                  THEN REPLACE(payload->>'paidReward', ' ETH', '')::numeric
                  ELSE 0
                END
              ), 0)::text AS gross_reward_eth,
              COALESCE(SUM(
                CASE
                  WHEN event_name = 'keeper_receipt'
                    AND payload->>'gasCost' ~ ${VALID_ETH_SQL}
                  THEN REPLACE(payload->>'gasCost', ' ETH', '')::numeric
                  ELSE 0
                END
              ), 0)::text AS gas_cost_eth
            FROM windows
            LEFT JOIN latest_outcomes
              ON latest_outcomes.occurred_at >= $1::timestamptz - windows.duration
            GROUP BY windows.window_name, windows.duration
            ORDER BY windows.duration
          `,
          [now.toISOString()],
        ),
        this.#pool.query<LaneRow>(
          `
            WITH latest_outcomes AS (
              ${LATEST_OUTCOMES_SQL}
            )
            SELECT
              COALESCE(job_kind, payload->>'kind', 'unknown') AS kind,
              COUNT(*)::text AS transactions,
              COUNT(*) FILTER (WHERE ${SUCCESS_SQL})::text AS successes,
              COUNT(*) FILTER (WHERE NOT (${SUCCESS_SQL}))::text AS failures,
              COALESCE(SUM(
                CASE
                  WHEN event_name = 'keeper_receipt'
                    AND payload->>'realizedProfit' ~ ${VALID_ETH_SQL}
                  THEN REPLACE(payload->>'realizedProfit', ' ETH', '')::numeric
                  ELSE 0
                END
              ), 0)::text AS realized_profit_eth,
              COALESCE(SUM(
                CASE
                  WHEN event_name = 'keeper_receipt'
                    AND payload->>'paidReward' ~ ${VALID_ETH_SQL}
                  THEN REPLACE(payload->>'paidReward', ' ETH', '')::numeric
                  ELSE 0
                END
              ), 0)::text AS gross_reward_eth,
              COALESCE(SUM(
                CASE
                  WHEN event_name = 'keeper_receipt'
                    AND payload->>'gasCost' ~ ${VALID_ETH_SQL}
                  THEN REPLACE(payload->>'gasCost', ' ETH', '')::numeric
                  ELSE 0
                END
              ), 0)::text AS gas_cost_eth
            FROM latest_outcomes
            GROUP BY COALESCE(job_kind, payload->>'kind', 'unknown')
            ORDER BY ABS(COALESCE(SUM(
              CASE
                WHEN event_name = 'keeper_receipt'
                  AND payload->>'realizedProfit' ~ ${VALID_ETH_SQL}
                THEN REPLACE(payload->>'realizedProfit', ' ETH', '')::numeric
                ELSE 0
              END
            ), 0)) DESC, COUNT(*) DESC
          `,
          [now.toISOString()],
        ),
        this.#pool.query<HealthRow>(
          `
            SELECT
              (
                SELECT COUNT(DISTINCT transaction_hash)
                FROM keeper_events
                WHERE event_name = 'keeper_transaction_sent'
                  AND transaction_hash IS NOT NULL
                  AND occurred_at >= $1::timestamptz - INTERVAL '1 hour'
              )::text AS submissions_1h,
              (
                SELECT COUNT(DISTINCT transaction_hash)
                FROM keeper_events
                WHERE event_name = 'keeper_transaction_sent'
                  AND transaction_hash IS NOT NULL
                  AND occurred_at >= $1::timestamptz - INTERVAL '24 hours'
              )::text AS submissions_24h,
              (
                SELECT COUNT(*)
                FROM keeper_events
                WHERE event_name = 'pass_complete'
                  AND occurred_at >= $1::timestamptz - INTERVAL '1 hour'
              )::text AS passes_1h,
              (
                SELECT COUNT(*)
                FROM keeper_events
                WHERE event_name = 'pass_complete'
                  AND occurred_at >= $1::timestamptz - INTERVAL '24 hours'
              )::text AS passes_24h,
              (
                SELECT COUNT(*)
                FROM keeper_events
                WHERE event_name = 'keeper_pass_failed'
                  AND occurred_at >= $1::timestamptz - INTERVAL '1 hour'
              )::text AS pass_failures_1h,
              (
                SELECT COUNT(*)
                FROM keeper_events
                WHERE event_name = 'keeper_pass_failed'
                  AND occurred_at >= $1::timestamptz - INTERVAL '24 hours'
              )::text AS pass_failures_24h,
              (
                SELECT occurred_at
                FROM keeper_events
                WHERE event_name = 'pass_complete'
                ORDER BY occurred_at DESC
                LIMIT 1
              ) AS last_pass_at,
              (
                SELECT COALESCE(
                  payload->>'observedBlock',
                  payload->>'block'
                )
                FROM keeper_events
                WHERE event_name = 'pass_complete'
                ORDER BY occurred_at DESC
                LIMIT 1
              ) AS last_pass_block,
              (
                SELECT occurred_at
                FROM keeper_events
                WHERE event_name = 'keeper_receipt'
                  AND payload->>'status' = 'success'
                  AND COALESCE(payload->>'targetBlockMatched', 'true') <> 'false'
                ORDER BY occurred_at DESC
                LIMIT 1
              ) AS last_success_at
          `,
          [now.toISOString()],
        ),
      ]);

    const oneHour = windowsResult.rows.find(
      (row) => row.window_name === "1h",
    );
    const twentyFourHours = windowsResult.rows.find(
      (row) => row.window_name === "24h",
    );
    const health = healthResult.rows[0];
    if (
      oneHour === undefined ||
      twentyFourHours === undefined ||
      health === undefined
    ) {
      throw new Error("hourly stats query returned incomplete results");
    }

    return {
      generatedAt: now,
      oneHour: windowFromRow(oneHour),
      twentyFourHours: windowFromRow(twentyFourHours),
      lanes24h: lanesResult.rows.map((row) => ({
        kind: row.kind,
        ...windowFromRow(row),
      })),
      health: {
        submissions1h: count(health.submissions_1h),
        submissions24h: count(health.submissions_24h),
        passes1h: count(health.passes_1h),
        passes24h: count(health.passes_24h),
        passFailures1h: count(health.pass_failures_1h),
        passFailures24h: count(health.pass_failures_24h),
        lastPassAt: optionalDate(health.last_pass_at),
        lastPassBlock: health.last_pass_block ?? undefined,
        lastSuccessAt: optionalDate(health.last_success_at),
      },
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

function signedEth(value: bigint): string {
  const prefix = value > 0n ? "+" : "";
  return `${prefix}${formatEther(value)} ETH`;
}

function signedUsd(valueWei: bigint, ethUsd: number): string {
  const value = Number(formatEther(valueWei)) * ethUsd;
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  return `${prefix}$${absolute.toLocaleString("en-US", {
    minimumFractionDigits: absolute < 0.01 ? 4 : 2,
    maximumFractionDigits: absolute < 0.01 ? 4 : 2,
  })}`;
}

function countRatio(window: HourlyStatsWindow): string {
  if (window.transactions === 0) return "—";
  return `${(
    (window.successes / window.transactions) *
    100
  ).toFixed(1)}%`;
}

function windowField(
  window: HourlyStatsWindow,
  ethUsd: number | undefined,
): string {
  const usd =
    ethUsd === undefined
      ? ""
      : ` (${signedUsd(window.realizedProfitWei, ethUsd)})`;
  return [
    `**P&L:** ${signedEth(window.realizedProfitWei)}${usd}`,
    `**Transactions:** ${window.transactions}`,
    `**Success / failed:** ${window.successes} / ${window.failures} (${countRatio(window)})`,
    `**Gross / gas:** ${formatEther(window.grossRewardWei)} / ${formatEther(window.gasCostWei)} ETH`,
  ].join("\n");
}

function discordTime(date: Date | undefined): string {
  if (date === undefined) return "—";
  return `<t:${Math.floor(date.getTime() / 1_000)}:R>`;
}

function laneName(kind: string): string {
  return kind
    .split("_")
    .map((part) =>
      part.length === 0
        ? part
        : `${part[0]!.toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function laneField(lanes: readonly HourlyStatsLane[]): string {
  if (lanes.length === 0) {
    return "No terminal transaction outcomes in the last 24 hours.";
  }
  const visible = lanes.slice(0, 8);
  const lines = visible.map(
    (lane) =>
      `• **${laneName(lane.kind)}:** ${signedEth(lane.realizedProfitWei)} · ${lane.successes}/${lane.failures} W/F`,
  );
  if (lanes.length > visible.length) {
    lines.push(`• ${lanes.length - visible.length} more lanes omitted`);
  }
  return lines.join("\n");
}

export function buildHourlyStatsEmbed(
  snapshot: HourlyStatsSnapshot,
  ethUsd?: number,
): DiscordEmbed {
  const { health } = snapshot;
  const color =
    snapshot.oneHour.realizedProfitWei > 0n
      ? 0x2ecc71
      : snapshot.oneHour.realizedProfitWei < 0n ||
          snapshot.oneHour.failures > 0 ||
          health.passFailures1h > 0
        ? 0xe74c3c
        : 0x3498db;
  const price =
    ethUsd === undefined
      ? ""
      : ` · ETH/USD $${ethUsd.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;

  return {
    title: "Hourly keeper stats",
    description:
      "Rolling receipt-derived performance. Failed includes reverted, expired/missed, and unresolved transaction outcomes.",
    color,
    fields: [
      {
        name: "Last 1 hour",
        value: windowField(snapshot.oneHour, ethUsd),
        inline: true,
      },
      {
        name: "Rolling 24 hours",
        value: windowField(snapshot.twentyFourHours, ethUsd),
        inline: true,
      },
      {
        name: "Operations",
        value: [
          `**Submitted (1h / 24h):** ${health.submissions1h} / ${health.submissions24h}`,
          `**Passes (1h / 24h):** ${health.passes1h} / ${health.passes24h}`,
          `**Pass failures:** ${health.passFailures1h} / ${health.passFailures24h}`,
          `**Last pass:** ${discordTime(health.lastPassAt)}${
            health.lastPassBlock === undefined
              ? ""
              : ` · block ${health.lastPassBlock}`
          }`,
          `**Last success:** ${discordTime(health.lastSuccessAt)}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "24h by lane · P&L · W/F",
        value: laneField(snapshot.lanes24h),
        inline: false,
      },
    ],
    timestamp: snapshot.generatedAt.toISOString(),
    footer: { text: `FWA Keeper · durable PostgreSQL telemetry${price}` },
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class HourlyStatsDeliveryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("hourly stats delivery failed");
    this.name = "HourlyStatsDeliveryError";
    this.code = code;
  }
}

export class DiscordHourlyStatsSender
  implements HourlyStatsSender
{
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(parameters: {
    readonly url: string;
    readonly timeoutMs: number;
  }) {
    this.#url = parameters.url;
    this.#timeoutMs = parameters.timeoutMs;
  }

  async send(embed: DiscordEmbed): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "FWA Keeper Stats",
          allowed_mentions: { parse: [] },
          embeds: [embed],
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.ok) return;
      if (response.status === 429 && attempt === 0) {
        const payload = (await response.json()) as {
          readonly retry_after?: number;
        };
        const retryAfterMs = Math.min(
          Math.max((payload.retry_after ?? 1) * 1_000, 250),
          10_000,
        );
        await delay(retryAfterMs);
        continue;
      }
      throw new HourlyStatsDeliveryError(
        `HTTP_${response.status}`,
      );
    }
  }
}

type StatsReporterLog = (
  level: LogLevel,
  event: string,
  fields: Record<string, LogFieldValue>,
) => void;

export class HourlyStatsReporter {
  readonly #source: HourlyStatsSource;
  readonly #sender: HourlyStatsSender;
  readonly #beforeReport: (() => Promise<void>) | undefined;
  readonly #ethUsd: (() => Promise<number>) | undefined;
  readonly #report: StatsReporterLog;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #started = false;
  #closed = false;

  constructor(parameters: {
    readonly source: HourlyStatsSource;
    readonly sender: HourlyStatsSender;
    readonly beforeReport?: (() => Promise<void>) | undefined;
    readonly ethUsd?: (() => Promise<number>) | undefined;
    readonly report?: StatsReporterLog;
    readonly now?: () => Date;
    readonly intervalMs?: number;
  }) {
    const intervalMs = parameters.intervalMs ?? HOUR_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("hourly stats interval must be a positive integer");
    }
    this.#source = parameters.source;
    this.#sender = parameters.sender;
    this.#beforeReport = parameters.beforeReport;
    this.#ethUsd = parameters.ethUsd;
    this.#report = parameters.report ?? (() => undefined);
    this.#now = parameters.now ?? (() => new Date());
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#schedule();
  }

  async runNow(): Promise<void> {
    if (this.#closed) return;
    if (this.#inFlight !== undefined) {
      await this.#inFlight;
      return;
    }
    const operation = this.#run();
    this.#inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.#inFlight === operation) {
        this.#inFlight = undefined;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight;
    await this.#source.close();
  }

  #schedule(): void {
    if (this.#closed) return;
    const remainder = this.#now().getTime() % this.#intervalMs;
    const delayMs =
      remainder === 0
        ? this.#intervalMs
        : this.#intervalMs - remainder;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runNow().finally(() => this.#schedule());
    }, delayMs);
    this.#timer.unref();
  }

  async #run(): Promise<void> {
    if (this.#beforeReport !== undefined) {
      try {
        await this.#beforeReport();
      } catch (error) {
        this.#report("warn", "hourly_stats_flush_failed", {
          ...errorFingerprint(error),
          action: "continuing_with_durable_events",
        });
      }
    }

    const now = this.#now();
    let snapshot: HourlyStatsSnapshot;
    try {
      snapshot = await this.#source.load(now);
    } catch (error) {
      this.#report("warn", "hourly_stats_query_failed", {
        ...errorFingerprint(error),
        action: "retrying_at_next_hour",
      });
      return;
    }

    let ethUsd: number | undefined;
    if (this.#ethUsd !== undefined) {
      try {
        const price = await this.#ethUsd();
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error("invalid ETH/USD price");
        }
        ethUsd = price;
      } catch (error) {
        this.#report("warn", "hourly_stats_price_failed", {
          ...errorFingerprint(error),
          action: "sending_eth_only",
        });
      }
    }

    try {
      await this.#sender.send(
        buildHourlyStatsEmbed(snapshot, ethUsd),
      );
    } catch (error) {
      this.#report("warn", "hourly_stats_delivery_failed", {
        ...errorFingerprint(error),
        action: "retrying_at_next_hour",
      });
      return;
    }
    this.#report("info", "hourly_stats_report_sent", {
      reportTime: snapshot.generatedAt.toISOString(),
      transactions1h: snapshot.oneHour.transactions,
      successes1h: snapshot.oneHour.successes,
      failures1h: snapshot.oneHour.failures,
      realizedProfit1h: `${formatEther(
        snapshot.oneHour.realizedProfitWei,
      )} ETH`,
      transactions24h: snapshot.twentyFourHours.transactions,
      realizedProfit24h: `${formatEther(
        snapshot.twentyFourHours.realizedProfitWei,
      )} ETH`,
    });
  }
}
