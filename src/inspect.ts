import {
  createPublicClient,
  formatEther,
  formatGwei,
  getAddress,
  http,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

import {
  factoryAbi,
  fwaAbi,
  poolAbi,
  standingOrderAbi,
} from "./abi.js";
import { nextBlockBaseFeePerGas } from "./base-fee.js";
import { quoteCompetitiveFees } from "./bidding.js";
import {
  CHAIN_ID,
  CREATED_ORDER_ADDRESS,
  CREATION_BLOCK,
  CREATION_TX,
} from "./constants.js";
import { loadConfig } from "./config.js";
import {
  acquisitionStatusName,
  estimatePoolBounty,
  ROUND_STATE,
} from "./lifecycle.js";

function roundStateName(state: number): string {
  switch (state) {
    case ROUND_STATE.none:
      return "none";
    case ROUND_STATE.open:
      return "open";
    case ROUND_STATE.pulling:
      return "pulling";
    case ROUND_STATE.claimable:
      return "claimable";
    case ROUND_STATE.settled:
      return "settled";
    case ROUND_STATE.refunding:
      return "refunding";
    default:
      return `unknown_${state}`;
  }
}

function timestampIso(timestamp: bigint): string | undefined {
  const maximumDateSeconds = 8_640_000_000n;
  if (timestamp === 0n || timestamp > maximumDateSeconds) {
    return undefined;
  }
  return new Date(Number(timestamp) * 1_000).toISOString();
}

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
  const [orders, roundCount, ethPendingRound, paused, poolConfig, fwa] =
    await Promise.all([
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
        functionName: "ethPendingRound",
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
      client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "FWA",
      }),
    ]);
  const [ticketsNeeded, currentRound] =
    roundCount === 0n
      ? [0n, undefined]
      : await Promise.all([
          client.readContract({
            address: pool,
            abi: poolAbi,
            functionName: "ticketsNeeded",
            args: [roundCount],
          }),
          client.readContract({
            address: pool,
            abi: poolAbi,
            functionName: "getRound",
            args: [roundCount],
          }),
        ]);
  let currentLifecycleAnalysis: Record<string, unknown> | undefined;
  if (ethPendingRound !== 0n) {
    try {
      const lifecycleRound =
        ethPendingRound === roundCount && currentRound !== undefined
          ? currentRound
          : await client.readContract({
              address: pool,
              abi: poolAbi,
              functionName: "getRound",
              args: [ethPendingRound],
            });
      if (lifecycleRound.fwaRequestId === 0n) {
        currentLifecycleAnalysis = {
          round: ethPendingRound.toString(),
          fwa,
          status: "missing_request_id",
        };
      } else {
        const acquisition = await client.readContract({
          address: fwa,
          abi: fwaAbi,
          functionName: "acquisitions",
          args: [lifecycleRound.fwaRequestId],
        });
        currentLifecycleAnalysis = {
          round: ethPendingRound.toString(),
          fwa,
          requestId: lifecycleRound.fwaRequestId.toString(),
          purchaser: acquisition[0],
          requestBlock: acquisition[1].toString(),
          priceEscrowedEth: formatEther(acquisition[2]),
          listingId: acquisition[3].toString(),
          status: acquisitionStatusName(Number(acquisition[4])),
          statusCode: acquisition[4],
        };
      }
    } catch (error) {
      currentLifecycleAnalysis = {
        round: ethPendingRound.toString(),
        fwa,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  let currentPullAnalysis: Record<string, unknown> | undefined;
  if (
    currentRound !== undefined &&
    currentRound.state === ROUND_STATE.open &&
    ticketsNeeded === 0n
  ) {
    const parent = await client.getBlock();
    if (parent.baseFeePerGas === null) {
      currentPullAnalysis = {
        eligible: true,
        error: "latest block did not include a base fee",
      };
    } else {
      const targetBaseFeePerGas = nextBlockBaseFeePerGas({
        parentBaseFeePerGas: parent.baseFeePerGas,
        parentGasUsed: parent.gasUsed,
        parentGasLimit: parent.gasLimit,
      });
      try {
        const estimatedGas = await client.estimateContractGas({
          account: config.simulationAccount,
          address: pool,
          abi: poolAbi,
          functionName: "pull",
          args: [roundCount],
        });
        const estimatedBounty = estimatePoolBounty({
          gasUsed: estimatedGas,
          baseFeePerGas: targetBaseFeePerGas,
          terms: {
            crankBountyCap: currentRound.crankBountyCap,
            bountyTipWei: currentRound.bountyTipWei,
          },
          estimateBps: config.poolPullBountyEstimateBps,
        });
        const quote = quoteCompetitiveFees({
          crankFee: estimatedBounty,
          simulatedGasUsed: estimatedGas,
          baseFeeAllowancePerGas: targetBaseFeePerGas,
          minimumPriorityFeePerGas: config.poolMinPriorityFeePerGas,
          builderBidBps: config.poolPullBuilderBidBps,
          maxFeePerGasCap: config.maxFeePerGas,
          minProfitWei: config.minProfitWei,
        });
        const zeroBaseFeeQuote = quoteCompetitiveFees({
          crankFee: estimatedBounty,
          simulatedGasUsed: estimatedGas,
          baseFeeAllowancePerGas: 0n,
          minimumPriorityFeePerGas:
            config.poolMinPriorityFeePerGas,
          builderBidBps: config.poolPullBuilderBidBps,
          maxFeePerGasCap: config.maxFeePerGas,
          minProfitWei: config.minProfitWei,
        });
        const profitableBaseFeeBudget =
          estimatedBounty -
          zeroBaseFeeQuote.builderPayment -
          zeroBaseFeeQuote.requiredProfit;
        const maximumProfitableBaseFeePerGas =
          profitableBaseFeeBudget > 0n
            ? profitableBaseFeeBudget / estimatedGas
            : 0n;
        currentPullAnalysis = {
          eligible: true,
          parentBlock: parent.number.toString(),
          targetBlock: (parent.number + 1n).toString(),
          targetBaseFeeGwei: formatGwei(targetBaseFeePerGas),
          maximumProfitableBaseFeeGwei: formatGwei(
            maximumProfitableBaseFeePerGas,
          ),
          estimatedGas: estimatedGas.toString(),
          estimatedBountyEth: formatEther(estimatedBounty),
          configuredBuilderBidBps:
            config.poolPullBuilderBidBps.toString(),
          quote: {
            profitable: quote.profitable,
            reason: quote.reason,
            maxFeePerGasGwei: formatGwei(quote.maxFeePerGas),
            maxPriorityFeePerGasGwei: formatGwei(
              quote.maxPriorityFeePerGas,
            ),
            expectedGasCostEth: formatEther(
              quote.expectedGasCost,
            ),
            expectedProfitEth: formatEther(
              quote.expectedProfit,
            ),
            effectiveBuilderBidBps:
              quote.effectiveBuilderBidBps.toString(),
            cappedByFeeCap: quote.cappedByFeeCap,
            cappedByProfit: quote.cappedByProfit,
          },
        };
      } catch (error) {
        currentPullAnalysis = {
          eligible: true,
          parentBlock: parent.number.toString(),
          targetBlock: (parent.number + 1n).toString(),
          targetBaseFeeGwei: formatGwei(targetBaseFeePerGas),
          error:
            error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

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
        ticketsNeeded: ticketsNeeded.toString(),
        pendingLifecycleRound: ethPendingRound.toString(),
        currentLifecycleAnalysis,
        currentPullAnalysis,
        currentRoundSnapshot:
          currentRound === undefined
            ? undefined
            : {
                state: roundStateName(currentRound.state),
                stateCode: currentRound.state,
                outcome: currentRound.outcome,
                fundingDeadline: currentRound.fundingDeadline.toString(),
                fundingDeadlineIso: timestampIso(
                  currentRound.fundingDeadline,
                ),
                ticketsSold: currentRound.ticketsSold,
                maxTickets: currentRound.maxTickets,
                escrowEth: formatEther(currentRound.escrow),
                feeOwedEth: formatEther(currentRound.feeOwed),
                refundPoolEth: formatEther(currentRound.refundPool),
                ethPot: formatEther(currentRound.ethPot),
                tokenPot: currentRound.tokenPot.toString(),
                fwaRequestId: currentRound.fwaRequestId.toString(),
                acquisitionSpentEth: formatEther(
                  currentRound.acquisitionSpent,
                ),
                bidValueEth: formatEther(currentRound.bidValue),
                listingId: currentRound.listingId.toString(),
                allocatedAt: currentRound.allocatedAt.toString(),
                allocatedAtIso: timestampIso(currentRound.allocatedAt),
                pullingAt: currentRound.pullingAt.toString(),
                pullingAtIso: timestampIso(currentRound.pullingAt),
                fwaResolved: currentRound.fwaResolved,
                feeClaimed: currentRound.feeClaimed,
                nftHeld: currentRound.nftHeld,
                rewardCredited: currentRound.rewardCredited,
                creditTaken: currentRound.creditTaken.toString(),
                rewardAmount: currentRound.rewardAmount.toString(),
              },
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
