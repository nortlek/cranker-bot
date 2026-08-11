import {
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import {
  groupPullAbi,
  groupPullStandingOrderAbi,
  groupPullStandingOrderFactoryAbi,
  poolV2Abi,
} from "./abi.js";
import {
  GROUP_PULL_ADDRESS,
  GROUP_PULL_RUNTIME_CODE_HASH,
  GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS,
  GROUP_PULL_STANDING_ORDER_FACTORY_RUNTIME_CODE_HASH,
  PULL_POOL_V2_ADDRESS,
} from "./constants.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import { errorMessage, log } from "./format.js";
import { ROUND_STATE } from "./lifecycle.js";
import type { KeeperJob } from "./strategy.js";

export const GROUP_PULL_ROUND_STATE = {
  NONE: 0,
  SELLING: 1,
  BUYING: 2,
  COLLECTING: 3,
  DISTRIBUTING: 4,
  EXPIRED: 5,
} as const;

const verifiedGroupPullRuntimeClients = new WeakSet<object>();
const verifiedGroupPullFactoryRuntimeClients = new WeakSet<object>();

export type GroupPullRound = Awaited<
  ReturnType<typeof readGroupPullRound>
>;

export function groupPullBountyForCalls(parameters: {
  readonly bountyPot: bigint;
  readonly bountyShares: number;
  readonly calls: number;
}): bigint {
  if (
    parameters.bountyPot < 0n ||
    !Number.isSafeInteger(parameters.bountyShares) ||
    parameters.bountyShares < 0 ||
    !Number.isSafeInteger(parameters.calls) ||
    parameters.calls < 0 ||
    parameters.calls > parameters.bountyShares
  ) {
    throw new Error("invalid GroupPull bounty parameters");
  }
  let pot = parameters.bountyPot;
  let shares = BigInt(parameters.bountyShares);
  let reward = 0n;
  for (let index = 0; index < parameters.calls; index += 1) {
    if (shares === 0n) {
      throw new Error("GroupPull bounty shares exhausted");
    }
    const paid = pot / shares;
    reward += paid;
    pot -= paid;
    shares -= 1n;
  }
  return reward;
}

export async function verifyGroupPullRuntime(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<void> {
  const cacheKey = parameters.client as object;
  const runtimeVerified =
    verifiedGroupPullRuntimeClients.has(cacheKey);
  const [code, pool] = await Promise.all([
    runtimeVerified
      ? Promise.resolve(undefined)
      : parameters.client.getCode({
          address: GROUP_PULL_ADDRESS,
          blockNumber: parameters.blockNumber,
        }),
    parameters.client.readContract({
      address: GROUP_PULL_ADDRESS,
      abi: groupPullAbi,
      functionName: "pool",
      blockNumber: parameters.blockNumber,
    }),
  ]);
  if (
    !runtimeVerified &&
    (code === undefined ||
      code === "0x" ||
      keccak256(code) !== GROUP_PULL_RUNTIME_CODE_HASH)
  ) {
    throw new Error("GroupPull runtime does not match pinned code");
  }
  if (!isAddressEqual(pool, PULL_POOL_V2_ADDRESS)) {
    throw new Error("GroupPull no longer targets the canonical PullPool V2");
  }
  verifiedGroupPullRuntimeClients.add(cacheKey);
}

export async function verifyGroupPullStandingOrderFactory(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<readonly Address[]> {
  const cacheKey = parameters.client as object;
  const runtimeVerified =
    verifiedGroupPullFactoryRuntimeClients.has(cacheKey);
  const [code, [group, orderCount, orders]] = await Promise.all([
    runtimeVerified
      ? Promise.resolve(undefined)
      : parameters.client.getCode({
          address: GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS,
          blockNumber: parameters.blockNumber,
        }),
    parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        {
          address: GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS,
          abi: groupPullStandingOrderFactoryAbi,
          functionName: "GROUP" as const,
        },
        {
          address: GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS,
          abi: groupPullStandingOrderFactoryAbi,
          functionName: "orderCount" as const,
        },
        {
          address: GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS,
          abi: groupPullStandingOrderFactoryAbi,
          functionName: "allOrders" as const,
        },
      ],
    }),
  ]);
  if (
    !runtimeVerified &&
    (code === undefined ||
      code === "0x" ||
      keccak256(code) !==
        GROUP_PULL_STANDING_ORDER_FACTORY_RUNTIME_CODE_HASH)
  ) {
    throw new Error(
      "GroupPull standing-order factory runtime does not match pinned code",
    );
  }
  if (!isAddressEqual(group, GROUP_PULL_ADDRESS)) {
    throw new Error(
      "GroupPull standing-order factory no longer targets the canonical GroupPull",
    );
  }
  if (orderCount > 512n || BigInt(orders.length) !== orderCount) {
    throw new Error("GroupPull standing-order factory index mismatch");
  }
  verifiedGroupPullFactoryRuntimeClients.add(cacheKey);
  return orders;
}

export async function planGroupPullStandingOrderJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
  readonly builderBidBps: bigint;
}): Promise<readonly KeeperJob[]> {
  const orders = await verifyGroupPullStandingOrderFactory(parameters);
  const candidateState =
    orders.length === 0
      ? []
      : await parameters.client.multicall({
          allowFailure: true,
          blockNumber: parameters.blockNumber,
          contracts: orders.flatMap((order) => [
            {
              address: GROUP_PULL_STANDING_ORDER_FACTORY_ADDRESS,
              abi: groupPullStandingOrderFactoryAbi,
              functionName: "isOrder" as const,
              args: [order] as const,
            },
            {
              address: order,
              abi: groupPullStandingOrderAbi,
              functionName: "groupPull" as const,
            },
            {
              address: order,
              abi: groupPullStandingOrderAbi,
              functionName: "crankFee" as const,
            },
          ]),
        });
  const candidates = await Promise.all(
    orders.map(async (order, index): Promise<KeeperJob | undefined> => {
      try {
        const isOrder = candidateState[index * 3];
        const groupPull = candidateState[index * 3 + 1];
        const crankFee = candidateState[index * 3 + 2];
        if (
          isOrder?.status !== "success" ||
          groupPull?.status !== "success" ||
          crankFee?.status !== "success" ||
          isOrder.result !== true ||
          typeof groupPull.result !== "string" ||
          typeof crankFee.result !== "bigint" ||
          !isAddressEqual(groupPull.result, GROUP_PULL_ADDRESS)
        ) {
          return undefined;
        }
        const data = encodeFunctionData({
          abi: groupPullStandingOrderAbi,
          functionName: "crank",
        });
        const estimatedGas = await parameters.client.estimateGas({
          account: parameters.account,
          to: order,
          data,
          blockNumber: parameters.blockNumber,
        });
        const gas = bufferedGas(
          estimatedGas,
          parameters.gasLimitMultiplierBps,
        );
        if (
          crankFee.result - gas * parameters.maxFeePerGas <
          requiredProfit(parameters.minProfitWei)
        ) {
          return undefined;
        }
        return {
          kind: "group_pull_standing_order",
          label: `group_pull_standing_order:${order}`,
          target: order,
          data,
          gas,
          reward: { kind: "fixed", amountWei: crankFee.result },
          configuredBuilderBidBps: parameters.builderBidBps,
          order,
        };
      } catch (error) {
        log("debug", "group_pull_standing_order_not_ready", {
          order,
          reason: errorMessage(error),
        });
        return undefined;
      }
    }),
  );
  return candidates
    .filter((job): job is KeeperJob => job !== undefined)
    .sort((left, right) => {
      const leftProfit =
        (left.reward.kind === "fixed" ? left.reward.amountWei : 0n) -
        left.gas * parameters.maxFeePerGas;
      const rightProfit =
        (right.reward.kind === "fixed" ? right.reward.amountWei : 0n) -
        right.gas * parameters.maxFeePerGas;
      return leftProfit === rightProfit
        ? left.label.localeCompare(right.label)
        : leftProfit > rightProfit
          ? -1
          : 1;
    });
}

export async function readGroupPullRound(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly roundId: bigint;
}) {
  return parameters.client.readContract({
    address: GROUP_PULL_ADDRESS,
    abi: groupPullAbi,
    functionName: "getRound",
    args: [parameters.roundId],
    blockNumber: parameters.blockNumber,
  });
}

export async function readGroupPullPlannerState(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<{
  readonly paused: boolean;
  readonly deprecated: boolean;
  readonly roundCount: bigint;
  readonly liveRound: bigint;
  readonly buyingRounds: bigint;
}> {
  const [paused, deprecated, roundCount, liveRound, buyingRounds] =
    await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        {
          address: GROUP_PULL_ADDRESS,
          abi: groupPullAbi,
          functionName: "paused" as const,
        },
        {
          address: GROUP_PULL_ADDRESS,
          abi: groupPullAbi,
          functionName: "deprecated" as const,
        },
        {
          address: GROUP_PULL_ADDRESS,
          abi: groupPullAbi,
          functionName: "roundCount" as const,
        },
        {
          address: GROUP_PULL_ADDRESS,
          abi: groupPullAbi,
          functionName: "liveRound" as const,
        },
        {
          address: GROUP_PULL_ADDRESS,
          abi: groupPullAbi,
          functionName: "buyingRounds" as const,
        },
      ],
    });
  return { paused, deprecated, roundCount, liveRound, buyingRounds };
}

