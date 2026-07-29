import { readFile } from "node:fs/promises";

import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hash,
} from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../src/config.js";
import { DiscordWebhookNotifier } from "../src/discord.js";
import {
  FlashbotsRelay,
  simulatedGasUsed,
  submitBundleToRelays,
} from "../src/flashbots.js";

const POOL = "0x7865d01da4c9ba2f69b7879e6d2483ab6b354d95";
const STANDARD_CLAIMER =
  "0x54aa02cbc223Fc834949FB1fd8C855e4dA126c7D";
const CUSTOM_CLAIMER =
  "0x98CC81798954c35c39b960DfcA3d8b170154aa7e";
const CUSTOM_VAULT =
  "0x9eE31E845fF1358Bf6B1F914d3918c6223c75573";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const STANDARD_VAULTS = [
  "0x3acd377da549010a197b9ed0f271e1f621e4b62e",
  "0x96fe7b5762bd4405149a9a313473e68a8e870f6c",
  "0x24e32bb2aae5edcebf51e25b287dde165069791c",
  "0x3a49f5a6a8af9b2103d882278193112cf9f73a25",
] as const;
const DEFAULT_WINNERS_PATH =
  "/tmp/pull-pool-winners.S0R3Rs/1/0x7865d01da4c9ba2f69b7879e6d2483ab6b354d95/draw/24/winners.json";
const DEFAULT_MAX_CLAIMS = 150;
const PRIORITY_FEE_PER_GAS = 1_000_000n;
const TRANSACTION_GAS_LIMIT = 16_777_216n;

const claimAbi = parseAbi([
  "function claimPrizes(address,uint8,address[],uint32[][],address,uint256) returns(uint256)",
  "function computeFeePerClaim(uint8,uint256) view returns(uint256)",
]);
const poolAbi = parseAbi([
  "function wasClaimed(address,address,uint8,uint32) view returns(bool)",
  "function withdrawRewards(address,uint256)",
]);
const wethAbi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
]);
const vaultAbi = parseAbi([
  "function claimer() view returns(address)",
]);

interface WinnerEntry {
  readonly user: string;
  readonly prizes: Readonly<Record<string, readonly number[]>>;
}

interface FlatClaim {
  readonly vault: Address;
  readonly winner: Address;
  readonly prizeIndex: number;
}

interface ClaimBatch {
  readonly lane: "standard" | "custom";
  readonly claimer: Address;
  readonly vault: Address;
  readonly winners: readonly Address[];
  readonly prizeIndices: readonly (readonly number[])[];
  readonly claimCount: number;
  readonly availableInVault: number;
}

function nextBaseFee(
  baseFeePerGas: bigint,
  gasUsed: bigint,
  gasLimit: bigint,
): bigint {
  const targetGas = gasLimit / 2n;
  if (gasUsed === targetGas) return baseFeePerGas;
  if (gasUsed > targetGas) {
    let delta =
      (baseFeePerGas * (gasUsed - targetGas)) / targetGas / 8n;
    if (delta < 1n) delta = 1n;
    return baseFeePerGas + delta;
  }
  return (
    baseFeePerGas -
    (baseFeePerGas * (targetGas - gasUsed)) / targetGas / 8n
  );
}

async function waitForBlock(
  client: ReturnType<typeof createPublicClient>,
  targetBlock: bigint,
): Promise<void> {
  while ((await client.getBlockNumber()) < targetBlock) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function optionalReceipt(
  client: ReturnType<typeof createPublicClient>,
  hash: Hash,
) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch {
    return undefined;
  }
}

function winnersPath(): string {
  const argument = process.argv.find((value) =>
    value.startsWith("--winners="),
  );
  return (
    argument?.slice("--winners=".length) ||
    process.env.POOLTOGETHER_WINNERS_PATH ||
    DEFAULT_WINNERS_PATH
  );
}

