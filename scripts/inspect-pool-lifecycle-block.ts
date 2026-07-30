import {
  createPublicClient,
  formatEther,
  formatGwei,
  http,
  type Hash,
} from "viem";
import { mainnet } from "viem/chains";

import { observeWinningPoolLifecycleBids } from "../src/competition.js";
import { loadConfig } from "../src/config.js";

function requiredBigintArgument(name: string): bigint {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) =>
    value.startsWith(prefix),
  );
  if (argument === undefined) {
    throw new Error(`${prefix}<number> is required`);
  }
  const value = BigInt(argument.slice(prefix.length));
  if (value < 0n) {
    throw new Error(`${name} cannot be negative`);
  }
  return value;
}

function ourTransactionHashes(): readonly Hash[] {
  return process.argv
    .filter((value) => value.startsWith("--ours="))
    .map((value) => value.slice("--ours=".length))
    .map((value) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`invalid --ours transaction hash: ${value}`);
      }
      return value as Hash;
    });
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
  const block = requiredBigintArgument("block");
  const round = requiredBigintArgument("round");
  const observations =
    await observeWinningPoolLifecycleBids(client, {
      targetBlock: block,
      pool: config.expectedPoolAddress,
      lostRoundIds: [round],
      ourTransactionHashes: ourTransactionHashes(),
      traceConfig: {
        url: config.competitorTraceUrl,
        timeoutMs: config.competitorTraceTimeoutMs,
        retries: config.competitorTraceRetries,
        retryDelayMs: config.competitorTraceRetryDelayMs,
      },
    });
  const canonicalBlock = await client.getBlock({
    blockNumber: block,
  });
  const enriched = await Promise.all(
    observations.map(async (observation) => {
      const [receipt, transaction] = await Promise.all([
        client.getTransactionReceipt({
          hash: observation.transactionHash,
        }),
        client.getTransaction({
          hash: observation.transactionHash,
        }),
      ]);
      const gasCost =
        receipt.gasUsed * receipt.effectiveGasPrice;
      const baseFeeCost =
        receipt.gasUsed *
        (canonicalBlock.baseFeePerGas ?? 0n);
      const conservativeRetainedAfterKnownCosts =
        observation.grossPoolReward -
        gasCost -
        observation.directBeneficiaryPayment -
        transaction.value;
      return {
        transactionHash: observation.transactionHash,
        round: observation.roundId.toString(),
        sender: transaction.from,
        target: transaction.to,
        selector: transaction.input.slice(0, 10),
        cranker: observation.cranker,
        grossPoolRewardEth: formatEther(
          observation.grossPoolReward,
        ),
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceGwei: formatGwei(
          receipt.effectiveGasPrice,
        ),
        baseFeeCostEth: formatEther(baseFeeCost),
        gasCostEth: formatEther(gasCost),
        transactionValueEth: formatEther(transaction.value),
        priorityPaymentEth: formatEther(
          observation.priorityPayment,
        ),
        directBeneficiaryPaymentEth: formatEther(
          observation.directBeneficiaryPayment,
        ),
        totalBuilderPaymentEth: formatEther(
          observation.totalBuilderPayment,
        ),
        winningBidBpsUpperBound:
          observation.winningBidBpsUpperBound.toString(),
        conservativeRetainedAfterKnownCostsEth: formatEther(
          conservativeRetainedAfterKnownCosts,
        ),
      };
    }),
  );
  console.log(
    JSON.stringify({
      event: "pool_lifecycle_block_inspection",
      block: block.toString(),
      round: round.toString(),
      baseFeeGwei:
        canonicalBlock.baseFeePerGas === null
          ? undefined
          : formatGwei(canonicalBlock.baseFeePerGas),
      beneficiary: canonicalBlock.miner,
      pool: config.expectedPoolAddress,
      observations: enriched,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "pool_lifecycle_block_inspection_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
