import {
  getAddress,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import {
  stakeDaoProtocolControllerAbi,
  stakeDaoVaultRegisteredEvent,
} from "./abi.js";
import { mapConcurrent } from "./concurrency.js";
import {
  STAKE_DAO_CURVE_PROTOCOL_ID,
  STAKE_DAO_PROTOCOL_CONTROLLER_ADDRESS,
  STAKE_DAO_REGISTRY_START_BLOCK,
} from "./constants.js";

const WAD = 1_000_000_000_000_000_000n;
const BPS = 10_000n;

export interface StakeDaoGauge {
  readonly gauge: Address;
  readonly vault: Address;
}

export interface StakeDaoVaultAccounting {
  readonly supply: bigint;
  readonly netCredited: bigint;
  readonly reservedHarvestFee: bigint;
  readonly reservedProtocolFee: bigint;
}

interface RegistryCache {
  readonly registrations: Map<string, Address>;
  scannedThrough: bigint;
}

let registryCache: RegistryCache | undefined;
let registryRefresh:
  | Promise<readonly StakeDaoGauge[]>
  | undefined;

function blockRanges(
  fromBlock: bigint,
  toBlock: bigint,
  maximumRange: bigint,
): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[] {
  if (maximumRange < 1n) {
    throw new Error("Stake DAO discovery range must be positive");
  }
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
 * Discovers every Curve gauge ever registered on the canonical controller,
 * then re-reads current vault/shutdown state so stale registrations cannot be
 * submitted. The event cache is process-local and incrementally refreshed.
 */
export async function discoverStakeDaoCurveGauges(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly stateClient?: PublicClient<Transport, Chain>;
  readonly maximumBlockRange: bigint;
  readonly concurrency: number;
}): Promise<readonly StakeDaoGauge[]> {
  if (registryRefresh !== undefined) return registryRefresh;
  registryRefresh = (async () => {
    const latestBlock = await parameters.client.getBlockNumber();
    const cache =
      registryCache ??
      {
        registrations: new Map<string, Address>(),
        scannedThrough: STAKE_DAO_REGISTRY_START_BLOCK - 1n,
      };
    const fromBlock = cache.scannedThrough + 1n;
    if (fromBlock <= latestBlock) {
      const ranges = blockRanges(
        fromBlock,
        latestBlock,
        parameters.maximumBlockRange,
      );
      const pages = await mapConcurrent(
        ranges,
        parameters.concurrency,
        (range) =>
          parameters.client.getLogs({
            address: STAKE_DAO_PROTOCOL_CONTROLLER_ADDRESS,
            event: stakeDaoVaultRegisteredEvent,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            strict: true,
          }),
      );
      for (const page of pages) {
        for (const event of page) {
          if (
            event.args.protocolId.toLowerCase() !==
            STAKE_DAO_CURVE_PROTOCOL_ID
          ) {
            continue;
          }
          cache.registrations.set(
            event.args.gauge.toLowerCase(),
            getAddress(event.args.gauge),
          );
        }
      }
      cache.scannedThrough = latestBlock;
      registryCache = cache;
    }

    const gauges = [...cache.registrations.values()];
    const current = await (
      parameters.stateClient ?? parameters.client
    ).multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: gauges.flatMap((gauge) => [
        {
          address: STAKE_DAO_PROTOCOL_CONTROLLER_ADDRESS,
          abi: stakeDaoProtocolControllerAbi,
          functionName: "vault" as const,
          args: [gauge] as const,
        },
        {
          address: STAKE_DAO_PROTOCOL_CONTROLLER_ADDRESS,
          abi: stakeDaoProtocolControllerAbi,
          functionName: "isShutdown" as const,
          args: [gauge] as const,
        },
      ]),
    });
    return gauges.flatMap((gauge, index) => {
      const vault = current[index * 2];
      const shutdown = current[index * 2 + 1];
      if (
        vault?.status !== "success" ||
        typeof vault.result !== "string" ||
        vault.result === "0x0000000000000000000000000000000000000000" ||
        shutdown?.status !== "success" ||
        typeof shutdown.result !== "boolean" ||
        shutdown.result
      ) {
        return [];
      }
      return [{ gauge, vault: getAddress(vault.result) }];
    });
  })();
  try {
    return await registryRefresh;
  } finally {
    registryRefresh = undefined;
  }
}

/**
 * Lower-bounds the CRV paid to the caller using the Accountant's exact
 * accounting order. Core gauge CRV is a lower bound on total pending rewards;
 * sidecar rewards are deliberately ignored.
 */
export function conservativeStakeDaoHarvesterFee(parameters: {
  readonly claimableCrv: bigint;
  readonly harvestFeePercent: bigint;
  readonly accounting: StakeDaoVaultAccounting;
}): bigint {
  if (
    parameters.claimableCrv < 0n ||
    parameters.harvestFeePercent < 0n ||
    parameters.harvestFeePercent > WAD
  ) {
    throw new Error("invalid Stake DAO fee input");
  }
  if (parameters.claimableCrv === 0n) return 0n;
  const {
    supply,
    netCredited,
    reservedHarvestFee,
    reservedProtocolFee,
  } = parameters.accounting;
  let fee = reservedHarvestFee;
  const existingClaims =
    reservedProtocolFee + reservedHarvestFee + netCredited;
  if (
    supply > 0n &&
    parameters.claimableCrv > existingClaims
  ) {
    const newRewards = parameters.claimableCrv - existingClaims;
    fee +=
      (newRewards * parameters.harvestFeePercent) /
      WAD;
  }
  return fee;
}

/**
 * CRV/USD and ETH/USD use the same Chainlink precision, so the ratio preserves
 * the token's 18 decimals. Rounding is always down before the configured
 * haircut.
 */
export function conservativeCrvToEthWei(parameters: {
  readonly crvAmount: bigint;
  readonly crvUsd: bigint;
  readonly ethUsd: bigint;
  readonly haircutBps: bigint;
}): bigint {
  if (
    parameters.crvAmount < 0n ||
    parameters.crvUsd <= 0n ||
    parameters.ethUsd <= 0n ||
    parameters.haircutBps < 0n ||
    parameters.haircutBps > BPS
  ) {
    throw new Error("invalid Stake DAO CRV conversion input");
  }
  return (
    (parameters.crvAmount *
      parameters.crvUsd *
      parameters.haircutBps) /
    parameters.ethUsd /
    BPS
  );
}

export function isFreshChainlinkRound(parameters: {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
  readonly nowSeconds: bigint;
  readonly maximumAgeSeconds: bigint;
}): boolean {
  return (
    parameters.answer > 0n &&
    parameters.updatedAt > 0n &&
    parameters.answeredInRound >= parameters.roundId &&
    parameters.updatedAt <= parameters.nowSeconds &&
    parameters.nowSeconds - parameters.updatedAt <=
      parameters.maximumAgeSeconds
  );
}

export function stakeDaoGaugePrefixes<T>(
  candidates: readonly T[],
  maximumBatchSize: number,
): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(maximumBatchSize) || maximumBatchSize < 1) {
    throw new Error("Stake DAO batch size must be positive");
  }
  const maximum = Math.min(candidates.length, maximumBatchSize);
  return Array.from({ length: maximum }, (_, index) =>
    candidates.slice(0, index + 1),
  );
}
