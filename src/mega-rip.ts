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

import { fwaAbi } from "./abi.js";
import {
  ETHEREUM_TRANSACTION_GAS_LIMIT,
} from "./config.js";
import {
  FWA_TOKEN_ADDRESS,
  MEGA_RIP_ADDRESS,
  MEGA_RIP_FWA_REWARDS_ADDRESS,
  MEGA_RIP_RUNTIME_CODE_HASH,
  PULL_POOL_FWA_ADDRESS,
} from "./constants.js";
import { bufferedGas, requiredProfit } from "./economics.js";
import { errorMessage, log } from "./format.js";
import { ACQUISITION_STATUS } from "./lifecycle.js";
import type { KeeperJob } from "./strategy.js";

export const MEGA_RIP_STATE = {
  PENDING: 0,
  FUNDING: 1,
  PULLING: 2,
  FINALIZED: 3,
} as const;

export const MEGA_RIP_ACQUISITION_STATE = {
  NONE: 0,
  PENDING: 1,
  ALLOCATED: 2,
  STUCK_NFT: 3,
  RESOLVED: 4,
  VOIDED: 5,
} as const;

const MAX_ACQUISITIONS_TO_SCAN = 512n;

export const megaRipAbi = [
  {
    type: "function",
    name: "FWA",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "FWA_TOKEN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "FWA_REWARDS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "state",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "fundingEndsAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "totalDeposited",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pullsDone",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "estimatedPullsRemaining",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "crankBounty",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "acquisitionAt",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "requestId", type: "uint256" },
          { name: "listingId", type: "uint256" },
          { name: "collection", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "backing", type: "uint128" },
          { name: "bidEquiv", type: "uint128" },
          { name: "reserve", type: "uint128" },
          { name: "highBid", type: "uint128" },
          { name: "highBidder", type: "address" },
          { name: "requestedAt", type: "uint64" },
          { name: "allocatedAt", type: "uint64" },
          { name: "deadline", type: "uint64" },
          { name: "hardDeadline", type: "uint64" },
          { name: "discountBps", type: "uint16" },
          { name: "status", type: "uint8" },
          { name: "auctionOpen", type: "bool" },
          { name: "reserved", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "lock",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "pull",
    stateMutability: "nonpayable",
    inputs: [{ name: "maxPulls", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "BountyPaid",
    anonymous: false,
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

type MegaRipAcquisition = Awaited<
  ReturnType<typeof readMegaRipAcquisition>
>;

export function megaRipFundingCanLockInNextBlock(parameters: {
  readonly state: number;
  readonly totalDeposited: bigint;
  readonly fundingEndsAt: bigint;
  readonly parentTimestamp: bigint;
}): boolean {
  return (
    parameters.state === MEGA_RIP_STATE.FUNDING &&
    parameters.totalDeposited > 0n &&
    parameters.fundingEndsAt > 0n &&
    parameters.parentTimestamp + 12n >= parameters.fundingEndsAt
  );
}

export function megaRipFloorSettlementIsRewarded(parameters: {
  readonly acquisition: MegaRipAcquisition;
  readonly blockTimestamp: bigint;
}): boolean {
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const acquisition = parameters.acquisition;
  return (
    Number(acquisition.status) === MEGA_RIP_ACQUISITION_STATE.ALLOCATED &&
    acquisition.reserved &&
    acquisition.listingId !== 0n &&
    isAddressEqual(acquisition.highBidder, zeroAddress) &&
    (!acquisition.auctionOpen ||
      parameters.blockTimestamp >= acquisition.deadline)
  );
}

export interface MegaRipPlan {
  readonly jobs: readonly KeeperJob[];
  readonly minimumViablePrefix: number;
  readonly state: number;
  readonly fundingEndsAt: bigint;
  readonly totalDeposited: bigint;
  readonly pullsDone: bigint;
  readonly estimatedPullsRemaining: bigint;
}

export async function verifyMegaRipRuntime(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<void> {
  const [code, fwa, token, rewards] = await Promise.all([
    parameters.client.getCode({
      address: MEGA_RIP_ADDRESS,
      blockNumber: parameters.blockNumber,
    }),
    parameters.client.readContract({
      address: MEGA_RIP_ADDRESS,
      abi: megaRipAbi,
      functionName: "FWA",
      blockNumber: parameters.blockNumber,
    }),
    parameters.client.readContract({
      address: MEGA_RIP_ADDRESS,
      abi: megaRipAbi,
      functionName: "FWA_TOKEN",
      blockNumber: parameters.blockNumber,
    }),
    parameters.client.readContract({
      address: MEGA_RIP_ADDRESS,
      abi: megaRipAbi,
      functionName: "FWA_REWARDS",
      blockNumber: parameters.blockNumber,
    }),
  ]);
  if (
    code === undefined ||
    code === "0x" ||
    keccak256(code) !== MEGA_RIP_RUNTIME_CODE_HASH
  ) {
    throw new Error("MegaRip runtime does not match pinned code");
  }
  if (
    !isAddressEqual(fwa, PULL_POOL_FWA_ADDRESS) ||
    !isAddressEqual(token, FWA_TOKEN_ADDRESS) ||
    !isAddressEqual(rewards, MEGA_RIP_FWA_REWARDS_ADDRESS)
  ) {
    throw new Error("MegaRip immutable relationships are not canonical");
  }
}

async function readMegaRipAcquisition(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly index: bigint;
}) {
  return parameters.client.readContract({
    address: MEGA_RIP_ADDRESS,
    abi: megaRipAbi,
    functionName: "acquisitionAt",
    args: [parameters.index],
    blockNumber: parameters.blockNumber,
  });
}

function profitableJob(parameters: {
  readonly kind: "mega_rip_pull" | "mega_rip_settle";
  readonly label: string;
  readonly data: `0x${string}`;
  readonly gas: bigint;
  readonly reward: bigint;
  readonly maxFeePerGas: bigint;
  readonly minProfitWei: bigint;
  readonly builderBidBps: bigint;
}): KeeperJob | undefined {
  if (
    parameters.reward - parameters.gas * parameters.maxFeePerGas <
    requiredProfit(parameters.minProfitWei)
  ) {
    return undefined;
  }
  return {
    kind: parameters.kind,
    label: parameters.label,
    target: MEGA_RIP_ADDRESS,
    data: parameters.data,
    gas: parameters.gas,
    reward: { kind: "fixed", amountWei: parameters.reward },
    configuredBuilderBidBps: parameters.builderBidBps,
  };
}

export async function planMegaRipJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly minProfitWei: bigint;
  readonly builderBidBps: bigint;
}): Promise<MegaRipPlan> {
  await verifyMegaRipRuntime(parameters);
  const [stateRaw, fundingEndsAt, totalDeposited, pullsDone, remaining, bounty] =
    await Promise.all([
      parameters.client.readContract({
        address: MEGA_RIP_ADDRESS,
        abi: megaRipAbi,
        functionName: "state",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: MEGA_RIP_ADDRESS,
        abi: megaRipAbi,
        functionName: "fundingEndsAt",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: MEGA_RIP_ADDRESS,
        abi: megaRipAbi,
        functionName: "totalDeposited",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: MEGA_RIP_ADDRESS,
        abi: megaRipAbi,
        functionName: "pullsDone",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: MEGA_RIP_ADDRESS,
        abi: megaRipAbi,
        functionName: "estimatedPullsRemaining",
        blockNumber: parameters.blockNumber,
      }),
      parameters.client.readContract({
        address: MEGA_RIP_ADDRESS,
        abi: megaRipAbi,
        functionName: "crankBounty",
        blockNumber: parameters.blockNumber,
      }),
    ]);
  const state = Number(stateRaw);
  const base = {
    state,
    fundingEndsAt,
    totalDeposited,
    pullsDone,
    estimatedPullsRemaining: remaining,
  };

  if (
    megaRipFundingCanLockInNextBlock({
      state,
      totalDeposited,
      fundingEndsAt,
      parentTimestamp: parameters.blockTimestamp,
    })
  ) {
    const lockData = encodeFunctionData({
      abi: megaRipAbi,
      functionName: "lock",
    });
    const lockGas =
      parameters.blockTimestamp >= fundingEndsAt
        ? bufferedGas(
            await parameters.client.estimateGas({
              account: parameters.account,
              to: MEGA_RIP_ADDRESS,
              data: lockData,
              blockNumber: parameters.blockNumber,
            }),
            parameters.gasLimitMultiplierBps,
          )
        : BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT);
    return {
      ...base,
      jobs: [
        {
          kind: "mega_rip_lock",
          label: "mega_rip_lock",
          target: MEGA_RIP_ADDRESS,
          data: lockData,
          gas: lockGas,
          reward: { kind: "fixed", amountWei: 0n },
          configuredBuilderBidBps: parameters.builderBidBps,
          requiresBundleSimulation: true,
        },
        {
          kind: "mega_rip_pull",
          label: "mega_rip_pull:1:after_lock",
          target: MEGA_RIP_ADDRESS,
          data: encodeFunctionData({
            abi: megaRipAbi,
            functionName: "pull",
            args: [1n],
          }),
          gas: BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
          reward: { kind: "fixed", amountWei: bounty },
          configuredBuilderBidBps: parameters.builderBidBps,
          requiresBundleSimulation: true,
        },
      ],
      minimumViablePrefix: 2,
    };
  }

  if (state !== MEGA_RIP_STATE.PULLING) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }
  if (pullsDone > MAX_ACQUISITIONS_TO_SCAN) {
    throw new Error("MegaRip acquisition index exceeds bounded scan");
  }
  const acquisitions: MegaRipAcquisition[] = await Promise.all(
    Array.from({ length: Number(pullsDone) }, (_, index) =>
      readMegaRipAcquisition({
        client: parameters.client,
        blockNumber: parameters.blockNumber,
        index: BigInt(index),
      }),
    ),
  );
  const candidates: KeeperJob[] = [];
  const pending = acquisitions.filter(
    (acquisition) =>
      Number(acquisition.status) === MEGA_RIP_ACQUISITION_STATE.PENDING,
  );
  let pendingCanOnlyStayPending = true;
  if (pending.length > 0) {
    const statuses = await Promise.all(
      pending.map((acquisition) =>
        parameters.client.readContract({
          address: PULL_POOL_FWA_ADDRESS,
          abi: fwaAbi,
          functionName: "acquisitions",
          args: [acquisition.requestId],
          blockNumber: parameters.blockNumber,
        }),
      ),
    );
    pendingCanOnlyStayPending = statuses.every(
      (acquisition) =>
        Number(acquisition[4]) === ACQUISITION_STATUS.pending,
    );
  }
  if (remaining > 0n && pendingCanOnlyStayPending) {
    const data = encodeFunctionData({
      abi: megaRipAbi,
      functionName: "pull",
      args: [1n],
    });
    try {
      const gas = bufferedGas(
        await parameters.client.estimateGas({
          account: parameters.account,
          to: MEGA_RIP_ADDRESS,
          data,
          blockNumber: parameters.blockNumber,
        }),
        parameters.gasLimitMultiplierBps,
      );
      const job = profitableJob({
        kind: "mega_rip_pull",
        label: "mega_rip_pull:1",
        data,
        gas,
        reward: bounty,
        maxFeePerGas: parameters.maxFeePerGas,
        minProfitWei: parameters.minProfitWei,
        builderBidBps: parameters.builderBidBps,
      });
      if (job !== undefined) candidates.push(job);
    } catch (error) {
      log("debug", "mega_rip_pull_not_ready", {
        reason: errorMessage(error),
      });
    }
  }
  await Promise.all(
    acquisitions.map(async (acquisition) => {
      if (
        !megaRipFloorSettlementIsRewarded({
          acquisition,
          blockTimestamp: parameters.blockTimestamp,
        })
      ) {
        return;
      }
      const data = encodeFunctionData({
        abi: megaRipAbi,
        functionName: "settle",
        args: [acquisition.listingId],
      });
      try {
        const gas = bufferedGas(
          await parameters.client.estimateGas({
            account: parameters.account,
            to: MEGA_RIP_ADDRESS,
            data,
            blockNumber: parameters.blockNumber,
          }),
          parameters.gasLimitMultiplierBps,
        );
        const job = profitableJob({
          kind: "mega_rip_settle",
          label: `mega_rip_settle:${acquisition.listingId}`,
          data,
          gas,
          reward: bounty,
          maxFeePerGas: parameters.maxFeePerGas,
          minProfitWei: parameters.minProfitWei,
          builderBidBps: parameters.builderBidBps,
        });
        if (job !== undefined) candidates.push(job);
      } catch (error) {
        log("debug", "mega_rip_settle_not_ready", {
          listingId: acquisition.listingId.toString(),
          reason: errorMessage(error),
        });
      }
    }),
  );
  candidates.sort((left, right) => {
    const leftReward = left.reward.kind === "fixed" ? left.reward.amountWei : 0n;
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
    ...base,
    jobs: candidates.slice(0, 1),
    minimumViablePrefix: candidates.length === 0 ? 0 : 1,
  };
}
