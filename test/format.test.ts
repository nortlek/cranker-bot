import { describe, expect, it } from "vitest";

import {
  errorFingerprint,
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

describe("errorFingerprint", () => {
  it("records only bounded error names and codes across causes", () => {
    const rpc = Object.assign(new Error("request details"), {
      name: "RpcRequestError",
      code: -32602,
      url: "https://secret.invalid/key",
    });
    const execution = Object.assign(
      new Error("execution details", { cause: rpc }),
      {
        name: "ContractFunctionExecutionError",
        code: "CALL_EXCEPTION",
      },
    );

    expect(errorFingerprint(execution)).toEqual({
      errorName: "ContractFunctionExecutionError",
      errorCode: "CALL_EXCEPTION",
      errorChain:
        "ContractFunctionExecutionError[CALL_EXCEPTION]>RpcRequestError[-32602]",
    });
    expect(
      JSON.stringify(errorFingerprint(execution)),
    ).not.toContain("secret");
  });

  it("handles non-errors and cyclic causes without throwing", () => {
    expect(errorFingerprint("failure")).toEqual({
      errorName: "NonError",
      errorChain: "NonError",
    });

    const cyclic = Object.assign(new Error("cycle"), {
      name: "CyclicError",
      cause: undefined as unknown,
    });
    cyclic.cause = cyclic;
    expect(errorFingerprint(cyclic).errorChain).toBe(
      "CyclicError>Cycle",
    );
  });
});
