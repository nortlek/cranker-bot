import { randomUUID } from "node:crypto";

import { Pool, type PoolConfig } from "pg";

import {
  errorMessage,
  type LogEntry,
  type LogFieldValue,
} from "./format.js";

export interface StoredLogEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly entry: LogEntry;
  readonly blockNumber: string | undefined;
  readonly targetBlock: string | undefined;
  readonly transactionHash: string | undefined;
  readonly jobKind: string | undefined;
}

export interface EventBatchWriter {
  write(events: readonly StoredLogEvent[]): Promise<void>;
  stop(stoppedAt: string): Promise<void>;
  close(): Promise<void>;
}

interface RunMetadata {
  readonly runId: string;
  readonly startedAt: string;
  readonly service: string;
  readonly gitSha: string | undefined;
  readonly instanceId: string | undefined;
}

export interface PostgresEventSinkOptions {
  readonly connectionString: string;
  readonly batchSize: number;
  readonly flushIntervalMs: number;
  readonly maximumQueueSize: number;
  readonly service?: string;
  readonly gitSha?: string | undefined;
  readonly instanceId?: string | undefined;
  readonly retryMaximumMs?: number;
  readonly report?: (entry: LogEntry) => void;
}

export interface BatchedEventSinkOptions {
  readonly writer: EventBatchWriter;
  readonly runId?: string;
  readonly batchSize: number;
  readonly flushIntervalMs: number;
  readonly maximumQueueSize: number;
  readonly retryMaximumMs?: number;
  readonly report?: (entry: LogEntry) => void;
}

const IMPORTANT_EVENTS = new Set([
  "adaptive_builder_bid_updated",
  "bundle_stage_timing",
  "competitor_bid_observed",
  "fatal",
  "firm_replenish_accounting_failed",
  "firm_replenish_opportunity",
  "firm_replenish_scan_failed",
  "keeper_receipt",
  "keeper_pass_stage_timing",
  "keeper_pass_timing",
  "keeper_plan_stale",
  "keeper_transaction_expired",
  "keeper_transaction_sent",
  "relay_submission_result",
  "signer_lease_acquired",
  "signer_lease_waiting",
  "stakedao_curve_opportunity",
  "stakedao_curve_scan_failed",
]);

function directReport(entry: LogEntry): void {
  console.warn(JSON.stringify(entry));
}

function optionalIntegerString(
  value: LogFieldValue | undefined,
): string | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }
  if (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*)$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

function optionalString(
  value: LogFieldValue | undefined,
): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function eventPriority(entry: LogEntry): number {
  if (IMPORTANT_EVENTS.has(entry.event)) return 4;
  if (entry.level === "error" || entry.level === "warn") return 3;
  if (entry.level === "info") return 2;
  return 1;
}

function poolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    max: 2,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 3_000,
    statement_timeout: 2_000,
  };
}

export class PostgresEventWriter implements EventBatchWriter {
  readonly #pool: Pool;
  readonly #run: RunMetadata;

  constructor(
    connectionString: string,
    run: RunMetadata,
    poolOverride?: Pool,
  ) {
    this.#pool =
      poolOverride ?? new Pool(poolConfig(connectionString));
    this.#run = run;
  }

