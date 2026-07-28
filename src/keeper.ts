import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
} from "viem";

import { factoryAbi, standingOrderAbi } from "./abi.js";
import type { KeeperConfig } from "./config.js";
import { assessProfit } from "./economics.js";
import { errorMessage, eth, gwei, log } from "./format.js";

interface OrderCandidate {
  readonly address: Address;
  readonly crankFee: bigint;
}

export interface PassResult {
  readonly orders: number;
  readonly viable: number;
  readonly sent: number;
  readonly confirmed: number;
}

export interface KeeperContext {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly config: KeeperConfig;
  readonly sendCrank:
    | ((parameters: {
        readonly order: Address;
        readonly gas: bigint;
        readonly maxFeePerGas: bigint;
        readonly maxPriorityFeePerGas: bigint;
      }) => Promise<Hash>)
    | undefined;
}

export function rankByFee(
  candidates: readonly OrderCandidate[],
): OrderCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.crankFee === b.crankFee) {
      return a.address.localeCompare(b.address);
    }
    return a.crankFee > b.crankFee ? -1 : 1;
  });
}

function revertedErrorName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(
    (candidate) => candidate instanceof ContractFunctionRevertedError,
  );
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  return reverted.data?.errorName;
}

async function getCandidates(
  client: PublicClient<Transport, Chain>,
  factoryAddress: Address,
): Promise<OrderCandidate[]> {
  const orders = await client.readContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "allOrders",
  });
  const feeResults = await client.multicall({
    allowFailure: true,
    contracts: orders.map((address) => ({
      address,
      abi: standingOrderAbi,
      functionName: "crankFee" as const,
    })),
  });

  const candidates: OrderCandidate[] = [];
  for (let index = 0; index < orders.length; index += 1) {
    const address = orders[index];
    const result = feeResults[index];
    if (address !== undefined && result?.status === "success") {
      candidates.push({ address, crankFee: result.result });
    }
  }
  return rankByFee(candidates);
}

function actualFeeFromReceipt(
  order: Address,
  logs: readonly {
    readonly address: Address;
    readonly data: `0x${string}`;
    readonly topics: [] | [`0x${string}`, ...`0x${string}`[]];
  }[],
  fallback: bigint,
): bigint {
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== order.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: standingOrderAbi,
        data: entry.data,
        topics: entry.topics,
      });
      if (decoded.eventName === "Cranked") return decoded.args.fee;
    } catch {
      // Not every log from the order must be Cranked.
    }
  }
  return fallback;
}

export async function runPass(context: KeeperContext): Promise<PassResult> {
  const { publicClient, sendCrank, account, config } = context;
  const candidates = await getCandidates(
    publicClient,
    config.factoryAddress,
  );
  const feeQuote = await publicClient.estimateFeesPerGas({ type: "eip1559" });
  const maxFeePerGas = feeQuote.maxFeePerGas;
  const maxPriorityFeePerGas = feeQuote.maxPriorityFeePerGas;

  if (maxFeePerGas > config.maxFeePerGas) {
    log("info", "gas_price_above_cap", {
      estimatedMaxFee: gwei(maxFeePerGas),
      configuredCap: gwei(config.maxFeePerGas),
      orders: candidates.length,
    });
    return { orders: candidates.length, viable: 0, sent: 0, confirmed: 0 };
  }

  let viable = 0;
  let sent = 0;
  let confirmed = 0;
  const skipped = new Map<string, number>();

  for (const candidate of candidates) {
    if (
      config.maxTransactionsPerPass !== 0 &&
      sent >= config.maxTransactionsPerPass
    ) {
      break;
    }
    if (candidate.crankFee < config.minProfitWei) {
      skipped.set("fee_below_absolute_floor", 1 + (skipped.get("fee_below_absolute_floor") ?? 0));
      continue;
    }

    let estimatedGas: bigint;
    try {
      estimatedGas = await publicClient.estimateContractGas({
        account,
        address: candidate.address,
        abi: standingOrderAbi,
        functionName: "crank",
      });
    } catch (error) {
      const reason = revertedErrorName(error) ?? "simulation_failed";
      skipped.set(reason, 1 + (skipped.get(reason) ?? 0));
      continue;
    }

    const decision = assessProfit({
      crankFee: candidate.crankFee,
      estimatedGas,
      maxFeePerGas,
      gasLimitMultiplierBps: config.gasLimitMultiplierBps,
      minProfitWei: config.minProfitWei,
      minProfitBps: config.minProfitBps,
    });
    if (!decision.profitable) {
      skipped.set("unprofitable", 1 + (skipped.get("unprofitable") ?? 0));
      continue;
    }

    viable += 1;
    log("info", "crank_opportunity", {
      order: candidate.address,
      crankFee: eth(candidate.crankFee),
      estimatedGas: estimatedGas.toString(),
      gasLimit: decision.gasLimit.toString(),
      maxFeePerGas: gwei(maxFeePerGas),
      worstCaseProfit: eth(decision.maxProfit),
      requiredProfit: eth(decision.requiredProfit),
      dryRun: config.dryRun,
    });

    if (config.dryRun) continue;
    if (sendCrank === undefined) {
      throw new Error("live mode requires a configured transaction sender");
    }

    try {
      const hash = await sendCrank({
        order: candidate.address,
        gas: decision.gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      sent += 1;
      log("info", "crank_sent", {
        order: candidate.address,
        hash,
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: config.confirmations,
      });
      const successful = receipt.status === "success";
      if (successful) confirmed += 1;
      const paidFee = successful
        ? actualFeeFromReceipt(candidate.address, receipt.logs, candidate.crankFee)
        : 0n;
      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
      const realizedProfit = paidFee - gasCost;
      log(successful ? "info" : "warn", "crank_receipt", {
        order: candidate.address,
        hash,
        block: receipt.blockNumber.toString(),
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: gwei(receipt.effectiveGasPrice),
        paidFee: eth(paidFee),
        gasCost: eth(gasCost),
        realizedProfit: eth(realizedProfit),
      });
    } catch (error) {
      log("warn", "crank_submission_failed", {
        order: candidate.address,
        reason: revertedErrorName(error) ?? errorMessage(error),
      });
    }
  }

  log("info", "pass_complete", {
    orders: candidates.length,
    viable,
    sent,
    confirmed,
    skipped: JSON.stringify(Object.fromEntries(skipped)),
  });
  return { orders: candidates.length, viable, sent, confirmed };
}
