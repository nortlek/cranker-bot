import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface AdaptiveBidPolicy {
  readonly minimumBidBps: bigint;
  readonly baselineBidBps: bigint;
  readonly maximumBidBps: bigint;
  readonly lossStepBps: bigint;
  readonly winDecayBps: bigint;
  readonly winsBeforeDecay: number;
  readonly evidenceMaxAgeBlocks: bigint;
}

export interface AdaptiveBidState {
  readonly currentBidBps: bigint;
  readonly consecutiveFullWins: number;
  readonly lastObservedWinningBidBps?: bigint;
  readonly lastObservedWinningBlock?: bigint;
  readonly lowestWinningBidBps?: bigint;
  readonly highestLosingBidBps?: bigint;
  readonly highestLosingBidBlock?: bigint;
  readonly activeProbeBidBps?: bigint;
  readonly lastUpdatedBlock?: bigint;
}

export interface AdaptiveBidPersistence {
  load(
    policy: AdaptiveBidPolicy,
  ): Promise<Map<string, AdaptiveBidState>>;
  save(
    states: ReadonlyMap<string, AdaptiveBidState>,
  ): Promise<void>;
  close(): Promise<void>;
}

export type AdaptiveBidOutcome =
  | {
      readonly kind: "full_win";
      readonly blockNumber: bigint;
      readonly effectiveBidBps?: bigint;
    }
  | {
      readonly kind: "miss";
      readonly blockNumber: bigint;
      readonly effectiveBidBps?: bigint;
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

function validatePolicy(policy: AdaptiveBidPolicy): void {
  if (
    policy.minimumBidBps < 0n ||
    policy.minimumBidBps > policy.baselineBidBps ||
    policy.baselineBidBps > policy.maximumBidBps ||
    policy.maximumBidBps > 10_000n
  ) {
    throw new Error(
      "adaptive bid policy must satisfy 0 <= minimum <= baseline <= maximum <= 10000",
    );
  }
  if (
    policy.lossStepBps <= 0n ||
    policy.winDecayBps <= 0n ||
    policy.winsBeforeDecay < 1 ||
    policy.evidenceMaxAgeBlocks < 1n
  ) {
    throw new Error(
      "adaptive bid steps, win streak, and evidence age must be positive",
    );
  }
}

function clampToPolicy(
  value: bigint,
  policy: AdaptiveBidPolicy,
): bigint {
  return minimum(
    policy.maximumBidBps,
    maximum(policy.minimumBidBps, value),
  );
}

function optionalMinimum(
  left: bigint | undefined,
  right: bigint,
): bigint {
  return left === undefined ? right : minimum(left, right);
}

function optionalMaximum(
  left: bigint | undefined,
  right: bigint,
): bigint {
  return left === undefined ? right : maximum(left, right);
}

function bidAction(
  previousBidBps: bigint,
  currentBidBps: bigint,
): AdaptiveBidAdjustment["action"] {
  if (currentBidBps < previousBidBps) return "decreased";
  if (currentBidBps > previousBidBps) return "increased";
  return "held";
}

function searchLowerBound(
  state: AdaptiveBidState,
  policy: AdaptiveBidPolicy,
  blockNumber: bigint,
): bigint {
  let lowerBound = policy.minimumBidBps;
  if (
    state.highestLosingBidBps !== undefined &&
    evidenceIsFresh(
      state.highestLosingBidBlock,
      blockNumber,
      policy,
    )
  ) {
    lowerBound = maximum(
      lowerBound,
      state.highestLosingBidBps + policy.lossStepBps,
    );
  }
  if (
    state.lastObservedWinningBidBps !== undefined &&
    evidenceIsFresh(
      state.lastObservedWinningBlock,
      blockNumber,
      policy,
    )
  ) {
    lowerBound = maximum(
      lowerBound,
      state.lastObservedWinningBidBps + policy.lossStepBps,
    );
  }
  return clampToPolicy(lowerBound, policy);
}

function evidenceIsFresh(
  evidenceBlock: bigint | undefined,
  currentBlock: bigint,
  policy: AdaptiveBidPolicy,
): boolean {
  if (evidenceBlock === undefined || currentBlock <= evidenceBlock) {
    return true;
  }
  return (
    currentBlock - evidenceBlock <=
    policy.evidenceMaxAgeBlocks
  );
}

export function initialAdaptiveBidState(
  policy: AdaptiveBidPolicy,
): AdaptiveBidState {
  validatePolicy(policy);
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
  validatePolicy(policy);
  const previousBidBps = state.currentBidBps;
  if (outcome.kind === "miss") {
    const effectiveBidBps = clampToPolicy(
      outcome.effectiveBidBps ?? previousBidBps,
      policy,
    );
    const observedTarget =
      outcome.observedWinningBidBps === undefined
        ? undefined
        : clampToPolicy(
            outcome.observedWinningBidBps +
              policy.lossStepBps,
            policy,
          );
    const wasProbe =
      state.activeProbeBidBps !== undefined &&
      state.activeProbeBidBps === previousBidBps;
    const priceMiss =
      outcome.observedWinningBidBps === undefined
        ? wasProbe
        : outcome.observedWinningBidBps >= effectiveBidBps;
    const freshHighestLosingBidBps =
      state.highestLosingBidBps !== undefined &&
      evidenceIsFresh(
        state.highestLosingBidBlock,
        outcome.blockNumber,
        policy,
      )
        ? state.highestLosingBidBps
        : undefined;
    const highestLosingBidBps = priceMiss
      ? optionalMaximum(
          freshHighestLosingBidBps,
          effectiveBidBps,
        )
      : state.highestLosingBidBps;
    const highestLosingBidBlock = priceMiss
      ? freshHighestLosingBidBps !== undefined &&
        freshHighestLosingBidBps >= effectiveBidBps
        ? state.highestLosingBidBlock
        : outcome.blockNumber
      : state.highestLosingBidBlock;
    const candidateState: AdaptiveBidState = {
      ...state,
      ...(highestLosingBidBps === undefined
        ? {}
        : { highestLosingBidBps }),
      ...(highestLosingBidBlock === undefined
        ? {}
        : { highestLosingBidBlock }),
      ...(outcome.observedWinningBidBps === undefined
        ? {}
        : {
            lastObservedWinningBidBps:
              outcome.observedWinningBidBps,
            lastObservedWinningBlock: outcome.blockNumber,
          }),
    };
    const lowerBound = searchLowerBound(
      candidateState,
      policy,
      outcome.blockNumber,
    );
    const lowestWinningBidBps =
      state.lowestWinningBidBps !== undefined &&
      state.lowestWinningBidBps > lowerBound
        ? state.lowestWinningBidBps
        : undefined;
    const recoveryBid =
      lowestWinningBidBps ?? policy.baselineBidBps;
    const currentBidBps = clampToPolicy(
      wasProbe
        ? maximum(recoveryBid, lowerBound)
        : observedTarget !== undefined
        ? maximum(previousBidBps, observedTarget)
        : previousBidBps,
      policy,
    );
    const nextState: AdaptiveBidState = {
      currentBidBps,
      consecutiveFullWins: 0,
      lastUpdatedBlock: outcome.blockNumber,
      ...(lowestWinningBidBps === undefined
        ? {}
        : { lowestWinningBidBps }),
      ...(highestLosingBidBps === undefined
        ? {}
        : { highestLosingBidBps }),
      ...(highestLosingBidBlock === undefined
        ? {}
        : { highestLosingBidBlock }),
      ...(outcome.observedWinningBidBps === undefined
        ? state.lastObservedWinningBidBps === undefined
          ? {}
          : {
              lastObservedWinningBidBps:
                state.lastObservedWinningBidBps,
              ...(state.lastObservedWinningBlock === undefined
                ? {}
                : {
                    lastObservedWinningBlock:
                      state.lastObservedWinningBlock,
                  }),
            }
        : {
            lastObservedWinningBidBps:
              outcome.observedWinningBidBps,
            lastObservedWinningBlock: outcome.blockNumber,
          }),
    };
    return {
      action: bidAction(previousBidBps, currentBidBps),
      previousBidBps,
      currentBidBps,
      state: nextState,
    };
  }

  const effectiveBidBps = clampToPolicy(
    outcome.effectiveBidBps ?? previousBidBps,
    policy,
  );
  const lowestWinningBidBps = optionalMinimum(
    state.lowestWinningBidBps,
    effectiveBidBps,
  );
  const highestLosingBidBps =
    state.highestLosingBidBps !== undefined &&
    effectiveBidBps <= state.highestLosingBidBps
      ? undefined
      : state.highestLosingBidBps;
  const highestLosingBidBlock =
    highestLosingBidBps === undefined
      ? undefined
      : state.highestLosingBidBlock;
  const lastObservedWinningBidBps =
    state.lastObservedWinningBidBps;
  const lastObservedWinningBlock =
    state.lastObservedWinningBlock;
  const boundedState: AdaptiveBidState = {
    currentBidBps: state.currentBidBps,
    consecutiveFullWins: state.consecutiveFullWins,
    lowestWinningBidBps,
    ...(highestLosingBidBps === undefined
      ? {}
      : { highestLosingBidBps }),
    ...(highestLosingBidBlock === undefined
      ? {}
      : { highestLosingBidBlock }),
    ...(lastObservedWinningBidBps === undefined
      ? {}
      : { lastObservedWinningBidBps }),
    ...(lastObservedWinningBlock === undefined
      ? {}
      : { lastObservedWinningBlock }),
    ...(state.lastUpdatedBlock === undefined
      ? {}
      : { lastUpdatedBlock: state.lastUpdatedBlock }),
  };
  const consecutiveFullWins = Math.min(
    state.consecutiveFullWins + 1,
    policy.winsBeforeDecay,
  );
  const lowerTarget = searchLowerBound(
    boundedState,
    policy,
    outcome.blockNumber,
  );
  const shouldDecay =
    consecutiveFullWins >= policy.winsBeforeDecay &&
    lowestWinningBidBps > lowerTarget;
  const distanceToTarget =
    lowestWinningBidBps > lowerTarget
      ? lowestWinningBidBps - lowerTarget
      : 0n;
  const decayStep = maximum(
    policy.winDecayBps,
    (distanceToTarget + 1n) / 2n,
  );
  const currentBidBps = shouldDecay
    ? maximum(
        lowerTarget,
        lowestWinningBidBps - decayStep,
      )
    : previousBidBps;
  const nextState: AdaptiveBidState = {
    currentBidBps,
    consecutiveFullWins: shouldDecay ? 0 : consecutiveFullWins,
    lastUpdatedBlock: outcome.blockNumber,
    lowestWinningBidBps,
    ...(lastObservedWinningBidBps === undefined
      ? {}
      : {
          lastObservedWinningBidBps:
            lastObservedWinningBidBps,
        }),
    ...(lastObservedWinningBlock === undefined
      ? {}
      : { lastObservedWinningBlock }),
    ...(highestLosingBidBps === undefined
      ? {}
      : { highestLosingBidBps }),
    ...(highestLosingBidBlock === undefined
      ? {}
      : { highestLosingBidBlock }),
    ...(shouldDecay ? { activeProbeBidBps: currentBidBps } : {}),
  };
  return {
    action: bidAction(previousBidBps, currentBidBps),
    previousBidBps,
    currentBidBps,
    state: nextState,
  };
}

interface SerializedOrderBidState {
  readonly currentBidBps: string;
  readonly consecutiveFullWins: number;
  readonly lastObservedWinningBidBps?: string;
  readonly lastObservedWinningBlock?: string;
  readonly lowestWinningBidBps?: string;
  readonly highestLosingBidBps?: string;
  readonly highestLosingBidBlock?: string;
  readonly activeProbeBidBps?: string;
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
  validatePolicy(policy);
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
    currentBidBps: clampToPolicy(persistedBid, policy),
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
          lastObservedWinningBlock: BigInt(
            serialized.lastObservedWinningBlock ??
              serialized.lastUpdatedBlock ??
              "0",
          ),
        }),
    ...(serialized.lowestWinningBidBps === undefined
      ? {}
      : {
          lowestWinningBidBps: clampToPolicy(
            BigInt(serialized.lowestWinningBidBps),
            policy,
          ),
        }),
    ...(serialized.highestLosingBidBps === undefined
      ? {}
      : {
          highestLosingBidBps: clampToPolicy(
            BigInt(serialized.highestLosingBidBps),
            policy,
          ),
          ...(serialized.highestLosingBidBlock === undefined
            ? {}
            : {
                highestLosingBidBlock: BigInt(
                  serialized.highestLosingBidBlock,
                ),
              }),
        }),
    ...(serialized.activeProbeBidBps === undefined
      ? {}
      : {
          activeProbeBidBps: clampToPolicy(
            BigInt(serialized.activeProbeBidBps),
            policy,
          ),
        }),
    ...(serialized.lastUpdatedBlock === undefined
      ? {}
      : {
          lastUpdatedBlock: BigInt(serialized.lastUpdatedBlock),
        }),
  };
}