  async write(events: readonly StoredLogEvent[]): Promise<void> {
    if (events.length === 0) return;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO keeper_runs (
            run_id,
            started_at,
            service,
            git_sha,
            instance_id
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (run_id) DO NOTHING
        `,
        [
          this.#run.runId,
          this.#run.startedAt,
          this.#run.service,
          this.#run.gitSha ?? null,
          this.#run.instanceId ?? null,
        ],
      );

      const values: unknown[] = [];
      const rows = events.map((event, index) => {
        const offset = index * 10;
        values.push(
          event.eventId,
          event.runId,
          event.entry.time,
          event.entry.level,
          event.entry.event,
          event.blockNumber ?? null,
          event.targetBlock ?? null,
          event.transactionHash ?? null,
          event.jobKind ?? null,
          JSON.stringify(event.entry),
        );
        return `(${Array.from(
          { length: 10 },
          (_, parameter) => `$${offset + parameter + 1}`,
        ).join(", ")})`;
      });
      await client.query(
        `
          INSERT INTO keeper_events (
            event_id,
            run_id,
            occurred_at,
            level,
            event_name,
            block_number,
            target_block,
            transaction_hash,
            job_kind,
            payload
          )
          VALUES ${rows.join(", ")}
          ON CONFLICT (event_id) DO NOTHING
        `,
        values,
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original database error is more useful than rollback failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async stop(stoppedAt: string): Promise<void> {
    await this.#pool.query(
      `
        UPDATE keeper_runs
        SET stopped_at = $2
        WHERE run_id = $1
      `,
      [this.#run.runId, stoppedAt],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export class BatchedEventSink {
  readonly #writer: EventBatchWriter;
  readonly #runId: string;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #maximumQueueSize: number;
  readonly #retryMaximumMs: number;
  readonly #report: (entry: LogEntry) => void;
  readonly #queue: StoredLogEvent[] = [];
  #timer: NodeJS.Timeout | undefined;
  #draining: Promise<boolean> | undefined;
  #inFlightCount = 0;
  #retryDelayMs: number;
  #closed = false;
  #overflowReportedAt = 0;
  #closePromise: Promise<void> | undefined;

  constructor(options: BatchedEventSinkOptions) {
    if (
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      !Number.isSafeInteger(options.flushIntervalMs) ||
      options.flushIntervalMs < 1 ||
      !Number.isSafeInteger(options.maximumQueueSize) ||
      options.maximumQueueSize < options.batchSize
    ) {
      throw new Error("invalid telemetry batch or queue configuration");
    }
    this.#writer = options.writer;
    this.#runId = options.runId ?? randomUUID();
    this.#batchSize = options.batchSize;
    this.#flushIntervalMs = options.flushIntervalMs;
    this.#maximumQueueSize = options.maximumQueueSize;
    this.#retryMaximumMs =
      options.retryMaximumMs ?? 30_000;
    this.#retryDelayMs = this.#flushIntervalMs;
    this.#report = options.report ?? directReport;
  }

  get runId(): string {
    return this.#runId;
  }

  get pendingEvents(): number {
    return this.#queue.length;
  }

  notify(entry: LogEntry): void {
    if (this.#closed) return;
    const event: StoredLogEvent = {
      eventId: randomUUID(),
      runId: this.#runId,
      entry,
      blockNumber: optionalIntegerString(entry.block),
      targetBlock: optionalIntegerString(entry.targetBlock),
      transactionHash:
        optionalString(entry.hash) ??
        optionalString(entry.transactionHash),
      jobKind: optionalString(entry.kind),
    };
    this.#makeRoom(event);
    if (this.#queue.length >= this.#maximumQueueSize) return;
    this.#queue.push(event);
    this.#schedule(
      this.#queue.length >= this.#batchSize
        ? 0
        : this.#flushIntervalMs,
    );
  }

  async flush(): Promise<void> {
    this.#clearTimer();
    while (this.#queue.length > 0) {
      const succeeded = await this.#drainOne();
      if (!succeeded) break;
    }
    if (!this.#closed && this.#queue.length > 0) {
      this.#schedule(this.#retryDelayMs);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#clearTimer();
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  #makeRoom(incoming: StoredLogEvent): void {
    if (this.#queue.length < this.#maximumQueueSize) return;
    const incomingPriority = eventPriority(incoming.entry);
    let candidateIndex = -1;
    let candidatePriority = Number.POSITIVE_INFINITY;
    for (
      let index = this.#inFlightCount;
      index < this.#queue.length;
      index += 1
    ) {
      const queued = this.#queue[index];
      if (queued === undefined) continue;
      const priority = eventPriority(queued.entry);
      if (priority < candidatePriority) {
        candidateIndex = index;
        candidatePriority = priority;
      }
    }
    if (
      candidateIndex >= 0 &&
      candidatePriority <= incomingPriority
    ) {
      this.#queue.splice(candidateIndex, 1);
    }
    this.#reportOverflow();
  }

  #reportOverflow(): void {
    const now = Date.now();
    if (now - this.#overflowReportedAt < 60_000) return;
    this.#overflowReportedAt = now;
    this.#report({
      time: new Date(now).toISOString(),
      level: "warn",
      event: "telemetry_queue_overflow",
      maximumQueueSize: this.#maximumQueueSize,
    });
  }

  #schedule(delayMs: number): void {
    if (
      this.#closed ||
      this.#timer !== undefined ||
      this.#draining !== undefined
    ) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drainOne().then(() => {
        if (this.#queue.length > 0) {
          this.#schedule(
            this.#retryDelayMs,
          );
        }
      });
    }, delayMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #drainOne(): Promise<boolean> {
    if (this.#draining !== undefined) return this.#draining;
    const batch = this.#queue.slice(0, this.#batchSize);
    if (batch.length === 0) return true;
    this.#inFlightCount = batch.length;
    const draining = (async (): Promise<boolean> => {
      try {
        await this.#writer.write(batch);
        this.#queue.splice(0, batch.length);
        this.#retryDelayMs = this.#flushIntervalMs;
        return true;
      } catch (error) {
        this.#retryDelayMs = Math.min(
          Math.max(
            this.#retryDelayMs * 2,
            this.#flushIntervalMs,
          ),
          this.#retryMaximumMs,
        );
        this.#report({
          time: new Date().toISOString(),
          level: "warn",
          event: "telemetry_write_failed",
          reason: errorMessage(error),
          queuedEvents: this.#queue.length,
          retryDelayMs: this.#retryDelayMs,
        });
        return false;
      }
    })();
    this.#draining = draining;
    try {
      return await draining;
    } finally {
      if (this.#draining === draining) {
        this.#draining = undefined;
        this.#inFlightCount = 0;
      }
    }
  }

  async #close(): Promise<void> {
    try {
      await this.flush();
      try {
        await this.#writer.stop(new Date().toISOString());
      } catch (error) {
        this.#report({
          time: new Date().toISOString(),
          level: "warn",
          event: "telemetry_run_stop_failed",
          reason: errorMessage(error),
        });
      }
    } finally {
      try {
        await this.#writer.close();
      } catch (error) {
        this.#report({
          time: new Date().toISOString(),
          level: "warn",
          event: "telemetry_close_failed",
          reason: errorMessage(error),
        });
      }
    }
  }
}

export function createPostgresEventSink(
  options: PostgresEventSinkOptions,
): BatchedEventSink {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const writer = new PostgresEventWriter(
    options.connectionString,
    {
      runId,
      startedAt,
      service: options.service ?? "keeper",
      gitSha: options.gitSha,
      instanceId: options.instanceId,
    },
  );
  return new BatchedEventSink({
    writer,
    runId,
    batchSize: options.batchSize,
    flushIntervalMs: options.flushIntervalMs,
    maximumQueueSize: options.maximumQueueSize,
    ...(options.report === undefined
      ? {}
      : { report: options.report }),
    ...(options.retryMaximumMs === undefined
      ? {}
      : { retryMaximumMs: options.retryMaximumMs }),
  });
}
