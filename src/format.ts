import { formatEther, formatGwei } from "viem";

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
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, boolean | number | string> = {},
): void {
  const payload = {
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
