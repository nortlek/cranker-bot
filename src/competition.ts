import {
  decodeEventLog,
  parseAbiItem,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import {
  factoryAbi,
  poolAbi,
  standingOrderAbi,
  vaultFactoryAbi,
} from "./abi.js";
import type { PrivateBatchOutcome } from "./keeper.js";

const crankedEvent = parseAbiItem(
  "event Cranked(uint256 indexed roundId, uint32 tickets, uint256 cost, uint256 fee, address indexed caller)",
);
const pulledEvent = parseAbiItem(
  "event Pulled(uint256 indexed roundId, uint256 fwaRequestId, uint256 spent, address indexed cranker)",
);
const BPS = 10_000n;

interface InternalOperation {
  readonly txHash?: string;
  readonly to?: string;
  readonly value?: string;
  readonly status?: boolean;
}

interface InternalOperationsResponse {
  readonly items?: readonly InternalOperation[];
}

export interface WinningBidObservation {
  readonly transactionHash: Hash;
  readonly orderCount: number;
  readonly relevantOrders: readonly Address[];
  readonly totalCrankFees: bigint;
  readonly priorityPayment: bigint;
  readonly directBeneficiaryPayment: bigint;
  readonly totalBuilderPayment: bigint;
  readonly winningBidBps: bigint;
}

export interface WinningPoolPullBidObservation {
  readonly transactionHash: Hash;
  readonly roundId: bigint;
  readonly cranker: Address;
  readonly grossPoolReward: bigint;
  readonly priorityPayment: bigint;
  readonly directBeneficiaryPayment: bigint;
  readonly totalBuilderPayment: bigint;
  /**
   * This is an upper bound when the same transaction earned rewards outside
   * PullPool, so it is recorded as evidence and is not fed into adaptive
   * bidding automatically.
   */
  readonly winningBidBpsUpperBound: bigint;
}

export interface CompetitionTraceConfig {
  readonly url: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
}

export interface CompetitionRegistryConfig {
  readonly factoryAddress: Address;
  readonly vaultFactoryAddress: Address | undefined;
}

export function competitionRegistryBlockNumber(
  targetBlock: bigint,
): bigint {
  if (targetBlock < 1n) {
    throw new Error(
      "competition target block must have a parent block",
    );
  }
  return targetBlock - 1n;
}

export function aggregateKnownCrankFees(
  logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: readonly Hex[];
  }[],
  knownOrders: readonly Address[],
): {
  readonly orderCount: number;
  readonly totalCrankFees: bigint;
} {
  const known = new Set(
    knownOrders.map((address) => address.toLowerCase()),
  );
  let orderCount = 0;
  let totalCrankFees = 0n;
  for (const entry of logs) {
    if (!known.has(entry.address.toLowerCase())) continue;
    try {
      const decoded = decodeEventLog({
        abi: standingOrderAbi,
        data: entry.data,
        topics: entry.topics as
          | []
          | [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "Cranked") continue;
      orderCount += 1;
      totalCrankFees += decoded.args.fee;
    } catch {
      // A known order may emit unrelated events in the same receipt.
    }
  }
  return { orderCount, totalCrankFees };
}

export function aggregatePoolCrankBounties(
  logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: readonly Hex[];
  }[],
  pool: Address,
  roundId: bigint,
): bigint {
  let total = 0n;
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: poolAbi,
        data: entry.data,
        topics: entry.topics as
          | []
          | [Hex, ...Hex[]],
      });
      if (
        decoded.eventName === "CrankBountyPaid" &&
        decoded.args.roundId === roundId
      ) {
        total += decoded.args.amount;
      }
    } catch {
      // PullPool emits unrelated lifecycle events in the same receipt.
    }
  }
  return total;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function calculateWinningBidBps(parameters: {
  readonly totalCrankFees: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly baseFeePerGas: bigint;
  readonly directBeneficiaryPayment: bigint;
}): {
  readonly priorityPayment: bigint;
  readonly totalBuilderPayment: bigint;
  readonly winningBidBps: bigint;
} {
  if (parameters.totalCrankFees <= 0n) {
    throw new Error("totalCrankFees must be positive");
  }
  const effectivePriorityFee =
    parameters.effectiveGasPrice > parameters.baseFeePerGas
      ? parameters.effectiveGasPrice - parameters.baseFeePerGas
      : 0n;
  const priorityPayment = effectivePriorityFee * parameters.gasUsed;
  const totalBuilderPayment =
    priorityPayment + parameters.directBeneficiaryPayment;
  return {
    priorityPayment,
    totalBuilderPayment,
    winningBidBps: ceilDivide(
      totalBuilderPayment * BPS,
      parameters.totalCrankFees,
    ),
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function directBeneficiaryPayment(
  transactionHash: Hash,
  beneficiary: Address,
  config: CompetitionTraceConfig,
): Promise<bigint> {
  const url = new URL(config.url);
  url.searchParams.set("txHash", transactionHash);
  url.searchParams.set("sort", "asc");

  for (let attempt = 1; attempt <= config.retries; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `competitor trace returned HTTP ${response.status}`,
      );
    }
    const payload =
      (await response.json()) as InternalOperationsResponse;
    const items = payload.items;
    if (items !== undefined && items.length > 0) {
      return items.reduce((total, operation) => {
        if (
          operation.status !== false &&
          operation.to?.toLowerCase() === beneficiary.toLowerCase() &&
          operation.value !== undefined
        ) {
          return total + BigInt(operation.value);
        }
        return total;
      }, 0n);
    }
    if (attempt < config.retries) {
      await delay(config.retryDelayMs);
    }
  }
  throw new Error(
    `competitor trace was not indexed after ${config.retries} attempts`,
  );
}

