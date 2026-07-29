import { describe, expect, it } from "vitest";

import {
  log,
  setLogSink,
  type LogEntry,
  withLogContext,
} from "../src/format.js";

describe("withLogContext", () => {
  it("correlates asynchronous logs without leaking across passes", async () => {
    const entries: LogEntry[] = [];
    setLogSink((entry) => entries.push(entry));
    try {
      await Promise.all([
        withLogContext(
          { passId: "pass-a", observedBlock: "1" },
          async () => {
            await Promise.resolve();
            log("info", "test_event", { value: "a" });
          },
        ),
        withLogContext(
          { passId: "pass-b", observedBlock: "2" },
          async () => {
            await Promise.resolve();
            log("info", "test_event", { value: "b" });
          },
        ),
      ]);
    } finally {
      setLogSink(undefined);
    }

    expect(
      entries.map(({ passId, observedBlock, value }) => ({
        passId,
        observedBlock,
        value,
      })),
    ).toEqual(
      expect.arrayContaining([
        { passId: "pass-a", observedBlock: "1", value: "a" },
        { passId: "pass-b", observedBlock: "2", value: "b" },
      ]),
    );
  });
});
