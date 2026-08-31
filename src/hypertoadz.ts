import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { ETHEREUM_TRANSACTION_GAS_LIMIT } from "./config.js";
import {
  HYPERTOADZ_AUCTION_DURATION,
  HYPERTOADZ_CORE_ADDRESS,
  HYPERTOADZ_CORE_RUNTIME_CODE_HASH,
  HYPERTOADZ_EXTENSION_WINDOW,
  HYPERTOADZ_MAX_SETTLER_REWARD_BPS,
} from "./constants.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import type { KeeperJob } from "./strategy.js";

export const HYPERTOADZ_SLOT_SECONDS = 12n;
// Builder simulations have understated canonical receipt gas by as much as
// 287 gas on this lane. Keep a narrow evidence-backed reserve so a
// profit-capped priority bid cannot consume the configured retained-profit
// floor when the canonical builder executes the same signed transaction.
export const HYPERTOADZ_RECEIPT_GAS_BUFFER = 2_048n;

export function hypertoadzPlanningMaxFeePerGas(parameters: {
  readonly baseFeeAllowancePerGas: bigint;
  readonly simulationBaseFeePerGas: bigint;
  readonly minimumPriorityFeePerGas: bigint;
}): bigint {
  return (
    (parameters.baseFeeAllowancePerGas >
    parameters.simulationBaseFeePerGas
      ? parameters.baseFeeAllowancePerGas
      : parameters.simulationBaseFeePerGas) +
    parameters.minimumPriorityFeePerGas
  );
}

export const hypertoadzAbi = parseAbi([
  "function currentAuction() view returns ((uint256 tokenId,uint256 bid,address bidder,address recipient,uint64 start,uint64 end,bytes32 seed,bool ended,bool hasBid) state)",
  "function auctionDuration() view returns (uint64)",
  "function extensionWindow() view returns (uint64)",
  "function MAX_SETTLER_REWARD_BPS() view returns (uint16)",
  "function settlerRewardBps() view returns (uint16)",
  "function settlerRewardFor(uint256 winningBid) view returns (uint256 reward)",
  "function finalize() returns (uint256 tokenId)",
  "event AuctionFinalized(uint256 indexed tokenId,address indexed winner,address indexed recipient,uint256 amount,address settler,uint256 settlerReward,bytes32 genome)",
]);

export interface HypertoadzAuction {
  readonly tokenId: bigint;
  readonly bid: bigint;
  readonly bidder: Address;
  readonly recipient: Address;
  readonly start: bigint;
  readonly end: bigint;
  readonly seed: `0x${string}`;
  readonly ended: boolean;
  readonly hasBid: boolean;
}

export interface HypertoadzPlan {
  readonly job?: KeeperJob;
  readonly auction: HypertoadzAuction;
  readonly settlerRewardBps: bigint;
  readonly reward: bigint;
}

const verifiedClients = new WeakSet<object>();

export function hypertoadzCanFinalizeInNextBlock(parameters: {
  readonly auctionEnd: bigint;
  readonly parentTimestamp: bigint;
  readonly hasBid: boolean;
}): boolean {
  return (
    parameters.hasBid &&
    parameters.auctionEnd > 0n &&
    parameters.auctionEnd <=
      parameters.parentTimestamp + HYPERTOADZ_SLOT_SECONDS
  );
}

export async function verifyHypertoadzRuntime(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<void> {
  const cacheKey = parameters.client as object;
  if (verifiedClients.has(cacheKey)) return;
  const [code, auctionDuration, extensionWindow, maximumRewardBps] =
    await Promise.all([
      parameters.client.getCode({
        address: HYPERTOADZ_CORE_ADDRESS,
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: HYPERTOADZ_CORE_ADDRESS,
        abi: hypertoadzAbi,
        functionName: "auctionDuration",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: HYPERTOADZ_CORE_ADDRESS,
        abi: hypertoadzAbi,
        functionName: "extensionWindow",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: HYPERTOADZ_CORE_ADDRESS,
        abi: hypertoadzAbi,
        functionName: "MAX_SETTLER_REWARD_BPS",
        blockNumber: parameters.blockNumber,
      }),
    ]);
  if (
    code === undefined ||
    code === "0x" ||
    keccak256(code) !== HYPERTOADZ_CORE_RUNTIME_CODE_HASH
  ) {
    throw new Error("Hypertoadz runtime does not match pinned code");
  }
  if (
    auctionDuration !== HYPERTOADZ_AUCTION_DURATION ||
    extensionWindow !== HYPERTOADZ_EXTENSION_WINDOW ||
    BigInt(maximumRewardBps) !== HYPERTOADZ_MAX_SETTLER_REWARD_BPS
  ) {
    throw new Error("Hypertoadz auction configuration is not canonical");
  }
  verifiedClients.add(cacheKey);
}

export async function planHypertoadzFinalize(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
  readonly builderBidBps: bigint;
}): Promise<HypertoadzPlan> {
  await verifyHypertoadzRuntime(parameters);
  const [auction, settlerRewardBps] = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: [
      {
        address: HYPERTOADZ_CORE_ADDRESS,
        abi: hypertoadzAbi,
        functionName: "currentAuction" as const,
      },
      {
        address: HYPERTOADZ_CORE_ADDRESS,
        abi: hypertoadzAbi,
        functionName: "settlerRewardBps" as const,
      },
    ],
  });
  const snapshot = auction as unknown as HypertoadzAuction;
  const reward = await parameters.client.readContract({
    address: HYPERTOADZ_CORE_ADDRESS,
    abi: hypertoadzAbi,
    functionName: "settlerRewardFor",
    args: [snapshot.bid],
    blockNumber: parameters.blockNumber,
  });
  const base = {
    auction: snapshot,
    settlerRewardBps: BigInt(settlerRewardBps),
    reward,
  };
  if (
    reward === 0n ||
    !hypertoadzCanFinalizeInNextBlock({
      auctionEnd: snapshot.end,
      parentTimestamp: parameters.blockTimestamp,
      hasBid: snapshot.hasBid,
    })
  ) {
    return base;
  }
  const data = encodeFunctionData({
    abi: hypertoadzAbi,
    functionName: "finalize",
  });
  const requiresBundleSimulation =
    parameters.blockTimestamp < snapshot.end;
  const gas = requiresBundleSimulation
    ? BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT)
    : bufferedGas(
        await parameters.client.estimateGas({
          account: parameters.account,
          to: HYPERTOADZ_CORE_ADDRESS,
          data,
          blockNumber: parameters.blockNumber,
        }),
        parameters.gasLimitMultiplierBps,
      );
  if (
    !requiresBundleSimulation &&
    reward - gas * parameters.maxFeePerGas <
      requiredProfit(parameters.minProfitWei)
  ) {
    return base;
  }
  return {
    ...base,
    job: {
      kind: "hypertoadz_finalize",
      label: `hypertoadz_finalize:${snapshot.tokenId}`,
      target: HYPERTOADZ_CORE_ADDRESS,
      data,
      gas,
      reward: { kind: "fixed", amountWei: reward },
      configuredBuilderBidBps: parameters.builderBidBps,
      ...(requiresBundleSimulation
        ? { requiresBundleSimulation: true }
        : {}),
    },
  };
}
