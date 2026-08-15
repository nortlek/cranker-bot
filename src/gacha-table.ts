import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import { fwaAbi } from "./abi.js";
import { ETHEREUM_TRANSACTION_GAS_LIMIT } from "./config.js";
import {
  GACHA_TABLE_ADDRESS,
  GACHA_TABLE_ESCROW_IMPLEMENTATION_ADDRESS,
  GACHA_TABLE_ESCROW_RUNTIME_CODE_HASH,
  GACHA_TABLE_RUNTIME_CODE_HASH,
  PULL_POOL_FWA_ADDRESS,
} from "./constants.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import { errorMessage, log } from "./format.js";
import {
  encodeGachaTableDefaults,
  encodeGachaTableFire,
  encodeGachaTableSettlement,
  GACHA_TABLE_KEEPER_EXECUTOR_DEPLOY_GAS_LIMIT,
  gachaTableKeeperExecutorAbi,
  gachaTableKeeperExecutorDeployment,
} from "./gacha-table-keeper-executor.js";
import {
  SINGLETON_FACTORY_ADDRESS,
  SINGLETON_FACTORY_RUNTIME_CODE,
} from "./standing-order-batch-executor.js";
import type { KeeperJob } from "./strategy.js";

export const GACHA_TABLE_STATE = {
  OPEN: 0,
  FILLED: 1,
  FIRED: 2,
  SETTLED: 3,
  CLOSED: 4,
  VOID: 5,
} as const;

export const GACHA_TABLE_DEFAULT_BOUNTY = 1_000_000_000_000_000n;
export const GACHA_TABLE_JOIN_EXPIRY = 86_400n;
export const GACHA_TABLE_FIRE_EXPIRY = 259_200n;
export const GACHA_TABLE_MAX_BATTLES_TO_SCAN = 256n;
export const ETHEREUM_SLOT_SECONDS = 12n;

const GACHA_ACQUISITION_STATUS = {
  FULFILLED: 2,
  EXPIRED: 3,
  REFUNDED: 4,
} as const;

const verifiedGachaTableRuntimeClients = new WeakSet<object>();

export const gachaTableAbi = parseAbi([
  "function currentBattleId() view returns (uint256)",
  "function feePool() view returns (uint256)",
  "function bountyFlat() view returns (uint256)",
  "function fwa() view returns (address)",
  "function escrowImplementation() view returns (address)",
  "function joinExpiry() view returns (uint64)",
  "function fireExpiry() view returns (uint64)",
  "function battle(uint256 id) view returns ((uint8 state,uint8 seatsTaken,uint8 winnerSeat,uint8 legsResolved,uint64 openedAt,uint64 filledAt,uint64 settledAt,address escrow,address winner,uint256 pendingFee,address[4] seats,uint256[4] stakes,uint256[4] requestIds))",
  "function legs(uint256 id,uint8 leg) view returns ((uint256 listingId,uint256 value,uint256 word,uint8 choice,uint8 form,bool resolved))",
  "function fire(uint256 battleId)",
  "function settle(uint256 battleId)",
  "function crankDefault(uint256 battleId,uint8 leg)",
  "event BountyPaid(uint256 indexed battleId,address indexed crank,uint8 kind,uint256 amount)",
]);

const gachaTableFwaAbi = parseAbi([
  "function settlementWindow() view returns (uint256)",
  "function listings(uint256 listingId) view returns (address collection,address depositor,address purchaser,uint256 tokenId,uint256 weight,uint256 value,uint256 feeShare,uint256 feeDebt,uint256 slot,uint64 allocatedAt,uint8 status)",
]);

export interface GachaBattle {
  readonly state: number;
  readonly seatsTaken: number;
  readonly winnerSeat: number;
  readonly legsResolved: number;
  readonly openedAt: bigint;
  readonly filledAt: bigint;
  readonly settledAt: bigint;
  readonly escrow: Address;
  readonly winner: Address;
  readonly pendingFee: bigint;
  readonly seats: readonly Address[];
  readonly stakes: readonly bigint[];
  readonly requestIds: readonly bigint[];
}

