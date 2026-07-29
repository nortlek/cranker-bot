import {
  createPublicClient,
  fallback,
  formatEther,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { mapConcurrent } from "../src/concurrency.js";
import { loadConfig } from "../src/config.js";
import { bufferedGas } from "../src/economics.js";

const BEEFY_ETHEREUM_VAULTS_URL =
  "https://api.beefy.finance/vaults/ethereum";
const WETH = getAddress(
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
);
const REWARD_HAIRCUT_BPS = 9_500n;
const BPS = 10_000n;

const viewAbi = parseAbi([
  "function callReward() view returns(uint256)",
  "function paused() view returns(bool)",
  "function native() view returns(address)",
  "function lastHarvest() view returns(uint256)",
]);
const harvestRecipientAbi = parseAbi([
  "function harvest(address callFeeRecipient)",
]);
const harvestLegacyRecipientAbi = parseAbi([
  "function harvestWithCallFeeRecipient(address callFeeRecipient)",
]);
const harvestNoArgumentAbi = parseAbi(["function harvest()"]);

interface BeefyVault {
  readonly id: string;
  readonly status: string;
  readonly platformId: string;
  readonly strategy?: string;
}

type HarvestVariant =
  | "harvest_recipient"
  | "harvest_legacy_recipient"
  | "harvest_no_argument";

interface VariantEstimate {
  readonly variant: HarvestVariant;
  readonly gas: bigint;
}

function positiveIntegerEnv(name: string, fallbackValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallbackValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function estimateVariant(
  client: ReturnType<typeof createPublicClient>,
  strategy: Address,
  account: Address | ReturnType<typeof privateKeyToAccount>,
  recipient: Address,
  variant: HarvestVariant,
): Promise<VariantEstimate | undefined> {
  try {
    if (variant === "harvest_recipient") {
      const gas = await client.estimateContractGas({
        account,
        address: strategy,
        abi: harvestRecipientAbi,
        functionName: "harvest",
        args: [recipient],
      });
      return { variant, gas };
    }
    if (variant === "harvest_legacy_recipient") {
      const gas = await client.estimateContractGas({
        account,
        address: strategy,
        abi: harvestLegacyRecipientAbi,
        functionName: "harvestWithCallFeeRecipient",
        args: [recipient],
      });
      return { variant, gas };
    }
    const gas = await client.estimateContractGas({
      account,
      address: strategy,
      abi: harvestNoArgumentAbi,
      functionName: "harvest",
    });
    return { variant, gas };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const discoveryRpcUrls = (
    process.env.DISCOVERY_RPC_URLS ??
    process.env.DISCOVERY_RPC_URL ??
    config.rpcUrl
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (discoveryRpcUrls.length === 0) {
    throw new Error("At least one discovery RPC URL is required");
  }
  const discoveryConcurrency = positiveIntegerEnv(
    "DISCOVERY_CONCURRENCY",
    2,
  );
  const account =
    config.privateKey === undefined
      ? config.simulationAccount
      : privateKeyToAccount(config.privateKey);
  const recipient =
    typeof account === "string" ? account : account.address;
  const client = createPublicClient({
    chain: mainnet,
    transport: fallback(
      discoveryRpcUrls.map((url) =>
        http(url, {
          retryCount: 1,
          retryDelay: 500,
          timeout: 60_000,
        }),
      ),
      { rank: false },
    ),
  });

  const response = await fetch(BEEFY_ETHEREUM_VAULTS_URL, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Beefy vault API returned HTTP ${response.status}`);
  }
  const vaults = (await response.json()) as BeefyVault[];
  const active = vaults.flatMap((vault) => {
    if (vault.status !== "active" || vault.strategy === undefined) {
      return [];
    }
    try {
      return [{ ...vault, strategy: getAddress(vault.strategy) }];
    } catch {
      return [];
    }
  });

  const reads = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: active.flatMap((vault) => [
      {
        address: vault.strategy,
        abi: viewAbi,
        functionName: "callReward" as const,
      },
      {
        address: vault.strategy,
        abi: viewAbi,
        functionName: "paused" as const,
      },
      {
        address: vault.strategy,
        abi: viewAbi,
        functionName: "native" as const,
      },
      {
        address: vault.strategy,
        abi: viewAbi,
        functionName: "lastHarvest" as const,
      },
    ]),
  });
  const feeQuote = await client.estimateFeesPerGas({
    type: "eip1559",
  });
  const candidates = active.map((vault, index) => {
    const callReward = reads[index * 4];
    const paused = reads[index * 4 + 1];
    const native = reads[index * 4 + 2];
    const lastHarvest = reads[index * 4 + 3];
    return {
      ...vault,
      callReward:
        callReward?.status === "success"
          ? (callReward.result as bigint)
          : undefined,
      paused:
        paused?.status === "success"
          ? (paused.result as boolean)
          : undefined,
      native:
        native?.status === "success"
          ? (native.result as Address)
          : undefined,
      lastHarvest:
        lastHarvest?.status === "success"
          ? (lastHarvest.result as bigint)
          : undefined,
    };
  });

  const simulations = await mapConcurrent(
    candidates,
    discoveryConcurrency,
    async (candidate) => {
      const variants = (
        await Promise.all([
          estimateVariant(
            client,
            candidate.strategy,
            account,
            recipient,
            "harvest_recipient",
          ),
          estimateVariant(
            client,
            candidate.strategy,
            account,
            recipient,
            "harvest_legacy_recipient",
          ),
          estimateVariant(
            client,
            candidate.strategy,
            account,
            recipient,
            "harvest_no_argument",
          ),
        ])
      ).filter(
        (value): value is VariantEstimate => value !== undefined,
      );
      const selected =
        variants.find(
          (value) => value.variant === "harvest_recipient",
        ) ??
        variants.find(
          (value) =>
            value.variant === "harvest_legacy_recipient",
        ) ??
        variants.find(
          (value) => value.variant === "harvest_no_argument",
        );
      const gasLimit =
        selected === undefined
          ? undefined
          : bufferedGas(
              selected.gas,
              config.gasLimitMultiplierBps,
            );
      const rewardAfterHaircut =
        candidate.callReward === undefined
          ? undefined
          : (candidate.callReward * REWARD_HAIRCUT_BPS) / BPS;
      return {
        ...candidate,
        variants,
        selected,
        gasLimit,
        netEth:
          rewardAfterHaircut === undefined || gasLimit === undefined
            ? undefined
            : rewardAfterHaircut -
              gasLimit * feeQuote.maxFeePerGas,
      };
    },
  );

  const byNet = simulations
    .filter(
      (
        candidate,
      ): candidate is typeof candidate & {
        readonly netEth: bigint;
        readonly gasLimit: bigint;
        readonly selected: VariantEstimate;
        readonly callReward: bigint;
      } =>
        candidate.netEth !== undefined &&
        candidate.gasLimit !== undefined &&
        candidate.selected !== undefined &&
        candidate.callReward !== undefined &&
        candidate.native?.toLowerCase() === WETH.toLowerCase(),
    )
    .sort((left, right) =>
      left.netEth === right.netEth
        ? left.id.localeCompare(right.id)
        : left.netEth > right.netEth
          ? -1
          : 1,
    );

  const summarize = (candidate: (typeof byNet)[number]) => ({
    id: candidate.id,
    platform: candidate.platformId,
    strategy: candidate.strategy,
    variant: candidate.selected.variant,
    native: candidate.native,
    callRewardEth: formatEther(candidate.callReward),
    estimatedGas: candidate.selected.gas.toString(),
    gasLimit: candidate.gasLimit.toString(),
    netEthAfterRewardHaircut: formatEther(candidate.netEth),
    lastHarvest:
      candidate.lastHarvest === undefined
        ? undefined
        : candidate.lastHarvest.toString(),
  });

  console.log(
    JSON.stringify({
      event: "beefy_harvest_scan",
      activeStrategies: candidates.length,
      callRewardReadable: candidates.filter(
        (candidate) => candidate.callReward !== undefined,
      ).length,
      positiveCallReward: candidates.filter(
        (candidate) =>
          candidate.callReward !== undefined &&
          candidate.callReward > 0n,
      ).length,
      paused: candidates.filter(
        (candidate) => candidate.paused === true,
      ).length,
      nativeAssets: Object.fromEntries(
        [...new Set(
          candidates
            .map((candidate) => candidate.native)
            .filter(
              (native): native is Address => native !== undefined,
            ),
        )].map((native) => [
          native,
          candidates.filter(
            (candidate) =>
              candidate.native?.toLowerCase() ===
              native.toLowerCase(),
          ).length,
        ]),
      ),
      simulatableVariants: {
        harvestRecipient: simulations.filter((candidate) =>
          candidate.variants.some(
            (variant) =>
              variant.variant === "harvest_recipient",
          ),
        ).length,
        harvestLegacyRecipient: simulations.filter((candidate) =>
          candidate.variants.some(
            (variant) =>
              variant.variant === "harvest_legacy_recipient",
          ),
        ).length,
        harvestNoArgument: simulations.filter((candidate) =>
          candidate.variants.some(
            (variant) =>
              variant.variant === "harvest_no_argument",
          ),
        ).length,
      },
      rewardHaircutBps: REWARD_HAIRCUT_BPS.toString(),
      gasLimitMultiplierBps:
        config.gasLimitMultiplierBps.toString(),
      estimatedMaxFeeGwei: formatEther(
        feeQuote.maxFeePerGas * 10n ** 9n,
      ),
      discoveryRpcHosts: discoveryRpcUrls.map(
        (url) => new URL(url).hostname,
      ),
      profitable: byNet
        .filter((candidate) => candidate.netEth > 0n)
        .slice(0, 20)
        .map(summarize),
      positiveButUnprofitable: byNet
        .filter(
          (candidate) =>
            candidate.callReward > 0n &&
            candidate.netEth <= 0n,
        )
        .slice(0, 20)
        .map(summarize),
      notCurrentlySimulatable: simulations
        .filter((candidate) => candidate.variants.length === 0)
        .map((candidate) => ({
          id: candidate.id,
          platform: candidate.platformId,
          strategy: candidate.strategy,
          callRewardEth:
            candidate.callReward === undefined
              ? undefined
              : formatEther(candidate.callReward),
          paused: candidate.paused,
        })),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "beefy_harvest_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
