import {
  getAddress,
  keccak256,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import {
  factoryAbi,
  poolV2Abi,
  poolV2LifecycleAbi,
} from "./abi.js";
import type { KeeperConfig } from "./config.js";
import {
  FWA_TOKEN_ADDRESS,
  PULL_POOL_FWA_ADDRESS,
  PULL_POOL_V2_ADDRESS,
  PULL_POOL_V2_COMPONENTS,
  PULL_POOL_V2_DEPLOYMENT_BLOCK,
  PULL_POOL_V2_FACTORY_ADDRESS,
} from "./constants.js";
import { ROUND_STATE } from "./lifecycle.js";

export interface PullPoolV2LaunchState {
  readonly paused: boolean;
  readonly deprecated: boolean;
  readonly roundCount: bigint;
  readonly bytecodeValid: boolean;
  readonly relationshipsValid: boolean;
  readonly selected: boolean;
}

export interface PullPoolV2ActivationSignal {
  readonly paused: boolean;
  readonly deprecated: boolean;
  readonly roundCount: bigint;
  readonly activated: boolean;
}

export interface PullPoolV2RoundSnapshot {
  readonly roundId: bigint;
  readonly ticketPrice: bigint;
  readonly crankBountyCap: bigint;
  readonly bountyTipWei: bigint;
  readonly fwaRequestId: bigint;
  readonly state: number;
  readonly ticketsNeeded: bigint;
}

export interface PullPoolV2Routing {
  readonly activeRoundIds: readonly bigint[];
  readonly lifecycleRounds: readonly PullPoolV2RoundSnapshot[];
  readonly fundingRound: PullPoolV2RoundSnapshot | undefined;
  readonly currentOpenRound: bigint;
  readonly pendingPullCount: bigint;
}

type LifecycleEvent = {
  readonly eventName:
    | "RoundOpened"
    | "RoundSettled"
    | "RoundVoided";
  readonly args: { readonly roundId: bigint };
};

const V2_EVENT_SCAN_BLOCK_RANGE = 2_000n;

let activeRoundIndex:
  | {
      throughBlock: bigint;
      active: Set<bigint>;
    }
  | undefined;

export function activePullPoolV2RoundIds(
  logs: readonly LifecycleEvent[],
): bigint[] {
  const active = new Set<bigint>();
  for (const entry of logs) {
    if (entry.eventName === "RoundOpened") {
      active.add(entry.args.roundId);
    } else {
      active.delete(entry.args.roundId);
    }
  }
  return [...active].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

async function readLifecycleEvents(
  client: PublicClient<Transport, Chain>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<LifecycleEvent[]> {
  if (fromBlock > toBlock) return [];
  const ranges: Array<{
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }> = [];
  for (
    let start = fromBlock;
    start <= toBlock;
    start += V2_EVENT_SCAN_BLOCK_RANGE
  ) {
    const end =
      start + V2_EVENT_SCAN_BLOCK_RANGE - 1n < toBlock
        ? start + V2_EVENT_SCAN_BLOCK_RANGE - 1n
        : toBlock;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  const chunks = await Promise.all(
    ranges.map((range) =>
      client.getLogs({
        address: PULL_POOL_V2_ADDRESS,
        events: poolV2LifecycleAbi,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        strict: true,
      }),
    ),
  );
  return chunks.flatMap((logs) =>
    logs.map((entry) => ({
      eventName: entry.eventName,
      args: { roundId: entry.args.roundId },
    })),
  );
}

export function pullPoolV2ShouldBeSelected(parameters: {
  readonly paused: boolean;
  readonly deprecated: boolean;
  readonly roundCount: bigint;
  readonly bytecodeValid: boolean;
  readonly relationshipsValid: boolean;
}): boolean {
  return (
    parameters.bytecodeValid &&
    parameters.relationshipsValid &&
    !parameters.deprecated &&
    (!parameters.paused || parameters.roundCount > 0n)
  );
}

export function configurePullPoolV2(
  config: KeeperConfig,
): KeeperConfig {
  return {
    ...config,
    poolVersion: "v2",
    factoryAddress: PULL_POOL_V2_FACTORY_ADDRESS,
    expectedPoolAddress: PULL_POOL_V2_ADDRESS,
    // The V1 vault registry and both pending-event decoders are version
    // specific. Confirmed-head V2 lifecycle and order calls remain enabled.
    enableVaults: false,
    enablePendingFundingBackruns: false,
    enablePendingFwaFulfillmentBackruns: false,
    // Shared non-pool lanes remain owned by the primary V1 adapter. Running
    // them here would duplicate discovery and could create two same-nonce
    // alternatives. V2 contributes only its own orders and pool lifecycle to
    // the merged pass.
    enableBuyback: false,
    enableLiveBidSweep: false,
    enableLiquityLiquidations: false,
    enableConvexEarmarks: false,
    enableConvexKicks: false,
    enableStakeDaoCurveHarvests: false,
    enableFirmReplenishments: false,
    // V1's high fulfilled-state bid is learned from V1 competition. Start
    // the new pool at the independently configured low ready-cycle bid until
    // V2 receipts provide evidence for a separate controller.
    poolFulfilledBuilderBidBps: config.poolBuilderBidBps,
  };
}

export async function readPullPoolV2LaunchState(
  client: PublicClient<Transport, Chain>,
  blockNumber?: bigint,
): Promise<PullPoolV2LaunchState> {
  const atBlock =
    blockNumber === undefined ? {} : { blockNumber };
  const [
    codes,
    paused,
    deprecated,
    roundCount,
    factoryPool,
    fwa,
    fwaToken,
  ] = await Promise.all([
    Promise.all(
      PULL_POOL_V2_COMPONENTS.map((component) =>
        client.getBytecode({
          address: component.address,
          ...atBlock,
        }),
      ),
    ),
    client.readContract({
      address: PULL_POOL_V2_ADDRESS,
      abi: poolV2Abi,
      functionName: "paused",
      ...atBlock,
    }),
    client.readContract({
      address: PULL_POOL_V2_ADDRESS,
      abi: poolV2Abi,
      functionName: "deprecated",
      ...atBlock,
    }),
    client.readContract({
      address: PULL_POOL_V2_ADDRESS,
      abi: poolV2Abi,
      functionName: "roundCount",
      ...atBlock,
    }),
    client.readContract({
      address: PULL_POOL_V2_FACTORY_ADDRESS,
      abi: factoryAbi,
      functionName: "POOL",
      ...atBlock,
    }),
    client.readContract({
      address: PULL_POOL_V2_ADDRESS,
      abi: poolV2Abi,
      functionName: "FWA",
      ...atBlock,
    }),
    client.readContract({
      address: PULL_POOL_V2_ADDRESS,
      abi: poolV2Abi,
      functionName: "FWA_TOKEN",
      ...atBlock,
    }),
  ]);
  const bytecodeValid = PULL_POOL_V2_COMPONENTS.every(
    (component, index) => {
      const code = codes[index];
      return (
        code !== undefined &&
        code !== "0x" &&
        keccak256(code) === component.codeHash
      );
    },
  );
  const relationshipsValid =
    getAddress(factoryPool) === PULL_POOL_V2_ADDRESS &&
    getAddress(fwa) === PULL_POOL_FWA_ADDRESS &&
    getAddress(fwaToken) === FWA_TOKEN_ADDRESS;
  return {
    paused,
    deprecated,
    roundCount,
    bytecodeValid,
    relationshipsValid,
    selected: pullPoolV2ShouldBeSelected({
      paused,
      deprecated,
      roundCount,
      bytecodeValid,
      relationshipsValid,
    }),
  };
}

export async function readPullPoolV2ActivationSignal(
  client: PublicClient<Transport, Chain>,
  blockNumber: bigint,
): Promise<PullPoolV2ActivationSignal> {
  const [paused, deprecated, roundCount] =
    await client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        {
          address: PULL_POOL_V2_ADDRESS,
          abi: poolV2Abi,
          functionName: "paused",
        },
        {
          address: PULL_POOL_V2_ADDRESS,
          abi: poolV2Abi,
          functionName: "deprecated",
        },
        {
          address: PULL_POOL_V2_ADDRESS,
          abi: poolV2Abi,
          functionName: "roundCount",
        },
      ],
    });
  return {
    paused,
    deprecated,
    roundCount,
    activated: !paused || roundCount > 0n,
  };
}

export async function readPullPoolV2Routing(
  client: PublicClient<Transport, Chain>,
  blockNumber: bigint,
): Promise<PullPoolV2Routing> {
  if (
    activeRoundIndex === undefined ||
    blockNumber < activeRoundIndex.throughBlock
  ) {
    activeRoundIndex = {
      throughBlock: PULL_POOL_V2_DEPLOYMENT_BLOCK - 1n,
      active: new Set(),
    };
  }
  const fromBlock = activeRoundIndex.throughBlock + 1n;
  const [logs, currentOpenRound, pendingPullCount] =
    await Promise.all([
      fromBlock > blockNumber
        ? Promise.resolve([])
        : readLifecycleEvents(
            client,
            fromBlock,
            blockNumber,
          ),
      client.readContract({
        address: PULL_POOL_V2_ADDRESS,
        abi: poolV2Abi,
        functionName: "currentOpenRound",
        blockNumber,
      }),
      client.readContract({
        address: PULL_POOL_V2_ADDRESS,
        abi: poolV2Abi,
        functionName: "pendingPullCount",
        blockNumber,
      }),
    ]);
  const nextActive = new Set(activeRoundIndex.active);
  for (const entry of logs) {
    if (entry.eventName === "RoundOpened") {
      nextActive.add(entry.args.roundId);
    } else {
      nextActive.delete(entry.args.roundId);
    }
  }
  activeRoundIndex = {
    throughBlock: blockNumber,
    active: nextActive,
  };
  const activeRoundIds = [...nextActive].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const rounds = await Promise.all(
    activeRoundIds.map(async (roundId) => {
      const [round, ticketsNeeded] = await Promise.all([
        client.readContract({
          address: PULL_POOL_V2_ADDRESS,
          abi: poolV2Abi,
          functionName: "getRound",
          args: [roundId],
          blockNumber,
        }),
        client.readContract({
          address: PULL_POOL_V2_ADDRESS,
          abi: poolV2Abi,
          functionName: "ticketsNeeded",
          args: [roundId],
          blockNumber,
        }),
      ]);
      return {
        roundId,
        ticketPrice: round.ticketPrice,
        crankBountyCap: round.crankBountyCap,
        bountyTipWei: round.bountyTipWei,
        fwaRequestId: round.fwaRequestId,
        state: round.state,
        ticketsNeeded,
      } satisfies PullPoolV2RoundSnapshot;
    }),
  );
  const pullingCount = rounds.filter(
    (round) => round.state === ROUND_STATE.pulling,
  ).length;
  if (BigInt(pullingCount) !== pendingPullCount) {
    throw new Error(
      `PullPool V2 event index found ${pullingCount} pulling rounds but pendingPullCount is ${pendingPullCount}`,
    );
  }
  if (
    rounds.some(
      (round) =>
        round.state !== ROUND_STATE.open &&
        round.state !== ROUND_STATE.pulling &&
        round.state !== ROUND_STATE.claimable,
    )
  ) {
    throw new Error(
      "PullPool V2 event index retained a terminal round",
    );
  }
  if (
    currentOpenRound > 0n &&
    !rounds.some(
      (round) =>
        round.roundId === currentOpenRound &&
        round.state === ROUND_STATE.open &&
        round.ticketsNeeded > 0n,
    )
  ) {
    throw new Error(
      "PullPool V2 currentOpenRound disagrees with the event index",
    );
  }
  const lifecycleRounds = rounds.filter(
    (round) =>
      round.state === ROUND_STATE.pulling ||
      round.state === ROUND_STATE.claimable,
  );
  const coveredOpenRound = rounds.find(
    (round) =>
      round.state === ROUND_STATE.open &&
      round.ticketsNeeded === 0n,
  );
  const fundingRound =
    coveredOpenRound ??
    rounds.find((round) => round.roundId === currentOpenRound);
  return {
    activeRoundIds,
    lifecycleRounds,
    fundingRound,
    currentOpenRound,
    pendingPullCount,
  };
}
