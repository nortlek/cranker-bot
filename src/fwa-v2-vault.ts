import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { bufferedGas } from "./economics.js";
import type { KeeperJob } from "./strategy.js";

export const FWA_V2_VAULT_FACTORY = getAddress(
  "0x2D774bE0c47902306D911b049E03D02dD7E399C6",
);
export const FWA_V2_VAULT_IMPLEMENTATION = getAddress(
  "0x0e4bC3E18919cDD4A83746F030b7b89f9Dc522F1",
);
export const FWA_V2_VAULT = getAddress(
  "0x12E9aC05B754D9000D5d1D66046457CaBad3D2b6",
);
export const FWA_V2_ADDRESS = getAddress(
  "0x958C41181182e76F221331b2755b77D9e1426A98",
);
export const FWA_V2_VAULT_ROUTER = getAddress(
  "0x186F4c10152f9a902573b3Fe07F48689Fa8a4927",
);

const FACTORY_RUNTIME_HASH =
  "0x2228c35c8e96bb466b5696e86a54bdd20cc5fa10e7b0a4d47d89f228f1a25b37";
const IMPLEMENTATION_RUNTIME_HASH =
  "0x7b52425cbdfe014ebeaaa2a4f7a07905c90f0f1daaab97d34c9cd427cbd91e17";
const VAULT_RUNTIME_HASH =
  "0xb0941615d8a2d18390cbb8a2911e5601db5e24c7136b56c2c59c6d1062ab0038";

const MAX_BATCH = 5n;
const PRIORITY_CAP = 2_000_000_000n;
const GAS_OVERHEAD = 40_000n;
const REQUEST_GAS_CAP = 1_500_000n;
const SYNC_GAS_CAP = 3_000_000n;
const FINALIZE_GAS_CAP = 1_000_000n;
const MAX_GAS_CEILING = 100_000_000_000n;
const SYNC_BOUNTY_RAMP = 1_200n;

export const fwaV2VaultAbi = parseAbi([
  "function FACTORY() view returns (address)",
  "function FWA() view returns (address)",
  "function ROUTER() view returns (address)",
  "function status() view returns (uint8)",
  "function privateMode() view returns (bool)",
  "function idle() view returns (uint256)",
  "function gasCeiling() view returns (uint256)",
  "function bountyWei() view returns (uint256)",
  "function syncBountyMaxWei() view returns (uint256)",
  "function outstandingCount() view returns (uint256)",
  "function openAuctionIds() view returns (uint256[])",
  "function syncStatus() view returns (uint256 resolvable,uint256 oldestAllocatedAt,uint256 openAuctionsPastDeadline)",
  "function auctionInfo(uint256 requestId) view returns (uint256 listingId,address collection,uint256 tokenId,uint256 backstop,uint256 highBid,address highBidder,uint256 deadline,uint256 hardDeadline,uint256 minNextBid)",
  "function requestPulls(uint256 count) returns (uint256 requested)",
  "function sync(uint256 maxCount) returns (uint256 resolved)",
  "function finalizeAuction(uint256 requestId)",
  "event KeeperReimbursed(address indexed keeper,uint256 gasUsed,uint256 gasPrice,uint256 amount)",
  "event BountyPaid(address indexed caller,uint256 amount)",
]);

const factoryAbi = parseAbi([
  "function isVault(address) view returns (bool)",
  "function IMPLEMENTATION() view returns (address)",
  "function FWA() view returns (address)",
  "function ROUTER() view returns (address)",
]);

export interface FwaV2VaultPlan {
  readonly status: number;
  readonly idle: bigint;
  readonly outstandingCount: bigint;
  readonly resolvable: bigint;
  readonly openAuctions: number;
  readonly job?: KeeperJob;
}

const verifiedClients = new WeakSet<object>();

