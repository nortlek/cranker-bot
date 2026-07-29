import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import {
  erc20Abi,
  firmAddMarketEvent,
  firmDbrAbi,
  firmForceReplenishEvent,
  firmMarketAbi,
} from "./abi.js";
import { mapConcurrent } from "./concurrency.js";
import {
  FIRM_DBR_ADDRESS,
  FIRM_DBR_DEPLOYMENT_BLOCK,
  FIRM_DOLA_ADDRESS,
} from "./constants.js";

const BPS = 10_000n;
const MAXIMUM_REPLENISHMENT_PRICE_BPS = 1_000_000n;

export interface FirmCandidate {
  readonly market: Address;
  readonly account: Address;
  readonly lastSeenBlock: bigint;
}

export interface FirmDiscovery {
  readonly candidates: readonly FirmCandidate[];
  readonly registeredMarkets: number;
  readonly scannedThrough: bigint;
}

interface FirmDiscoveryCache {
  readonly markets: Map<string, Address>;
  readonly candidates: Map<string, FirmCandidate>;
  marketScannedThrough: bigint;
  borrowerScannedThrough: bigint | undefined;
}

type ReceiptLog = {
  readonly address: Address;
  readonly data: Hex;
  readonly topics: [] | [Hex, ...Hex[]];
};

let discoveryCache: FirmDiscoveryCache | undefined;
let discoveryRefresh: Promise<FirmDiscovery> | undefined;

export function firmBlockRanges(
  fromBlock: bigint,
  toBlock: bigint,
  maximumRange: bigint,
): readonly {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}[] {
  if (maximumRange < 1n) {
    throw new Error("FiRM discovery range must be positive");
  }
  if (fromBlock > toBlock) return [];
  const ranges: Array<{
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }> = [];
  for (let start = fromBlock; start <= toBlock; start += maximumRange) {
    const end = start + maximumRange - 1n;
    ranges.push({
      fromBlock: start,
      toBlock: end < toBlock ? end : toBlock,
    });
  }
  return ranges;
}

/**
 * Reconstructs the canonical market registry from DBR AddMarket events and a
 * bounded set of recurring borrower/market pairs from recent ForceReplenish
 * events. Both scans are process-cached and incrementally refreshed.
 */
