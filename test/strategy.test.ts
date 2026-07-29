import {
  InvalidParamsRpcError,
  RpcRequestError,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  highestPositiveClaimableIndexes,
  isFreshBlockStateUnavailable,
  orderAlreadyBought,
  orderHasMinimumBalance,
  planningHeadIsStale,
} from "../src/strategy.js";

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
