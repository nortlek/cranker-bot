import {
  getAddress,
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  PendingFundingReplacementTracker,
  PendingFundingValidationError,
  subscribeToAlchemyPendingFundingHashes,
  validatePendingFundingPrerequisite,
  type PendingFundingRpcTransaction,
  type PendingFundingTransactionType,
} from "../src/pending-funding.js";

const account = privateKeyToAccount(
  `0x${"11".repeat(32)}`,
);
const otherAccount = privateKeyToAccount(
  `0x${"22".repeat(32)}`,
);
const canonicalTarget = getAddress(
  "0x1000000000000000000000000000000000000001",
);
const otherTarget = getAddress(
  "0x2000000000000000000000000000000000000002",
);

async function signFunding(
  type: PendingFundingTransactionType,
  overrides: {
    readonly chainId?: number;
    readonly nonce?: number;
    readonly to?: Address | null;
    readonly value?: bigint;
    readonly data?: Hex;
  } = {},
): Promise<Hex> {
  const base = {
    chainId: overrides.chainId ?? 1,
    nonce: overrides.nonce ?? 7,
    to:
      overrides.to === undefined
        ? canonicalTarget
        : overrides.to,
    value: overrides.value ?? 1_000_000_000_000_000n,
    data: overrides.data ?? "0x",
    gas: 50_000n,
  } as const;

  if (type === "legacy") {
    return account.signTransaction({
      ...base,
      type,
      gasPrice: 2_000_000_000n,
    });
  }
  if (type === "eip2930") {
    return account.signTransaction({
      ...base,
      type,
      accessList: [],
      gasPrice: 2_000_000_000n,
    });
  }
  return account.signTransaction({
    ...base,
    type,
    accessList: [],
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
}

function rpcTransaction(
  rawTransaction: Hex,
  overrides: Partial<PendingFundingRpcTransaction> = {},
): PendingFundingRpcTransaction {
  const parsed = parseTransaction(rawTransaction);
  if (
    parsed.type === undefined ||
    parsed.chainId === undefined ||
    parsed.nonce === undefined ||
    parsed.to === undefined ||
    parsed.to === null
  ) {
    throw new Error("test funding fixture is incomplete");
  }
  return {
    hash: keccak256(rawTransaction),
    from: account.address,
    nonce: parsed.nonce,
    chainId: parsed.chainId,
    type: parsed.type,
    to: parsed.to,
    value: parsed.value ?? 0n,
    input: parsed.data ?? "0x",
    ...overrides,
  };
}

async function expectValidationCode(
  promise: Promise<unknown>,
  code: PendingFundingValidationError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "PendingFundingValidationError",
    code,
  });
}

let eip1559Funding: Hex;
let eip2930Funding: Hex;
let legacyFunding: Hex;

