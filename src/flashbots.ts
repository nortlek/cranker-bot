import {
  keccak256,
  toBytes,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JsonRpcResponse<T> {
  readonly result?: T;
  readonly error?: JsonRpcError;
}

export class FlashbotsRpcError extends Error {
  readonly code: number;

  constructor(method: string, error: JsonRpcError) {
    super(`Flashbots ${method} failed (${error.code}): ${error.message}`);
    this.name = "FlashbotsRpcError";
    this.code = error.code;
  }
}

const CALL_BUNDLE_STATE_RETRY_WINDOW_MS = 1_000;
const CALL_BUNDLE_STATE_RETRY_INTERVAL_MS = 100;
const CALL_BUNDLE_FUTURE_BASE_FEE_RETRY_WINDOW_MS = 500;

function isCallBundleStateUnavailable(error: unknown): boolean {
  return (
    error instanceof FlashbotsRpcError &&
    error.code === -32_001 &&
    error.message.includes("block not found")
  );
}

function isCallBundleFutureBaseFeeUnavailable(
  error: unknown,
): boolean {
  return (
    error instanceof FlashbotsRpcError &&
    error.code === -32_000 &&
    error.message.includes(
      "max fee per gas less than block base fee",
    )
  );
}

export interface CallBundleItem {
  readonly coinbaseDiff?: string;
  readonly error?: string;
  readonly ethSentToCoinbase?: string;
  readonly gasUsed?: number | string;
  readonly revert?: string;
  readonly txHash?: Hash;
}

export interface CallBundleResult {
  readonly bundleHash?: Hash;
  readonly coinbaseDiff?: string;
  readonly ethSentToCoinbase?: string;
  readonly results?: readonly CallBundleItem[];
  readonly totalGasUsed?: number | string;
}

export interface CallBundleStateAvailabilityWait {
  readonly targetBlock: bigint;
  readonly stateBlockNumber: bigint;
  readonly attempts: number;
  readonly waitMs: number;
}

export interface DirectCoinbasePaymentValidation {
  readonly totalCoinbasePayment: bigint;
  readonly directCoinbasePayment: bigint;
  readonly reportedCoinbaseDiff: bigint;
  readonly aggregateBaseFeeArtifact: boolean;
}

export interface EmbeddedCoinbasePaymentValidation {
  readonly totalCoinbasePayment: bigint;
  readonly embeddedCoinbasePayment: bigint;
}

interface SendBundleResult {
  readonly bundleHash: Hash;
  readonly smart?: boolean | string;
}

export interface FlashbotsSubmission {
  readonly bundleHash: Hash;
  readonly relayUrl: string;
  readonly smart: boolean;
  readonly transactionCount: number;
}

export interface BundlePrefixSimulation {
  readonly prefixLength: number;
  readonly simulation: CallBundleResult | undefined;
}

export interface FutureBaseFeeAvailabilityWait {
  readonly targetBlock: bigint;
  readonly attempts: number;
  readonly waitMs: number;
}

export interface RelaySubmissionAttempt {
  readonly relayIndex: number;
  readonly transactionCount: number;
  readonly durationMs: number;
  readonly status: "accepted" | "rejected";
  readonly bundleHash?: Hash;
  readonly smart?: boolean;
  readonly reason?: string;
}

export class FlashbotsRelay {
  readonly #url: string;
  readonly #authAccount: PrivateKeyAccount;
  readonly #timeoutMs: number;
  readonly #reportStateAvailabilityWait:
    | ((wait: CallBundleStateAvailabilityWait) => void)
    | undefined;

  constructor(parameters: {
    url: string;
    authAccount: PrivateKeyAccount;
    timeoutMs: number;
    reportStateAvailabilityWait?: (
      wait: CallBundleStateAvailabilityWait,
    ) => void;
  }) {
    this.#url = parameters.url;
    this.#authAccount = parameters.authAccount;
    this.#timeoutMs = parameters.timeoutMs;
    this.#reportStateAvailabilityWait =
      parameters.reportStateAvailabilityWait;
  }

  get url(): string {
    return this.#url;
  }

  async #request<T>(method: string, params: readonly unknown[]): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    const bodyHash = keccak256(toBytes(body));
    const signature = await this.#authAccount.signMessage({
      message: bodyHash,
    });
    const response = await fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flashbots-signature": `${this.#authAccount.address}:${signature}`,
      },
      body,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const responseBody = await response.text();
    if (!response.ok) {
      let detail = "";
      try {
        const errorPayload = JSON.parse(
          responseBody,
        ) as JsonRpcResponse<unknown>;
        detail =
          errorPayload.error?.message === undefined
            ? ""
            : `: ${errorPayload.error.message}`;
      } catch {
        const compact = responseBody
          .replaceAll(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        detail = compact === "" ? "" : `: ${compact}`;
      }
      throw new Error(
        `Flashbots relay ${this.#url} returned HTTP ${response.status}${detail}`,
      );
    }
    const payload = JSON.parse(responseBody) as JsonRpcResponse<T>;
    if (payload.error !== undefined) {
      throw new FlashbotsRpcError(method, payload.error);
    }
    if (payload.result === undefined) {
      throw new Error(`Flashbots ${method} returned no result`);
    }
    return payload.result;
  }

  async callBundle(
    transactions: readonly Hex[],
    targetBlock: bigint,
  ): Promise<CallBundleResult> {
    if (targetBlock <= 0n) {
      throw new Error("bundle target block must have a parent");
    }
    const parameters = [
      {
        txs: transactions,
        blockNumber: `0x${targetBlock.toString(16)}`,
        stateBlockNumber: `0x${(targetBlock - 1n).toString(16)}`,
      },
    ] as const;
    const stateBlockNumber = targetBlock - 1n;
    const startedAt = Date.now();
    let attempts = 0;
    const deadline = Date.now() + CALL_BUNDLE_STATE_RETRY_WINDOW_MS;
    for (;;) {
      try {
        attempts += 1;
        const result = await this.#request<CallBundleResult>(
          "eth_callBundle",
          parameters,
        );
        if (attempts > 1) {
          try {
            this.#reportStateAvailabilityWait?.({
              targetBlock,
              stateBlockNumber,
              attempts,
              waitMs: Date.now() - startedAt,
            });
          } catch {
            // Simulation telemetry is fail-open.
          }
        }
        return result;
      } catch (error) {
        if (!isCallBundleStateUnavailable(error) || Date.now() >= deadline) {
          throw error;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, CALL_BUNDLE_STATE_RETRY_INTERVAL_MS),
        );
        if (Date.now() >= deadline) {
          throw error;
        }
      }
    }
  }

  async sendBundle(
    transactions: readonly Hex[],
    targetBlock: bigint,
    builders: readonly string[],
  ): Promise<SendBundleResult> {
    return this.#request<SendBundleResult>("eth_sendBundle", [
      {
        txs: transactions,
        blockNumber: `0x${targetBlock.toString(16)}`,
        ...(builders.length === 0 ? {} : { builders }),
      },
    ]);
  }
}

