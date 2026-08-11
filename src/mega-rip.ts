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
import {
  encodeMegaRipExactPull,
  encodeMegaRipExactSettlements,
  MEGA_RIP_KEEPER_EXECUTOR_DEPLOY_GAS_LIMIT,
  MEGA_RIP_KEEPER_EXECUTOR_MAX_CALLS,
  megaRipKeeperExecutorDeployment,
} from "./mega-rip-keeper-executor.js";
import {
  SINGLETON_FACTORY_ADDRESS,
  SINGLETON_FACTORY_RUNTIME_CODE,
} from "./standing-order-batch-executor.js";
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
// Current live-fork gas is ~13.6m for 40 pulls. This preserves room inside the
// keeper's 16,777,216 signing envelope; the executor's hard ABI bound remains
// 64 for lower-gas terminal batches.
const MAX_REWARDED_PULLS_PER_TRANSACTION = 40n;

// Terminal auctions are short-lived, independent first-to-land races. Ask the
// exact repricer for the entire reward and let its base-fee-aware profitability
// cap preserve MIN_PROFIT_ETH. Pulls retain their separate configured policy.
export const MEGA_RIP_SETTLEMENT_BUILDER_BID_BPS = 10_000n;

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
    name: "quoteAcquisitionPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fee", type: "uint256" },
      { name: "vrf", type: "uint256" },
      { name: "total", type: "uint256" },
    ],
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

export function megaRipTerminalSettlementIsEligible(parameters: {
  readonly acquisition: MegaRipAcquisition;
  readonly blockTimestamp: bigint;
}): boolean {
  const acquisition = parameters.acquisition;
  return (
    Number(acquisition.status) === MEGA_RIP_ACQUISITION_STATE.ALLOCATED &&
    acquisition.reserved &&
    acquisition.listingId !== 0n &&
    (!acquisition.auctionOpen ||
      parameters.blockTimestamp >= acquisition.deadline)
  );
}

export function megaRipInitialPullCount(parameters: {
  readonly totalDeposited: bigint;
  readonly acquisitionPrice: bigint;
  readonly bounty: bigint;
}): bigint {
  const unitCost = parameters.acquisitionPrice + parameters.bounty * 2n;
  return unitCost === 0n
    ? 0n
    : boundedMegaRipCallCount(parameters.totalDeposited / unitCost);
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

export async function readMegaRipAcquisitions(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly count: bigint;
}): Promise<readonly MegaRipAcquisition[]> {
  return parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: Array.from({ length: Number(parameters.count) }, (_, index) => ({
      address: MEGA_RIP_ADDRESS,
      abi: megaRipAbi,
      functionName: "acquisitionAt" as const,
      args: [BigInt(index)] as const,
    })),
  });
}

function profitableJob(parameters: {
  readonly kind:
    | "mega_rip_pull"
    | "mega_rip_settle"
    | "mega_rip_recover";
  readonly label: string;
  readonly target: Address;
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
    target: parameters.target,
    data: parameters.data,
    gas: parameters.gas,
    reward: { kind: "fixed", amountWei: parameters.reward },
    configuredBuilderBidBps: parameters.builderBidBps,
  };
}

async function megaRipExecutorState(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
}): Promise<{
  readonly address: Address;
  readonly deployed: boolean;
  readonly deployJob?: KeeperJob;
}> {
  const owner =
    typeof parameters.account === "string"
      ? parameters.account
      : parameters.account.address;
  const deployment = megaRipKeeperExecutorDeployment(owner);
  const code = await parameters.client.getCode({
    address: deployment.address,
    blockNumber: parameters.blockNumber,
  });
  if (code !== undefined && code !== "0x") {
    if (keccak256(code) !== deployment.expectedRuntimeCodeHash) {
      throw new Error("MegaRip executor runtime does not match pinned code");
    }
    return { address: deployment.address, deployed: true };
  }
  const factoryCode = await parameters.client.getCode({
    address: SINGLETON_FACTORY_ADDRESS,
    blockNumber: parameters.blockNumber,
  });
  if (factoryCode !== SINGLETON_FACTORY_RUNTIME_CODE) {
    throw new Error("MegaRip executor factory runtime is not canonical");
  }
  return {
    address: deployment.address,
    deployed: false,
    deployJob: {
      kind: "mega_rip_executor_deploy",
      label: "mega_rip_executor_deploy",
      target: SINGLETON_FACTORY_ADDRESS,
      data: deployment.deployData,
      gas: MEGA_RIP_KEEPER_EXECUTOR_DEPLOY_GAS_LIMIT,
      reward: { kind: "fixed", amountWei: 0n },
      requiresBundleSimulation: true,
    },
  };
}

