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
  readonly blockPollMs: number;
  readonly confirmations: number;
  readonly maxTransactionsPerPass: number;
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
  const minProfitBps = integerEnv("MIN_PROFIT_BPS", 2_500, {
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
    minProfitWei: parseEther(process.env.MIN_PROFIT_ETH || "0.00005"),
    minProfitBps: BigInt(minProfitBps),
    gasLimitMultiplierBps: BigInt(gasLimitMultiplierBps),
    maxFeePerGas: parseGwei(
      process.env.MAX_FEE_PER_GAS_GWEI || "5",
    ),
    blockPollMs: integerEnv("BLOCK_POLL_MS", 2_000, {
      min: 250,
      max: 60_000,
    }),
    confirmations: integerEnv("CONFIRMATIONS", 1, { min: 1, max: 64 }),
    maxTransactionsPerPass: integerEnv(
      "MAX_TRANSACTIONS_PER_PASS",
      0,
      { min: 0, max: 1_000 },
    ),
  };
}
