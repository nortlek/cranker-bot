import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";
import { DiscordWebhookNotifier } from "../src/discord.js";
import {
  FlashbotsRelay,
  simulatedGasUsed,
  submitBundleToRelays,
} from "../src/flashbots.js";

const PAIR = getAddress("0xBC5eaDA31d8F2eE2BDA02231A6602579Cf0bd30e");
const ROUTER = getAddress("0x7c210be12bcef8090610914189a0de43e2192ea0");
const PRIZE_VAULT = getAddress(
  "0x4147cB38FAe27a737ECd55551d3315fEc11c28d2",
);
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const DAI = getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F");
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const DAI_USD_FEED = getAddress(
  "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
);
const PRIORITY_FEE_PER_GAS = 1_000_000n;
const MINIMUM_NET_USD_8 = 200_000n; // $0.002 after worst-case gas.

const pairAbi = parseAbi([
  "function maxAmountOut() view returns(uint256)",
  "function computeExactAmountIn(uint256) view returns(uint256)",
]);
const routerAbi = parseAbi([
  "function swapExactAmountOut(address,address,uint256,uint256,uint256) returns(uint256)",
]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
]);
const vaultAbi = parseAbi([
  "function asset() view returns(address)",
  "function previewRedeem(uint256) view returns(uint256)",
  "function redeem(uint256,address,address) returns(uint256)",
]);
const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

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

