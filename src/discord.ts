import { formatEther, parseEther } from "viem";

import {
  errorMessage,
  type LogEntry,
  type LogFieldValue,
} from "./format.js";

const COLOR = {
  blue: 0x3498db,
  green: 0x2ecc71,
  grey: 0x95a5a6,
  orange: 0xf39c12,
  red: 0xe74c3c,
} as const;

interface DiscordEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface DiscordEmbed {
  readonly title: string;
  readonly description?: string;
  readonly color: number;
  readonly fields?: readonly DiscordEmbedField[];
  readonly timestamp: string;
  readonly footer: { readonly text: string };
}

const FAILURE_EVENTS = new Set([
  "adaptive_bid_observation_failed",
  "competitor_bid_measurement_failed",
  "dependency_batch_unfunded",
  "fatal",
  "firm_replenish_accounting_failed",
  "firm_replenish_scan_failed",
  "keeper_batch_submission_failed",
  "keeper_pass_failed",
  "keeper_receipt_unresolved",
  "keeper_submission_failed",
  "keeper_transaction_expired",
  "nonce_batch_blocked",
  "signer_lease_disabled",
  "signer_lease_waiting",
  "stakedao_curve_scan_failed",
  "telemetry_close_failed",
  "telemetry_queue_overflow",
  "telemetry_run_stop_failed",
  "telemetry_write_failed",
]);

function compact(value: LogFieldValue | undefined, maximum = 1_000): string {
  const text = value === undefined ? "—" : String(value);
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1)}…`;
}

function field(
  name: string,
  value: LogFieldValue | undefined,
  inline = true,
): DiscordEmbedField {
  return { name, value: compact(value), inline };
}

function transactionDescription(entry: LogEntry): string | undefined {
  const hash = entry.hash;
  if (
    typeof hash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(hash)
  ) {
    return undefined;
  }
  return `[View transaction on Etherscan](https://etherscan.io/tx/${hash})`;
}

function displayedEthWei(value: LogFieldValue | undefined): bigint | undefined {
  if (typeof value !== "string" || !value.endsWith(" ETH")) {
    return undefined;
  }
  try {
    return parseEther(value.slice(0, -" ETH".length));
  } catch {
    return undefined;
  }
}

function commonEmbed(
  entry: LogEntry,
  parameters: {
    readonly title: string;
    readonly color: number;
    readonly description?: string | undefined;
    readonly fields?: readonly DiscordEmbedField[] | undefined;
  },
): DiscordEmbed {
  return {
    title: parameters.title,
    color: parameters.color,
    timestamp: entry.time,
    footer: { text: "Ethereum mainnet • pull-pool-keeper" },
    ...(parameters.description === undefined
      ? {}
      : { description: parameters.description }),
    ...(parameters.fields === undefined
      ? {}
      : { fields: parameters.fields }),
  };
}