class FileAdaptiveBidPersistence
  implements AdaptiveBidPersistence
{
  readonly #statePath: string;

  constructor(statePath: string) {
    this.#statePath = resolve(statePath);
  }

  async load(
    policy: AdaptiveBidPolicy,
  ): Promise<Map<string, AdaptiveBidState>> {
    const states = new Map<string, AdaptiveBidState>();
    try {
      const source = await readFile(this.#statePath, "utf8");
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
    return states;
  }

  async save(
    states: ReadonlyMap<string, AdaptiveBidState>,
  ): Promise<void> {
    const orders: Record<string, SerializedOrderBidState> = {};
    for (const [order, state] of states) {
      orders[order] = {
        currentBidBps: state.currentBidBps.toString(),
        consecutiveFullWins: state.consecutiveFullWins,
        ...(state.lastObservedWinningBidBps === undefined
          ? {}
          : {
              lastObservedWinningBidBps:
                state.lastObservedWinningBidBps.toString(),
              ...(state.lastObservedWinningBlock === undefined
                ? {}
                : {
                    lastObservedWinningBlock:
                      state.lastObservedWinningBlock.toString(),
                  }),
            }),
        ...(state.lowestWinningBidBps === undefined
          ? {}
          : {
              lowestWinningBidBps:
                state.lowestWinningBidBps.toString(),
            }),
        ...(state.highestLosingBidBps === undefined
          ? {}
          : {
              highestLosingBidBps:
                state.highestLosingBidBps.toString(),
              ...(state.highestLosingBidBlock === undefined
                ? {}
                : {
                    highestLosingBidBlock:
                      state.highestLosingBidBlock.toString(),
                  }),
            }),
        ...(state.activeProbeBidBps === undefined
          ? {}
          : {
              activeProbeBidBps:
                state.activeProbeBidBps.toString(),
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

  async close(): Promise<void> {
    // File persistence does not hold open resources.
  }
}

export class AdaptiveBidController {
  readonly #policy: AdaptiveBidPolicy;
  readonly #persistence: AdaptiveBidPersistence;
  readonly #states: Map<string, AdaptiveBidState>;

  private constructor(
    policy: AdaptiveBidPolicy,
    persistence: AdaptiveBidPersistence,
    states: Map<string, AdaptiveBidState>,
  ) {
    this.#policy = policy;
    this.#persistence = persistence;
    this.#states = states;
  }

  static async load(
    policy: AdaptiveBidPolicy,
    statePath: string,
  ): Promise<AdaptiveBidController> {
    return AdaptiveBidController.loadWithPersistence(
      policy,
      new FileAdaptiveBidPersistence(statePath),
    );
  }

  static async loadWithPersistence(
    policy: AdaptiveBidPolicy,
    persistence: AdaptiveBidPersistence,
  ): Promise<AdaptiveBidController> {
    const states = await persistence.load(policy);
    return new AdaptiveBidController(
      policy,
      persistence,
      states,
    );
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
    await this.#persistence.save(this.#states);
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

  async close(): Promise<void> {
    await this.#persistence.close();
  }
}