export function successfulPrefixLength(
  result: CallBundleResult,
  transactionCount: number,
): number {
  const items = result.results;
  if (items === undefined || items.length !== transactionCount) {
    throw new Error("Flashbots simulation returned an incomplete result set");
  }
  const firstFailure = items.findIndex(
    (item) => item.error !== undefined || item.revert !== undefined,
  );
  return firstFailure === -1 ? transactionCount : firstFailure;
}

export function simulatedGasUsed(
  result: CallBundleResult,
  transactionCount: number,
): bigint[] {
  const items = result.results;
  if (items === undefined || items.length !== transactionCount) {
    throw new Error("Flashbots simulation returned an incomplete result set");
  }
  return items.map((item) => {
    if (item.error !== undefined || item.revert !== undefined) {
      throw new Error("Flashbots simulation contains a reverting transaction");
    }
    if (item.gasUsed === undefined) {
      throw new Error("Flashbots simulation did not report transaction gas");
    }
    const gas = BigInt(item.gasUsed);
    if (gas <= 0n) {
      throw new Error("Flashbots simulation reported non-positive gas");
    }
    return gas;
  });
}

export function validateDirectCoinbasePaymentSimulation(parameters: {
  readonly result: CallBundleResult;
  readonly transactionCount: number;
  readonly helperIndex: number;
  readonly expectedTotalCoinbasePayment: bigint;
  readonly expectedDirectCoinbasePayment: bigint;
  readonly allowLowerAggregateBaseFeeArtifact?: boolean;
}): DirectCoinbasePaymentValidation {
  if (
    parameters.helperIndex < 0 ||
    parameters.helperIndex >= parameters.transactionCount
  ) {
    throw new Error("direct payment helper index is outside the bundle");
  }
  const items = parameters.result.results;
  if (
    items === undefined ||
    items.length !== parameters.transactionCount
  ) {
    throw new Error(
      "direct payment simulation returned an incomplete result set",
    );
  }
  const helper = items[parameters.helperIndex];
  if (helper === undefined) {
    throw new Error(
      "direct payment simulation omitted the helper transaction",
    );
  }
  if (
    parameters.result.coinbaseDiff === undefined ||
    helper.ethSentToCoinbase === undefined
  ) {
    throw new Error(
      "direct payment simulation omitted coinbase accounting",
    );
  }
  const reportedCoinbaseDiff = BigInt(
    parameters.result.coinbaseDiff,
  );
  const directCoinbasePayment = BigInt(
    helper.ethSentToCoinbase,
  );
  if (
    directCoinbasePayment !==
    parameters.expectedDirectCoinbasePayment
  ) {
    throw new Error(
      `direct payment simulation reported helper payment ${directCoinbasePayment}, expected ${parameters.expectedDirectCoinbasePayment}`,
    );
  }
  const aggregateMatches =
    reportedCoinbaseDiff ===
    parameters.expectedTotalCoinbasePayment;
  const lowerAggregateBaseFeeArtifact =
    parameters.allowLowerAggregateBaseFeeArtifact === true &&
    parameters.expectedTotalCoinbasePayment ===
      parameters.expectedDirectCoinbasePayment &&
    reportedCoinbaseDiff <
      parameters.expectedTotalCoinbasePayment &&
    items.every(
      (item, index) =>
        index === parameters.helperIndex ||
        item.ethSentToCoinbase === "0",
    );
  if (!aggregateMatches && !lowerAggregateBaseFeeArtifact) {
    throw new Error(
      `direct payment simulation reported total coinbase payment ${reportedCoinbaseDiff}, expected ${parameters.expectedTotalCoinbasePayment}`,
    );
  }
  return {
    totalCoinbasePayment:
      parameters.expectedTotalCoinbasePayment,
    directCoinbasePayment,
    reportedCoinbaseDiff,
    aggregateBaseFeeArtifact:
      lowerAggregateBaseFeeArtifact,
  };
}

