import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface AdaptiveBidPolicy {
  readonly baselineBidBps: bigint;
  readonly maximumBidBps: bigint;
  readonly lossStepBps: bigint;
  readonly winDecayBps: bigint;
  readonly winsBeforeDecay: number;
}

export interface AdaptiveBidState {
  readonly currentBidBps: bigint;
  readonly consecutiveFullWins: number;
  readonly lastObservedWinningBidBps?: bigint;
  readonly lastUpdatedBlock?: bigint;
}

export type AdaptiveBidOutcome =
  | {
      readonly kind: "full_win";
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: "miss";
      readonly blockNumber: bigint;
      readonly observedWinningBidBps?: bigint;
    };

export interface AdaptiveBidAdjustment {
  readonly action: "increased" | "decreased" | "held";
  readonly previousBidBps: bigint;
  readonly currentBidBps: bigint;
  readonly state: AdaptiveBidState;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function initialAdaptiveBidState(
  policy: AdaptiveBidPolicy,
): AdaptiveBidState {
  return {
    currentBidBps: policy.baselineBidBps,
    consecutiveFullWins: 0,
  };
}

export function adjustAdaptiveBid(
  state: AdaptiveBidState,
  policy: AdaptiveBidPolicy,
  outcome: AdaptiveBidOutcome,
): AdaptiveBidAdjustment {
  const previousBidBps = state.currentBidBps;
  if (outcome.kind === "miss") {
    const observedTarget =
      outcome.observedWinningBidBps === undefined
        ? previousBidBps
        : outcome.observedWinningBidBps + policy.lossStepBps;
    const currentBidBps = minimum(
      policy.maximumBidBps,
      maximum(previousBidBps, observedTarget),
    );
    const nextState: AdaptiveBidState = {
      currentBidBps,
      consecutiveFullWins: 0,
      lastUpdatedBlock: outcome.blockNumber,
      ...(outcome.observedWinningBidBps === undefined
        ? state.lastObservedWinningBidBps === undefined
          ? {}
          : {
              lastObservedWinningBidBps:
                state.lastObservedWinningBidBps,
            }
        : {
            lastObservedWinningBidBps:
              outcome.observedWinningBidBps,
          }),
    };
    return {
      action:
        currentBidBps > previousBidBps ? "increased" : "held",
      previousBidBps,
      currentBidBps,
      state: nextState,
    };
  }

  const consecutiveFullWins = state.consecutiveFullWins + 1;
  const shouldDecay =
    consecutiveFullWins >= policy.winsBeforeDecay &&
    previousBidBps > policy.baselineBidBps;
  const currentBidBps = shouldDecay
    ? maximum(
        policy.baselineBidBps,
        previousBidBps - policy.winDecayBps,
      )
    : previousBidBps;
  const nextState: AdaptiveBidState = {
    currentBidBps,
    consecutiveFullWins: shouldDecay ? 0 : consecutiveFullWins,
    lastUpdatedBlock: outcome.blockNumber,
    ...(state.lastObservedWinningBidBps === undefined
      ? {}
      : {
          lastObservedWinningBidBps:
            state.lastObservedWinningBidBps,
        }),
  };
  return {
    action:
      currentBidBps < previousBidBps ? "decreased" : "held",
    previousBidBps,
    currentBidBps,
    state: nextState,
  };
}

interface SerializedOrderBidState {
  readonly currentBidBps: string;
  readonly consecutiveFullWins: number;
  readonly lastObservedWinningBidBps?: string;
  readonly lastUpdatedBlock?: string;
}

interface SerializedAdaptiveBidState {
  readonly version: 2;
  readonly orders: Readonly<Record<string, SerializedOrderBidState>>;
}

function deserializeOrderState(
  value: unknown,
  policy: AdaptiveBidPolicy,
): AdaptiveBidState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("currentBidBps" in value) ||
    typeof value.currentBidBps !== "string" ||
    !("consecutiveFullWins" in value) ||
    typeof value.consecutiveFullWins !== "number"
  ) {
    throw new Error("adaptive bid state has an unsupported shape");
  }
  const serialized = value as unknown as SerializedOrderBidState;
  const persistedBid = BigInt(serialized.currentBidBps);
  return {
    currentBidBps: minimum(
      policy.maximumBidBps,
      maximum(policy.baselineBidBps, persistedBid),
    ),
    consecutiveFullWins:
      Number.isSafeInteger(serialized.consecutiveFullWins) &&
      serialized.consecutiveFullWins >= 0
        ? serialized.consecutiveFullWins
        : 0,
    ...(serialized.lastObservedWinningBidBps === undefined
      ? {}
      : {
          lastObservedWinningBidBps: BigInt(
            serialized.lastObservedWinningBidBps,
          ),
        }),
    ...(serialized.lastUpdatedBlock === undefined
      ? {}
      : {
          lastUpdatedBlock: BigInt(serialized.lastUpdatedBlock),
        }),
  };
}

