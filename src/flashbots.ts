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

export interface CallBundleItem {
  readonly error?: string;
  readonly gasUsed?: number | string;
  readonly revert?: string;
  readonly txHash?: Hash;
}

export interface CallBundleResult {
  readonly bundleHash?: Hash;
  readonly coinbaseDiff?: string;
  readonly results?: readonly CallBundleItem[];
  readonly totalGasUsed?: number | string;
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

export class FlashbotsRelay {
  readonly #url: string;
  readonly #authAccount: PrivateKeyAccount;
  readonly #timeoutMs: number;

  constructor(parameters: {
    url: string;
    authAccount: PrivateKeyAccount;
    timeoutMs: number;
  }) {
    this.#url = parameters.url;
    this.#authAccount = parameters.authAccount;
    this.#timeoutMs = parameters.timeoutMs;
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
      throw new Error(
        `Flashbots ${method} failed (${payload.error.code}): ${payload.error.message}`,
      );
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
    return this.#request<CallBundleResult>("eth_callBundle", [
      {
        txs: transactions,
        blockNumber: `0x${targetBlock.toString(16)}`,
        stateBlockNumber: "latest",
      },
    ]);
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

export async function longestValidBundlePrefix(
  relay: FlashbotsRelay,
  transactions: readonly Hex[],
  targetBlock: bigint,
): Promise<number> {
  if (transactions.length === 0) return 0;

  try {
    const result = await relay.callBundle(transactions, targetBlock);
    const prefixLength = successfulPrefixLength(result, transactions.length);
    if (prefixLength === 0 || prefixLength === transactions.length) {
      return prefixLength;
    }
    const confirmation = await relay.callBundle(
      transactions.slice(0, prefixLength),
      targetBlock,
    );
    return successfulPrefixLength(confirmation, prefixLength);
  } catch (fullBundleError) {
    let prefixLength = 0;
    for (let length = 1; length <= transactions.length; length += 1) {
      try {
        const result = await relay.callBundle(
          transactions.slice(0, length),
          targetBlock,
        );
        if (successfulPrefixLength(result, length) !== length) break;
        prefixLength = length;
      } catch {
        break;
      }
    }
    if (prefixLength === 0) throw fullBundleError;
    return prefixLength;
  }
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
): Promise<readonly FlashbotsSubmission[]> {
  if (transactions.length === 0) return [];

  const attempts = relays.flatMap((relay) =>
    transactions.map((_, index) => {
      const transactionCount = index + 1;
      return {
        relay,
        transactionCount,
        promise: relay.sendBundle(
          transactions.slice(0, transactionCount),
          targetBlock,
          builders,
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