function formatUsd8(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  return `${sign}${formatUnits(magnitude, 8)}`;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const config = loadConfig();
  if (config.privateKey === undefined) {
    throw new Error("PRIVATE_KEY is required to sign the simulation");
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

  const asset = await client.readContract({
    address: PRIZE_VAULT,
    abi: vaultAbi,
    functionName: "asset",
  });
  if (getAddress(asset) !== DAI) {
    throw new Error(`unexpected prize vault asset ${asset}`);
  }

  const [beforeEth, beforeWeth, beforeDai] = await Promise.all([
    client.getBalance({ address: signer.address }),
    client.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [signer.address],
    }),
    client.readContract({
      address: DAI,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [signer.address],
    }),
  ]);

  let confirmed:
    | {
        readonly hashes: readonly [Hash, Hash, Hash];
        readonly block: bigint;
        readonly gasUsed: bigint;
        readonly gasCost: bigint;
      }
    | undefined;
  const attempts = execute ? 12 : 1;

  for (let attempt = 1; attempt <= attempts && confirmed === undefined; attempt += 1) {
    const [
      latestNonce,
      pendingNonce,
      parent,
      maxAmountOut,
      ethRound,
      daiRound,
      allowance,
    ] = await Promise.all([
      client.getTransactionCount({
        address: signer.address,
        blockTag: "latest",
      }),
      client.getTransactionCount({
        address: signer.address,
        blockTag: "pending",
      }),
      client.getBlock(),
      client.readContract({
        address: PAIR,
        abi: pairAbi,
        functionName: "maxAmountOut",
      }),
      client.readContract({
        address: ETH_USD_FEED,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: DAI_USD_FEED,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "allowance",
        args: [signer.address, ROUTER],
      }),
    ]);
    if (latestNonce !== pendingNonce) {
      throw new Error(
        `nonce blocked: latest=${latestNonce} pending=${pendingNonce}`,
      );
    }
    if (parent.baseFeePerGas === null) {
      throw new Error("latest block did not include a base fee");
    }
    if (maxAmountOut === 0n) {
      throw new Error("the DAI liquidation pair has no available output");
    }
    if (ethRound[1] <= 0n || daiRound[1] <= 0n) {
      throw new Error("Chainlink returned a non-positive price");
    }
    if (
      BigInt(Math.floor(Date.now() / 1_000)) - ethRound[3] > 7_200n ||
      BigInt(Math.floor(Date.now() / 1_000)) - daiRound[3] > 90_000n
    ) {
      throw new Error("Chainlink price is stale");
    }

    const [amountInMax, redeemAssets] = await Promise.all([
      client.readContract({
        address: PAIR,
        abi: pairAbi,
        functionName: "computeExactAmountIn",
        args: [maxAmountOut],
      }),
      client.readContract({
        address: PRIZE_VAULT,
        abi: vaultAbi,
        functionName: "previewRedeem",
        args: [maxAmountOut],
      }),
    ]);
    if (amountInMax > beforeWeth) {
      throw new Error(
        `insufficient WETH: need ${formatEther(amountInMax)}, have ${formatEther(beforeWeth)}`,
      );
    }

    const targetBlock = parent.number + 1n;
    const targetBaseFee = nextBaseFee(
      parent.baseFeePerGas,
      parent.gasUsed,
      parent.gasLimit,
    );
    const worstCaseTargetBaseFee =
      (parent.baseFeePerGas * 1_125n + 999n) / 1_000n;
    if (
      config.maxFeePerGas <
      worstCaseTargetBaseFee + PRIORITY_FEE_PER_GAS
    ) {
      throw new Error(
        "configured max fee does not cover the worst-case target base fee",
      );
    }

    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ROUTER, amountInMax],
    });
    const swapData = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactAmountOut",
      args: [
        PAIR,
        signer.address,
        maxAmountOut,
        amountInMax,
        parent.timestamp + 120n,
      ],
    });
    const redeemData = encodeFunctionData({
      abi: vaultAbi,
      functionName: "redeem",
      args: [maxAmountOut, signer.address, signer.address],
    });
    const approvalRequired = allowance < amountInMax;
    const unsigned = [
      // Keep the bundle shape deterministic and make the exact allowance part
      // of the same atomic state transition as the swap.
      { to: WETH, data: approveData, gas: 65_000n },
      { to: ROUTER, data: swapData, gas: 400_000n },
      { to: PRIZE_VAULT, data: redeemData, gas: 1_200_000n },
    ] as const;
    const transactions = await Promise.all(
      unsigned.map((transaction, index) =>
        signer.signTransaction({
          chainId: mainnet.id,
          type: "eip1559",
          to: transaction.to,
          data: transaction.data,
          gas: transaction.gas,
          maxFeePerGas: config.maxFeePerGas,
          maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
          nonce: latestNonce + index,
          value: 0n,
        }),
      ),
    );
    if ((await client.getBlockNumber()) >= targetBlock) continue;

    const simulation = await relays[0]!.callBundle(
      transactions,
      targetBlock,
    );
    let gas: bigint[];
    try {
      gas = simulatedGasUsed(simulation, transactions.length);
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "pooltogether_tpda_simulation_failed",
          attempt,
          targetBlock: targetBlock.toString(),
          results: simulation.results,
        }),
      );
      throw error;
    }
    const totalGas = gas.reduce((sum, value) => sum + value, 0n);
    const worstCaseGasCost =
      totalGas * (worstCaseTargetBaseFee + PRIORITY_FEE_PER_GAS);
    const outputUsd8 = (redeemAssets * daiRound[1]) / 10n ** 18n;
    const inputUsd8 = (amountInMax * ethRound[1]) / 10n ** 18n;
    const gasUsd8 = (worstCaseGasCost * ethRound[1]) / 10n ** 18n;
    const netUsd8 = outputUsd8 - inputUsd8 - gasUsd8;
    const netEthEquivalent =
      (netUsd8 * 10n ** 18n) / ethRound[1];

    console.log(
      JSON.stringify({
        event: "pooltogether_tpda_dai_simulated",
        execute,
        attempt,
        targetBlock: targetBlock.toString(),
        targetBaseFeeGwei: formatGwei(targetBaseFee),
        worstCaseBaseFeeGwei: formatGwei(worstCaseTargetBaseFee),
        amountOutShares: formatEther(maxAmountOut),
        redeemDai: formatEther(redeemAssets),
        amountInWeth: formatEther(amountInMax),
        approvalRequired,
        simulatedGas: gas.map(String),
        worstCaseGasCostEth: formatEther(worstCaseGasCost),
        expectedNetUsd: formatUsd8(netUsd8),
        expectedNetEthEquivalent: formatEther(netEthEquivalent),
      }),
    );

    if (!execute) break;
    if (netUsd8 < MINIMUM_NET_USD_8) {
      await waitForBlock(client, targetBlock);
      continue;
    }

    const submissions = await submitBundleToRelays(
      relays,
      transactions,
      targetBlock,
      config.flashbotsBuilders,
    );
    const hashes = transactions.map(keccak256) as [Hash, Hash, Hash];
    console.log(
      JSON.stringify({
        event: "pooltogether_tpda_dai_submitted",
        attempt,
        targetBlock: targetBlock.toString(),
        hashes,
        relays: submissions.length,
        expectedNetUsd: formatUsd8(netUsd8),
      }),
    );

    await waitForBlock(client, targetBlock);
    const receipts = await Promise.all(
      hashes.map((hash) => optionalReceipt(client, hash)),
    );
    if (receipts.every((receipt) => receipt !== undefined)) {
      if (receipts.some((receipt) => receipt?.status !== "success")) {
        throw new Error("included bundle contained a failed transaction");
      }
      const completeReceipts = receipts.filter(
        (receipt) => receipt !== undefined,
      );
      confirmed = {
        hashes,
        block: completeReceipts[0]!.blockNumber,
        gasUsed: completeReceipts.reduce(
          (sum, receipt) => sum + receipt.gasUsed,
          0n,
        ),
        gasCost: completeReceipts.reduce(
          (sum, receipt) =>
            sum + receipt.gasUsed * receipt.effectiveGasPrice,
          0n,
        ),
      };
    }
  }

  if (!execute) return;
  if (confirmed === undefined) {
    throw new Error(
      `PoolTogether TPDA DAI bundle was not included within ${attempts} target blocks`,
    );
  }

  const [afterEth, afterWeth, afterDai, ethRound, daiRound] =
    await Promise.all([
      client.getBalance({ address: signer.address }),
      client.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [signer.address],
      }),
      client.readContract({
        address: DAI,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [signer.address],
      }),
      client.readContract({
        address: ETH_USD_FEED,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: DAI_USD_FEED,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
    ]);
  const wethSpent = beforeWeth - afterWeth;
  const daiReceived = afterDai - beforeDai;
  const ethSpent = beforeEth - afterEth;
  const realizedUsd8 =
    (daiReceived * daiRound[1]) / 10n ** 18n -
    (wethSpent * ethRound[1]) / 10n ** 18n -
    (ethSpent * ethRound[1]) / 10n ** 18n;
  const realizedEthEquivalent =
    (realizedUsd8 * 10n ** 18n) / ethRound[1];

  console.log(
    JSON.stringify({
      event: "pooltogether_tpda_dai_confirmed",
      hashes: confirmed.hashes,
      block: confirmed.block.toString(),
      gasUsed: confirmed.gasUsed.toString(),
      daiReceived: formatEther(daiReceived),
      wethSpent: formatEther(wethSpent),
      gasCostEth: formatEther(confirmed.gasCost),
      realizedProfitUsd: formatUsd8(realizedUsd8),
      realizedProfitEthEquivalent: formatEther(realizedEthEquivalent),
    }),
  );
  notifier?.notify({
    time: new Date().toISOString(),
    level: "info",
    event: "keeper_receipt",
    hash: confirmed.hashes[1],
    status: "success",
    kind: "pooltogether_tpda",
    label: "PoolTogether TPDA przDAI liquidation",
    block: confirmed.block.toString(),
    gasUsed: confirmed.gasUsed.toString(),
    paidReward: `${formatEther(daiReceived)} DAI`,
    gasCost: `${formatEther(confirmed.gasCost)} ETH`,
    realizedProfit: `${formatEther(realizedEthEquivalent)} ETH`,
  });
  await notifier?.flush();
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "pooltogether_tpda_dai_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
