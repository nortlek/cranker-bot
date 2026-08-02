import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { errorFingerprint, log } from "./format.js";

interface WorkerHandler {
  fetch(
    request: Request,
    environment: {
      readonly ASSETS: { fetch(request: Request): Promise<Response> };
    },
  ): Promise<Response>;
}

interface DashboardOptions {
  readonly databaseUrl?: string;
  readonly ethUsd?: () => Promise<number>;
  readonly port?: number;
}

export interface DashboardRuntime {
  readonly port: number;
  close(): Promise<void>;
}

interface EventRow {
  readonly occurred_at: Date;
  readonly event_name: string;
  readonly transaction_hash: string | null;
  readonly target_block: string | null;
  readonly block_number: string | null;
  readonly job_kind: string | null;
  readonly payload: Record<string, unknown>;
}

interface ProfitRow {
  readonly bucket: Date;
  readonly job_kind: string | null;
  readonly profit_eth: string;
}

interface LaneProfitRow {
  readonly job_kind: string | null;
  readonly profit_eth: string;
}

interface ExecutionSummaryRow {
  readonly batch_attempts: string;
  readonly batch_wins: string;
  readonly last_pass_at: Date | null;
  readonly last_block: string | null;
  readonly last_viable: string | null;
  readonly last_sent: string | null;
  readonly last_confirmed: string | null;
}

interface RelaySummaryRow {
  readonly relay_index: string;
  readonly attempted: string;
  readonly accepted: string;
}

interface HealthSummaryRow {
  readonly active_runs: string;
  readonly signer_leases: string;
  readonly pass_failures_24h: string;
}

const mimeTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function fileExtension(pathname: string): string {
  const lastDot = pathname.lastIndexOf(".");
  return lastDot === -1 ? "" : pathname.slice(lastDot).toLowerCase();
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("dashboard port must be an integer from 1 through 65535");
  }
  return parsed;
}

