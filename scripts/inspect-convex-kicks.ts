import {
  createPublicClient,
  decodeEventLog,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { mapConcurrent } from "../src/concurrency.js";
import { loadConfig } from "../src/config.js";
import { bufferedGas } from "../src/economics.js";

const LOCKER = getAddress(
  "0x72a19342e8F1838460eBFCCEf09F6585e32db86E",
);
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const ROUTESCAN_LOGS_URL =
  "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api";
const BLOCKS_PER_WEEK = 50_400n;
const SECONDS_PER_WEEK = 604_800n;
const LOCK_WEEKS = 16n;

const lockerAbi = parseAbi([
  "function kickExpiredLocks(address)",
  "function kickRewardPerEpoch() view returns(uint256)",
  "function kickRewardEpochDelay() view returns(uint256)",
  "function lockedBalances(address) view returns(uint256 total,uint256 unlockable,uint256 locked,(uint112 amount,uint112 boosted,uint32 unlockTime)[] lockData)",
]);
const stakedEvent = parseAbiItem(
  "event Staked(address indexed _user,uint256 indexed _epoch,uint256 _paidAmount,uint256 _lockedAmount,uint256 _boostedAmount)",
);
const stakedEventSelector = toEventSelector(stakedEvent);
const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

interface Candidate {
  readonly account: Address;
  readonly eventRewardCvx: bigint;
}

interface RoutescanLog {
  readonly data: Hex;
  readonly topics: readonly Hex[];
}

async function getStakedLogs(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<readonly RoutescanLog[]> {
  const logs: RoutescanLog[] = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(ROUTESCAN_LOGS_URL);
    for (const [name, value] of [
      ["module", "logs"],
      ["action", "getLogs"],
      ["fromBlock", fromBlock.toString()],
      ["toBlock", toBlock.toString()],
      ["address", LOCKER],
      ["topic0", stakedEventSelector],
      ["page", page.toString()],
      ["offset", "1000"],
    ]) {
      url.searchParams.set(name, value);
    }
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(20_000),
        });
        if (response.ok) break;
      } catch {
        // Retry indexer lag or transient network failures.
      }
      await new Promise((resolve) =>
        setTimeout(resolve, attempt * 500),
      );
    }
    if (response === undefined || !response.ok) {
      throw new Error("Routescan locker log request failed");
    }
    const payload = (await response.json()) as {
      readonly status: string;
      readonly message: string;
      readonly result: readonly RoutescanLog[] | string;
    };
    if (
      payload.status === "0" &&
      typeof payload.result === "string" &&
      payload.result.toLowerCase().includes("no records")
    ) {
      break;
    }
    if (!Array.isArray(payload.result)) {
      throw new Error(
        `Routescan locker log response failed: ${payload.message}`,
      );
    }
    logs.push(...payload.result);
    if (payload.result.length < 1_000) break;
  }
  return logs;
}

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
  const [latest, block, rewardPerEpoch, epochDelay, cvxUsdFeed] =
    await Promise.all([
      client.getBlockNumber(),
      client.getBlock(),
      client.readContract({
        address: LOCKER,
        abi: lockerAbi,
        functionName: "kickRewardPerEpoch",
      }),
      client.readContract({
        address: LOCKER,
        abi: lockerAbi,
        functionName: "kickRewardEpochDelay",
      }),
      client.getEnsAddress({ name: "cvx-usd.data.eth" }),
    ]);
  if (cvxUsdFeed === null) {
    throw new Error("cvx-usd.data.eth did not resolve");
  }
  const fromBlock = latest - 32n * BLOCKS_PER_WEEK;
  const toBlock = latest - 20n * BLOCKS_PER_WEEK;
  const indexedLogs = await getStakedLogs(fromBlock, toBlock);
  const currentEpoch =
    (block.timestamp - epochDelay * SECONDS_PER_WEEK) /
    SECONDS_PER_WEEK *
    SECONDS_PER_WEEK;
  const rewardsByAccount = new Map<Address, bigint>();
  for (const entry of indexedLogs) {
    const decoded = decodeEventLog({
      abi: [stakedEvent],
      data: entry.data,
      topics: entry.topics as [Hex, ...Hex[]],
    });
    const args = decoded.args;
    const unlockTime =
      args._epoch + LOCK_WEEKS * SECONDS_PER_WEEK;
    if (unlockTime > currentEpoch) continue;
    const epochsOver =
      (currentEpoch - unlockTime) / SECONDS_PER_WEEK;
    const rewardRate =
      rewardPerEpoch * (epochsOver + 1n) < 10_000n
        ? rewardPerEpoch * (epochsOver + 1n)
        : 10_000n;
    const reward =
      (args._lockedAmount * rewardRate) / 10_000n;
    rewardsByAccount.set(
      args._user,
      (rewardsByAccount.get(args._user) ?? 0n) + reward,
    );
  }
  const candidates: Candidate[] = [...rewardsByAccount].map(
    ([candidateAccount, eventRewardCvx]) => ({
      account: candidateAccount,
      eventRewardCvx,
    }),
  );
  const balances = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: candidates.map((candidate) => ({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "lockedBalances" as const,
      args: [candidate.account] as const,
    })),
  });
  const ready = candidates.flatMap((candidate, index) => {
    const balance = balances[index];
    if (balance?.status !== "success" || balance.result[1] === 0n) {
      return [];
    }
    const minimumReward =
      (balance.result[1] * rewardPerEpoch) / 10_000n;
    return [
      {
        ...candidate,
        unlockableCvx: balance.result[1],
        conservativeRewardCvx:
          candidate.eventRewardCvx < minimumReward
            ? candidate.eventRewardCvx
            : minimumReward,
      },
    ];
  });
  const [cvxRound, ethRound, fees] = await Promise.all([
    client.readContract({
      address: cvxUsdFeed,
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
  if (cvxRound[1] <= 0n || ethRound[1] <= 0n) {
    throw new Error("Chainlink returned a non-positive price");
  }
  const estimates = await mapConcurrent(
    ready,
    config.simulationConcurrency,
    async (candidate) => {
      try {
        const gas = await client.estimateContractGas({
          account,
          address: LOCKER,
          abi: lockerAbi,
          functionName: "kickExpiredLocks",
          args: [candidate.account],
        });
        const rewardEthEquivalent =
          (candidate.conservativeRewardCvx *
            cvxRound[1] *
            9_500n) /
          ethRound[1] /
          10_000n;
        return {
          ...candidate,
          gas,
          gasLimit: bufferedGas(
            gas,
            config.gasLimitMultiplierBps,
          ),
          rewardEthEquivalent,
          netEthEquivalent:
            rewardEthEquivalent -
            bufferedGas(gas, config.gasLimitMultiplierBps) *
              fees.maxFeePerGas,
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
        ? left.account.localeCompare(right.account)
        : left.netEthEquivalent > right.netEthEquivalent
          ? -1
          : 1,
    );
  console.log(
    JSON.stringify({
      event: "convex_kick_scan",
      locker: LOCKER,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      stakedEvents: indexedLogs.length,
      accounts: candidates.length,
      unlockableAccounts: ready.length,
      unlockableCandidates: ready.map((candidate) => candidate.account),
      simulatable: viable.length,
      rewardPerEpochBps: rewardPerEpoch.toString(),
      epochDelay: epochDelay.toString(),
      cvxUsd: formatEther(cvxRound[1] * 10n ** 10n),
      ethUsd: formatEther(ethRound[1] * 10n ** 10n),
      profitable: viable
        .filter((candidate) => candidate.netEthEquivalent > 0n)
        .slice(0, 30)
        .map((candidate) => ({
          account: candidate.account,
          unlockableCvx: formatEther(candidate.unlockableCvx),
          rewardCvx: formatEther(candidate.conservativeRewardCvx),
          gas: candidate.gas.toString(),
          gasLimit: candidate.gasLimit.toString(),
          rewardEthEquivalent: formatEther(
            candidate.rewardEthEquivalent,
          ),
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
      event: "convex_kick_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
