import {
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import { ETHEREUM_TRANSACTION_GAS_LIMIT } from "./config.js";
import { PULL_POOL_FWA_ADDRESS } from "./constants.js";
import { bufferedGas } from "./economics.js";
import { errorMessage, log } from "./format.js";
import {
  encodeFwairDropExecution,
  FWAIR_DROP_EXECUTOR_DEPLOY_GAS_LIMIT,
  FWAIR_DROP_EXECUTOR_GAS_DISCOUNT,
  FWAIR_DROP_GAS_PRICE_CEILING,
  FWAIR_DROP_KEEPER_PROFIT,
  FWAIR_DROP_LAUNCH_ADDRESS,
  FWAIR_DROP_PRIORITY_FEE_CAP,
  FWAIR_DROP_ROUND_ADDRESS,
  FWAIR_DROP_RUNTIME_CODE_HASH,
  FWAIR_DROP_TARGET_ADDRESS,
  FWAIR_DROP_TERMS_HASH,
  fwairDropExecutorDeployment,
  fwairDropFwaAbi,
  fwairDropLaunchAbi,
  fwairDropRoundAbi,
} from "./fwair-drop-keeper-executor.js";
import {
  SINGLETON_FACTORY_ADDRESS,
  SINGLETON_FACTORY_RUNTIME_CODE,
} from "./standing-order-batch-executor.js";
import type { KeeperJob } from "./strategy.js";

export const FWAIR_DROP_STATE = {
  FUNDING: 0,
  HUNTING: 1,
  ENDING: 2,
  SETTLED: 3,
} as const;

export const FWAIR_DROP_PULL_STATUS = {
  NONE: 0,
  REQUESTED: 1,
  REVEALED: 2,
  RESCUE_PENDING: 3,
  SETTLED: 4,
  VOIDED: 5,
  FORCED_SALE: 6,
} as const;

const MAX_PULLS_TO_SCAN = 1_024n;
const verifiedRuntimeClients = new WeakSet<object>();

export interface FwairDropPlan {
  readonly state: number;
  readonly totalContributed: bigint;
  readonly pullCount: bigint;
  readonly outstanding: bigint;
  readonly pendingReadyToSync: bigint;
  readonly pendingSettles: bigint;
  readonly jobs: readonly KeeperJob[];
  readonly minimumViablePrefix: number;
}

export async function verifyFwairDropRuntime(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<void> {
  const cacheKey = parameters.client as object;
  if (verifiedRuntimeClients.has(cacheKey)) return;
  const code = await parameters.client.getCode({
    address: FWAIR_DROP_ROUND_ADDRESS,
    blockNumber: parameters.blockNumber,
  });
  if (code === undefined || keccak256(code) !== FWAIR_DROP_RUNTIME_CODE_HASH) {
    throw new Error("FWAIR drop runtime does not match pinned code");
  }
  const [fwa, target, terms, relationships, keeperProfit, priorityCap, gasCeiling] =
    await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "FWA" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "target" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "termsHash" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "fwairContracts" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "keeperProfit" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "priorityFeeCap" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "gasPriceCeiling" },
      ],
    });
  if (
    !isAddressEqual(fwa, PULL_POOL_FWA_ADDRESS) ||
    !isAddressEqual(target, FWAIR_DROP_TARGET_ADDRESS) ||
    terms !== FWAIR_DROP_TERMS_HASH ||
    !isAddressEqual(relationships[1], FWAIR_DROP_LAUNCH_ADDRESS) ||
    keeperProfit !== FWAIR_DROP_KEEPER_PROFIT ||
    priorityCap !== FWAIR_DROP_PRIORITY_FEE_CAP ||
    gasCeiling !== FWAIR_DROP_GAS_PRICE_CEILING
  ) {
    throw new Error("FWAIR drop immutable relationships are not canonical");
  }
  verifiedRuntimeClients.add(cacheKey);
}

async function executorState(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
}): Promise<{ address: Address; deployed: boolean; deployJob?: KeeperJob }> {
  const owner = typeof parameters.account === "string" ? parameters.account : parameters.account.address;
  const deployment = fwairDropExecutorDeployment(owner);
  const code = await parameters.client.getCode({ address: deployment.address, blockNumber: parameters.blockNumber });
  if (code !== undefined && code !== "0x") {
    if (keccak256(code) !== deployment.expectedRuntimeCodeHash) {
      throw new Error("FWAIR drop executor runtime does not match pinned code");
    }
    return { address: deployment.address, deployed: true };
  }
  const factoryCode = await parameters.client.getCode({ address: SINGLETON_FACTORY_ADDRESS, blockNumber: parameters.blockNumber });
  if (factoryCode !== SINGLETON_FACTORY_RUNTIME_CODE) {
    throw new Error("FWAIR drop executor factory runtime is not canonical");
  }
  return {
    address: deployment.address,
    deployed: false,
    deployJob: {
      kind: "fwair_drop_executor_deploy",
      label: "fwair_drop_executor_deploy",
      target: SINGLETON_FACTORY_ADDRESS,
      data: deployment.deployData,
      gas: FWAIR_DROP_EXECUTOR_DEPLOY_GAS_LIMIT,
      reward: { kind: "fixed", amountWei: 0n },
      configuredBuilderBidBps: 0n,
      requiresBundleSimulation: true,
    },
  };
}

