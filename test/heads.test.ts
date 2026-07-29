import { describe, expect, it, vi } from "vitest";

import { LatestHeadSignal } from "../src/heads.js";

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
