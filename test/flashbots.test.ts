import { createServer } from "node:http";

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  FlashbotsRelay,
  simulateLongestValidBundlePrefix,
  simulatedGasUsed,
  submitBundlePrefixLadder,
  successfulPrefixLength,
  validateDirectCoinbasePaymentSimulation,
  validateEmbeddedCoinbasePaymentSimulation,
} from "../src/flashbots.js";

describe("successfulPrefixLength", () => {
  it("keeps a completely successful ordered bundle", () => {
    expect(
      successfulPrefixLength(
        { results: [{ txHash: `0x${"01".repeat(32)}` }, {}] },
        2,
      ),
    ).toBe(2);
  });

  it("cuts the bundle before the first reverting nonce", () => {
    expect(
      successfulPrefixLength(
        {
          results: [
            {},
            { revert: "0x0b3465c2" },
            {},
          ],
        },
        3,
      ),
    ).toBe(1);
  });

  it("rejects incomplete simulation output", () => {
    expect(() => successfulPrefixLength({ results: [{}] }, 2)).toThrow(
      "incomplete result set",
    );
  });
});

describe("simulatedGasUsed", () => {
  it("extracts gas from a successful ordered simulation", () => {
    expect(
      simulatedGasUsed(
        {
          results: [
            { gasUsed: 348_298 },
            { gasUsed: "191959" },
          ],
        },
        2,
      ),
    ).toEqual([348_298n, 191_959n]);
  });
});

describe("validateDirectCoinbasePaymentSimulation", () => {
  it("requires exact aggregate and helper coinbase accounting", () => {
    expect(
      validateDirectCoinbasePaymentSimulation({
        result: {
          coinbaseDiff: "243",
          results: [
            { gasUsed: 100, ethSentToCoinbase: "0" },
            { gasUsed: 30, ethSentToCoinbase: "143" },
          ],
        },
        transactionCount: 2,
        helperIndex: 1,
        expectedTotalCoinbasePayment: 243n,
        expectedDirectCoinbasePayment: 143n,
      }),
    ).toEqual({
      totalCoinbasePayment: 243n,
      directCoinbasePayment: 143n,
    });
  });

  it("rejects a helper simulation without exact payment fields", () => {
    expect(() =>
      validateDirectCoinbasePaymentSimulation({
        result: { coinbaseDiff: "243", results: [{ gasUsed: 30 }] },
        transactionCount: 1,
        helperIndex: 0,
        expectedTotalCoinbasePayment: 243n,
        expectedDirectCoinbasePayment: 143n,
      }),
    ).toThrow("omitted coinbase accounting");
  });
});

describe("validateEmbeddedCoinbasePaymentSimulation", () => {
  it("requires exact aggregate and in-transaction coinbase accounting", () => {
    expect(
      validateEmbeddedCoinbasePaymentSimulation({
        result: {
          coinbaseDiff: "243",
          results: [
            { gasUsed: 100, ethSentToCoinbase: "0" },
            { gasUsed: 300, ethSentToCoinbase: "143" },
          ],
        },
        transactionCount: 2,
        paymentIndex: 1,
        expectedTotalCoinbasePayment: 243n,
        expectedEmbeddedCoinbasePayment: 143n,
      }),
    ).toEqual({
      totalCoinbasePayment: 243n,
      embeddedCoinbasePayment: 143n,
    });
  });

  it("rejects a mismatch between the contract payment and simulation", () => {
    expect(() =>
      validateEmbeddedCoinbasePaymentSimulation({
        result: {
          coinbaseDiff: "143",
          results: [
            { gasUsed: 300, ethSentToCoinbase: "142" },
          ],
        },
        transactionCount: 1,
        paymentIndex: 0,
        expectedTotalCoinbasePayment: 143n,
        expectedEmbeddedCoinbasePayment: 143n,
      }),
    ).toThrow("reported direct payment 142, expected 143");
  });
});

describe("simulateLongestValidBundlePrefix", () => {
  it("returns the successful full simulation without calling the relay twice", async () => {
    let calls = 0;
    const simulation = {
      results: [{ gasUsed: 100_000 }, { gasUsed: 200_000 }],
    };
    const relay = {
      callBundle: async () => {
        calls += 1;
        return simulation;
      },
    } as unknown as FlashbotsRelay;

    const result = await simulateLongestValidBundlePrefix(
      relay,
      ["0x01", "0x02"],
      42n,
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      prefixLength: 2,
      simulation,
    });
  });

  it("confirms and returns the longest successful prefix", async () => {
    const transactionCounts: number[] = [];
    const relay = {
      callBundle: async (transactions: readonly string[]) => {
        transactionCounts.push(transactions.length);
        return transactions.length === 3
          ? {
              results: [
                { gasUsed: 100_000 },
                { gasUsed: 200_000 },
                { revert: "stale suffix" },
              ],
            }
          : {
              results: [
                { gasUsed: 100_000 },
                { gasUsed: 200_000 },
              ],
            };
      },
    } as unknown as FlashbotsRelay;

    const result = await simulateLongestValidBundlePrefix(
      relay,
      ["0x01", "0x02", "0x03"],
      42n,
    );

    expect(transactionCounts).toEqual([3, 2]);
    expect(result.prefixLength).toBe(2);
    expect(simulatedGasUsed(result.simulation!, 2)).toEqual([
      100_000n,
      200_000n,
    ]);
  });
});

