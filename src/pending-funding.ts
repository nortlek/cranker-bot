import {
  decodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  isHash,
  isHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hash,
  type Hex,
  type TransactionSerialized,
} from "viem";

import { poolAbi } from "./abi.js";

const ETHEREUM_CHAIN_ID = 1;
const EMPTY_INPUT = "0x";
const SUBSCRIPTION_REQUEST_ID = 1;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export type PendingFundingTransactionType =
  | "legacy"
  | "eip2930"
  | "eip1559";

const SUPPORTED_TRANSACTION_TYPES =
  new Set<PendingFundingTransactionType>([
    "legacy",
    "eip2930",
    "eip1559",
  ]);

/**
 * The subset of an authoritative RPC transaction needed to prove that a
 * serialized prerequisite is the same pending native-value transfer.
 */
export interface PendingFundingRpcTransaction {
  readonly hash: Hash;
  readonly from: Address;
  readonly nonce: number;
  readonly chainId: number | undefined;
  readonly type: string;
  readonly to: Address | null;
  readonly value: bigint;
  readonly input: Hex;
}

export interface PendingFundingObservedRpcTransaction
  extends PendingFundingRpcTransaction {
  readonly blockNumber: bigint | null;
}

export type PendingFundingHashResolution =
  | {
      readonly status: "pending";
      readonly transaction: PendingFundingObservedRpcTransaction;
      readonly rawTransaction: Hex;
    }
  | {
      readonly status: "mined";
      readonly transaction: PendingFundingObservedRpcTransaction;
      readonly rawAvailable: boolean;
    };

/**
 * Resolves both authoritative representations concurrently so the hot path
 * does not add a sequential RPC round trip. A mined transaction is still
 * classified when raw-byte retrieval fails, preserving evidence that the
 * pending notification arrived too late to execute.
 */
export async function resolvePendingFundingHash(parameters: {
  readonly getRawTransaction: () => Promise<Hex>;
  readonly getTransaction:
    () => Promise<PendingFundingObservedRpcTransaction>;
}): Promise<PendingFundingHashResolution> {
  const [rawResult, transactionResult] =
    await Promise.allSettled([
      parameters.getRawTransaction(),
      parameters.getTransaction(),
    ]);
  if (transactionResult.status === "rejected") {
    throw transactionResult.reason;
  }
  if (transactionResult.value.blockNumber !== null) {
    return {
      status: "mined",
      transaction: transactionResult.value,
      rawAvailable: rawResult.status === "fulfilled",
    };
  }
  if (rawResult.status === "rejected") {
    throw rawResult.reason;
  }
  return {
    status: "pending",
    transaction: transactionResult.value,
    rawTransaction: rawResult.value,
  };
}

export type PendingFundingValidationErrorCode =
  | "raw_missing"
  | "raw_malformed"
  | "expected_hash_invalid"
  | "hash_mismatch"
  | "rpc_hash_mismatch"
  | "unsupported_type"
  | "type_mismatch"
  | "wrong_chain"
  | "chain_mismatch"
  | "sender_invalid"
  | "sender_mismatch"
  | "nonce_invalid"
  | "nonce_mismatch"
  | "target_missing"
  | "target_mismatch"
  | "target_not_canonical"
  | "value_not_positive"
  | "value_mismatch"
  | "input_not_empty"
  | "input_mismatch"
  | "input_unsupported"
  | "ticket_purchase_invalid";

export class PendingFundingValidationError extends Error {
  readonly code: PendingFundingValidationErrorCode;

  constructor(
    code: PendingFundingValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PendingFundingValidationError";
    this.code = code;
  }
}

interface ValidatedPendingPrerequisiteBase {
  readonly rawTransaction: Hex;
  readonly hash: Hash;
  readonly sender: Address;
  readonly nonce: number;
  readonly chainId: typeof ETHEREUM_CHAIN_ID;
  readonly type: PendingFundingTransactionType;
  readonly target: Address;
  readonly value: bigint;
}

export type ValidatedPendingFundingPrerequisite =
  | (ValidatedPendingPrerequisiteBase & {
      readonly action: "order_funding";
    })
  | (ValidatedPendingPrerequisiteBase & {
      readonly action: "pool_ticket_purchase";
      readonly purchaseFunction:
        | "buyTickets"
        | "buyIntoCurrentRound";
      readonly roundId?: bigint;
      readonly tickets: number;
      readonly recipient: Address;
    });

function validationFailure(
  code: PendingFundingValidationErrorCode,
  message: string,
): never {
  throw new PendingFundingValidationError(code, message);
}

