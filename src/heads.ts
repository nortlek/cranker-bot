import {
  hexToBigInt,
  isHash,
  isHex,
  type Hash,
  type Hex,
} from "viem";

export interface SubscribedHead {
  readonly number: bigint;
  readonly hash: Hash;
  readonly timestamp: bigint;
  readonly baseFeePerGas: bigint | null;
}

function requiredQuantity(
  value: unknown,
  field: string,
): bigint {
  if (
    typeof value !== "string" ||
    !isHex(value) ||
    value.length <= 2
  ) {
    throw new Error(
      `newHeads payload has invalid ${field}`,
    );
  }
  return hexToBigInt(value as Hex);
}

export function parseNewHeadsPayload(
  value: unknown,
): SubscribedHead {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("newHeads payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.hash !== "string" ||
    !isHash(payload.hash)
  ) {
    throw new Error("newHeads payload has invalid hash");
  }
  return {
    number: requiredQuantity(payload.number, "number"),
    hash: payload.hash,
    timestamp: requiredQuantity(
      payload.timestamp,
      "timestamp",
    ),
    baseFeePerGas:
      payload.baseFeePerGas === null ||
      payload.baseFeePerGas === undefined
        ? null
        : requiredQuantity(
            payload.baseFeePerGas,
            "baseFeePerGas",
          ),
  };
}

interface HeadWaiter {
  readonly afterBlock: bigint;
  readonly resolve: (observed: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

export class LatestHeadSignal {
  #latest: bigint | undefined;
  readonly #waiters = new Set<HeadWaiter>();
  #closed = false;

  observe(blockNumber: bigint): void {
    if (blockNumber < 0n) {
      throw new Error("head block number cannot be negative");
    }
    if (this.#closed) return;
    if (this.#latest === undefined || blockNumber > this.#latest) {
      this.#latest = blockNumber;
    }
    for (const waiter of this.#waiters) {
      if (blockNumber > waiter.afterBlock) {
        this.#resolve(waiter, true);
      }
    }
  }

  latestAfter(blockNumber: bigint): bigint | undefined {
    return this.#latest !== undefined && this.#latest > blockNumber
      ? this.#latest
      : undefined;
  }

  async waitForNewer(
    blockNumber: bigint,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("head wait timeout must be positive");
    }
    if (this.#closed) return false;
    if (this.latestAfter(blockNumber) !== undefined) return true;
    return new Promise<boolean>((resolve) => {
      const waiter: HeadWaiter = {
        afterBlock: blockNumber,
        resolve,
        timer: setTimeout(() => {
          this.#resolve(waiter, false);
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.#waiters.add(waiter);
      if (this.#closed) this.#resolve(waiter, false);
      else if (this.latestAfter(blockNumber) !== undefined)
        this.#resolve(waiter, true);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters) {
      this.#resolve(waiter, false);
    }
  }

  #resolve(waiter: HeadWaiter, observed: boolean): void {
    if (!this.#waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(observed);
  }
}

export type TargetBoundReadResult<Value> =
  | {
      readonly status: "ready";
      readonly value: Value;
    }
  | {
      readonly status: "target_observed";
      readonly observedBlock?: bigint;
    };

/**
 * Completes an exact-state gate only while the target block is still in the
 * future. The subscribed head is authoritative for the deadline: a lagging or
 * stalled RPC read must never make a stale private bundle look submit-able.
 */
export async function readBeforeTargetBlock<Value>(parameters: {
  readonly headSignal: LatestHeadSignal;
  readonly targetBlock: bigint;
  readonly timeoutMs: number;
  readonly read: () => Promise<Value>;
}): Promise<TargetBoundReadResult<Value>> {
  if (parameters.targetBlock <= 0n) {
    throw new Error("target block must be positive");
  }
  if (
    !Number.isSafeInteger(parameters.timeoutMs) ||
    parameters.timeoutMs < 1
  ) {
    throw new Error("target-bound read timeout must be positive");
  }
  const parentBlock = parameters.targetBlock - 1n;
  const alreadyObserved =
    parameters.headSignal.latestAfter(parentBlock);
  if (alreadyObserved !== undefined) {
    return {
      status: "target_observed",
      observedBlock: alreadyObserved,
    };
  }
  return Promise.race([
    parameters.read().then((value) => {
      const observedBlock =
        parameters.headSignal.latestAfter(parentBlock);
      return observedBlock === undefined
        ? ({ status: "ready", value } as const)
        : ({
            status: "target_observed",
            observedBlock,
          } as const);
    }),
    parameters.headSignal
      .waitForNewer(parentBlock, parameters.timeoutMs)
      .then(() => {
        const observedBlock =
          parameters.headSignal.latestAfter(parentBlock);
        return {
          status: "target_observed",
          ...(observedBlock === undefined
            ? {}
            : { observedBlock }),
        } as const;
      }),
  ]);
}

export async function retryTransientRead<Value>(parameters: {
  readonly read: () => Promise<Value>;
  readonly shouldRetry: (error: unknown) => boolean;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}): Promise<{
  readonly value: Value;
  readonly attempts: number;
  readonly waitedMs: number;
}> {
  if (
    !Number.isSafeInteger(parameters.maxAttempts) ||
    parameters.maxAttempts < 1
  ) {
    throw new Error("transient read attempts must be positive");
  }
  if (
    !Number.isSafeInteger(parameters.retryDelayMs) ||
    parameters.retryDelayMs < 1
  ) {
    throw new Error("transient read delay must be positive");
  }
  for (
    let attempt = 1;
    attempt <= parameters.maxAttempts;
    attempt += 1
  ) {
    try {
      return {
        value: await parameters.read(),
        attempts: attempt,
        waitedMs: (attempt - 1) * parameters.retryDelayMs,
      };
    } catch (error) {
      if (
        attempt === parameters.maxAttempts ||
        !parameters.shouldRetry(error)
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, parameters.retryDelayMs);
      });
    }
  }
  throw new Error("unreachable transient read state");
}