beforeAll(async () => {
  [eip1559Funding, eip2930Funding, legacyFunding] =
    await Promise.all([
      signFunding("eip1559"),
      signFunding("eip2930"),
      signFunding("legacy"),
    ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("validatePendingFundingPrerequisite", () => {
  it.each([
    ["legacy", () => legacyFunding],
    ["eip2930", () => eip2930Funding],
    ["eip1559", () => eip1559Funding],
  ] as const)(
    "accepts an exact signed Ethereum %s native transfer",
    async (type, raw) => {
      const rawTransaction = raw();
      const hash = keccak256(rawTransaction);

      await expect(
        validatePendingFundingPrerequisite({
          rawTransaction,
          expectedHash: hash,
          rpcTransaction: rpcTransaction(rawTransaction),
          canonicalTargets: [canonicalTarget],
        }),
      ).resolves.toMatchObject({
        rawTransaction,
        hash,
        sender: account.address,
        nonce: 7,
        chainId: 1,
        type,
        target: canonicalTarget,
        value: 1_000_000_000_000_000n,
      });
    },
  );

  it.each([null, undefined])(
    "rejects missing raw bytes",
    async (rawTransaction) => {
      await expectValidationCode(
        validatePendingFundingPrerequisite({
          rawTransaction,
          expectedHash: keccak256(eip1559Funding),
          rpcTransaction: rpcTransaction(eip1559Funding),
          canonicalTargets: [canonicalTarget],
        }),
        "raw_missing",
      );
    },
  );

  it.each(["0x", "0xzz"])(
    "rejects malformed raw bytes",
    async (rawTransaction) => {
      await expectValidationCode(
        validatePendingFundingPrerequisite({
          rawTransaction: rawTransaction as Hex,
          expectedHash: keccak256(eip1559Funding),
          rpcTransaction: rpcTransaction(eip1559Funding),
          canonicalTargets: [canonicalTarget],
        }),
        "raw_malformed",
      );
    },
  );

  it("rejects raw hex that cannot be decoded as a transaction", async () => {
    const rawTransaction = "0x01";
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          hash: keccak256(rawTransaction),
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "raw_malformed",
    );
  });

  it("rejects a raw transaction with a different expected hash", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: `0x${"aa".repeat(32)}`,
        rpcTransaction: rpcTransaction(eip1559Funding),
        canonicalTargets: [canonicalTarget],
      }),
      "hash_mismatch",
    );
  });

  it("rejects a mismatched RPC transaction hash", async () => {
    const expectedHash = keccak256(eip1559Funding);
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash,
        rpcTransaction: rpcTransaction(eip1559Funding, {
          hash: `0x${"bb".repeat(32)}`,
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "rpc_hash_mismatch",
    );
  });

  it("rejects a mismatched RPC sender", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          from: otherAccount.address,
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "sender_mismatch",
    );
  });

  it("rejects unsigned raw transaction bytes", async () => {
    const rawTransaction = serializeTransaction({
      type: "eip1559",
      chainId: 1,
      nonce: 7,
      gas: 50_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: canonicalTarget,
      value: 1n,
    });
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: {
          ...rpcTransaction(eip1559Funding),
          hash: keccak256(rawTransaction),
          value: 1n,
        },
        canonicalTargets: [canonicalTarget],
      }),
      "raw_malformed",
    );
  });

  it("rejects a raw transaction signed for another chain", async () => {
    const rawTransaction = await signFunding("eip1559", {
      chainId: 2,
    });
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: rpcTransaction(rawTransaction),
        canonicalTargets: [canonicalTarget],
      }),
      "wrong_chain",
    );
  });

  it("rejects a mismatched RPC chain", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          chainId: 2,
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "chain_mismatch",
    );
  });

  it("rejects unsupported raw transaction types", async () => {
    const rawTransaction = serializeTransaction({
      type: "eip4844",
      chainId: 1,
      nonce: 7,
      gas: 50_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerBlobGas: 1_000_000_000n,
      to: canonicalTarget,
      value: 1n,
      blobVersionedHashes: [
        `0x01${"00".repeat(31)}`,
      ],
      r: `0x${"01".repeat(32)}`,
      s: `0x${"02".repeat(32)}`,
      yParity: 0,
    });
    const parsed = parseTransaction(rawTransaction);
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: {
          hash: keccak256(rawTransaction),
          from: account.address,
          nonce: parsed.nonce ?? 0,
          chainId: parsed.chainId,
          type: "eip4844",
          to: canonicalTarget,
          value: 1n,
          input: "0x",
        },
        canonicalTargets: [canonicalTarget],
      }),
      "unsupported_type",
    );
  });

  it("rejects a mismatched or unsupported RPC type", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          type: "eip7702",
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "unsupported_type",
    );
  });

  it("rejects a different supported RPC type", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          type: "legacy",
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "type_mismatch",
    );
  });

  it("rejects a mismatched nonce", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          nonce: 8,
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "nonce_mismatch",
    );
  });

  it("rejects a mismatched RPC recipient", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          to: otherTarget,
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "target_mismatch",
    );
  });

  it("rejects a recipient outside the current canonical set", async () => {
    const rawTransaction = await signFunding("eip1559", {
      to: otherTarget,
    });
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: rpcTransaction(rawTransaction),
        canonicalTargets: [canonicalTarget],
      }),
      "target_not_canonical",
    );
  });

  it("rejects a contract-creation prerequisite", async () => {
    const rawTransaction = await signFunding("eip1559", {
      to: null,
    });
    const parsed = parseTransaction(rawTransaction);
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: {
          hash: keccak256(rawTransaction),
          from: account.address,
          nonce: parsed.nonce ?? 0,
          chainId: parsed.chainId,
          type: parsed.type ?? "eip1559",
          to: null,
          value: parsed.value ?? 0n,
          input: parsed.data ?? "0x",
        },
        canonicalTargets: [canonicalTarget],
      }),
      "target_missing",
    );
  });

  it("rejects a mismatched RPC value", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          value: 2n,
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "value_mismatch",
    );
  });

  it("rejects a zero-value transfer", async () => {
    const rawTransaction = await signFunding("eip1559", {
      value: 0n,
    });
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: rpcTransaction(rawTransaction),
        canonicalTargets: [canonicalTarget],
      }),
      "value_not_positive",
    );
  });

  it("rejects non-empty RPC input", async () => {
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction: eip1559Funding,
        expectedHash: keccak256(eip1559Funding),
        rpcTransaction: rpcTransaction(eip1559Funding, {
          input: "0x01",
        }),
        canonicalTargets: [canonicalTarget],
      }),
      "input_not_empty",
    );
  });

  it("rejects a signed transfer with calldata", async () => {
    const rawTransaction = await signFunding("eip1559", {
      data: "0x1234",
    });
    await expectValidationCode(
      validatePendingFundingPrerequisite({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: rpcTransaction(rawTransaction),
        canonicalTargets: [canonicalTarget],
      }),
      "input_not_empty",
    );
  });
});