export function validateEmbeddedCoinbasePaymentSimulation(parameters: {
  readonly result: CallBundleResult;
  readonly transactionCount: number;
  readonly paymentIndex: number;
  readonly expectedTotalCoinbasePayment: bigint;
  readonly expectedEmbeddedCoinbasePayment: bigint;
}): EmbeddedCoinbasePaymentValidation {
  if (
    parameters.paymentIndex < 0 ||
    parameters.paymentIndex >= parameters.transactionCount
  ) {
    throw new Error("embedded payment index is outside the bundle");
  }
  const items = parameters.result.results;
  if (
    items === undefined ||
    items.length !== parameters.transactionCount
  ) {
    throw new Error(
      "embedded payment simulation returned an incomplete result set",
    );
  }
  const payment = items[parameters.paymentIndex];
  if (
    payment === undefined ||
    payment.ethSentToCoinbase === undefined ||
    parameters.result.coinbaseDiff === undefined
  ) {
    throw new Error(
      "embedded payment simulation omitted coinbase accounting",
    );
  }
  const totalCoinbasePayment = BigInt(
    parameters.result.coinbaseDiff,
  );
  const embeddedCoinbasePayment = BigInt(
    payment.ethSentToCoinbase,
  );
  if (
    totalCoinbasePayment !==
    parameters.expectedTotalCoinbasePayment
  ) {
    throw new Error(
      `embedded payment simulation reported total coinbase payment ${totalCoinbasePayment}, expected ${parameters.expectedTotalCoinbasePayment}`,
    );
  }
  if (
    embeddedCoinbasePayment !==
    parameters.expectedEmbeddedCoinbasePayment
  ) {
    throw new Error(
      `embedded payment simulation reported direct payment ${embeddedCoinbasePayment}, expected ${parameters.expectedEmbeddedCoinbasePayment}`,
    );
  }
  return { totalCoinbasePayment, embeddedCoinbasePayment };
}