function boundedMegaRipCallCount(count: bigint): bigint {
  return count < MAX_REWARDED_PULLS_PER_TRANSACTION
    ? count
    : MAX_REWARDED_PULLS_PER_TRANSACTION;
}

async function estimateRewardGatedJob(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly target: Address;
  readonly data: `0x${string}`;
  readonly gasLimitMultiplierBps: bigint;
}): Promise<bigint> {
  return bufferedGas(
    await parameters.client.estimateGas({
      account: parameters.account,
      to: parameters.target,
      data: parameters.data,
      blockNumber: parameters.blockNumber,
    }),
    parameters.gasLimitMultiplierBps,
  );
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
  const executor = await megaRipExecutorState({
    client: parameters.client,
    account: parameters.account,
    blockNumber: parameters.blockNumber,
  });

  if (
    megaRipFundingCanLockInNextBlock({
      state,
      totalDeposited,
      fundingEndsAt,
      parentTimestamp: parameters.blockTimestamp,
    })
  ) {
    const quote = await parameters.client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: megaRipAbi,
      functionName: "quoteAcquisitionPrice",
      blockNumber: parameters.blockNumber,
    });
    const pullCount = megaRipInitialPullCount({
      totalDeposited,
      acquisitionPrice: quote[2],
      bounty,
    });
    if (pullCount === 0n) {
      return { ...base, jobs: [], minimumViablePrefix: 0 };
    }
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
        ...(executor.deployJob === undefined
          ? []
          : [executor.deployJob]),
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
          label: `mega_rip_pull:${pullCount}:after_lock`,
          target: executor.address,
          data: encodeMegaRipExactPull(
            pullCount,
            pullCount * bounty,
          ),
          gas: BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT),
          reward: {
            kind: "fixed",
            amountWei: pullCount * bounty,
          },
          configuredBuilderBidBps: parameters.builderBidBps,
          requiresBundleSimulation: true,
        },
      ],
      minimumViablePrefix:
        executor.deployJob === undefined ? 2 : 3,
    };
  }

  if (state !== MEGA_RIP_STATE.PULLING) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }
  if (pullsDone > MAX_ACQUISITIONS_TO_SCAN) {
    throw new Error("MegaRip acquisition index exceeds bounded scan");
  }
  const acquisitions = await readMegaRipAcquisitions({
    client: parameters.client,
    blockNumber: parameters.blockNumber,
    count: pullsDone,
  });
  if (remaining > 0n) {
    let pullCount = boundedMegaRipCallCount(remaining);
    let gas: bigint | undefined;
    if (executor.deployed) {
      while (pullCount > 0n) {
        const data = encodeMegaRipExactPull(
          pullCount,
          pullCount * bounty,
        );
        try {
          gas = await estimateRewardGatedJob({
            client: parameters.client,
            account: parameters.account,
            blockNumber: parameters.blockNumber,
            target: executor.address,
            data,
            gasLimitMultiplierBps:
              parameters.gasLimitMultiplierBps,
          });
          break;
        } catch (error) {
          log("debug", "mega_rip_pull_batch_not_ready", {
            pullCount: pullCount.toString(),
            reason: errorMessage(error),
          });
          pullCount /= 2n;
        }
      }
    } else {
      gas = BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT);
    }
    if (pullCount > 0n && gas !== undefined) {
      const reward = pullCount * bounty;
      const pullJob = profitableJob({
        kind: "mega_rip_pull",
        label: `mega_rip_pull:${pullCount}`,
        target: executor.address,
        data: encodeMegaRipExactPull(pullCount, reward),
        gas,
        reward,
        maxFeePerGas: parameters.maxFeePerGas,
        minProfitWei: parameters.minProfitWei,
        builderBidBps: parameters.builderBidBps,
      });
      if (pullJob !== undefined) {
        const jobs = [
          ...(executor.deployJob === undefined
            ? []
            : [executor.deployJob]),
          {
            ...pullJob,
            ...(executor.deployed
              ? {}
              : { requiresBundleSimulation: true }),
          },
        ];
        return {
          ...base,
          jobs,
          minimumViablePrefix: jobs.length,
        };
      }
    }
  }
  const eligibleSettlements = acquisitions
    .filter((acquisition) =>
      megaRipTerminalSettlementIsEligible({
        acquisition,
        blockTimestamp: parameters.blockTimestamp,
      }),
    )
    .slice(0, Number(MEGA_RIP_KEEPER_EXECUTOR_MAX_CALLS));
  if (eligibleSettlements.length === 0) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }
  let settlementIds = eligibleSettlements.map(
    (acquisition) => acquisition.listingId,
  );
  if (executor.deployed) {
    const individuallyRewarded = await Promise.all(
      settlementIds.map(async (listingId) => {
        const data = encodeMegaRipExactSettlements(
          [listingId],
          bounty,
        );
        try {
          await estimateRewardGatedJob({
            client: parameters.client,
            account: parameters.account,
            blockNumber: parameters.blockNumber,
            target: executor.address,
            data,
            gasLimitMultiplierBps:
              parameters.gasLimitMultiplierBps,
          });
          return listingId;
        } catch (error) {
          log("debug", "mega_rip_settlement_not_rewarded", {
            listingId: listingId.toString(),
            reason: errorMessage(error),
          });
          return undefined;
        }
      }),
    );
    settlementIds = individuallyRewarded.filter(
      (listingId): listingId is bigint => listingId !== undefined,
    );
  } else {
    settlementIds = settlementIds.slice(0, 1);
  }
  if (settlementIds.length === 0) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }
  let settlementGas = BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT);
  if (executor.deployed) {
    while (settlementIds.length > 0) {
      const reward = bounty * BigInt(settlementIds.length);
      try {
        settlementGas = await estimateRewardGatedJob({
          client: parameters.client,
          account: parameters.account,
          blockNumber: parameters.blockNumber,
          target: executor.address,
          data: encodeMegaRipExactSettlements(
            settlementIds,
            reward,
          ),
          gasLimitMultiplierBps:
            parameters.gasLimitMultiplierBps,
        });
        break;
      } catch (error) {
        log("debug", "mega_rip_settlement_batch_not_ready", {
          settlements: settlementIds.length,
          reason: errorMessage(error),
        });
        settlementIds = settlementIds.slice(
          0,
          Math.floor(settlementIds.length / 2),
        );
      }
    }
  }
  if (settlementIds.length === 0) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }
  const settlementReward = bounty * BigInt(settlementIds.length);
  const settlementJob = profitableJob({
    kind: "mega_rip_settle",
    label: `mega_rip_settle:${settlementIds.length}`,
    target: executor.address,
    data: encodeMegaRipExactSettlements(
      settlementIds,
      settlementReward,
    ),
    gas: settlementGas,
    reward: settlementReward,
    maxFeePerGas: parameters.maxFeePerGas,
    minProfitWei: parameters.minProfitWei,
    builderBidBps: MEGA_RIP_SETTLEMENT_BUILDER_BID_BPS,
  });
  if (settlementJob === undefined) {
    return { ...base, jobs: [], minimumViablePrefix: 0 };
  }
  const jobs = [
    ...(executor.deployJob === undefined ? [] : [executor.deployJob]),
    {
      ...settlementJob,
      ...(executor.deployed
        ? {}
        : { requiresBundleSimulation: true }),
    },
  ];
  return {
    ...base,
    jobs,
    minimumViablePrefix: jobs.length,
  };
}
