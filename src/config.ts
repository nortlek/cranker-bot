import "dotenv/config";

import {
  getAddress,
  parseEther,
  parseGwei,
  type Address,
  type Hex,
} from "viem";

import { FACTORY_ADDRESS, POOL_ADDRESS } from "./constants.js";

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly submissionMode: "flashbots" | "public";
  readonly flashbotsRelayUrls: readonly string[];
  readonly flashbotsBuilders: readonly string[];
  readonly flashbotsAuthPrivateKey: Hex | undefined;
  readonly relayTimeoutMs: number;
  readonly builderBidBps: bigint;
  readonly factoryAddress: Address;
  readonly expectedPoolAddress: Address;
  readonly dryRun: boolean;
  readonly runOnce: boolean;
  readonly privateKey: Hex | undefined;
  readonly simulationAccount: Address;
  readonly minProfitWei: bigint;
  readonly minProfitBps: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly maxFeePerGas: bigint;
  readonly minPriorityFeePerGas: bigint;
  readonly simulationConcurrency: number;
  readonly blockPollMs: number;
  readonly confirmations: number;
  readonly receiptTimeoutMs: number;
  readonly maxTransactionsPerPass: number;
}

function submissionModeEnv(): "flashbots" | "public" {
  const value = process.env.SUBMISSION_MODE || "flashbots";
  if (value === "flashbots" || value === "public") return value;
  throw new Error('SUBMISSION_MODE must be "flashbots" or "public"');
}

function relayUrlsEnv(): readonly string[] {
  const values = (
    process.env.FLASHBOTS_RELAY_URLS || "https://relay.flashbots.net"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error("FLASHBOTS_RELAY_URLS must contain at least one URL");
  }
  for (const value of values) {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("Flashbots relay URLs must use HTTPS");
    }
  }
  return values;
}

function flashbotsBuildersEnv(): readonly string[] {
  return (
    process.env.FLASHBOTS_BUILDERS ||
    "flashbots,builder0x69,beaverbuild.org,Titan,rsync"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalPrivateKeyEnv(name: string): Hex | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex string`);
  }
  return raw as Hex;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function integerEnv(
  name: string,
  fallback: number,
  options: { min: number; max?: number },
): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < options.min ||
    (options.max !== undefined && parsed > options.max)
  ) {
    const max = options.max === undefined ? "" : ` and <= ${options.max}`;
    throw new Error(`${name} must be an integer >= ${options.min}${max}`);
  }
  return parsed;
}

function privateKeyEnv(): Hex | undefined {
  const raw = process.env.PRIVATE_KEY;
  if (raw === undefined || raw === "") return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  }
  return raw as Hex;
}

export function loadConfig(): KeeperConfig {
  const minProfitBps = integerEnv("MIN_PROFIT_BPS", 500, {
    min: 0,
    max: 10_000,
  });
  const builderBidBps = integerEnv("BUILDER_BID_BPS", 8_100, {
    min: 0,
    max: 10_000,
  });
  const gasLimitMultiplierBps = integerEnv(
    "GAS_LIMIT_MULTIPLIER_BPS",
    12_000,
    { min: 10_000, max: 30_000 },
  );

  return {
    rpcUrl: process.env.RPC_URL || "https://ethereum-rpc.publicnode.com",
    submissionMode: submissionModeEnv(),
    flashbotsRelayUrls: relayUrlsEnv(),
    flashbotsBuilders: flashbotsBuildersEnv(),
    flashbotsAuthPrivateKey: optionalPrivateKeyEnv(
      "FLASHBOTS_AUTH_PRIVATE_KEY",
    ),
    relayTimeoutMs: integerEnv("RELAY_TIMEOUT_MS", 5_000, {
      min: 1_000,
      max: 30_000,
    }),
    builderBidBps: BigInt(builderBidBps),
    factoryAddress: getAddress(
      process.env.FACTORY_ADDRESS || FACTORY_ADDRESS,
    ),
    expectedPoolAddress: getAddress(
      process.env.EXPECTED_POOL_ADDRESS || POOL_ADDRESS,
    ),
    dryRun: booleanEnv("DRY_RUN", true),
    runOnce: booleanEnv("RUN_ONCE", false),
    privateKey: privateKeyEnv(),
    simulationAccount: getAddress(
      process.env.SIMULATION_ACCOUNT ||
        "0x000000000000000000000000000000000000dEaD",
    ),
    minProfitWei: parseEther(process.env.MIN_PROFIT_ETH || "0.00001"),
    minProfitBps: BigInt(minProfitBps),
    gasLimitMultiplierBps: BigInt(gasLimitMultiplierBps),
    maxFeePerGas: parseGwei(
      process.env.MAX_FEE_PER_GAS_GWEI || "5",
    ),
    minPriorityFeePerGas: parseGwei(
      process.env.MIN_PRIORITY_FEE_GWEI || "0.1",
    ),
    simulationConcurrency: integerEnv("SIMULATION_CONCURRENCY", 8, {
      min: 1,
      max: 64,
    }),
    blockPollMs: integerEnv("BLOCK_POLL_MS", 250, {
      min: 100,
      max: 60_000,
    }),
    confirmations: integerEnv("CONFIRMATIONS", 1, { min: 1, max: 64 }),
    receiptTimeoutMs: integerEnv("RECEIPT_TIMEOUT_MS", 180_000, {
      min: 10_000,
      max: 1_800_000,
    }),
    maxTransactionsPerPass: integerEnv(
      "MAX_TRANSACTIONS_PER_PASS",
      0,
      { min: 0, max: 1_000 },
    ),
  };
}
