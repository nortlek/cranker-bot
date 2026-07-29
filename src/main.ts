import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  type Account,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { AdaptiveBidController } from "./adaptive-bidding.js";
import { factoryAbi, vaultFactoryAbi } from "./abi.js";
import {
  aggregateBuilderBidBps,
  quoteCompetitiveFees,
} from "./bidding.js";
import { observeWinningCrankBids } from "./competition.js";
import { CHAIN_ID } from "./constants.js";
import { loadConfig } from "./config.js";
import { DiscordWebhookNotifier } from "./discord.js";
import { requiredProfit } from "./economics.js";
import {
  FlashbotsRelay,
  longestValidBundlePrefix,
  simulatedGasUsed,
  submitBundlePrefixLadder,
} from "./flashbots.js";
import {
  errorMessage,
  eth,
  gwei,
  log,
  setLogSink,
} from "./format.js";
import { PostgresAdaptiveBidPersistence } from "./postgres-adaptive-bidding.js";
import {
  estimatedJobReward,
  runKeeperPass,
  type StrategyContext,
} from "./strategy.js";
import {
  acquireSignerLease,
  type SignerLease,
} from "./singleton.js";
import {
  createPostgresEventSink,
  type BatchedEventSink,
} from "./telemetry.js";

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let discordNotifier: DiscordWebhookNotifier | undefined;
let telemetrySink: BatchedEventSink | undefined;
let signerLease: SignerLease | undefined;
let adaptiveBidController: AdaptiveBidController | undefined;