export async function verifyFwaV2VaultRuntime(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<void> {
  const cacheKey = parameters.client as object;
  if (verifiedClients.has(cacheKey)) return;
  const [factoryCode, implementationCode, vaultCode, identity] = await Promise.all([
    parameters.client.getCode({ address: FWA_V2_VAULT_FACTORY, blockNumber: parameters.blockNumber }),
    parameters.client.getCode({ address: FWA_V2_VAULT_IMPLEMENTATION, blockNumber: parameters.blockNumber }),
    parameters.client.getCode({ address: FWA_V2_VAULT, blockNumber: parameters.blockNumber }),
    parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        { address: FWA_V2_VAULT_FACTORY, abi: factoryAbi, functionName: "isVault", args: [FWA_V2_VAULT] },
        { address: FWA_V2_VAULT_FACTORY, abi: factoryAbi, functionName: "IMPLEMENTATION" },
        { address: FWA_V2_VAULT_FACTORY, abi: factoryAbi, functionName: "FWA" },
        { address: FWA_V2_VAULT_FACTORY, abi: factoryAbi, functionName: "ROUTER" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "FACTORY" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "FWA" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "ROUTER" },
      ],
    }),
  ]);
  if (
    factoryCode === undefined || implementationCode === undefined || vaultCode === undefined ||
    keccak256(factoryCode) !== FACTORY_RUNTIME_HASH ||
    keccak256(implementationCode) !== IMPLEMENTATION_RUNTIME_HASH ||
    keccak256(vaultCode) !== VAULT_RUNTIME_HASH
  ) throw new Error("FWA V2 vault runtime does not match pinned code");
  const expected = [true, FWA_V2_VAULT_IMPLEMENTATION, FWA_V2_ADDRESS, FWA_V2_VAULT_ROUTER, FWA_V2_VAULT_FACTORY, FWA_V2_ADDRESS, FWA_V2_VAULT_ROUTER] as const;
  if (identity.some((value, index) => typeof expected[index] === "string"
    ? String(value).toLowerCase() !== String(expected[index]).toLowerCase()
    : value !== expected[index])) {
    throw new Error("FWA V2 vault relationship does not match pinned identity");
  }
  verifiedClients.add(cacheKey);
}

function reward(parameters: {
  readonly bounty: bigint;
  readonly gasPriceCeiling: bigint;
  readonly gasCap: bigint;
  readonly idle: bigint;
}): KeeperJob["reward"] {
  return {
    kind: "gas_reimbursement",
    flatProfitWei: parameters.bounty,
    callCount: 1n,
    gasPriceCeiling: parameters.gasPriceCeiling,
    priorityFeeCap: PRIORITY_CAP,
    executorGasDiscount: 0n,
    reimbursementGasBonus: GAS_OVERHEAD,
    reimbursedGasCap: parameters.gasCap,
    maximumPayoutWei: parameters.idle,
  };
}

export function fwaV2VaultSyncBounty(parameters: {
  readonly bounty: bigint;
  readonly maximum: bigint;
  readonly oldestAllocatedAt: bigint;
  readonly blockTimestamp: bigint;
}): bigint {
  if (
    parameters.oldestAllocatedAt === 0n ||
    parameters.oldestAllocatedAt >= parameters.blockTimestamp
  ) return parameters.bounty;
  const elapsed = parameters.blockTimestamp - parameters.oldestAllocatedAt;
  const age = elapsed < SYNC_BOUNTY_RAMP ? elapsed : SYNC_BOUNTY_RAMP;
  return parameters.bounty +
    (parameters.maximum - parameters.bounty) * age / SYNC_BOUNTY_RAMP;
}

