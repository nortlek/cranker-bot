import {
  createPublicClient,
  formatEther,
  formatGwei,
  getAddress,
  http,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

import { factoryAbi, poolAbi, standingOrderAbi } from "./abi.js";
import {
  CHAIN_ID,
  CREATED_ORDER_ADDRESS,
  CREATION_BLOCK,
  CREATION_TX,
} from "./constants.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`expected mainnet chain id 1, received ${chainId}`);
  }

  const pool = getAddress(
    await client.readContract({
      address: config.factoryAddress,
      abi: factoryAbi,
      functionName: "POOL",
    }),
  );
  const [orders, roundCount, paused, poolConfig] = await Promise.all([
    client.readContract({
      address: config.factoryAddress,
      abi: factoryAbi,
      functionName: "allOrders",
    }),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "roundCount",
    }),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "paused",
    }),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "config",
    }),
  ]);

  const rows = await Promise.all(
    orders.map(async (order: Address) => {
      const [reads, balance] = await Promise.all([
        client.multicall({
          allowFailure: false,
          contracts: [
            {
              address: order,
              abi: standingOrderAbi,
              functionName: "OWNER",
            },
            {
              address: order,
              abi: standingOrderAbi,
              functionName: "ticketsPerRound",
            },
            {
              address: order,
              abi: standingOrderAbi,
              functionName: "crankFee",
            },
            {
              address: order,
              abi: standingOrderAbi,
              functionName: "lastRoundBought",
            },
          ],
        }),
        client.getBalance({ address: order }),
      ]);
      const [owner, ticketsPerRound, crankFee, lastRoundBought] = reads;
      return {
        transactionOrder:
          order.toLowerCase() === CREATED_ORDER_ADDRESS.toLowerCase()
            ? "yes"
            : "",
        order,
        owner,
        ticketsPerRound: ticketsPerRound.toString(),
        crankFeeEth: formatEther(crankFee),
        lastRoundBought: lastRoundBought.toString(),
        balanceEth: formatEther(balance),
      };
    }),
  );

  console.log(
    JSON.stringify(
      {
        chainId,
        factory: config.factoryAddress,
        pool,
        poolPaused: paused,
        currentRound: roundCount.toString(),
        poolConfig: {
          ticketPriceEth: formatEther(poolConfig[0]),
          fundingDurationSeconds: poolConfig[1].toString(),
          headroomBps: poolConfig[2],
          feeCapBps: poolConfig[3],
          crankBountyCapEth: formatEther(poolConfig[4]),
          vrfAllowanceEth: formatEther(poolConfig[5]),
          bountyTipGwei: formatGwei(poolConfig[6]),
          stallTimeoutSeconds: poolConfig[7].toString(),
          maxTickets: poolConfig[8],
        },
        examinedTransaction: {
          hash: CREATION_TX,
          block: CREATION_BLOCK.toString(),
          factory: config.factoryAddress,
          createdOrder: CREATED_ORDER_ADDRESS,
          ticketsPerRound: 1,
          crankFeeEth: "0.0003",
          openingDepositEth: "0.053",
        },
      },
      null,
      2,
    ),
  );
  console.table(rows);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
