import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { mapConcurrent } from "../src/concurrency.js";
import { loadConfig } from "../src/config.js";

const BOOSTER = getAddress(
  "0xF403C135812408BFbE8713b5A23a04b3D48AAE31",
);
const CRV = getAddress(
  "0xD533a949740bb3306d119CC777fa900bA034cd52",
);
const CRV_USD_FEED = getAddress(
  "0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f",
);
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);

const boosterAbi = parseAbi([
  "function poolLength() view returns(uint256)",
  "function poolInfo(uint256) view returns(address lptoken,address token,address gauge,address crvRewards,address stash,bool shutdown)",
  "function staker() view returns(address)",
  "function earmarkIncentive() view returns(uint256)",
  "function earmarkRewards(uint256) returns(bool)",
]);
const gaugeAbi = parseAbi([
  "function claimable_tokens(address) returns(uint256)",
]);
const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

async function main(): Promise<void> {
  const config = loadConfig();
  const account =
    config.privateKey === undefined
      ? config.simulationAccount
      : privateKeyToAccount(config.privateKey);
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 30_000,
    }),
  });
  const [poolLength, staker, incentive, crvRound, ethRound, fees] =
    await Promise.all([
      client.readContract({
        address: BOOSTER,
        abi: boosterAbi,
        functionName: "poolLength",
      }),
      client.readContract({
        address: BOOSTER,
        abi: boosterAbi,
        functionName: "staker",
      }),
      client.readContract({
        address: BOOSTER,
        abi: boosterAbi,
        functionName: "earmarkIncentive",
      }),
      client.readContract({
        address: CRV_USD_FEED,
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
  if (crvRound[1] <= 0n || ethRound[1] <= 0n) {
    throw new Error("Chainlink returned a non-positive price");
  }
  if (poolLength > 2_000n) {
    throw new Error(`Convex pool count ${poolLength} exceeds safety limit`);
  }
  const poolResults = await client.multicall({
    allowFailure: true,
    contracts: Array.from({ length: Number(poolLength) }, (_, pid) => ({
      address: BOOSTER,
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
    const callerCrv = (result.result * incentive) / 10_000n;
    const rewardEthEquivalent =
      (callerCrv * crvRound[1]) / ethRound[1];
    return [
      {
        ...pool,
        pendingCrv: result.result,
        callerCrv,
        rewardEthEquivalent,
      },
    ];
  });
  const estimates = await mapConcurrent(
    candidates,
    config.simulationConcurrency,
    async (candidate) => {
      try {
        const gas = await client.estimateContractGas({
          account,
          address: BOOSTER,
          abi: boosterAbi,
          functionName: "earmarkRewards",
          args: [BigInt(candidate.pid)],
        });
        return {
          ...candidate,
          gas,
          netEthEquivalent:
            candidate.rewardEthEquivalent - gas * fees.maxFeePerGas,
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
      event: "convex_earmark_scan",
      booster: BOOSTER,
      crv: CRV,
      pools: poolLength.toString(),
      activePools: pools.length,
      pricedCandidates: candidates.length,
      incentiveBps: incentive.toString(),
      crvUsd: formatEther(crvRound[1] * 10n ** 10n),
      ethUsd: formatEther(ethRound[1] * 10n ** 10n),
      estimatedMaxFeeGwei: formatEther(
        fees.maxFeePerGas * 10n ** 9n,
      ),
      profitable: viable
        .filter((candidate) => candidate.netEthEquivalent > 0n)
        .slice(0, 20)
        .map((candidate) => ({
          pid: candidate.pid,
          gauge: candidate.gauge,
          pendingCrv: formatEther(candidate.pendingCrv),
          callerCrv: formatEther(candidate.callerCrv),
          rewardEthEquivalent: formatEther(
            candidate.rewardEthEquivalent,
          ),
          gas: candidate.gas.toString(),
          netEthEquivalent: formatEther(
            candidate.netEthEquivalent,
          ),
        })),
      bestUnprofitable: viable
        .filter((candidate) => candidate.netEthEquivalent <= 0n)
        .slice(0, 5)
        .map((candidate) => ({
          pid: candidate.pid,
          callerCrv: formatEther(candidate.callerCrv),
          gas: candidate.gas.toString(),
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
      event: "convex_earmark_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