async function closeRuntimeResources(): Promise<void> {
  try {
    await Promise.all([
      adaptiveBidController?.close(),
      telemetrySink?.close(),
      discordNotifier?.flush(),
    ]);
  } finally {
    await signerLease?.release();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  discordNotifier =
    config.discordWebhookUrl === undefined
      ? undefined
      : new DiscordWebhookNotifier({
          url: config.discordWebhookUrl,
          timeoutMs: config.discordWebhookTimeoutMs,
        });
  telemetrySink =
    config.databaseUrl === undefined
      ? undefined
      : createPostgresEventSink({
          connectionString: config.databaseUrl,
          batchSize: config.telemetryBatchSize,
          flushIntervalMs: config.telemetryFlushMs,
          maximumQueueSize: config.telemetryMaxQueue,
          gitSha:
            process.env.RAILWAY_GIT_COMMIT_SHA ??
            process.env.GIT_SHA,
          instanceId:
            process.env.RAILWAY_REPLICA_ID ??
            process.env.HOSTNAME,
          report: (entry) => {
            console.warn(JSON.stringify(entry));
            discordNotifier?.notify(entry);
          },
        });
  setLogSink((entry) => {
    discordNotifier?.notify(entry);
    telemetrySink?.notify(entry);
  });
  if (!config.dryRun && config.databaseUrl !== undefined) {
    signerLease = await acquireSignerLease({
      connectionString: config.databaseUrl,
      onWaiting: () => {
        log("warn", "signer_lease_waiting");
      },
    });
    log("info", "signer_lease_acquired", {
      waitedMs: signerLease.waitedMs,
    });
  } else if (!config.dryRun) {
    log("warn", "signer_lease_disabled", {
      reason: "DATABASE_URL is not configured",
    });
  }
  if (
    config.adaptiveBidding &&
    config.submissionMode === "flashbots"
  ) {
    const policy = {
      baselineBidBps: config.builderBidBps,
      maximumBidBps: config.adaptiveBidMaxBps,
      lossStepBps: config.adaptiveBidStepBps,
      winDecayBps: config.adaptiveBidDecayBps,
      winsBeforeDecay: config.adaptiveBidWinStreak,
    };
    adaptiveBidController =
      config.databaseUrl === undefined
        ? await AdaptiveBidController.load(
            policy,
            config.adaptiveBidStatePath,
          )
        : await AdaptiveBidController.loadWithPersistence(
            policy,
            new PostgresAdaptiveBidPersistence(
              config.databaseUrl,
            ),
          );
  }
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`expected Ethereum mainnet chain id 1, received ${chainId}`);
  }

  const poolAddress = getAddress(
    await publicClient.readContract({
      address: config.factoryAddress,
      abi: factoryAbi,
      functionName: "POOL",
    }),
  );
  if (poolAddress !== config.expectedPoolAddress) {
    throw new Error(
      `factory pool ${poolAddress} does not match expected pool ${config.expectedPoolAddress}`,
    );
  }
  if (config.enableVaults) {
    const vaultPoolAddress = getAddress(
      await publicClient.readContract({
        address: config.vaultFactoryAddress,
        abi: vaultFactoryAbi,
        functionName: "POOL",
      }),
    );
    if (vaultPoolAddress !== config.expectedPoolAddress) {
      throw new Error(
        `vault factory pool ${vaultPoolAddress} does not match expected pool ${config.expectedPoolAddress}`,
      );
    }
  }

  let account: Account | Address = config.simulationAccount;
  let sendTransaction:
    StrategyContext["sendTransaction"] = undefined;
  let sendBatch: StrategyContext["sendBatch"] = undefined;
  let observePrivateBatch:
    StrategyContext["observePrivateBatch"] = undefined;
  if (config.privateKey !== undefined) {
    const signer = privateKeyToAccount(config.privateKey);
    account = signer;
    const walletClient = createWalletClient({
      account: signer,
      chain: mainnet,
      transport: http(config.rpcUrl, {
        retryCount: 3,
        retryDelay: 500,
        timeout: 20_000,
      }),
    });
    if (config.submissionMode === "public") {
      sendTransaction = async (request) =>
        walletClient.sendTransaction({
          to: request.target,
          data: request.data,
          gas: request.gas,
          maxFeePerGas: request.maxFeePerGas,
          maxPriorityFeePerGas: request.maxPriorityFeePerGas,
          nonce: request.nonce,
          value: 0n,
        });
    } else {
      const authAccount = privateKeyToAccount(
        config.flashbotsAuthPrivateKey ?? config.privateKey,
      );
      const relays = config.flashbotsRelayUrls.map(
        (url) =>
          new FlashbotsRelay({
            url,
            authAccount,
            timeoutMs: config.relayTimeoutMs,
          }),
      );
      sendBatch = async ({
        requests,
        targetBlock,
        minimumViablePrefix,
        bountyBaseFeePerGas,
      }) => {
        const limitedRequests = requests.slice(0, 100);
        const preliminaryTransactions = await Promise.all(
          limitedRequests.map((request) =>
            signer.signTransaction({
              chainId: mainnet.id,
              type: "eip1559",
              to: request.target,
              data: request.data,
              gas: request.gas,
              maxFeePerGas: request.maxFeePerGas,
              maxPriorityFeePerGas: request.maxPriorityFeePerGas,
              nonce: request.nonce,
              value: 0n,
            }),
          ),
        );
        const prefixLength = await longestValidBundlePrefix(
          relays[0]!,
          preliminaryTransactions,
          targetBlock,
        );
        if (prefixLength < minimumViablePrefix) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const preliminaryPrefix = preliminaryTransactions.slice(
          0,
          prefixLength,
        );
        const prefixRequests = limitedRequests.slice(0, prefixLength);
        const simulation = await relays[0]!.callBundle(
          preliminaryPrefix,
          targetBlock,
        );
        const gasUsed = simulatedGasUsed(simulation, prefixLength);
        const firstRequest = prefixRequests[0];
        if (firstRequest === undefined) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const baseFeeAllowancePerGas =
          firstRequest.maxFeePerGas -
          firstRequest.maxPriorityFeePerGas;
        let grossReward = 0n;
        let totalGasUsed = 0n;
        let hasPoolPullBid = false;
        let hasPoolReadyBid = false;
        let hasPoolFulfilledBid = false;
        let hasDefaultBid = false;
        let hasLiveBidSweepBid = false;
        let hasLiquityBid = false;
        let hasConvexBid = false;
        let minimumPriorityFeePerGas = 0n;
        const bidComponents: Array<{
          rewardWei: bigint;
          builderBidBps: bigint;
        }> = [];
        for (let index = 0; index < prefixRequests.length; index += 1) {
          const request = prefixRequests[index];
          const transactionGas = gasUsed[index];
          if (request === undefined || transactionGas === undefined) {
            throw new Error("bundle reward simulation was incomplete");
          }
          const rewardWei = estimatedJobReward({
            job: request,
            gasUsed: transactionGas,
            baseFeePerGas: bountyBaseFeePerGas,
            poolBountyEstimateBps:
              config.poolBountyEstimateBps,
          });
          grossReward += rewardWei;
          totalGasUsed += transactionGas;
          let requestBidBps: bigint;
          if (request.order !== undefined) {
            requestBidBps =
              adaptiveBidController?.currentBidBps(request.order) ??
              config.builderBidBps;
            hasDefaultBid = true;
            if (
              config.minPriorityFeePerGas >
              minimumPriorityFeePerGas
            ) {
              minimumPriorityFeePerGas =
                config.minPriorityFeePerGas;
            }
          } else if (
            request.poolBuilderBidPolicy !== undefined
          ) {
            switch (request.poolBuilderBidPolicy) {
              case "pool_pull":
                requestBidBps = config.poolPullBuilderBidBps;
                hasPoolPullBid = true;
                break;
              case "pool_ready":
                requestBidBps = config.poolBuilderBidBps;
                hasPoolReadyBid = true;
                break;
              case "pool_fulfilled":
                requestBidBps =
                  config.poolFulfilledBuilderBidBps;
                hasPoolFulfilledBid = true;
                break;
            }
            if (
              config.poolMinPriorityFeePerGas >
              minimumPriorityFeePerGas
            ) {
              minimumPriorityFeePerGas =
                config.poolMinPriorityFeePerGas;
            }
          } else if (request.kind === "live_bid_sweep") {
            requestBidBps =
              config.liveBidSweepBuilderBidBps;
            hasLiveBidSweepBid = true;
            if (
              config.liveBidSweepMinPriorityFeePerGas >
              minimumPriorityFeePerGas
            ) {
              minimumPriorityFeePerGas =
                config.liveBidSweepMinPriorityFeePerGas;
            }
          } else if (request.kind === "liquity_liquidation") {
            requestBidBps = config.liquityBuilderBidBps;
            hasLiquityBid = true;
            if (
              config.minPriorityFeePerGas >
              minimumPriorityFeePerGas
            ) {
              minimumPriorityFeePerGas =
                config.minPriorityFeePerGas;
            }
          } else if (
            request.kind === "convex_earmark" ||
            request.kind === "convex_kick"
          ) {
            requestBidBps = config.convexBuilderBidBps;
            hasConvexBid = true;
          } else {
            requestBidBps = config.builderBidBps;
            hasDefaultBid = true;
            if (
              config.minPriorityFeePerGas >
              minimumPriorityFeePerGas
            ) {
              minimumPriorityFeePerGas =
                config.minPriorityFeePerGas;
            }
          }
          bidComponents.push({
            rewardWei,
            builderBidBps: requestBidBps,
          });
        }
        const builderBidBps =
          aggregateBuilderBidBps(bidComponents);
        const bidPolicies = [
          ...(hasDefaultBid ? ["default"] : []),
          ...(hasPoolPullBid ? ["pool_pull"] : []),
          ...(hasPoolReadyBid ? ["pool_ready"] : []),
          ...(hasPoolFulfilledBid ? ["pool_fulfilled"] : []),
          ...(hasLiveBidSweepBid ? ["live_bid_sweep"] : []),
          ...(hasLiquityBid ? ["liquity"] : []),
          ...(hasConvexBid ? ["convex"] : []),
        ];
        const bidPolicy =
          bidPolicies.length > 1
            ? `weighted:${bidPolicies.join("+")}`
            : (bidPolicies[0] ?? "default");
        const quote = quoteCompetitiveFees({
          crankFee: grossReward,
          simulatedGasUsed: totalGasUsed,
          baseFeeAllowancePerGas,
          minimumPriorityFeePerGas,
          builderBidBps,
          maxFeePerGasCap: config.maxFeePerGas,
          minProfitWei: config.minProfitWei,
        });
        log(quote.profitable ? "info" : "warn", "builder_bid", {
          jobs: prefixRequests.length,
          kinds: JSON.stringify(
            prefixRequests.map((request) => request.kind),
          ),
          firstNonce: firstRequest.nonce,
          grossReward: eth(grossReward),
          simulatedGasUsed: totalGasUsed.toString(),
          bidPolicy,
          builderBidBps: builderBidBps.toString(),
          configuredPoolBuilderBidBps:
            config.poolBuilderBidBps.toString(),
          configuredPoolPullBuilderBidBps:
            config.poolPullBuilderBidBps.toString(),
          configuredPoolFulfilledBuilderBidBps:
            config.poolFulfilledBuilderBidBps.toString(),
          configuredLiveBidSweepBuilderBidBps:
            config.liveBidSweepBuilderBidBps.toString(),
          configuredLiquityBuilderBidBps:
            config.liquityBuilderBidBps.toString(),
          configuredConvexBuilderBidBps:
            config.convexBuilderBidBps.toString(),
          effectiveBuilderBidBps:
            quote.effectiveBuilderBidBps.toString(),
          builderPayment: eth(quote.builderPayment),
          maxFeePerGas: gwei(quote.maxFeePerGas),
          maxPriorityFeePerGas: gwei(
            quote.maxPriorityFeePerGas,
          ),
          expectedProfit: eth(quote.expectedProfit),
          requiredProfit: eth(quote.requiredProfit),
          cappedByProfit: quote.cappedByProfit,
          cappedByFeeCap: quote.cappedByFeeCap,
          accepted: quote.profitable,
          reason: quote.reason ?? "",
        });
        if (!quote.profitable) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const competitivelyPriced = prefixRequests.map((request) => ({
          ...request,
          maxFeePerGas: quote.maxFeePerGas,
          maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
        }));
        const competitiveTransactions = await Promise.all(
          competitivelyPriced.map((request) =>
            signer.signTransaction({
              chainId: mainnet.id,
              type: "eip1559",
              to: request.target,
              data: request.data,
              gas: request.gas,
              maxFeePerGas: request.maxFeePerGas,
              maxPriorityFeePerGas: request.maxPriorityFeePerGas,
              nonce: request.nonce,
              value: 0n,
            }),
          ),
        );
        const competitivePrefixLength =
          await longestValidBundlePrefix(
            relays[0]!,
            competitiveTransactions,
            targetBlock,
          );
        if (competitivePrefixLength < minimumViablePrefix) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const selected = competitiveTransactions.slice(
          0,
          competitivePrefixLength,
        );
        const selectedRequests = competitivelyPriced.slice(
          0,
          competitivePrefixLength,
        );
        const selectedGas = gasUsed.slice(0, competitivePrefixLength);
        const profitFloor = requiredProfit(config.minProfitWei);
        let minimumEconomicPrefix = minimumViablePrefix;
        let prefixReward = 0n;
        let prefixGas = 0n;
        for (let index = 0; index < selectedRequests.length; index += 1) {
          const request = selectedRequests[index];
          const transactionGas = selectedGas[index];
          if (request === undefined || transactionGas === undefined) {
            throw new Error("competitive prefix accounting was incomplete");
          }
          prefixReward += estimatedJobReward({
            job: request,
            gasUsed: transactionGas,
            baseFeePerGas: bountyBaseFeePerGas,
            poolBountyEstimateBps:
              config.poolBountyEstimateBps,
          });
          prefixGas += transactionGas;
          const count = index + 1;
          if (
            count >= minimumViablePrefix &&
            prefixReward - prefixGas * quote.maxFeePerGas <
              profitFloor
          ) {
            minimumEconomicPrefix = count + 1;
          }
        }
        if (minimumEconomicPrefix > selected.length) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const submissions = await submitBundlePrefixLadder(
          relays,
          selected,
          targetBlock,
          config.flashbotsBuilders,
          minimumEconomicPrefix,
        );
        const acceptedTransactionCount = Math.max(
          ...submissions.map(
            (submission) => submission.transactionCount,
          ),
        );
        const accepted = selected.slice(0, acceptedTransactionCount);
        const relayIndexes = new Set(
          submissions.map((submission) =>
            relays.findIndex(
              (relay) => relay.url === submission.relayUrl,
            ),
          ),
        );
        return {
          hashes: accepted.map((transaction) => keccak256(transaction)),
          targetBlock,
          relayCount: relayIndexes.size,
          bundleCount: submissions.length,
          bundleHashes: submissions.map(
            (submission) => submission.bundleHash,
          ),
          bundles: submissions.map((submission) => ({
            bundleHash: submission.bundleHash,
            relayIndex: relays.findIndex(
              (relay) => relay.url === submission.relayUrl,
            ),
            smart: submission.smart,
            transactionCount: submission.transactionCount,
          })),
        };
      };
      if (adaptiveBidController !== undefined) {
        const bidController = adaptiveBidController;
        observePrivateBatch = async (outcome) => {
          const includedCount = outcome.attempts.filter(
            (attempt) => attempt.included,
          ).length;
          const fullWin =
            includedCount === outcome.attempts.length;
          const observedBidsByOrder = new Map<string, bigint>();
          if (!fullWin) {
            try {
              const observations = await observeWinningCrankBids(
                publicClient,
                outcome,
                {
                  url: config.competitorTraceUrl,
                  timeoutMs: config.competitorTraceTimeoutMs,
                  retries: config.competitorTraceRetries,
                  retryDelayMs:
                    config.competitorTraceRetryDelayMs,
                },
              );
              for (const observation of observations) {
                log("info", "competitor_bid_observed", {
                  targetBlock: outcome.targetBlock.toString(),
                  transactionHash: observation.transactionHash,
                  orderCount: observation.orderCount,
                  relevantOrders: JSON.stringify(
                    observation.relevantOrders,
                  ),
                  totalCrankFees: eth(
                    observation.totalCrankFees,
                  ),
                  priorityPayment: eth(
                    observation.priorityPayment,
                  ),
                  directBeneficiaryPayment: eth(
                    observation.directBeneficiaryPayment,
                  ),
                  totalBuilderPayment: eth(
                    observation.totalBuilderPayment,
                  ),
                  winningBidBps:
                    observation.winningBidBps.toString(),
                });
                for (const order of observation.relevantOrders) {
                  const key = order.toLowerCase();
                  const existing = observedBidsByOrder.get(key);
                  if (
                    existing === undefined ||
                    observation.winningBidBps > existing
                  ) {
                    observedBidsByOrder.set(
                      key,
                      observation.winningBidBps,
                    );
                  }
                }
              }
            } catch (error) {
              log("warn", "competitor_bid_measurement_failed", {
                targetBlock: outcome.targetBlock.toString(),
                reason: errorMessage(error),
              });
            }
          }

          const adjustments =
            await bidController.observeBatch(
              outcome.attempts.map((attempt) => {
                const observedWinningBidBps =
                  observedBidsByOrder.get(
                    attempt.order.toLowerCase(),
                  );
                return {
                  order: attempt.order,
                  outcome: attempt.included
                    ? {
                        kind: "full_win" as const,
                        blockNumber: outcome.targetBlock,
                      }
                    : {
                        kind: "miss" as const,
                        blockNumber: outcome.targetBlock,
                        ...(observedWinningBidBps === undefined
                          ? {}
                          : { observedWinningBidBps }),
                      },
                };
              }),
          );
          for (const adjustment of adjustments) {
            const attempt = outcome.attempts.find(
              (candidate) =>
                candidate.order.toLowerCase() ===
                adjustment.order.toLowerCase(),
            );
            log("info", "adaptive_builder_bid_updated", {
              targetBlock: outcome.targetBlock.toString(),
              order: adjustment.order,
              outcome: attempt?.included ? "win" : "loss",
              observedWinningBidBps:
                observedBidsByOrder
                  .get(adjustment.order.toLowerCase())
                  ?.toString() ?? "",
              action: adjustment.action,
              previousBidBps:
                adjustment.previousBidBps.toString(),
              currentBidBps:
                adjustment.currentBidBps.toString(),
              consecutiveFullWins:
                adjustment.state.consecutiveFullWins,
            });
          }
          log("info", "adaptive_bid_batch_complete", {
            targetBlock: outcome.targetBlock.toString(),
            outcome: fullWin
              ? "full_win"
              : includedCount === 0
                ? "loss"
                : "partial_win",
            included: includedCount,
            attempted: outcome.attempts.length,
          });
        };
      }
    }
  } else if (!config.dryRun) {
    throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  }

  const accountAddress =
    typeof account === "string" ? account : account.address;
  const balance = await publicClient.getBalance({ address: accountAddress });
  log("info", "keeper_started", {
    chainId,
    factory: config.factoryAddress,
    vaultFactory: config.vaultFactoryAddress,
    pool: poolAddress,
    account: accountAddress,
    accountBalance: eth(balance),
    dryRun: config.dryRun,
    runOnce: config.runOnce,
    submissionMode: config.submissionMode,
    relayCount: config.flashbotsRelayUrls.length,
    builderCount: config.flashbotsBuilders.length,
    configuredBuilderBidBps: config.builderBidBps.toString(),
    configuredPoolBuilderBidBps:
      config.poolBuilderBidBps.toString(),
    configuredPoolPullBuilderBidBps:
      config.poolPullBuilderBidBps.toString(),
    configuredPoolFulfilledBuilderBidBps:
      config.poolFulfilledBuilderBidBps.toString(),
    configuredLiveBidSweepBuilderBidBps:
      config.liveBidSweepBuilderBidBps.toString(),
    configuredLiquityBuilderBidBps:
      config.liquityBuilderBidBps.toString(),
    configuredConvexBuilderBidBps:
      config.convexBuilderBidBps.toString(),
    poolMinPriorityFeePerGas: gwei(
      config.poolMinPriorityFeePerGas,
    ),
    liveBidSweepMinPriorityFeePerGas: gwei(
      config.liveBidSweepMinPriorityFeePerGas,
    ),
    maximumActiveBuilderBidBps:
      adaptiveBidController?.maximumActiveBidBps.toString() ??
      config.builderBidBps.toString(),
    adaptiveBidding: adaptiveBidController !== undefined,
    poolLifecycle: config.enablePoolLifecycle,
    vaults: config.enableVaults,
    buyback: config.enableBuyback,
    liveBidSweep: config.enableLiveBidSweep,
    liquityLiquidations: config.enableLiquityLiquidations,
    convexEarmarks: config.enableConvexEarmarks,
    convexKicks: config.enableConvexKicks,
    liveBidAdapter: config.liveBidAdapterAddress,
    poolBountyEstimateBps:
      config.poolBountyEstimateBps.toString(),
    discordNotifications: discordNotifier !== undefined,
    durableTelemetry: telemetrySink !== undefined,
  });

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let lastProcessedBlock = -1n;
  do {
    try {
      const block = await publicClient.getBlockNumber();
      if (block !== lastProcessedBlock) {
        lastProcessedBlock = block;
        log("debug", "new_block", { block: block.toString() });
        await runKeeperPass({
          publicClient,
          account,
          config,
          sendTransaction,
          sendBatch,
          observePrivateBatch,
        });
        if (config.runOnce) break;
      }
    } catch (error) {
      log("error", "keeper_pass_failed", { reason: errorMessage(error) });
      if (config.runOnce) throw error;
    }
    if (!stopping) await sleep(config.blockPollMs);
  } while (!stopping);

  log("info", "keeper_stopped");
  await closeRuntimeResources();
}

main().catch(async (error: unknown) => {
  log("error", "fatal", { reason: errorMessage(error) });
  await closeRuntimeResources();
  process.exitCode = 1;
});
