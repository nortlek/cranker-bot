import { readFile } from "node:fs/promises";

import {
  BaseError,
  createPublicClient,
  formatEther,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";

const POOL = getAddress("0x7865d01da4c9ba2f69b7879e6d2483ab6b354d95");
const VAULT = getAddress("0x9eE31E845fF1358Bf6B1F914d3918c6223c75573");
const CLAIMER = getAddress("0x98CC81798954c35c39b960DfcA3d8b170154aa7e");
const DEFAULT_WINNERS_PATH =
  "/tmp/pull-pool-winners.S0R3Rs/1/0x7865d01da4c9ba2f69b7879e6d2483ab6b354d95/draw/24/winners.json";

const poolAbi = parseAbi([
  "function wasClaimed(address,address,uint8,uint32) view returns(bool)",
  "function isWinner(address,address,uint8,uint32) view returns(bool)",
  "function getLastAwardedDrawId() view returns(uint24)",
]);
const vaultAbi = parseAbi([
  "function claimer() view returns(address)",
  "function prizePool() view returns(address)",
  "function claimPrize(address,uint8,uint32,uint96,address) returns(uint256)",
  "error CallerNotClaimer(address caller,address claimer)",
  "error ClaimRecipientZeroAddress()",
  "error ClaimPeriodExpired()",
  "error RewardRecipientZeroAddress()",
  "error RewardTooLarge(uint256 reward,uint256 maxReward)",
  "error PrizeIsZero()",
  "error DidNotWin(address vault,address winner,uint8 tier,uint32 prizeIndex)",
  "error AlreadyClaimed(address vault,address winner,uint8 tier,uint32 prizeIndex)",
]);
const claimerAbi = parseAbi([
  "function computeFeePerClaim(uint8,uint256) view returns(uint256)",
  "function claimPrizes(address,uint8,address[],uint32[][],address,uint256) returns(uint256)",
]);

interface WinnerEntry {
  readonly user: string;
  readonly prizes: Readonly<Record<string, readonly number[]>>;
}

interface Claim {
  readonly winner: Address;
  readonly prizeIndex: number;
}

function winnersPath(): string {
  const argument = process.argv.find((value) => value.startsWith("--winners="));
  return (
    argument?.slice("--winners=".length) ||
    process.env.POOLTOGETHER_WINNERS_PATH ||
    DEFAULT_WINNERS_PATH
  );
}

function prizeTier(): number {
  const argument = process.argv.find((value) => value.startsWith("--tier="));
  if (argument === undefined) return 5;
  const value = Number(argument.slice("--tier=".length));
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`invalid --tier value: ${String(value)}`);
  }
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    const root = error.walk();
    return root.shortMessage || root.message || error.shortMessage || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const parsed = JSON.parse(
    await readFile(winnersPath(), "utf8"),
  ) as Readonly<Record<string, readonly WinnerEntry[]>>;
  const tier = prizeTier();

  const allClaims: Claim[] = [];
  for (const entry of parsed[VAULT.toLowerCase()] ?? []) {
    for (const prizeIndex of entry.prizes[String(tier)] ?? []) {
      allClaims.push({
        winner: getAddress(entry.user),
        prizeIndex,
      });
    }
  }
  const statuses = await client.multicall({
    allowFailure: true,
    contracts: allClaims.map((claim) => ({
      address: POOL,
      abi: poolAbi,
      functionName: "wasClaimed" as const,
      args: [VAULT, claim.winner, tier, claim.prizeIndex] as const,
    })),
  });
  const unclaimed = allClaims.filter(
    (_, index) =>
      statuses[index]?.status === "success" &&
      statuses[index]?.result === false,
  );
  const candidate = unclaimed[0];
  if (candidate === undefined) {
    throw new Error("no unclaimed custom-vault claims remain");
  }

  const [configuredClaimer, configuredPool, drawId, feePerClaim, isWinner] =
    await Promise.all([
      client.readContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: "claimer",
      }),
      client.readContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: "prizePool",
      }),
      client.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "getLastAwardedDrawId",
      }),
      client.readContract({
        address: CLAIMER,
        abi: claimerAbi,
        functionName: "computeFeePerClaim",
        args: [tier, 1n],
      }),
      client.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "isWinner",
        args: [VAULT, candidate.winner, tier, candidate.prizeIndex],
      }),
    ]);

  let innerResult: string;
  try {
    const simulation = await client.simulateContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "claimPrize",
      args: [
        candidate.winner,
        tier,
        candidate.prizeIndex,
        feePerClaim,
        CLAIMER,
      ],
      account: CLAIMER,
    });
    innerResult = `success:${formatEther(simulation.result)}`;
  } catch (error) {
    innerResult = `failure:${describeError(error)}`;
  }

  let outerResult: string;
  try {
    const simulation = await client.simulateContract({
      address: CLAIMER,
      abi: claimerAbi,
      functionName: "claimPrizes",
      args: [
        VAULT,
        tier,
        [candidate.winner],
        [[candidate.prizeIndex]],
        CLAIMER,
        feePerClaim,
      ],
      account: CLAIMER,
    });
    outerResult = `success:${formatEther(simulation.result)}`;
  } catch (error) {
    outerResult = `failure:${describeError(error)}`;
  }

  console.log(
    JSON.stringify({
      event: "pooltogether_custom_claim_diagnostic",
      drawId,
      tier,
      winnersPath: winnersPath(),
      totalClaimsInFile: allClaims.length,
      unclaimedClaims: unclaimed.length,
      configuredClaimer: getAddress(configuredClaimer),
      expectedClaimer: CLAIMER,
      configuredPool: getAddress(configuredPool),
      expectedPool: POOL,
      candidate,
      poolReportsWinner: isWinner,
      feePerClaim: formatEther(feePerClaim),
      innerResult,
      outerResult,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "pooltogether_custom_claim_diagnostic_failed",
      reason: describeError(error),
    }),
  );
  process.exitCode = 1;
});