function claimLane(): "standard" | "custom" {
  const argument = process.argv.find((value) =>
    value.startsWith("--lane="),
  );
  const lane = argument?.slice("--lane=".length) ?? "standard";
  if (lane !== "standard" && lane !== "custom") {
    throw new Error(`unsupported claim lane: ${lane}`);
  }
  return lane;
}

function prizeTier(): number {
  const argument = process.argv.find((value) =>
    value.startsWith("--tier="),
  );
  if (argument === undefined) return 5;
  const value = Number(argument.slice("--tier=".length));
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`invalid --tier value: ${String(value)}`);
  }
  return value;
}

function maximumClaims(): number {
  const argument = process.argv.find((value) =>
    value.startsWith("--max-claims="),
  );
  if (argument === undefined) return DEFAULT_MAX_CLAIMS;
  const value = Number(argument.slice("--max-claims=".length));
  if (!Number.isSafeInteger(value) || value < 1 || value > 150) {
    throw new Error(`invalid --max-claims value: ${String(value)}`);
  }
  return value;
}

async function loadClaimBatch(
  client: ReturnType<typeof createPublicClient>,
): Promise<ClaimBatch> {
  const parsed = JSON.parse(
    await readFile(winnersPath(), "utf8"),
  ) as Readonly<Record<string, readonly WinnerEntry[]>>;
  const tier = prizeTier();

  const lane = claimLane();
  const expectedClaimer = getAddress(
    lane === "custom" ? CUSTOM_CLAIMER : STANDARD_CLAIMER,
  );
  const vaults =
    lane === "custom" ? [CUSTOM_VAULT] : [...STANDARD_VAULTS];
  const vaultChecks = await Promise.all(
    vaults.map(async (vault) => ({
      vault: getAddress(vault),
      claimer: getAddress(
        await client.readContract({
          address: getAddress(vault),
          abi: vaultAbi,
          functionName: "claimer",
        }),
      ),
    })),
  );
  for (const check of vaultChecks) {
    if (check.claimer !== expectedClaimer) {
      throw new Error(
        `vault ${check.vault} uses unexpected claimer ${check.claimer}`,
      );
    }
  }

  const allClaims: FlatClaim[] = [];
  for (const vault of vaults) {
    const normalizedVault = getAddress(vault);
    for (const entry of parsed[vault.toLowerCase()] ?? []) {
      for (const prizeIndex of entry.prizes[String(tier)] ?? []) {
        allClaims.push({
          vault: normalizedVault,
          winner: getAddress(entry.user),
          prizeIndex,
        });
      }
    }
  }
  const statuses = await client.multicall({
    allowFailure: true,
    contracts: allClaims.map((claim) => ({
      address: getAddress(POOL),
      abi: poolAbi,
      functionName: "wasClaimed" as const,
      args: [
        claim.vault,
        claim.winner,
        tier,
        claim.prizeIndex,
      ] as const,
    })),
  });
  const unclaimedByVault = new Map<Address, FlatClaim[]>();
  for (let index = 0; index < allClaims.length; index += 1) {
    const claim = allClaims[index];
    const status = statuses[index];
    if (
      claim === undefined ||
      status?.status !== "success" ||
      status.result
    ) {
      continue;
    }
    const existing = unclaimedByVault.get(claim.vault) ?? [];
    existing.push(claim);
    unclaimedByVault.set(claim.vault, existing);
  }
  const best = [...unclaimedByVault.entries()].sort(
    ([leftVault, left], [rightVault, right]) =>
      right.length - left.length || leftVault.localeCompare(rightVault),
  )[0];
  if (best === undefined || best[1].length === 0) {
    throw new Error(
      `no unclaimed ${lane}-claimer tier-${tier} prizes remain`,
    );
  }
  const [vault, available] = best;
  const selected = available.slice(0, maximumClaims());
  const grouped = new Map<Address, number[]>();
  for (const claim of selected) {
    const indices = grouped.get(claim.winner) ?? [];
    indices.push(claim.prizeIndex);
    grouped.set(claim.winner, indices);
  }
  const winners = [...grouped.keys()];
  return {
    lane,
    claimer: expectedClaimer,
    vault,
    winners,
    prizeIndices: winners.map((winner) => grouped.get(winner) ?? []),
    claimCount: selected.length,
    availableInVault: available.length,
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");

  const config = loadConfig();
  if (config.privateKey === undefined) {
    throw new Error("PRIVATE_KEY is required");
  }
  const signer = privateKeyToAccount(config.privateKey);
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const authAccount = privateKeyToAccount(
    config.flashbotsAuthPrivateKey ?? config.privateKey,
  );
  const relays = config.flashbotsRelayUrls.map(
    (url) =>
      new FlashbotsRelay({
        url,
        authAccount,
        timeoutMs: config.relayTimeoutMs,
      }),
  );
  const notifier =
    config.discordWebhookUrl === undefined
      ? undefined
      : new DiscordWebhookNotifier({
          url: config.discordWebhookUrl,
          timeoutMs: config.discordWebhookTimeoutMs,
        });

  const beforeWeth = await client.readContract({
    address: WETH,
    abi: wethAbi,
    functionName: "balanceOf",
    args: [signer.address],
  });
  const batch = await loadClaimBatch(client);
  console.log(
    JSON.stringify({
      event: "pooltogether_claim_batch_selected",
      execute,
      lane: batch.lane,
      tier: prizeTier(),
      claimer: batch.claimer,
      vault: batch.vault,
      winners: batch.winners.length,
      claims: batch.claimCount,
      availableInVault: batch.availableInVault,
      winnersPath: winnersPath(),
    }),
  );

  let confirmed:
    | {
        readonly claimHash: Hash;
        readonly withdrawHash: Hash;
        readonly reward: bigint;
        readonly gasCost: bigint;
        readonly block: bigint;
        readonly gasUsed: bigint;
      }
    | undefined;

  const attempts = execute ? 8 : 1;
  for (let attempt = 1; attempt <= attempts && confirmed === undefined; attempt += 1) {
    const tier = prizeTier();
    const statusCalls = batch.winners.flatMap((winner, winnerIndex) =>
      (batch.prizeIndices[winnerIndex] ?? []).map((prizeIndex) => ({
        winner,
        prizeIndex,
      })),
    );
    const statuses = await client.multicall({
      allowFailure: true,
      contracts: statusCalls.map(({ winner, prizeIndex }) => ({
        address: getAddress(POOL),
        abi: poolAbi,
        functionName: "wasClaimed" as const,
        args: [
          batch.vault,
          winner,
          tier,
          prizeIndex,
        ] as const,
      })),
    });
    const changed = statuses.some(
      (status) => status.status !== "success" || status.result,
    );
    if (changed) {
      throw new Error(
        "claim state changed before submission",
      );
    }

    const [latestNonce, pendingNonce, parent] = await Promise.all([
      client.getTransactionCount({
        address: signer.address,
        blockTag: "latest",
      }),
      client.getTransactionCount({
        address: signer.address,
        blockTag: "pending",
      }),
      client.getBlock(),
    ]);
    if (latestNonce !== pendingNonce) {
      throw new Error(
        `nonce blocked: latest=${latestNonce} pending=${pendingNonce}`,
      );
    }
    if (parent.baseFeePerGas === null) {
      throw new Error("latest block did not include a base fee");
    }

    const targetBlock = parent.number + 1n;
    const targetBaseFee = nextBaseFee(
      parent.baseFeePerGas,
      parent.gasUsed,
      parent.gasLimit,
    );
    const worstCaseTargetBaseFee =
      (parent.baseFeePerGas * 1_125n + 999n) / 1_000n;
    const requiredFeeCap =
      worstCaseTargetBaseFee + PRIORITY_FEE_PER_GAS;
    if (config.maxFeePerGas < requiredFeeCap) {
      throw new Error(
        "configured max fee does not cover the worst-case target base fee",
      );
    }
    // A 15M-gas claim signed at the global 5 gwei ceiling would fail the
    // sender-balance precheck despite costing far less at current base fees.
    const maxFeePerGas = requiredFeeCap;
    const feePerClaim = await client.readContract({
      address: batch.claimer,
      abi: claimAbi,
      functionName: "computeFeePerClaim",
      args: [tier, BigInt(batch.claimCount)],
    });
    const args = [
      batch.vault,
      tier,
      [...batch.winners],
      batch.prizeIndices.map((indices) => [...indices]),
      signer.address,
      feePerClaim,
    ] as const;
    const simulation = await client.simulateContract({
      address: batch.claimer,
      abi: claimAbi,
      functionName: "claimPrizes",
      args,
      account: signer,
    });
    const reward = simulation.result;
    const expectedReward = feePerClaim * BigInt(batch.claimCount);
    if (reward !== expectedReward) {
      throw new Error(
        `unexpected reward: expected ${expectedReward}, simulated ${reward}`,
      );
    }
    const claimEstimate = await client.estimateContractGas({
      address: batch.claimer,
      abi: claimAbi,
      functionName: "claimPrizes",
      args,
      account: signer,
    });
    if (claimEstimate > TRANSACTION_GAS_LIMIT) {
      throw new Error(
        `claim estimate ${claimEstimate} exceeds the transaction gas limit`,
      );
    }
    const bufferedClaimGas = (claimEstimate * 103n + 99n) / 100n;
    const claimGas =
      bufferedClaimGas > TRANSACTION_GAS_LIMIT
        ? TRANSACTION_GAS_LIMIT
        : bufferedClaimGas;
    const claimData = encodeFunctionData({
      abi: claimAbi,
      functionName: "claimPrizes",
      args,
    });
    const withdrawData = encodeFunctionData({
      abi: poolAbi,
      functionName: "withdrawRewards",
      args: [signer.address, reward],
    });
    const claimRaw = await signer.signTransaction({
      chainId: mainnet.id,
      type: "eip1559",
      to: batch.claimer,
      data: claimData,
      gas: claimGas,
      maxFeePerGas,
      maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
      nonce: latestNonce,
      value: 0n,
    });
    const withdrawRaw = await signer.signTransaction({
      chainId: mainnet.id,
      type: "eip1559",
      to: POOL,
      data: withdrawData,
      gas: 120_000n,
      maxFeePerGas,
      maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
      nonce: latestNonce + 1,
      value: 0n,
    });
    console.log(
      JSON.stringify({
        event: "pooltogether_bundle_prepared",
        attempt,
        targetBlock: targetBlock.toString(),
        lane: batch.lane,
        tier,
        claims: batch.claimCount,
        claimEstimate: claimEstimate.toString(),
        claimGas: claimGas.toString(),
      }),
    );

    if ((await client.getBlockNumber()) >= targetBlock) continue;

    const transactions = [claimRaw, withdrawRaw] as const;
    const bundleSimulation = await relays[0]!.callBundle(
      transactions,
      targetBlock,
    );
    let gas: bigint[];
    try {
      gas = simulatedGasUsed(bundleSimulation, transactions.length);
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "pooltogether_bundle_simulation_failed",
          targetBlock: targetBlock.toString(),
          results: bundleSimulation.results,
        }),
      );
      throw error;
    }
    const simulatedCost =
      (gas[0]! + gas[1]!) *
      (targetBaseFee + PRIORITY_FEE_PER_GAS);
    const net = reward - simulatedCost;
    if (net <= 0n) {
      console.log(
        JSON.stringify({
          event: "pooltogether_bundle_deferred",
          attempt,
          targetBlock: targetBlock.toString(),
          targetBaseFeeGwei: formatGwei(targetBaseFee),
          rewardWeth: formatEther(reward),
          simulatedCostEth: formatEther(simulatedCost),
          netEth: formatEther(net),
        }),
      );
      if (!execute) return;
      await waitForBlock(client, targetBlock);
      continue;
    }
    if (!execute) {
      console.log(
        JSON.stringify({
          event: "pooltogether_claim_profitable",
          targetBlock: targetBlock.toString(),
          lane: batch.lane,
          tier,
        vault: batch.vault,
          claims: batch.claimCount,
          rewardWeth: formatEther(reward),
          simulatedGas: gas.map(String),
          targetBaseFeeGwei: formatGwei(targetBaseFee),
          expectedNetEth: formatEther(net),
        }),
      );
      return;
    }

    const submissions = await submitBundleToRelays(
      relays,
      transactions,
      targetBlock,
      config.flashbotsBuilders,
    );
    const claimHash = keccak256(claimRaw);
    const withdrawHash = keccak256(withdrawRaw);
    console.log(
      JSON.stringify({
        event: "pooltogether_bundle_submitted",
        attempt,
        targetBlock: targetBlock.toString(),
        claimHash,
        withdrawHash,
        relays: submissions.length,
        targetBaseFeeGwei: formatGwei(targetBaseFee),
        priorityFeeGwei: formatGwei(PRIORITY_FEE_PER_GAS),
        rewardWeth: formatEther(reward),
        simulatedGas: gas.map(String),
        expectedNetEth: formatEther(net),
      }),
    );

    await waitForBlock(client, targetBlock);
    const [claimReceipt, withdrawReceipt] = await Promise.all([
      optionalReceipt(client, claimHash),
      optionalReceipt(client, withdrawHash),
    ]);
    if (claimReceipt !== undefined && withdrawReceipt !== undefined) {
      if (
        claimReceipt.status !== "success" ||
        withdrawReceipt.status !== "success"
      ) {
        throw new Error("included bundle contained a failed transaction");
      }
      const gasCost =
        claimReceipt.gasUsed * claimReceipt.effectiveGasPrice +
        withdrawReceipt.gasUsed * withdrawReceipt.effectiveGasPrice;
      confirmed = {
        claimHash,
        withdrawHash,
        reward,
        gasCost,
        block: claimReceipt.blockNumber,
        gasUsed: claimReceipt.gasUsed + withdrawReceipt.gasUsed,
      };
    }
  }

  if (confirmed === undefined) {
    throw new Error(
      `PoolTogether bundle was not included within ${attempts} target blocks`,
    );
  }

  const afterWeth = await client.readContract({
    address: WETH,
    abi: wethAbi,
    functionName: "balanceOf",
    args: [signer.address],
  });
  const paidReward = afterWeth - beforeWeth;
  const realizedProfit = paidReward - confirmed.gasCost;
  console.log(
    JSON.stringify({
      event: "pooltogether_bundle_confirmed",
      claimHash: confirmed.claimHash,
      withdrawHash: confirmed.withdrawHash,
      block: confirmed.block.toString(),
      gasUsed: confirmed.gasUsed.toString(),
      paidRewardWeth: formatEther(paidReward),
      gasCostEth: formatEther(confirmed.gasCost),
      realizedProfitEth: formatEther(realizedProfit),
    }),
  );
  notifier?.notify({
    time: new Date().toISOString(),
    level: "info",
    event: "keeper_receipt",
    hash: confirmed.claimHash,
    status: "success",
    kind: "pooltogether_prize_claim",
    label: `PoolTogether draw 24 tier ${prizeTier()} ${batch.lane} lane (${batch.claimCount} claims)`,
    block: confirmed.block.toString(),
    gasUsed: confirmed.gasUsed.toString(),
    paidReward: `${formatEther(paidReward)} ETH`,
    gasCost: `${formatEther(confirmed.gasCost)} ETH`,
    realizedProfit: `${formatEther(realizedProfit)} ETH`,
  });
  await notifier?.flush();
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "pooltogether_claim_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
