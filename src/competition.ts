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
const crankBountyPaidEvent = parseAbiItem(
  "event CrankBountyPaid(uint256 indexed roundId, address indexed cranker, uint256 amount)",
);
const BPS = 10_000n;

export interface RpcTransactionTrace {
  readonly action?: {
    readonly to?: string;
    readonly value?: string;
  };
  readonly error?: string | null;
}

export interface WinningBidObservation {
  readonly transactionHash: Hash;
  readonly orderCount: number;
  readonly relevantOrders: readonly Address[];
  readonly totalCrankFees: bigint;
  readonly gasUsed: bigint;
  readonly baseFeePerGas: bigint;
  readonly effectiveGasPrice: bigint;
  readonly baseGasCost: bigint;
  readonly totalTransactionGasCost: bigint;
  readonly priorityPayment: bigint;
  readonly directBeneficiaryPayment: bigint;
  readonly totalBuilderPayment: bigint;
  /**
   * Crank fees minus the receipt's full gas cost and direct beneficiary
   * payment. This deliberately does not claim to be the competitor's wallet
   * P&L because an otherwise eligible transaction could still have an
   * unobserved source of value outside the known Cranked events.
   */
  readonly retainedFromKnownCrankFees: bigint;
  readonly winningBidBps: bigint;
  readonly adaptiveBidEligible: boolean;
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

export interface WinningPoolLifecycleBidObservation {
  readonly transactionHash: Hash;
  readonly roundId: bigint;
  readonly cranker: Address;
  readonly grossPoolReward: bigint;
  readonly priorityPayment: bigint;
  readonly directBeneficiaryPayment: bigint;
  readonly totalBuilderPayment: bigint;
  /**
   * This is an upper bound when the same transaction earned a processor,
   * standing-order, or other reward outside the pool lifecycle calls.
   */
  readonly winningBidBpsUpperBound: bigint;
}

export interface CompetitionRegistryConfig {
  readonly factoryAddresses: readonly Address[];
  readonly vaultFactoryAddress: Address | undefined;
  readonly poolAddresses: readonly Address[];
}

/**
 * Some providers surface a just-published block's temporary state
 * unavailability as an untyped top-level Error instead of viem's typed RPC
 * error chain. Keep this deliberately exact so malformed requests and other
 * permanent failures are never retried as publication lag.
 */
export function isTransientCompetitionObservationError(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.split("\n", 1)[0]?.trim() ?? "";
  return (
    /^Missing or invalid parameters\.?$/i.test(message) ||
    /^Invalid parameters were provided to the RPC method\.?$/i.test(
      message,
    )
  );
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

export function receiptHasPoolCrankBounty(
  logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: readonly Hex[];
  }[],
  poolAddresses: readonly Address[],
): boolean {
  const pools = new Set(
    poolAddresses.map((address) => address.toLowerCase()),
  );
  return logs.some((entry) => {
    if (!pools.has(entry.address.toLowerCase())) return false;
    try {
      const decoded = decodeEventLog({
        abi: poolAbi,
        data: entry.data,
        topics: entry.topics as [] | [Hex, ...Hex[]],
      });
      return decoded.eventName === "CrankBountyPaid";
    } catch {
      return false;
    }
  });
}

export function filterRelevantPoolPulls(
  entries: readonly {
    readonly transactionHash: Hash | null;
    readonly args: {
      readonly roundId: bigint;
      readonly cranker: Address;
    };
  }[],
  parameters: {
    readonly lostRoundIds: readonly bigint[];
    readonly ourTransactionHashes: readonly Hash[];
  },
): readonly {
  readonly transactionHash: Hash;
  readonly roundId: bigint;
  readonly cranker: Address;
}[] {
  const lostRounds = new Set(
    parameters.lostRoundIds.map((roundId) =>
      roundId.toString(),
    ),
  );
  const ourHashes = new Set(
    parameters.ourTransactionHashes.map((hash) =>
      hash.toLowerCase(),
    ),
  );
  return entries.flatMap((entry) => {
    if (
      entry.transactionHash === null ||
      !lostRounds.has(entry.args.roundId.toString()) ||
      ourHashes.has(entry.transactionHash.toLowerCase())
    ) {
      return [];
    }
    return [
      {
        transactionHash: entry.transactionHash,
        roundId: entry.args.roundId,
        cranker: entry.args.cranker,
      },
    ];
  });
}

export function groupRelevantPoolLifecycleBounties(
  entries: readonly {
    readonly transactionHash: Hash | null;
    readonly args: {
      readonly roundId: bigint;
      readonly cranker: Address;
      readonly amount: bigint;
    };
  }[],
  parameters: {
    readonly lostRoundIds: readonly bigint[];
    readonly ourTransactionHashes: readonly Hash[];
  },
): readonly {
  readonly transactionHash: Hash;
  readonly roundId: bigint;
  readonly cranker: Address;
  readonly grossPoolReward: bigint;
}[] {
  const lostRounds = new Set(
    parameters.lostRoundIds.map((roundId) =>
      roundId.toString(),
    ),
  );
  const ourHashes = new Set(
    parameters.ourTransactionHashes.map((hash) =>
      hash.toLowerCase(),
    ),
  );
  const grouped = new Map<
    string,
    {
      readonly transactionHash: Hash;
      readonly roundId: bigint;
      readonly cranker: Address;
      grossPoolReward: bigint;
    }
  >();
  for (const entry of entries) {
    if (
      entry.transactionHash === null ||
      !lostRounds.has(entry.args.roundId.toString()) ||
      ourHashes.has(entry.transactionHash.toLowerCase())
    ) {
      continue;
    }
    const key =
      `${entry.transactionHash.toLowerCase()}:${entry.args.roundId}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        transactionHash: entry.transactionHash,
        roundId: entry.args.roundId,
        cranker: entry.args.cranker,
        grossPoolReward: entry.args.amount,
      });
      continue;
    }
    if (
      existing.cranker.toLowerCase() !==
      entry.args.cranker.toLowerCase()
    ) {
      throw new Error(
        `pool lifecycle transaction ${entry.transactionHash} paid multiple crankers for round ${entry.args.roundId}`,
      );
    }
    existing.grossPoolReward += entry.args.amount;
  }
  return [...grouped.values()];
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
  readonly baseGasCost: bigint;
  readonly totalTransactionGasCost: bigint;
  readonly priorityPayment: bigint;
  readonly totalBuilderPayment: bigint;
  readonly retainedFromKnownCrankFees: bigint;
  readonly winningBidBps: bigint;
} {
  if (parameters.totalCrankFees <= 0n) {
    throw new Error("totalCrankFees must be positive");
  }
  const effectivePriorityFee =
    parameters.effectiveGasPrice > parameters.baseFeePerGas
      ? parameters.effectiveGasPrice - parameters.baseFeePerGas
      : 0n;
  const baseGasCost = parameters.baseFeePerGas * parameters.gasUsed;
  const totalTransactionGasCost =
    parameters.effectiveGasPrice * parameters.gasUsed;
  const priorityPayment = effectivePriorityFee * parameters.gasUsed;
  const totalBuilderPayment =
    priorityPayment + parameters.directBeneficiaryPayment;
  return {
    baseGasCost,
    totalTransactionGasCost,
    priorityPayment,
    totalBuilderPayment,
    retainedFromKnownCrankFees:
      parameters.totalCrankFees -
      totalTransactionGasCost -
      parameters.directBeneficiaryPayment,
    winningBidBps: ceilDivide(
      totalBuilderPayment * BPS,
      parameters.totalCrankFees,
    ),
  };
}

export function directBeneficiaryPaymentFromTraces(parameters: {
  readonly traces: readonly RpcTransactionTrace[];
  readonly beneficiary: Address;
}): bigint {
  return parameters.traces.reduce((total, trace) => {
    if (
      trace.error == null &&
      trace.action?.to?.toLowerCase() ===
        parameters.beneficiary.toLowerCase() &&
      trace.action.value !== undefined
    ) {
      return total + BigInt(trace.action.value);
    }
    return total;
  }, 0n);
}

async function directBeneficiaryPayment(
  traceClient: PublicClient<Transport, Chain>,
  transactionHash: Hash,
  beneficiary: Address,
): Promise<bigint> {
  let traces: readonly RpcTransactionTrace[];
  try {
    traces = (await traceClient.request({
      method: "trace_transaction",
      params: [transactionHash],
    } as never)) as readonly RpcTransactionTrace[];
  } catch (error) {
    throw new Error("competitor RPC trace failed", {
      cause: error,
    });
  }
  if (traces.length === 0) {
    throw new Error("competitor RPC trace returned no frames");
  }
  return directBeneficiaryPaymentFromTraces({
    traces,
    beneficiary,
  });
}

export async function observeWinningCrankBids(
  publicClient: PublicClient<Transport, Chain>,
  traceClient: PublicClient<Transport, Chain>,
  outcome: PrivateBatchOutcome,
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

  const [block, logsByOrder, ordersByFactory, vaults] =
    await Promise.all([
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
      Promise.all(
        registryConfig.factoryAddresses.map((factoryAddress) =>
          publicClient.readContract({
            address: factoryAddress,
            abi: factoryAbi,
            functionName: "allOrders",
            blockNumber: registryBlock,
          }),
        ),
      ),
      registryConfig.vaultFactoryAddress === undefined
        ? Promise.resolve([])
        : publicClient.readContract({
            address: registryConfig.vaultFactoryAddress,
            abi: vaultFactoryAbi,
            functionName: "allVaults",
            blockNumber: registryBlock,
          }),
    ]);
  const knownOrders = [
    ...new Map(
      [...ordersByFactory.flat(), ...vaults].map((address) => [
        address.toLowerCase(),
        address,
      ]),
    ).values(),
  ];
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
          traceClient,
          transactionHash,
          block.miner,
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
        gasUsed: receipt.gasUsed,
        baseFeePerGas,
        effectiveGasPrice: receipt.effectiveGasPrice,
        baseGasCost: calculated.baseGasCost,
        totalTransactionGasCost:
          calculated.totalTransactionGasCost,
        priorityPayment: calculated.priorityPayment,
        directBeneficiaryPayment: directPayment,
        totalBuilderPayment: calculated.totalBuilderPayment,
        retainedFromKnownCrankFees:
          calculated.retainedFromKnownCrankFees,
        winningBidBps: calculated.winningBidBps,
        adaptiveBidEligible: !receiptHasPoolCrankBounty(
          receipt.logs,
          registryConfig.poolAddresses,
        ),
      };
    }),
  );
}

export async function observeWinningPoolPullBids(
  publicClient: PublicClient<Transport, Chain>,
  parameters: {
    readonly targetBlock: bigint;
    readonly pool: Address;
    readonly lostRoundIds: readonly bigint[];
    readonly ourTransactionHashes: readonly Hash[];
    readonly traceClient: PublicClient<Transport, Chain>;
  },
): Promise<readonly WinningPoolPullBidObservation[]> {
  if (parameters.lostRoundIds.length === 0) return [];
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
  const competitorPulls = filterRelevantPoolPulls(
    pulledLogs,
    {
      lostRoundIds: parameters.lostRoundIds,
      ourTransactionHashes: parameters.ourTransactionHashes,
    },
  );
  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  return Promise.all(
    competitorPulls.map(async (entry) => {
      const [receipt, directPayment] = await Promise.all([
        publicClient.getTransactionReceipt({
          hash: entry.transactionHash,
        }),
        directBeneficiaryPayment(
          parameters.traceClient,
          entry.transactionHash,
          block.miner,
        ),
      ]);
      const grossPoolReward = aggregatePoolCrankBounties(
        receipt.logs,
        parameters.pool,
        entry.roundId,
      );
      if (grossPoolReward <= 0n) {
        throw new Error(
          `competitor pool pull ${entry.transactionHash} emitted no round-${entry.roundId} crank bounty`,
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
        roundId: entry.roundId,
        cranker: entry.cranker,
        grossPoolReward,
        priorityPayment: calculated.priorityPayment,
        directBeneficiaryPayment: directPayment,
        totalBuilderPayment: calculated.totalBuilderPayment,
        winningBidBpsUpperBound: calculated.winningBidBps,
      };
    }),
  );
}

export async function observeWinningPoolLifecycleBids(
  publicClient: PublicClient<Transport, Chain>,
  parameters: {
    readonly targetBlock: bigint;
    readonly pool: Address;
    readonly lostRoundIds: readonly bigint[];
    readonly ourTransactionHashes: readonly Hash[];
    readonly traceClient: PublicClient<Transport, Chain>;
  },
): Promise<readonly WinningPoolLifecycleBidObservation[]> {
  if (parameters.lostRoundIds.length === 0) return [];
  const [block, bountyLogs] = await Promise.all([
    publicClient.getBlock({
      blockNumber: parameters.targetBlock,
    }),
    publicClient.getLogs({
      address: parameters.pool,
      event: crankBountyPaidEvent,
      fromBlock: parameters.targetBlock,
      toBlock: parameters.targetBlock,
      strict: true,
    }),
  ]);
  const candidates = groupRelevantPoolLifecycleBounties(
    bountyLogs,
    {
      lostRoundIds: parameters.lostRoundIds,
      ourTransactionHashes: parameters.ourTransactionHashes,
    },
  );
  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  return Promise.all(
    candidates.map(async (candidate) => {
      const [receipt, directPayment] = await Promise.all([
        publicClient.getTransactionReceipt({
          hash: candidate.transactionHash,
        }),
        directBeneficiaryPayment(
          parameters.traceClient,
          candidate.transactionHash,
          block.miner,
        ),
      ]);
      if (candidate.grossPoolReward <= 0n) {
        throw new Error(
          `competitor pool lifecycle ${candidate.transactionHash} emitted no round-${candidate.roundId} crank bounty`,
        );
      }
      const calculated = calculateWinningBidBps({
        totalCrankFees: candidate.grossPoolReward,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        baseFeePerGas,
        directBeneficiaryPayment: directPayment,
      });
      return {
        transactionHash: candidate.transactionHash,
        roundId: candidate.roundId,
        cranker: candidate.cranker,
        grossPoolReward: candidate.grossPoolReward,
        priorityPayment: calculated.priorityPayment,
        directBeneficiaryPayment: directPayment,
        totalBuilderPayment: calculated.totalBuilderPayment,
        winningBidBpsUpperBound: calculated.winningBidBps,
      };
    }),
  );
}
