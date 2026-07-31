import { randomUUID } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  keccak256,
  webSocket,
  type Account,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import {
  AdaptiveBidController,
  adaptiveBidAdjustmentFields,
} from "./adaptive-bidding.js";
import {
  factoryAbi,
  fwaAbi,
  poolAbi,
  chainlinkPriceFeedAbi,
  vaultFactoryAbi,
} from "./abi.js";
import {
  aggregateBuilderBidBps,
  compareObservedBuilderPayment,
  effectiveBuilderBidBps,
  quoteCompetitiveFees,
  selectMostProfitablePrefix,
} from "./bidding.js";
import {
  isTransientCompetitionObservationError,
  observeWinningCrankBids,
  observeWinningPoolLifecycleBids,
  observeWinningPoolPullBids,
} from "./competition.js";
import {
  CHAIN_ID,
  DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
  DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
  DIRECT_COINBASE_PAYMENT_HELPER_CODE_HASH,
  ETH_USD_FEED_ADDRESS,
} from "./constants.js";
import {
  loadConfig,
  pendingFwaFulfillmentExecutionEnabled,
  pendingFundingExecutionEnabled,
  type KeeperConfig,
} from "./config.js";
import { DiscordWebhookNotifier } from "./discord.js";
import {
  startDashboardServer,
  type DashboardRuntime,
} from "./dashboard.js";
import {
  appendDirectCoinbasePayment,
  requiredSignerBalance,
} from "./direct-coinbase-payment.js";
import { requiredProfit } from "./economics.js";
import {
  FlashbotsRelay,
  simulateLongestValidBundlePrefix,
  simulatedGasUsed,
  submitBundlePrefixLadder,
  validateDirectCoinbasePaymentSimulation,
} from "./flashbots.js";
import {
  errorFingerprint,
  errorMessage,
  eth,
  gwei,
  log,
  setLogSink,
  withLogContext,
} from "./format.js";
import {
  LatestHeadSignal,
  parseNewHeadsPayload,
  readBeforeTargetBlock,
  retryTransientRead,
} from "./heads.js";
import {
  minimumLifecycleSubmissionPrefix,
  ROUND_STATE,
} from "./lifecycle.js";
import {
  executePendingFwaBackrun,
  executePendingFwaBackrunWithRetargets,
} from "./pending-fwa-backrun.js";
import {
  PendingFwaFulfillmentValidationError,
  VRF_FULFILL_RANDOM_WORDS_SELECTOR,
  validatePendingFwaFulfillment,
  type PendingFwaBundlePrerequisite,
  type ValidatedPendingFwaFulfillment,
} from "./pending-fwa-fulfillment.js";
import { executePendingFundingBackrun } from "./pending-funding-backrun.js";
import { executePendingPoolPullBackrun } from "./pending-pool-pull-backrun.js";
import {
  PendingFundingReplacementTracker,
  PendingFundingValidationError,
  resolvePendingFundingHash,
  subscribeToAlchemyPendingFundingHashes,
  validatePendingFundingPrerequisite,
  validateSignedPendingTransaction,
  type ValidatedPendingFundingPrerequisite,
  type ValidatedSignedPendingTransaction,
} from "./pending-funding.js";
import { PostgresAdaptiveBidPersistence } from "./postgres-adaptive-bidding.js";
import {
  configurePullPoolV2,
  readPullPoolV2ActivationSignal,
  readPullPoolV2LaunchState,
} from "./pull-pool-v2.js";
import {
  estimatedJobReward,
  isFreshBlockReadUnavailable,
  runKeeperPass,
  scheduleColdPlannerRefresh,
  type KeeperTransactionRequest,
  type KeeperObservedHead,
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
import {
  PendingFundingExecutionController,
  SignerSubmissionCoordinator,
  signerNonceIsUsable,
} from "./signer-coordinator.js";

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
let v2PoolPullBidController: AdaptiveBidController | undefined;
let signerLeaseFailure: Error | undefined;
let closeHeadSubscription: (() => Promise<void>) | undefined;
let closePendingFundingRuntime:
  | (() => Promise<void>)
  | undefined;
let closePendingFwaRuntime:
  | (() => Promise<void>)
  | undefined;
let dashboardRuntime: DashboardRuntime | undefined;

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
      closePendingFundingRuntime?.(),
      closePendingFwaRuntime?.(),
    ]);
  } finally {
    try {
      await Promise.all([
        closeHeadSubscription?.(),
        adaptiveBidController?.close(),
        v2PoolPullBidController?.close(),
        telemetrySink?.close(),
        discordNotifier?.flush(),
        dashboardRuntime?.close(),
      ]);
    } finally {
      await signerLease?.release();
    }
  }
}

