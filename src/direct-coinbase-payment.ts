import {
  DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
  DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
} from "./constants.js";
import type { KeeperTransactionRequest } from "./strategy.js";

export function directCoinbasePaymentEligible(
  requests: readonly KeeperTransactionRequest[],
): boolean {
  if (
    requests.length === 0 ||
    requests.some((request) => (request.value ?? 0n) !== 0n)
  ) {
    return false;
  }
  return (
    requests.every(
      (request) =>
        request.kind === "standing_order" &&
        request.order !== undefined,
    ) ||
    (requests.length === 1 &&
      requests[0]?.kind === "fwa_buyback")
  );
}

export function appendDirectCoinbasePayment(parameters: {
  readonly requests: readonly KeeperTransactionRequest[];
  readonly directBuilderPayment: bigint;
  readonly baseFeeAllowancePerGas: bigint;
  readonly maxFeePerGas: bigint;
}): readonly KeeperTransactionRequest[] {
  if (parameters.directBuilderPayment <= 0n) {
    throw new Error("direct builder payment must be positive");
  }
  if (parameters.baseFeeAllowancePerGas < 0n) {
    throw new Error("base fee allowance cannot be negative");
  }
  if (
    parameters.maxFeePerGas <
    parameters.baseFeeAllowancePerGas
  ) {
    throw new Error(
      "direct payment max fee cannot be below the target base fee",
    );
  }
  const lastRequest = parameters.requests.at(-1);
  if (lastRequest === undefined) {
    throw new Error(
      "direct coinbase payment requires at least one keeper request",
    );
  }
  const firstNonce = parameters.requests[0]!.nonce;
  if (
    parameters.requests.some(
      (request) => (request.value ?? 0n) !== 0n,
    )
  ) {
    throw new Error(
      "direct coinbase payment requires zero-value keeper requests",
    );
  }
  if (!directCoinbasePaymentEligible(parameters.requests)) {
    throw new Error(
      "direct coinbase payment requires standing orders or one isolated FWA buyback",
    );
  }
  for (
    let index = 0;
    index < parameters.requests.length;
    index += 1
  ) {
    const request = parameters.requests[index]!;
    if (request.nonce !== firstNonce + index) {
      throw new Error(
        "direct coinbase payment requires contiguous keeper nonces",
      );
    }
  }
  if (lastRequest.nonce >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "direct coinbase payment nonce exceeds the safe integer range",
    );
  }

  return [
    ...parameters.requests,
    {
      kind: "builder_payment",
      label: "builder_payment:coinbase",
      target: DIRECT_COINBASE_PAYMENT_HELPER_ADDRESS,
      data: "0x",
      gas: DIRECT_COINBASE_PAYMENT_GAS_LIMIT,
      reward: { kind: "fixed", amountWei: 0n },
      nonce: lastRequest.nonce + 1,
      // Some relay simulators retain the parent base fee while publishing a
      // decreasing child base fee. Give the zero-tip helper the same signed
      // fee capacity as the reward-producing transaction; its effective gas
      // price remains the exact child base fee.
      maxFeePerGas: parameters.maxFeePerGas,
      maxPriorityFeePerGas: 0n,
      value: parameters.directBuilderPayment,
    },
  ];
}

export function requiredSignerBalance(
  requests: readonly KeeperTransactionRequest[],
): bigint {
  return requests.reduce((total, request) => {
    if (
      request.gas < 0n ||
      request.maxFeePerGas < 0n ||
      (request.value ?? 0n) < 0n
    ) {
      throw new Error(
        "transaction funding requirements cannot be negative",
      );
    }
    return (
      total +
      request.gas * request.maxFeePerGas +
      (request.value ?? 0n)
    );
  }, 0n);
}
