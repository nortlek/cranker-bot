import {
  createPublicClient,
  fallback,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { mapConcurrent } from "../src/concurrency.js";
import { loadConfig } from "../src/config.js";
import { bufferedGas } from "../src/economics.js";

const AURA_BOOSTER = getAddress(
  "0xA57b8d98dAE62B26Ec3bcC4a365338157060B234",
);
const BAL_USD_FEED = getAddress(
  "0xd10aBbC76679a20055E167BB80A24ac851b37056",
);
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const DEFAULT_DISCOVERY_RPC_URLS = [
  "https://eth-mainnet.public.blastapi.io",
  "https://mainnet.gateway.tenderly.co",
  "https://rpc.mevblocker.io",
] as const;

const boosterAbi = parseAbi([
  "function poolLength() view returns(uint256)",
  "function poolInfo(uint256) view returns(address lptoken,address token,address gauge,address crvRewards,address stash,bool shutdown)",
  "function staker() view returns(address)",
  "function crv() view returns(address)",
  "function isShutdown() view returns(bool)",
  "function FEE_DENOMINATOR() view returns(uint256)",
  "function earmarkIncentive() view returns(uint256)",
  "function earmarkRewards(uint256) returns(bool)",
]);
const gaugeAbi = parseAbi([
  "function claimable_tokens(address) returns(uint256)",
]);
const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

function positiveIntegerEnv(name: string, fallbackValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallbackValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const discoveryRpcUrls = (
    process.env.DISCOVERY_RPC_URLS ??
    process.env.DISCOVERY_RPC_URL ??
    DEFAULT_DISCOVERY_RPC_URLS.join(",")
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
  const [
    poolLength,
    staker,
    rewardToken,
    systemShutdown,
    feeDenominator,
    incentive,
    balRound,
    ethRound,
    fees,
  ] = await Promise.all([
    client.readContract({
      address: AURA_BOOSTER,
      abi: boosterAbi,
      functionName: "poolLength",
    }),
    client.readContract({
      address: AURA_BOOSTER,
      abi: boosterAbi,
      functionName: "staker",
    }),
    client.readContract({
      address: AURA_BOOSTER,
      abi: boosterAbi,
      functionName: "crv",
    }),
    client.readContract({
      address: AURA_BOOSTER,
      abi: boosterAbi,
      functionName: "isShutdown",
    }),
    client.readContract({
      address: AURA_BOOSTER,
      abi: boosterAbi,
      functionName: "FEE_DENOMINATOR",
    }),
    client.readContract({
      address: AURA_BOOSTER,
      abi: boosterAbi,
      functionName: "earmarkIncentive",
    }),
    client.readContract({
      address: BAL_USD_FEED,
      abi: chainlinkAbi,
      functionName: "latestRoundData",
    }),
    client.readContract({
      address: ETH_USD_FEED,
      abi: chainlinkAbi,
      functionName: "latestRoundData",
    }),
    client.estimateFeesPerGas({ type: "eip1559" }),
  ]);
  if (balRound[1] <= 0n || ethRound[1] <= 0n) {
    throw new Error("Chainlink returned a non-positive price");
  }
  if (poolLength > 2_000n) {
    throw new Error(`Aura pool count ${poolLength} exceeds safety limit`);
  }
  if (feeDenominator === 0n) {
    throw new Error("Aura fee denominator is zero");
  }
  const poolResults = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: Array.from({ length: Number(poolLength) }, (_, pid) => ({
      address: AURA_BOOSTER,
      abi: boosterAbi,
      functionName: "poolInfo" as const,
      args: [BigInt(pid)] as const,
    })),
  });
  const pools = poolResults.flatMap((result, pid) =>
    result.status === "success" && !result.result[5]
      ? [{ pid, gauge: result.result[2] }]
      : [],
  );
  const claimableResults = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: pools.map((pool) => ({
      address: pool.gauge,
      abi: gaugeAbi,
      functionName: "claimable_tokens" as const,
      args: [staker] as const,
    })),
  });
  const candidates = pools.flatMap((pool, index) => {
    const result = claimableResults[index];
    if (result?.status !== "success" || result.result === 0n) return [];
    const callerBal = (result.result * incentive) / feeDenominator;
    // Both feeds use 8 decimals. The 5% haircut covers price movement and
    // the cost of exiting the BAL caller reward.
    const rewardEthEquivalent =
      (callerBal * balRound[1] * 9_500n) /
      ethRound[1] /
      10_000n;
    return [
      {
        ...pool,
        pendingBal: result.result,
        callerBal,
        rewardEthEquivalent,
      },
    ];
  });
  const estimates = await mapConcurrent(
    candidates,
    discoveryConcurrency,
    async (candidate) => {
      try {
        const estimatedGas = await client.estimateContractGas({
          account,
          address: AURA_BOOSTER,
          abi: boosterAbi,
          functionName: "earmarkRewards",
          args: [BigInt(candidate.pid)],
        });
        const gasLimit = bufferedGas(
          estimatedGas,
          config.gasLimitMultiplierBps,
        );
        return {
          ...candidate,
          estimatedGas,
          gasLimit,
          netEthEquivalent:
            candidate.rewardEthEquivalent -
            gasLimit * fees.maxFeePerGas,
        };
      } catch {
        return undefined;
      }
    },
  );
  const viable = estimates
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((left, right) =>
      left.netEthEquivalent === right.netEthEquivalent
        ? left.pid - right.pid
        : left.netEthEquivalent > right.netEthEquivalent
          ? -1
          : 1,
    );

  console.log(
    JSON.stringify({
      event: "aura_earmark_scan",
      booster: AURA_BOOSTER,
      rewardToken,
      systemShutdown,
      pools: poolLength.toString(),
      activePools: pools.length,
      pricedCandidates: candidates.length,
      simulatable: viable.length,
      incentive: incentive.toString(),
      feeDenominator: feeDenominator.toString(),
      balUsd: formatEther(balRound[1] * 10n ** 10n),
      ethUsd: formatEther(ethRound[1] * 10n ** 10n),
      estimatedMaxFeeGwei: formatEther(
        fees.maxFeePerGas * 10n ** 9n,
      ),
      discoveryRpcHosts: discoveryRpcUrls.map(
        (url) => new URL(url).hostname,
      ),
      profitable: viable
        .filter((candidate) => candidate.netEthEquivalent > 0n)
        .slice(0, 20)
        .map((candidate) => ({
          pid: candidate.pid,
          gauge: candidate.gauge,
          pendingBal: formatEther(candidate.pendingBal),
          callerBal: formatEther(candidate.callerBal),
          rewardEthEquivalent: formatEther(
            candidate.rewardEthEquivalent,
          ),
          estimatedGas: candidate.estimatedGas.toString(),
          gasLimit: candidate.gasLimit.toString(),
          netEthEquivalent: formatEther(
            candidate.netEthEquivalent,
          ),
        })),
      bestUnprofitable: viable
        .filter((candidate) => candidate.netEthEquivalent <= 0n)
        .slice(0, 5)
        .map((candidate) => ({
          pid: candidate.pid,
          callerBal: formatEther(candidate.callerBal),
          gasLimit: candidate.gasLimit.toString(),
          netEthEquivalent: formatEther(
            candidate.netEthEquivalent,
          ),
        })),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "aura_earmark_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
