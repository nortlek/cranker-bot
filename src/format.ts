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

export interface ErrorFingerprint {
  readonly errorName: string;
  readonly errorCode?: string;
  readonly errorChain: string;
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

function safeErrorName(error: object): string {
  try {
    const name = Reflect.get(error, "name");
    if (
      typeof name === "string" &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)
    ) {
      return name;
    }
  } catch {
    // A diagnostic must never replace the original failure.
  }
  return "UnknownError";
}

function safeErrorCode(error: object): string | undefined {
  try {
    const code = Reflect.get(error, "code");
    if (
      typeof code === "number" &&
      Number.isSafeInteger(code)
    ) {
      return String(code);
    }
    if (
      typeof code === "string" &&
      (/^-?[0-9]{1,10}$/.test(code) ||
        /^[A-Z][A-Z0-9_]{0,63}$/.test(code))
    ) {
      return code;
    }
  } catch {
    // Omit an unsafe or throwing code accessor.
  }
  return undefined;
}

function errorCause(error: object): unknown {
  try {
    return Reflect.get(error, "cause");
  } catch {
    return undefined;
  }
}

/**
 * Produces a secret-free structural fingerprint for durable error telemetry.
 * Messages, URLs, request bodies, and metadata are deliberately excluded.
 */
export function errorFingerprint(error: unknown): ErrorFingerprint {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null
  ) {
    return {
      errorName: "NonError",
      errorChain: "NonError",
    };
  }
  const seen = new Set<object>();
  const chain: string[] = [];
  let current: unknown = error;
  let outerName = "UnknownError";
  let outerCode: string | undefined;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      (typeof current !== "object" &&
        typeof current !== "function") ||
      current === null
    ) {
      break;
    }
    const item = current as object;
    if (seen.has(item)) {
      chain.push("Cycle");
      break;
    }
    seen.add(item);
    const name = safeErrorName(item);
    const code = safeErrorCode(item);
    if (depth === 0) {
      outerName = name;
      outerCode = code;
    }
    chain.push(code === undefined ? name : `${name}[${code}]`);
    current = errorCause(item);
  }
  return {
    errorName: outerName,
    ...(outerCode === undefined ? {} : { errorCode: outerCode }),
    errorChain: chain.join(">"),
  };
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
