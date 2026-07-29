import {
  createPublicClient,
  decodeFunctionData,
  http,
  parseAbiItem,
  type Address,
  type Hash,
} from "viem";
import { mainnet } from "viem/chains";

import { poolAbi } from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import { POOL_ADDRESS } from "../src/constants.js";

const BLOCK_LOOKBACK = 20_000n;
const BLOCK_CHUNK = 1_000n;
const SAMPLE_SIZE = 50;

const pulledEvent = parseAbiItem(
  "event Pulled(uint256 indexed roundId,uint256 fwaRequestId,uint256 spent,address indexed cranker)",
);

interface Purchase {
  readonly hash: Hash;
  readonly sender: Address;
  readonly transactionIndex: number;
  readonly functionName:
    | "buyTickets"
    | "buyIntoCurrentRound";
  readonly roundId: bigint;
  readonly tickets: bigint;
  readonly recipient: Address;
  readonly maxPriorityFeePerGas: bigint | undefined;
}

function safeErrorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.discoveryRpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const latestBlock = await client.getBlockNumber();
  const firstBlock =
    latestBlock > BLOCK_LOOKBACK
      ? latestBlock - BLOCK_LOOKBACK
      : 0n;
  const logs: Array<
    Awaited<ReturnType<typeof client.getLogs>>[number]
  > = [];
  for (
    let fromBlock = firstBlock;
    fromBlock <= latestBlock;
    fromBlock += BLOCK_CHUNK
  ) {
    const toBlock =
      fromBlock + BLOCK_CHUNK - 1n > latestBlock
        ? latestBlock
        : fromBlock + BLOCK_CHUNK - 1n;
    logs.push(
      ...(await client.getLogs({
        address: POOL_ADDRESS,
        event: pulledEvent,
        fromBlock,
        toBlock,
        strict: true,
      })),
    );
  }
  const sample = logs.slice(-SAMPLE_SIZE);
  const observations: Array<{
    readonly roundId: bigint;
    readonly blockNumber: bigint;
    readonly pullHash: Hash;
    readonly pullSender: Address;
    readonly pullTarget: Address | null;
    readonly pullTransactionIndex: number;
    readonly purchases: readonly Purchase[];
  }> = [];
  for (const entry of sample) {
    if (
      entry.transactionHash === null ||
      entry.transactionIndex === null ||
      entry.args.roundId === undefined
    ) {
      continue;
    }
    const block = await client.getBlock({
      blockNumber: entry.blockNumber,
      includeTransactions: true,
    });
    const pullIndex = block.transactions.findIndex(
      (transaction) =>
        transaction.hash.toLowerCase() ===
        entry.transactionHash?.toLowerCase(),
    );
    if (pullIndex < 0) continue;
    const pullTransaction = block.transactions[pullIndex];
    if (pullTransaction === undefined) continue;
    const purchases: Purchase[] = [];
    for (let index = 0; index < pullIndex; index += 1) {
      const transaction = block.transactions[index];
      if (
        transaction === undefined ||
        transaction.to?.toLowerCase() !==
          POOL_ADDRESS.toLowerCase()
      ) {
        continue;
      }
      try {
        const decoded = decodeFunctionData({
          abi: poolAbi,
          data: transaction.input,
        });
        const args = decoded.args as
          | readonly unknown[]
          | undefined;
        if (
          decoded.functionName === "buyTickets" &&
          typeof args?.[0] === "bigint" &&
          (typeof args[1] === "bigint" ||
            typeof args[1] === "number") &&
          typeof args[2] === "string"
        ) {
          purchases.push({
            hash: transaction.hash,
            sender: transaction.from,
            transactionIndex: index,
            functionName: "buyTickets",
            roundId: args[0],
            tickets: BigInt(args[1]),
            recipient: args[2] as Address,
            maxPriorityFeePerGas:
              transaction.maxPriorityFeePerGas,
          });
        } else if (
          decoded.functionName === "buyIntoCurrentRound" &&
          (typeof args?.[0] === "bigint" ||
            typeof args?.[0] === "number") &&
          typeof args[1] === "string"
        ) {
          purchases.push({
            hash: transaction.hash,
            sender: transaction.from,
            transactionIndex: index,
            functionName: "buyIntoCurrentRound",
            roundId: entry.args.roundId,
            tickets: BigInt(args[0]),
            recipient: args[1] as Address,
            maxPriorityFeePerGas:
              transaction.maxPriorityFeePerGas,
          });
        }
      } catch {
        // Other pool entry points are irrelevant to final-ticket coverage.
      }
    }
    observations.push({
      roundId: entry.args.roundId,
      blockNumber: entry.blockNumber,
      pullHash: entry.transactionHash,
      pullSender: pullTransaction.from,
      pullTarget: pullTransaction.to,
      pullTransactionIndex: entry.transactionIndex,
      purchases: purchases.filter(
        (purchase) =>
          purchase.roundId === entry.args.roundId,
      ),
    });
  }

  const withSameBlockPurchase = observations.filter(
    (entry) => entry.purchases.length > 0,
  );
  const withMultiplePurchases = withSameBlockPurchase.filter(
    (entry) => entry.purchases.length > 1,
  );
  console.log(
    JSON.stringify({
      event: "pool_final_purchase_scan",
      fromBlock: firstBlock.toString(),
      toBlock: latestBlock.toString(),
      pulledEvents: logs.length,
      sampledPulls: observations.length,
      sameBlockPurchasePulls: withSameBlockPurchase.length,
      multiplePurchasePulls: withMultiplePurchases.length,
      observations: withSameBlockPurchase.map((entry) => ({
        roundId: entry.roundId.toString(),
        blockNumber: entry.blockNumber.toString(),
        pullHash: entry.pullHash,
        pullSender: entry.pullSender,
        pullTarget: entry.pullTarget,
        pullTransactionIndex: entry.pullTransactionIndex,
        purchaseCount: entry.purchases.length,
        totalTickets: entry.purchases
          .reduce(
            (total, purchase) =>
              total + purchase.tickets,
            0n,
          )
          .toString(),
        purchases: entry.purchases.map((purchase) => ({
          hash: purchase.hash,
          sender: purchase.sender,
          transactionIndex:
            purchase.transactionIndex,
          functionName: purchase.functionName,
          tickets: purchase.tickets.toString(),
          recipient: purchase.recipient,
          maxPriorityFeePerGas:
            purchase.maxPriorityFeePerGas?.toString(),
        })),
      })),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "pool_final_purchase_scan_failed",
      errorClass: safeErrorClass(error),
    }),
  );
  process.exitCode = 1;
});
