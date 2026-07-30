import type { Address } from "viem";

export interface SignerReservation {
  readonly id: symbol;
  readonly targetBlock: bigint;
  readonly nonce: number;
  readonly lane: string;
}

/**
 * Coordinates one private signer decision per target block. A reservation is
 * retained until the target block is observed so asynchronous opportunity
 * sources cannot build conflicting same-nonce bundles with misleading
 * receipt or adaptive-bid accounting.
 */
export class SignerSubmissionCoordinator {
  readonly #byTargetBlock = new Map<bigint, SignerReservation>();

  tryReserve(parameters: {
    readonly targetBlock: bigint;
    readonly nonce: number;
    readonly lane: string;
  }): SignerReservation | undefined {
    if (parameters.targetBlock < 1n) {
      throw new Error("signer reservation target block must be positive");
    }
    if (
      !Number.isSafeInteger(parameters.nonce) ||
      parameters.nonce < 0
    ) {
      throw new Error("signer reservation nonce must be non-negative");
    }
    if (parameters.lane.trim() === "") {
      throw new Error("signer reservation lane cannot be empty");
    }
    if (this.#byTargetBlock.has(parameters.targetBlock)) {
      return undefined;
    }
    const reservation: SignerReservation = {
      id: Symbol(parameters.lane),
      targetBlock: parameters.targetBlock,
      nonce: parameters.nonce,
      lane: parameters.lane,
    };
    this.#byTargetBlock.set(parameters.targetBlock, reservation);
    return reservation;
  }

  release(reservation: SignerReservation): boolean {
    const current = this.#byTargetBlock.get(
      reservation.targetBlock,
    );
    if (current?.id !== reservation.id) return false;
    this.#byTargetBlock.delete(reservation.targetBlock);
    return true;
  }

  observeHead(blockNumber: bigint): void {
    if (blockNumber < 0n) {
      throw new Error("observed head cannot be negative");
    }
    for (const targetBlock of this.#byTargetBlock.keys()) {
      if (targetBlock <= blockNumber) {
        this.#byTargetBlock.delete(targetBlock);
      }
    }
  }

  reservationFor(
    targetBlock: bigint,
  ): SignerReservation | undefined {
    return this.#byTargetBlock.get(targetBlock);
  }
}

export function signerNonceIsUsable(parameters: {
  readonly account: Address;
  readonly expectedNonce: number;
  readonly latestNonce: number;
  readonly pendingNonce: number;
}): boolean {
  if (
    !Number.isSafeInteger(parameters.expectedNonce) ||
    parameters.expectedNonce < 0 ||
    !Number.isSafeInteger(parameters.latestNonce) ||
    parameters.latestNonce < 0 ||
    !Number.isSafeInteger(parameters.pendingNonce) ||
    parameters.pendingNonce < 0
  ) {
    throw new Error(
      `invalid nonce state for signer ${parameters.account}`,
    );
  }
  return (
    parameters.latestNonce === parameters.pendingNonce &&
    parameters.latestNonce === parameters.expectedNonce
  );
}

/**
 * Owns the lifetime of the one asynchronous pending-event signer task.
 * Shutdown aborts work that has not submitted and drains the task before the
 * advisory signer lease can be released.
 */
export class PendingFundingExecutionController {
  #active: Promise<void> | undefined;
  #abortController: AbortController | undefined;
  #stopping = false;
  #enabled: boolean;

  constructor(initiallyEnabled = true) {
    this.#enabled = initiallyEnabled;
  }

  get active(): boolean {
    return this.#active !== undefined;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  activate(): boolean {
    if (this.#stopping) return false;
    this.#enabled = true;
    return true;
  }

  start(
    task: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> | undefined {
    if (
      !this.#enabled ||
      this.#stopping ||
      this.#active !== undefined
    ) {
      return undefined;
    }
    const abortController = new AbortController();
    this.#abortController = abortController;
    const active = Promise.resolve()
      .then(() => task(abortController.signal))
      .finally(() => {
        if (this.#active === active) {
          this.#active = undefined;
          this.#abortController = undefined;
        }
      });
    this.#active = active;
    return active;
  }

  async stopAndDrain(): Promise<void> {
    this.#stopping = true;
    this.#enabled = false;
    this.#abortController?.abort();
    await this.#active;
  }
}
