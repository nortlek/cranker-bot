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

  it("suppresses grouped transaction receipts in favor of an aggregate batch result", () => {
    const memberEmbed = buildDiscordEmbed(
      {
        time: "2026-07-29T15:54:29.000Z",
        level: "info",
        event: "keeper_receipt",
        kind: "standing_order",
        label: "standing_order:0x1234",
        hash: `0x${"56".repeat(32)}`,
        block: "25639517",
        status: "success",
        gasUsed: "183753",
        paidReward: "0.0003 ETH",
        gasCost: "0.000313670644176015 ETH",
        realizedProfit: "-0.000013670644176015 ETH",
        batchTransactionCount: 5,
        batchPosition: 2,
        batchTargetBlock: "25639517",
      },
      -13_670_644_176_015n,
    );
    const batchEmbed = buildDiscordEmbed(
      {
        time: "2026-07-29T15:54:29.200Z",
        level: "info",
        event: "keeper_batch_result",
        kinds: JSON.stringify(
          Array.from({ length: 5 }, () => "standing_order"),
        ),
        transactionCount: 5,
        confirmedTransactions: 5,
        revertedTransactions: 0,
        expiredTransactions: 0,
        targetBlock: "25639517",
        block: "25639517",
        totalReward: "0.0016 ETH",
        totalGasCost: "0.001568353220880075 ETH",
        realizedProfit: "0.000031646779119925 ETH",
        effectiveBuilderBidBps: "6898",
      },
      31_646_779_119_925n,
    );

    expect(memberEmbed).toBeUndefined();
    expect(batchEmbed?.title).toBe("Keeper batch confirmed");
    expect(batchEmbed?.color).toBe(0x2ecc71);
    expect(
      batchEmbed?.fields?.find(
        (entry) => entry.name === "Batch P&L",
      )?.value,
    ).toBe("0.000031646779119925 ETH");
  });

  it("renders a gas-free grouped batch miss once as an expiration", () => {
    const memberEmbed = buildDiscordEmbed(
      {
        time: "2026-07-29T15:51:28.000Z",
        level: "warn",
        event: "keeper_transaction_expired",
        kind: "standing_order",
        label: "standing_order:0x1234",
        hash: `0x${"78".repeat(32)}`,
        targetBlock: "25639502",
        reason: "receipt not found",
        batchTransactionCount: 5,
        batchPosition: 1,
        batchTargetBlock: "25639502",
      },
      0n,
    );
    const batchEmbed = buildDiscordEmbed(
      {
        time: "2026-07-29T15:51:29.000Z",
        level: "info",
        event: "keeper_batch_result",
        kinds: JSON.stringify(
          Array.from({ length: 5 }, () => "standing_order"),
        ),
        transactionCount: 5,
        confirmedTransactions: 0,
        revertedTransactions: 0,
        expiredTransactions: 5,
        targetBlock: "25639502",
        block: "",
        totalReward: "0 ETH",
        totalGasCost: "0 ETH",
        realizedProfit: "0 ETH",
        effectiveBuilderBidBps: "6342",
      },
      0n,
    );

    expect(memberEmbed).toBeUndefined();
    expect(batchEmbed?.title).toBe("Keeper batch expired");
    expect(batchEmbed?.color).toBe(0xf39c12);
  });

  it("shows direct builder value in aggregate batch P&L", () => {
    const embed = buildDiscordEmbed(
      {
        time: "2026-07-29T16:00:00.000Z",
        level: "info",
        event: "keeper_batch_result",
        kinds: JSON.stringify([
          "standing_order",
          "builder_payment",
        ]),
        transactionCount: 2,
        confirmedTransactions: 2,
        revertedTransactions: 0,
        expiredTransactions: 0,
        targetBlock: "25640510",
        block: "25640510",
        totalReward: "0.0025 ETH",
        totalGasCost: "0.00015 ETH",
        totalTransactionValue: "0.0022 ETH",
        realizedProfit: "0.00015 ETH",
        effectiveBuilderBidBps: "8939",
      },
      150_000_000_000_000n,
    );

    expect(
      embed?.fields?.find(
        (entry) => entry.name === "Direct builder payment",
      )?.value,
    ).toBe("0.0022 ETH");
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

  it("counts grouped member receipts once and sends only the aggregate result", async () => {
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
      for (const [index, realizedProfit] of [
        "-0.00001 ETH",
        "0.00004 ETH",
      ].entries()) {
        notifier.notify({
          time: `2026-07-29T16:00:0${index}.000Z`,
          level: "info",
          event: "keeper_receipt",
          kind: "standing_order",
          label: `standing_order:${index}`,
          hash: `0x${String(index + 1)
            .padStart(2, "0")
            .repeat(32)}`,
          block: "25639517",
          status: "success",
          gasUsed: "183753",
          paidReward: "0.0003 ETH",
          gasCost: "0.0003 ETH",
          realizedProfit,
          batchTransactionCount: 2,
          batchPosition: index + 1,
          batchTargetBlock: "25639517",
        });
      }
      notifier.notify({
        time: "2026-07-29T16:00:02.000Z",
        level: "info",
        event: "keeper_batch_result",
        kinds: JSON.stringify([
          "standing_order",
          "standing_order",
        ]),
        transactionCount: 2,
        confirmedTransactions: 2,
        revertedTransactions: 0,
        expiredTransactions: 0,
        targetBlock: "25639517",
        block: "25639517",
        totalReward: "0.0006 ETH",
        totalGasCost: "0.00057 ETH",
        realizedProfit: "0.00003 ETH",
        effectiveBuilderBidBps: "5000",
      });
      await notifier.flush();

      expect(messages).toHaveLength(1);
      const message = messages[0] as {
        embeds: Array<{
          title: string;
          fields: Array<{ name: string; value: string }>;
        }>;
      };
      expect(message.embeds[0]?.title).toBe(
        "Keeper batch confirmed",
      );
      expect(
        message.embeds[0]?.fields.find(
          (entry) => entry.name === "Session realized P&L",
        )?.value,
      ).toBe("0.00003 ETH");
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