async function readActiveRounds(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly roundCount: bigint;
  readonly buyingRounds: bigint;
}): Promise<readonly { roundId: bigint; round: GroupPullRound }[]> {
  if (parameters.buyingRounds === 0n) return [];
  if (parameters.buyingRounds > 64n) {
    throw new Error("GroupPull buying-round count exceeds safety bound");
  }
  const expected = Number(parameters.buyingRounds);
  const found: { roundId: bigint; round: GroupPullRound }[] = [];
  let cursor = parameters.roundCount;
  while (cursor > 0n && found.length < expected) {
    const ids: bigint[] = [];
    for (let index = 0; index < 32 && cursor > 0n; index += 1) {
      ids.push(cursor);
      cursor -= 1n;
    }
    const rounds = await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: ids.map((roundId) => ({
        address: GROUP_PULL_ADDRESS,
        abi: groupPullAbi,
        functionName: "getRound" as const,
        args: [roundId] as const,
      })),
    });
    for (let index = 0; index < ids.length; index += 1) {
      const round = rounds[index];
      if (
        round?.state === GROUP_PULL_ROUND_STATE.BUYING ||
        round?.state === GROUP_PULL_ROUND_STATE.COLLECTING
      ) {
        found.push({ roundId: ids[index]!, round });
      }
    }
  }
  if (found.length !== expected) {
    throw new Error(
      `GroupPull active-round index mismatch: expected ${expected}, found ${found.length}`,
    );
  }
  return found;
}

async function readFirstCollectablePulls(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly roundId: bigint;
}): Promise<{
  readonly poolRoundCount: number;
  readonly firstCollections: number;
  readonly poolRoundIds: readonly bigint[];
  readonly collected: readonly boolean[];
  readonly rounds: readonly {
    readonly state: number;
    readonly tokenPot: bigint;
  }[];
  readonly canPayTokens: boolean;
}> {
  const [pool, poolRoundIds] = await Promise.all([
    parameters.client.readContract({
      address: GROUP_PULL_ADDRESS,
      abi: groupPullAbi,
      functionName: "roundPool",
      args: [parameters.roundId],
      blockNumber: parameters.blockNumber,
    }),
    parameters.client.readContract({
      address: GROUP_PULL_ADDRESS,
      abi: groupPullAbi,
      functionName: "poolRoundsOf",
      args: [parameters.roundId],
      blockNumber: parameters.blockNumber,
    }),
  ]);
  const [canPayTokens, rounds, collected] = await Promise.all([
    parameters.client.readContract({
      address: pool,
      abi: poolV2Abi,
      functionName: "canPayTokens",
      blockNumber: parameters.blockNumber,
    }),
    poolRoundIds.length === 0
      ? Promise.resolve([])
      : parameters.client.multicall({
          allowFailure: false,
          blockNumber: parameters.blockNumber,
          contracts: poolRoundIds.map((poolRoundId) => ({
            address: pool,
            abi: poolV2Abi,
            functionName: "getRound" as const,
            args: [poolRoundId] as const,
          })),
        }),
    poolRoundIds.length === 0
      ? Promise.resolve([])
      : parameters.client.multicall({
          allowFailure: false,
          blockNumber: parameters.blockNumber,
          contracts: poolRoundIds.map((poolRoundId) => ({
            address: GROUP_PULL_ADDRESS,
            abi: groupPullAbi,
            functionName: "pullCollected" as const,
            args: [parameters.roundId, poolRoundId] as const,
          })),
        }),
  ]);
  let firstCollections = 0;
  for (let index = 0; index < poolRoundIds.length; index += 1) {
    if (collected[index]) continue;
    const round = rounds[index]!;
    if (round.state === ROUND_STATE.refunding) {
      firstCollections += 1;
    } else if (
      round.state === ROUND_STATE.settled &&
      (round.tokenPot === 0n || canPayTokens)
    ) {
      firstCollections += 1;
    }
  }
  return {
    poolRoundCount: poolRoundIds.length,
    firstCollections,
    poolRoundIds,
    collected,
    rounds: rounds.map((round) => ({
      state: round.state,
      tokenPot: round.tokenPot,
    })),
    canPayTokens,
  };
}