function normalizeCanonicalTargets(
  targets: Iterable<Address>,
): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const target of targets) {
    if (!isAddress(target, { strict: false })) {
      validationFailure(
        "target_not_canonical",
        "Canonical target set contains an invalid address",
      );
    }
    normalized.add(getAddress(target).toLowerCase());
  }
  return normalized;
}

function isSupportedTransactionType(
  type: string,
): type is PendingFundingTransactionType {
  return SUPPORTED_TRANSACTION_TYPES.has(
    type as PendingFundingTransactionType,
  );
}

/**
 * Proves that raw bytes fetched for a pending transaction are the exact,
 * signed Ethereum mainnet native-value transfer described by the RPC object.
 *
 * This function deliberately validates the current target allowlist at the
 * last possible point before a caller can use the raw transaction as a bundle
 * prerequisite.
 */
export async function validatePendingFundingPrerequisite(parameters: {
  readonly rawTransaction: Hex | null | undefined;
  readonly expectedHash: Hash;
  readonly rpcTransaction: PendingFundingRpcTransaction;
  readonly canonicalTargets: Iterable<Address>;
  readonly poolTarget?: Address;
}): Promise<ValidatedPendingFundingPrerequisite> {
  const {
    rawTransaction,
    expectedHash,
    rpcTransaction,
    canonicalTargets,
  } = parameters;

  if (rawTransaction === null || rawTransaction === undefined) {
    validationFailure(
      "raw_missing",
      "Pending transaction raw bytes are unavailable",
    );
  }
  if (
    !isHex(rawTransaction, { strict: true }) ||
    rawTransaction === EMPTY_INPUT
  ) {
    validationFailure(
      "raw_malformed",
      "Pending transaction raw bytes are malformed",
    );
  }
  if (!isHash(expectedHash)) {
    validationFailure(
      "expected_hash_invalid",
      "Expected pending transaction hash is invalid",
    );
  }

  const computedHash = keccak256(rawTransaction);
  if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
    validationFailure(
      "hash_mismatch",
      "Raw pending transaction hash does not match the expected hash",
    );
  }
  if (
    !isHash(rpcTransaction.hash) ||
    rpcTransaction.hash.toLowerCase() !== expectedHash.toLowerCase()
  ) {
    validationFailure(
      "rpc_hash_mismatch",
      "RPC pending transaction hash does not match the expected hash",
    );
  }

  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(
      rawTransaction as TransactionSerialized,
    );
  } catch {
    validationFailure(
      "raw_malformed",
      "Pending transaction raw bytes cannot be decoded",
    );
  }

  if (
    typeof parsed.type !== "string" ||
    !isSupportedTransactionType(parsed.type)
  ) {
    validationFailure(
      "unsupported_type",
      "Pending transaction type is not supported",
    );
  }
  if (!isSupportedTransactionType(rpcTransaction.type)) {
    validationFailure(
      "unsupported_type",
      "RPC pending transaction type is not supported",
    );
  }
  if (parsed.type !== rpcTransaction.type) {
    validationFailure(
      "type_mismatch",
      "Raw and RPC pending transaction types do not match",
    );
  }

  if (parsed.chainId !== ETHEREUM_CHAIN_ID) {
    validationFailure(
      "wrong_chain",
      "Pending transaction is not signed for Ethereum mainnet",
    );
  }
  if (rpcTransaction.chainId !== ETHEREUM_CHAIN_ID) {
    validationFailure(
      "chain_mismatch",
      "RPC pending transaction is not on Ethereum mainnet",
    );
  }

  let sender: Address;
  try {
    sender = getAddress(
      await recoverTransactionAddress({
        serializedTransaction:
          rawTransaction as TransactionSerialized,
      }),
    );
  } catch {
    validationFailure(
      "raw_malformed",
      "Pending transaction signature cannot be recovered",
    );
  }
  if (!isAddress(rpcTransaction.from, { strict: false })) {
    validationFailure(
      "sender_invalid",
      "RPC pending transaction sender is invalid",
    );
  }
  if (!isAddressEqual(sender, rpcTransaction.from)) {
    validationFailure(
      "sender_mismatch",
      "Recovered and RPC pending transaction senders do not match",
    );
  }

  if (
    parsed.nonce === undefined ||
    !Number.isSafeInteger(parsed.nonce) ||
    parsed.nonce < 0
  ) {
    validationFailure(
      "nonce_invalid",
      "Pending transaction nonce is invalid",
    );
  }
  if (
    !Number.isSafeInteger(rpcTransaction.nonce) ||
    rpcTransaction.nonce < 0
  ) {
    validationFailure(
      "nonce_invalid",
      "RPC pending transaction nonce is invalid",
    );
  }
  if (parsed.nonce !== rpcTransaction.nonce) {
    validationFailure(
      "nonce_mismatch",
      "Raw and RPC pending transaction nonces do not match",
    );
  }

  if (parsed.to === undefined || parsed.to === null) {
    validationFailure(
      "target_missing",
      "Pending transaction has no recipient",
    );
  }
  if (
    rpcTransaction.to === null ||
    !isAddress(rpcTransaction.to, { strict: false })
  ) {
    validationFailure(
      "target_mismatch",
      "RPC pending transaction has no recipient",
    );
  }
  if (!isAddressEqual(parsed.to, rpcTransaction.to)) {
    validationFailure(
      "target_mismatch",
      "Raw and RPC pending transaction recipients do not match",
    );
  }
  const target = getAddress(parsed.to);
  const normalizedTargets =
    normalizeCanonicalTargets(canonicalTargets);
  if (!normalizedTargets.has(target.toLowerCase())) {
    validationFailure(
      "target_not_canonical",
      "Pending transaction recipient is not a canonical target",
    );
  }

  const value = parsed.value ?? 0n;
  if (value <= 0n || rpcTransaction.value <= 0n) {
    validationFailure(
      "value_not_positive",
      "Pending transaction must transfer positive native value",
    );
  }
  if (value !== rpcTransaction.value) {
    validationFailure(
      "value_mismatch",
      "Raw and RPC pending transaction values do not match",
    );
  }

  const input = parsed.data ?? EMPTY_INPUT;
  const isPoolTarget =
    parameters.poolTarget !== undefined &&
    isAddressEqual(target, parameters.poolTarget);
  if (!isPoolTarget) {
    if (
      input !== EMPTY_INPUT ||
      rpcTransaction.input !== EMPTY_INPUT
    ) {
      validationFailure(
        "input_not_empty",
        "Pending funding transaction input must be empty",
      );
    }
    return {
      action: "order_funding",
      rawTransaction,
      hash: computedHash,
      sender,
      nonce: parsed.nonce,
      chainId: ETHEREUM_CHAIN_ID,
      type: parsed.type,
      target,
      value,
    };
  }
  if (input.toLowerCase() !== rpcTransaction.input.toLowerCase()) {
    validationFailure(
      "input_mismatch",
      "Raw and RPC pending transaction inputs do not match",
    );
  }
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: poolAbi,
      data: input,
    });
  } catch {
    validationFailure(
      "input_unsupported",
      "Pending pool transaction calldata is not recognized",
    );
  }
  if (
    decoded.functionName !== "buyTickets" &&
    decoded.functionName !== "buyIntoCurrentRound"
  ) {
    validationFailure(
      "input_unsupported",
      "Pending pool transaction is not a ticket purchase",
    );
  }
  if (!Array.isArray(decoded.args)) {
    validationFailure(
      "ticket_purchase_invalid",
      "Pending pool ticket purchase arguments are incomplete",
    );
  }
  const explicitRound =
    decoded.functionName === "buyTickets";
  if (
    (explicitRound && decoded.args.length !== 3) ||
    (!explicitRound && decoded.args.length !== 2)
  ) {
    validationFailure(
      "ticket_purchase_invalid",
      "Pending pool ticket purchase arguments are incomplete",
    );
  }
  const roundId = explicitRound
    ? decoded.args[0]
    : undefined;
  const tickets = explicitRound
    ? decoded.args[1]
    : decoded.args[0];
  const recipient = explicitRound
    ? decoded.args[2]
    : decoded.args[1];
  if (
    (explicitRound &&
      (typeof roundId !== "bigint" ||
        roundId <= 0n)) ||
    typeof tickets !== "number" ||
    !Number.isSafeInteger(tickets) ||
    tickets <= 0 ||
    typeof recipient !== "string" ||
    !isAddress(recipient, { strict: false })
  ) {
    validationFailure(
      "ticket_purchase_invalid",
      "Pending pool ticket purchase arguments are invalid",
    );
  }

  return {
    action: "pool_ticket_purchase",
    purchaseFunction: decoded.functionName,
    rawTransaction,
    hash: computedHash,
    sender,
    nonce: parsed.nonce,
    chainId: ETHEREUM_CHAIN_ID,
    type: parsed.type,
    target,
    value,
    ...(typeof roundId === "bigint" ? { roundId } : {}),
    tickets,
    recipient: getAddress(recipient),
  };
}

