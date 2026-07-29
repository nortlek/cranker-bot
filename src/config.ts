import "dotenv/config";

import {
  getAddress,
  parseEther,
  parseGwei,
  type Address,
  type Hex,
} from "viem";

import {
  FACTORY_ADDRESS,
  FWA_TOKEN_ADDRESS,
  LIVE_BID_ADAPTER_ADDRESS,
  POOL_ADDRESS,
  VAULT_FACTORY_ADDRESS,
} from "./constants.js";

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly discoveryRpcUrl: string;
  readonly submissionMode: "flashbots" | "public";
  readonly flashbotsRelayUrls: readonly string[];
  readonly flashbotsBuilders: readonly string[];
  readonly flashbotsAuthPrivateKey: Hex | undefined;
  readonly relayTimeoutMs: number;
  readonly builderBidBps: bigint;
  readonly poolBuilderBidBps: bigint;
  readonly poolPullBuilderBidBps: bigint;
  readonly poolFulfilledBuilderBidBps: bigint;
  readonly liveBidSweepBuilderBidBps: bigint;
  readonly liquityBuilderBidBps: bigint;
  readonly convexBuilderBidBps: bigint;
  readonly stakeDaoBuilderBidBps: bigint;
  readonly firmBuilderBidBps: bigint;
  readonly adaptiveBidding: boolean;
  readonly adaptiveBidStepBps: bigint;
  readonly adaptiveBidMaxBps: bigint;
  readonly adaptiveBidWinStreak: number;
  readonly adaptiveBidDecayBps: bigint;
  readonly adaptiveBidStatePath: string;
  readonly competitorTraceUrl: string;
  readonly competitorTraceTimeoutMs: number;
  readonly competitorTraceRetries: number;
  readonly competitorTraceRetryDelayMs: number;
  readonly discordWebhookUrl: string | undefined;
  readonly discordWebhookTimeoutMs: number;
  readonly databaseUrl: string | undefined;
  readonly telemetryBatchSize: number;
  readonly telemetryFlushMs: number;
  readonly telemetryMaxQueue: number;
  readonly factoryAddress: Address;
  readonly vaultFactoryAddress: Address;
  readonly expectedPoolAddress: Address;
  readonly expectedFwaTokenAddress: Address;
  readonly liveBidAdapterAddress: Address;
  readonly enablePoolLifecycle: boolean;
  readonly enableVaults: boolean;
  readonly enableBuyback: boolean;
  readonly enableLiveBidSweep: boolean;
  readonly enableLiquityLiquidations: boolean;
  readonly enableConvexEarmarks: boolean;
  readonly enableConvexKicks: boolean;
  readonly enableStakeDaoCurveHarvests: boolean;
  readonly enableFirmReplenishments: boolean;
  readonly poolBountyEstimateBps: bigint;
  readonly poolPullGasLimit: bigint;
  readonly poolSyncGasLimit: bigint;
  readonly poolSettleGasLimit: bigint;
  readonly fwaProcessGasLimit: bigint;
  readonly fwaProcessMaxCount: number;
  readonly buybackGasLimit: bigint;
  readonly liveBidSweepGasLimit: bigint;
  readonly liquityGasLimit: bigint;
  readonly liquityMaxTrovesPerBatch: number;
  readonly convexEarmarkGasLimit: bigint;
  readonly convexKickGasLimit: bigint;
  readonly stakeDaoHarvestGasLimit: bigint;
  readonly stakeDaoHarvestMaxBatchSize: number;
  readonly stakeDaoHarvestMaxCandidates: number;
  readonly stakeDaoHarvestRewardHaircutBps: bigint;
  readonly stakeDaoOracleMaxAgeSeconds: number;
  readonly stakeDaoDiscoveryBlockRange: number;
  readonly firmReplenishGasLimit: bigint;
  readonly firmMaxCandidates: number;
  readonly firmRewardHaircutBps: bigint;
  readonly firmDolaOracleMaxAgeSeconds: number;
  readonly firmEthOracleMaxAgeSeconds: number;
  readonly firmDiscoveryBlockRange: number;
  readonly firmBorrowerLookbackBlocks: number;
  readonly dryRun: boolean;
  readonly runOnce: boolean;
  readonly privateKey: Hex | undefined;
  readonly simulationAccount: Address;
  readonly minProfitWei: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly maxFeePerGas: bigint;
  readonly minPriorityFeePerGas: bigint;
  readonly poolMinPriorityFeePerGas: bigint;
  readonly liveBidSweepMinPriorityFeePerGas: bigint;
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
    process.env.FLASHBOTS_RELAY_URLS ||
    "https://relay.flashbots.net,https://rpc.quasar.win,https://rpc.titanbuilder.xyz,https://rpc.beaverbuild.org"
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

