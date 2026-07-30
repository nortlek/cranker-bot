import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Hash,
  type Hex,
} from "viem";

import { vrfCoordinatorAbi } from "./abi.js";
import {
  validateSignedPendingTransaction,
  type PendingFundingRpcTransaction,
  type PendingFundingTransactionType,
} from "./pending-funding.js";

export const VRF_FULFILL_RANDOM_WORDS_SELECTOR = "0x301f42e9";

export type PendingFwaFulfillmentValidationErrorCode =
  | "coordinator_mismatch"
  | "value_not_zero"
  | "calldata_unsupported"
  | "consumer_mismatch"
  | "subscription_mismatch"
  | "request_mismatch";

export class PendingFwaFulfillmentValidationError extends Error {
  readonly code: PendingFwaFulfillmentValidationErrorCode;

  constructor(
    code: PendingFwaFulfillmentValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PendingFwaFulfillmentValidationError";
    this.code = code;
  }
}

export interface ValidatedPendingFwaFulfillment {
  readonly rawTransaction: Hex;
  readonly hash: Hash;
  readonly sender: Address;
  readonly nonce: number;
  readonly chainId: 1;
  readonly type: PendingFundingTransactionType;
  readonly coordinator: Address;
  readonly value: 0n;
  readonly requestId: bigint;
  readonly consumer: Address;
  readonly subId: bigint;
}

export interface PendingFwaBundlePrerequisite
  extends ValidatedPendingFwaFulfillment {
  readonly prerequisiteTransactions: readonly {
    readonly rawTransaction: Hex;
    readonly hash: Hash;
    readonly sender: Address;
    readonly nonce: number;
  }[];
}

function validationFailure(
  code: PendingFwaFulfillmentValidationErrorCode,
  message: string,
): never {
  throw new PendingFwaFulfillmentValidationError(code, message);
}

export function requestIdFromFulfillmentProof(parameters: {
  readonly publicKey: readonly [bigint, bigint];
  readonly seed: bigint;
}): bigint {
  const keyHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256[2]" }],
      [[parameters.publicKey[0], parameters.publicKey[1]]],
    ),
  );
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }],
        [keyHash, parameters.seed],
      ),
    ),
  );
}

/**
 * Validates the exact raw Chainlink fulfillment that can move the pool's FWA
 * request from Pending to Fulfilled inside the prerequisite transaction.
 */
export async function validatePendingFwaFulfillment(parameters: {
  readonly rawTransaction: Hex | null | undefined;
  readonly expectedHash: Hash;
  readonly rpcTransaction: PendingFundingRpcTransaction;
  readonly expectedCoordinator: Address;
  readonly expectedConsumer: Address;
  readonly expectedSubId: bigint;
  readonly expectedRequestId: bigint;
}): Promise<ValidatedPendingFwaFulfillment> {
  const validated = await validateSignedPendingTransaction(parameters);
  if (
    !isAddressEqual(
      validated.target,
      getAddress(parameters.expectedCoordinator),
    )
  ) {
    validationFailure(
      "coordinator_mismatch",
      "Pending fulfillment target is not the configured coordinator",
    );
  }
  if (validated.value !== 0n) {
    validationFailure(
      "value_not_zero",
      "Pending fulfillment must have zero transaction value",
    );
  }

  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: vrfCoordinatorAbi,
      data: validated.input,
    });
  } catch {
    validationFailure(
      "calldata_unsupported",
      "Pending coordinator calldata is not a VRF fulfillment",
    );
  }
  if (
    decoded.functionName !== "fulfillRandomWords" ||
    !Array.isArray(decoded.args) ||
    decoded.args.length !== 3
  ) {
    validationFailure(
      "calldata_unsupported",
      "Pending coordinator calldata is not a VRF fulfillment",
    );
  }
  const [proof, commitment] = decoded.args;
  if (
    !isAddressEqual(
      commitment.sender,
      getAddress(parameters.expectedConsumer),
    )
  ) {
    validationFailure(
      "consumer_mismatch",
      "Pending fulfillment is for another VRF consumer",
    );
  }
  if (commitment.subId !== parameters.expectedSubId) {
    validationFailure(
      "subscription_mismatch",
      "Pending fulfillment uses another VRF subscription",
    );
  }
  const requestId = requestIdFromFulfillmentProof({
    publicKey: proof.pk,
    seed: proof.seed,
  });
  if (requestId !== parameters.expectedRequestId) {
    validationFailure(
      "request_mismatch",
      "Pending fulfillment is for another FWA request",
    );
  }

  return {
    rawTransaction: validated.rawTransaction,
    hash: validated.hash,
    sender: validated.sender,
    nonce: validated.nonce,
    chainId: 1,
    type: validated.type,
    coordinator: validated.target,
    value: 0n,
    requestId,
    consumer: getAddress(commitment.sender),
    subId: commitment.subId,
  };
}