export async function observeWinningCrankBids(
  publicClient: PublicClient<Transport, Chain>,
  outcome: PrivateBatchOutcome,
  traceConfig: CompetitionTraceConfig,
  registryConfig: CompetitionRegistryConfig,
): Promise<readonly WinningBidObservation[]> {
  const lostOrderAddresses = new Map(
    outcome.attempts
      .filter((attempt) => !attempt.included)
      .map((attempt) => [
        attempt.order.toLowerCase(),
        attempt.order,
      ]),
  );
  if (lostOrderAddresses.size === 0) return [];
  const lostOrders = new Set(lostOrderAddresses.keys());
  const registryBlock = competitionRegistryBlockNumber(
    outcome.targetBlock,
  );

  const [block, logsByOrder, orders, vaults] = await Promise.all([
    publicClient.getBlock({ blockNumber: outcome.targetBlock }),
    Promise.all(
      [...lostOrderAddresses.values()].map((address) =>
        publicClient.getLogs({
          address,
          event: crankedEvent,
          fromBlock: outcome.targetBlock,
          toBlock: outcome.targetBlock,
          strict: true,
        }),
      ),
    ),
    publicClient.readContract({
      address: registryConfig.factoryAddress,
      abi: factoryAbi,
      functionName: "allOrders",
      blockNumber: registryBlock,
    }),
    registryConfig.vaultFactoryAddress === undefined
      ? Promise.resolve([])
      : publicClient.readContract({
          address: registryConfig.vaultFactoryAddress,
          abi: vaultFactoryAbi,
          functionName: "allVaults",
          blockNumber: registryBlock,
        }),
  ]);
  const knownOrders = [...orders, ...vaults];
  const logs = logsByOrder.flat();
  const ourHashes = new Set(
    outcome.attempts.map((attempt) => attempt.hash.toLowerCase()),
  );
  const grouped = new Map<
    Hash,
    Array<(typeof logs)[number]>
  >();
  const relevantTransactions = new Set<Hash>();
  for (const entry of logs) {
    if (entry.transactionHash === null) continue;
    const existing = grouped.get(entry.transactionHash) ?? [];
    existing.push(entry);
    grouped.set(entry.transactionHash, existing);
    if (
      lostOrders.has(entry.address.toLowerCase()) &&
      !ourHashes.has(entry.transactionHash.toLowerCase())
    ) {
      relevantTransactions.add(entry.transactionHash);
    }
  }

  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  return Promise.all(
    [...relevantTransactions].map(async (transactionHash) => {
      const transactionLogs = grouped.get(transactionHash) ?? [];
      const relevantOrders = [
        ...new Set(
          transactionLogs
            .filter((entry) =>
              lostOrders.has(entry.address.toLowerCase()),
            )
            .map((entry) => entry.address),
        ),
      ];
      const [receipt, directPayment] = await Promise.all([
        publicClient.getTransactionReceipt({
          hash: transactionHash,
        }),
        directBeneficiaryPayment(
          transactionHash,
          block.miner,
          traceConfig,
        ),
      ]);
      const aggregate = aggregateKnownCrankFees(
        receipt.logs,
        knownOrders,
      );
      if (aggregate.totalCrankFees <= 0n) {
        throw new Error(
          `competitor transaction ${transactionHash} emitted no known crank fees`,
        );
      }
      const calculated = calculateWinningBidBps({
        totalCrankFees: aggregate.totalCrankFees,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        baseFeePerGas,
        directBeneficiaryPayment: directPayment,
      });
      return {
        transactionHash,
        orderCount: aggregate.orderCount,
        relevantOrders,
        totalCrankFees: aggregate.totalCrankFees,
        priorityPayment: calculated.priorityPayment,
        directBeneficiaryPayment: directPayment,
        totalBuilderPayment: calculated.totalBuilderPayment,
        winningBidBps: calculated.winningBidBps,
      };
    }),
  );
}

