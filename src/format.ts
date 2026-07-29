import { AsyncLocalStorage } from "node:async_hooks";

import { formatEther, formatGwei } from "viem";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFieldValue = boolean | number | string;

export interface LogEntry {
  readonly time: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly [field: string]: LogFieldValue;
}

export type LogSink = (entry: LogEntry) => void;

let logSink: LogSink | undefined;
const logContext =
  new AsyncLocalStorage<Record<string, LogFieldValue>>();

export function setLogSink(sink: LogSink | undefined): void {
  logSink = sink;
}

export function withLogContext<T>(
  fields: Record<string, LogFieldValue>,
  callback: () => T,
): T {
  return logContext.run(
    {
      ...(logContext.getStore() ?? {}),
      ...fields,
    },
    callback,
  );
}

export function eth(value: bigint): string {
  return `${formatEther(value)} ETH`;
}

export function gwei(value: bigint): string {
  return `${formatGwei(value)} gwei`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n", 1)[0] ?? error.name;
  return String(error);
}

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, LogFieldValue> = {},
): void {
  const payload: LogEntry = {
    time: new Date().toISOString(),
    level,
    event,
    ...(logContext.getStore() ?? {}),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  try {
    logSink?.(payload);
  } catch (error) {
    console.warn(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "warn",
        event: "log_sink_failed",
        reason: errorMessage(error),
      }),
    );
  }
}
