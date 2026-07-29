import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";

const ETH_GAS_COMPENSATION = 37_500_000_000_000_000n;
const COLL_GAS_COMPENSATION_DIVISOR = 200n;
const COLL_GAS_COMPENSATION_CAP = 2_000_000_000_000_000_000n;
const WETH = getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");

const BRANCHES = [
  {
    symbol: "WETH",
    collateral: WETH,
    troveManager: getAddress(
      "0x7bcb64b2c9206a5b699ed43363f6f98d4776cf5a",
    ),
    priceFeed: getAddress(
      "0xcc5f8102eb670c89a4a3c567c13851260303c24f",
    ),
    mcr: 1_100_000_000_000_000_000n,
  },
  {
    symbol: "wstETH",
    collateral: getAddress(
      "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    ),
    troveManager: getAddress(
      "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22",
    ),
    priceFeed: getAddress(
      "0xe7aa2ba9e086a379d3beb224098bc634a46e314e",
    ),
    mcr: 1_200_000_000_000_000_000n,
  },
  {
    symbol: "rETH",
    collateral: getAddress(
      "0xae78736cd615f374d3085123a210448e74fc6393",
    ),
    troveManager: getAddress(
      "0xb2b2abeb5c357a234363ff5d180912d319e3e19e",
    ),
    priceFeed: getAddress(
      "0x34f1e9c7dcc279ec70d3c4488eb2d80fba8b7b2b",
    ),
    mcr: 1_200_000_000_000_000_000n,
  },
] as const;

const troveManagerAbi = parseAbi([
  "function getTroveIdsCount() view returns(uint256)",
  "function getTroveFromTroveIdsArray(uint256) view returns(uint256)",
  "function getTroveStatus(uint256) view returns(uint8)",
  "function getCurrentICR(uint256,uint256) view returns(uint256)",
  "function Troves(uint256) view returns(uint256 debt,uint256 coll,uint256 stake,uint8 status,uint64 arrayIndex,uint64 lastDebtUpdateTime,uint64 lastInterestRateAdjTime,uint256 annualInterestRate,address interestBatchManager,uint256 batchDebtShares)",
  "function batchLiquidateTroves(uint256[])",
]);
const priceFeedAbi = parseAbi([
  "function fetchPrice() view returns(uint256,bool)",
]);

interface TroveCandidate {
  readonly id: bigint;
  readonly icr: bigint;
  readonly collateral: bigint;
}

function percent(value: bigint): string {
  const basisPoints = (value * 10_000n) / 1_000_000_000_000_000_000n;
  return `${basisPoints / 100n}.${(basisPoints % 100n)
    .toString()
    .padStart(2, "0")}%`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 30_000,
    }),
  });
  const account =
    config.privateKey === undefined
      ? undefined
      : privateKeyToAccount(config.privateKey);

  const prices = await Promise.all(
    BRANCHES.map(async (branch) => {
      const result = await client.readContract({
        address: branch.priceFeed,
        abi: priceFeedAbi,
        functionName: "fetchPrice",
      });
      return result[0];
    }),
  );
  const wethPrice = prices[0];
  if (wethPrice === undefined || wethPrice === 0n) {
    throw new Error("Liquity WETH price feed returned zero");
  }

  for (let branchIndex = 0; branchIndex < BRANCHES.length; branchIndex += 1) {
    const branch = BRANCHES[branchIndex]!;
    const price = prices[branchIndex]!;
    const count = await client.readContract({
      address: branch.troveManager,
      abi: troveManagerAbi,
      functionName: "getTroveIdsCount",
    });
    if (count > 10_000n) {
      throw new Error(
        `${branch.symbol} trove count ${count} exceeds scan safety limit`,
      );
    }
    const idResults = await client.multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: Array.from({ length: Number(count) }, (_, index) => ({
        address: branch.troveManager,
        abi: troveManagerAbi,
        functionName: "getTroveFromTroveIdsArray" as const,
        args: [BigInt(index)] as const,
      })),
    });
    const ids = idResults.flatMap((result) =>
      result.status === "success" ? [result.result] : [],
    );
    const healthResults = await client.multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: ids.flatMap((id) => [
        {
          address: branch.troveManager,
          abi: troveManagerAbi,
          functionName: "getTroveStatus" as const,
          args: [id] as const,
        },
        {
          address: branch.troveManager,
          abi: troveManagerAbi,
          functionName: "getCurrentICR" as const,
          args: [id, price] as const,
        },
        {
          address: branch.troveManager,
          abi: troveManagerAbi,
          functionName: "Troves" as const,
          args: [id] as const,
        },
      ]),
    });

    const candidates: TroveCandidate[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!;
      const status = healthResults[index * 3];
      const icr = healthResults[index * 3 + 1];
      const trove = healthResults[index * 3 + 2];
      if (
        status?.status !== "success" ||
        icr?.status !== "success" ||
        trove?.status !== "success" ||
        (status.result !== 1 && status.result !== 4)
      ) {
        continue;
      }
      candidates.push({
        id,
        icr: icr.result,
        collateral: trove.result[1],
      });
    }
    candidates.sort((left, right) =>
      left.icr === right.icr
        ? left.id < right.id
          ? -1
          : 1
        : left.icr < right.icr
          ? -1
          : 1,
    );
    const liquidatable = candidates.filter(
      (candidate) => candidate.icr < branch.mcr,
    );
    const near = candidates.slice(0, 5).map((candidate) => ({
      id: candidate.id.toString(),
      icr: percent(candidate.icr),
      distanceToMcrBps:
        (
          ((candidate.icr - branch.mcr) * 10_000n) /
          1_000_000_000_000_000_000n
        ).toString(),
    }));

    let estimatedGas: bigint | undefined;
    let grossRewardEth: bigint | undefined;
    if (liquidatable.length > 0 && account !== undefined) {
      const idsToLiquidate = liquidatable.map((candidate) => candidate.id);
      estimatedGas = await client.estimateContractGas({
        account,
        address: branch.troveManager,
        abi: troveManagerAbi,
        functionName: "batchLiquidateTroves",
        args: [idsToLiquidate],
      });
      const collateralCompensation = liquidatable.reduce(
        (total, candidate) => {
          const variable = candidate.collateral / COLL_GAS_COMPENSATION_DIVISOR;
          return (
            total +
            (variable < COLL_GAS_COMPENSATION_CAP
              ? variable
              : COLL_GAS_COMPENSATION_CAP)
          );
        },
        0n,
      );
      grossRewardEth =
        ETH_GAS_COMPENSATION * BigInt(liquidatable.length) +
        (collateralCompensation * price) / wethPrice;
    }

    console.log(
      JSON.stringify({
        event: "liquity_liquidation_scan",
        branch: branch.symbol,
        collateral: branch.collateral,
        troveManager: branch.troveManager,
        priceUsd: formatEther(price),
        mcr: percent(branch.mcr),
        troves: ids.length,
        activeOrZombie: candidates.length,
        liquidatable: liquidatable.map((candidate) => ({
          id: candidate.id.toString(),
          icr: percent(candidate.icr),
          collateral: formatEther(candidate.collateral),
        })),
        near,
        ...(estimatedGas === undefined
          ? {}
          : { estimatedGas: estimatedGas.toString() }),
        ...(grossRewardEth === undefined
          ? {}
          : { grossRewardEth: formatEther(grossRewardEth) }),
      }),
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "liquity_liquidation_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