export async function discoverFirmCandidates(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly latestBlock: bigint;
  readonly borrowerLookbackBlocks: bigint;
  readonly maximumBlockRange: bigint;
  readonly concurrency: number;
}): Promise<FirmDiscovery> {
  if (parameters.borrowerLookbackBlocks < 1n) {
    throw new Error("FiRM borrower lookback must be positive");
  }
  if (discoveryRefresh !== undefined) return discoveryRefresh;
  discoveryRefresh = (async () => {
    const cache =
      discoveryCache ??
      {
        markets: new Map<string, Address>(),
        candidates: new Map<string, FirmCandidate>(),
        marketScannedThrough: FIRM_DBR_DEPLOYMENT_BLOCK - 1n,
        borrowerScannedThrough: undefined,
      };

    const marketFrom = cache.marketScannedThrough + 1n;
    if (marketFrom <= parameters.latestBlock) {
      const pages = await mapConcurrent(
        firmBlockRanges(
          marketFrom,
          parameters.latestBlock,
          parameters.maximumBlockRange,
        ),
        parameters.concurrency,
        (range) =>
          parameters.client.getLogs({
            address: FIRM_DBR_ADDRESS,
            event: firmAddMarketEvent,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            strict: true,
          }),
      );
      for (const page of pages) {
        for (const event of page) {
          const market = getAddress(event.args.market);
          cache.markets.set(market.toLowerCase(), market);
        }
      }
      cache.marketScannedThrough = parameters.latestBlock;
    }

    const minimumBorrowerBlock =
      parameters.latestBlock >= parameters.borrowerLookbackBlocks
        ? parameters.latestBlock - parameters.borrowerLookbackBlocks + 1n
        : FIRM_DBR_DEPLOYMENT_BLOCK;
    const borrowerFrom =
      cache.borrowerScannedThrough === undefined
        ? minimumBorrowerBlock > FIRM_DBR_DEPLOYMENT_BLOCK
          ? minimumBorrowerBlock
          : FIRM_DBR_DEPLOYMENT_BLOCK
        : cache.borrowerScannedThrough + 1n;
    if (borrowerFrom <= parameters.latestBlock) {
      const pages = await mapConcurrent(
        firmBlockRanges(
          borrowerFrom,
          parameters.latestBlock,
          parameters.maximumBlockRange,
        ),
        parameters.concurrency,
        (range) =>
          parameters.client.getLogs({
            address: FIRM_DBR_ADDRESS,
            event: firmForceReplenishEvent,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            strict: true,
          }),
      );
      for (const page of pages) {
        for (const event of page) {
          const market = getAddress(event.args.market);
          const account = getAddress(event.args.account);
          if (!cache.markets.has(market.toLowerCase())) continue;
          const key = `${market.toLowerCase()}:${account.toLowerCase()}`;
          const previous = cache.candidates.get(key);
          const blockNumber = event.blockNumber;
          if (
            previous === undefined ||
            blockNumber > previous.lastSeenBlock
          ) {
            cache.candidates.set(key, {
              market,
              account,
              lastSeenBlock: blockNumber,
            });
          }
        }
      }
      cache.borrowerScannedThrough = parameters.latestBlock;
    }

    for (const [key, candidate] of cache.candidates) {
      if (
        candidate.lastSeenBlock < minimumBorrowerBlock ||
        !cache.markets.has(candidate.market.toLowerCase())
      ) {
        cache.candidates.delete(key);
      }
    }
    discoveryCache = cache;
    return {
      candidates: [...cache.candidates.values()].sort((left, right) => {
        if (left.lastSeenBlock !== right.lastSeenBlock) {
          return left.lastSeenBlock > right.lastSeenBlock ? -1 : 1;
        }
        const marketOrder = left.market.localeCompare(right.market);
        return marketOrder === 0
          ? left.account.localeCompare(right.account)
          : marketOrder;
      }),
      registeredMarkets: cache.markets.size,
      scannedThrough: parameters.latestBlock,
    };
  })();
  try {
    return await discoveryRefresh;
  } finally {
    discoveryRefresh = undefined;
  }
}

export function firmReplenishmentAmounts(parameters: {
  readonly deficit: bigint;
  readonly replenishmentPriceBps: bigint;
  readonly replenishmentIncentiveBps: bigint;
}): {
  readonly replenishmentCostDola: bigint;
  readonly replenisherRewardDola: bigint;
} {
  if (parameters.deficit <= 0n) {
    throw new Error("FiRM deficit must be positive");
  }
  if (
    parameters.replenishmentPriceBps <= 0n ||
    parameters.replenishmentPriceBps >
      MAXIMUM_REPLENISHMENT_PRICE_BPS
  ) {
    throw new Error("invalid FiRM replenishment price");
  }
  if (
    parameters.replenishmentIncentiveBps < 0n ||
    parameters.replenishmentIncentiveBps >= BPS
  ) {
    throw new Error("invalid FiRM replenishment incentive");
  }
  const replenishmentCostDola =
    (parameters.deficit * parameters.replenishmentPriceBps) / BPS;
  const replenisherRewardDola =
    (replenishmentCostDola *
      parameters.replenishmentIncentiveBps) /
    BPS;
  return { replenishmentCostDola, replenisherRewardDola };
}

function decimalScale(decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("invalid oracle decimals");
  }
  return 10n ** BigInt(decimals);
}

export interface FirmOracleRound {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
}

export type FirmOracleRoundStatus =
  | "fresh"
  | "non_positive_answer"
  | "missing_timestamp"
  | "incomplete_round"
  | "future_timestamp"
  | "stale";

