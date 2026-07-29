import {
  InvalidParamsRpcError,
  RpcRequestError,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  highestPositiveClaimableIndexes,
  isFreshBlockStateUnavailable,
  estimatedJobReward,
  maximumFundableGasEnvelope,
  orderAlreadyBought,
  orderHasMinimumBalance,
  planningHeadIsStale,
} from "../src/strategy.js";

const POOL =
  "0x1111111111111111111111111111111111111111" as const;

describe("isFreshBlockStateUnavailable", () => {
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
    }
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