describe("FlashbotsRelay", () => {
  it("sends an authenticated, multiplexed bundle request", async () => {
    let receivedBody = "";
    let receivedSignature = "";
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        const signatureHeader =
          request.headers["x-flashbots-signature"];
        receivedSignature = Array.isArray(signatureHeader)
          ? (signatureHeader[0] ?? "")
          : (signatureHeader ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              bundleHash: `0x${"ab".repeat(32)}`,
              smart: "true",
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      const authAccount = privateKeyToAccount(
        `0x${"01".repeat(32)}`,
      );
      const relay = new FlashbotsRelay({
        url: `http://127.0.0.1:${address.port}`,
        authAccount,
        timeoutMs: 1_000,
      });

      const result = await relay.sendBundle(
        ["0x01"],
        42n,
        ["flashbots", "builder0x69"],
      );

      expect(result.bundleHash).toBe(`0x${"ab".repeat(32)}`);
      expect(receivedSignature).toMatch(
        new RegExp(`^${authAccount.address}:0x[0-9a-f]{130}$`, "i"),
      );
      expect(JSON.parse(receivedBody)).toMatchObject({
        method: "eth_sendBundle",
        params: [
          {
            txs: ["0x01"],
            blockNumber: "0x2a",
            builders: ["flashbots", "builder0x69"],
          },
        ],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });
});

describe("submitBundlePrefixLadder", () => {
  it("submits each contiguous nonce prefix", async () => {
    const calls: number[] = [];
    const relay = {
      url: "https://relay.example",
      sendBundle: async (transactions: readonly string[]) => {
        calls.push(transactions.length);
        return {
          bundleHash: `0x${transactions.length
            .toString(16)
            .padStart(64, "0")}`,
          smart: "true",
        };
      },
    } as unknown as FlashbotsRelay;

    const submissions = await submitBundlePrefixLadder(
      [relay],
      ["0x01", "0x02", "0x03"],
      42n,
      ["flashbots"],
    );

    expect(calls).toEqual([1, 2, 3]);
    expect(
      submissions.map((submission) => submission.transactionCount),
    ).toEqual([1, 2, 3]);
    expect(submissions.every((submission) => submission.smart)).toBe(
      true,
    );
  });

  it("does not submit prefixes below a dependency floor", async () => {
    const calls: number[] = [];
    const relay = {
      url: "https://relay.example",
      sendBundle: async (transactions: readonly string[]) => {
        calls.push(transactions.length);
        return {
          bundleHash: `0x${transactions.length
            .toString(16)
            .padStart(64, "0")}`,
          smart: true,
        };
      },
    } as unknown as FlashbotsRelay;

    await submitBundlePrefixLadder(
      [relay],
      ["0x01", "0x02", "0x03"],
      42n,
      ["flashbots"],
      3,
    );

    expect(calls).toEqual([3]);
  });

  it("submits lifecycle-safe prefixes and same-nonce funding supersets together", async () => {
    const recorded: string[][] = [];
    const relay = {
      url: "https://relay.example",
      sendBundle: async (transactions: readonly string[]) => {
        recorded.push([...transactions]);
        return {
          bundleHash: `0x${transactions.length
            .toString(16)
            .padStart(64, "0")}`,
          smart: true,
        };
      },
    } as unknown as FlashbotsRelay;
    const transactions = [
      "0x01", // process
      "0x02", // sync: base dependency floor
      "0x03", // settle
      "0x04", // funding crank
      "0x05", // covered pull
    ] as const;

    await submitBundlePrefixLadder(
      [relay],
      transactions,
      42n,
      ["flashbots"],
      2,
    );

    expect(recorded).toEqual([
      transactions.slice(0, 2),
      transactions.slice(0, 3),
      transactions.slice(0, 4),
      transactions.slice(0, 5),
    ]);
    expect(recorded.every((bundle) => bundle[0] === "0x01")).toBe(
      true,
    );
    expect(recorded.every((bundle) => bundle[1] === "0x02")).toBe(
      true,
    );
  });

  it("reports every relay-prefix attempt without affecting delivery", async () => {
    const attempts: Array<{
      relayIndex: number;
      transactionCount: number;
      status: string;
    }> = [];
    const acceptedRelay = {
      url: "https://accepted.example",
      sendBundle: async (transactions: readonly string[]) => ({
        bundleHash: `0x${transactions.length
          .toString(16)
          .padStart(64, "0")}`,
        smart: true,
      }),
    } as unknown as FlashbotsRelay;
    const rejectedRelay = {
      url: "https://rejected.example",
      sendBundle: async () => {
        throw new Error("relay rejected");
      },
    } as unknown as FlashbotsRelay;

    const submissions = await submitBundlePrefixLadder(
      [acceptedRelay, rejectedRelay],
      ["0x01", "0x02"],
      42n,
      [],
      1,
      (attempt) => {
        attempts.push({
          relayIndex: attempt.relayIndex,
          transactionCount: attempt.transactionCount,
          status: attempt.status,
        });
      },
    );

    expect(submissions).toHaveLength(2);
    expect(attempts).toEqual(
      expect.arrayContaining([
        { relayIndex: 0, transactionCount: 1, status: "accepted" },
        { relayIndex: 0, transactionCount: 2, status: "accepted" },
        { relayIndex: 1, transactionCount: 1, status: "rejected" },
        { relayIndex: 1, transactionCount: 2, status: "rejected" },
      ]),
    );
  });
});