function discordWebhookUrlEnv(): string | undefined {
  const raw = process.env.DISCORD_WEBHOOK_URL;
  if (raw === undefined || raw === "") return undefined;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "discord.com" &&
      url.hostname !== "discordapp.com") ||
    !/^\/api\/webhooks\/[^/]+\/[^/]+$/.test(url.pathname)
  ) {
    throw new Error(
      "DISCORD_WEBHOOK_URL must be a Discord HTTPS webhook URL",
    );
  }
  return raw;
}

function databaseUrlEnv(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (raw === undefined || raw === "") return undefined;
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    throw new Error(
      "DATABASE_URL must be a PostgreSQL connection URL",
    );
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL must be a PostgreSQL connection URL",
    );
  }
  return raw;
}

export function loadConfig(): KeeperConfig {
  const rpcUrl =
    process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
  const discoveryRpcUrl =
    process.env.DISCOVERY_RPC_URL ||
    process.env.DISCOVERY_RPC_URLS?.split(",")[0]?.trim() ||
    rpcUrl;
  const submissionMode = submissionModeEnv();
  const enableStakeDaoCurveHarvests = booleanEnv(
    "ENABLE_STAKEDAO_CURVE_HARVESTS",
    false,
  );
  const enableFirmReplenishments = booleanEnv(
    "ENABLE_FIRM_REPLENISHMENTS",
    false,
  );
  if (
    (enableStakeDaoCurveHarvests ||
      enableFirmReplenishments) &&
    submissionMode !== "flashbots"
  ) {
    throw new Error(
      `${
        enableFirmReplenishments
          ? "ENABLE_FIRM_REPLENISHMENTS"
          : "ENABLE_STAKEDAO_CURVE_HARVESTS"
      } requires SUBMISSION_MODE=flashbots`,
    );
  }
  const builderBidBps = integerEnv("BUILDER_BID_BPS", 8_100, {
    min: 0,
    max: 10_000,
  });
  const poolBuilderBidBps = integerEnv(
    "POOL_BUILDER_BID_BPS",
    1_000,
    {
      min: 0,
      max: 10_000,
    },
  );
  const poolPullBuilderBidBps = integerEnv(
    "POOL_PULL_BUILDER_BID_BPS",
    850,
    {
      min: 0,
      max: 10_000,
    },
  );
  const poolFulfilledBuilderBidBps = integerEnv(
    "POOL_FULFILLED_BUILDER_BID_BPS",
    300,
    {
      min: 0,
      max: 10_000,
    },
  );
  const liveBidSweepBuilderBidBps = integerEnv(
    "LIVE_BID_SWEEP_BUILDER_BID_BPS",
    100,
    {
      min: 0,
      max: 10_000,
    },
  );
  const liquityBuilderBidBps = integerEnv(
    "LIQUITY_BUILDER_BID_BPS",
    8_100,
    {
      min: 0,
      max: 10_000,
    },
  );
  const convexBuilderBidBps = integerEnv(
    "CONVEX_BUILDER_BID_BPS",
    1_000,
    {
      min: 0,
      max: 10_000,
    },
  );
  const stakeDaoBuilderBidBps = integerEnv(
    "STAKEDAO_BUILDER_BID_BPS",
    1_000,
    {
      min: 0,
      max: 10_000,
    },
  );
  const firmBuilderBidBps = integerEnv(
    "FIRM_BUILDER_BID_BPS",
    1_000,
    {
      min: 0,
      max: 10_000,
    },
  );
  const adaptiveBidMaxBps = integerEnv(
    "ADAPTIVE_BID_MAX_BPS",
    9_900,
    { min: 0, max: 10_000 },
  );
  if (adaptiveBidMaxBps < builderBidBps) {
    throw new Error(
      "ADAPTIVE_BID_MAX_BPS must be >= BUILDER_BID_BPS",
    );
  }
  const competitorTraceUrl =
    process.env.COMPETITOR_TRACE_URL ||
    "https://api.routescan.io/v2/network/mainnet/evm/1/internal-operations";
  if (new URL(competitorTraceUrl).protocol !== "https:") {
    throw new Error("COMPETITOR_TRACE_URL must use HTTPS");
  }
  const gasLimitMultiplierBps = integerEnv(
    "GAS_LIMIT_MULTIPLIER_BPS",
    12_000,
    { min: 10_000, max: 30_000 },
  );
  const telemetryBatchSize = integerEnv(
    "TELEMETRY_BATCH_SIZE",
    50,
    { min: 1, max: 500 },
  );
  const telemetryMaxQueue = integerEnv(
    "TELEMETRY_MAX_QUEUE",
    10_000,
    { min: telemetryBatchSize, max: 1_000_000 },
  );

  return {
    rpcUrl,
    discoveryRpcUrl,
    submissionMode,
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
    poolBuilderBidBps: BigInt(poolBuilderBidBps),
    poolPullBuilderBidBps: BigInt(poolPullBuilderBidBps),
    poolFulfilledBuilderBidBps:
      BigInt(poolFulfilledBuilderBidBps),
    liveBidSweepBuilderBidBps:
      BigInt(liveBidSweepBuilderBidBps),
    liquityBuilderBidBps: BigInt(liquityBuilderBidBps),
    convexBuilderBidBps: BigInt(convexBuilderBidBps),
    stakeDaoBuilderBidBps: BigInt(stakeDaoBuilderBidBps),
    firmBuilderBidBps: BigInt(firmBuilderBidBps),
    adaptiveBidding: booleanEnv("ADAPTIVE_BIDDING", true),
    adaptiveBidStepBps: BigInt(
      integerEnv("ADAPTIVE_BID_STEP_BPS", 25, {
        min: 1,
        max: 1_000,
      }),
    ),
    adaptiveBidMaxBps: BigInt(adaptiveBidMaxBps),
    adaptiveBidWinStreak: integerEnv(
      "ADAPTIVE_BID_WIN_STREAK",
      3,
      { min: 1, max: 100 },
    ),
    adaptiveBidDecayBps: BigInt(
      integerEnv("ADAPTIVE_BID_DECAY_BPS", 10, {
        min: 1,
        max: 1_000,
      }),
    ),
    adaptiveBidStatePath:
      process.env.ADAPTIVE_BID_STATE_PATH ||
      ".keeper-bid-state.json",
    competitorTraceUrl,
    competitorTraceTimeoutMs: integerEnv(
      "COMPETITOR_TRACE_TIMEOUT_MS",
      5_000,
      { min: 1_000, max: 30_000 },
    ),
    competitorTraceRetries: integerEnv(
      "COMPETITOR_TRACE_RETRIES",
      5,
      { min: 1, max: 20 },
    ),
    competitorTraceRetryDelayMs: integerEnv(
      "COMPETITOR_TRACE_RETRY_DELAY_MS",
      1_000,
      { min: 100, max: 10_000 },
    ),
    discordWebhookUrl: discordWebhookUrlEnv(),
    discordWebhookTimeoutMs: integerEnv(
      "DISCORD_WEBHOOK_TIMEOUT_MS",
      5_000,
      { min: 1_000, max: 30_000 },
    ),
    databaseUrl: databaseUrlEnv(),
    telemetryBatchSize,
    telemetryFlushMs: integerEnv(
      "TELEMETRY_FLUSH_MS",
      250,
      { min: 10, max: 60_000 },
    ),
    telemetryMaxQueue,
    factoryAddress: getAddress(
      process.env.FACTORY_ADDRESS || FACTORY_ADDRESS,
    ),
    vaultFactoryAddress: getAddress(
      process.env.VAULT_FACTORY_ADDRESS ||
        VAULT_FACTORY_ADDRESS,
    ),
    expectedPoolAddress: getAddress(
      process.env.EXPECTED_POOL_ADDRESS || POOL_ADDRESS,
    ),
    expectedFwaTokenAddress: getAddress(
      process.env.EXPECTED_FWA_TOKEN_ADDRESS ||
        FWA_TOKEN_ADDRESS,
    ),
    liveBidAdapterAddress: getAddress(
      process.env.LIVE_BID_ADAPTER_ADDRESS ||
        LIVE_BID_ADAPTER_ADDRESS,
    ),
    enablePoolLifecycle: booleanEnv("ENABLE_POOL_LIFECYCLE", true),
    enableVaults: booleanEnv("ENABLE_VAULTS", true),
    enableBuyback: booleanEnv("ENABLE_BUYBACK", true),
    enableLiveBidSweep: booleanEnv(
      "ENABLE_LIVE_BID_SWEEP",
      true,
    ),
    enableLiquityLiquidations: booleanEnv(
      "ENABLE_LIQUITY_LIQUIDATIONS",
      true,
    ),
    enableConvexEarmarks: booleanEnv(
      "ENABLE_CONVEX_EARMARKS",
      true,
    ),
    enableConvexKicks: booleanEnv("ENABLE_CONVEX_KICKS", true),
    enableStakeDaoCurveHarvests,
    enableFirmReplenishments,
    poolBountyEstimateBps: BigInt(
      integerEnv("POOL_BOUNTY_ESTIMATE_BPS", 9_000, {
        min: 0,
        max: 10_000,
      }),
    ),
    poolPullGasLimit: BigInt(
      integerEnv("POOL_PULL_GAS_LIMIT", 500_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    poolSyncGasLimit: BigInt(
      integerEnv("POOL_SYNC_GAS_LIMIT", 700_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    poolSettleGasLimit: BigInt(
      integerEnv("POOL_SETTLE_GAS_LIMIT", 700_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    fwaProcessGasLimit: BigInt(
      integerEnv("FWA_PROCESS_GAS_LIMIT", 3_000_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    fwaProcessMaxCount: integerEnv(
      "FWA_PROCESS_MAX_COUNT",
      5,
      { min: 1, max: 50 },
    ),
    buybackGasLimit: BigInt(
      integerEnv("BUYBACK_GAS_LIMIT", 700_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    liveBidSweepGasLimit: BigInt(
      integerEnv("LIVE_BID_SWEEP_GAS_LIMIT", 250_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    liquityGasLimit: BigInt(
      integerEnv("LIQUITY_GAS_LIMIT", 15_000_000, {
        min: 21_000,
        max: 16_777_216,
      }),
    ),
    liquityMaxTrovesPerBatch: integerEnv(
      "LIQUITY_MAX_TROVES_PER_BATCH",
      25,
      {
        min: 1,
        max: 100,
      },
    ),
    convexEarmarkGasLimit: BigInt(
      integerEnv("CONVEX_EARMARK_GAS_LIMIT", 1_500_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    convexKickGasLimit: BigInt(
      integerEnv("CONVEX_KICK_GAS_LIMIT", 500_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    stakeDaoHarvestGasLimit: BigInt(
      integerEnv("STAKEDAO_HARVEST_GAS_LIMIT", 5_000_000, {
        min: 21_000,
        max: 16_777_216,
      }),
    ),
    stakeDaoHarvestMaxBatchSize: integerEnv(
      "STAKEDAO_HARVEST_MAX_BATCH_SIZE",
      12,
      { min: 1, max: 50 },
    ),
    stakeDaoHarvestMaxCandidates: integerEnv(
      "STAKEDAO_HARVEST_MAX_CANDIDATES",
      24,
      { min: 1, max: 250 },
    ),
    stakeDaoHarvestRewardHaircutBps: BigInt(
      integerEnv("STAKEDAO_HARVEST_REWARD_HAIRCUT_BPS", 9_500, {
        min: 0,
        max: 10_000,
      }),
    ),
    stakeDaoOracleMaxAgeSeconds: integerEnv(
      "STAKEDAO_ORACLE_MAX_AGE_SECONDS",
      86_400,
      { min: 60, max: 604_800 },
    ),
    stakeDaoDiscoveryBlockRange: integerEnv(
      "STAKEDAO_DISCOVERY_BLOCK_RANGE",
      100_000,
      { min: 1_000, max: 1_000_000 },
    ),
    firmReplenishGasLimit: BigInt(
      integerEnv("FIRM_REPLENISH_GAS_LIMIT", 400_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    firmMaxCandidates: integerEnv(
      "FIRM_MAX_CANDIDATES",
      64,
      { min: 1, max: 1_000 },
    ),
    firmRewardHaircutBps: BigInt(
      integerEnv("FIRM_REWARD_HAIRCUT_BPS", 9_500, {
        min: 0,
        max: 10_000,
      }),
    ),
    firmDolaOracleMaxAgeSeconds: integerEnv(
      "FIRM_DOLA_ORACLE_MAX_AGE_SECONDS",
      90_000,
      { min: 60, max: 604_800 },
    ),
    firmEthOracleMaxAgeSeconds: integerEnv(
      "FIRM_ETH_ORACLE_MAX_AGE_SECONDS",
      7_200,
      { min: 60, max: 86_400 },
    ),
    firmDiscoveryBlockRange: integerEnv(
      "FIRM_DISCOVERY_BLOCK_RANGE",
      100_000,
      { min: 1_000, max: 1_000_000 },
    ),
    firmBorrowerLookbackBlocks: integerEnv(
      "FIRM_BORROWER_LOOKBACK_BLOCKS",
      100_000,
      { min: 1_000, max: 5_000_000 },
    ),
    dryRun: booleanEnv("DRY_RUN", true),
    runOnce: booleanEnv("RUN_ONCE", false),
    privateKey: privateKeyEnv(),
    simulationAccount: getAddress(
      process.env.SIMULATION_ACCOUNT ||
        "0x000000000000000000000000000000000000dEaD",
    ),
    minProfitWei: parseEther(process.env.MIN_PROFIT_ETH || "0"),
    gasLimitMultiplierBps: BigInt(gasLimitMultiplierBps),
    maxFeePerGas: parseGwei(
      process.env.MAX_FEE_PER_GAS_GWEI || "5",
    ),
    minPriorityFeePerGas: parseGwei(
      process.env.MIN_PRIORITY_FEE_GWEI || "0.1",
    ),
    poolMinPriorityFeePerGas: parseGwei(
      process.env.POOL_MIN_PRIORITY_FEE_GWEI || "0",
    ),
    liveBidSweepMinPriorityFeePerGas: parseGwei(
      process.env.LIVE_BID_SWEEP_MIN_PRIORITY_FEE_GWEI || "0",
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
