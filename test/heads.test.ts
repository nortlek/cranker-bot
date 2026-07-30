import { describe, expect, it, vi } from "vitest";

import {
  LatestHeadSignal,
  parseNewHeadsPayload,
  readBeforeTargetBlock,
  retryTransientRead,
} from "../src/heads.js";

describe("parseNewHeadsPayload", () => {
  it("uses the raw subscription header without fetching the block", () => {
    expect(
      parseNewHeadsPayload({
        number: "0x1872f30",
        hash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        timestamp: "0x68d4a25f",
        baseFeePerGas: "0x59682f00",
        gasUsed: "0x1c9c380",
        gasLimit: "0x3938700",
        transactionsRoot:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
      }),
    ).toEqual({
      number: 25_636_656n,
      hash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      timestamp: 1_758_765_663n,
      baseFeePerGas: 1_500_000_000n,
      gasUsed: 30_000_000n,
      gasLimit: 60_000_000n,
    });
  });

  it("fails closed on an incomplete or malformed header", () => {
    expect(() =>
      parseNewHeadsPayload({
        number: "0x10",
        hash: "0x1234",
        timestamp: "0x20",
        baseFeePerGas: "0x30",
      }),
    ).toThrow("invalid hash");
    expect(() =>
      parseNewHeadsPayload({
        number: "0x10",
        hash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        baseFeePerGas: "0x30",
      }),
    ).toThrow("invalid timestamp");
    expect(() =>
      parseNewHeadsPayload({
        number: "0x10",
        hash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        timestamp: "0x20",
        baseFeePerGas: "0x30",
        gasLimit: "0x100",
      }),
    ).toThrow("invalid gasUsed");
  });
});

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

describe("readBeforeTargetBlock", () => {
  it("returns an exact-state result while the target is still future", async () => {
    const signal = new LatestHeadSignal();
    signal.observe(100n);
    await expect(
      readBeforeTargetBlock({
        headSignal: signal,
        targetBlock: 101n,
        timeoutMs: 1_000,
        read: async () => "ready",
      }),
    ).resolves.toEqual({ status: "ready", value: "ready" });
    signal.close();
  });

  it("rejects a gate after the target was already observed", async () => {
    const signal = new LatestHeadSignal();
    signal.observe(101n);
    await expect(
      readBeforeTargetBlock({
        headSignal: signal,
        targetBlock: 101n,
        timeoutMs: 1_000,
        read: async () => "stale",
      }),
    ).resolves.toEqual({
      status: "target_observed",
      observedBlock: 101n,
    });
    signal.close();
  });

  it("lets the subscribed target head preempt a stalled RPC gate", async () => {
    const signal = new LatestHeadSignal();
    signal.observe(100n);
    const stalled = new Promise<string>(() => {});
    const result = readBeforeTargetBlock({
      headSignal: signal,
      targetBlock: 101n,
      timeoutMs: 1_000,
      read: () => stalled,
    });
    signal.observe(101n);
    await expect(result).resolves.toEqual({
      status: "target_observed",
      observedBlock: 101n,
    });
    signal.close();
  });

  it("rechecks the head after an RPC gate resolves", async () => {
    const signal = new LatestHeadSignal();
    signal.observe(100n);
    const result = readBeforeTargetBlock({
      headSignal: signal,
      targetBlock: 101n,
      timeoutMs: 1_000,
      read: async () => {
        signal.observe(101n);
        return "stale";
      },
    });
    await expect(result).resolves.toEqual({
      status: "target_observed",
      observedBlock: 101n,
    });
    signal.close();
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