async function activeWitness(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<bigint | undefined> {
  const [startTokenId, tokenCount] = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: [
      { address: FWAIR_DROP_LAUNCH_ADDRESS, abi: fwairDropLaunchAbi, functionName: "startTokenId" },
      { address: FWAIR_DROP_LAUNCH_ADDRESS, abi: fwairDropLaunchAbi, functionName: "tokenCount" },
    ],
  });
  const bounded = tokenCount > 32 ? 32 : tokenCount;
  const positions = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: Array.from({ length: bounded }, (_, index) => ({
      address: FWAIR_DROP_LAUNCH_ADDRESS,
      abi: fwairDropLaunchAbi,
      functionName: "positions" as const,
      args: [startTokenId + BigInt(index)] as const,
    })),
  });
  for (const position of positions) {
    const listingId = position[1];
    if (listingId === 0n) continue;
    const listing = await parameters.client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: fwairDropFwaAbi,
      functionName: "listings",
      args: [listingId],
      blockNumber: parameters.blockNumber,
    });
    if (isAddressEqual(listing[0], FWAIR_DROP_TARGET_ADDRESS) && listing[10] === 1) {
      return listingId;
    }
  }
  return undefined;
}

function reward(callCount: number): KeeperJob["reward"] {
  return {
    kind: "gas_reimbursement",
    flatProfitWei: FWAIR_DROP_KEEPER_PROFIT,
    callCount: BigInt(callCount),
    gasPriceCeiling: FWAIR_DROP_GAS_PRICE_CEILING,
    priorityFeeCap: FWAIR_DROP_PRIORITY_FEE_CAP,
    executorGasDiscount: FWAIR_DROP_EXECUTOR_GAS_DISCOUNT,
  };
}

async function buildJob(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly executor: Address;
  readonly executorDeployed: boolean;
  readonly calls: readonly Hex[];
  readonly label: string;
  readonly gasLimitMultiplierBps: bigint;
  readonly builderBidBps: bigint;
}): Promise<KeeperJob | undefined> {
  const data = encodeFwairDropExecution(
    parameters.calls,
    BigInt(parameters.calls.length) * FWAIR_DROP_KEEPER_PROFIT,
  );
  let gas = BigInt(ETHEREUM_TRANSACTION_GAS_LIMIT);
  if (parameters.executorDeployed) {
    try {
      gas = bufferedGas(
        await parameters.client.estimateGas({
          account: parameters.account,
          to: parameters.executor,
          data,
          blockNumber: parameters.blockNumber,
        }),
        parameters.gasLimitMultiplierBps,
      );
    } catch (error) {
      log("debug", "fwair_drop_action_not_ready", {
        action: parameters.label,
        reason: errorMessage(error),
      });
      return undefined;
    }
  }
  return {
    kind: "fwair_drop_crank",
    label: parameters.label,
    target: parameters.executor,
    data,
    gas,
    reward: reward(parameters.calls.length),
    configuredBuilderBidBps: parameters.builderBidBps,
    requiresBundleSimulation: true,
  };
}