export function firmOracleRoundStatus(parameters: {
  readonly round: FirmOracleRound;
  readonly nowSeconds: bigint;
  readonly maximumAgeSeconds: bigint;
}): FirmOracleRoundStatus {
  const { round } = parameters;
  if (round.answer <= 0n) return "non_positive_answer";
  if (round.updatedAt <= 0n) return "missing_timestamp";
  if (round.answeredInRound < round.roundId) return "incomplete_round";
  if (round.updatedAt > parameters.nowSeconds) return "future_timestamp";
  if (
    parameters.nowSeconds - round.updatedAt >
    parameters.maximumAgeSeconds
  ) {
    return "stale";
  }
  return "fresh";
}

export function firmOracleRoundsAreFresh(parameters: {
  readonly dolaRound: FirmOracleRound;
  readonly ethRound: FirmOracleRound;
  readonly nowSeconds: bigint;
  readonly dolaMaximumAgeSeconds: bigint;
  readonly ethMaximumAgeSeconds: bigint;
}): boolean {
  return (
    firmOracleRoundStatus({
      round: parameters.dolaRound,
      nowSeconds: parameters.nowSeconds,
      maximumAgeSeconds: parameters.dolaMaximumAgeSeconds,
    }) === "fresh" &&
    firmOracleRoundStatus({
      round: parameters.ethRound,
      nowSeconds: parameters.nowSeconds,
      maximumAgeSeconds: parameters.ethMaximumAgeSeconds,
    }) === "fresh"
  );
}

/**
 * Returns a conservatively haircutted USD value with caller-selected output
 * precision. DOLA is capped at one USD even if the feed reports a premium.
 */
export function conservativeDolaToUsd(parameters: {
  readonly dolaAmount: bigint;
  readonly dolaUsd: bigint;
  readonly dolaUsdDecimals: number;
  readonly outputUsdDecimals: number;
  readonly haircutBps: bigint;
}): bigint {
  if (
    parameters.dolaAmount < 0n ||
    parameters.dolaUsd <= 0n ||
    parameters.haircutBps < 0n ||
    parameters.haircutBps > BPS
  ) {
    throw new Error("invalid FiRM DOLA USD conversion input");
  }
  const dolaScale = decimalScale(parameters.dolaUsdDecimals);
  const outputScale = decimalScale(parameters.outputUsdDecimals);
  const cappedDolaUsd =
    parameters.dolaUsd < dolaScale
      ? parameters.dolaUsd
      : dolaScale;
  return (
    (parameters.dolaAmount *
      cappedDolaUsd *
      outputScale *
      parameters.haircutBps) /
    10n ** 18n /
    dolaScale /
    BPS
  );
}

/**
 * Converts 18-decimal DOLA into wei, caps DOLA at one USD, rounds down at
 * every step, and finally applies the configured exit-risk haircut.
 */
export function conservativeDolaToEthWei(parameters: {
  readonly dolaAmount: bigint;
  readonly dolaUsd: bigint;
  readonly dolaUsdDecimals: number;
  readonly ethUsd: bigint;
  readonly ethUsdDecimals: number;
  readonly haircutBps: bigint;
}): bigint {
  if (
    parameters.dolaAmount < 0n ||
    parameters.dolaUsd <= 0n ||
    parameters.ethUsd <= 0n ||
    parameters.haircutBps < 0n ||
    parameters.haircutBps > BPS
  ) {
    throw new Error("invalid FiRM DOLA conversion input");
  }
  const dolaScale = decimalScale(parameters.dolaUsdDecimals);
  const ethScale = decimalScale(parameters.ethUsdDecimals);
  const cappedDolaUsd =
    parameters.dolaUsd < dolaScale
      ? parameters.dolaUsd
      : dolaScale;
  return (
    (parameters.dolaAmount *
      cappedDolaUsd *
      ethScale *
      parameters.haircutBps) /
    parameters.ethUsd /
    dolaScale /
    BPS
  );
}

export function firmForceReplenishCalldata(parameters: {
  readonly account: Address;
  readonly fixedObservedDeficit: bigint;
}): Hex {
  if (parameters.fixedObservedDeficit <= 0n) {
    throw new Error("FiRM fixed observed deficit must be positive");
  }
  return encodeFunctionData({
    abi: firmMarketAbi,
    functionName: "forceReplenish",
    args: [parameters.account, parameters.fixedObservedDeficit],
  });
}

