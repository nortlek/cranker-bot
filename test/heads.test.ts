import { describe, expect, it, vi } from "vitest";

import {
  LatestHeadSignal,
  retryTransientRead,
} from "../src/heads.js";

describe("LatestHeadSignal", () => {
  it("keeps only the newest observed head", () => {
    const signal = new LatestHeadSignal();
    signal.observe(10n);
    signal.observe(9n);
    signal.observe(12n);

    expect(signal.latestAfter(10n)).toBe(12n);
    expect(signal.latestAfter(12n)).toBeUndefined();
  });

  it("wakes immediately when a newer head arrives", async () => {
    const signal = new LatestHeadSignal();
    const waiting = signal.waitForNewer(10n, 10_000);

    signal.observe(11n);

    await expect(waiting).resolves.toBe(true);
  });

  it("reports a timeout for the liveness assertion", async () => {
    vi.useFakeTimers();
    const signal = new LatestHeadSignal();
    const waiting = signal.waitForNewer(10n, 250);

    await vi.advanceTimersByTimeAsync(250);

    await expect(waiting).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("closes outstanding waiters during shutdown", async () => {
    const signal = new LatestHeadSignal();
    const waiting = signal.waitForNewer(10n, 10_000);

    signal.close();

    await expect(waiting).resolves.toBe(false);
  });
});

describe("retryTransientRead", () => {
  it("retries only classified transient failures", async () => {
    vi.useFakeTimers();
    const transient = new Error("not ready");
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("ready");
    const result = retryTransientRead({
      read,
      shouldRetry: (error) => error === transient,
      maxAttempts: 4,
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({
      value: "ready",
      attempts: 3,
      waitedMs: 100,
    });
    vi.useRealTimers();
  });

  it("does not retry an unclassified failure", async () => {
    const terminal = new Error("terminal");
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(terminal);

    await expect(
      retryTransientRead({
        read,
        shouldRetry: () => false,
        maxAttempts: 4,
        retryDelayMs: 50,
      }),
    ).rejects.toBe(terminal);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