function parseEth(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = /^(-?[0-9]+(?:\.[0-9]+)?) ETH$/.exec(value.trim());
  if (match?.[1] === undefined) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function laneForKind(kind: string): {
  readonly laneKey: "orders" | "lifecycle" | "fwa" | "pull" | "other";
  readonly lane: string;
  readonly contract: string;
  readonly strategy: string;
  readonly accent: string;
} {
  switch (kind) {
    case "standing_order":
      return {
        laneKey: "orders",
        lane: "Standing order",
        contract: "PullStandingOrder",
        strategy: "crank",
        accent: "#b7f34a",
      };
    case "fwa_process":
      return {
        laneKey: "fwa",
        lane: "FWA backrun",
        contract: "FWA",
        strategy: "processAcquisitions",
        accent: "#8ba6ff",
      };
    case "pool_sync":
      return {
        laneKey: "lifecycle",
        lane: "Pool lifecycle",
        contract: "PullPool",
        strategy: "syncFwaResult",
        accent: "#6ce5d7",
      };
    case "pool_settle":
    case "pool_settle_forced_eth":
      return {
        laneKey: "lifecycle",
        lane: "Pool lifecycle",
        contract: "PullPool",
        strategy: kind === "pool_settle" ? "settle" : "settleForcedEth",
        accent: "#6ce5d7",
      };
    case "pool_pull":
      return {
        laneKey: "pull",
        lane: "Pool pull",
        contract: "PullPool",
        strategy: "pull",
        accent: "#c5a7ff",
      };
    case "convex_earmark":
      return {
        laneKey: "other",
        lane: "Convex earmark",
        contract: "Booster",
        strategy: "earmarkRewards",
        accent: "#ffb35c",
      };
    case "convex_kick":
      return {
        laneKey: "other",
        lane: "Convex kick",
        contract: "vlCVX",
        strategy: "kick",
        accent: "#ffb35c",
      };
    case "liquity_liquidation":
      return {
        laneKey: "other",
        lane: "Liquity liquidation",
        contract: "BorrowerOperations",
        strategy: "batchLiquidateTroves",
        accent: "#ffb35c",
      };
    case "fwa_buyback":
      return {
        laneKey: "other",
        lane: "FWA buyback",
        contract: "FWAToken",
        strategy: "buyback",
        accent: "#ffb35c",
      };
    default:
      return {
        laneKey: "other",
        lane: "Other keeper lane",
        contract: "Keeper target",
        strategy: kind || "execute",
        accent: "#ffb35c",
      };
  }
}

function relativeTime(date: Date): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h ago`;
  return `${Math.floor(elapsedSeconds / 86_400)}d ago`;
}

function shortenedHash(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export async function buildDashboardData(
  pool: Pool,
  ethUsd: number,
): Promise<Record<string, unknown>> {
  const [
    recentResult,
    profitResult,
    totalResult,
    laneProfitResult,
    executionResult,
    relayResult,
    healthResult,
  ] = await Promise.all([
    pool.query<EventRow>(
      `
        SELECT
          occurred_at,
          event_name,
          transaction_hash,
          target_block::text,
          block_number::text,
          job_kind,
          payload
        FROM keeper_events
        WHERE event_name IN ('keeper_receipt', 'keeper_transaction_expired')
        ORDER BY occurred_at DESC
        LIMIT 160
      `,
    ),
    pool.query<ProfitRow>(
      `
        SELECT
          date_trunc('day', occurred_at) AS bucket,
          job_kind,
          SUM(REPLACE(payload->>'realizedProfit', ' ETH', '')::numeric)::text AS profit_eth
        FROM keeper_events
        WHERE event_name = 'keeper_receipt'
          AND occurred_at >= NOW() - INTERVAL '30 days'
          AND payload->>'realizedProfit' ~ '^-?[0-9]+([.][0-9]+)? ETH$'
        GROUP BY 1, 2
        ORDER BY 1
      `,
    ),
    pool.query<{ total_profit_eth: string; receipt_count: string }>(
      `
        SELECT
          COALESCE(SUM(REPLACE(payload->>'realizedProfit', ' ETH', '')::numeric), 0)::text AS total_profit_eth,
          COUNT(*)::text AS receipt_count
        FROM keeper_events
        WHERE event_name = 'keeper_receipt'
          AND payload->>'realizedProfit' ~ '^-?[0-9]+([.][0-9]+)? ETH$'
      `,
    ),
    pool.query<LaneProfitRow>(
      `
        SELECT
          job_kind,
          COALESCE(SUM(REPLACE(payload->>'realizedProfit', ' ETH', '')::numeric), 0)::text AS profit_eth
        FROM keeper_events
        WHERE event_name = 'keeper_receipt'
          AND payload->>'realizedProfit' ~ '^-?[0-9]+([.][0-9]+)? ETH$'
        GROUP BY job_kind
      `,
    ),
    pool.query<ExecutionSummaryRow>(
      `
        WITH latest_pass AS (
          SELECT
            occurred_at,
            payload->>'observedBlock' AS block,
            payload->>'viable' AS viable,
            payload->>'sent' AS sent,
            payload->>'confirmed' AS confirmed
          FROM keeper_events
          WHERE event_name = 'pass_complete'
          ORDER BY occurred_at DESC
          LIMIT 1
        ), batches AS (
          SELECT
            COUNT(*) AS attempts,
            COUNT(*) FILTER (
              WHERE COALESCE((payload->>'confirmedTransactions')::integer, 0) > 0
            ) AS wins
          FROM keeper_events
          WHERE event_name = 'keeper_batch_result'
            AND occurred_at >= NOW() - INTERVAL '7 days'
        )
        SELECT
          batches.attempts::text AS batch_attempts,
          batches.wins::text AS batch_wins,
          latest_pass.occurred_at AS last_pass_at,
          latest_pass.block AS last_block,
          latest_pass.viable AS last_viable,
          latest_pass.sent AS last_sent,
          latest_pass.confirmed AS last_confirmed
        FROM batches
        LEFT JOIN latest_pass ON TRUE
      `,
    ),
    pool.query<RelaySummaryRow>(
      `
        SELECT
          payload->>'relayIndex' AS relay_index,
          COUNT(*)::text AS attempted,
          COUNT(*) FILTER (WHERE payload->>'status' = 'accepted')::text AS accepted
        FROM keeper_events
        WHERE event_name = 'relay_submission_result'
          AND occurred_at >= NOW() - INTERVAL '7 days'
          AND payload->>'relayIndex' ~ '^[0-9]+$'
        GROUP BY payload->>'relayIndex'
        ORDER BY (payload->>'relayIndex')::integer
      `,
    ),
    pool.query<HealthSummaryRow>(
      `
        SELECT
          (SELECT COUNT(*) FROM keeper_runs WHERE stopped_at IS NULL)::text AS active_runs,
          (SELECT COUNT(*) FROM pg_locks WHERE locktype = 'advisory' AND granted)::text AS signer_leases,
          (
            SELECT COUNT(*)
            FROM keeper_events
            WHERE event_name = 'keeper_pass_failed'
              AND occurred_at >= NOW() - INTERVAL '24 hours'
          )::text AS pass_failures_24h
      `,
    ),
  ]);

  const transactions = recentResult.rows.map((row) => {
    const payload = row.payload;
    const kind =
      typeof payload.kind === "string"
        ? payload.kind
        : row.job_kind ?? "";
    const lane = laneForKind(kind);
    const batchSize = optionalInteger(payload.batchTransactionCount);
    const batchIndex = optionalInteger(payload.batchPosition);
    const targetBlock =
      row.target_block ??
      (typeof payload.batchTargetBlock === "string" ? payload.batchTargetBlock : undefined) ??
      row.block_number ??
      "";
    const hash =
      row.transaction_hash ??
      (typeof payload.hash === "string" ? payload.hash : "");
    const isReceipt = row.event_name === "keeper_receipt";
    const status = isReceipt && payload.status === "success" ? "landed" : "missed";
    const reward = parseEth(payload.paidReward) * ethUsd;
    const cost = parseEth(payload.gasCost) * ethUsd;
    const net = parseEth(payload.realizedProfit) * ethUsd;
    return {
      hash: shortenedHash(hash),
      fullHash: hash,
      ...lane,
      time: new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "America/Denver",
      }).format(row.occurred_at),
      relative: relativeTime(row.occurred_at),
      block: targetBlock === "" ? "—" : Number(targetBlock).toLocaleString("en-US"),
      builder: "Private",
      reward: Number(reward.toFixed(2)),
      cost: Number(cost.toFixed(2)),
      net: Number(net.toFixed(2)),
      status,
      calls: [lane.strategy],
      gas: typeof payload.gasUsed === "string"
        ? Number(payload.gasUsed).toLocaleString("en-US")
        : "—",
      bid: typeof payload.effectiveBuilderBidBps === "string"
        ? `${(Number(payload.effectiveBuilderBidBps) / 100).toFixed(2)}%`
        : "—",
      ...(batchSize !== undefined && batchSize > 1
        ? {
            batchId: `target-${targetBlock}`,
            batchLabel: `${lane.lane} · block ${targetBlock}`,
            batchIndex,
            batchSize,
          }
        : {}),
    };
  });

  const buckets = new Map<string, Record<string, number>>();
  for (const row of profitResult.rows) {
    const key = row.bucket.toISOString().slice(0, 10);
    const current = buckets.get(key) ?? {
      orders: 0,
      lifecycle: 0,
      fwa: 0,
      pull: 0,
      other: 0,
    };
    const lane = laneForKind(row.job_kind ?? "").laneKey;
    current[lane] = (current[lane] ?? 0) + Number(row.profit_eth) * ethUsd;
    buckets.set(key, current);
  }

  let cumulative = 0;
  const pnl = [...buckets.entries()].map(([date, values]) => {
    const interval = Object.values(values).reduce((total, value) => total + value, 0);
    cumulative += interval;
    const dateValue = new Date(`${date}T00:00:00Z`);
    return {
      label: new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", timeZone: "UTC" }).format(dateValue),
      short: new Intl.DateTimeFormat("en-US", { day: "2-digit", timeZone: "UTC" }).format(dateValue),
      pnl: Number(cumulative.toFixed(2)),
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value.toFixed(2))])),
    };
  });

  const total = totalResult.rows[0];
  const laneTotals = new Map<
    ReturnType<typeof laneForKind>["laneKey"],
    number
  >();
  for (const row of laneProfitResult.rows) {
    const laneKey = laneForKind(row.job_kind ?? "").laneKey;
    laneTotals.set(
      laneKey,
      (laneTotals.get(laneKey) ?? 0) + Number(row.profit_eth) * ethUsd,
    );
  }
  const lanes = (["orders", "lifecycle", "fwa", "pull", "other"] as const)
    .map((key) => ({
      key,
      value: Number((laneTotals.get(key) ?? 0).toFixed(2)),
      chartValue: Number(Math.max(0, laneTotals.get(key) ?? 0).toFixed(2)),
    }));
  const execution = executionResult.rows[0];
  const batchAttempts = Number(execution?.batch_attempts ?? 0);
  const batchWins = Number(execution?.batch_wins ?? 0);
  const relays = relayResult.rows.map((row) => ({
    relayIndex: Number(row.relay_index),
    attempted: Number(row.attempted),
    accepted: Number(row.accepted),
  }));
  const relayAttempts = relays.reduce(
    (totalAttempts, relay) => totalAttempts + relay.attempted,
    0,
  );
  const relayAccepted = relays.reduce(
    (totalAccepted, relay) => totalAccepted + relay.accepted,
    0,
  );
  const health = healthResult.rows[0];
  return {
    generatedAt: new Date().toISOString(),
    ethUsd,
    summary: {
      receiptProfitUsd: Number((Number(total?.total_profit_eth ?? 0) * ethUsd).toFixed(2)),
      receiptProfitEth: Number(total?.total_profit_eth ?? 0),
      receiptCount: Number(total?.receipt_count ?? 0),
      batchAttempts,
      batchWins,
      batchWinRate:
        batchAttempts === 0
          ? 0
          : Number(((batchWins / batchAttempts) * 100).toFixed(1)),
      relayAttempts,
      relayAccepted,
      relayDeliveryRate:
        relayAttempts === 0
          ? 0
          : Number(((relayAccepted / relayAttempts) * 100).toFixed(1)),
    },
    execution: {
      lastPassAt: execution?.last_pass_at?.toISOString() ?? "",
      lastBlock: execution?.last_block ?? "",
      viable: Number(execution?.last_viable ?? 0),
      sent: Number(execution?.last_sent ?? 0),
      confirmed: Number(execution?.last_confirmed ?? 0),
      activeRuns: Number(health?.active_runs ?? 0),
      signerLeases: Number(health?.signer_leases ?? 0),
      passFailures24h: Number(health?.pass_failures_24h ?? 0),
    },
    lanes,
    relays,
    pnl,
    transactions,
  };
}

function staticAssetFetcher(clientRoot: string): {
  fetch(request: Request): Promise<Response>;
} {
  const rootPrefix = `${clientRoot}${sep}`;
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      const relativePath = pathname.replace(/^\/+/, "");
      if (relativePath === "") return new Response("Not Found", { status: 404 });
      const assetPath = resolve(clientRoot, relativePath);
      if (!assetPath.startsWith(rootPrefix)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const body = await readFile(assetPath);
        const headers = new Headers({
          "content-type": mimeTypes[fileExtension(assetPath)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
        });
        if (pathname.startsWith("/assets/")) {
          headers.set("cache-control", "public, max-age=31536000, immutable");
        } else {
          headers.set("cache-control", "public, max-age=3600");
        }
        return new Response(body, { status: 200, headers });
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "";
        if (code === "ENOENT" || code === "EISDIR") {
          return new Response("Not Found", { status: 404 });
        }
        throw error;
      }
    },
  };
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 1_048_576) {
      throw new Error("dashboard request body exceeded one megabyte");
    }
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function writeResponse(
  request: IncomingMessage,
  response: ServerResponse,
  fetchResponse: Response,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of fetchResponse.headers) {
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  headers["referrer-policy"] ??= "same-origin";
  headers["x-frame-options"] ??= "DENY";
  headers["x-content-type-options"] ??= "nosniff";
  response.writeHead(fetchResponse.status, headers);
  if (request.method === "HEAD" || fetchResponse.body === null) {
    response.end();
    return;
  }
  await new Promise<void>((resolveStream, rejectStream) => {
    const body = Readable.fromWeb(fetchResponse.body as never);
    body.on("error", rejectStream);
    response.on("error", rejectStream);
    response.on("finish", resolveStream);
    body.pipe(response);
  });
}

export async function startDashboardServer(
  options: DashboardOptions = {},
): Promise<DashboardRuntime | undefined> {
  const port =
    options.port ??
    parsePort(process.env.DASHBOARD_PORT ?? process.env.PORT);
  if (port === undefined) {
    log("info", "dashboard_disabled", {
      reason: "PORT and DASHBOARD_PORT are unset",
    });
    return undefined;
  }

  const buildRoot = resolve(process.cwd(), "dashboard", "dist");
  const serverEntry = resolve(buildRoot, "server", "index.js");
  const clientRoot = resolve(buildRoot, "client");
  const imported = (await import(pathToFileURL(serverEntry).href)) as {
    readonly default: WorkerHandler;
  };
  const worker = imported.default;
  const assets = staticAssetFetcher(clientRoot);
  const pool =
    options.databaseUrl === undefined
      ? undefined
      : new Pool({
          connectionString: options.databaseUrl,
          max: 2,
          application_name: "keeper-dashboard",
        });

  let cachedData:
    | { readonly expiresAt: number; readonly body: string }
    | undefined;
  let cachedEthUsd:
    | { readonly expiresAt: number; readonly value: number }
    | undefined;
  const currentEthUsd = async (): Promise<number> => {
    if (cachedEthUsd !== undefined && cachedEthUsd.expiresAt > Date.now()) {
      return cachedEthUsd.value;
    }
    const configured = Number(process.env.DASHBOARD_ETH_USD);
    const fallback =
      Number.isFinite(configured) && configured > 0
        ? configured
        : cachedEthUsd?.value ?? 1_923.19;
    if (options.ethUsd === undefined) return fallback;
    try {
      const value = await options.ethUsd();
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("ETH/USD resolver returned an invalid value");
      }
      cachedEthUsd = {
        value,
        expiresAt: Date.now() + 60_000,
      };
      return value;
    } catch (error) {
      log("warn", "dashboard_eth_usd_refresh_failed", {
        ...errorFingerprint(error),
        action: "using_last_known_or_snapshot_price",
      });
      return fallback;
    }
  };
  const server = createServer(async (request, response) => {
    try {
      const headers = requestHeaders(request);
      const forwardedProtocol = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
      const protocol = forwardedProtocol === "https" ? "https" : "http";
      const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? `127.0.0.1:${port}`;
      const url = new URL(request.url ?? "/", `${protocol}://${host}`);

      if (url.pathname === "/healthz") {
        await writeResponse(
          request,
          response,
          new Response(JSON.stringify({ ok: true }), {
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
            },
          }),
        );
        return;
      }

      if (url.pathname === "/api/dashboard") {
        if (pool === undefined) {
          await writeResponse(
            request,
            response,
            new Response(JSON.stringify({ error: "dashboard data is unavailable" }), {
              status: 503,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json; charset=utf-8",
              },
            }),
          );
          return;
        }
        if (cachedData === undefined || cachedData.expiresAt <= Date.now()) {
          cachedData = {
            body: JSON.stringify(
              await buildDashboardData(pool, await currentEthUsd()),
            ),
            expiresAt: Date.now() + 15_000,
          };
        }
        await writeResponse(
          request,
          response,
          new Response(cachedData.body, {
            headers: {
              "cache-control": "private, max-age=10",
              "content-type": "application/json; charset=utf-8",
            },
          }),
        );
        return;
      }

      if (
        request.method === "GET" ||
        request.method === "HEAD" ||
        request.method === undefined
      ) {
        const assetResponse = await assets.fetch(
          new Request(url, {
            headers,
            method: request.method ?? "GET",
          }),
        );
        if (assetResponse.status !== 404) {
          await writeResponse(request, response, assetResponse);
          return;
        }
      }

      const body = await requestBody(request);
      const fetchRequest = new Request(url, {
        headers,
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(body === undefined
          ? {}
          : { body: Uint8Array.from(body).buffer }),
      });
      const fetchResponse = await worker.fetch(fetchRequest, { ASSETS: assets });
      await writeResponse(request, response, fetchResponse);
    } catch (error) {
      log("error", "dashboard_request_failed", {
        path: request.url?.split("?")[0] ?? "",
        ...errorFingerprint(error),
      });
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
      }
      response.end(JSON.stringify({ error: "dashboard request failed" }));
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  log("info", "dashboard_started", {
    port,
    durableData: pool !== undefined,
  });

  return {
    port,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
      });
      await pool?.end();
    },
  };
}