export async function planFwairDropJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly builderBidBps: bigint;
}): Promise<FwairDropPlan> {
  await verifyFwairDropRuntime(parameters);
  const [stateRaw, totalContributed, pullCount, outstanding, pendingReadyToSync, pendingSettles] =
    await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "state" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "totalContributed" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "pullCount" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "outstanding" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "pendingReadyToSync" },
        { address: FWAIR_DROP_ROUND_ADDRESS, abi: fwairDropRoundAbi, functionName: "pendingSettles" },
      ],
    });
  const state = Number(stateRaw);
  const base = { state, totalContributed, pullCount, outstanding, pendingReadyToSync, pendingSettles };
  const executor = await executorState(parameters);
  const wrap = (job: KeeperJob | undefined): FwairDropPlan => {
    if (job === undefined) return { ...base, jobs: [], minimumViablePrefix: 0 };
    const jobs = [...(executor.deployJob === undefined ? [] : [executor.deployJob]), job];
    return { ...base, jobs, minimumViablePrefix: jobs.length };
  };

  if (state === FWAIR_DROP_STATE.FUNDING) {
    const [fullyFundedAt, launchedCount, tokenCount] = await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        { address: FWAIR_DROP_LAUNCH_ADDRESS, abi: fwairDropLaunchAbi, functionName: "fullyFundedAt" },
        { address: FWAIR_DROP_LAUNCH_ADDRESS, abi: fwairDropLaunchAbi, functionName: "launchedCount" },
        { address: FWAIR_DROP_LAUNCH_ADDRESS, abi: fwairDropLaunchAbi, functionName: "tokenCount" },
      ],
    });
    if (fullyFundedAt === 0n || tokenCount === 0 || launchedCount !== tokenCount) {
      return wrap(undefined);
    }
    const witness = await activeWitness(parameters);
    if (witness === undefined) return wrap(undefined);
    return wrap(await buildJob({
      ...parameters,
      executor: executor.address,
      executorDeployed: executor.deployed,
      calls: [
        encodeFunctionData({ abi: fwairDropRoundAbi, functionName: "lock" }),
        encodeFunctionData({ abi: fwairDropRoundAbi, functionName: "requestPull", args: [witness] }),
      ],
      label: `fwair_drop_lock_request:${witness}`,
    }));
  }

  if (state !== FWAIR_DROP_STATE.HUNTING && state !== FWAIR_DROP_STATE.ENDING) {
    return wrap(undefined);
  }
  if (pendingReadyToSync > 0n) {
    const count = pendingReadyToSync > 32n ? 32n : pendingReadyToSync;
    const job = await buildJob({
      ...parameters,
      executor: executor.address,
      executorDeployed: executor.deployed,
      calls: [encodeFunctionData({ abi: fwairDropRoundAbi, functionName: "syncReveals", args: [count] })],
      label: `fwair_drop_sync:${count}`,
    });
    if (job !== undefined) return wrap(job);
  }

  if (pullCount > MAX_PULLS_TO_SCAN) {
    throw new Error("FWAIR drop pull count exceeds bounded lifecycle scan");
  }
  if (pullCount > 0n) {
    const pulls = await parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: Array.from({ length: Number(pullCount) }, (_, index) => ({
        address: FWAIR_DROP_ROUND_ADDRESS,
        abi: fwairDropRoundAbi,
        functionName: "pullAt" as const,
        args: [BigInt(index)] as const,
      })),
    });
    for (let index = 0; index < pulls.length; index += 1) {
      const status = Number(pulls[index]!.status);
      const functionName =
        status === FWAIR_DROP_PULL_STATUS.REVEALED ? "settleBackstop" :
        status === FWAIR_DROP_PULL_STATUS.RESCUE_PENDING ? "rescueFinalize" :
        status === FWAIR_DROP_PULL_STATUS.VOIDED ? "recoverVoided" :
        status === FWAIR_DROP_PULL_STATUS.FORCED_SALE ? "abandonForced" : undefined;
      if (functionName === undefined) continue;
      const job = await buildJob({
        ...parameters,
        executor: executor.address,
        executorDeployed: executor.deployed,
        calls: [encodeFunctionData({ abi: fwairDropRoundAbi, functionName, args: [BigInt(index)] })],
        label: `fwair_drop_${functionName}:${index}`,
      });
      if (job !== undefined) return wrap(job);
    }
  }

  if (state === FWAIR_DROP_STATE.HUNTING) {
    const canRequest = await parameters.client.readContract({
      address: FWAIR_DROP_ROUND_ADDRESS,
      abi: fwairDropRoundAbi,
      functionName: "canRequest",
      blockNumber: parameters.blockNumber,
    });
    if (canRequest[0]) {
      const witness = await activeWitness(parameters);
      if (witness !== undefined) {
        const job = await buildJob({
          ...parameters,
          executor: executor.address,
          executorDeployed: executor.deployed,
          calls: [encodeFunctionData({ abi: fwairDropRoundAbi, functionName: "requestPull", args: [witness] })],
          label: `fwair_drop_request:${pullCount}:${witness}`,
        });
        if (job !== undefined) return wrap(job);
      }
    }
    if (outstanding > 0n) {
      const job = await buildJob({
        ...parameters,
        executor: executor.address,
        executorDeployed: executor.deployed,
        calls: [encodeFunctionData({ abi: fwairDropRoundAbi, functionName: "advanceBlockedPull", args: [4n] })],
        label: "fwair_drop_advance:4",
      });
      if (job !== undefined) return wrap(job);
    }
    const canEnd = await parameters.client.readContract({
      address: FWAIR_DROP_ROUND_ADDRESS,
      abi: fwairDropRoundAbi,
      functionName: "canEnd",
      blockNumber: parameters.blockNumber,
    });
    if (canEnd[0]) {
      return wrap(await buildJob({
        ...parameters,
        executor: executor.address,
        executorDeployed: executor.deployed,
        calls: [encodeFunctionData({ abi: fwairDropRoundAbi, functionName: "beginEnding" })],
        label: "fwair_drop_begin_ending",
      }));
    }
  }

  const canFinalize = await parameters.client.readContract({
    address: FWAIR_DROP_ROUND_ADDRESS,
    abi: fwairDropRoundAbi,
    functionName: "canFinalize",
    blockNumber: parameters.blockNumber,
  });
  return canFinalize
    ? wrap(await buildJob({
        ...parameters,
        executor: executor.address,
        executorDeployed: executor.deployed,
        calls: [encodeFunctionData({ abi: fwairDropRoundAbi, functionName: "finalizeEconomics" })],
        label: "fwair_drop_finalize",
      }))
    : wrap(undefined);
}
