import { createServer } from "node:http";

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  FlashbotsRelay,
  simulatedGasUsed,
  submitBundlePrefixLadder,
  successfulPrefixLength,
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
});
