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