export interface GroupPullCollectContext {
  readonly roundId: bigint;
  readonly bountyPot: bigint;
  readonly bountyShares: number;
  readonly poolRoundIds: readonly bigint[];
  readonly collected: readonly boolean[];
  readonly rounds: readonly {
    readonly state: number;
    readonly tokenPot: bigint;
  }[];
  readonly canPayTokens: boolean;
  readonly firstCollections: number;
}

export const GROUP_PULL_DEPENDENT_COLLECT_GAS_LIMIT = 5_000_000n;

export function groupPullCollectAfterSettlement(parameters: {
  readonly contexts: readonly GroupPullCollectContext[];
  readonly poolRoundId: bigint;
  readonly builderBidBps: bigint;
}): KeeperJob | undefined {
  for (const context of parameters.contexts) {
    const index = context.poolRoundIds.findIndex(
      (roundId) => roundId === parameters.poolRoundId,
    );
    if (index < 0 || context.collected[index] === true) continue;
    const poolRound = context.rounds[index];
    if (
      poolRound === undefined ||
      (poolRound.state !== ROUND_STATE.pulling &&
        poolRound.state !== ROUND_STATE.claimable) ||
      (poolRound.tokenPot !== 0n && !context.canPayTokens)
    ) {
      continue;
    }
    // Only the pool round settled by our mandatory prefix is guaranteed.
    // Earlier collectable rounds may be taken by public transactions ordered
    // before the bundle, so treat them as unpriced upside.
    const calls = 1;
    const reward = groupPullBountyForCalls({
      bountyPot: context.bountyPot,
      bountyShares: context.bountyShares,
      calls,
    });
    return {
      kind: "group_pull_collect",
      label: `group_pull_collect:${context.roundId}:${calls}:after_settle`,
      target: GROUP_PULL_ADDRESS,
      data: encodeFunctionData({
        abi: groupPullAbi,
        functionName: "collect",
        args: [context.roundId, BigInt(context.poolRoundIds.length)],
      }),
      gas: GROUP_PULL_DEPENDENT_COLLECT_GAS_LIMIT,
      reward: { kind: "fixed", amountWei: reward },
      configuredBuilderBidBps: parameters.builderBidBps,
      requiresBundleSimulation: true,
      roundId: context.roundId,
    };
  }
  return undefined;
}

export interface GroupPullPlan {
  readonly job?: KeeperJob;
  readonly paused: boolean;
  readonly deprecated: boolean;
  readonly roundCount: bigint;
  readonly liveRound: bigint;
  readonly buyingRounds: bigint;
  readonly collectContexts: readonly GroupPullCollectContext[];
}