export interface PendingFundingCandidateIdentity {
  readonly hash: Hash;
  readonly sender: Address;
  readonly nonce: number;
}

export type PendingFundingTrackResult =
  | {
      readonly status: "new";
      readonly key: string;
      readonly hash: Hash;
    }
  | {
      readonly status: "duplicate";
      readonly key: string;
      readonly hash: Hash;
    }
  | {
      readonly status: "replacement";
      readonly key: string;
      readonly hash: Hash;
      readonly replacedHash: Hash;
    };

function candidateKey(
  candidate: Pick<
    PendingFundingCandidateIdentity,
    "sender" | "nonce"
  >,
): string {
  if (!isAddress(candidate.sender, { strict: false })) {
    throw new TypeError(
      "Pending funding candidate sender is invalid",
    );
  }
  if (
    !Number.isSafeInteger(candidate.nonce) ||
    candidate.nonce < 0
  ) {
    throw new TypeError(
      "Pending funding candidate nonce is invalid",
    );
  }
  return `${candidate.sender.toLowerCase()}:${candidate.nonce}`;
}

/**
 * Tracks pending-transaction identity by sender and nonce. A later hash for
 * the same key atomically supersedes the earlier candidate, allowing
 * asynchronous handlers to stop before simulating or submitting stale bytes.
 */
