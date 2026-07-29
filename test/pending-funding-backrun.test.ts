import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbiParameters,
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

import { standingOrderAbi } from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import { FlashbotsRelay } from "../src/flashbots.js";
import {
  executePendingFundingBackrun,
  pendingFundingBundleTransactions,
  pendingFundingCrankGasUsed,
  receiptSucceededInTarget,
  shouldObservePendingFundingMiss,
} from "../src/pending-funding-backrun.js";
import {
  PendingFundingExecutionController,
  SignerSubmissionCoordinator,
} from "../src/signer-coordinator.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pending funding prerequisite-bundle accounting", () => {
  it("prices only the keeper crank at simulation index one", () => {
    const gas = pendingFundingCrankGasUsed({
      simulation: {
        results: [
          { gasUsed: "21000" },
          { gasUsed: "230351" },
        ],
      },
    });

    expect(gas).toBe(230_351n);
  });

  it("requires the full funding plus crank dependency", () => {
    expect(() =>
      pendingFundingCrankGasUsed({
        simulation: {
          results: [
            { gasUsed: "21000" },
            {
              gasUsed: "230351",
              revert: "InsufficientBalance",
            },
          ],
        },
      }),
    ).toThrow("did not simulate both transactions");
  });

  it("does not accept incomplete simulation results", () => {
    expect(() =>
      pendingFundingCrankGasUsed({
        simulation: {
          results: [{ gasUsed: "21000" }],
        },
      }),
    ).toThrow("incomplete result set");
  });

  it("always constructs the funding and crank as one exact pair", () => {
    expect(
      pendingFundingBundleTransactions("0x01", "0x02"),
    ).toEqual(["0x01", "0x02"]);
    expect(() =>
      pendingFundingBundleTransactions("0x01", "0x"),
    ).toThrow("cannot be empty");
  });

  it("records a bid miss only when funding landed and a competitor cranked", () => {
    expect(
      shouldObservePendingFundingMiss({
        prerequisiteIncluded: true,
        competitorCranked: true,
      }),
    ).toBe(true);
    expect(
      shouldObservePendingFundingMiss({
        prerequisiteIncluded: false,
        competitorCranked: true,
      }),
    ).toBe(false);
    expect(
      shouldObservePendingFundingMiss({
        prerequisiteIncluded: true,
        competitorCranked: false,
      }),
    ).toBe(false);
  });

  it("attributes inclusion only to a successful receipt in the exact target", () => {
    expect(
      receiptSucceededInTarget({
        status: "success",
        blockNumber: 101n,
        targetBlock: 101n,
      }),
    ).toBe(true);
    expect(
      receiptSucceededInTarget({
        status: "reverted",
        blockNumber: 101n,
        targetBlock: 101n,
      }),
    ).toBe(false);
    expect(
      receiptSucceededInTarget({
        status: "success",
        blockNumber: 102n,
        targetBlock: 101n,
      }),
    ).toBe(false);
  });

  it("simulates and submits only the full pair while accounting only for our crank", async () => {
    const signer = privateKeyToAccount(
      `0x${"01".padStart(64, "0")}`,
    );
    const funder = privateKeyToAccount(
      `0x${"02".padStart(64, "0")}`,
    );
    const relayAuth = privateKeyToAccount(
      `0x${"03".padStart(64, "0")}`,
    );
    const order =
      "0x0000000000000000000000000000000000000010";
    const rawFunding = await funder.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: order,
      value: parseEther("0.1"),
      gas: 21_000n,
      maxFeePerGas: parseGwei("2"),
      maxPriorityFeePerGas: parseGwei("0.1"),
      nonce: 4,
    });
    const fundingHash = keccak256(rawFunding);
    const crankFee = parseEther("0.0025");
    const simulatedCrankGas = 200_000n;
    const receiptGasPrice = parseGwei("2");
    const sentBundles: string[][] = [];
    const simulatedBundles: string[][] = [];
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
                  { gasUsed: "10000000" },
                  { gasUsed: simulatedCrankGas.toString() },
                ],
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
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
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }),
    );
    const crankedTopics = encodeEventTopics({
      abi: standingOrderAbi,
      eventName: "Cranked",
      args: {
        roundId: 286n,
        caller: signer.address,
      },
    });
    const crankedData = encodeAbiParameters(
      parseAbiParameters("uint32,uint256,uint256"),
      [1, parseEther("0.09"), crankFee],
    );
    const publicClient = {
      getBlockNumber: vi.fn(async () => 100n),
      getTransactionCount: vi.fn(async () => 7),
      estimateFeesPerGas: vi.fn(async () => ({
        maxFeePerGas: parseGwei("1"),
        maxPriorityFeePerGas: 0n,
      })),
      readContract: vi.fn(async () => crankFee),
      getBalance: vi.fn(async () => parseEther("1")),
      getTransactionReceipt: vi.fn(
        async ({ hash }: { hash: `0x${string}` }) => ({
          transactionHash: hash,
          status: "success",
          blockNumber: 101n,
          gasUsed: simulatedCrankGas,
          effectiveGasPrice: receiptGasPrice,
          logs: [
            {
              address: order,
              topics: crankedTopics,
              data: crankedData,
            },
          ],
        }),
      ),
    };
    const pendingClient = {
      getTransaction: vi.fn(async () => ({
        blockNumber: null,
      })),
      getRawTransaction: vi.fn(async () => rawFunding),
    };
    const observed: unknown[] = [];
    const coordinator = new SignerSubmissionCoordinator();
    const relay = new FlashbotsRelay({
      url: "https://relay.example",
      authAccount: relayAuth,
      timeoutMs: 1_000,
    });

    const result = await executePendingFundingBackrun({
      publicClient: publicClient as never,
      pendingClient: pendingClient as never,
      signer,
      prerequisite: {
        rawTransaction: rawFunding,
        hash: fundingHash,
        sender: funder.address,
        nonce: 4,
        chainId: 1,
        type: "eip1559",
        target: order,
        value: parseEther("0.1"),
      },
      relays: [relay],
      builders: [],
      config: {
        ...loadConfig(),
        minPriorityFeePerGas: 0n,
        minProfitWei: 1n,
        maxFeePerGas: parseGwei("5"),
      },
      builderBidBps: 1_000n,
      coordinator,
      assertSignerLeaseHeld: vi.fn(async () => undefined),
      isPrerequisiteCurrent: () => true,
      waitForTargetBlock: vi.fn(async () => true),
      observePrivateBatch: vi.fn(async (outcome) => {
        observed.push(outcome);
      }),
    });

    expect(result.status).toBe("confirmed");
    expect(result.realizedProfitWei).toBe(
      crankFee - simulatedCrankGas * receiptGasPrice,
    );
    expect(simulatedBundles.length).toBeGreaterThanOrEqual(2);
    expect(
      simulatedBundles.every(
        (transactions) =>
          transactions.length === 2 &&
          transactions[0] === rawFunding,
      ),
    ).toBe(true);
    expect(sentBundles).toHaveLength(1);
    expect(sentBundles[0]).toHaveLength(2);
    expect(sentBundles[0]?.[0]).toBe(rawFunding);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      bidScope: "pending_funding_backrun",
    });
    expect(
      coordinator.reservationFor(101n)?.lane,
    ).toBe("pending_funding_backrun");
  });

  it("cannot touch a relay in dry-run mode", async () => {
    const signer = privateKeyToAccount(
      `0x${"04".padStart(64, "0")}`,
    );
    const relayAuth = privateKeyToAccount(
      `0x${"05".padStart(64, "0")}`,
    );
    const relay = new FlashbotsRelay({
      url: "https://relay.example",
      authAccount: relayAuth,
      timeoutMs: 1_000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executePendingFundingBackrun({
      publicClient: {} as never,
      pendingClient: {} as never,
      signer,
      prerequisite: {
        rawTransaction: "0x01",
        hash: `0x${"11".repeat(32)}`,
        sender: signer.address,
        nonce: 0,
        chainId: 1,
        type: "eip1559",
        target:
          "0x0000000000000000000000000000000000000010",
        value: 1n,
      },
      relays: [relay],
      builders: [],
      config: {
        ...loadConfig(),
        dryRun: true,
      },
      builderBidBps: 1_000n,
      coordinator: new SignerSubmissionCoordinator(),
      assertSignerLeaseHeld: vi.fn(async () => undefined),
      isPrerequisiteCurrent: () => true,
      waitForTargetBlock: vi.fn(async () => true),
      observePrivateBatch: undefined,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "dry_run",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drains an aborted simulation without submitting after shutdown", async () => {
    const signer = privateKeyToAccount(
      `0x${"06".padStart(64, "0")}`,
    );
    const funder = privateKeyToAccount(
      `0x${"07".padStart(64, "0")}`,
    );
    const relayAuth = privateKeyToAccount(
      `0x${"08".padStart(64, "0")}`,
    );
    const order =
      "0x0000000000000000000000000000000000000010";
    const rawFunding = await funder.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: order,
      value: parseEther("0.1"),
      gas: 21_000n,
      maxFeePerGas: parseGwei("2"),
      maxPriorityFeePerGas: parseGwei("0.1"),
      nonce: 5,
    });
    let releaseFirstSimulation:
      | (() => void)
      | undefined;
    const methods: string[] = [];
    let firstSimulation = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
        };
        methods.push(body.method);
        if (firstSimulation) {
          firstSimulation = false;
          await new Promise<void>((resolve) => {
            releaseFirstSimulation = resolve;
          });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              body.method === "eth_callBundle"
                ? {
                    results: [
                      { gasUsed: "21000" },
                      { gasUsed: "200000" },
                    ],
                  }
                : {
                    bundleHash: `0x${"ab".repeat(32)}`,
                  },
          }),
          { status: 200 },
        );
      }),
    );
    const relay = new FlashbotsRelay({
      url: "https://relay.example",
      authAccount: relayAuth,
      timeoutMs: 1_000,
    });
    const controller =
      new PendingFundingExecutionController();
    const execution = controller.start(async (signal) => {
      await executePendingFundingBackrun({
        publicClient: {
          getBlockNumber: vi.fn(async () => 100n),
          getTransactionCount: vi.fn(async () => 7),
          estimateFeesPerGas: vi.fn(async () => ({
            maxFeePerGas: parseGwei("1"),
            maxPriorityFeePerGas: 0n,
          })),
          readContract: vi.fn(
            async () => parseEther("0.0025"),
          ),
          getBalance: vi.fn(async () => parseEther("1")),
        } as never,
        pendingClient: {} as never,
        signer,
        prerequisite: {
          rawTransaction: rawFunding,
          hash: keccak256(rawFunding),
          sender: funder.address,
          nonce: 5,
          chainId: 1,
          type: "eip1559",
          target: order,
          value: parseEther("0.1"),
        },
        relays: [relay],
        builders: [],
        config: {
          ...loadConfig(),
          dryRun: false,
          minPriorityFeePerGas: 0n,
          minProfitWei: 1n,
          maxFeePerGas: parseGwei("5"),
        },
        builderBidBps: 1_000n,
        coordinator: new SignerSubmissionCoordinator(),
        assertSignerLeaseHeld: vi.fn(async () => undefined),
        isPrerequisiteCurrent: () => true,
        waitForTargetBlock: vi.fn(async () => true),
        observePrivateBatch: undefined,
        signal,
      });
    });

    await vi.waitFor(() =>
      expect(releaseFirstSimulation).toBeDefined(),
    );
    const drain = controller.stopAndDrain();
    releaseFirstSimulation?.();
    await drain;
    await execution;

    expect(methods).toContain("eth_callBundle");
    expect(methods).not.toContain("eth_sendBundle");
  });
});
