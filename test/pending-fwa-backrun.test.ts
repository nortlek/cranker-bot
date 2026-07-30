import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseEther,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { poolAbi } from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import { FlashbotsRelay } from "../src/flashbots.js";
import {
  setLogSink,
  type LogEntry,
} from "../src/format.js";
import {
  executePendingFwaBackrun,
  pendingFwaLifecycleGasUsed,
} from "../src/pending-fwa-backrun.js";
import { SignerSubmissionCoordinator } from "../src/signer-coordinator.js";

afterEach(() => {
  setLogSink(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pending FWA fulfillment backrun", () => {
  it("prices only sync and settle after the public prerequisite", () => {
    expect(
      pendingFwaLifecycleGasUsed({
        prerequisiteCount: 3,
        simulation: {
          results: [
            { gasUsed: "617575" },
            { gasUsed: "510000" },
            { gasUsed: "530000" },
            { gasUsed: "220000" },
            { gasUsed: "180000" },
          ],
        },
      }),
    ).toEqual([220_000n, 180_000n]);
  });

  it("requires fulfillment, sync, and settle to all simulate", () => {
    expect(() =>
      pendingFwaLifecycleGasUsed({
        prerequisiteCount: 1,
        simulation: {
          results: [
            { gasUsed: "617575" },
            { gasUsed: "220000" },
            { gasUsed: "180000", revert: "WrongState" },
          ],
        },
      }),
    ).toThrow("did not all simulate");
  });

  it("submits the full contiguous prerequisite prefix and accounts both keeper receipts", async () => {
    const signer = privateKeyToAccount(
      `0x${"51".repeat(32)}`,
    );
    const oracle = privateKeyToAccount(
      `0x${"52".repeat(32)}`,
    );
    const relayAuth = privateKeyToAccount(
      `0x${"53".repeat(32)}`,
    );
    const pool =
      "0x3000000000000000000000000000000000000003";
    const fwa =
      "0x4000000000000000000000000000000000000004";
    const coordinatorAddress =
      "0x5000000000000000000000000000000000000005";
    const roundId = 355n;
    const requestId = 123456789n;
    const rawPrerequisites = await Promise.all(
      [2, 3, 4].map((nonce) =>
        oracle.signTransaction({
          chainId: 1,
          type: "eip1559",
          to: coordinatorAddress,
          value: 0n,
          data: "0x301f42e9",
          gas: 1_000_000n,
          maxFeePerGas: parseGwei("2"),
          maxPriorityFeePerGas: parseGwei("0.1"),
          nonce,
        }),
      ),
    );
    const rawFulfillment = rawPrerequisites[2]!;
    const prerequisiteHash = keccak256(rawFulfillment);
    const syncGas = 220_000n;
    const settleGas = 180_000n;
    const syncReward = parseEther("0.00025");
    const settleReward = parseEther("0.00059");
    const receiptGasPrice = parseGwei("1.2");
    const simulatedBundles: string[][] = [];
    const sentBundles: string[][] = [];
    const loggedEntries: LogEntry[] = [];
    setLogSink((entry) => loggedEntries.push(entry));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
          params: [{ txs: string[] }];
        };
        if (body.method === "eth_callBundle") {
          simulatedBundles.push(body.params[0].txs);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                results: [
                  { gasUsed: "617575" },
                  { gasUsed: "510000" },
                  { gasUsed: "530000" },
                  { gasUsed: syncGas.toString() },
                  { gasUsed: settleGas.toString() },
                ],
              },
            }),
            { status: 200 },
          );
        }
        sentBundles.push(body.params[0].txs);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              bundleHash: `0x${"ab".repeat(32)}`,
            },
          }),
          { status: 200 },
        );
      }),
    );
    const bountyTopics = encodeEventTopics({
      abi: poolAbi,
      eventName: "CrankBountyPaid",
      args: {
        roundId,
        cranker: signer.address,
      },
    });
    const receiptIndex = { value: 0 };
    const publicClient = {
      getBlockNumber: vi.fn(async () => 100n),
      getTransactionCount: vi.fn(async () => 7),
      getBlock: vi.fn(async () => ({
        baseFeePerGas: parseGwei("1"),
        gasUsed: 30_000_000n,
        gasLimit: 60_000_000n,
      })),
      readContract: vi.fn(
        async ({
          functionName,
        }: {
          functionName: string;
        }) => {
          if (functionName === "ethPendingRound") {
            return roundId;
          }
          if (functionName === "getRound") {
            return {
              state: 2,
              fwaResolved: false,
              fwaRequestId: requestId,
              crankBountyCap:
                parseEther("0.0015"),
              bountyTipWei: parseGwei("2"),
            };
          }
          if (functionName === "acquisitions") {
            return [pool, 99n, 0n, 0n, 1];
          }
          throw new Error(
            `unexpected contract read ${functionName}`,
          );
        },
      ),
      getBalance: vi.fn(async () => parseEther("1")),
      getTransactionReceipt: vi.fn(async () => {
        const index = receiptIndex.value;
        receiptIndex.value += 1;
        const reward = index === 0 ? syncReward : settleReward;
        const gasUsed = index === 0 ? syncGas : settleGas;
        return {
          status: "success",
          blockNumber: 101n,
          gasUsed,
          effectiveGasPrice: receiptGasPrice,
          logs: [
            {
              address: pool,
              topics: bountyTopics,
              data: encodeAbiParameters(
                [{ type: "uint256" }],
                [reward],
              ),
            },
          ],
        };
      }),
    };
    const rawByHash = new Map(
      rawPrerequisites.map((rawTransaction) => [
        keccak256(rawTransaction).toLowerCase(),
        rawTransaction,
      ]),
    );
    const pendingClient = {
      getTransaction: vi.fn(async () => ({
        blockNumber: null,
      })),
      getRawTransaction: vi.fn(
        async ({ hash }: { hash: `0x${string}` }) =>
          rawByHash.get(hash.toLowerCase()),
      ),
    };
    const signerCoordinator =
      new SignerSubmissionCoordinator();
    const relay = new FlashbotsRelay({
      url: "https://relay.example",
      authAccount: relayAuth,
      timeoutMs: 1_000,
    });

    const result = await executePendingFwaBackrun({
      publicClient: publicClient as never,
      pendingClient: pendingClient as never,
      signer,
      prerequisite: {
        rawTransaction: rawFulfillment,
        hash: prerequisiteHash,
        sender: oracle.address,
        nonce: 4,
        chainId: 1,
        type: "eip1559",
        coordinator: coordinatorAddress,
        value: 0n,
        requestId,
        consumer: fwa,
        subId: 8n,
        prerequisiteTransactions: [
          {
            rawTransaction: rawPrerequisites[0]!,
            hash: keccak256(rawPrerequisites[0]!),
            sender: oracle.address,
            nonce: 2,
          },
          {
            rawTransaction: rawPrerequisites[1]!,
            hash: keccak256(rawPrerequisites[1]!),
            sender: oracle.address,
            nonce: 3,
          },
          {
            rawTransaction: rawFulfillment,
            hash: prerequisiteHash,
            sender: oracle.address,
            nonce: 4,
          },
        ],
      },
      pool,
      fwa,
      relays: [relay],
      builders: [],
      config: {
        ...loadConfig(),
        minProfitWei: 1n,
        maxFeePerGas: parseGwei("5"),
        poolMinPriorityFeePerGas: 0n,
        poolBountyEstimateBps: 10_000n,
      },
      builderBidBps: 300n,
      coordinator: signerCoordinator,
      assertSignerLeaseHeld: vi.fn(
        async () => undefined,
      ),
      isPrerequisiteCurrent: () => true,
      waitForTargetBlock: vi.fn(async () => true),
      readBeforeTargetBlock: async ({ read }) => ({
        status: "ready",
        value: await read(),
      }),
    });

    expect(result.status).toBe("confirmed");
    expect(result.realizedProfitWei).toBe(
      syncReward +
        settleReward -
        (syncGas + settleGas) * receiptGasPrice,
    );
    expect(simulatedBundles.length).toBeGreaterThanOrEqual(2);
    expect(
      simulatedBundles.every(
        (transactions) =>
          transactions.length === 5 &&
          transactions
            .slice(0, 3)
            .every(
              (transaction, index) =>
                transaction === rawPrerequisites[index],
            ),
      ),
    ).toBe(true);
    expect(sentBundles).toHaveLength(1);
    expect(sentBundles[0]).toHaveLength(5);
    expect(sentBundles[0]?.slice(0, 3)).toEqual(
      rawPrerequisites,
    );
    expect(
      loggedEntries.find(
        (entry) => entry.event === "keeper_batch_result",
      ),
    ).toMatchObject({
      transactionCount: 2,
      confirmedTransactions: 2,
      revertedTransactions: 0,
      expiredTransactions: 0,
      totalTransactionValue: "0 ETH",
      kind: "pending_fwa_fulfillment_backrun",
    });
    expect(
      signerCoordinator.reservationFor(101n)?.lane,
    ).toBe("pending_fwa_fulfillment_backrun");
  });
});