export class PendingFundingReplacementTracker {
  readonly #currentHashes = new Map<string, Hash>();

  get size(): number {
    return this.#currentHashes.size;
  }

  observe(
    candidate: PendingFundingCandidateIdentity,
  ): PendingFundingTrackResult {
    if (!isHash(candidate.hash)) {
      throw new TypeError(
        "Pending funding candidate hash is invalid",
      );
    }
    const key = candidateKey(candidate);
    const previous = this.#currentHashes.get(key);
    if (
      previous !== undefined &&
      previous.toLowerCase() === candidate.hash.toLowerCase()
    ) {
      return {
        status: "duplicate",
        key,
        hash: previous,
      };
    }

    this.#currentHashes.set(key, candidate.hash);
    if (previous === undefined) {
      return {
        status: "new",
        key,
        hash: candidate.hash,
      };
    }
    return {
      status: "replacement",
      key,
      hash: candidate.hash,
      replacedHash: previous,
    };
  }

  isCurrent(candidate: PendingFundingCandidateIdentity): boolean {
    if (!isHash(candidate.hash)) {
      return false;
    }
    const current = this.#currentHashes.get(candidateKey(candidate));
    return (
      current !== undefined &&
      current.toLowerCase() === candidate.hash.toLowerCase()
    );
  }

  forget(candidate: PendingFundingCandidateIdentity): boolean {
    if (!this.isCurrent(candidate)) {
      return false;
    }
    return this.#currentHashes.delete(candidateKey(candidate));
  }

  clear(): void {
    this.#currentHashes.clear();
  }
}

export type PendingFundingSubscriptionErrorCode =
  | "connection_failed"
  | "protocol_error"
  | "handler_failed";

export class PendingFundingSubscriptionError extends Error {
  readonly code: PendingFundingSubscriptionErrorCode;

  constructor(
    code: PendingFundingSubscriptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PendingFundingSubscriptionError";
    this.code = code;
  }
}

export type PendingFundingWebSocketFactory = (
  url: string,
) => WebSocket;

export interface PendingFundingHashSubscription {
  readonly closed: boolean;
  readonly ready: Promise<void>;
  close(): void;
}

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: string;
  readonly params?: {
    readonly subscription?: unknown;
    readonly result?: unknown;
  };
}

async function messageText(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }
  return undefined;
}

/**
 * Opens an Alchemy hash-only filtered pending-transaction subscription.
 * Disconnects reconnect through the same WebSocket subscription mechanism;
 * this helper intentionally has no polling or unfiltered fallback.
 */