async function main(): Promise<void> {
  const startupStartedAt = performance.now();
  const config = loadConfig();
  const sourceRevision =
    process.env.DEPLOY_GIT_SHA ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GIT_SHA;
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
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
          gitSha: sourceRevision,
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
    const v2PoolPullPolicy = {
      minimumBidBps: config.poolPullBuilderBidBps,
      baselineBidBps: config.poolPullBuilderBidBps,
      // A 100% target is only a request for the full aggregate reward. The
      // profitability-only quote below always clamps it first to the exact
      // retained-profit boundary.
      maximumBidBps: 10_000n,
      lossStepBps: 1n,
      winDecayBps: config.adaptiveBidDecayBps,
      winsBeforeDecay: config.adaptiveBidWinStreak,
      evidenceMaxAgeBlocks:
        config.adaptiveBidEvidenceMaxAgeBlocks,
    };
    v2PoolPullBidController =
      config.databaseUrl === undefined
        ? await AdaptiveBidController.load(
            v2PoolPullPolicy,
            `${config.adaptiveBidStatePath}.v2-pool-pull`,
          )
        : await AdaptiveBidController.loadWithPersistence(
            v2PoolPullPolicy,
            new PostgresAdaptiveBidPersistence(
              config.databaseUrl,
              "v2_pool_pull",
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
  dashboardRuntime = await startDashboardServer({
    ...(config.databaseUrl === undefined
      ? {}
      : { databaseUrl: config.databaseUrl }),
    ethUsd: async () => {
      const round = await publicClient.readContract({
        address: ETH_USD_FEED_ADDRESS,
        abi: chainlinkPriceFeedAbi,
        functionName: "latestRoundData",
      });
      const [roundId, answer, , updatedAt, answeredInRound] =
        round;
      const ageSeconds =
        BigInt(Math.floor(Date.now() / 1_000)) - updatedAt;
      if (
        answer <= 0n ||
        updatedAt === 0n ||
        answeredInRound < roundId ||
        ageSeconds < 0n ||
        ageSeconds >
          BigInt(config.firmEthOracleMaxAgeSeconds)
      ) {
        throw new Error("ETH/USD oracle round is incomplete or stale");
      }
      return Number(formatUnits(answer, 8));
    },
  });
  let exactStateClient: StrategyContext["publicClient"] =
    publicClient;
  let exactStateTransport: "http" | "websocket" = "http";
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
  const signerCoordinator = new SignerSubmissionCoordinator();
  const headSignal = new LatestHeadSignal();
  let latestSubscribedHead: KeeperObservedHead | undefined;
  let stopping = false;
  let requestStop: (() => void) | undefined;
  let activatePendingFundingExecution:
    | (() => void)
    | undefined;
  let activatePendingFwaExecution:
    | (() => void)
    | undefined;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const stop = (): void => {
    stopping = true;
    requestStop?.();
    requestStop = undefined;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
    exactStateClient = headClient;
    exactStateTransport = "websocket";
    const headSubscription =
      await headClient.transport.subscribe({
        params: ["newHeads"],
        onData: (data) => {
          let block: KeeperObservedHead;
          try {
            block = parseNewHeadsPayload(data.result);
          } catch (error) {
            log("warn", "head_subscription_payload_invalid", {
              ...errorFingerprint(error),
              action: "ignored_malformed_head",
            });
            return;
          }
          latestSubscribedHead = {
            number: block.number,
            hash: block.hash,
            timestamp: block.timestamp,
            baseFeePerGas: block.baseFeePerGas,
            gasUsed: block.gasUsed,
            gasLimit: block.gasLimit,
          };
          headSignal.observe(block.number);
          signerCoordinator.observeHead(block.number);
          log("debug", "head_subscription_observed", {
            block: block.number.toString(),
            blockHash: block.hash,
            headTimestamp: block.timestamp.toString(),
            headAgeMs:
              Date.now() -
              Number(block.timestamp) * 1_000,
          });
        },
        onError: (error) => {
          log("warn", "head_subscription_failed", {
            errorClass: relayFailureClass(
              errorMessage(error),
            ),
            ...errorFingerprint(error),
            action: "reconnecting_or_watchdog_restart",
          });
        },
      });
    let headSubscriptionClosed = false;
    closeHeadSubscription = async (): Promise<void> => {
      if (headSubscriptionClosed) return;
      headSubscriptionClosed = true;
      try {
        await headSubscription.unsubscribe();
      } catch {
        // A disconnected socket has no live subscription to remove.
      }
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
  const v2LaunchState =
    await readPullPoolV2LaunchState(publicClient);
  const v2ActivationObserved =
    !v2LaunchState.paused ||
    v2LaunchState.roundCount > 0n;
  if (
    v2ActivationObserved &&
    (!v2LaunchState.bytecodeValid ||
      !v2LaunchState.relationshipsValid)
  ) {
    throw new Error(
      "PullPool V2 activated without matching pinned bytecode and relationships",
    );
  }
  let v2Config: KeeperConfig | undefined =
    v2LaunchState.selected
      ? configurePullPoolV2(config)
      : undefined;
  let v2Enabled = v2Config !== undefined;
  let v2RuntimeVerified =
    v2LaunchState.bytecodeValid &&
    v2LaunchState.relationshipsValid;
  log(
    v2LaunchState.selected ? "info" : "debug",
    "pull_pool_adapters_selected",
    {
      poolVersions: JSON.stringify(
        v2Config === undefined ? ["v1"] : ["v1", "v2"],
      ),
      v2Paused: v2LaunchState.paused,
      v2Deprecated: v2LaunchState.deprecated,
      v2RoundCount: v2LaunchState.roundCount.toString(),
      v2BytecodeValid: v2LaunchState.bytecodeValid,
      v2RelationshipsValid:
        v2LaunchState.relationshipsValid,
      pendingFundingBackruns:
        pendingFundingExecutionEnabled(config),
      pendingFwaFulfillmentBackruns:
        pendingFwaFulfillmentExecutionEnabled(config),
    },
  );

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`expected Ethereum mainnet chain id 1, received ${chainId}`);
  }
  if (config.enableDirectCoinbasePayments) {
    const helperCode = await publicClient.getBytecode({
      address: DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
    });
    if (
      helperCode === undefined ||
      helperCode === "0x" ||
      keccak256(helperCode) !==
        DIRECT_COINBASE_PAYMENT_HELPER_CODE_HASH
    ) {
      throw new Error(
        "direct coinbase payment helper bytecode does not match the pinned runtime",
      );
    }
    log("info", "direct_coinbase_payment_helper_verified", {
      helper: DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
      codeHash: DIRECT_COINBASE_PAYMENT_HELPER_CODE_HASH,
      gasLimit:
        DIRECT_COINBASE_PAYMENT_GAS_LIMIT.toString(),
    });
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
  const waitForTargetBlock:
    StrategyContext["waitForTargetBlock"] =
    config.headRpcUrl === undefined
      ? undefined
      : async (targetBlock, timeoutMs) => {
          const afterBlock = targetBlock - 1n;
          if (
            headSignal.latestAfter(afterBlock) !== undefined
          ) {
            return true;
          }
          return headSignal.waitForNewer(
            afterBlock,
            timeoutMs,
          );
        };
  let observePrivateBatch:
    StrategyContext["observePrivateBatch"] = undefined;
  const observePoolPullBatch:
    StrategyContext["observePoolPullBatch"] = async (outcome) => {
      const missed = outcome.attempts.filter(
        (attempt) => !attempt.included,
      );
      const v2BidController =
        outcome.poolVersion === "v2"
          ? v2PoolPullBidController
          : undefined;
      if (missed.length === 0) {
        if (v2BidController !== undefined) {
          const adjustment = await v2BidController.observe(
            outcome.pool,
            {
              kind: "full_win",
              blockNumber: outcome.targetBlock,
              ...(outcome.effectiveBuilderBidBps === undefined
                ? {}
                : {
                    effectiveBidBps:
                      outcome.effectiveBuilderBidBps,
                  }),
            },
          );
          log("info", "v2_pool_pull_adaptive_bid_adjusted", {
            pool: outcome.pool,
            targetBlock: outcome.targetBlock.toString(),
            outcome: "full_win",
            ...adaptiveBidAdjustmentFields(adjustment),
            effectiveBuilderBidBps:
              outcome.effectiveBuilderBidBps?.toString() ?? "",
            pricingBoundary: "exact_profitability_only",
          });
        }
        return;
      }
      const lostRoundIds = [
        ...new Map(
          missed.map((attempt) => [
            attempt.roundId.toString(),
            attempt.roundId,
          ]),
        ).values(),
      ];
      try {
        const observationRead = await retryTransientRead({
          read: () =>
            observeWinningPoolPullBids(publicClient, {
              targetBlock: outcome.targetBlock,
              pool: outcome.pool,
              lostRoundIds,
              ourTransactionHashes: outcome.attempts.map(
                (attempt) => attempt.hash,
              ),
              traceConfig: {
                url: config.competitorTraceUrl,
                timeoutMs: config.competitorTraceTimeoutMs,
                retries: config.competitorTraceRetries,
                retryDelayMs:
                  config.competitorTraceRetryDelayMs,
              },
            }),
          shouldRetry: (error) =>
            isFreshBlockReadUnavailable(error) ||
            isTransientCompetitionObservationError(error),
          maxAttempts: 11,
          retryDelayMs: 100,
        });
        if (observationRead.attempts > 1) {
          log(
            "info",
            "pool_competitor_state_availability_waited",
            {
              targetBlock: outcome.targetBlock.toString(),
              readAttempts: observationRead.attempts,
              availabilityWaitMs: observationRead.waitedMs,
            },
          );
        }
        let observedWinningBidBps: bigint | undefined;
        for (const observation of observationRead.value) {
          const paymentComparison =
            outcome.plannedGrossReward === undefined ||
            outcome.plannedBuilderPayment === undefined ||
            outcome.plannedExpectedProfit === undefined
              ? undefined
              : compareObservedBuilderPayment({
                  observedBuilderPayment:
                    observation.totalBuilderPayment,
                  plannedGrossReward:
                    outcome.plannedGrossReward,
                  plannedBuilderPayment:
                    outcome.plannedBuilderPayment,
                  plannedExpectedProfit:
                    outcome.plannedExpectedProfit,
                  minProfitWei: config.minProfitWei,
                });
          const observedBidBps =
            outcome.plannedGrossReward === undefined
              ? undefined
              : effectiveBuilderBidBps(
                  observation.totalBuilderPayment,
                  outcome.plannedGrossReward,
                );
          if (
            paymentComparison?.profitable === true &&
            observedBidBps !== undefined &&
            (observedWinningBidBps === undefined ||
              observedBidBps > observedWinningBidBps)
          ) {
            observedWinningBidBps = observedBidBps;
          }
          log("info", "pool_competitor_bid_observed", {
            poolVersion: outcome.poolVersion,
            pool: outcome.pool,
            targetBlock: outcome.targetBlock.toString(),
            transactionHash: observation.transactionHash,
            round: observation.roundId.toString(),
            cranker: observation.cranker,
            grossPoolReward: eth(
              observation.grossPoolReward,
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
            winningBidBpsUpperBound:
              observation.winningBidBpsUpperBound.toString(),
            ...(paymentComparison === undefined
              ? {}
              : {
                  plannedGrossReward: eth(
                    outcome.plannedGrossReward ?? 0n,
                  ),
                  plannedBuilderPayment: eth(
                    outcome.plannedBuilderPayment ?? 0n,
                  ),
                  requiredBuilderPayment: eth(
                    paymentComparison.requiredBuilderPayment,
                  ),
                  additionalBuilderPaymentRequired: eth(
                    paymentComparison
                      .additionalBuilderPaymentRequired,
                  ),
                  requiredBidBpsAgainstPlannedGross:
                    paymentComparison
                      .requiredBidBpsAgainstPlannedGross
                      .toString(),
                  counterfactualExpectedProfit: eth(
                    paymentComparison
                      .counterfactualExpectedProfit,
                  ),
                  counterfactualRequiredProfit: eth(
                    paymentComparison.requiredProfit,
                  ),
                  counterfactualProfitable:
                    paymentComparison.profitable,
                }),
            action:
              v2BidController === undefined
                ? "record_only_without_contaminating_standing_order_learning"
                : paymentComparison?.profitable === true
                  ? "feed_v2_pool_pull_controller"
                  : "hold_unprofitable_competitor_evidence",
          });
        }
        const adaptiveAdjustment =
          v2BidController === undefined
            ? undefined
            : await v2BidController.observe(outcome.pool, {
                kind: "miss",
                blockNumber: outcome.targetBlock,
                ...(outcome.effectiveBuilderBidBps === undefined
                  ? {}
                  : {
                      effectiveBidBps:
                        outcome.effectiveBuilderBidBps,
                    }),
                ...(observedWinningBidBps === undefined
                  ? {}
                  : { observedWinningBidBps }),
              });
        if (adaptiveAdjustment !== undefined) {
          log("info", "v2_pool_pull_adaptive_bid_adjusted", {
            pool: outcome.pool,
            targetBlock: outcome.targetBlock.toString(),
            outcome:
              observationRead.value.length > 0
                ? "competitor_won"
                : "no_competitor_pull",
            ...adaptiveBidAdjustmentFields(adaptiveAdjustment),
            effectiveBuilderBidBps:
              outcome.effectiveBuilderBidBps?.toString() ?? "",
            observedWinningBidBps:
              observedWinningBidBps?.toString() ?? "",
            counterfactualProfitableEvidence:
              observedWinningBidBps !== undefined,
            pricingBoundary: "exact_profitability_only",
          });
        }
        log("info", "pool_pull_bid_observation", {
          poolVersion: outcome.poolVersion,
          pool: outcome.pool,
          targetBlock: outcome.targetBlock.toString(),
          outcome:
            observationRead.value.length > 0
              ? "competitor_won"
              : "no_competitor_pull",
          attemptedRounds: JSON.stringify(
            missed.map((attempt) =>
              attempt.roundId.toString(),
            ),
          ),
          observedCompetitors: observationRead.value.length,
          action:
            adaptiveAdjustment === undefined
              ? "hold_lane_specific_bid"
              : adaptiveAdjustment.action,
        });
      } catch (error) {
        log("warn", "pool_competitor_bid_measurement_failed", {
          targetBlock: outcome.targetBlock.toString(),
          attemptedRounds: JSON.stringify(
            missed.map((attempt) =>
              attempt.roundId.toString(),
            ),
          ),
          reason: errorMessage(error),
          ...errorFingerprint(error),
        });
      }
    };
  const observePoolLifecycleBatch:
    StrategyContext["observePoolLifecycleBatch"] = async (
      outcome,
    ) => {
      const missed = outcome.attempts.filter(
        (attempt) => !attempt.included,
      );
      if (missed.length === 0) return;
      const lostRoundIds = [
        ...new Set(
          missed.map((attempt) =>
            attempt.roundId.toString(),
          ),
        ),
      ].map(BigInt);
      try {
        const observationRead = await retryTransientRead({
          read: () =>
            observeWinningPoolLifecycleBids(publicClient, {
              targetBlock: outcome.targetBlock,
              pool: outcome.pool,
              lostRoundIds,
              ourTransactionHashes: outcome.attempts.map(
                (attempt) => attempt.hash,
              ),
              traceConfig: {
                url: config.competitorTraceUrl,
                timeoutMs: config.competitorTraceTimeoutMs,
                retries: config.competitorTraceRetries,
                retryDelayMs:
                  config.competitorTraceRetryDelayMs,
              },
            }),
          shouldRetry: (error) =>
            isFreshBlockReadUnavailable(error) ||
            isTransientCompetitionObservationError(error),
          maxAttempts: 11,
          retryDelayMs: 100,
        });
        if (observationRead.attempts > 1) {
          log(
            "info",
            "pool_lifecycle_competitor_state_availability_waited",
            {
              poolVersion: outcome.poolVersion,
              pool: outcome.pool,
              targetBlock: outcome.targetBlock.toString(),
              rounds: JSON.stringify(
                lostRoundIds.map(String),
              ),
              readAttempts: observationRead.attempts,
              availabilityWaitMs: observationRead.waitedMs,
            },
          );
        }
        for (const observation of observationRead.value) {
          const paymentComparison =
            outcome.plannedGrossReward === undefined ||
            outcome.plannedBuilderPayment === undefined ||
            outcome.plannedExpectedProfit === undefined
              ? undefined
              : compareObservedBuilderPayment({
                  observedBuilderPayment:
                    observation.totalBuilderPayment,
                  plannedGrossReward:
                    outcome.plannedGrossReward,
                  plannedBuilderPayment:
                    outcome.plannedBuilderPayment,
                  plannedExpectedProfit:
                    outcome.plannedExpectedProfit,
                  minProfitWei: config.minProfitWei,
                });
          log(
            "info",
            "pool_lifecycle_competitor_bid_observed",
            {
              targetBlock: outcome.targetBlock.toString(),
              transactionHash: observation.transactionHash,
              round: observation.roundId.toString(),
              cranker: observation.cranker,
              grossPoolReward: eth(
                observation.grossPoolReward,
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
              winningBidBpsUpperBound:
                observation.winningBidBpsUpperBound.toString(),
              ...(paymentComparison === undefined
                ? {}
                : {
                    plannedGrossReward: eth(
                      outcome.plannedGrossReward ?? 0n,
                    ),
                    plannedBuilderPayment: eth(
                      outcome.plannedBuilderPayment ?? 0n,
                    ),
                    requiredBuilderPayment: eth(
                      paymentComparison.requiredBuilderPayment,
                    ),
                    additionalBuilderPaymentRequired: eth(
                      paymentComparison
                        .additionalBuilderPaymentRequired,
                    ),
                    requiredBidBpsAgainstPlannedGross:
                      paymentComparison
                        .requiredBidBpsAgainstPlannedGross
                        .toString(),
                    counterfactualExpectedProfit: eth(
                      paymentComparison
                        .counterfactualExpectedProfit,
                    ),
                    counterfactualRequiredProfit: eth(
                      paymentComparison.requiredProfit,
                    ),
                    counterfactualProfitable:
                      paymentComparison.profitable,
                  }),
              action:
                "record_only_without_contaminating_standing_order_learning",
            },
          );
        }
        log("info", "pool_lifecycle_bid_observation", {
          poolVersion: outcome.poolVersion,
          pool: outcome.pool,
          targetBlock: outcome.targetBlock.toString(),
          outcome:
            observationRead.value.length > 0
              ? "competitor_won"
              : "no_competitor_lifecycle",
          attemptedRounds: JSON.stringify(
            lostRoundIds.map(String),
          ),
          observedCompetitors: observationRead.value.length,
          action:
            "hold_lane_specific_bid_pending_repeated_exact_evidence",
        });
      } catch (error) {
        log(
          "warn",
          "pool_lifecycle_competitor_bid_measurement_failed",
          {
            targetBlock: outcome.targetBlock.toString(),
            rounds: JSON.stringify(
              lostRoundIds.map(String),
            ),
            reason: errorMessage(error),
            ...errorFingerprint(error),
          },
        );
      }
    };
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
          value: request.value ?? 0n,
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
        const firstPlannedRequest = requests[0];
        if (firstPlannedRequest === undefined) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const reservation = signerCoordinator.tryReserve({
          targetBlock,
          nonce: firstPlannedRequest.nonce,
          lane: "normal_keeper_pass",
        });
        if (reservation === undefined) {
          const active =
            signerCoordinator.reservationFor(targetBlock);
          log("info", "signer_submission_slot_busy", {
            targetBlock: targetBlock.toString(),
            requestedLane: "normal_keeper_pass",
            activeLane: active?.lane ?? "",
            activeNonce: active?.nonce ?? "",
            action: "skip_conflicting_private_bundle",
          });
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        let retainReservation = false;
        try {
          await assertSignerLeaseHeld();
          const observedTarget =
            headSignal.latestAfter(targetBlock - 1n);
          if (observedTarget !== undefined) {
            log("info", "signer_submission_gate_rejected", {
              targetBlock: targetBlock.toString(),
              currentBlock: observedTarget.toString(),
              expectedNonce: firstPlannedRequest.nonce,
              lane: "normal_keeper_pass",
              reason: "target_block_already_observed",
            });
            return { hashes: [], targetBlock, relayCount: 0 };
          }
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
                value: request.value ?? 0n,
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
          minimumAggregateBuilderBidBps?: bigint;
          profitabilityOnly?: boolean;
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
            poolPullBountyEstimateBps:
              config.poolPullBountyEstimateBps,
          });
          let requestBidBps: bigint;
          let requestMinimumPriorityFeePerGas = 0n;
          let requestBidPolicy: string;
          let minimumAggregateBuilderBidBps: bigint | undefined;
          let profitabilityOnly = false;
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
            const poolPullBidController =
              v2PoolPullBidController;
            const adaptiveV2PoolPull =
              request.poolVersion === "v2" &&
              request.poolBuilderBidPolicy === "pool_pull" &&
              poolPullBidController !== undefined;
            if (
              adaptiveV2PoolPull &&
              poolPullBidController !== undefined
            ) {
              requestBidBps =
                poolPullBidController.currentBidBps(request.target);
            } else {
              requestBidBps =
                request.configuredBuilderBidBps ??
                (request.poolBuilderBidPolicy === "pool_pull"
                  ? config.poolPullBuilderBidBps
                  : request.poolBuilderBidPolicy === "pool_ready"
                    ? config.poolBuilderBidBps
                    : config.poolFulfilledBuilderBidBps);
            }
            requestBidPolicy = adaptiveV2PoolPull
              ? "v2:pool_pull:adaptive_profitability_only"
              : request.poolVersion === undefined
                ? request.poolBuilderBidPolicy
                : `${request.poolVersion}:${request.poolBuilderBidPolicy}`;
            if (adaptiveV2PoolPull) {
              minimumAggregateBuilderBidBps = requestBidBps;
              profitabilityOnly = true;
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
            ...(minimumAggregateBuilderBidBps === undefined
              ? {}
              : { minimumAggregateBuilderBidBps }),
            ...(profitabilityOnly ? { profitabilityOnly: true } : {}),
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
        const directPaymentEligible =
          config.enableDirectCoinbasePayments &&
          prefixRequests.every(
            (request) =>
              request.kind === "standing_order" &&
              request.order !== undefined,
          );
        const profitabilityOnlyPricing = pricingComponents.some(
          (component) => component.profitabilityOnly === true,
        );
        const fullQuote = quoteCompetitiveFees({
          crankFee: fullGrossReward,
          simulatedGasUsed: fullGasUsed,
          baseFeeAllowancePerGas,
          minimumPriorityFeePerGas:
            fullMinimumPriorityFeePerGas,
          builderBidBps: fullBuilderBidBps,
          ...(profitabilityOnlyPricing
            ? {}
            : { maxFeePerGasCap: config.maxFeePerGas }),
          minProfitWei: config.minProfitWei,
          ...(directPaymentEligible
            ? {
                directPaymentGasUsed:
                  DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
              }
            : {}),
        });
        const prefixSelection = selectMostProfitablePrefix({
          components: pricingComponents,
          minimumViablePrefix,
          baseFeeAllowancePerGas,
          maxFeePerGasCap: config.maxFeePerGas,
          minProfitWei: config.minProfitWei,
          ...(directPaymentEligible
            ? {
                directPaymentGasUsed:
                  DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
              }
            : {}),
        });
        const selectedLength =
          prefixSelection?.length ?? pricingComponents.length;
        const selectedPricingComponents =
          pricingComponents.slice(0, selectedLength);
        const selectedProfitabilityOnlyPricing =
          selectedPricingComponents.some(
            (component) => component.profitabilityOnly === true,
          );
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
          targetBlock: targetBlock.toString(),
          jobs: competitivelySelectedRequests.length,
          kinds: JSON.stringify(
            competitivelySelectedRequests.map(
              (request) => request.kind,
            ),
          ),
          poolVersions: JSON.stringify([
            ...new Set(
              competitivelySelectedRequests.flatMap((request) =>
                request.poolVersion === undefined
                  ? []
                  : [request.poolVersion],
              ),
            ),
          ]),
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
          priorityBuilderPayment: eth(
            quote.priorityBuilderPayment,
          ),
          directBuilderPayment: eth(
            quote.directBuilderPayment,
          ),
          directPaymentGasUsed:
            quote.directPaymentGasUsed.toString(),
          directPaymentEnabled:
            quote.directBuilderPayment > 0n,
          maxFeePerGas: gwei(quote.maxFeePerGas),
          maxPriorityFeePerGas: gwei(
            quote.maxPriorityFeePerGas,
          ),
          expectedProfit: eth(quote.expectedProfit),
          requiredProfit: eth(quote.requiredProfit),
          cappedByProfit: quote.cappedByProfit,
          cappedByFeeCap: quote.cappedByFeeCap,
          pricingBoundary: selectedProfitabilityOnlyPricing
            ? "exact_profitability_only"
            : "configured_fee_and_profitability",
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
        let competitivelyPricedWithPayment:
          readonly KeeperTransactionRequest[] =
          competitivelyPriced;
        if (quote.directBuilderPayment > 0n) {
          competitivelyPricedWithPayment =
            appendDirectCoinbasePayment({
              requests: competitivelyPriced,
              directBuilderPayment:
                quote.directBuilderPayment,
              baseFeeAllowancePerGas,
            });
        }
        const competitiveSignStartedAt = performance.now();
        const competitiveTransactions = await Promise.all(
          competitivelyPricedWithPayment.map((request) =>
            signer.signTransaction({
              chainId: mainnet.id,
              type: "eip1559",
              to: request.target,
              data: request.data,
              gas: request.gas,
              maxFeePerGas: request.maxFeePerGas,
              maxPriorityFeePerGas: request.maxPriorityFeePerGas,
              nonce: request.nonce,
              value: request.value ?? 0n,
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
        const competitivePrefixSimulation =
          await simulateLongestValidBundlePrefix(
            relays[0]!,
            competitiveTransactions,
            targetBlock,
          );
        const competitivePrefixLength =
          competitivePrefixSimulation.prefixLength;
        log("info", "bundle_stage_timing", {
          stage: "competitive_simulation",
          durationMs:
            performance.now() - competitiveSimulationStartedAt,
          plannedJobs: competitiveTransactions.length,
          validJobs: competitivePrefixLength,
          targetBlock: targetBlock.toString(),
        });
        if (
          quote.directBuilderPayment > 0n &&
          competitivePrefixLength !==
            competitiveTransactions.length
        ) {
          log("warn", "direct_coinbase_payment_simulation_failed", {
            targetBlock: targetBlock.toString(),
            plannedTransactions:
              competitiveTransactions.length,
            validTransactions: competitivePrefixLength,
            action: "skip_complete_bundle",
          });
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        if (competitivePrefixLength < minimumViablePrefix) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const selected = competitiveTransactions.slice(
          0,
          competitivePrefixLength,
        );
        const selectedRequests =
          competitivelyPricedWithPayment.slice(
          0,
          competitivePrefixLength,
        );
        let selectedGas = gasUsed.slice(
          0,
          competitivePrefixLength,
        );
        const profitFloor = requiredProfit(config.minProfitWei);
        let lastAdaptiveV2PullIndex = -1;
        for (const [index, request] of selectedRequests.entries()) {
          if (
            request.poolVersion === "v2" &&
            request.poolBuilderBidPolicy === "pool_pull"
          ) {
            lastAdaptiveV2PullIndex = index;
          }
        }
        // The aggregate high bid is justified by the pull. Never offer a
        // same-fee lifecycle-only prefix that lets a builder collect that bid
        // while discarding the competitively priced pull.
        let minimumEconomicPrefix = Math.max(
          minimumViablePrefix,
          lastAdaptiveV2PullIndex + 1,
        );
        if (quote.directBuilderPayment > 0n) {
          const finalSimulation =
            competitivePrefixSimulation.simulation;
          if (finalSimulation === undefined) {
            throw new Error(
              "direct payment bundle lacked its exact simulation",
            );
          }
          selectedGas = simulatedGasUsed(
            finalSimulation,
            selectedRequests.length,
          );
          const helperIndex = selectedRequests.length - 1;
          const helperGas = selectedGas[helperIndex];
          if (helperGas === undefined) {
            throw new Error(
              "direct payment simulation omitted helper gas",
            );
          }
          const jobGas = selectedGas.slice(0, helperIndex);
          const priorityBuilderPayment = jobGas.reduce(
            (total, transactionGas) =>
              total +
              transactionGas * quote.maxPriorityFeePerGas,
            0n,
          );
          const totalCoinbasePayment =
            priorityBuilderPayment +
            quote.directBuilderPayment;
          validateDirectCoinbasePaymentSimulation({
            result: finalSimulation,
            transactionCount: selectedRequests.length,
            helperIndex,
            expectedTotalCoinbasePayment:
              totalCoinbasePayment,
            expectedDirectCoinbasePayment:
              quote.directBuilderPayment,
          });
          let exactGrossReward = 0n;
          for (let index = 0; index < helperIndex; index += 1) {
            const request = selectedRequests[index];
            const transactionGas = selectedGas[index];
            if (
              request === undefined ||
              transactionGas === undefined
            ) {
              throw new Error(
                "direct payment reward accounting was incomplete",
              );
            }
            exactGrossReward += estimatedJobReward({
              job: request,
              gasUsed: transactionGas,
              baseFeePerGas: bountyBaseFeePerGas,
              poolBountyEstimateBps:
                config.poolBountyEstimateBps,
              poolPullBountyEstimateBps:
                config.poolPullBountyEstimateBps,
            });
          }
          const totalExactGas = selectedGas.reduce(
            (total, transactionGas) =>
              total + transactionGas,
            0n,
          );
          const exactExpectedProfit =
            exactGrossReward -
            totalExactGas * baseFeeAllowancePerGas -
            totalCoinbasePayment;
          log(
            exactExpectedProfit >= profitFloor
              ? "info"
              : "warn",
            "direct_coinbase_payment_simulated",
            {
              targetBlock: targetBlock.toString(),
              jobs: helperIndex,
              helperGasUsed: helperGas.toString(),
              grossReward: eth(exactGrossReward),
              priorityBuilderPayment: eth(
                priorityBuilderPayment,
              ),
              directBuilderPayment: eth(
                quote.directBuilderPayment,
              ),
              totalBuilderPayment: eth(
                totalCoinbasePayment,
              ),
              expectedProfit: eth(exactExpectedProfit),
              requiredProfit: eth(profitFloor),
              accepted:
                exactExpectedProfit >= profitFloor,
            },
          );
          if (exactExpectedProfit < profitFloor) {
            return { hashes: [], targetBlock, relayCount: 0 };
          }
          // A payment suffix is never submitted as a prefix or without every
          // selected reward-producing transaction.
          minimumEconomicPrefix = selected.length;
        } else {
          let prefixReward = 0n;
          let prefixGas = 0n;
          for (
            let index = 0;
            index < selectedRequests.length;
            index += 1
          ) {
            const request = selectedRequests[index];
            const transactionGas = selectedGas[index];
            if (
              request === undefined ||
              transactionGas === undefined
            ) {
              throw new Error(
                "competitive prefix accounting was incomplete",
              );
            }
            prefixReward += estimatedJobReward({
              job: request,
              gasUsed: transactionGas,
              baseFeePerGas: bountyBaseFeePerGas,
              poolBountyEstimateBps:
                config.poolBountyEstimateBps,
              poolPullBountyEstimateBps:
                config.poolPullBountyEstimateBps,
            });
            prefixGas += transactionGas;
            const count = index + 1;
            if (
              count >= minimumViablePrefix &&
              prefixReward -
                prefixGas * quote.maxFeePerGas <
                profitFloor
            ) {
              minimumEconomicPrefix = count + 1;
            }
          }
        }
        if (minimumEconomicPrefix > selected.length) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const finalGateStartedAt = performance.now();
        const finalGate = await readBeforeTargetBlock({
          headSignal,
          targetBlock,
          timeoutMs: Math.min(
            config.receiptTimeoutMs,
            config.headStaleTimeoutMs,
          ),
          read: () =>
            Promise.all([
              exactStateClient.getTransactionCount({
                address: signer.address,
                blockNumber: targetBlock - 1n,
              }),
              exactStateClient.getTransactionCount({
                address: signer.address,
                blockTag: "pending",
              }),
              exactStateClient.getBalance({
                address: signer.address,
                blockNumber: targetBlock - 1n,
              }),
            ]),
        });
        log("info", "bundle_stage_timing", {
          stage: "final_submission_gate",
          durationMs: performance.now() - finalGateStartedAt,
          targetBlock: targetBlock.toString(),
          result: finalGate.status,
          exactStateTransport,
        });
        if (finalGate.status === "target_observed") {
          log("info", "bundle_target_expired_before_submission", {
            targetBlock: targetBlock.toString(),
            currentBlock:
              finalGate.observedBlock?.toString() ?? "",
            expectedNonce: firstPlannedRequest.nonce,
            action: "skip_submission",
            reason: "subscribed_target_head_observed",
          });
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const [
          finalLatestNonce,
          finalPendingNonce,
          finalAccountBalance,
        ] = finalGate.value;
        if (
          !signerNonceIsUsable({
            account: signer.address,
            expectedNonce: firstPlannedRequest.nonce,
            latestNonce: finalLatestNonce,
            pendingNonce: finalPendingNonce,
          })
        ) {
          log("info", "bundle_target_expired_before_submission", {
            targetBlock: targetBlock.toString(),
            currentBlock: "",
            expectedNonce: firstPlannedRequest.nonce,
            latestNonce: finalLatestNonce,
            pendingNonce: finalPendingNonce,
            action: "skip_submission",
            reason: "signer_nonce_unavailable",
          });
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const requiredBalance =
          requiredSignerBalance(selectedRequests);
        if (requiredBalance > finalAccountBalance) {
          log("warn", "bundle_balance_gate_rejected", {
            targetBlock: targetBlock.toString(),
            requiredBalance: eth(requiredBalance),
            accountBalance: eth(finalAccountBalance),
            directBuilderPayment: eth(
              quote.directBuilderPayment,
            ),
          });
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        await assertSignerLeaseHeld();
        const observedAtRelaySubmission =
          headSignal.latestAfter(targetBlock - 1n);
        if (observedAtRelaySubmission !== undefined) {
          log("info", "bundle_target_expired_before_submission", {
            targetBlock: targetBlock.toString(),
            currentBlock:
              observedAtRelaySubmission.toString(),
            expectedNonce: firstPlannedRequest.nonce,
            action: "skip_submission",
            reason: "subscribed_target_head_observed",
          });
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const minimumSubmissionPrefix =
          minimumLifecycleSubmissionPrefix(
            selectedRequests,
            minimumEconomicPrefix,
          );
        if (minimumSubmissionPrefix > minimumEconomicPrefix) {
          log("info", "bundle_submission_floor", {
            targetBlock: targetBlock.toString(),
            minimumViablePrefix,
            minimumEconomicPrefix,
            minimumSubmissionPrefix,
            reason: "settlement_in_exact_simulated_core",
          });
        }
        const relaySubmissionStartedAt = performance.now();
        let firstAcceptedMs: number | undefined;
        const submissions = await submitBundlePrefixLadder(
          relays,
          selected,
          targetBlock,
          config.flashbotsBuilders,
          minimumSubmissionPrefix,
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
        const acceptedRequests = selectedRequests.slice(
          0,
          acceptedTransactionCount,
        );
        const relayIndexes = new Set(
          submissions.map((submission) =>
            relays.findIndex(
              (relay) => relay.url === submission.relayUrl,
            ),
          ),
        );
        retainReservation = true;
        return {
          hashes: accepted.map((transaction) => keccak256(transaction)),
          acceptedRequests,
          targetBlock,
          relayCount: relayIndexes.size,
          effectiveBuilderBidBps:
            quote.effectiveBuilderBidBps,
          plannedGrossReward: grossReward,
          plannedBuilderPayment: quote.builderPayment,
          plannedExpectedProfit: quote.expectedProfit,
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
        } finally {
          if (!retainReservation) {
            signerCoordinator.release(reservation);
          }
        }
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
              const observationRead = await retryTransientRead({
                read: () =>
                  observeWinningCrankBids(
                    publicClient,
                    outcome,
                    {
                      url: config.competitorTraceUrl,
                      timeoutMs:
                        config.competitorTraceTimeoutMs,
                      retries: config.competitorTraceRetries,
                      retryDelayMs:
                        config.competitorTraceRetryDelayMs,
                    },
                    {
                      factoryAddress:
                        outcome.factoryAddress ??
                        config.factoryAddress,
                      vaultFactoryAddress:
                        outcome.factoryAddress === undefined
                          ? config.enableVaults
                            ? config.vaultFactoryAddress
                            : undefined
                          : outcome.vaultFactoryAddress,
                    },
                  ),
                shouldRetry: (error) =>
                  isFreshBlockReadUnavailable(error) ||
                  isTransientCompetitionObservationError(error),
                maxAttempts: 11,
                retryDelayMs: 100,
              });
              if (observationRead.attempts > 1) {
                log(
                  "info",
                  "competitor_bid_state_availability_waited",
                  {
                    targetBlock: outcome.targetBlock.toString(),
                    bidScope:
                      outcome.bidScope ?? "standing_order",
                    readAttempts: observationRead.attempts,
                    availabilityWaitMs: observationRead.waitedMs,
                  },
                );
              }
              const observations = observationRead.value;
              for (const observation of observations) {
                log("info", "competitor_bid_observed", {
                  poolVersion:
                    outcome.poolVersion ?? config.poolVersion,
                  targetBlock: outcome.targetBlock.toString(),
                  bidScope:
                    outcome.bidScope ?? "standing_order",
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
                bidScope:
                  outcome.bidScope ?? "standing_order",
                reason: errorMessage(error),
                ...errorFingerprint(error),
              });
            }
          }

          const adjustments =
            outcome.bidScope === "pending_funding_backrun"
              ? []
              : await bidController.observeBatch(
                  outcome.attempts.map((attempt) => {
                    const observedWinningBidBps =
                      observedBidsByOrder.get(
                        attempt.order.toLowerCase(),
                    );
                    return {
                      target: attempt.order,
                      outcome: attempt.included
                        ? {
                            kind: "full_win" as const,
                            blockNumber: outcome.targetBlock,
                            ...(attempt.effectiveBidBps ===
                            undefined
                              ? {}
                              : {
                                  effectiveBidBps:
                                    attempt.effectiveBidBps,
                                }),
                          }
                        : {
                            kind: "miss" as const,
                            blockNumber: outcome.targetBlock,
                            ...(attempt.effectiveBidBps ===
                            undefined
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
          if (outcome.bidScope === "pending_funding_backrun") {
            log("info", "pending_funding_bid_observation", {
              targetBlock: outcome.targetBlock.toString(),
              outcome: fullWin ? "win" : "loss",
              attempted: outcome.attempts.length,
              observedWinningBids: JSON.stringify(
                Object.fromEntries(
                  [...observedBidsByOrder.entries()].map(
                    ([order, bidBps]) => [
                      order,
                      bidBps.toString(),
                    ],
                  ),
                ),
              ),
              action:
                "hold_lane_specific_static_bid_without_contaminating_standing_order_learning",
            });
          }
          for (const adjustment of adjustments) {
            const attempt = outcome.attempts.find(
              (candidate) =>
                candidate.order.toLowerCase() ===
                adjustment.target.toLowerCase(),
            );
            log("info", "adaptive_builder_bid_updated", {
              targetBlock: outcome.targetBlock.toString(),
              order: adjustment.target,
              outcome: attempt?.included ? "win" : "loss",
              observedWinningBidBps:
                observedBidsByOrder
                  .get(adjustment.target.toLowerCase())
                  ?.toString() ?? "",
              effectiveBidBps:
                attempt?.effectiveBidBps?.toString() ?? "",
              ...adaptiveBidAdjustmentFields(adjustment),
            });
          }
          if (outcome.bidScope !== "pending_funding_backrun") {
            log("info", "adaptive_bid_batch_complete", {
              targetBlock: outcome.targetBlock.toString(),
              bidScope: "standing_order",
              outcome: fullWin
                ? "full_win"
                : includedCount === 0
                  ? "loss"
                  : "partial_win",
              included: includedCount,
              attempted: outcome.attempts.length,
            });
          }
        };
      }
      if (pendingFundingExecutionEnabled(config)) {
        const [orders, vaults] = await Promise.all([
          publicClient.readContract({
            address: config.factoryAddress,
            abi: factoryAbi,
            functionName: "allOrders",
          }),
          config.enableVaults
            ? publicClient.readContract({
                address: config.vaultFactoryAddress,
                abi: vaultFactoryAbi,
                functionName: "allVaults",
              })
            : Promise.resolve([]),
        ]);
        const canonicalTargets = [
          ...new Set(
            [
              ...orders,
              ...vaults,
              config.expectedPoolAddress,
            ].map((address) => getAddress(address)),
          ),
        ];
        const replacementTracker =
          new PendingFundingReplacementTracker();
        const executionController =
          new PendingFundingExecutionController(false);
        let candidateResolutionQueue = Promise.resolve();
        let pendingCandidateResolutions = 0;
        let queuedCandidate:
          | ValidatedPendingFundingPrerequisite
          | undefined;

        const executeQueuedCandidate = (): void => {
          if (
            !executionController.enabled ||
            executionController.active ||
            executionController.stopping
          ) {
            return;
          }
          const prerequisite = queuedCandidate;
          if (prerequisite === undefined) return;
          queuedCandidate = undefined;
          const execution = executionController.start(
            async (signal) => {
              try {
                const result =
                  prerequisite.action ===
                  "pool_ticket_purchase"
                    ? await executePendingPoolPullBackrun({
                        publicClient,
                        pendingClient: discoveryClient,
                        signer,
                        prerequisite,
                        relays,
                        builders:
                          config.flashbotsBuilders,
                        config,
                        builderBidBps:
                          config.poolPullBuilderBidBps,
                        coordinator: signerCoordinator,
                        assertSignerLeaseHeld,
                        isPrerequisiteCurrent: () =>
                          replacementTracker.isCurrent({
                            hash: prerequisite.hash,
                            sender: prerequisite.sender,
                            nonce: prerequisite.nonce,
                          }),
                        waitForTargetBlock: async (
                          targetBlock,
                          timeoutMs,
                        ) => {
                          const afterBlock =
                            targetBlock - 1n;
                          if (
                            headSignal.latestAfter(
                              afterBlock,
                            ) !== undefined
                          ) {
                            return true;
                          }
                          return headSignal.waitForNewer(
                            afterBlock,
                            timeoutMs,
                          );
                        },
                        signal,
                      })
                    : await executePendingFundingBackrun({
                        publicClient,
                        pendingClient: discoveryClient,
                        signer,
                        prerequisite,
                        relays,
                        builders:
                          config.flashbotsBuilders,
                        config,
                        builderBidBps:
                          config.pendingFundingBuilderBidBps,
                        coordinator: signerCoordinator,
                        assertSignerLeaseHeld,
                        isPrerequisiteCurrent: () =>
                          replacementTracker.isCurrent({
                            hash: prerequisite.hash,
                            sender: prerequisite.sender,
                            nonce: prerequisite.nonce,
                          }),
                        waitForTargetBlock: async (
                          targetBlock,
                          timeoutMs,
                        ) => {
                          const afterBlock =
                            targetBlock - 1n;
                          if (
                            headSignal.latestAfter(
                              afterBlock,
                            ) !== undefined
                          ) {
                            return true;
                          }
                          return headSignal.waitForNewer(
                            afterBlock,
                            timeoutMs,
                          );
                        },
                        observePrivateBatch,
                        signal,
                      });
                const transactionHash =
                  "pullHash" in result
                    ? result.pullHash
                    : "crankHash" in result
                      ? result.crankHash
                      : undefined;
                log(
                  "info",
                  prerequisite.action ===
                    "pool_ticket_purchase"
                    ? "pending_pool_pull_backrun_complete"
                    : "pending_funding_backrun_complete",
                  {
                    prerequisiteHash: prerequisite.hash,
                    action: prerequisite.action,
                    target: prerequisite.target,
                    ...(prerequisite.action ===
                    "pool_ticket_purchase"
                          ? {
                              round:
                                prerequisite.roundId?.toString() ??
                                "current",
                            }
                      : {}),
                    status: result.status,
                    reason: result.reason,
                    targetBlock:
                      result.targetBlock?.toString() ?? "",
                    transactionHash:
                      transactionHash ?? "",
                    realizedProfit:
                      result.realizedProfitWei === undefined
                        ? ""
                        : eth(result.realizedProfitWei),
                  },
                );
              } catch (error) {
                log(
                  "warn",
                  prerequisite.action ===
                    "pool_ticket_purchase"
                    ? "pending_pool_pull_backrun_failed"
                    : "pending_funding_backrun_failed",
                  {
                    prerequisiteHash: prerequisite.hash,
                    action: prerequisite.action,
                    target: prerequisite.target,
                    reason: errorMessage(error),
                  },
                );
              } finally {
                replacementTracker.forget({
                  hash: prerequisite.hash,
                  sender: prerequisite.sender,
                  nonce: prerequisite.nonce,
                });
              }
            },
          );
          void execution?.finally(() => {
            executeQueuedCandidate();
          });
        };
        activatePendingFundingExecution = () => {
          if (!executionController.activate()) return;
          executeQueuedCandidate();
        };

        const subscription =
          subscribeToAlchemyPendingFundingHashes({
            url: config.headRpcUrl!,
            targetAddresses: canonicalTargets,
            onSubscribed: (connectionGeneration) => {
              log(
                "info",
                "pending_funding_subscription_ready",
                {
                  connectionGeneration,
                  targetCount: canonicalTargets.length,
                },
              );
            },
            onHash: (hash) => {
              const observedAt = performance.now();
              pendingCandidateResolutions += 1;
              log(
                "debug",
                "pending_funding_hash_observed",
                {
                  hash,
                  resolutionQueueDepth:
                    pendingCandidateResolutions,
                },
              );
              const resolution =
                candidateResolutionQueue.then(
                  async () => {
                    if (executionController.stopping) {
                      return;
                    }
                    const resolutionStartedAt =
                      performance.now();
                    const resolutionQueueWaitMs =
                      resolutionStartedAt - observedAt;
                    try {
                      const resolved =
                        await resolvePendingFundingHash({
                          getRawTransaction: () =>
                            discoveryClient.getRawTransaction({
                              hash,
                            }),
                          getTransaction: async () => {
                            const transaction =
                              await discoveryClient.getTransaction({
                                hash,
                              });
                            return {
                              hash: transaction.hash,
                              from: transaction.from,
                              nonce: transaction.nonce,
                              chainId: transaction.chainId,
                              type: transaction.type,
                              to: transaction.to,
                              value: transaction.value,
                              input: transaction.input,
                              blockNumber:
                                transaction.blockNumber,
                            };
                          },
                        });
                      const resolutionMs =
                        performance.now() -
                        resolutionStartedAt;
                      const observedToResolutionMs =
                        performance.now() - observedAt;
                      if (resolved.status === "mined") {
                        log(
                          "info",
                          "pending_funding_candidate_late",
                          {
                            hash,
                            order:
                              resolved.transaction.to ?? "",
                            block:
                              resolved.transaction.blockNumber?.toString() ??
                              "",
                            rawAvailable:
                              resolved.rawAvailable,
                            resolutionQueueWaitMs,
                            resolutionMs,
                            observedToResolutionMs,
                          },
                        );
                        return;
                      }
                      const transaction =
                        resolved.transaction;
                      const prerequisite =
                        await validatePendingFundingPrerequisite({
                          rawTransaction:
                            resolved.rawTransaction,
                          expectedHash: hash,
                          rpcTransaction: {
                            hash: transaction.hash,
                            from: transaction.from,
                            nonce: transaction.nonce,
                            chainId: transaction.chainId,
                            type: transaction.type,
                            to: transaction.to,
                            value: transaction.value,
                            input: transaction.input,
                          },
                          canonicalTargets,
                          poolTarget:
                            config.expectedPoolAddress,
                        });
                      log(
                        "info",
                        "pending_funding_candidate_validated",
                        {
                          hash: prerequisite.hash,
                          action: prerequisite.action,
                          target: prerequisite.target,
                          sender: prerequisite.sender,
                          nonce: prerequisite.nonce,
                          value: eth(prerequisite.value),
                          ...(prerequisite.action ===
                          "pool_ticket_purchase"
                            ? {
                                round:
                                  prerequisite.roundId?.toString() ??
                                  "current",
                                purchaseFunction:
                                  prerequisite.purchaseFunction,
                                tickets:
                                  prerequisite.tickets,
                              }
                            : {}),
                          resolutionQueueWaitMs,
                          resolutionMs:
                            performance.now() -
                            resolutionStartedAt,
                          observedToResolutionMs:
                            performance.now() - observedAt,
                        },
                      );
                      if (executionController.stopping) {
                        return;
                      }
                      const tracked =
                        replacementTracker.observe({
                          hash: prerequisite.hash,
                          sender: prerequisite.sender,
                          nonce: prerequisite.nonce,
                        });
                      if (tracked.status === "duplicate") {
                        log(
                          "debug",
                          "pending_funding_candidate_duplicate",
                          {
                            hash: prerequisite.hash,
                            order: prerequisite.target,
                            sender: prerequisite.sender,
                            nonce: prerequisite.nonce,
                          },
                        );
                        return;
                      }
                      if (tracked.status === "replacement") {
                        log(
                          "info",
                          "pending_funding_replacement_observed",
                          {
                            order: prerequisite.target,
                            sender: prerequisite.sender,
                            nonce: prerequisite.nonce,
                            replacedHash:
                              tracked.replacedHash,
                            hash: prerequisite.hash,
                          },
                        );
                      }
                      const displaced = queuedCandidate;
                      if (
                        displaced !== undefined &&
                        displaced.hash.toLowerCase() !==
                          prerequisite.hash.toLowerCase()
                      ) {
                        replacementTracker.forget({
                          hash: displaced.hash,
                          sender: displaced.sender,
                          nonce: displaced.nonce,
                        });
                      }
                      queuedCandidate = prerequisite;
                      executeQueuedCandidate();
                    } catch (error) {
                      const validationError =
                        error instanceof
                        PendingFundingValidationError;
                      log(
                        "debug",
                        "pending_funding_candidate_rejected",
                        {
                          hash,
                          reason: validationError
                            ? error.code
                            : "rpc_resolution_failed",
                          resolutionQueueWaitMs,
                          resolutionMs:
                            performance.now() -
                            resolutionStartedAt,
                          observedToResolutionMs:
                            performance.now() - observedAt,
                          ...(validationError
                            ? {}
                            : errorFingerprint(error)),
                        },
                      );
                    }
                  },
                );
              candidateResolutionQueue = resolution.finally(
                () => {
                  pendingCandidateResolutions -= 1;
                },
              );
              return candidateResolutionQueue;
            },
            onError: (error) => {
              log(
                "warn",
                "pending_funding_subscription_failed",
                {
                  errorClass: error.code,
                  action:
                    "reconnecting_same_filtered_subscription",
                },
              );
            },
          });
        try {
          await Promise.race([
            subscription.ready,
            new Promise<never>((_, reject) => {
              const timer = setTimeout(() => {
                reject(
                  new Error(
                    "pending funding subscription did not become ready",
                  ),
                );
              }, 10_000);
              timer.unref();
            }),
          ]);
        } catch (error) {
          subscription.close();
          throw error;
        }
        closePendingFundingRuntime = async () => {
          subscription.close();
          queuedCandidate = undefined;
          replacementTracker.clear();
          const drain = executionController.stopAndDrain();
          await candidateResolutionQueue;
          await drain;
        };
        log("info", "pending_funding_subscription_started", {
          targetCount: canonicalTargets.length,
          hashesOnly: true,
          transport: "websocket",
          fallback: "none",
        });
      }
      if (pendingFwaFulfillmentExecutionEnabled(config)) {
        const fwa = getAddress(
          await publicClient.readContract({
            address: poolAddress,
            abi: poolAbi,
            functionName: "FWA",
          }),
        );
        const [vrfCoordinator, vrfSubId] =
          await publicClient.readContract({
            address: fwa,
            abi: fwaAbi,
            functionName: "vrfCoordinatorAndSubId",
          });
        const canonicalVrfCoordinator =
          getAddress(vrfCoordinator);
        const replacementTracker =
          new PendingFundingReplacementTracker();
        const executionController =
          new PendingFundingExecutionController(false);
        const resolutions = new Set<Promise<void>>();
        const coordinatorTransactions = new Map<
          string,
          Map<number, ValidatedSignedPendingTransaction>
        >();
        let waitingCandidate:
          | ValidatedPendingFwaFulfillment
          | undefined;
        let queuedCandidate:
          | PendingFwaBundlePrerequisite
          | undefined;

        const executeQueuedCandidate = (): void => {
          if (
            !executionController.enabled ||
            executionController.active ||
            executionController.stopping
          ) {
            return;
          }
          const prerequisite = queuedCandidate;
          if (prerequisite === undefined) return;
          queuedCandidate = undefined;
          const execution = executionController.start(
            async (signal) => {
              try {
                const isPrerequisiteCurrent = () =>
                  replacementTracker.isCurrent({
                    hash: prerequisite.hash,
                    sender: prerequisite.sender,
                    nonce: prerequisite.nonce,
                  }) &&
                  prerequisite.prerequisiteTransactions.every(
                    (transaction) =>
                      coordinatorTransactions
                        .get(
                          transaction.sender.toLowerCase(),
                        )
                        ?.get(transaction.nonce)
                        ?.hash.toLowerCase() ===
                      transaction.hash.toLowerCase(),
                  );
                const result =
                  await executePendingFwaBackrunWithRetargets(
                    {
                      execute: () =>
                        executePendingFwaBackrun({
                          publicClient: exactStateClient,
                          pendingClient: discoveryClient,
                          signer,
                          prerequisite,
                          pool: poolAddress,
                          fwa,
                          relays,
                          builders: config.flashbotsBuilders,
                          config,
                          builderBidBps:
                            config.poolBuilderBidBps,
                          coordinator: signerCoordinator,
                          assertSignerLeaseHeld,
                          isPrerequisiteCurrent,
                          waitForTargetBlock: async (
                            targetBlock,
                            timeoutMs,
                          ) => {
                            const afterBlock =
                              targetBlock - 1n;
                            if (
                              headSignal.latestAfter(
                                afterBlock,
                              ) !== undefined
                            ) {
                              return true;
                            }
                            return headSignal.waitForNewer(
                              afterBlock,
                              timeoutMs,
                            );
                          },
                          readBeforeTargetBlock: ({
                            targetBlock,
                            timeoutMs,
                            read,
                          }) =>
                            readBeforeTargetBlock({
                              headSignal,
                              targetBlock,
                              timeoutMs,
                              read,
                            }),
                          signal,
                        }),
                      isPrerequisiteCurrent,
                      isPrerequisitePending: async () => {
                        if (!isPrerequisiteCurrent()) {
                          return false;
                        }
                        const transactions =
                          await Promise.all(
                            prerequisite.prerequisiteTransactions.map(
                              (transaction) =>
                                discoveryClient
                                  .getTransaction({
                                    hash: transaction.hash,
                                  })
                                  .catch(() => undefined),
                            ),
                          );
                        return transactions.every(
                          (transaction) =>
                            transaction !== undefined &&
                            transaction.blockNumber === null,
                        );
                      },
                      prerequisiteHash: prerequisite.hash,
                      requestId: prerequisite.requestId,
                      signal,
                    },
                  );
                log(
                  "info",
                  "pending_fwa_backrun_complete",
                  {
                    prerequisiteHash: prerequisite.hash,
                    requestId:
                      prerequisite.requestId.toString(),
                    status: result.status,
                    reason: result.reason,
                    targetBlock:
                      result.targetBlock?.toString() ?? "",
                    processHash: result.processHash ?? "",
                    syncHash: result.syncHash ?? "",
                    settleHash: result.settleHash ?? "",
                    realizedProfit:
                      result.realizedProfitWei === undefined
                        ? ""
                        : eth(result.realizedProfitWei),
                  },
                );
              } catch (error) {
                log("warn", "pending_fwa_backrun_failed", {
                  prerequisiteHash: prerequisite.hash,
                  requestId:
                    prerequisite.requestId.toString(),
                  reason: errorMessage(error),
                  ...errorFingerprint(error),
                });
              } finally {
                replacementTracker.forget({
                  hash: prerequisite.hash,
                  sender: prerequisite.sender,
                  nonce: prerequisite.nonce,
                });
              }
            },
          );
          void execution?.finally(() => {
            executeQueuedCandidate();
          });
        };
        activatePendingFwaExecution = () => {
          if (!executionController.activate()) return;
          executeQueuedCandidate();
        };

        const cacheCoordinatorTransaction = (
          transaction: ValidatedSignedPendingTransaction,
        ): void => {
          const sender = transaction.sender.toLowerCase();
          let byNonce = coordinatorTransactions.get(sender);
          if (byNonce === undefined) {
            byNonce = new Map();
            coordinatorTransactions.set(sender, byNonce);
          }
          byNonce.set(transaction.nonce, transaction);
          while (byNonce.size > 64) {
            const oldestNonce = [...byNonce.keys()].sort(
              (left, right) => left - right,
            )[0];
            if (oldestNonce === undefined) break;
            byNonce.delete(oldestNonce);
          }
        };

        const queueCompleteCandidate = async (
          candidate: ValidatedPendingFwaFulfillment,
        ): Promise<boolean> => {
          const currentHead =
            await exactStateClient.getBlockNumber();
          const [lifecycleRound, senderNonce] =
            await Promise.all([
              exactStateClient.readContract({
                address: poolAddress,
                abi: poolAbi,
                functionName: "ethPendingRound",
                blockNumber: currentHead,
              }),
              exactStateClient.getTransactionCount({
                address: candidate.sender,
                blockNumber: currentHead,
              }),
            ]);
          if (
            lifecycleRound <= 0n ||
            candidate.nonce < senderNonce
          ) {
            if (
              waitingCandidate?.hash.toLowerCase() ===
              candidate.hash.toLowerCase()
            ) {
              waitingCandidate = undefined;
            }
            return false;
          }
          const round =
            await exactStateClient.readContract({
              address: poolAddress,
              abi: poolAbi,
              functionName: "getRound",
              args: [lifecycleRound],
              blockNumber: currentHead,
            });
          if (
            round.state !== ROUND_STATE.pulling ||
            round.fwaResolved ||
            round.fwaRequestId !== candidate.requestId
          ) {
            if (
              waitingCandidate?.hash.toLowerCase() ===
              candidate.hash.toLowerCase()
            ) {
              waitingCandidate = undefined;
            }
            return false;
          }
          const prerequisiteCount =
            candidate.nonce - senderNonce + 1;
          if (
            prerequisiteCount < 1 ||
            prerequisiteCount > 8
          ) {
            log(
              "info",
              "pending_fwa_prerequisite_chain_rejected",
              {
                hash: candidate.hash,
                sender: candidate.sender,
                senderNonce,
                fulfillmentNonce: candidate.nonce,
                prerequisiteCount,
                reason: "nonce_chain_outside_bound",
              },
            );
            waitingCandidate = undefined;
            return false;
          }
          const byNonce = coordinatorTransactions.get(
            candidate.sender.toLowerCase(),
          );
          const prerequisiteTransactions: ValidatedSignedPendingTransaction[] =
            [];
          for (
            let nonce = senderNonce;
            nonce <= candidate.nonce;
            nonce += 1
          ) {
            const transaction = byNonce?.get(nonce);
            if (transaction === undefined) {
              waitingCandidate = candidate;
              log(
                "debug",
                "pending_fwa_prerequisite_gap",
                {
                  hash: candidate.hash,
                  sender: candidate.sender,
                  missingNonce: nonce,
                  fulfillmentNonce: candidate.nonce,
                  prerequisiteCount,
                  action:
                    "wait_for_contiguous_coordinator_prefix",
                },
              );
              return false;
            }
            prerequisiteTransactions.push(transaction);
          }
          const fulfillment =
            prerequisiteTransactions.at(-1);
          if (
            fulfillment === undefined ||
            fulfillment.hash.toLowerCase() !==
              candidate.hash.toLowerCase()
          ) {
            waitingCandidate = undefined;
            return false;
          }
          waitingCandidate = undefined;
          const prerequisite: PendingFwaBundlePrerequisite = {
            ...candidate,
            prerequisiteTransactions,
          };
          const tracked = replacementTracker.observe({
            hash: prerequisite.hash,
            sender: prerequisite.sender,
            nonce: prerequisite.nonce,
          });
          if (tracked.status === "duplicate") return false;
          if (tracked.status === "replacement") {
            log(
              "info",
              "pending_fwa_replacement_observed",
              {
                sender: prerequisite.sender,
                nonce: prerequisite.nonce,
                replacedHash: tracked.replacedHash,
                hash: prerequisite.hash,
              },
            );
          }
          const displaced = queuedCandidate;
          if (
            displaced !== undefined &&
            displaced.hash.toLowerCase() !==
              prerequisite.hash.toLowerCase()
          ) {
            replacementTracker.forget({
              hash: displaced.hash,
              sender: displaced.sender,
              nonce: displaced.nonce,
            });
          }
          queuedCandidate = prerequisite;
          log("info", "pending_fwa_candidate_queued", {
            hash: prerequisite.hash,
            requestId: prerequisite.requestId.toString(),
            round: lifecycleRound.toString(),
            sender: prerequisite.sender,
            senderNonce,
            fulfillmentNonce: prerequisite.nonce,
            prerequisiteCount:
              prerequisite.prerequisiteTransactions.length,
          });
          executeQueuedCandidate();
          return true;
        };

        const subscription =
          subscribeToAlchemyPendingFundingHashes({
            url: config.headRpcUrl!,
            targetAddresses: [canonicalVrfCoordinator],
            onSubscribed: (connectionGeneration) => {
              log(
                "info",
                "pending_fwa_subscription_ready",
                {
                  connectionGeneration,
                  coordinator: canonicalVrfCoordinator,
                  consumer: fwa,
                },
              );
            },
            onHash: (hash) => {
              const observedAt = performance.now();
              if (resolutions.size >= 32) {
                log(
                  "warn",
                  "pending_fwa_resolution_saturated",
                  {
                    resolutionConcurrency:
                      resolutions.size,
                    action:
                      "drop_unresolved_coordinator_hash",
                  },
                );
                return;
              }
              log(
                "debug",
                "pending_fwa_hash_observed",
                {
                  hash,
                  resolutionConcurrency:
                    resolutions.size + 1,
                },
              );
              let resolution: Promise<void>;
              resolution = (async () => {
                try {
                  const resolved =
                    await resolvePendingFundingHash({
                      getRawTransaction: () =>
                        discoveryClient.getRawTransaction({
                          hash,
                        }),
                      getTransaction: async () => {
                        const transaction =
                          await discoveryClient.getTransaction({
                            hash,
                          });
                        return {
                          hash: transaction.hash,
                          from: transaction.from,
                          nonce: transaction.nonce,
                          chainId: transaction.chainId,
                          type: transaction.type,
                          to: transaction.to,
                          value: transaction.value,
                          input: transaction.input,
                          blockNumber:
                            transaction.blockNumber,
                        };
                      },
                    });
                  if (resolved.status === "mined") {
                    log(
                      "info",
                      "pending_fwa_candidate_late",
                      {
                        hash,
                        block:
                          resolved.transaction.blockNumber?.toString() ??
                          "",
                        rawAvailable:
                          resolved.rawAvailable,
                        observedToResolutionMs:
                          performance.now() - observedAt,
                      },
                    );
                    return;
                  }
                  const transaction = resolved.transaction;
                  const rpcTransaction = {
                    hash: transaction.hash,
                    from: transaction.from,
                    nonce: transaction.nonce,
                    chainId: transaction.chainId,
                    type: transaction.type,
                    to: transaction.to,
                    value: transaction.value,
                    input: transaction.input,
                  };
                  const coordinatorTransaction =
                    await validateSignedPendingTransaction({
                      rawTransaction:
                        resolved.rawTransaction,
                      expectedHash: hash,
                      rpcTransaction,
                    });
                  if (
                    coordinatorTransaction.target.toLowerCase() !==
                      canonicalVrfCoordinator.toLowerCase() ||
                    coordinatorTransaction.value !== 0n ||
                    coordinatorTransaction.input
                      .slice(0, 10)
                      .toLowerCase() !==
                      VRF_FULFILL_RANDOM_WORDS_SELECTOR
                  ) {
                    return;
                  }
                  cacheCoordinatorTransaction(
                    coordinatorTransaction,
                  );
                  if (waitingCandidate !== undefined) {
                    await queueCompleteCandidate(
                      waitingCandidate,
                    );
                  }

                  const currentHead =
                    await exactStateClient.getBlockNumber();
                  const lifecycleRound =
                    await exactStateClient.readContract({
                      address: poolAddress,
                      abi: poolAbi,
                      functionName: "ethPendingRound",
                      blockNumber: currentHead,
                    });
                  if (lifecycleRound <= 0n) {
                    return;
                  }
                  const round =
                    await exactStateClient.readContract({
                      address: poolAddress,
                      abi: poolAbi,
                      functionName: "getRound",
                      args: [lifecycleRound],
                      blockNumber: currentHead,
                    });
                  if (
                    round.state !== ROUND_STATE.pulling ||
                    round.fwaResolved ||
                    round.fwaRequestId <= 0n
                  ) {
                    return;
                  }
                  const prerequisite =
                    await validatePendingFwaFulfillment({
                      rawTransaction:
                        resolved.rawTransaction,
                      expectedHash: hash,
                      rpcTransaction,
                      expectedCoordinator:
                        canonicalVrfCoordinator,
                      expectedConsumer: fwa,
                      expectedSubId: vrfSubId,
                      expectedRequestId:
                        round.fwaRequestId,
                    });
                  log(
                    "info",
                    "pending_fwa_candidate_validated",
                    {
                      hash: prerequisite.hash,
                      requestId:
                        prerequisite.requestId.toString(),
                      round: lifecycleRound.toString(),
                      sender: prerequisite.sender,
                      nonce: prerequisite.nonce,
                      observedToResolutionMs:
                        performance.now() - observedAt,
                    },
                  );
                  if (executionController.stopping) return;
                  await queueCompleteCandidate(prerequisite);
                } catch (error) {
                  const validationError =
                    error instanceof
                      PendingFwaFulfillmentValidationError ||
                    error instanceof
                      PendingFundingValidationError;
                  log(
                    "debug",
                    "pending_fwa_candidate_rejected",
                    {
                      hash,
                      reason: validationError
                        ? error.code
                        : "rpc_resolution_failed",
                      observedToResolutionMs:
                        performance.now() - observedAt,
                      ...(validationError
                        ? {}
                        : errorFingerprint(error)),
                    },
                  );
                }
              })().finally(() => {
                resolutions.delete(resolution);
              });
              resolutions.add(resolution);
            },
            onError: (error) => {
              log(
                "warn",
                "pending_fwa_subscription_failed",
                {
                  errorClass: error.code,
                  action:
                    "reconnecting_same_filtered_subscription",
                },
              );
            },
          });
        try {
          await Promise.race([
            subscription.ready,
            new Promise<never>((_, reject) => {
              const timer = setTimeout(() => {
                reject(
                  new Error(
                    "pending FWA subscription did not become ready",
                  ),
                );
              }, 10_000);
              timer.unref();
            }),
          ]);
        } catch (error) {
          subscription.close();
          throw error;
        }
        closePendingFwaRuntime = async () => {
          subscription.close();
          queuedCandidate = undefined;
          waitingCandidate = undefined;
          coordinatorTransactions.clear();
          replacementTracker.clear();
          const drain =
            executionController.stopAndDrain();
          await Promise.allSettled([...resolutions]);
          await drain;
        };
        log("info", "pending_fwa_subscription_started", {
          coordinator: canonicalVrfCoordinator,
          consumer: fwa,
          hashesOnly: true,
          transport: "websocket",
          resolutionConcurrencyLimit: 32,
          fallback: "none",
        });
      }
    }
  } else if (!config.dryRun) {
    throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  }

  if (!config.dryRun) {
    log("info", "signer_initialization_ready", {
      durationMs: performance.now() - startupStartedAt,
      pendingFundingReady:
        !pendingFundingExecutionEnabled(config) ||
        activatePendingFundingExecution !== undefined,
      pendingFwaReady:
        !pendingFwaFulfillmentExecutionEnabled(config) ||
        activatePendingFwaExecution !== undefined,
    });
    signerLease = await acquireSignerLease({
      connectionString: config.databaseUrl!,
      onWaiting: () => {
        log("warn", "signer_lease_waiting");
      },
    });
    log("info", "signer_lease_acquired", {
      waitedMs: signerLease.waitedMs,
      initializationDurationMs:
        performance.now() - startupStartedAt,
    });
    activatePendingFundingExecution?.();
    activatePendingFwaExecution?.();
  }

  const accountAddress =
    typeof account === "string" ? account : account.address;
  const balance = await publicClient.getBalance({ address: accountAddress });
  log("info", "keeper_started", {
    chainId,
    poolVersion: config.poolVersion,
    poolVersions: JSON.stringify(
      v2Config === undefined ? ["v1"] : ["v1", "v2"],
    ),
    v2Enabled: v2Config !== undefined,
    v2Pool: v2Config?.expectedPoolAddress ?? "",
    v2Factory: v2Config?.factoryAddress ?? "",
    factory: config.factoryAddress,
    vaultFactory: config.vaultFactoryAddress,
    pool: poolAddress,
    account: accountAddress,
    accountBalance: eth(balance),
    minimumProfitFloor: eth(
      requiredProfit(config.minProfitWei),
    ),
    dryRun: config.dryRun,
    runOnce: config.runOnce,
    submissionMode: config.submissionMode,
    relayCount: config.flashbotsRelayUrls.length,
    builderCount: config.flashbotsBuilders.length,
    configuredBuilderBidBps: config.builderBidBps.toString(),
    configuredPendingFundingBuilderBidBps:
      config.pendingFundingBuilderBidBps.toString(),
    adaptiveBidMinimumBps:
      config.adaptiveBidMinBps.toString(),
    adaptiveBidEvidenceMaxAgeBlocks:
      config.adaptiveBidEvidenceMaxAgeBlocks.toString(),
    configuredPoolBuilderBidBps:
      config.poolBuilderBidBps.toString(),
    configuredPoolPullBuilderBidBps:
      config.poolPullBuilderBidBps.toString(),
    activeV2PoolPullBuilderBidBps:
      v2Config === undefined
        ? ""
        : (v2PoolPullBidController?.currentBidBps(
            v2Config.expectedPoolAddress,
          ) ?? config.poolPullBuilderBidBps
          ).toString(),
    v2PoolPullAdaptiveBidding:
      v2PoolPullBidController !== undefined,
    v2PoolPullPricingBoundary:
      v2PoolPullBidController === undefined
        ? "configured_fee_and_profitability"
        : "exact_profitability_only",
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
    pendingFundingBackruns:
      pendingFundingExecutionEnabled(config),
    pendingFwaFulfillmentBackruns:
      pendingFwaFulfillmentExecutionEnabled(config),
    directCoinbasePayments:
      config.enableDirectCoinbasePayments,
    directCoinbasePaymentHelper:
      config.enableDirectCoinbasePayments
        ? DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS
        : "",
    liveBidAdapter: config.liveBidAdapterAddress,
    poolBountyEstimateBps:
      config.poolBountyEstimateBps.toString(),
    poolPullBountyEstimateBps:
      config.poolPullBountyEstimateBps.toString(),
    fwaProcessGasLimit: config.fwaProcessGasLimit.toString(),
    fwaProcessMaxCount: config.fwaProcessMaxCount,
    discordNotifications: discordNotifier !== undefined,
    durableTelemetry: telemetrySink !== undefined,
    exactStateTransport,
    sourceRevision: sourceRevision ?? "",
    deploymentId: deploymentId ?? "",
  });

  let lastProcessedBlock = -1n;
  do {
    let passFailed = false;
    let attemptedPassId: string | undefined;
    let attemptedBlock: bigint | undefined;
    let attemptedHeadSource: string | undefined;
    try {
      let subscribedBlock =
        headSignal.latestAfter(lastProcessedBlock);
      if (
        config.headRpcUrl !== undefined &&
        lastProcessedBlock >= 0n &&
        subscribedBlock === undefined
      ) {
        const observed = await Promise.race([
          headSignal.waitForNewer(
            lastProcessedBlock,
            config.headStaleTimeoutMs,
          ),
          stopRequested.then(() => false),
        ]);
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
      const observedHead =
        subscribedBlock !== undefined &&
        latestSubscribedHead?.number === subscribedBlock
          ? latestSubscribedHead
          : undefined;
      signerCoordinator.observeHead(block);
      const headSource =
        subscribedBlock !== undefined
          ? "websocket"
          : config.headRpcUrl !== undefined
            ? "initial_http"
            : "poll";
      if (block !== lastProcessedBlock) {
        const passId = randomUUID();
        attemptedPassId = passId;
        attemptedBlock = block;
        attemptedHeadSource = headSource;
        const passStartedAt = performance.now();
        await withLogContext(
          {
            passId,
            observedBlock: block.toString(),
            headSource,
          },
          async () => {
            log("debug", "new_block", { block: block.toString() });
            const additionalPoolConfigs = (async () => {
              const activation =
                await readPullPoolV2ActivationSignal(
                  exactStateClient,
                  block,
                );
              const shouldEnable =
                activation.activated &&
                !activation.deprecated;
              if (shouldEnable && !v2RuntimeVerified) {
                const verified =
                  await readPullPoolV2LaunchState(
                    exactStateClient,
                    block,
                  );
                if (!verified.selected) {
                  throw new Error(
                    "PullPool V2 activation failed pinned runtime verification",
                  );
                }
                v2RuntimeVerified = true;
              }
              if (shouldEnable && v2Config === undefined) {
                v2Config = configurePullPoolV2(config);
              }
              if (shouldEnable !== v2Enabled) {
                v2Enabled = shouldEnable;
                log(
                  shouldEnable ? "info" : "warn",
                  "pull_pool_adapter_state_changed",
                  {
                    block: block.toString(),
                    poolVersion: "v2",
                    enabled: shouldEnable,
                    paused: activation.paused,
                    deprecated: activation.deprecated,
                    roundCount:
                      activation.roundCount.toString(),
                    activeVersions: JSON.stringify(
                      shouldEnable ? ["v1", "v2"] : ["v1"],
                    ),
                    action: shouldEnable
                      ? "merge_into_single_signer_pass"
                      : "retain_v1_and_disarm_v2",
                  },
                );
              }
              return shouldEnable && v2Config !== undefined
                ? [v2Config]
                : [];
            })();
            const assertPoolAdaptersCurrent =
              async (): Promise<void> => {
                await additionalPoolConfigs;
              };
            if (!config.dryRun) {
              await assertSignerLeaseHeld();
            }
            const passResult = await runKeeperPass({
              publicClient: exactStateClient,
              discoveryClient,
              headBlockNumber: block,
              exactStateTransport,
              ...(observedHead === undefined
                ? {}
                : { observedHead }),
              account,
              config,
              additionalPoolConfigs,
              sendTransaction,
              sendBatch,
              waitForTargetBlock,
              observePrivateBatch,
              observePoolPullBatch,
              observePoolLifecycleBatch,
              preSubmissionGate: assertPoolAdaptersCurrent,
            });
            await assertPoolAdaptersCurrent();
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
          ...errorFingerprint(error),
          action: "stopping_signer",
        });
        throw error;
      }
      if (error instanceof HeadSubscriptionStaleError) {
        log("error", "head_subscription_stale", {
          reason: error.message,
          ...errorFingerprint(error),
          action: "restarting_worker",
        });
        throw error;
      }
      passFailed = true;
      log("error", "keeper_pass_failed", {
        reason: errorMessage(error),
        ...errorFingerprint(error),
        ...(attemptedPassId === undefined
          ? {}
          : { passId: attemptedPassId }),
        ...(attemptedBlock === undefined
          ? {}
          : {
              block: attemptedBlock.toString(),
              observedBlock: attemptedBlock.toString(),
            }),
        ...(attemptedHeadSource === undefined
          ? {}
          : { headSource: attemptedHeadSource }),
      });
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
  log("error", "fatal", {
    reason: errorMessage(error),
    ...errorFingerprint(error),
  });
  await closeRuntimeResources();
  process.exitCode = 1;
});
