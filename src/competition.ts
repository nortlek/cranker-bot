import {
  parseAbiItem,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
} from "viem";

import type { PrivateBatchOutcome } from "./keeper.js";

const crankedEvent = parseAbiItem(
  "event Cranked(uint256 indexed roundId, uint32 tickets, uint256 cost, uint256 fee, address indexed caller)",
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

export interface CompetitionTraceConfig {
  readonly url: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
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

  const [block, logsByOrder] = await Promise.all([
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
  ]);
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
      const totalCrankFees = transactionLogs.reduce(
        (total, entry) => total + entry.args.fee,
        0n,
      );
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
      const calculated = calculateWinningBidBps({
        totalCrankFees,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        baseFeePerGas,
        directBeneficiaryPayment: directPayment,
      });
      return {
        transactionHash,
        orderCount: transactionLogs.length,
        relevantOrders,
        totalCrankFees,
        priorityPayment: calculated.priorityPayment,
        directBeneficiaryPayment: directPayment,
        totalBuilderPayment: calculated.totalBuilderPayment,
        winningBidBps: calculated.winningBidBps,
      };
    }),
  );
}
