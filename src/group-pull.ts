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

import { groupPullAbi } from "./abi.js";
import {
  GROUP_PULL_ADDRESS,
  GROUP_PULL_RUNTIME_CODE_HASH,
  PULL_POOL_V2_ADDRESS,
} from "./constants.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import { errorMessage, log } from "./format.js";
import type { KeeperJob } from "./strategy.js";

export const GROUP_PULL_ROUND_STATE = {
  NONE: 0,
  SELLING: 1,
  BUYING: 2,
  DISTRIBUTING: 3,
  EXPIRED: 4,
  ABORTED: 5,
} as const;

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
  const [code, pool] = await Promise.all([
    parameters.client.getCode({
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
    code === undefined ||
    code === "0x" ||
    keccak256(code) !== GROUP_PULL_RUNTIME_CODE_HASH
  ) {
    throw new Error("GroupPull runtime does not match pinned code");
  }
  if (!isAddressEqual(pool, PULL_POOL_V2_ADDRESS)) {
    throw new Error("GroupPull no longer targets the canonical PullPool V2");
  }
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

async function readBuyingRounds(parameters: {
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
    const rounds = await Promise.all(
      ids.map((roundId) =>
        readGroupPullRound({
          client: parameters.client,
          blockNumber: parameters.blockNumber,
          roundId,
        }),
      ),
    );
    for (let index = 0; index < ids.length; index += 1) {
      const round = rounds[index];
      if (round?.state === GROUP_PULL_ROUND_STATE.BUYING) {
        found.push({ roundId: ids[index]!, round });
      }
    }
  }
  if (found.length !== expected) {
    throw new Error(
      `GroupPull buying-round index mismatch: expected ${expected}, found ${found.length}`,
    );
  }
  return found;
}

export interface GroupPullPlan {
  readonly job?: KeeperJob;
  readonly paused: boolean;
  readonly deprecated: boolean;
  readonly roundCount: bigint;
  readonly liveRound: bigint;
  readonly buyingRounds: bigint;
}

export async function planGroupPullJob(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
  readonly builderBidBps: bigint;
}): Promise<GroupPullPlan> {
  await verifyGroupPullRuntime(parameters);
  const [paused, deprecated, roundCount, liveRound, buyingRounds] =
    await Promise.all([
      parameters.client.readContract({
        address: GROUP_PULL_ADDRESS,
        abi: groupPullAbi,
        functionName: "paused",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: GROUP_PULL_ADDRESS,
        abi: groupPullAbi,
        functionName: "deprecated",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: GROUP_PULL_ADDRESS,
        abi: groupPullAbi,
        functionName: "roundCount",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: GROUP_PULL_ADDRESS,
        abi: groupPullAbi,
        functionName: "liveRound",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: GROUP_PULL_ADDRESS,
        abi: groupPullAbi,
        functionName: "buyingRounds",
        blockNumber: parameters.blockNumber,
      }),
    ]);
  const candidates: KeeperJob[] = [];
  if (liveRound > 0n) {
    const round = await readGroupPullRound({
      client: parameters.client,
      blockNumber: parameters.blockNumber,
      roundId: liveRound,
    });
    if (
      round.state === GROUP_PULL_ROUND_STATE.SELLING &&
      round.bountyShares > 0
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
          bountyShares: round.bountyShares,
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
  const buying = await readBuyingRounds({
    client: parameters.client,
    blockNumber: parameters.blockNumber,
    roundCount,
    buyingRounds,
  });
  for (const { roundId, round } of buying) {
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
  };
}