export interface GachaBattleSnapshot {
  readonly battleId: bigint;
  readonly battle: GachaBattle;
}

interface GachaCandidate {
  readonly job: KeeperJob;
  readonly profit: bigint;
  readonly reward: bigint;
}

export interface GachaTablePlan {
  readonly jobs: readonly KeeperJob[];
  readonly minimumViablePrefix: number;
  readonly currentBattleId: bigint;
  readonly firstBattleId: bigint;
  readonly scannedBattles: number;
  readonly feePool: bigint;
  readonly bountyFlat: bigint;
}

function canonicalAccount(account: Account | Address): Address {
  return typeof account === "string" ? account : account.address;
}

export function gachaTableExpectedBounty(parameters: {
  readonly feePool: bigint;
  readonly bountyFlat: bigint;
  readonly calls: number;
}): bigint {
  if (
    parameters.feePool < 0n ||
    parameters.bountyFlat < 0n ||
    !Number.isSafeInteger(parameters.calls) ||
    parameters.calls < 0
  ) {
    throw new Error("invalid GachaTable bounty inputs");
  }
  const maximum = parameters.bountyFlat * BigInt(parameters.calls);
  return parameters.feePool < maximum
    ? parameters.feePool
    : maximum;
}

export function gachaTableAcquisitionsAreTerminal(
  statuses: readonly number[],
): boolean {
  return (
    statuses.length === 4 &&
    statuses.every(
      (status) =>
        status === GACHA_ACQUISITION_STATUS.FULFILLED ||
        status === GACHA_ACQUISITION_STATUS.EXPIRED ||
        status === GACHA_ACQUISITION_STATUS.REFUNDED,
    )
  );
}

export function gachaTableDefaultDueAt(parameters: {
  readonly allocatedAt: bigint;
  readonly settlementWindow: bigint;
}): bigint {
  if (parameters.allocatedAt < 0n || parameters.settlementWindow < 0n) {
    throw new Error("invalid GachaTable default timing");
  }
  const configuredDelay = (parameters.settlementWindow * 3n) / 4n;
  const delay =
    configuredDelay < 64_800n ? configuredDelay : 64_800n;
  return parameters.allocatedAt + delay;
}

export function gachaTableDefaultCanExecuteInNextBlock(parameters: {
  readonly allocatedAt: bigint;
  readonly settlementWindow: bigint;
  readonly parentTimestamp: bigint;
}): boolean {
  return (
    gachaTableDefaultDueAt(parameters) <=
    parameters.parentTimestamp + ETHEREUM_SLOT_SECONDS
  );
}

export async function verifyGachaTableRuntime(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<void> {
  const cacheKey = parameters.client as object;
  if (verifiedGachaTableRuntimeClients.has(cacheKey)) return;
  const [code, escrowCode, values] = await Promise.all([
    parameters.client.getCode({
      address: GACHA_TABLE_ADDRESS,
      blockNumber: parameters.blockNumber,
    }),
    parameters.client.getCode({
      address: GACHA_TABLE_ESCROW_IMPLEMENTATION_ADDRESS,
      blockNumber: parameters.blockNumber,
    }),
    parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "fwa" as const,
        },
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "escrowImplementation" as const,
        },
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "bountyFlat" as const,
        },
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "joinExpiry" as const,
        },
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "fireExpiry" as const,
        },
      ],
    }),
  ]);
  const [fwa, escrow, bountyFlat, joinExpiry, fireExpiry] = values;
  if (
    code === undefined ||
    code === "0x" ||
    keccak256(code) !== GACHA_TABLE_RUNTIME_CODE_HASH
  ) {
    throw new Error("GachaTable runtime does not match pinned code");
  }
  if (
    escrowCode === undefined ||
    escrowCode === "0x" ||
    keccak256(escrowCode) !== GACHA_TABLE_ESCROW_RUNTIME_CODE_HASH
  ) {
    throw new Error("GachaTable escrow runtime does not match pinned code");
  }
  if (
    !isAddressEqual(fwa, PULL_POOL_FWA_ADDRESS) ||
    !isAddressEqual(
      escrow,
      GACHA_TABLE_ESCROW_IMPLEMENTATION_ADDRESS,
    ) ||
    bountyFlat !== GACHA_TABLE_DEFAULT_BOUNTY ||
    joinExpiry !== GACHA_TABLE_JOIN_EXPIRY ||
    fireExpiry !== GACHA_TABLE_FIRE_EXPIRY
  ) {
    throw new Error("GachaTable immutable relationships are not canonical");
  }
  verifiedGachaTableRuntimeClients.add(cacheKey);
}

