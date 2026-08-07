import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import {
  DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
  DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
} from "../src/constants.js";
import {
  appendDirectCoinbasePayment,
  directCoinbasePaymentEligible,
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

function buybackRequest(
  nonce: number,
): KeeperTransactionRequest {
  return {
    kind: "fwa_buyback",
    label: "fwa_buyback",
    target: ORDER,
    data: "0xf8ec6911",
    gas: 160_000n,
    reward: {
      kind: "fixed",
      amountWei: 5_000_000_000_000_000n,
    },
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
      maxFeePerGas: 5_000_000_000n,
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      kind: "builder_payment",
      target: DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
      data: "0x",
      gas: DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
      nonce: 43,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 0n,
      value: 1_200n,
    });
  });

  it("supports one isolated zero-value FWA buyback", () => {
    const requests = appendDirectCoinbasePayment({
      requests: [buybackRequest(42)],
      directBuilderPayment: 4_072_814_195_571_175n,
      baseFeeAllowancePerGas: 120_176_581n,
      maxFeePerGas: 5_000_000_000n,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.kind).toBe("fwa_buyback");
    expect(requests[1]).toMatchObject({
      kind: "builder_payment",
      nonce: 43,
      value: 4_072_814_195_571_175n,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 0n,
    });
  });

  it("covers a decreasing-child relay simulation with the reward fee envelope", () => {
    const requests = appendDirectCoinbasePayment({
      requests: [buybackRequest(42)],
      directBuilderPayment: 1n,
      baseFeeAllowancePerGas: 198_755_378n,
      maxFeePerGas: 5_000_000_000n,
    });

    expect(requests[1]).toMatchObject({
      kind: "builder_payment",
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 0n,
    });
  });

  it("rejects a helper fee envelope below the exact target base fee", () => {
    expect(() =>
      appendDirectCoinbasePayment({
        requests: [buybackRequest(42)],
        directBuilderPayment: 1n,
        baseFeeAllowancePerGas: 198_755_378n,
        maxFeePerGas: 198_755_377n,
      }),
    ).toThrow("direct payment max fee cannot be below the target base fee");
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
        maxFeePerGas: 500n,
      }),
    ).toThrow("standing orders or one isolated FWA buyback");

    expect(() =>
      appendDirectCoinbasePayment({
        requests: [
          { ...buybackRequest(42), value: 1n },
        ],
        directBuilderPayment: 1n,
        baseFeeAllowancePerGas: 1n,
        maxFeePerGas: 500n,
      }),
    ).toThrow("zero-value keeper requests");

    expect(() =>
      appendDirectCoinbasePayment({
        requests: [
          standingOrderRequest(42),
          standingOrderRequest(44),
        ],
        directBuilderPayment: 1n,
        baseFeeAllowancePerGas: 1n,
        maxFeePerGas: 500n,
      }),
    ).toThrow("contiguous keeper nonces");
  });
});

describe("directCoinbasePaymentEligible", () => {
  it("keeps pricing eligibility aligned with bundle construction", () => {
    expect(
      directCoinbasePaymentEligible([buybackRequest(42)]),
    ).toBe(true);
    expect(
      directCoinbasePaymentEligible([
        { ...buybackRequest(42), value: 1n },
      ]),
    ).toBe(false);
    expect(
      directCoinbasePaymentEligible([
        buybackRequest(42),
        buybackRequest(43),
      ]),
    ).toBe(false);
  });
});

describe("requiredSignerBalance", () => {
  it("reserves gas and transaction value for the complete atomic bundle", () => {
    const requests = appendDirectCoinbasePayment({
      requests: [standingOrderRequest(42)],
      directBuilderPayment: 1_200n,
      baseFeeAllowancePerGas: 500n,
      maxFeePerGas: 5_000_000_000n,
    });

    expect(requiredSignerBalance(requests)).toBe(
      230_000n * 5_000_000_000n +
        DIRECT_COINBASE_PAYMENT_GAS_LIMIT * 5_000_000_000n +
        1_200n,
    );
  });
});
