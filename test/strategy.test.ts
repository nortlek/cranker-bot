import {
  BlockNotFoundError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  getAddress,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  parseAbi,
  RpcRequestError,
  TransactionReceiptNotFoundError,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { CONVEX_KICK_CANDIDATES } from "../src/constants.js";
import {
  appendGroupPullCollectAfterSettlement,
  exactSimulationPlanIsAdmissible,
  fwaProcessJob,
  highestPositiveClaimableIndexes,
  isPureSingleRoundFulfilledLifecycleBatch,
  isConvexCrvChangeRevert,
  isConvexNoExpiredLocksRevert,
  isFreshBlockReadUnavailable,
  isFreshBlockStateUnavailable,
  isTransactionReceiptTemporarilyUnavailable,
  estimatedJobReward,
  maximumFundableGasEnvelope,
  mergeConcurrentPoolPlans,
  orderStandaloneStandingJobsForAuction,
  orderAlreadyBought,
  orderHasMinimumBalance,
  planningHeadIsStale,
  privateNextBlockFeeQuote,
  readOrderFactoryOrders,
  readPublishedTransactionReceipt,
  resolvePlanningFeeQuote,
  resolvePlanningHead,
} from "../src/strategy.js";

const POOL =
  "0x1111111111111111111111111111111111111111" as const;

describe("readOrderFactoryOrders", () => {
  it("merges every configured registry and deduplicates addresses", async () => {
    const factoryA = getAddress(
      "0x1000000000000000000000000000000000000001",
    );
    const factoryB = getAddress(
      "0x2000000000000000000000000000000000000002",
    );
    const orderA = getAddress(
      "0xa000000000000000000000000000000000000001",
    );
    const shared = getAddress(
      "0xa000000000000000000000000000000000000002",
    );
    const orderB = getAddress(
      "0xa000000000000000000000000000000000000003",
    );
    const readContract = vi.fn(async ({ address }) =>
      address === factoryA
        ? [orderA, shared]
        : [shared, orderB],
    );

    await expect(
      readOrderFactoryOrders(
        { readContract } as never,
        [factoryA, factoryB],
        25_655_294n,
      ),
    ).resolves.toEqual([orderA, shared, orderB]);
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: factoryB,
        blockNumber: 25_655_294n,
        functionName: "allOrders",
      }),
    );
  });
});

describe("isPureSingleRoundFulfilledLifecycleBatch", () => {
  const sync = {
    kind: "pool_sync" as const,
    target: POOL,
    poolVersion: "v2" as const,
    poolBuilderBidPolicy: "pool_fulfilled" as const,
    roundId: 55n,
  };
  const settle = {
    ...sync,
    kind: "pool_settle" as const,
  };

  it("accepts only a same-round V2 fulfilled lifecycle with sync", () => {
    expect(
      isPureSingleRoundFulfilledLifecycleBatch([sync, settle]),
    ).toBe(true);
  });

  it("rejects ready, settle-only, mixed, and multi-round batches", () => {
    expect(
      isPureSingleRoundFulfilledLifecycleBatch([
        { ...sync, poolBuilderBidPolicy: "pool_ready" },
        { ...settle, poolBuilderBidPolicy: "pool_ready" },
      ]),
    ).toBe(false);
    expect(
      isPureSingleRoundFulfilledLifecycleBatch([settle]),
    ).toBe(false);
    expect(
      isPureSingleRoundFulfilledLifecycleBatch([
        sync,
        {
          kind: "standing_order",
          target: POOL,
          poolVersion: "v2",
        },
      ]),
    ).toBe(false);
    expect(
      isPureSingleRoundFulfilledLifecycleBatch([
        sync,
        { ...settle, roundId: 56n },
      ]),
    ).toBe(false);
  });
});

describe("configured Convex kick candidates", () => {
  it("normalizes every address without Array.map callback arguments", () => {
    expect(CONVEX_KICK_CANDIDATES).toHaveLength(85);
    expect(new Set(CONVEX_KICK_CANDIDATES).size).toBe(85);
    for (const candidate of CONVEX_KICK_CANDIDATES) {
      expect(getAddress(candidate)).toBe(candidate);
    }
  });
});

