import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
  DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
} from "../src/constants.js";
import {
  appendDirectCoinbasePayment,
  requiredSignerBalance,
} from "../src/direct-coinbase-payment.js";
import type { KeeperTransactionRequest } from "../src/strategy.js";

const ORDER = getAddress(
  "0x93d56d01534e7e4702fEE7a6282C708cB60d49E7",
);

function standingOrderRequest(
  nonce: number,
): KeeperTransactionRequest {
  return {
    kind: "standing_order",
    label: `standing_order:${ORDER}`,
    target: ORDER,
    data: "0x1234",
    gas: 230_000n,
    reward: { kind: "fixed", amountWei: 2_500_000_000_000_000n },
    order: ORDER,
    nonce,
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 4_500_000_000n,
  };
}

describe("appendDirectCoinbasePayment", () => {
  it("appends an exact zero-priority payment suffix at the next nonce", () => {
    const requests = appendDirectCoinbasePayment({
      requests: [standingOrderRequest(42)],
      directBuilderPayment: 1_200n,
      baseFeeAllowancePerGas: 500n,
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      kind: "builder_payment",
      target: DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
      data: "0x",
      gas: DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
      nonce: 43,
      maxFeePerGas: 500n,
      maxPriorityFeePerGas: 0n,
      value: 1_200n,
    });
  });

  it("rejects mixed jobs and nonce gaps", () => {
    const {
      order: _order,
      ...standingOrderWithoutOrder
    } = standingOrderRequest(43);
    const mixed: KeeperTransactionRequest = {
      ...standingOrderWithoutOrder,
      kind: "pool_pull",
    };
    expect(() =>
      appendDirectCoinbasePayment({
        requests: [standingOrderRequest(42), mixed],
        directBuilderPayment: 1n,
        baseFeeAllowancePerGas: 1n,
      }),
    ).toThrow("zero-value standing-order");

    expect(() =>
      appendDirectCoinbasePayment({
        requests: [
          standingOrderRequest(42),
          standingOrderRequest(44),
        ],
        directBuilderPayment: 1n,
        baseFeeAllowancePerGas: 1n,
      }),
    ).toThrow("contiguous keeper nonces");
  });
});

describe("requiredSignerBalance", () => {
  it("reserves gas and transaction value for the complete atomic bundle", () => {
    const requests = appendDirectCoinbasePayment({
      requests: [standingOrderRequest(42)],
      directBuilderPayment: 1_200n,
      baseFeeAllowancePerGas: 500n,
    });

    expect(requiredSignerBalance(requests)).toBe(
      230_000n * 5_000_000_000n +
        DIRECT_COINBASE_PAYMENT_GAS_LIMIT * 500n +
        1_200n,
    );
  });
});
