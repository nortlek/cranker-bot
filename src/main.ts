import { randomUUID } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  webSocket,
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
  selectMostProfitablePrefix,
} from "./bidding.js";
import { observeWinningCrankBids } from "./competition.js";
import { CHAIN_ID } from "./constants.js";
import { loadConfig } from "./config.js";
import { DiscordWebhookNotifier } from "./discord.js";
import { requiredProfit } from "./economics.js";
import {
  FlashbotsRelay,
  longestValidBundlePrefix,
  simulateLongestValidBundlePrefix,
  simulatedGasUsed,
  submitBundlePrefixLadder,
} from "./flashbots.js";
import {
  errorMessage,
  eth,
  gwei,
  log,
  setLogSink,
  withLogContext,
} from "./format.js";
import { LatestHeadSignal } from "./heads.js";
import { PostgresAdaptiveBidPersistence } from "./postgres-adaptive-bidding.js";
import {
  estimatedJobReward,
  runKeeperPass,
  scheduleColdPlannerRefresh,
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

function relayFailureClass(reason: string | undefined): string {
  if (reason === undefined) return "";
  if (/timeout|timed out|aborted/i.test(reason)) return "timeout";
  const httpStatus = /HTTP ([1-5][0-9]{2})/.exec(reason)?.[1];
  if (httpStatus !== undefined) return `http_${httpStatus}`;
  const rpcCode = /failed \((-?[0-9]+)\)/.exec(reason)?.[1];
  if (rpcCode !== undefined) return `rpc_${rpcCode}`;
  return "relay_error";
}

let discordNotifier: DiscordWebhookNotifier | undefined;
let telemetrySink: BatchedEventSink | undefined;
let signerLease: SignerLease | undefined;
let adaptiveBidController: AdaptiveBidController | undefined;
let signerLeaseFailure: Error | undefined;
let closeHeadSubscription: (() => Promise<void>) | undefined;

class SignerLeaseLostError extends Error {
  constructor(cause: unknown) {
    super(`signer lease lost: ${errorMessage(cause)}`, { cause });
    this.name = "SignerLeaseLostError";
  }
}

class HeadSubscriptionStaleError extends Error {
  constructor(lastObservedBlock: bigint, currentHttpBlock: bigint) {
    super(
      `head subscription stalled at ${lastObservedBlock}; HTTP reached ${currentHttpBlock}`,
    );
    this.name = "HeadSubscriptionStaleError";
  }
}

async function assertSignerLeaseHeld(): Promise<void> {
  if (signerLeaseFailure !== undefined) {
    throw signerLeaseFailure;
  }
  if (signerLease === undefined) {
    signerLeaseFailure = new SignerLeaseLostError(
      "signer lease is unavailable",
    );
    throw signerLeaseFailure;
  }
  try {
    await signerLease.assertHeld();
  } catch (error) {
    signerLeaseFailure = new SignerLeaseLostError(error);
    throw signerLeaseFailure;
  }
}

async function closeRuntimeResources(): Promise<void> {
  try {
    await Promise.all([
      closeHeadSubscription?.(),
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
  if (!config.dryRun && config.databaseUrl === undefined) {
    throw new Error(
      "DATABASE_URL is required for a fail-closed live signer lease",
    );
  }
  if (!config.dryRun) {
    signerLease = await acquireSignerLease({
      connectionString: config.databaseUrl!,
      onWaiting: () => {
        log("warn", "signer_lease_waiting");
      },
    });
    log("info", "signer_lease_acquired", {
      waitedMs: signerLease.waitedMs,
    });
  }
  if (
    config.adaptiveBidding &&
    config.submissionMode === "flashbots"
  ) {
    const policy = {
      minimumBidBps: config.adaptiveBidMinBps,
      baselineBidBps: config.builderBidBps,
      maximumBidBps: config.adaptiveBidMaxBps,
      lossStepBps: config.adaptiveBidStepBps,
      winDecayBps: config.adaptiveBidDecayBps,
      winsBeforeDecay: config.adaptiveBidWinStreak,
      evidenceMaxAgeBlocks:
        config.adaptiveBidEvidenceMaxAgeBlocks,
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
  const discoveryClient =
    config.discoveryRpcUrl === config.rpcUrl
      ? publicClient
      : createPublicClient({
          chain: mainnet,
          transport: http(config.discoveryRpcUrl, {
            retryCount: 3,
            retryDelay: 500,
            timeout: 20_000,
          }),
        });
  const headSignal = new LatestHeadSignal();
  if (config.headRpcUrl !== undefined) {
    const headTransport = webSocket(config.headRpcUrl, {
      timeout: 10_000,
      reconnect: {
        attempts: 10,
        delay: 500,
      },
    });
    const headClient = createPublicClient({
      chain: mainnet,
      transport: headTransport,
    });
    const unwatch = headClient.watchBlocks({
      poll: false,
      onBlock: (block) => {
        headSignal.observe(block.number);
        log("debug", "head_subscription_observed", {
          block: block.number.toString(),
          blockHash: block.hash,
          headTimestamp: block.timestamp.toString(),
          headAgeMs:
            Date.now() - Number(block.timestamp) * 1_000,
        });
      },
      onError: (error) => {
        log("warn", "head_subscription_failed", {
          errorClass: relayFailureClass(errorMessage(error)),
          action: "reconnecting_or_watchdog_restart",
        });
      },
    });
    let headSubscriptionClosed = false;
    closeHeadSubscription = async (): Promise<void> => {
      if (headSubscriptionClosed) return;
      headSubscriptionClosed = true;
      unwatch();
      headSignal.close();
      try {
        const rpcClient = await headClient.transport.getRpcClient();
        rpcClient.close();
      } catch {
        // The socket may already be closed after a failed subscription.
      }
    };
    log("info", "head_subscription_started", {
      transport: "websocket",
      staleTimeoutMs: config.headStaleTimeoutMs,
    });
  }
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
      sendTransaction = async (request) => {
        await assertSignerLeaseHeld();
        return walletClient.sendTransaction({
          to: request.target,
          data: request.data,
          gas: request.gas,
          maxFeePerGas: request.maxFeePerGas,
          maxPriorityFeePerGas: request.maxPriorityFeePerGas,
          nonce: request.nonce,
          value: 0n,
        });
      };
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
        const batchStartedAt = performance.now();
        const limitedRequests = requests.slice(0, 100);
        const preliminarySignStartedAt = performance.now();
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
        log("info", "bundle_stage_timing", {
          stage: "preliminary_sign",
          durationMs:
            performance.now() - preliminarySignStartedAt,
          jobs: limitedRequests.length,
          targetBlock: targetBlock.toString(),
        });
        const preliminarySimulationStartedAt = performance.now();
        const prefixSimulation =
          await simulateLongestValidBundlePrefix(
            relays[0]!,
            preliminaryTransactions,
            targetBlock,
          );
        const prefixLength = prefixSimulation.prefixLength;
        log("info", "bundle_stage_timing", {
          stage: "preliminary_simulation",
          durationMs:
            performance.now() - preliminarySimulationStartedAt,
          plannedJobs: limitedRequests.length,
          validJobs: prefixLength,
          droppedKinds: JSON.stringify(
            limitedRequests
              .slice(prefixLength)
              .map((request) => request.kind),
          ),
          targetBlock: targetBlock.toString(),
        });
        if (prefixLength < minimumViablePrefix) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const prefixRequests = limitedRequests.slice(0, prefixLength);
        const simulation = prefixSimulation.simulation;
        if (simulation === undefined) {
          throw new Error(
            "valid bundle prefix did not include its simulation result",
          );
        }
        const gasUsed = simulatedGasUsed(simulation, prefixLength);
        const firstRequest = prefixRequests[0];
        if (firstRequest === undefined) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const baseFeeAllowancePerGas =
          firstRequest.maxFeePerGas -
          firstRequest.maxPriorityFeePerGas;
        const pricingComponents: Array<{
          rewardWei: bigint;
          gasUsed: bigint;
          builderBidBps: bigint;
          minimumPriorityFeePerGas: bigint;
          bidPolicy: string;
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
          let requestBidBps: bigint;
          let requestMinimumPriorityFeePerGas = 0n;
          let requestBidPolicy: string;
          if (request.order !== undefined) {
            requestBidBps =
              adaptiveBidController?.currentBidBps(request.order) ??
              config.builderBidBps;
            requestBidPolicy = "default";
            requestMinimumPriorityFeePerGas =
              config.minPriorityFeePerGas;
          } else if (
            request.poolBuilderBidPolicy !== undefined
          ) {
            switch (request.poolBuilderBidPolicy) {
              case "pool_pull":
                requestBidBps = config.poolPullBuilderBidBps;
                requestBidPolicy = "pool_pull";
                break;
              case "pool_ready":
                requestBidBps = config.poolBuilderBidBps;
                requestBidPolicy = "pool_ready";
                break;
              case "pool_fulfilled":
                requestBidBps =
                  config.poolFulfilledBuilderBidBps;
                requestBidPolicy = "pool_fulfilled";
                break;
            }
            requestMinimumPriorityFeePerGas =
              config.poolMinPriorityFeePerGas;
          } else if (request.kind === "live_bid_sweep") {
            requestBidBps =
              config.liveBidSweepBuilderBidBps;
            requestBidPolicy = "live_bid_sweep";
            requestMinimumPriorityFeePerGas =
              config.liveBidSweepMinPriorityFeePerGas;
          } else if (request.kind === "liquity_liquidation") {
            requestBidBps = config.liquityBuilderBidBps;
            requestBidPolicy = "liquity";
            requestMinimumPriorityFeePerGas =
              config.minPriorityFeePerGas;
          } else if (
            request.kind === "convex_earmark" ||
            request.kind === "convex_kick"
          ) {
            requestBidBps = config.convexBuilderBidBps;
            requestBidPolicy = "convex";
          } else if (
            request.kind === "stakedao_curve_harvest"
          ) {
            requestBidBps = config.stakeDaoBuilderBidBps;
            requestBidPolicy = "stakedao_curve";
          } else if (request.kind === "firm_replenish") {
            requestBidBps = config.firmBuilderBidBps;
            requestBidPolicy = "firm_replenish";
          } else {
            requestBidBps = config.builderBidBps;
            requestBidPolicy = "default";
            requestMinimumPriorityFeePerGas =
              config.minPriorityFeePerGas;
          }
          pricingComponents.push({
            rewardWei,
            gasUsed: transactionGas,
            builderBidBps: requestBidBps,
            minimumPriorityFeePerGas:
              requestMinimumPriorityFeePerGas,
            bidPolicy: requestBidPolicy,
          });
        }

        const fullGrossReward = pricingComponents.reduce(
          (total, component) => total + component.rewardWei,
          0n,
        );
        const fullGasUsed = pricingComponents.reduce(
          (total, component) => total + component.gasUsed,
          0n,
        );
        const fullMinimumPriorityFeePerGas =
          pricingComponents.reduce(
            (highest, component) =>
              component.minimumPriorityFeePerGas > highest
                ? component.minimumPriorityFeePerGas
                : highest,
            0n,
          );
        const fullBuilderBidBps = aggregateBuilderBidBps(
          pricingComponents,
        );
        const fullQuote = quoteCompetitiveFees({
          crankFee: fullGrossReward,
          simulatedGasUsed: fullGasUsed,
          baseFeeAllowancePerGas,
          minimumPriorityFeePerGas:
            fullMinimumPriorityFeePerGas,
          builderBidBps: fullBuilderBidBps,
          maxFeePerGasCap: config.maxFeePerGas,
          minProfitWei: config.minProfitWei,
        });
        const prefixSelection = selectMostProfitablePrefix({
          components: pricingComponents,
          minimumViablePrefix,
          baseFeeAllowancePerGas,
          maxFeePerGasCap: config.maxFeePerGas,
          minProfitWei: config.minProfitWei,
        });
        const selectedLength =
          prefixSelection?.length ?? pricingComponents.length;
        const selectedPricingComponents =
          pricingComponents.slice(0, selectedLength);
        const competitivelySelectedRequests =
          prefixRequests.slice(0, selectedLength);
        const grossReward =
          prefixSelection?.grossReward ?? fullGrossReward;
        const totalGasUsed =
          prefixSelection?.totalGasUsed ?? fullGasUsed;
        const builderBidBps =
          prefixSelection?.builderBidBps ?? fullBuilderBidBps;
        const quote = prefixSelection?.quote ?? fullQuote;
        const bidPolicies = [
          ...new Set(
            selectedPricingComponents.map(
              (component) => component.bidPolicy,
            ),
          ),
        ];
        const bidPolicy =
          bidPolicies.length > 1
            ? `weighted:${bidPolicies.join("+")}`
            : (bidPolicies[0] ?? "default");
        if (selectedLength < prefixRequests.length) {
          log("info", "unprofitable_bundle_suffix_pruned", {
            plannedJobs: prefixRequests.length,
            selectedJobs: selectedLength,
            droppedJobs: prefixRequests.length - selectedLength,
            droppedKinds: JSON.stringify(
              prefixRequests
                .slice(selectedLength)
                .map((request) => request.kind),
            ),
            selectedExpectedProfit: eth(quote.expectedProfit),
            fullExpectedProfit: eth(fullQuote.expectedProfit),
          });
        }
        log(quote.profitable ? "info" : "warn", "builder_bid", {
          jobs: competitivelySelectedRequests.length,
          kinds: JSON.stringify(
            competitivelySelectedRequests.map(
              (request) => request.kind,
            ),
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
          configuredStakeDaoBuilderBidBps:
            config.stakeDaoBuilderBidBps.toString(),
          configuredFirmBuilderBidBps:
            config.firmBuilderBidBps.toString(),
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
        if (prefixSelection === undefined) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const competitivelyPriced =
          competitivelySelectedRequests.map((request) => ({
            ...request,
            maxFeePerGas: quote.maxFeePerGas,
            maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
          }));
        const competitiveSignStartedAt = performance.now();
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
        log("info", "bundle_stage_timing", {
          stage: "competitive_sign",
          durationMs:
            performance.now() - competitiveSignStartedAt,
          jobs: competitiveTransactions.length,
          targetBlock: targetBlock.toString(),
        });
        const competitiveSimulationStartedAt = performance.now();
        const competitivePrefixLength =
          await longestValidBundlePrefix(
            relays[0]!,
            competitiveTransactions,
            targetBlock,
          );
        log("info", "bundle_stage_timing", {
          stage: "competitive_simulation",
          durationMs:
            performance.now() - competitiveSimulationStartedAt,
          plannedJobs: competitiveTransactions.length,
          validJobs: competitivePrefixLength,
          targetBlock: targetBlock.toString(),
        });
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
        const submissionHead = await publicClient.getBlockNumber();
        if (submissionHead >= targetBlock) {
          log("info", "bundle_target_expired_before_submission", {
            targetBlock: targetBlock.toString(),
            currentBlock: submissionHead.toString(),
            action: "skip_submission",
          });
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        await assertSignerLeaseHeld();
        const relaySubmissionStartedAt = performance.now();
        let firstAcceptedMs: number | undefined;
        const submissions = await submitBundlePrefixLadder(
          relays,
          selected,
          targetBlock,
          config.flashbotsBuilders,
          minimumEconomicPrefix,
          (attempt) => {
            if (
              attempt.status === "accepted" &&
              firstAcceptedMs === undefined
            ) {
              firstAcceptedMs =
                performance.now() - relaySubmissionStartedAt;
            }
            log(
              attempt.status === "accepted" ? "info" : "warn",
              "relay_submission_result",
              {
                relayIndex: attempt.relayIndex,
                transactionCount: attempt.transactionCount,
                durationMs: attempt.durationMs,
                status: attempt.status,
                bundleHash: attempt.bundleHash ?? "",
                errorClass: relayFailureClass(attempt.reason),
                targetBlock: targetBlock.toString(),
              },
            );
          },
        );
        log("info", "bundle_stage_timing", {
          stage: "relay_submission",
          durationMs:
            performance.now() - relaySubmissionStartedAt,
          firstAcceptedMs: firstAcceptedMs ?? -1,
          acceptedVariants: submissions.length,
          targetBlock: targetBlock.toString(),
        });
        log("info", "bundle_stage_timing", {
          stage: "batch_total",
          durationMs: performance.now() - batchStartedAt,
          submittedJobs: selected.length,
          targetBlock: targetBlock.toString(),
        });
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
          effectiveBuilderBidBps:
            quote.effectiveBuilderBidBps,
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
                        ...(attempt.effectiveBidBps === undefined
                          ? {}
                          : {
                              effectiveBidBps:
                                attempt.effectiveBidBps,
                            }),
                      }
                    : {
                        kind: "miss" as const,
                        blockNumber: outcome.targetBlock,
                        ...(attempt.effectiveBidBps === undefined
                          ? {}
                          : {
                              effectiveBidBps:
                                attempt.effectiveBidBps,
                            }),
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
              effectiveBidBps:
                attempt?.effectiveBidBps?.toString() ?? "",
              action: adjustment.action,
              previousBidBps:
                adjustment.previousBidBps.toString(),
              currentBidBps:
                adjustment.currentBidBps.toString(),
              consecutiveFullWins:
                adjustment.state.consecutiveFullWins,
              lowestWinningBidBps:
                adjustment.state.lowestWinningBidBps?.toString() ??
                "",
              highestLosingBidBps:
                adjustment.state.highestLosingBidBps?.toString() ??
                "",
              activeProbeBidBps:
                adjustment.state.activeProbeBidBps?.toString() ??
                "",
              lastObservedWinningBlock:
                adjustment.state.lastObservedWinningBlock?.toString() ??
                "",
              highestLosingBidBlock:
                adjustment.state.highestLosingBidBlock?.toString() ??
                "",
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
    adaptiveBidMinimumBps:
      config.adaptiveBidMinBps.toString(),
    adaptiveBidEvidenceMaxAgeBlocks:
      config.adaptiveBidEvidenceMaxAgeBlocks.toString(),
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
    configuredStakeDaoBuilderBidBps:
      config.stakeDaoBuilderBidBps.toString(),
    configuredFirmBuilderBidBps:
      config.firmBuilderBidBps.toString(),
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
    stakeDaoCurveHarvests:
      config.enableStakeDaoCurveHarvests,
    firmReplenishments:
      config.enableFirmReplenishments,
    liveBidAdapter: config.liveBidAdapterAddress,
    poolBountyEstimateBps:
      config.poolBountyEstimateBps.toString(),
    discordNotifications: discordNotifier !== undefined,
    durableTelemetry: telemetrySink !== undefined,
  });

  let stopping = false;
  const stop = (): void => {
    stopping = true;
    headSignal.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let lastProcessedBlock = -1n;
  do {
    let passFailed = false;
    try {
      let subscribedBlock =
        headSignal.latestAfter(lastProcessedBlock);
      if (
        config.headRpcUrl !== undefined &&
        lastProcessedBlock >= 0n &&
        subscribedBlock === undefined
      ) {
        const observed = await headSignal.waitForNewer(
          lastProcessedBlock,
          config.headStaleTimeoutMs,
        );
        if (stopping) break;
        subscribedBlock =
          headSignal.latestAfter(lastProcessedBlock);
        if (!observed || subscribedBlock === undefined) {
          const currentHttpBlock =
            await publicClient.getBlockNumber();
          if (currentHttpBlock > lastProcessedBlock) {
            throw new HeadSubscriptionStaleError(
              lastProcessedBlock,
              currentHttpBlock,
            );
          }
          continue;
        }
      }
      const block =
        subscribedBlock ??
        (await publicClient.getBlockNumber());
      const headSource =
        subscribedBlock !== undefined
          ? "websocket"
          : config.headRpcUrl !== undefined
            ? "initial_http"
            : "poll";
      if (block !== lastProcessedBlock) {
        const passId = randomUUID();
        const passStartedAt = performance.now();
        await withLogContext(
          {
            passId,
            observedBlock: block.toString(),
            headSource,
          },
          async () => {
            log("debug", "new_block", { block: block.toString() });
            if (!config.dryRun) {
              await assertSignerLeaseHeld();
            }
            const passResult = await runKeeperPass({
              publicClient,
              discoveryClient,
              headBlockNumber: block,
              account,
              config,
              sendTransaction,
              sendBatch,
              observePrivateBatch,
            });
            if (passResult.sent === 0) {
              scheduleColdPlannerRefresh({
                discoveryClient,
                config,
                headBlockNumber: block,
              });
            }
            log("info", "keeper_pass_timing", {
              durationMs: performance.now() - passStartedAt,
              block: block.toString(),
            });
          },
        );
        lastProcessedBlock = block;
        if (signerLeaseFailure !== undefined) {
          throw signerLeaseFailure;
        }
        if (config.runOnce) break;
      }
    } catch (error) {
      if (error instanceof SignerLeaseLostError) {
        log("error", "signer_lease_lost", {
          reason: errorMessage(error),
          action: "stopping_signer",
        });
        throw error;
      }
      if (error instanceof HeadSubscriptionStaleError) {
        log("error", "head_subscription_stale", {
          reason: error.message,
          action: "restarting_worker",
        });
        throw error;
      }
      passFailed = true;
      log("error", "keeper_pass_failed", { reason: errorMessage(error) });
      if (config.runOnce) throw error;
    }
    if (!stopping) {
      if (passFailed) {
        await sleep(config.blockPollMs);
      } else if (config.headRpcUrl === undefined) {
        await sleep(config.blockPollMs);
      }
    }
  } while (!stopping);

  log("info", "keeper_stopped");
  await closeRuntimeResources();
}

main().catch(async (error: unknown) => {
  log("error", "fatal", { reason: errorMessage(error) });
  await closeRuntimeResources();
  process.exitCode = 1;
});