describe("isFreshBlockStateUnavailable", () => {
  it("recognizes viem's ordinary exact-block publication lag", () => {
    expect(
      isFreshBlockReadUnavailable(
        new BlockNotFoundError({ blockNumber: 25_640_617n }),
      ),
    ).toBe(true);
  });

  it("recognizes the provider race observed after a fresh header", () => {
    for (const message of [
      "Missing or invalid parameters.",
      "Invalid parameters were provided to the RPC method.",
    ]) {
      const requestError = new RpcRequestError({
        body: {
          method: "eth_call",
          params: [],
        },
        error: {
          code: InvalidParamsRpcError.code,
          message,
        },
        url: "https://example.invalid",
      });

      expect(
        isFreshBlockStateUnavailable(
          new InvalidParamsRpcError(requestError),
        ),
      ).toBe(true);
      expect(
        isFreshBlockReadUnavailable(
          new InvalidParamsRpcError(requestError),
        ),
      ).toBe(true);
    }
  });

  it("recognizes viem's typed -32000 fresh-state error", () => {
    const requestError = new RpcRequestError({
      body: {
        method: "eth_call",
        params: [],
      },
      error: {
        code: InvalidInputRpcError.code,
        message: "state backend has not indexed the block",
      },
      url: "https://example.invalid",
    });

    expect(
      isFreshBlockStateUnavailable(
        new InvalidInputRpcError(requestError),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated invalid parameters as state lag", () => {
    const requestError = new RpcRequestError({
      body: {
        method: "eth_call",
        params: [],
      },
      error: {
        code: InvalidParamsRpcError.code,
        message: "invalid argument 0",
      },
      url: "https://example.invalid",
    });

    expect(
      isFreshBlockStateUnavailable(
        new InvalidParamsRpcError(requestError),
      ),
    ).toBe(false);
    expect(
      isFreshBlockStateUnavailable(
        new Error("Missing or invalid parameters."),
      ),
    ).toBe(false);

    const untypedInputError = new RpcRequestError({
      body: {
        method: "eth_call",
        params: [],
      },
      error: {
        code: InvalidInputRpcError.code,
        message: "execution aborted",
      },
      url: "https://example.invalid",
    });
    expect(
      isFreshBlockStateUnavailable(untypedInputError),
    ).toBe(false);
  });
});

describe("resolvePlanningHead", () => {
  const subscribedHead = {
    number: 25_640_617n,
    hash:
      "0x1111111111111111111111111111111111111111111111111111111111111111" as const,
    timestamp: 1_754_000_000n,
    baseFeePerGas: 100_000_000n,
    gasUsed: 30_000_000n,
    gasLimit: 60_000_000n,
  };

  it("uses the subscribed header without waiting for an HTTP block copy", async () => {
    const readExactBlock = vi.fn<
      () => Promise<typeof subscribedHead>
    >();

    await expect(
      resolvePlanningHead({
        headBlockNumber: subscribedHead.number,
        observedHead: subscribedHead,
        readExactBlock,
      }),
    ).resolves.toEqual({
      value: subscribedHead,
      attempts: 0,
      waitedMs: 0,
      source: "websocket_subscription",
    });
    expect(readExactBlock).not.toHaveBeenCalled();
  });

  it("fails closed when the subscribed header does not match the planning block", async () => {
    const readExactBlock = vi.fn<
      () => Promise<typeof subscribedHead>
    >();

    await expect(
      resolvePlanningHead({
        headBlockNumber: subscribedHead.number + 1n,
        observedHead: subscribedHead,
        readExactBlock,
      }),
    ).rejects.toThrow(
      "does not match planning block",
    );
    expect(readExactBlock).not.toHaveBeenCalled();
  });
});

describe("privateNextBlockFeeQuote", () => {
  it("covers the maximum EIP-1559 child base-fee increase", () => {
    expect(
      privateNextBlockFeeQuote({
        parentBaseFeePerGas: 800n,
        parentGasUsed: 200n,
        parentGasLimit: 200n,
        minimumPriorityFeePerGas: 25n,
      }),
    ).toEqual({
      baseFeeAllowancePerGas: 900n,
      maxPriorityFeePerGas: 25n,
      maxFeePerGas: 925n,
    });
  });

  it("uses the protocol one-wei minimum increase", () => {
    expect(
      privateNextBlockFeeQuote({
        parentBaseFeePerGas: 7n,
        parentGasUsed: 101n,
        parentGasLimit: 200n,
        minimumPriorityFeePerGas: 0n,
      }),
    ).toEqual({
      baseFeeAllowancePerGas: 8n,
      maxPriorityFeePerGas: 0n,
      maxFeePerGas: 8n,
    });
  });

  it("fails closed without a usable EIP-1559 parent fee", () => {
    expect(() =>
      privateNextBlockFeeQuote({
        parentBaseFeePerGas: null,
        parentGasUsed: 100n,
        parentGasLimit: 200n,
        minimumPriorityFeePerGas: 0n,
      }),
    ).toThrow("requires a positive parent base fee");
    expect(() =>
      privateNextBlockFeeQuote({
        parentBaseFeePerGas: 1n,
        parentGasUsed: 100n,
        parentGasLimit: 200n,
        minimumPriorityFeePerGas: -1n,
      }),
    ).toThrow("cannot be negative");
  });
});

describe("resolvePlanningFeeQuote", () => {
  it("does not read provider fees for a private next-block bundle", async () => {
    const readProviderFeeQuote = vi.fn(async () => ({
      maxFeePerGas: 10_000n,
      maxPriorityFeePerGas: 5_000n,
    }));

    await expect(
      resolvePlanningFeeQuote({
        submissionMode: "flashbots",
        parentBaseFeePerGas: 800n,
        parentGasUsed: 200n,
        parentGasLimit: 200n,
        minimumPriorityFeePerGas: 25n,
        readProviderFeeQuote,
      }),
    ).resolves.toEqual({
      source: "subscribed_header_exact_next_base_fee",
      baseFeeAllowancePerGas: 900n,
      maxPriorityFeePerGas: 25n,
      maxFeePerGas: 925n,
    });
    expect(readProviderFeeQuote).not.toHaveBeenCalled();
  });

  it("fails closed without complete private parent gas fields", async () => {
    await expect(
      resolvePlanningFeeQuote({
        submissionMode: "flashbots",
        parentBaseFeePerGas: 800n,
        minimumPriorityFeePerGas: 25n,
        readProviderFeeQuote: async () => ({
          maxFeePerGas: 1_000n,
          maxPriorityFeePerGas: 25n,
        }),
      }),
    ).rejects.toThrow("requires complete parent gas fields");
  });

  it("retains provider fee estimation for public submission", async () => {
    const readProviderFeeQuote = vi.fn(async () => ({
      maxFeePerGas: 1_000n,
      maxPriorityFeePerGas: 10n,
    }));

    await expect(
      resolvePlanningFeeQuote({
        submissionMode: "public",
        parentBaseFeePerGas: null,
        minimumPriorityFeePerGas: 25n,
        readProviderFeeQuote,
      }),
    ).resolves.toEqual({
      source: "provider_estimate",
      baseFeeAllowancePerGas: 990n,
      maxPriorityFeePerGas: 25n,
      maxFeePerGas: 1_015n,
    });
    expect(readProviderFeeQuote).toHaveBeenCalledOnce();
  });
});

describe("exact-simulation lifecycle admission", () => {
  const fixedJob = {
    kind: "standing_order" as const,
    label: "fixed",
    target: POOL,
    data: "0x" as const,
    gas: 100n,
    reward: {
      kind: "fixed" as const,
      amountWei: 1n,
    },
  };

  it("marks FWA processing for mandatory exact bundle simulation", () => {
    expect(
      fwaProcessJob({
        fwa: POOL,
        gas: 16_777_216n,
        count: 5n,
      }),
    ).toMatchObject({
      kind: "fwa_process",
      gas: 16_777_216n,
      requiresBundleSimulation: true,
    });
  });

  it("admits a dependency-safe deferred plan without static gas economics", () => {
    expect(
      exactSimulationPlanIsAdmissible({
        jobs: [
          {
            ...fixedJob,
            requiresBundleSimulation: true,
          },
          fixedJob,
        ],
        minimumViablePrefix: 2,
      }),
    ).toBe(true);
  });

  it("does not bypass economics for ordinary or invalid prefixes", () => {
    expect(
      exactSimulationPlanIsAdmissible({
        jobs: [fixedJob],
        minimumViablePrefix: 1,
      }),
    ).toBe(false);
    expect(
      exactSimulationPlanIsAdmissible({
        jobs: [
          {
            ...fixedJob,
            requiresBundleSimulation: true,
          },
        ],
        minimumViablePrefix: 2,
      }),
    ).toBe(false);
  });
});

describe("pool pull exact-simulation economics", () => {
  const poolJob = (kind: "pool_pull" | "pool_sync") => ({
    kind,
    label: kind,
    target: POOL,
    data: "0x" as const,
    gas: 100n,
    reward: {
      kind: "pool_bounty" as const,
      terms: {
        crankBountyCap: 100_000n,
        bountyTipWei: 0n,
      },
    },
  });

  it("uses the pull-specific reimbursement estimate", () => {
    const common = {
      gasUsed: 100n,
      baseFeePerGas: 10n,
      poolBountyEstimateBps: 9_000n,
      poolPullBountyEstimateBps: 10_000n,
    };

    expect(
      estimatedJobReward({
        ...common,
        job: poolJob("pool_pull"),
      }),
    ).toBe(1_000n);
    expect(
      estimatedJobReward({
        ...common,
        job: poolJob("pool_sync"),
      }),
    ).toBe(900n);
  });

  it("caps an unknown-state envelope only by protocol request and funds", () => {
    expect(
      maximumFundableGasEnvelope({
        requestedGas: 100_000n,
        accountBalance: 1_000_000n,
        reservedGasCost: 100_000n,
        maxFeePerGas: 10n,
      }),
    ).toBe(90_000n);
    expect(
      maximumFundableGasEnvelope({
        requestedGas: 50_000n,
        accountBalance: 1_000_000n,
        reservedGasCost: 100_000n,
        maxFeePerGas: 10n,
      }),
    ).toBe(50_000n);
  });

  it("rejects an envelope below intrinsic transaction gas", () => {
    expect(
      maximumFundableGasEnvelope({
        requestedGas: 100_000n,
        accountBalance: 200_000n,
        reservedGasCost: 0n,
        maxFeePerGas: 10n,
      }),
    ).toBeUndefined();
  });
});

describe("highestPositiveClaimableIndexes", () => {
  it("keeps the largest positive values with stable tie ordering", () => {
    expect(
      highestPositiveClaimableIndexes(
        [0n, 5n, undefined, 9n, 5n, 12n],
        3,
      ),
    ).toEqual([5, 3, 1]);
  });

  it("rejects invalid cache sizes", () => {
    expect(() => highestPositiveClaimableIndexes([1n], 0)).toThrow(
      "must be positive",
    );
  });
});

describe("isConvexCrvChangeRevert", () => {
  const abi = parseAbi([
    "function earmarkRewards(uint256) returns(bool)",
    "error Error(string)",
  ]);

  function revertWith(reason: string): ContractFunctionRevertedError {
    return new ContractFunctionRevertedError({
      abi,
      data: encodeErrorResult({
        abi,
        errorName: "Error",
        args: [reason],
      }),
      functionName: "earmarkRewards",
    });
  }

  it("classifies only the exact structural stash invariant", () => {
    expect(isConvexCrvChangeRevert(revertWith("crvChange"))).toBe(
      true,
    );
    expect(isConvexCrvChangeRevert(revertWith("pool is closed"))).toBe(
      false,
    );
    expect(isConvexCrvChangeRevert(new Error("crvChange"))).toBe(
      false,
    );
  });

  it("classifies only the exact expired-lock eligibility revert", () => {
    expect(
      isConvexNoExpiredLocksRevert(revertWith("no exp locks")),
    ).toBe(true);
    expect(
      isConvexNoExpiredLocksRevert(revertWith("crvChange")),
    ).toBe(false);
    expect(
      isConvexNoExpiredLocksRevert(new Error("no exp locks")),
    ).toBe(false);
  });
});

describe("isTransactionReceiptTemporarilyUnavailable", () => {
  it("recognizes a receipt-index publication race", () => {
    expect(
      isTransactionReceiptTemporarilyUnavailable(
        new TransactionReceiptNotFoundError({
          hash:
            "0x1111111111111111111111111111111111111111111111111111111111111111",
        }),
      ),
    ).toBe(true);
  });

  it("does not retry an unrelated receipt error", () => {
    expect(
      isTransactionReceiptTemporarilyUnavailable(
        new Error("malformed request"),
      ),
    ).toBe(false);
  });

  it("waits within the bounded window for the receipt index", async () => {
    vi.useFakeTimers();
    const missing = new TransactionReceiptNotFoundError({
      hash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
    });
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing)
      .mockResolvedValue("published");
    const result = readPublishedTransactionReceipt(read);

    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual({
      value: "published",
      attempts: 3,
      waitedMs: 200,
    });
    expect(read).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("orderHasMinimumBalance", () => {
  it("rejects an order that cannot pay even its caller fee", () => {
    expect(orderHasMinimumBalance(299n, 300n)).toBe(false);
    expect(orderHasMinimumBalance(300n, 300n)).toBe(true);
  });

  it("includes the minimum ticket cost for an open funding round", () => {
    expect(orderHasMinimumBalance(5_299n, 300n, 5_000n)).toBe(false);
    expect(orderHasMinimumBalance(5_300n, 300n, 5_000n)).toBe(true);
  });

  it("allows zero-fee orders to continue to exact simulation", () => {
    expect(orderHasMinimumBalance(0n, 0n)).toBe(true);
  });

  it("rejects invalid negative accounting inputs", () => {
    expect(() => orderHasMinimumBalance(-1n, 0n)).toThrow(
      "cannot be negative",
    );
  });
});

describe("orderAlreadyBought", () => {
  it("filters an order bought in the current open round", () => {
    expect(orderAlreadyBought(256n, 257n)).toBe(false);
    expect(orderAlreadyBought(257n, 257n)).toBe(true);
  });

  it("scopes successor order rounds to the pool that issued them", () => {
    const v1 = getAddress(
      "0x1000000000000000000000000000000000000001",
    );
    const v2 = getAddress(
      "0x2000000000000000000000000000000000000002",
    );
    expect(
      orderAlreadyBought(366n, 57n, {
        lastPool: v1,
        activePool: v2,
      }),
    ).toBe(false);
    expect(
      orderAlreadyBought(57n, 57n, {
        lastPool: v2,
        activePool: v2,
      }),
    ).toBe(true);
    expect(
      orderAlreadyBought(58n, 57n, {
        lastPool: v2,
        activePool: v2,
      }),
    ).toBe(false);
  });

  it("rejects invalid negative round identifiers", () => {
    expect(() => orderAlreadyBought(-1n, 1n)).toThrow(
      "cannot be negative",
    );
  });
});

describe("planningHeadIsStale", () => {
  it("accepts a lagging HTTP head after exact-block planning", () => {
    expect(planningHeadIsStale(100n, 99n)).toBe(false);
  });

  it("accepts the planned head and rejects a newer head", () => {
    expect(planningHeadIsStale(100n, 100n)).toBe(false);
    expect(planningHeadIsStale(100n, 101n)).toBe(true);
  });

  it("rejects invalid negative block numbers", () => {
    expect(() => planningHeadIsStale(-1n, 0n)).toThrow(
      "block numbers cannot be negative",
    );
  });
});

describe("orderStandaloneStandingJobsForAuction", () => {
  const standingJob = (
    order: `0x${string}`,
    reward: bigint,
  ) => ({
    kind: "standing_order" as const,
    label: `standing_order:${order}`,
    target: order,
    order,
    data: "0x" as const,
    gas: 10n,
    reward: { kind: "fixed" as const, amountWei: reward },
    poolVersion: "v2" as const,
  });

  it("puts the strongest-priced work before an underpriced suffix", () => {
    const expensive = standingJob(
      "0x1000000000000000000000000000000000000001",
      300n,
    );
    const cheap = standingJob(
      "0x2000000000000000000000000000000000000002",
      200n,
    );
    const bids = new Map([
      [expensive.order, 9_409n],
      [cheap.order, 1_000n],
    ]);

    expect(
      orderStandaloneStandingJobsForAuction({
        jobs: [expensive, cheap],
        bidBps: (order) => bids.get(order)!,
        maxFeePerGas: 1n,
      }),
    ).toEqual([expensive, cheap]);
  });

  it("uses profit order when bid targets are equal", () => {
    const smaller = standingJob(
      "0x1000000000000000000000000000000000000001",
      200n,
    );
    const larger = standingJob(
      "0x2000000000000000000000000000000000000002",
      300n,
    );

    expect(
      orderStandaloneStandingJobsForAuction({
        jobs: [smaller, larger],
        bidBps: () => 1_000n,
        maxFeePerGas: 1n,
      }),
    ).toEqual([larger, smaller]);
  });
});

describe("mergeConcurrentPoolPlans", () => {
  const job = (
    kind:
      | "standing_order"
      | "fwa_process"
      | "pool_sync"
      | "pool_settle",
    poolVersion: "v1" | "v2",
    reward: bigint,
  ) =>
    ({
      kind,
      label: `${poolVersion}:${kind}`,
      target: POOL,
      data: "0x",
      gas: 1n,
      reward: { kind: "fixed", amountWei: reward },
      poolVersion,
    }) as const;

  it("keeps independently planned V1 and V2 order work in one nonce plan", () => {
    const merged = mergeConcurrentPoolPlans({
      maxJobs: 5,
      plans: [
        {
          poolVersion: "v1",
          estimatedProfit: 10n,
          plan: {
            jobs: [job("standing_order", "v1", 10n)],
            minimumViablePrefix: 1,
            orders: 72,
            skipped: new Map(),
          },
        },
        {
          poolVersion: "v2",
          estimatedProfit: 20n,
          plan: {
            jobs: [job("standing_order", "v2", 20n)],
            minimumViablePrefix: 1,
            orders: 2,
            skipped: new Map(),
          },
        },
      ],
    });

    expect(
      merged.jobs.map((candidate) => candidate.poolVersion),
    ).toEqual(["v2", "v1"]);
    expect(merged.orders).toBe(74);
    expect(merged.minimumViablePrefix).toBe(1);
  });

  it("selects only one lifecycle chain while still planning both", () => {
    const merged = mergeConcurrentPoolPlans({
      maxJobs: 6,
      plans: [
        {
          poolVersion: "v1",
          estimatedProfit: 10n,
          plan: {
            jobs: [
              job("pool_sync", "v1", 0n),
              job("pool_settle", "v1", 10n),
            ],
            minimumViablePrefix: 1,
            orders: 72,
            skipped: new Map(),
          },
        },
        {
          poolVersion: "v2",
          estimatedProfit: 20n,
          plan: {
            jobs: [
              job("pool_sync", "v2", 0n),
              job("pool_settle", "v2", 20n),
            ],
            minimumViablePrefix: 1,
            orders: 1,
            skipped: new Map(),
          },
        },
      ],
    });

    expect(
      new Set(
        merged.jobs.map(
          (candidate) => candidate.poolVersion,
        ),
      ),
    ).toEqual(new Set(["v2"]));
  });

  it("makes an unlocked GroupPull collect part of the mandatory lifecycle core", () => {
    const process = {
      ...job("fwa_process", "v2", 0n),
      requiresBundleSimulation: true,
    } as const;
    const sync = {
      ...job("pool_sync", "v2", 1n),
      roundId: 286n,
    } as const;
    const settle = {
      ...job("pool_settle", "v2", 1n),
      roundId: 286n,
    } as const;
    const optional = job("standing_order", "v1", 1n);
    const result = appendGroupPullCollectAfterSettlement({
      plan: {
        jobs: [process, sync, settle, optional],
        minimumViablePrefix: 2,
        orders: 1,
        skipped: new Map(),
      },
      contexts: [
        {
          roundId: 12n,
          bountyPot: 3_000n,
          bountyShares: 3,
          poolRoundIds: [286n],
          collected: [false],
          rounds: [{ state: 2, tokenPot: 0n }],
          canPayTokens: false,
          firstCollections: 0,
        },
      ],
      maxJobs: 6,
      builderBidBps: 9_100n,
    });

    expect(result.jobs.map(({ kind }) => kind)).toEqual([
      "fwa_process",
      "pool_sync",
      "pool_settle",
      "group_pull_collect",
      "standing_order",
    ]);
    expect(result.minimumViablePrefix).toBe(4);
    expect(result.jobs[3]).toMatchObject({
      configuredBuilderBidBps: 9_100n,
      requiresBundleSimulation: true,
    });
  });

  it("evicts an optional suffix when the collect fills the job limit", () => {
    const result = appendGroupPullCollectAfterSettlement({
      plan: {
        jobs: [
          { ...job("pool_sync", "v2", 1n), roundId: 286n },
          { ...job("pool_settle", "v2", 1n), roundId: 286n },
          job("standing_order", "v1", 1n),
        ],
        minimumViablePrefix: 2,
        orders: 1,
        skipped: new Map(),
      },
      contexts: [
        {
          roundId: 12n,
          bountyPot: 1_000n,
          bountyShares: 1,
          poolRoundIds: [286n],
          collected: [false],
          rounds: [{ state: 2, tokenPot: 0n }],
          canPayTokens: false,
          firstCollections: 0,
        },
      ],
      maxJobs: 3,
      builderBidBps: 9_100n,
    });

    expect(result.jobs.map(({ kind }) => kind)).toEqual([
      "pool_sync",
      "pool_settle",
      "group_pull_collect",
    ]);
    expect(result.minimumViablePrefix).toBe(3);
  });
});