export async function planFwaV2VaultJob(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly baseFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly builderBidBps: bigint;
}): Promise<FwaV2VaultPlan> {
  await verifyFwaV2VaultRuntime(parameters);
  const [status, privateMode, idle, gasCeiling, bounty, syncBountyMax, outstandingCount, openAuctionIds, syncStatus] =
    await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "status" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "privateMode" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "idle" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "gasCeiling" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "bountyWei" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "syncBountyMaxWei" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "outstandingCount" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "openAuctionIds" },
        { address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "syncStatus" },
      ],
    });
  const [resolvable, oldestAllocatedAt] = syncStatus;
  const base = { status: Number(status), idle, outstandingCount, resolvable, openAuctions: openAuctionIds.length };
  if (privateMode || idle === 0n) return base;

  for (const requestId of openAuctionIds) {
    const auction = await parameters.client.readContract({ address: FWA_V2_VAULT, abi: fwaV2VaultAbi, functionName: "auctionInfo", args: [requestId], blockNumber: parameters.blockNumber });
    if (auction[6] > parameters.blockTimestamp) continue;
    const data = encodeFunctionData({ abi: fwaV2VaultAbi, functionName: "finalizeAuction", args: [requestId] });
    const gas = bufferedGas(await parameters.client.estimateGas({ account: parameters.account, to: FWA_V2_VAULT, data, blockNumber: parameters.blockNumber }), parameters.gasLimitMultiplierBps);
    return { ...base, job: { kind: "fwa_v2_vault_finalize", label: `fwa_v2_vault_finalize:${requestId}`, target: FWA_V2_VAULT, data, gas, reward: reward({ bounty, gasPriceCeiling: MAX_GAS_CEILING, gasCap: FINALIZE_GAS_CAP, idle }), configuredBuilderBidBps: parameters.builderBidBps, requiresBundleSimulation: true } };
  }
  if (outstandingCount > 0n) {
    const data = encodeFunctionData({ abi: fwaV2VaultAbi, functionName: "sync", args: [outstandingCount] });
    const simulation = await parameters.client.simulateContract({
      account: parameters.account,
      address: FWA_V2_VAULT,
      abi: fwaV2VaultAbi,
      functionName: "sync",
      args: [outstandingCount],
      blockNumber: parameters.blockNumber,
    });
    if (simulation.result === 0n) return base;
    const syncBounty = fwaV2VaultSyncBounty({
      bounty,
      maximum: syncBountyMax,
      oldestAllocatedAt,
      blockTimestamp: parameters.blockTimestamp,
    });
    const gas = bufferedGas(await parameters.client.estimateGas({ account: parameters.account, to: FWA_V2_VAULT, data, blockNumber: parameters.blockNumber }), parameters.gasLimitMultiplierBps);
    return { ...base, job: { kind: "fwa_v2_vault_sync", label: "fwa_v2_vault_sync", target: FWA_V2_VAULT, data, gas, reward: reward({ bounty: syncBounty, gasPriceCeiling: MAX_GAS_CEILING, gasCap: SYNC_GAS_CAP, idle }), configuredBuilderBidBps: parameters.builderBidBps, requiresBundleSimulation: true } };
  }
  if (Number(status) === 1) {
    if (parameters.baseFeePerGas > gasCeiling) return base;
    const data = encodeFunctionData({ abi: fwaV2VaultAbi, functionName: "requestPulls", args: [MAX_BATCH] });
    const transactionMaxFeePerGas = parameters.maxFeePerGas < gasCeiling ? parameters.maxFeePerGas : gasCeiling;
    const gas = bufferedGas(await parameters.client.estimateGas({ account: parameters.account, to: FWA_V2_VAULT, data, maxFeePerGas: transactionMaxFeePerGas, maxPriorityFeePerGas: transactionMaxFeePerGas < PRIORITY_CAP ? transactionMaxFeePerGas : PRIORITY_CAP, blockNumber: parameters.blockNumber }), parameters.gasLimitMultiplierBps);
    return { ...base, job: { kind: "fwa_v2_vault_request", label: "fwa_v2_vault_request", target: FWA_V2_VAULT, data, gas, reward: reward({ bounty, gasPriceCeiling: gasCeiling, gasCap: REQUEST_GAS_CAP, idle }), configuredBuilderBidBps: parameters.builderBidBps, requiresBundleSimulation: true } };
  }
  return base;
}
