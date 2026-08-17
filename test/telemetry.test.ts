import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  BatchedEventSink,
  PostgresEventWriter,
  type EventBatchWriter,
  type StoredLogEvent,
} from "../src/telemetry.js";
import type { LogEntry } from "../src/format.js";

class RecordingWriter implements EventBatchWriter {
  readonly events: StoredLogEvent[] = [];
  readonly stoppedAt: string[] = [];
  closed = false;
  failures = 0;

  async write(events: readonly StoredLogEvent[]): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("database unavailable");
    }
    this.events.push(...events);
  }

  async stop(stoppedAt: string): Promise<void> {
    this.stoppedAt.push(stoppedAt);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function entry(
  event: string,
  fields: Partial<LogEntry> = {},
): LogEntry {
  return {
    time: "2026-07-29T00:00:00.000Z",
    level: "info",
    event,
    ...fields,
  };
}

describe("BatchedEventSink", () => {
  it("batches structured events and extracts indexed fields", async () => {
    const writer = new RecordingWriter();
    const sink = new BatchedEventSink({
      writer,
      runId: "8bd899e7-c5e4-47c8-84ff-5b761a0b04bd",
      batchSize: 10,
      flushIntervalMs: 60_000,
      maximumQueueSize: 100,
    });

    sink.notify(
      entry("keeper_receipt", {
        block: "25635555",
        targetBlock: "25635554",
        hash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        kind: "standing_order",
      }),
    );
    await sink.flush();

    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]).toMatchObject({
      runId: "8bd899e7-c5e4-47c8-84ff-5b761a0b04bd",
      blockNumber: "25635555",
      targetBlock: "25635554",
      transactionHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      jobKind: "standing_order",
    });
    await sink.close();
  });

  it("indexes a bundled event by its batch target block", async () => {
    const writer = new RecordingWriter();
    const sink = new BatchedEventSink({
      writer,
      batchSize: 10,
      flushIntervalMs: 60_000,
      maximumQueueSize: 100,
    });

    sink.notify(
      entry("keeper_transaction_expired", {
        batchTargetBlock: "25635556",
        hash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        kind: "standing_order",
      }),
    );
    await sink.flush();

    expect(writer.events[0]?.targetBlock).toBe("25635556");
    await sink.close();
  });

  it("retains a failed batch and succeeds on a later flush", async () => {
    const writer = new RecordingWriter();
    writer.failures = 1;
    const reports: LogEntry[] = [];
    const sink = new BatchedEventSink({
      writer,
      batchSize: 10,
      flushIntervalMs: 60_000,
      maximumQueueSize: 100,
      report: (reported) => reports.push(reported),
    });
    sink.notify(entry("keeper_started"));

    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.pendingEvents).toBe(1);
    expect(reports.at(-1)?.event).toBe("telemetry_write_failed");

    await sink.flush();
    expect(sink.pendingEvents).toBe(0);
    expect(writer.events.map((event) => event.entry.event)).toEqual([
      "keeper_started",
    ]);
    expect(reports.at(-1)).toMatchObject({
      event: "telemetry_write_recovered",
      failedAttempts: 1,
      persistedEvents: 1,
      remainingQueuedEvents: 0,
    });
    await sink.close();
  });

  it("discards a database connection after a failed transaction", async () => {
    const release = vi.fn();
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("INSERT INTO keeper_events")) {
        throw new Error("Query read timeout");
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
    const runId = "8bd899e7-c5e4-47c8-84ff-5b761a0b04bd";
    const writer = new PostgresEventWriter(
      "postgresql://example.invalid/test",
      {
        runId,
        startedAt: "2026-07-29T00:00:00.000Z",
        service: "keeper",
        gitSha: undefined,
        instanceId: undefined,
      },
      pool,
    );

    await expect(
      writer.write([
        {
          eventId: "5ec9a2f7-9cef-48e4-a6c9-89d0a5f9bcb2",
          runId,
          entry: entry("pass_complete"),
          blockNumber: undefined,
          targetBlock: undefined,
          transactionHash: undefined,
          jobKind: undefined,
        },
      ]),
    ).rejects.toThrow("Query read timeout");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("drops lower-priority telemetry before transaction outcomes", async () => {
    const writer = new RecordingWriter();
    const reports: LogEntry[] = [];
    const sink = new BatchedEventSink({
      writer,
      batchSize: 2,
      flushIntervalMs: 60_000,
      maximumQueueSize: 2,
      report: (reported) => reports.push(reported),
    });
    sink.notify(entry("new_block", { level: "debug" }));
    sink.notify(entry("acquisition_status", { level: "debug" }));
    sink.notify(entry("keeper_receipt"));

    await sink.flush();

    expect(
      writer.events.map((event) => event.entry.event),
    ).toContain("keeper_receipt");
    expect(
      writer.events.map((event) => event.entry.event),
    ).toHaveLength(2);
    expect(reports[0]?.event).toBe("telemetry_queue_overflow");
    await sink.close();
  });

  it("closes the writer without propagating stop failures", async () => {
    const writer = new RecordingWriter();
    writer.stop = async (): Promise<void> => {
      throw new Error("database unavailable");
    };
    const reports: LogEntry[] = [];
    const sink = new BatchedEventSink({
      writer,
      batchSize: 10,
      flushIntervalMs: 60_000,
      maximumQueueSize: 100,
      report: (reported) => reports.push(reported),
    });

    await expect(sink.close()).resolves.toBeUndefined();
    expect(writer.closed).toBe(true);
    expect(reports.at(-1)?.event).toBe(
      "telemetry_run_stop_failed",
    );
  });
});
