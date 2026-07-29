import {
  createPublicClient,
  formatEther,
  getAddress,
  hexToString,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { mapConcurrent } from "../src/concurrency.js";
import { loadConfig } from "../src/config.js";
import { bufferedGas } from "../src/economics.js";

const CHAINLOG = getAddress(
  "0xda0ab1e0017debcd72be8599041a2aa3ba7e740f",
);
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const DAI_USD_FEED = getAddress(
  "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
);
const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const BLN = 10n ** 9n;

const chainlogAbi = parseAbi([
  "function list() view returns(bytes32[])",
  "function getAddress(bytes32) view returns(address)",
]);
const clipperAbi = parseAbi([
  "function ilk() view returns(bytes32)",
  "function list() view returns(uint256[])",
  "function getStatus(uint256) view returns(bool needsRedo,uint256 price,uint256 lot,uint256 tab)",
  "function tip() view returns(uint256)",
  "function chip() view returns(uint64)",
  "function chost() view returns(uint256)",
  "function spotter() view returns(address)",
  "function stopped() view returns(uint256)",
  "function redo(uint256,address)",
]);
const spotterAbi = parseAbi([
  "function ilks(bytes32) view returns(address pip,uint256 mat)",
  "function par() view returns(uint256)",
]);
const oracleAbi = parseAbi([
  "function peek() view returns(bytes32,bool)",
]);
const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

interface Clipper {
  readonly key: string;
  readonly address: Address;
  readonly ilk: Hex;
  readonly active: readonly bigint[];
  readonly tip: bigint;
  readonly chip: bigint;
  readonly chost: bigint;
  readonly spotter: Address;
  readonly stopped: bigint;
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
  const keys = await client.readContract({
    address: CHAINLOG,
    abi: chainlogAbi,
    functionName: "list",
  });
  const clipKeys = keys.filter((key) => {
    const name = hexToString(key, { size: 32 });
    return (
      name.startsWith("MCD_CLIP_") &&
      !name.startsWith("MCD_CLIP_CALC_")
    );
  });
  const addressResults = await client.multicall({
    allowFailure: true,
    contracts: clipKeys.map((key) => ({
      address: CHAINLOG,
      abi: chainlogAbi,
      functionName: "getAddress" as const,
      args: [key] as const,
    })),
  });
  const unique = new Map<Address, string>();
  for (let index = 0; index < clipKeys.length; index += 1) {
    const key = clipKeys[index];
    const result = addressResults[index];
    if (
      key === undefined ||
      result?.status !== "success" ||
      result.result.toLowerCase() === ZERO_ADDRESS
    ) {
      continue;
    }
    unique.set(
      getAddress(result.result),
      hexToString(key, { size: 32 }),
    );
  }
  const clippers = (
    await mapConcurrent(
      [...unique],
      config.simulationConcurrency,
      async ([address, key]): Promise<Clipper | undefined> => {
        const results = await client.multicall({
          allowFailure: true,
          contracts: [
            {
              address,
              abi: clipperAbi,
              functionName: "ilk",
            },
            {
              address,
              abi: clipperAbi,
              functionName: "list",
            },
            {
              address,
              abi: clipperAbi,
              functionName: "tip",
            },
            {
              address,
              abi: clipperAbi,
              functionName: "chip",
            },
            {
              address,
              abi: clipperAbi,
              functionName: "chost",
            },
            {
              address,
              abi: clipperAbi,
              functionName: "spotter",
            },
            {
              address,
              abi: clipperAbi,
              functionName: "stopped",
            },
          ],
        });
        if (results.some((result) => result.status !== "success")) {
          return undefined;
        }
        return {
          key,
          address,
          ilk: results[0]!.result as Hex,
          active: results[1]!.result as readonly bigint[],
          tip: results[2]!.result as bigint,
          chip: results[3]!.result as bigint,
          chost: results[4]!.result as bigint,
          spotter: getAddress(results[5]!.result as Address),
          stopped: results[6]!.result as bigint,
        };
      },
    )
  ).filter((value): value is Clipper => value !== undefined);
  const active = clippers.flatMap((clipper) =>
    clipper.active.map((id) => ({ clipper, id })),
  );
  const statuses = await mapConcurrent(
    active,
    config.simulationConcurrency,
    async (auction) => {
      try {
        const status = await client.readContract({
          address: auction.clipper.address,
          abi: clipperAbi,
          functionName: "getStatus",
          args: [auction.id],
        });
        return { ...auction, status };
      } catch {
        return undefined;
      }
    },
  );
  const resettable = statuses.filter(
    (
      value,
    ): value is NonNullable<typeof value> =>
      value !== undefined && value.status[0],
  );
  const [fees, daiRound, ethRound] = await Promise.all([
    client.estimateFeesPerGas({ type: "eip1559" }),
    client.readContract({
      address: DAI_USD_FEED,
      abi: chainlinkAbi,
      functionName: "latestRoundData",
    }),
    client.readContract({
      address: ETH_USD_FEED,
      abi: chainlinkAbi,
      functionName: "latestRoundData",
    }),
  ]);
  if (daiRound[1] <= 0n || ethRound[1] <= 0n) {
    throw new Error("Chainlink returned a non-positive price");
  }
  const opportunities = await mapConcurrent(
    resettable,
    config.simulationConcurrency,
    async (auction) => {
      try {
        const [spotIlk, par] = await Promise.all([
          client.readContract({
            address: auction.clipper.spotter,
            abi: spotterAbi,
            functionName: "ilks",
            args: [auction.clipper.ilk],
          }),
          client.readContract({
            address: auction.clipper.spotter,
            abi: spotterAbi,
            functionName: "par",
          }),
        ]);
        const peek = await client.readContract({
          address: getAddress(spotIlk[0]),
          abi: oracleAbi,
          functionName: "peek",
        });
        if (!peek[1] || par === 0n) return undefined;
        const feedPrice =
          (BigInt(peek[0]) * BLN * RAY) / par;
        const [, , lot, tab] = auction.status;
        const rewardEligible =
          tab >= auction.clipper.chost &&
          lot * feedPrice >= auction.clipper.chost;
        if (!rewardEligible || auction.clipper.stopped >= 2n) {
          return undefined;
        }
        const rewardRad =
          auction.clipper.tip +
          (tab * auction.clipper.chip) / WAD;
        const rewardDai = rewardRad / RAY;
        const rewardEthEquivalent =
          (rewardDai * daiRound[1] * 9_950n) /
          ethRound[1] /
          10_000n;
        const gas = await client.estimateContractGas({
          account,
          address: auction.clipper.address,
          abi: clipperAbi,
          functionName: "redo",
          args: [
            auction.id,
            typeof account === "string"
              ? account
              : account.address,
          ],
        });
        const gasLimit = bufferedGas(
          gas,
          config.gasLimitMultiplierBps,
        );
        return {
          key: auction.clipper.key,
          clipper: auction.clipper.address,
          id: auction.id,
          rewardDai,
          rewardEthEquivalent,
          gas,
          gasLimit,
          netEthEquivalent:
            rewardEthEquivalent - gasLimit * fees.maxFeePerGas,
        };
      } catch {
        return undefined;
      }
    },
  );
  const viable = opportunities
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((left, right) =>
      left.netEthEquivalent === right.netEthEquivalent
        ? left.key.localeCompare(right.key)
        : left.netEthEquivalent > right.netEthEquivalent
          ? -1
          : 1,
    );
  console.log(
    JSON.stringify({
      event: "maker_redo_scan",
      chainlogKeys: keys.length,
      clippers: clippers.length,
      activeAuctions: active.length,
      resettableAuctions: resettable.length,
      rewardEligible: viable.length,
      profitable: viable
        .filter((value) => value.netEthEquivalent > 0n)
        .map((value) => ({
          key: value.key,
          clipper: value.clipper,
          id: value.id.toString(),
          rewardDai: formatEther(value.rewardDai),
          gas: value.gas.toString(),
          gasLimit: value.gasLimit.toString(),
          rewardEthEquivalent: formatEther(
            value.rewardEthEquivalent,
          ),
          netEthEquivalent: formatEther(value.netEthEquivalent),
        })),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "maker_redo_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