export async function planGroupPullJob(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
  readonly builderBidBps: bigint;
  readonly collectBuilderBidBps: bigint;
}): Promise<GroupPullPlan> {
  await verifyGroupPullRuntime(parameters);
  const { paused, deprecated, roundCount, liveRound, buyingRounds } =
    await readGroupPullPlannerState(parameters);
  const candidates: KeeperJob[] = [];
  const collectContexts: GroupPullCollectContext[] = [];
  if (liveRound > 0n) {
    const round = await readGroupPullRound({
      client: parameters.client,
      blockNumber: parameters.blockNumber,
      roundId: liveRound,
    });
    if (
      round.state === GROUP_PULL_ROUND_STATE.SELLING &&
      round.pullsPerRound > 0
    ) {
      const data = encodeFunctionData({
        abi: groupPullAbi,
        functionName: "close",
        args: [liveRound],
      });
      try {
        const estimatedGas = await parameters.client.estimateGas({
          account: parameters.account,
          to: GROUP_PULL_ADDRESS,
          data,
          blockNumber: parameters.blockNumber,
        });
        const gas = bufferedGas(
          estimatedGas,
          parameters.gasLimitMultiplierBps,
        );
        const reward = groupPullBountyForCalls({
          bountyPot: round.bountyPot,
          bountyShares: 1 + 2 * round.pullsPerRound,
          calls: 1,
        });
        if (
          reward - gas * parameters.maxFeePerGas >=
          requiredProfit(parameters.minProfitWei)
        ) {
          candidates.push({
            kind: "group_pull_close",
            label: `group_pull_close:${liveRound}`,
            target: GROUP_PULL_ADDRESS,
            data,
            gas,
            reward: { kind: "fixed", amountWei: reward },
            configuredBuilderBidBps: parameters.builderBidBps,
            roundId: liveRound,
          });
        }
      } catch (error) {
        log("debug", "group_pull_close_not_ready", {
          round: liveRound.toString(),
          reason: errorMessage(error),
        });
      }
    }
  }
  const active = await readActiveRounds({
    client: parameters.client,
    blockNumber: parameters.blockNumber,
    roundCount,
    buyingRounds,
  });
  for (const { roundId, round } of active) {
    if (round.state !== GROUP_PULL_ROUND_STATE.BUYING) continue;
    const remaining = round.pullsPerRound - round.bought;
    if (remaining <= 0 || round.bountyShares <= 0) continue;
    for (let calls = remaining; calls >= 1; calls -= 1) {
      const data = encodeFunctionData({
        abi: groupPullAbi,
        functionName: "submit",
        args: [roundId, BigInt(calls)],
      });
      try {
        const estimatedGas = await parameters.client.estimateGas({
          account: parameters.account,
          to: GROUP_PULL_ADDRESS,
          data,
          blockNumber: parameters.blockNumber,
        });
        const gas = bufferedGas(
          estimatedGas,
          parameters.gasLimitMultiplierBps,
        );
        const reward = groupPullBountyForCalls({
          bountyPot: round.bountyPot,
          bountyShares: round.bountyShares,
          calls,
        });
        if (
          reward - gas * parameters.maxFeePerGas >=
          requiredProfit(parameters.minProfitWei)
        ) {
          candidates.push({
            kind: "group_pull_submit",
            label: `group_pull_submit:${roundId}:${calls}`,
            target: GROUP_PULL_ADDRESS,
            data,
            gas,
            reward: { kind: "fixed", amountWei: reward },
            configuredBuilderBidBps: parameters.builderBidBps,
            roundId,
          });
        }
        break;
      } catch (error) {
        if (calls === 1) {
          log("debug", "group_pull_submit_not_ready", {
            round: roundId.toString(),
            reason: errorMessage(error),
          });
        }
      }
    }
  }
  for (const { roundId, round } of active) {
    if (round.state !== GROUP_PULL_ROUND_STATE.COLLECTING) continue;
    const remaining = round.bought - round.pullsCollected;
    if (remaining <= 0 || round.bountyShares <= 0) continue;
    try {
      const collectable =
        await readFirstCollectablePulls({
          client: parameters.client,
          blockNumber: parameters.blockNumber,
          roundId,
        });
      const { poolRoundCount, firstCollections } = collectable;
      collectContexts.push({
        roundId,
        bountyPot: round.bountyPot,
        bountyShares: round.bountyShares,
        poolRoundIds: collectable.poolRoundIds,
        collected: collectable.collected,
        rounds: collectable.rounds,
        canPayTokens: collectable.canPayTokens,
        firstCollections,
      });
      if (poolRoundCount === 0 || firstCollections === 0) continue;
      const data = encodeFunctionData({
        abi: groupPullAbi,
        functionName: "collect",
        // A previously collected pull with a late delta consumes a work slot.
        // Scan the complete bounded round so every priced first collection is
        // guaranteed to be reached.
        args: [roundId, BigInt(poolRoundCount)],
      });
      const estimatedGas = await parameters.client.estimateGas({
        account: parameters.account,
        to: GROUP_PULL_ADDRESS,
        data,
        blockNumber: parameters.blockNumber,
      });
      const gas = bufferedGas(
        estimatedGas,
        parameters.gasLimitMultiplierBps,
      );
      const reward = groupPullBountyForCalls({
        bountyPot: round.bountyPot,
        bountyShares: round.bountyShares,
        calls: firstCollections,
      });
      if (
        reward - gas * parameters.maxFeePerGas >=
        requiredProfit(parameters.minProfitWei)
      ) {
        candidates.push({
          kind: "group_pull_collect",
          label: `group_pull_collect:${roundId}:${firstCollections}`,
          target: GROUP_PULL_ADDRESS,
          data,
          gas,
          reward: { kind: "fixed", amountWei: reward },
          configuredBuilderBidBps:
            parameters.collectBuilderBidBps,
          roundId,
        });
      }
    } catch (error) {
      log("debug", "group_pull_collect_not_ready", {
        round: roundId.toString(),
        reason: errorMessage(error),
      });
    }
  }
  candidates.sort((left, right) => {
    const leftReward =
      left.reward.kind === "fixed" ? left.reward.amountWei : 0n;
    const rightReward =
      right.reward.kind === "fixed" ? right.reward.amountWei : 0n;
    const leftProfit = leftReward - left.gas * parameters.maxFeePerGas;
    const rightProfit = rightReward - right.gas * parameters.maxFeePerGas;
    return leftProfit === rightProfit
      ? left.label.localeCompare(right.label)
      : leftProfit > rightProfit
        ? -1
        : 1;
  });
  return {
    ...(candidates[0] === undefined ? {} : { job: candidates[0] }),
    paused,
    deprecated,
    roundCount,
    liveRound,
    buyingRounds,
    collectContexts,
  };
}