export async function readGachaTableSnapshot(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<{
  readonly currentBattleId: bigint;
  readonly firstBattleId: bigint;
  readonly feePool: bigint;
  readonly bountyFlat: bigint;
  readonly battles: readonly GachaBattleSnapshot[];
}> {
  const [currentBattleId, feePool, bountyFlat] =
    await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "currentBattleId" as const,
        },
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "feePool" as const,
        },
        {
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "bountyFlat" as const,
        },
      ],
    });
  const firstBattleId =
    currentBattleId > GACHA_TABLE_MAX_BATTLES_TO_SCAN
      ? currentBattleId - GACHA_TABLE_MAX_BATTLES_TO_SCAN + 1n
      : 1n;
  const count = Number(currentBattleId - firstBattleId + 1n);
  const battles = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: Array.from({ length: count }, (_, index) => ({
      address: GACHA_TABLE_ADDRESS,
      abi: gachaTableAbi,
      functionName: "battle" as const,
      args: [firstBattleId + BigInt(index)] as const,
    })),
  });
  return {
    currentBattleId,
    firstBattleId,
    feePool,
    bountyFlat,
    battles: battles.map((battle, index) => ({
      battleId: firstBattleId + BigInt(index),
      battle: battle as unknown as GachaBattle,
    })),
  };
}

async function gachaTableExecutorState(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
}): Promise<{
  readonly address: Address;
  readonly deployed: boolean;
  readonly deployJob?: KeeperJob;
}> {
  const deployment = gachaTableKeeperExecutorDeployment(
    canonicalAccount(parameters.account),
  );
  const code = await parameters.client.getCode({
    address: deployment.address,
    blockNumber: parameters.blockNumber,
  });
  if (code !== undefined && code !== "0x") {
    if (keccak256(code) !== deployment.expectedRuntimeCodeHash) {
      throw new Error("GachaTable executor runtime does not match pinned code");
    }
    return { address: deployment.address, deployed: true };
  }
  const factoryCode = await parameters.client.getCode({
    address: SINGLETON_FACTORY_ADDRESS,
    blockNumber: parameters.blockNumber,
  });
  if (factoryCode !== SINGLETON_FACTORY_RUNTIME_CODE) {
    throw new Error("GachaTable executor factory runtime is not canonical");
  }
  return {
    address: deployment.address,
    deployed: false,
    deployJob: {
      kind: "gacha_executor_deploy",
      label: "gacha_executor_deploy",
      target: SINGLETON_FACTORY_ADDRESS,
      data: deployment.deployData,
      gas: GACHA_TABLE_KEEPER_EXECUTOR_DEPLOY_GAS_LIMIT,
      reward: { kind: "fixed", amountWei: 0n },
      requiresBundleSimulation: true,
    },
  };
}