export async function observeWinningPoolPullBids(
  publicClient: PublicClient<Transport, Chain>,
  parameters: {
    readonly targetBlock: bigint;
    readonly pool: Address;
    readonly ourTransactionHashes: readonly Hash[];
    readonly traceConfig: CompetitionTraceConfig;
  },
): Promise<readonly WinningPoolPullBidObservation[]> {
  const [block, pulledLogs] = await Promise.all([
    publicClient.getBlock({
      blockNumber: parameters.targetBlock,
    }),
    publicClient.getLogs({
      address: parameters.pool,
      event: pulledEvent,
      fromBlock: parameters.targetBlock,
      toBlock: parameters.targetBlock,
      strict: true,
    }),
  ]);
  const ourHashes = new Set(
    parameters.ourTransactionHashes.map((hash) =>
      hash.toLowerCase(),
    ),
  );
  const competitorPulls = pulledLogs.filter(
    (
      entry,
    ): entry is typeof entry & {
      readonly transactionHash: Hash;
    } =>
      entry.transactionHash !== null &&
      !ourHashes.has(entry.transactionHash.toLowerCase()),
  );
  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  return Promise.all(
    competitorPulls.map(async (entry) => {
      const [receipt, directPayment] = await Promise.all([
        publicClient.getTransactionReceipt({
          hash: entry.transactionHash,
        }),
        directBeneficiaryPayment(
          entry.transactionHash,
          block.miner,
          parameters.traceConfig,
        ),
      ]);
      const grossPoolReward = aggregatePoolCrankBounties(
        receipt.logs,
        parameters.pool,
        entry.args.roundId,
      );
      if (grossPoolReward <= 0n) {
        throw new Error(
          `competitor pool pull ${entry.transactionHash} emitted no round-${entry.args.roundId} crank bounty`,
        );
      }
      const calculated = calculateWinningBidBps({
        totalCrankFees: grossPoolReward,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        baseFeePerGas,
        directBeneficiaryPayment: directPayment,
      });
      return {
        transactionHash: entry.transactionHash,
        roundId: entry.args.roundId,
        cranker: entry.args.cranker,
        grossPoolReward,
        priorityPayment: calculated.priorityPayment,
        directBeneficiaryPayment: directPayment,
        totalBuilderPayment: calculated.totalBuilderPayment,
        winningBidBpsUpperBound: calculated.winningBidBps,
      };
    }),
  );
}
