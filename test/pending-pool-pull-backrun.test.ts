import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
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

import { poolAbi } from "../src/abi.js";
import { loadConfig } from "../src/config.js";
import { FlashbotsRelay } from "../src/flashbots.js";
import {
  executePendingPoolPullBackrun,
  pendingPoolPullGasUsed,
} from "../src/pending-pool-pull-backrun.js";
import { SignerSubmissionCoordinator } from "../src/signer-coordinator.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pending pool pull prerequisite backrun", () => {
  it("prices only the keeper pull at simulation index one", () => {
    expect(
      pendingPoolPullGasUsed({
        simulation: {
          results: [
            { gasUsed: "117820" },
            { gasUsed: "401234" },
          ],
        },
      }),
    ).toBe(401_234n);
  });

  it("requires the ticket purchase and pull to both simulate", () => {
    expect(() =>
      pendingPoolPullGasUsed({
        simulation: {
          results: [
            { gasUsed: "117820" },
            {
              gasUsed: "401234",
              revert: "NotCovered",
            },
          ],
        },
      }),
    ).toThrow("did not simulate both transactions");
  });

  it("submits only the exact purchase-plus-pull pair and accounts only for the pull", async () => {
    const signer = privateKeyToAccount(
      `0x${"31".repeat(32)}`,
    );
    const buyer = privateKeyToAccount(
      `0x${"32".repeat(32)}`,
    );
    const relayAuth = privateKeyToAccount(
      `0x${"33".repeat(32)}`,
    );
    const pool =
      "0x3000000000000000000000000000000000000003";
    const roundId = 301n;
    const purchaseData = encodeFunctionData({
      abi: poolAbi,
      functionName: "buyIntoCurrentRound",
      args: [6, buyer.address],
    });
    const rawPurchase = await buyer.signTransaction({
      chainId: 1,
      type: "eip1559",
      to: pool,
      value: parseEther("0.03"),
      data: purchaseData,
      gas: 150_000n,
      maxFeePerGas: parseGwei("2"),
      maxPriorityFeePerGas: parseGwei("0.1"),
      nonce: 4,
    });
    const purchaseHash = keccak256(rawPurchase);
    const simulatedPullGas = 400_000n;
    const paidReward = parseEther("0.0012");
    const receiptGasPrice = parseGwei("1.2");
    const simulatedBundles: string[][] = [];
    const sentBundles: string[][] = [];
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
                  { gasUsed: "117820" },
                  {
                    gasUsed:
                      simulatedPullGas.toString(),
                  },
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
    const bountyTopics = encodeEventTopics({
      abi: poolAbi,
      eventName: "CrankBountyPaid",
      args: {
        roundId,
        cranker: signer.address,
      },
    });
    const bountyData = encodeAbiParameters(
      parseAbiParameters("uint256"),
      [paidReward],
    );
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
          if (functionName === "roundCount") {
            return roundId;
          }
          if (functionName === "ethPendingRound") {
            return 0n;
          }
          if (functionName === "getRound") {
            return {
              state: 1,
              crankBountyCap:
                parseEther("0.0015"),
              bountyTipWei: parseGwei("2"),
            };
          }
          throw new Error(
            `unexpected contract read ${functionName}`,
          );
        },
      ),
      getBalance: vi.fn(async () => parseEther("1")),
      getTransactionReceipt: vi.fn(
        async ({ hash }: { hash: `0x${string}` }) => ({
          transactionHash: hash,
          status: "success",
          blockNumber: 101n,
          gasUsed: simulatedPullGas,
          effectiveGasPrice: receiptGasPrice,
          logs: [
            {
              address: pool,
              topics: bountyTopics,
              data: bountyData,
            },
          ],
        }),
      ),
    };
    const pendingClient = {
      getTransaction: vi.fn(async () => ({
        blockNumber: null,
      })),
      getRawTransaction: vi.fn(
        async () => rawPurchase,
      ),
    };
    const coordinator =
      new SignerSubmissionCoordinator();
    const relay = new FlashbotsRelay({
      url: "https://relay.example",
      authAccount: relayAuth,
      timeoutMs: 1_000,
    });

    const result = await executePendingPoolPullBackrun({
      publicClient: publicClient as never,
      pendingClient: pendingClient as never,
      signer,
      prerequisite: {
        action: "pool_ticket_purchase",
        purchaseFunction: "buyIntoCurrentRound",
        rawTransaction: rawPurchase,
        hash: purchaseHash,
        sender: buyer.address,
        nonce: 4,
        chainId: 1,
        type: "eip1559",
        target: pool,
        value: parseEther("0.03"),
        tickets: 6,
        recipient: buyer.address,
      },
      relays: [relay],
      builders: [],
      config: {
        ...loadConfig(),
        minProfitWei: 1n,
        maxFeePerGas: parseGwei("5"),
        poolMinPriorityFeePerGas: 0n,
        poolPullBountyEstimateBps: 10_000n,
      },
      builderBidBps: 1_000n,
      coordinator,
      assertSignerLeaseHeld: vi.fn(
        async () => undefined,
      ),
      isPrerequisiteCurrent: () => true,
      waitForTargetBlock: vi.fn(async () => true),
    });

    expect(result.status).toBe("confirmed");
    expect(result.realizedProfitWei).toBe(
      paidReward -
        simulatedPullGas * receiptGasPrice,
    );
    expect(simulatedBundles.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      simulatedBundles.every(
        (transactions) =>
          transactions.length === 2 &&
          transactions[0] === rawPurchase,
      ),
    ).toBe(true);
    expect(sentBundles).toHaveLength(1);
    expect(sentBundles[0]).toHaveLength(2);
    expect(sentBundles[0]?.[0]).toBe(rawPurchase);
    expect(
      coordinator.reservationFor(101n)?.lane,
    ).toBe("pending_pool_pull_backrun");
  });
});
