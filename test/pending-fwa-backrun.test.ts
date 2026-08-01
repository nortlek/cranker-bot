import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
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

import { fwaAbi, poolAbi } from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import { FlashbotsRelay } from "../src/flashbots.js";
import {
  setLogSink,
  type LogEntry,
} from "../src/format.js";
import {
  executePendingFwaBackrun,
  executePendingFwaBackrunWithRetargets,
  pendingFwaLifecycleGasUsed,
  type PendingFwaBackrunResult,
} from "../src/pending-fwa-backrun.js";
import { SignerSubmissionCoordinator } from "../src/signer-coordinator.js";

afterEach(() => {
  setLogSink(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pending FWA fulfillment backrun", () => {
  it("retargets a still-pending prerequisite after its first target arrives", async () => {
    const prerequisiteHash =
      `0x${"91".repeat(32)}` as const;
    const executions: PendingFwaBackrunResult[] = [
      {
        status: "skipped",
        reason: "target_block_arrived",
        targetBlock: 101n,
      },
      {
        status: "confirmed",
        reason: "confirmed",
        targetBlock: 102n,
        realizedProfitWei: 1n,
      },
    ];
    const execute = vi.fn(async () => executions.shift()!);
    const heads = [100n, 101n];
    const loggedEntries: LogEntry[] = [];
    setLogSink((entry) => loggedEntries.push(entry));

    const result =
      await executePendingFwaBackrunWithRetargets({
        execute,
        getAuthoritativeHead: () => heads.shift()!,
        isPrerequisiteCurrent: () => true,
        isPrerequisitePending: vi.fn(async () => true),
        prerequisiteHash,
        requestId: 77n,
      });

    expect(result).toEqual({
      status: "confirmed",
      reason: "confirmed",
      targetBlock: 102n,
      realizedProfitWei: 1n,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, 100n);
    expect(execute).toHaveBeenNthCalledWith(2, 101n);
    expect(
      loggedEntries.find(
        (entry) =>
          entry.event ===
          "pending_fwa_backrun_retargeted",
      ),
    ).toMatchObject({
      prerequisiteHash,
      requestId: "77",
      completedTargetBlock: "101",
      nextTargetAttempt: 2,
      maximumTargetAttempts: 3,
      reason: "prerequisite_still_pending",
      retargetParentBlock: "101",
      nextTargetBlock: "102",
    });
  });

  it("does not retarget a prerequisite mined in the completed target", async () => {
    const execute = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "target_block_arrived",
      targetBlock: 101n,
    }));
    const isPrerequisitePending = vi.fn(
      async () => false,
    );

    const result =
      await executePendingFwaBackrunWithRetargets({
        execute,
        getAuthoritativeHead: () => 100n,
        isPrerequisiteCurrent: () => true,
        isPrerequisitePending,
        prerequisiteHash:
          `0x${"92".repeat(32)}`,
        requestId: 78n,
      });

    expect(result).toEqual({
      status: "skipped",
      reason: "target_block_arrived",
      targetBlock: 101n,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(isPrerequisitePending).toHaveBeenCalledOnce();
  });

  it("does not repeat an arrived target while the authoritative head is stale", async () => {
    const execute = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "target_block_arrived",
      targetBlock: 101n,
    }));
    const loggedEntries: LogEntry[] = [];
    setLogSink((entry) => loggedEntries.push(entry));

    const result =
      await executePendingFwaBackrunWithRetargets({
        execute,
        getAuthoritativeHead: () => 100n,
        isPrerequisiteCurrent: () => true,
        isPrerequisitePending: async () => true,
        prerequisiteHash:
          `0x${"93".repeat(32)}`,
        requestId: 79n,
      });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "target_block_arrived",
      targetBlock: 101n,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(
      loggedEntries.find(
        (entry) =>
          entry.event === "pending_fwa_retarget_gate_failed",
      ),
    ).toMatchObject({
      completedTargetBlock: "101",
      previousParentBlock: "100",
      authoritativeHead: "100",
      reason: "authoritative_head_not_advanced",
    });
  });

  it("prices only sync and settle after the public prerequisite", () => {
    expect(
      pendingFwaLifecycleGasUsed({
        prerequisiteCount: 3,
        includesProcessor: false,
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
    ).toEqual({
      sync: 220_000n,
      settle: 180_000n,
    });
  });

  it("requires fulfillment, sync, and settle to all simulate", () => {
    expect(() =>
      pendingFwaLifecycleGasUsed({
        prerequisiteCount: 1,
        includesProcessor: false,
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

  it("extracts processor, sync, and settle gas after the public prefix", () => {
    expect(
      pendingFwaLifecycleGasUsed({
        prerequisiteCount: 3,
        includesProcessor: true,
        simulation: {
          results: [
            { gasUsed: "617575" },
            { gasUsed: "510000" },
            { gasUsed: "530000" },
            { gasUsed: "450000" },
            { gasUsed: "220000" },
            { gasUsed: "180000" },
          ],
        },
      }),
    ).toEqual({
      process: 450_000n,
      sync: 220_000n,
      settle: 180_000n,
    });
  });

  it.each([
    {
      selectedVariant: "processor",
      directReverts: true,
    },
    {
      selectedVariant: "direct",
      directReverts: false,
    },
  ] as const)(
    "submits the profitable $selectedVariant variant with the full contiguous prerequisite prefix",
    async ({ selectedVariant, directReverts }) => {
      const processorSelected =
        selectedVariant === "processor";
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
      const processGas = 450_000n;
      const syncGas = 220_000n;
      const settleGas = 180_000n;
      const syncReward = parseEther("0.00025");
      const settleReward = parseEther("0.00059");
      const receiptGasPrice = parseGwei("1.2");
      const simulatedBundles: string[][] = [];
      const sentBundles: string[][] = [];
      const loggedEntries: LogEntry[] = [];
      let injectedBaseFeeSkew = false;
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
            if (!injectedBaseFeeSkew) {
              injectedBaseFeeSkew = true;
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  error: {
                    code: -32000,
                    message:
                      "max fee per gas less than block base fee",
                  },
                }),
                { status: 200 },
              );
            }
            const includesProcessor =
              body.params[0].txs.length === 6;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  results: includesProcessor
                    ? [
                        { gasUsed: "617575" },
                        { gasUsed: "510000" },
                        { gasUsed: "530000" },
                        { gasUsed: processGas.toString() },
                        { gasUsed: syncGas.toString() },
                        { gasUsed: settleGas.toString() },
                      ]
                    : [
                        { gasUsed: "617575" },
                        { gasUsed: "510000" },
                        { gasUsed: "530000" },
                        directReverts
                          ? {
                              gasUsed: syncGas.toString(),
                              revert: "WrongState",
                            }
                          : { gasUsed: syncGas.toString() },
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
            if (functionName === "nextSequenceToProcess") {
              return 10n;
            }
            if (functionName === "lastIssuedSequence") {
              return 11n;
            }
            throw new Error(
              `unexpected contract read ${functionName}`,
            );
          },
        ),
        multicall: vi.fn(async () => [987654321n, requestId]),
        getBalance: vi.fn(async () => parseEther("1")),
        getTransactionReceipt: vi.fn(async () => {
          const index = receiptIndex.value;
          receiptIndex.value += 1;
          const reward =
            processorSelected && index === 0
              ? 0n
              : index === (processorSelected ? 1 : 0)
                ? syncReward
                : settleReward;
          const gasUsed =
            processorSelected && index === 0
              ? processGas
              : index === (processorSelected ? 1 : 0)
                ? syncGas
                : settleGas;
          return {
            status: "success",
            blockNumber: 101n,
            gasUsed,
            effectiveGasPrice: receiptGasPrice,
            logs:
              reward === 0n
                ? []
                : [
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
        headBlockNumber: 100n,
        targetBlockHasArrived: () => false,
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
          ((processorSelected ? processGas : 0n) +
            syncGas +
            settleGas) *
            receiptGasPrice,
      );
      expect(simulatedBundles.length).toBeGreaterThanOrEqual(2);
      expect(
        simulatedBundles.every(
          (transactions) =>
            transactions
              .slice(0, 3)
              .every(
                (transaction, index) =>
                  transaction === rawPrerequisites[index],
              ),
        ),
      ).toBe(true);
      expect(
        simulatedBundles.some(
          (transactions) => transactions.length === 5,
        ),
      ).toBe(true);
      expect(
        simulatedBundles.some(
          (transactions) => transactions.length === 6,
        ),
      ).toBe(true);
      expect(sentBundles).toHaveLength(1);
      expect(sentBundles[0]).toHaveLength(
        processorSelected ? 6 : 5,
      );
      expect(sentBundles[0]?.slice(0, 3)).toEqual(
        rawPrerequisites,
      );
      if (processorSelected) {
        const signedProcess = parseTransaction(
          sentBundles[0]![3]! as `0x${string}`,
        );
        expect(
          decodeFunctionData({
            abi: fwaAbi,
            data: signedProcess.data!,
          }),
        ).toEqual({
          functionName: "processAcquisitions",
          args: [2n],
        });
      }
      expect(
        loggedEntries.find(
          (entry) =>
            entry.event ===
            "pending_fwa_simulation_availability_waited",
        ),
      ).toMatchObject({
        reason: "relay_future_base_fee_publication_skew",
        attempts: 2,
      });
      expect(
        loggedEntries.find(
          (entry) => entry.event === "keeper_batch_result",
        ),
      ).toMatchObject({
        transactionCount: processorSelected ? 3 : 2,
        confirmedTransactions: processorSelected ? 3 : 2,
        revertedTransactions: 0,
        expiredTransactions: 0,
        totalTransactionValue: "0 ETH",
        kind: "pending_fwa_fulfillment_backrun",
      });
      expect(
        signerCoordinator.reservationFor(101n)?.lane,
      ).toBe("pending_fwa_fulfillment_backrun");
    },
  );
});
