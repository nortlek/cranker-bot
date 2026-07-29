import {
  createPublicClient,
  fallback,
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

const MANAGER = getAddress(
  "0x5ef30b9986345249bc32d8928B7ee64DE9435E39",
);
const VAT = getAddress(
  "0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B",
);
const DOG = getAddress(
  "0x135954d155898D42C90D2a57824C690e0c7BEf1B",
);
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const DAI_USD_FEED = getAddress(
  "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
);
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const DEFAULT_DISCOVERY_RPC_URLS = [
  "https://eth-mainnet.public.blastapi.io",
  "https://mainnet.gateway.tenderly.co",
  "https://rpc.mevblocker.io",
] as const;
const DEFAULT_DISCOVERY_CONCURRENCY = 2;
const DEFAULT_VAULT_CHUNK_SIZE = 250;

const managerAbi = parseAbi([
  "function cdpi() view returns(uint256)",
  "function ilks(uint256) view returns(bytes32)",
  "function urns(uint256) view returns(address)",
]);
const vatAbi = parseAbi([
  "function urns(bytes32,address) view returns(uint256 ink,uint256 art)",
  "function ilks(bytes32) view returns(uint256 Art,uint256 rate,uint256 spot,uint256 line,uint256 dust)",
]);
const dogAbi = parseAbi([
  "function live() view returns(uint256)",
  "function Hole() view returns(uint256)",
  "function Dirt() view returns(uint256)",
  "function ilks(bytes32) view returns(address clip,uint256 chop,uint256 hole,uint256 dirt)",
  "function bark(bytes32,address,address) returns(uint256)",
]);
const clipperAbi = parseAbi([
  "function tip() view returns(uint256)",
  "function chip() view returns(uint64)",
]);
const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

interface Vault {
  readonly id: bigint;
  readonly ilk: Hex;
  readonly urn: Address;
}

interface ActiveVault extends Vault {
  readonly ink: bigint;
  readonly art: bigint;
}

interface IlkState {
  readonly ilk: Hex;
  readonly rate: bigint;
  readonly spot: bigint;
  readonly dust: bigint;
  readonly clip: Address;
  readonly chop: bigint;
  readonly hole: bigint;
  readonly dirt: bigint;
  readonly tip: bigint;
  readonly chip: bigint;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
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
    DEFAULT_DISCOVERY_CONCURRENCY,
  );
  const vaultChunkSize = positiveIntegerEnv(
    "DISCOVERY_VAULT_CHUNK_SIZE",
    DEFAULT_VAULT_CHUNK_SIZE,
  );
  const account =
    config.privateKey === undefined
      ? config.simulationAccount
      : privateKeyToAccount(config.privateKey);
  const accountAddress =
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
  const [count, live, globalHole, globalDirt] = await Promise.all([
    client.readContract({
      address: MANAGER,
      abi: managerAbi,
      functionName: "cdpi",
    }),
    client.readContract({
      address: DOG,
      abi: dogAbi,
      functionName: "live",
    }),
    client.readContract({
      address: DOG,
      abi: dogAbi,
      functionName: "Hole",
    }),
    client.readContract({
      address: DOG,
      abi: dogAbi,
      functionName: "Dirt",
    }),
  ]);
  if (live !== 1n) {
    throw new Error("Maker Dog is not live");
  }
  const chunks = Array.from(
    { length: Math.ceil(Number(count) / vaultChunkSize) },
    (_, chunk) => {
      const start = chunk * vaultChunkSize + 1;
      const end = Math.min(
        Number(count),
        start + vaultChunkSize - 1,
      );
      return Array.from(
        { length: end - start + 1 },
        (_, offset) => BigInt(start + offset),
      );
    },
  );
  const managerChunks = await mapConcurrent(
    chunks,
    discoveryConcurrency,
    async (ids) => {
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 131_072,
        contracts: ids.flatMap((id) => [
          {
            address: MANAGER,
            abi: managerAbi,
            functionName: "ilks" as const,
            args: [id] as const,
          },
          {
            address: MANAGER,
            abi: managerAbi,
            functionName: "urns" as const,
            args: [id] as const,
          },
        ]),
      });
      return ids.flatMap((id, index): Vault[] => {
        const ilk = results[index * 2];
        const urn = results[index * 2 + 1];
        if (
          ilk?.status !== "success" ||
          urn?.status !== "success"
        ) {
          return [];
        }
        return [
          {
            id,
            ilk: ilk.result as Hex,
            urn: getAddress(urn.result as Address),
          },
        ];
      });
    },
  );
  const vaults = managerChunks.flat();
  const balanceChunks = await mapConcurrent(
    chunks.map((ids, index) => ({
      ids,
      vaults: managerChunks[index] ?? [],
    })),
    discoveryConcurrency,
    async ({ vaults: chunkVaults }) => {
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 131_072,
        contracts: chunkVaults.map((vault) => ({
          address: VAT,
          abi: vatAbi,
          functionName: "urns" as const,
          args: [vault.ilk, vault.urn] as const,
        })),
      });
      return chunkVaults.flatMap((vault, index): ActiveVault[] => {
        const result = results[index];
        if (
          result?.status !== "success" ||
          result.result[0] === 0n ||
          result.result[1] === 0n
        ) {
          return [];
        }
        return [
          {
            ...vault,
            ink: result.result[0],
            art: result.result[1],
          },
        ];
      });
    },
  );
  const active = balanceChunks.flat();
  const uniqueIlks = [
    ...new Map(
      active.map((vault) => [vault.ilk.toLowerCase(), vault.ilk]),
    ).values(),
  ];
  const ilkStates = (
    await mapConcurrent(
      uniqueIlks,
      discoveryConcurrency,
      async (ilk): Promise<IlkState | undefined> => {
        try {
          const [vatIlk, dogIlk] = await Promise.all([
            client.readContract({
              address: VAT,
              abi: vatAbi,
              functionName: "ilks",
              args: [ilk],
            }),
            client.readContract({
              address: DOG,
              abi: dogAbi,
              functionName: "ilks",
              args: [ilk],
            }),
          ]);
          const clip = getAddress(dogIlk[0]);
          if (
            clip === "0x0000000000000000000000000000000000000000"
          ) {
            return undefined;
          }
          const [tip, chip] = await Promise.all([
            client.readContract({
              address: clip,
              abi: clipperAbi,
              functionName: "tip",
            }),
            client.readContract({
              address: clip,
              abi: clipperAbi,
              functionName: "chip",
            }),
          ]);
          return {
            ilk,
            rate: vatIlk[1],
            spot: vatIlk[2],
            dust: vatIlk[4],
            clip,
            chop: dogIlk[1],
            hole: dogIlk[2],
            dirt: dogIlk[3],
            tip,
            chip,
          };
        } catch {
          return undefined;
        }
      },
    )
  ).filter((value): value is IlkState => value !== undefined);
  const states = new Map(
    ilkStates.map((state) => [state.ilk.toLowerCase(), state]),
  );
  const unsafe = active.flatMap((vault) => {
    const state = states.get(vault.ilk.toLowerCase());
    return state !== undefined &&
      state.spot > 0n &&
      vault.ink * state.spot < vault.art * state.rate
      ? [{ vault, state }]
      : [];
  });
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
    unsafe,
    discoveryConcurrency,
    async ({ vault, state }) => {
      try {
        if (
          globalHole <= globalDirt ||
          state.hole <= state.dirt ||
          state.chop === 0n ||
          state.rate === 0n
        ) {
          return undefined;
        }
        const room = min(
          globalHole - globalDirt,
          state.hole - state.dirt,
        );
        let dart = min(
          vault.art,
          (room * WAD) / state.rate / state.chop,
        );
        if (
          vault.art > dart &&
          (vault.art - dart) * state.rate < state.dust
        ) {
          dart = vault.art;
        } else if (
          vault.art > dart &&
          dart * state.rate < state.dust
        ) {
          return undefined;
        }
        const due = dart * state.rate;
        const tab = (due * state.chop) / WAD;
        const rewardRad =
          state.tip + (tab * state.chip) / WAD;
        const rewardDai = rewardRad / RAY;
        if (rewardDai === 0n) return undefined;
        const rewardEthEquivalent =
          (rewardDai * daiRound[1] * 9_950n) /
          ethRound[1] /
          10_000n;
        const gas = await client.estimateContractGas({
          account,
          address: DOG,
          abi: dogAbi,
          functionName: "bark",
          args: [vault.ilk, vault.urn, accountAddress],
        });
        const gasLimit = bufferedGas(
          gas,
          config.gasLimitMultiplierBps,
        );
        return {
          vault,
          state,
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
        ? left.vault.id < right.vault.id
          ? -1
          : 1
        : left.netEthEquivalent > right.netEthEquivalent
          ? -1
          : 1,
    );
  console.log(
    JSON.stringify({
      event: "maker_bark_scan",
      discoveryRpcHosts: discoveryRpcUrls.map(
        (url) => new URL(url).hostname,
      ),
      discoveryConcurrency,
      vaultChunkSize,
      vaultIds: count.toString(),
      vaultsRead: vaults.length,
      activeVaults: active.length,
      activeIlks: ilkStates.length,
      unsafeVaults: unsafe.length,
      simulatable: viable.length,
      profitable: viable
        .filter((value) => value.netEthEquivalent > 0n)
        .map((value) => ({
          id: value.vault.id.toString(),
          ilk: hexToString(value.vault.ilk, { size: 32 }),
          urn: value.vault.urn,
          clip: value.state.clip,
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
      event: "maker_bark_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