async function exactExecutorGasAndReward(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly executor: Address;
  readonly data: Hex;
  readonly functionName:
    | "fireExact"
    | "settleExact"
    | "crankDefaultsExact";
  readonly gasLimitMultiplierBps: bigint;
}): Promise<{ readonly gas: bigint; readonly reward: bigint }> {
  const call = await parameters.client.call({
    account: parameters.account,
    to: parameters.executor,
    data: parameters.data,
    blockNumber: parameters.blockNumber,
  });
  if (call.data === undefined) {
    throw new Error("GachaTable executor simulation returned no bounty");
  }
  const reward = decodeFunctionResult({
    abi: gachaTableKeeperExecutorAbi,
    functionName: parameters.functionName,
    data: call.data,
  });
  const gas = bufferedGas(
    await parameters.client.estimateGas({
      account: parameters.account,
      to: parameters.executor,
      data: parameters.data,
      blockNumber: parameters.blockNumber,
    }),
    parameters.gasLimitMultiplierBps,
  );
  return { gas, reward };
}

async function directActionIsReady(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly data: Hex;
}): Promise<boolean> {
  try {
    await parameters.client.estimateGas({
      account: parameters.account,
      to: GACHA_TABLE_ADDRESS,
      data: parameters.data,
      blockNumber: parameters.blockNumber,
    });
    return true;
  } catch {
    return false;
  }
}

async function terminalBattleIsReady(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly requestIds: readonly bigint[];
}): Promise<boolean> {
  if (
    parameters.requestIds.length !== 4 ||
    parameters.requestIds.some((requestId) => requestId === 0n)
  ) {
    return false;
  }
  const acquisitions = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: parameters.requestIds.map((requestId) => ({
      address: PULL_POOL_FWA_ADDRESS,
      abi: fwaAbi,
      functionName: "acquisitions" as const,
      args: [requestId] as const,
    })),
  });
  return gachaTableAcquisitionsAreTerminal(
    acquisitions.map((acquisition) => acquisition[4]),
  );
}

function profitableGachaJob(parameters: {
  readonly kind: "gacha_fire" | "gacha_settle" | "gacha_default";
  readonly label: string;
  readonly target: Address;
  readonly data: Hex;
  readonly gas: bigint;
  readonly reward: bigint;
  readonly maxFeePerGas: bigint;
  readonly minProfitWei: bigint;
  readonly builderBidBps: bigint;
  readonly requiresBundleSimulation: boolean;
}): GachaCandidate | undefined {
  const profit = parameters.reward - parameters.gas * parameters.maxFeePerGas;
  if (
    !parameters.requiresBundleSimulation &&
    profit < requiredProfit(parameters.minProfitWei)
  ) {
    return undefined;
  }
  return {
    profit: parameters.requiresBundleSimulation
      ? parameters.reward
      : profit,
    reward: parameters.reward,
    job: {
      kind: parameters.kind,
      label: parameters.label,
      target: parameters.target,
      data: parameters.data,
      gas: parameters.gas,
      reward: { kind: "fixed", amountWei: parameters.reward },
      configuredBuilderBidBps: parameters.builderBidBps,
      ...(parameters.requiresBundleSimulation
        ? { requiresBundleSimulation: true }
        : {}),
    },
  };
}