function titleForFailure(event: string): string {
  return event
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function buildDiscordEmbed(
  entry: LogEntry,
  cumulativeRealizedPnlWei: bigint,
): DiscordEmbed | undefined {
  if (entry.event === "keeper_started") {
    return commonEmbed(entry, {
      title: "Keeper started",
      color: COLOR.green,
      fields: [
        field("Account", entry.account, false),
        field("Balance", entry.accountBalance),
        field("Submission", entry.submissionMode),
        field(
          "Order starting bid",
          `${compact(entry.configuredBuilderBidBps)} bps`,
        ),
        field(
          "Order learned minimum",
          `${compact(entry.adaptiveBidMinimumBps)} bps`,
        ),
        field(
          "Ready-chain bid",
          `${compact(entry.configuredPoolBuilderBidBps)} bps`,
        ),
        field(
          "Pool pull bid",
          `${compact(entry.configuredPoolPullBuilderBidBps)} bps`,
        ),
        field(
          "Fulfilled-chain bid",
          `${compact(entry.configuredPoolFulfilledBuilderBidBps)} bps`,
        ),
        field(
          "Sweep bid",
          `${compact(entry.configuredLiveBidSweepBuilderBidBps)} bps`,
        ),
        field(
          "Liquity bid",
          `${compact(entry.configuredLiquityBuilderBidBps)} bps`,
        ),
        field(
          "Convex bid",
          `${compact(entry.configuredConvexBuilderBidBps)} bps`,
        ),
        field(
          "Stake DAO bid",
          `${compact(entry.configuredStakeDaoBuilderBidBps)} bps`,
        ),
        field(
          "FiRM bid",
          `${compact(entry.configuredFirmBuilderBidBps)} bps`,
        ),
      ],
    });
  }

  if (entry.event === "keeper_stopped") {
    return commonEmbed(entry, {
      title: "Keeper stopped",
      color: COLOR.grey,
      fields: [
        field(
          "Session realized P&L",
          `${formatEther(cumulativeRealizedPnlWei)} ETH`,
          false,
        ),
      ],
    });
  }

  if (entry.event === "keeper_transaction_sent") {
    return commonEmbed(entry, {
      title: "Keeper transaction submitted",
      color: COLOR.blue,
      ...(transactionDescription(entry) === undefined
        ? {}
        : { description: transactionDescription(entry) }),
      fields: [
        field("Job", entry.kind),
        field("Label", entry.label, false),
        field("Target block", entry.targetBlock),
        field("Nonce", entry.nonce),
      ],
    });
  }

  if (entry.event === "keeper_receipt") {
    const pnlWei = displayedEthWei(entry.realizedProfit);
    const successful = entry.status === "success";
    return commonEmbed(entry, {
      title: successful
        ? "Keeper transaction confirmed"
        : "Keeper transaction failed",
      color:
        !successful || (pnlWei !== undefined && pnlWei < 0n)
          ? COLOR.red
          : COLOR.green,
      ...(transactionDescription(entry) === undefined
        ? {}
        : { description: transactionDescription(entry) }),
      fields: [
        field("Job", entry.kind),
        field("Label", entry.label, false),
        field("Block", entry.block),
        field("Gas used", entry.gasUsed),
        field("Reward", entry.paidReward),
        ...(entry.paidTokenReward === undefined
          ? []
          : [field("Token reward", entry.paidTokenReward)]),
        field("Gas cost", entry.gasCost),
        field("P&L change", entry.realizedProfit),
        field(
          "Session realized P&L",
          `${formatEther(cumulativeRealizedPnlWei)} ETH`,
        ),
      ],
    });
  }

  if (entry.event === "stakedao_curve_opportunity") {
    return commonEmbed(entry, {
      title: "Stake DAO Curve harvest found",
      color: COLOR.blue,
      fields: [
        field("Batch", entry.label, false),
        field("Gauges", entry.gaugeCount),
        field("Caller fee", entry.estimatedHarvesterFee),
        field("Conservative value", entry.conservativeReward),
        field("Gas limit", entry.gasLimit),
        field("Submission", "Private Flashbots only"),
      ],
    });
  }

  if (entry.event === "competitor_bid_observed") {
    return commonEmbed(entry, {
      title: "Competitor won a crank",
      color: COLOR.orange,
      fields: [
        field("Target block", entry.targetBlock),
        field("Winning bid", `${compact(entry.winningBidBps)} bps`),
        field("Crank fees", entry.totalCrankFees),
        field("Builder payment", entry.totalBuilderPayment),
        field("Transaction", entry.transactionHash, false),
      ],
    });
  }

  if (
    entry.event === "builder_bid" &&
    entry.accepted === false
  ) {
    return commonEmbed(entry, {
      title: "Opportunity rejected by economics",
      color: COLOR.orange,
      fields: [
        field("Jobs", entry.kinds, false),
        field("Gross reward", entry.grossReward),
        field("Expected P&L", entry.expectedProfit),
        field("Required P&L", entry.requiredProfit),
        field("Reason", entry.reason),
      ],
    });
  }

  if (FAILURE_EVENTS.has(entry.event)) {
    return commonEmbed(entry, {
      title: titleForFailure(entry.event),
      color: COLOR.red,
      ...(transactionDescription(entry) === undefined
        ? {}
        : { description: transactionDescription(entry) }),
      fields: [
        field("Reason", entry.reason, false),
        ...(entry.kind === undefined ? [] : [field("Job", entry.kind)]),
        ...(entry.label === undefined
          ? []
          : [field("Label", entry.label, false)]),
        ...(entry.targetBlock === undefined
          ? []
          : [field("Target block", entry.targetBlock)]),
      ],
    });
  }

  return undefined;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class DiscordWebhookNotifier {
  readonly #url: string;
  readonly #timeoutMs: number;
  #queue: Promise<void> = Promise.resolve();
  #cumulativeRealizedPnlWei = 0n;

  constructor(parameters: {
    readonly url: string;
    readonly timeoutMs: number;
  }) {
    this.#url = parameters.url;
    this.#timeoutMs = parameters.timeoutMs;
  }

  notify(entry: LogEntry): void {
    if (entry.event === "keeper_receipt") {
      this.#cumulativeRealizedPnlWei +=
        displayedEthWei(entry.realizedProfit) ?? 0n;
    }
    const embed = buildDiscordEmbed(
      entry,
      this.#cumulativeRealizedPnlWei,
    );
    if (embed === undefined) return;
    this.#queue = this.#queue.then(
      async () => this.#post(embed),
      async () => this.#post(embed),
    );
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  async #post(embed: DiscordEmbed): Promise<void> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "FWA Keeper",
            allowed_mentions: { parse: [] },
            embeds: [embed],
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (response.ok) return;
        if (response.status === 429 && attempt === 0) {
          const payload = (await response.json()) as {
            readonly retry_after?: number;
          };
          const retryAfterMs = Math.min(
            Math.max((payload.retry_after ?? 1) * 1_000, 250),
            10_000,
          );
          await delay(retryAfterMs);
          continue;
        }
        throw new Error(`Discord webhook returned HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          time: new Date().toISOString(),
          level: "warn",
          event: "discord_webhook_failed",
          reason: errorMessage(error),
        }),
      );
    }
  }
}