async function simulateLongestValidBundlePrefixOnce(
  relay: FlashbotsRelay,
  transactions: readonly Hex[],
  targetBlock: bigint,
): Promise<BundlePrefixSimulation> {
  if (transactions.length === 0) {
    return { prefixLength: 0, simulation: undefined };
  }

  const confirmResult = async (
    result: CallBundleResult,
    transactionCount: number,
  ): Promise<BundlePrefixSimulation> => {
    const prefixLength = successfulPrefixLength(
      result,
      transactionCount,
    );
    if (prefixLength === 0) {
      return { prefixLength, simulation: undefined };
    }
    if (prefixLength === transactionCount) {
      return { prefixLength, simulation: result };
    }
    const confirmation = await relay.callBundle(
      transactions.slice(0, prefixLength),
      targetBlock,
    );
    return confirmResult(confirmation, prefixLength);
  };

  try {
    const result = await relay.callBundle(transactions, targetBlock);
    return confirmResult(
      result,
      transactions.length,
    );
  } catch (fullBundleError) {
    // A fee-vs-base-fee response rejects every prefix equally. Let the outer
    // bounded publication-skew retry handle it instead of probing prefixes.
    if (isCallBundleFutureBaseFeeUnavailable(fullBundleError)) {
      throw fullBundleError;
    }
    let prefixLength = 0;
    let simulation: CallBundleResult | undefined;
    for (let length = 1; length <= transactions.length; length += 1) {
      try {
        const result = await relay.callBundle(
          transactions.slice(0, length),
          targetBlock,
        );
        if (successfulPrefixLength(result, length) !== length) break;
        prefixLength = length;
        simulation = result;
      } catch {
        break;
      }
    }
    if (prefixLength === 0) throw fullBundleError;
    return { prefixLength, simulation };
  }
}

export async function simulateLongestValidBundlePrefix(
  relay: FlashbotsRelay,
  transactions: readonly Hex[],
  targetBlock: bigint,
  reportFutureBaseFeeWait?: (
    wait: FutureBaseFeeAvailabilityWait,
  ) => void,
): Promise<BundlePrefixSimulation> {
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    try {
      attempts += 1;
      const result = await simulateLongestValidBundlePrefixOnce(
        relay,
        transactions,
        targetBlock,
      );
      if (attempts > 1) {
        try {
          reportFutureBaseFeeWait?.({
            targetBlock,
            attempts,
            waitMs: Date.now() - startedAt,
          });
        } catch {
          // Simulation telemetry is fail-open.
        }
      }
      return result;
    } catch (error) {
      if (
        !isCallBundleFutureBaseFeeUnavailable(error) ||
        Date.now() - startedAt >=
          CALL_BUNDLE_FUTURE_BASE_FEE_RETRY_WINDOW_MS
      ) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, CALL_BUNDLE_STATE_RETRY_INTERVAL_MS),
      );
      if (
        Date.now() - startedAt >=
        CALL_BUNDLE_FUTURE_BASE_FEE_RETRY_WINDOW_MS
      ) {
        throw error;
      }
    }
  }
}