export class AdaptiveBidController {
  readonly #policy: AdaptiveBidPolicy;
  readonly #statePath: string;
  readonly #states: Map<string, AdaptiveBidState>;

  private constructor(
    policy: AdaptiveBidPolicy,
    statePath: string,
    states: Map<string, AdaptiveBidState>,
  ) {
    this.#policy = policy;
    this.#statePath = resolve(statePath);
    this.#states = states;
  }

  static async load(
    policy: AdaptiveBidPolicy,
    statePath: string,
  ): Promise<AdaptiveBidController> {
    const resolvedPath = resolve(statePath);
    const states = new Map<string, AdaptiveBidState>();
    try {
      const source = await readFile(resolvedPath, "utf8");
      const parsed = JSON.parse(source) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("version" in parsed) ||
        parsed.version !== 2 ||
        !("orders" in parsed) ||
        typeof parsed.orders !== "object" ||
        parsed.orders === null
      ) {
        throw new Error("adaptive bid state has an unsupported shape");
      }
      for (const [order, value] of Object.entries(parsed.orders)) {
        states.set(
          order.toLowerCase(),
          deserializeOrderState(value, policy),
        );
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    return new AdaptiveBidController(policy, resolvedPath, states);
  }

  currentBidBps(order: string): bigint {
    return (
      this.#states.get(order.toLowerCase()) ??
      initialAdaptiveBidState(this.#policy)
    ).currentBidBps;
  }

  get maximumActiveBidBps(): bigint {
    let maximumBidBps = this.#policy.baselineBidBps;
    for (const state of this.#states.values()) {
      maximumBidBps = maximum(maximumBidBps, state.currentBidBps);
    }
    return maximumBidBps;
  }

  async observeBatch(
    outcomes: readonly {
      readonly order: string;
      readonly outcome: AdaptiveBidOutcome;
    }[],
  ): Promise<
    readonly (AdaptiveBidAdjustment & { readonly order: string })[]
  > {
    const adjustments = outcomes.map(({ order, outcome }) => {
      const key = order.toLowerCase();
      const state =
        this.#states.get(key) ??
        initialAdaptiveBidState(this.#policy);
      const adjustment = adjustAdaptiveBid(
        state,
        this.#policy,
        outcome,
      );
      this.#states.set(key, adjustment.state);
      return { ...adjustment, order };
    });
    await this.#persist();
    return adjustments;
  }

  async observe(
    order: string,
    outcome: AdaptiveBidOutcome,
  ): Promise<AdaptiveBidAdjustment> {
    const [adjustment] = await this.observeBatch([
      { order, outcome },
    ]);
    if (adjustment === undefined) {
      throw new Error("adaptive bid adjustment was not produced");
    }
    return adjustment;
  }

  async #persist(): Promise<void> {
    const orders: Record<string, SerializedOrderBidState> = {};
    for (const [order, state] of this.#states) {
      orders[order] = {
        currentBidBps: state.currentBidBps.toString(),
        consecutiveFullWins: state.consecutiveFullWins,
        ...(state.lastObservedWinningBidBps === undefined
          ? {}
          : {
              lastObservedWinningBidBps:
                state.lastObservedWinningBidBps.toString(),
            }),
        ...(state.lastUpdatedBlock === undefined
          ? {}
          : {
              lastUpdatedBlock: state.lastUpdatedBlock.toString(),
            }),
      };
    }
    const serialized: SerializedAdaptiveBidState = {
      version: 2,
      orders,
    };
    await mkdir(dirname(this.#statePath), { recursive: true });
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(serialized)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, this.#statePath);
  }
}