export function subscribeToAlchemyPendingFundingHashes(parameters: {
  readonly url: string;
  readonly targetAddresses: readonly Address[];
  readonly onHash: (hash: Hash) => void | Promise<void>;
  readonly onError?: (
    error: PendingFundingSubscriptionError,
  ) => void;
  readonly onSubscribed?: (
    connectionGeneration: number,
  ) => void;
  readonly reconnectDelayMs?: number;
  readonly webSocketFactory?: PendingFundingWebSocketFactory;
}): PendingFundingHashSubscription {
  const {
    url,
    onHash,
    onError,
    onSubscribed,
    webSocketFactory = (endpoint) => new WebSocket(endpoint),
  } = parameters;
  const reconnectDelayMs =
    parameters.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new TypeError(
      "Pending funding subscription URL is invalid",
    );
  }
  if (parsedUrl.protocol !== "wss:") {
    throw new TypeError(
      "Pending funding subscription URL must use wss",
    );
  }
  if (
    !Number.isFinite(reconnectDelayMs) ||
    reconnectDelayMs < 0
  ) {
    throw new TypeError(
      "Pending funding reconnect delay must be non-negative",
    );
  }

  const targets = [
    ...normalizeCanonicalTargets(parameters.targetAddresses),
  ];
  if (targets.length === 0) {
    throw new TypeError(
      "Pending funding subscription requires at least one target",
    );
  }

  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let subscriptionId: string | undefined;
  let connectionGeneration = 0;
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const report = (
    code: PendingFundingSubscriptionErrorCode,
    message: string,
  ): void => {
    if (onError === undefined) {
      return;
    }
    try {
      onError(new PendingFundingSubscriptionError(code, message));
    } catch {
      // The observer cannot be allowed to disrupt reconnection.
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelayMs);
  };

  const handleMessage = async (
    event: MessageEvent<unknown>,
    source: WebSocket,
  ): Promise<void> => {
    const text = await messageText(event.data);
    if (text === undefined) {
      report(
        "protocol_error",
        "Pending funding subscription returned unsupported message data",
      );
      return;
    }

    let payload: JsonRpcResponse;
    try {
      payload = JSON.parse(text) as JsonRpcResponse;
    } catch {
      report(
        "protocol_error",
        "Pending funding subscription returned invalid JSON",
      );
      return;
    }

    if (source !== socket || stopped) {
      return;
    }
    if (payload.id === SUBSCRIPTION_REQUEST_ID) {
      if (
        payload.error !== undefined ||
        typeof payload.result !== "string"
      ) {
        report(
          "protocol_error",
          "Pending funding subscription request was rejected",
        );
        source.close();
        return;
      }
      subscriptionId = payload.result;
      try {
        onSubscribed?.(connectionGeneration);
      } catch {
        report(
          "handler_failed",
          "Pending funding subscription observer failed",
        );
      }
      markReady?.();
      markReady = undefined;
      return;
    }
    if (
      payload.method !== "eth_subscription" ||
      payload.params?.subscription !== subscriptionId
    ) {
      return;
    }
    const hash = payload.params?.result;
    if (typeof hash !== "string" || !isHash(hash)) {
      report(
        "protocol_error",
        "Pending funding subscription returned an invalid hash",
      );
      return;
    }

    try {
      await onHash(hash);
    } catch {
      report(
        "handler_failed",
        "Pending funding hash handler failed",
      );
    }
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }

    let nextSocket: WebSocket;
    try {
      nextSocket = webSocketFactory(url);
    } catch {
      report(
        "connection_failed",
        "Pending funding WebSocket connection failed",
      );
      scheduleReconnect();
      return;
    }

    socket = nextSocket;
    connectionGeneration += 1;
    subscriptionId = undefined;
    nextSocket.onopen = () => {
      if (nextSocket !== socket || stopped) {
        return;
      }
      try {
        nextSocket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: SUBSCRIPTION_REQUEST_ID,
            method: "eth_subscribe",
            params: [
              "alchemy_pendingTransactions",
              {
                toAddress: targets,
                hashesOnly: true,
              },
            ],
          }),
        );
      } catch {
        report(
          "connection_failed",
          "Pending funding subscription request could not be sent",
        );
        nextSocket.close();
      }
    };
    nextSocket.onmessage = (event) => {
      void handleMessage(event, nextSocket);
    };
    nextSocket.onerror = () => {
      if (nextSocket === socket && !stopped) {
        report(
          "connection_failed",
          "Pending funding WebSocket connection failed",
        );
        try {
          nextSocket.close();
        } catch {
          socket = undefined;
          subscriptionId = undefined;
          scheduleReconnect();
        }
      }
    };
    nextSocket.onclose = () => {
      if (nextSocket !== socket) {
        return;
      }
      socket = undefined;
      subscriptionId = undefined;
      scheduleReconnect();
    };
  };

  connect();

  return {
    ready,
    get closed(): boolean {
      return stopped;
    },
    close(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const activeSocket = socket;
      socket = undefined;
      subscriptionId = undefined;
      activeSocket?.close(1000, "subscription closed");
    },
  };
}