export async function longestValidBundlePrefix(
  relay: FlashbotsRelay,
  transactions: readonly Hex[],
  targetBlock: bigint,
): Promise<number> {
  return (
    await simulateLongestValidBundlePrefix(
      relay,
      transactions,
      targetBlock,
    )
  ).prefixLength;
}

export async function submitBundleToRelays(
  relays: readonly FlashbotsRelay[],
  transactions: readonly Hex[],
  targetBlock: bigint,
  builders: readonly string[],
): Promise<readonly FlashbotsSubmission[]> {
  const results = await Promise.allSettled(
    relays.map(async (relay) => ({
      ...(await relay.sendBundle(transactions, targetBlock, builders)),
      relayUrl: relay.url,
    })),
  );
  const submissions: FlashbotsSubmission[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      submissions.push({
        bundleHash: result.value.bundleHash,
        relayUrl: result.value.relayUrl,
        smart:
          result.value.smart === true ||
          result.value.smart === "true",
        transactionCount: transactions.length,
      });
    } else {
      failures.push(
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      );
    }
  }
  if (submissions.length === 0) {
    throw new Error(
      `all private relays rejected the bundle: ${failures.join("; ")}`,
    );
  }
  return submissions;
}

/**
 * Sends every contiguous nonce prefix as an alternative bundle. Only one
 * prefix can land because the alternatives share nonces, but a conflict late
 * in the full batch no longer destroys an otherwise valid earlier prefix.
 */
export async function submitBundlePrefixLadder(
  relays: readonly FlashbotsRelay[],
  transactions: readonly Hex[],
  targetBlock: bigint,
  builders: readonly string[],
  minimumTransactionCount = 1,
  onAttempt?: (attempt: RelaySubmissionAttempt) => void,
): Promise<readonly FlashbotsSubmission[]> {
  if (transactions.length === 0) return [];
  if (
    !Number.isSafeInteger(minimumTransactionCount) ||
    minimumTransactionCount < 1 ||
    minimumTransactionCount > transactions.length
  ) {
    throw new Error(
      "minimumTransactionCount must select a non-empty bundle prefix",
    );
  }

  const attempts = relays.flatMap((relay, relayIndex) =>
    transactions.slice(minimumTransactionCount - 1).map((_, index) => {
      const transactionCount =
        minimumTransactionCount + index;
      const startedAt = performance.now();
      return {
        relay,
        relayIndex,
        transactionCount,
        promise: relay.sendBundle(
          transactions.slice(0, transactionCount),
          targetBlock,
          builders,
        ).then(
          (result) => {
            try {
              onAttempt?.({
                relayIndex,
                transactionCount,
                durationMs: performance.now() - startedAt,
                status: "accepted",
                bundleHash: result.bundleHash,
                smart:
                  result.smart === true || result.smart === "true",
              });
            } catch {
              // Telemetry must never change relay delivery.
            }
            return result;
          },
          (error: unknown) => {
            try {
              onAttempt?.({
                relayIndex,
                transactionCount,
                durationMs: performance.now() - startedAt,
                status: "rejected",
                reason:
                  error instanceof Error
                    ? error.message
                    : String(error),
              });
            } catch {
              // Telemetry must never change relay delivery.
            }
            throw error;
          },
        ),
      };
    }),
  );
  const results = await Promise.allSettled(
    attempts.map(({ promise }) => promise),
  );
  const submissions: FlashbotsSubmission[] = [];
  const failures: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const attempt = attempts[index];
    if (result === undefined || attempt === undefined) continue;
    if (result.status === "fulfilled") {
      submissions.push({
        bundleHash: result.value.bundleHash,
        relayUrl: attempt.relay.url,
        smart:
          result.value.smart === true ||
          result.value.smart === "true",
        transactionCount: attempt.transactionCount,
      });
    } else {
      failures.push(
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      );
    }
  }
  if (submissions.length === 0) {
    throw new Error(
      `all private relays rejected every bundle prefix: ${failures.join("; ")}`,
    );
  }
  return submissions;
}
