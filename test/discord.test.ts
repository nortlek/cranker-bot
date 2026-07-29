import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  buildDiscordEmbed,
  DiscordWebhookNotifier,
} from "../src/discord.js";

describe("buildDiscordEmbed", () => {
  it("ignores routine block-loop noise", () => {
    expect(
      buildDiscordEmbed(
        {
          time: "2026-07-28T00:00:00.000Z",
          level: "debug",
          event: "new_block",
          block: "123",
        },
        0n,
      ),
    ).toBeUndefined();
  });

  it("reports durable telemetry failures", () => {
    const embed = buildDiscordEmbed(
      {
        time: "2026-07-28T00:00:00.000Z",
        level: "warn",
        event: "telemetry_write_failed",
        reason: "database unavailable",
      },
      0n,
    );

    expect(embed?.title).toBe("Telemetry Write Failed");
    expect(embed?.color).toBe(0xe74c3c);
  });

  it("renders Stake DAO harvest opportunities with token economics", () => {
    const embed = buildDiscordEmbed(
      {
        time: "2026-07-28T00:00:00.000Z",
        level: "info",
        event: "stakedao_curve_opportunity",
        label: "stakedao_curve_harvest:3:0x1234",
        gaugeCount: "3",
        estimatedHarvesterFee: "1.5 CRV",
        conservativeReward: "0.0002 ETH",
        gasLimit: "1200000",
      },
      0n,
    );

    expect(embed?.title).toBe("Stake DAO Curve harvest found");
    expect(
      embed?.fields?.find((entry) => entry.name === "Caller fee")
        ?.value,
    ).toBe("1.5 CRV");
  });

  it("does not spam Discord for repeated FiRM planning opportunities", () => {
    const embed = buildDiscordEmbed(
      {
        time: "2026-07-28T00:00:00.000Z",
        level: "info",
        event: "firm_replenish_opportunity",
        market: "0xmarket",
        account: "0xborrower",
        fixedObservedDeficit: "0.5 DBR",
        deterministicReward: "0.027 DOLA",
        conservativeReward: "0.00001 ETH",
        estimatedGas: "215919",
      },
      0n,
    );

    expect(embed).toBeUndefined();
  });
});

describe("DiscordWebhookNotifier", () => {
  it("sends embeds and maintains cumulative realized P&L", async () => {
    const messages: unknown[] = [];
    const server = createServer((request, response) => {
      let source = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        source += chunk;
      });
      request.on("end", () => {
        messages.push(JSON.parse(source) as unknown);
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const notifier = new DiscordWebhookNotifier({
        url: `http://127.0.0.1:${address.port}/webhook`,
        timeoutMs: 2_000,
      });
      notifier.notify({
        time: "2026-07-28T00:00:00.000Z",
        level: "info",
        event: "keeper_receipt",
        kind: "pool_sync",
        label: "syncFwaResult:142",
        hash: `0x${"12".repeat(32)}`,
        block: "123",
        status: "success",
        gasUsed: "100000",
        paidReward: "0.0003 ETH",
        gasCost: "0.0001 ETH",
        realizedProfit: "0.0002 ETH",
      });
      notifier.notify({
        time: "2026-07-28T00:00:01.000Z",
        level: "info",
        event: "keeper_receipt",
        kind: "fwa_process",
        label: "fwa_process:1",
        hash: `0x${"34".repeat(32)}`,
        block: "124",
        status: "success",
        gasUsed: "100000",
        paidReward: "0 ETH",
        gasCost: "0.00005 ETH",
        realizedProfit: "-0.00005 ETH",
      });
      await notifier.flush();

      expect(messages).toHaveLength(2);
      const second = messages[1] as {
        allowed_mentions: { parse: unknown[] };
        embeds: Array<{
          color: number;
          fields: Array<{ name: string; value: string }>;
        }>;
      };
      expect(second.allowed_mentions.parse).toEqual([]);
      expect(
        second.embeds[0]?.fields.find(
          (entry) => entry.name === "Session realized P&L",
        )?.value,
      ).toBe("0.00015 ETH");
      expect(second.embeds[0]?.color).toBe(0xe74c3c);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