export interface FirmReceiptAccounting {
  readonly valid: boolean;
  readonly reason?: string;
  readonly fixedDeficit: bigint;
  readonly replenishmentCostDola: bigint;
  readonly replenisherRewardDola: bigint;
  readonly dolaBalanceDelta: bigint;
}

/**
 * Validates the canonical DBR accounting event, the exact DOLA transfer, and
 * the signer's block-level DOLA balance delta. Any mismatch reports zero
 * economic reward to the keeper.
 */
export function accountFirmReceipt(parameters: {
  readonly logs: readonly ReceiptLog[];
  readonly market: Address;
  readonly account: Address;
  readonly replenisher: Address;
  readonly fixedDeficit: bigint;
  readonly expectedReplenishmentCostDola: bigint;
  readonly expectedReplenisherRewardDola: bigint;
  readonly dolaBalanceBefore: bigint;
  readonly dolaBalanceAfter: bigint;
}): FirmReceiptAccounting {
  const base = {
    fixedDeficit: parameters.fixedDeficit,
    replenishmentCostDola: parameters.expectedReplenishmentCostDola,
    replenisherRewardDola: parameters.expectedReplenisherRewardDola,
    dolaBalanceDelta:
      parameters.dolaBalanceAfter >= parameters.dolaBalanceBefore
        ? parameters.dolaBalanceAfter - parameters.dolaBalanceBefore
        : 0n,
  };
  const invalid = (reason: string): FirmReceiptAccounting => ({
    valid: false,
    reason,
    ...base,
  });
  if (parameters.fixedDeficit <= 0n) {
    return invalid("zero_fixed_deficit");
  }
  if (parameters.dolaBalanceAfter < parameters.dolaBalanceBefore) {
    return invalid("dola_balance_decreased");
  }
  if (
    base.dolaBalanceDelta !==
    parameters.expectedReplenisherRewardDola
  ) {
    return invalid("dola_balance_delta_mismatch");
  }

  const forceEvents = [];
  const rewardTransfers = [];
  for (const entry of parameters.logs) {
    if (entry.address.toLowerCase() === FIRM_DBR_ADDRESS.toLowerCase()) {
      try {
        const decoded = decodeEventLog({
          abi: firmDbrAbi,
          data: entry.data,
          topics: entry.topics,
        });
        if (decoded.eventName === "ForceReplenish") {
          forceEvents.push(decoded.args);
        }
      } catch {
        // Ignore unrelated DBR events.
      }
    }
    if (entry.address.toLowerCase() === FIRM_DOLA_ADDRESS.toLowerCase()) {
      try {
        const decoded = decodeEventLog({
          abi: erc20Abi,
          data: entry.data,
          topics: entry.topics,
        });
        if (
          decoded.eventName === "Transfer" &&
          decoded.args.from.toLowerCase() ===
            parameters.market.toLowerCase() &&
          decoded.args.to.toLowerCase() ===
            parameters.replenisher.toLowerCase()
        ) {
          rewardTransfers.push(decoded.args.value);
        }
      } catch {
        // Ignore unrelated DOLA events.
      }
    }
  }
  if (forceEvents.length !== 1) {
    return invalid("force_replenish_event_count");
  }
  const event = forceEvents[0]!;
  if (
    event.account.toLowerCase() !== parameters.account.toLowerCase() ||
    event.replenisher.toLowerCase() !==
      parameters.replenisher.toLowerCase() ||
    event.market.toLowerCase() !== parameters.market.toLowerCase() ||
    event.deficit !== parameters.fixedDeficit ||
    event.replenishmentCost !==
      parameters.expectedReplenishmentCostDola ||
    event.replenisherReward !==
      parameters.expectedReplenisherRewardDola
  ) {
    return invalid("force_replenish_event_mismatch");
  }
  if (
    rewardTransfers.length !== 1 ||
    rewardTransfers[0] !== parameters.expectedReplenisherRewardDola
  ) {
    return invalid("dola_transfer_mismatch");
  }
  return { valid: true, ...base };
}
