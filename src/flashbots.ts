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
  readonly revert?: string;
  readonly txHash?: Hash;
}

export interface CallBundleResult {
  readonly results?: readonly CallBundleItem[];
}

interface SendBundleResult {
  readonly bundleHash: Hash;
  readonly smart?: string;
}

export interface FlashbotsSubmission {
  readonly bundleHash: Hash;
  readonly relayUrl: string;
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
    if (!response.ok) {
      throw new Error(
        `Flashbots relay ${this.#url} returned HTTP ${response.status}`,
      );
    }
    const payload = (await response.json()) as JsonRpcResponse<T>;
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