describe("PendingFundingReplacementTracker", () => {
  const firstHash = `0x${"01".repeat(32)}` as Hash;
  const replacementHash = `0x${"02".repeat(32)}` as Hash;
  const first = {
    hash: firstHash,
    sender: account.address,
    nonce: 9,
  };

  it("deduplicates the same sender, nonce, and hash", () => {
    const tracker = new PendingFundingReplacementTracker();

    expect(tracker.observe(first)).toMatchObject({
      status: "new",
      hash: firstHash,
    });
    expect(tracker.observe(first)).toMatchObject({
      status: "duplicate",
      hash: firstHash,
    });
    expect(tracker.size).toBe(1);
  });

  it("supersedes an earlier hash with the same sender and nonce", () => {
    const tracker = new PendingFundingReplacementTracker();
    const replacement = {
      ...first,
      hash: replacementHash,
    };

    tracker.observe(first);
    expect(tracker.observe(replacement)).toMatchObject({
      status: "replacement",
      hash: replacementHash,
      replacedHash: firstHash,
    });
    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(replacement)).toBe(true);
    expect(tracker.forget(first)).toBe(false);
    expect(tracker.forget(replacement)).toBe(true);
    expect(tracker.size).toBe(0);
  });

  it("keeps different sender-nonce keys independent", () => {
    const tracker = new PendingFundingReplacementTracker();

    expect(tracker.observe(first).status).toBe("new");
    expect(
      tracker.observe({
        ...first,
        sender: otherAccount.address,
      }).status,
    ).toBe("new");
    expect(
      tracker.observe({
        ...first,
        nonce: first.nonce + 1,
      }).status,
    ).toBe("new");
    expect(tracker.size).toBe(3);
  });
});

class FakeWebSocket {
  onopen: ((event: Event) => unknown) | null = null;
  onmessage:
    | ((event: MessageEvent<unknown>) => unknown)
    | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  readonly sent: string[] = [];
  closeCount = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    this.onclose?.(new CloseEvent("close"));
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  emitClose(): void {
    this.onclose?.(new CloseEvent("close"));
  }
}

describe("subscribeToAlchemyPendingFundingHashes", () => {
  it("requests only hashes filtered to the canonical targets", async () => {
    const sockets: FakeWebSocket[] = [];
    const hashes: Hash[] = [];
    const subscription =
      subscribeToAlchemyPendingFundingHashes({
        url: "wss://example.invalid/private",
        targetAddresses: [canonicalTarget, canonicalTarget],
        onHash: (hash) => {
          hashes.push(hash);
        },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });
    const socket = sockets[0]!;

    socket.emitOpen();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: [
        "alchemy_pendingTransactions",
        {
          toAddress: [canonicalTarget.toLowerCase()],
          hashesOnly: true,
        },
      ],
    });

    socket.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: "0xsubscription",
    });
    await expect(subscription.ready).resolves.toBeUndefined();
    const hash = `0x${"ab".repeat(32)}` as Hash;
    socket.emitMessage({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: "0xsubscription",
        result: hash,
      },
    });
    await vi.waitFor(() => expect(hashes).toEqual([hash]));

    subscription.close();
    expect(subscription.closed).toBe(true);
  });

  it("reconnects with the same filtered mechanism after a close", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const subscription =
      subscribeToAlchemyPendingFundingHashes({
        url: "wss://example.invalid/private",
        targetAddresses: [canonicalTarget],
        onHash: () => undefined,
        reconnectDelayMs: 25,
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });

    sockets[0]!.emitClose();
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(25);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emitOpen();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({
      method: "eth_subscribe",
      params: [
        "alchemy_pendingTransactions",
        { hashesOnly: true },
      ],
    });

    subscription.close();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
  });

  it("reports fixed protocol errors without endpoint or payload data", async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Error[] = [];
    const subscription =
      subscribeToAlchemyPendingFundingHashes({
        url: "wss://example.invalid/private-secret",
        targetAddresses: [canonicalTarget],
        onHash: () => undefined,
        onError: (error) => {
          errors.push(error);
        },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });
    const socket = sockets[0]!;

    socket.emitOpen();
    socket.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: "0xsubscription",
    });
    socket.emitMessage({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: "0xsubscription",
        result: "raw-secret-payload",
      },
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.message).not.toContain("private-secret");
    expect(errors[0]!.message).not.toContain(
      "raw-secret-payload",
    );

    subscription.close();
  });
});
