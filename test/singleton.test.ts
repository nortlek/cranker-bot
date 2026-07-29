import { describe, expect, it, vi } from "vitest";

import { acquireSignerLease } from "../src/singleton.js";

class FakeLeaseClient {
  readonly queries: string[] = [];
  connectCalls = 0;
  endCalls = 0;
  attempts = 0;
  held = true;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async query(
    text: string,
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    this.queries.push(text);
    if (text.includes("pg_try_advisory_lock")) {
      this.attempts += 1;
      return { rows: [{ locked: this.attempts >= 2 }] };
    }
    if (text.includes("FROM pg_locks")) {
      return { rows: [{ held: this.held }] };
    }
    return { rows: [{}] };
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

describe("acquireSignerLease", () => {
  it("waits for the process-scoped lock and releases it once", async () => {
    vi.useFakeTimers();
    const client = new FakeLeaseClient();
    const waiting = vi.fn();
    const pending = acquireSignerLease({
      connectionString: "postgres://unused",
      pollIntervalMs: 10,
      onWaiting: waiting,
      clientFactory: () => client,
    });

    await vi.advanceTimersByTimeAsync(10);
    const lease = await pending;

    expect(client.connectCalls).toBe(1);
    expect(client.attempts).toBe(2);
    expect(waiting).toHaveBeenCalledOnce();
    expect(lease.waitedMs).toBeGreaterThanOrEqual(10);

    await expect(lease.assertHeld()).resolves.toBeUndefined();
    client.held = false;
    await expect(lease.assertHeld()).rejects.toThrow(
      "signer advisory lock is no longer held",
    );

    await lease.release();
    await lease.release();
    expect(
      client.queries.filter((query) =>
        query.includes("pg_advisory_unlock"),
      ),
    ).toHaveLength(1);
    expect(client.endCalls).toBe(1);
    await expect(lease.assertHeld()).rejects.toThrow(
      "already been released",
    );
    vi.useRealTimers();
  });
});