export async function planGachaTableJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
  readonly defaultBuilderBidBps: bigint;
  readonly lifecycleBuilderBidBps: bigint;
}): Promise<GachaTablePlan> {
  await verifyGachaTableRuntime(parameters);
  const [snapshot, executor, settlementWindow] = await Promise.all([
    readGachaTableSnapshot(parameters),
    gachaTableExecutorState(parameters),
    parameters.client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: gachaTableFwaAbi,
      functionName: "settlementWindow",
      blockNumber: parameters.blockNumber,
    }),
  ]);
  const base = {
    currentBattleId: snapshot.currentBattleId,
    firstBattleId: snapshot.firstBattleId,
    scannedBattles: snapshot.battles.length,
    feePool: snapshot.feePool,
    bountyFlat: snapshot.bountyFlat,
  };
  if (snapshot.feePool === 0n || snapshot.bountyFlat === 0n) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }

  const candidates: GachaCandidate[] = [];
  const singleBounty = gachaTableExpectedBounty({
    feePool: snapshot.feePool,
    bountyFlat: snapshot.bountyFlat,
    calls: 1,
  });
  for (const { battleId, battle } of snapshot.battles) {
    if (battle.state === GACHA_TABLE_STATE.FILLED) {
      const directData = encodeFunctionData({
        abi: gachaTableAbi,
        functionName: "fire",
        args: [battleId],
      });
      if (
        !(await directActionIsReady({
          client: parameters.client,
          account: parameters.account,
          blockNumber: parameters.blockNumber,
          data: directData,
        }))
      ) {
        continue;
      }
      const data = encodeGachaTableFire(battleId, singleBounty);
      try {
        const exact = executor.deployed
          ? await exactExecutorGasAndReward({
              client: parameters.client,
              account: parameters.account,
              blockNumber: parameters.blockNumber,
              executor: executor.address,
              data,
              functionName: "fireExact",
              gasLimitMultiplierBps: parameters.gasLimitMultiplierBps,
            })
          : {
              gas: BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
              reward: singleBounty,
            };
        const candidate = profitableGachaJob({
          kind: "gacha_fire",
          label: `gacha_fire:${battleId}`,
          target: executor.address,
          data,
          gas: exact.gas,
          reward: exact.reward,
          maxFeePerGas: parameters.maxFeePerGas,
          minProfitWei: parameters.minProfitWei,
          builderBidBps: parameters.lifecycleBuilderBidBps,
          requiresBundleSimulation: !executor.deployed,
        });
        if (candidate !== undefined) candidates.push(candidate);
      } catch (error) {
        log("debug", "gacha_fire_not_ready", {
          battleId: battleId.toString(),
          reason: errorMessage(error),
        });
      }
      continue;
    }

    if (battle.state === GACHA_TABLE_STATE.FIRED) {
      if (
        !(await terminalBattleIsReady({
          client: parameters.client,
          blockNumber: parameters.blockNumber,
          requestIds: battle.requestIds,
        }))
      ) {
        continue;
      }
      const data = encodeGachaTableSettlement(battleId, singleBounty);
      try {
        const exact = executor.deployed
          ? await exactExecutorGasAndReward({
              client: parameters.client,
              account: parameters.account,
              blockNumber: parameters.blockNumber,
              executor: executor.address,
              data,
              functionName: "settleExact",
              gasLimitMultiplierBps: parameters.gasLimitMultiplierBps,
            })
          : {
              gas: BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
              reward: singleBounty,
            };
        const candidate = profitableGachaJob({
          kind: "gacha_settle",
          label: `gacha_settle:${battleId}`,
          target: executor.address,
          data,
          gas: exact.gas,
          reward: exact.reward,
          maxFeePerGas: parameters.maxFeePerGas,
          minProfitWei: parameters.minProfitWei,
          builderBidBps: parameters.lifecycleBuilderBidBps,
          requiresBundleSimulation: !executor.deployed,
        });
        if (candidate !== undefined) candidates.push(candidate);
      } catch (error) {
        log("debug", "gacha_settlement_not_ready", {
          battleId: battleId.toString(),
          reason: errorMessage(error),
        });
      }
      continue;
    }

    if (battle.state !== GACHA_TABLE_STATE.SETTLED) continue;
    const legs = await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: Array.from({ length: 4 }, (_, leg) => ({
        address: GACHA_TABLE_ADDRESS,
        abi: gachaTableAbi,
        functionName: "legs" as const,
        args: [battleId, leg] as const,
      })),
    });
    const unresolvedLegs = legs.flatMap((value, leg) =>
      value.resolved ? [] : [{ leg, listingId: value.listingId }],
    );
    const listings = await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: unresolvedLegs.map(({ listingId }) => ({
        address: PULL_POOL_FWA_ADDRESS,
        abi: gachaTableFwaAbi,
        functionName: "listings" as const,
        args: [listingId] as const,
      })),
    });
    const evaluatedLegs = await Promise.all(
      unresolvedLegs.map(async (unresolved, index) => {
        const listing = listings[index];
        if (listing === undefined) return undefined;
        const dueAt = gachaTableDefaultDueAt({
          allocatedAt: listing[9],
          settlementWindow,
        });
        if (
          !gachaTableDefaultCanExecuteInNextBlock({
            allocatedAt: listing[9],
            settlementWindow,
            parentTimestamp: parameters.blockTimestamp,
          })
        ) {
          return undefined;
        }
        if (dueAt > parameters.blockTimestamp) {
          return { leg: unresolved.leg, childTimestampRequired: true };
        }
        const directData = encodeFunctionData({
          abi: gachaTableAbi,
          functionName: "crankDefault",
          args: [battleId, unresolved.leg],
        });
        return (await directActionIsReady({
          client: parameters.client,
          account: parameters.account,
          blockNumber: parameters.blockNumber,
          data: directData,
        }))
          ? { leg: unresolved.leg, childTimestampRequired: false }
          : undefined;
      }),
    );
    const eligibleLegs = evaluatedLegs.flatMap((entry) =>
      entry === undefined ? [] : [entry.leg],
    );
    const childTimestampRequired = evaluatedLegs.some(
      (entry) => entry?.childTimestampRequired === true,
    );
    if (eligibleLegs.length === 0) continue;
    const reward = gachaTableExpectedBounty({
      feePool: snapshot.feePool,
      bountyFlat: snapshot.bountyFlat,
      calls: eligibleLegs.length,
    });
    const data = encodeGachaTableDefaults(
      battleId,
      eligibleLegs,
      reward,
    );
    try {
      const exact = executor.deployed && !childTimestampRequired
        ? await exactExecutorGasAndReward({
            client: parameters.client,
            account: parameters.account,
            blockNumber: parameters.blockNumber,
            executor: executor.address,
            data,
            functionName: "crankDefaultsExact",
            gasLimitMultiplierBps: parameters.gasLimitMultiplierBps,
          })
        : {
            gas: BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
            reward,
          };
      const candidate = profitableGachaJob({
        kind: "gacha_default",
        label: `gacha_default:${battleId}:${eligibleLegs.join(",")}`,
        target: executor.address,
        data,
        gas: exact.gas,
        reward: exact.reward,
        maxFeePerGas: parameters.maxFeePerGas,
        minProfitWei: parameters.minProfitWei,
        builderBidBps: parameters.defaultBuilderBidBps,
        requiresBundleSimulation:
          !executor.deployed || childTimestampRequired,
      });
      if (candidate !== undefined) candidates.push(candidate);
    } catch (error) {
      log("debug", "gacha_default_batch_not_ready", {
        battleId: battleId.toString(),
        legs: JSON.stringify(eligibleLegs),
        reason: errorMessage(error),
      });
    }
  }

  candidates.sort((left, right) =>
    left.profit === right.profit
      ? left.job.label.localeCompare(right.job.label)
      : left.profit > right.profit
        ? -1
        : 1,
  );
  const selected = candidates[0];
  if (selected === undefined) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }
  const jobs = [
    ...(executor.deployJob === undefined ? [] : [executor.deployJob]),
    selected.job,
  ];
  log("info", "gacha_table_opportunity", {
    battleId: selected.job.label.split(":")[1] ?? "",
    kind: selected.job.kind,
    label: selected.job.label,
    grossReward: selected.reward.toString(),
    gas: selected.job.gas.toString(),
    executor: executor.address,
    executorDeployed: executor.deployed,
  });
  return {
    ...base,
    jobs,
    minimumViablePrefix: jobs.length,
  };
}
