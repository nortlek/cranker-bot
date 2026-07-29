import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  http,
  keccak256,
  maxUint256,
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

const PAIR = getAddress("0x73c5Ea935455C0423a4FBA9A4874b7E4ebd01a94");
const ROUTER = getAddress("0x7c210be12bcef8090610914189a0de43e2192ea0");
const A_WETH = getAddress("0xfA1fDbBD71B0aA16162D76914d69cD8CB3Ef92da");
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const PRIORITY_FEE_PER_GAS = 1_000_000n;
const MINIMUM_NET_WEI = 200_000_000_000n;

const pairAbi = parseAbi([
  "function tokenOut() view returns(address)",
  "function maxAmountOut() view returns(uint256)",
  "function computeExactAmountIn(uint256) view returns(uint256)",
]);
const routerAbi = parseAbi([
  "function swapExactAmountOut(address,address,uint256,uint256,uint256) returns(uint256)",
]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
]);
const aTokenAbi = parseAbi([
  "function UNDERLYING_ASSET_ADDRESS() view returns(address)",
  "function POOL() view returns(address)",
]);
const aavePoolAbi = parseAbi([
  "function withdraw(address,uint256,address) returns(uint256)",
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

  const [tokenOut, underlying, aavePool, beforeEth, beforeWeth] =
    await Promise.all([
    client.readContract({
      address: PAIR,
      abi: pairAbi,
      functionName: "tokenOut",
    }),
    client.readContract({
      address: A_WETH,
      abi: aTokenAbi,
      functionName: "UNDERLYING_ASSET_ADDRESS",
    }),
    client.readContract({
      address: A_WETH,
      abi: aTokenAbi,
      functionName: "POOL",
    }),
    client.getBalance({ address: signer.address }),
    client.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [signer.address],
    }),
  ]);
  if (getAddress(tokenOut) !== A_WETH || getAddress(underlying) !== WETH) {
    throw new Error("unexpected TPDA or Aave token configuration");
  }

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
    const [latestNonce, pendingNonce, parent, amountOut] =
      await Promise.all([
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
      ]);
    if (latestNonce !== pendingNonce) {
      throw new Error(
        `nonce blocked: latest=${latestNonce} pending=${pendingNonce}`,
      );
    }
    if (parent.baseFeePerGas === null) {
      throw new Error("latest block did not include a base fee");
    }
    if (amountOut === 0n) {
      throw new Error("the aWETH liquidation pair has no available output");
    }
    const amountInMax = await client.readContract({
      address: PAIR,
      abi: pairAbi,
      functionName: "computeExactAmountIn",
      args: [amountOut],
    });
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
        amountOut,
        amountInMax,
        parent.timestamp + 120n,
      ],
    });
    const withdrawData = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "withdraw",
      // Interest-index rounding can make the received aToken balance a few
      // wei smaller than the pair's nominal amount out.
      args: [WETH, maxUint256, signer.address],
    });
    const unsigned = [
      { to: WETH, data: approveData, gas: 65_000n },
      { to: ROUTER, data: swapData, gas: 1_000_000n },
      { to: getAddress(aavePool), data: withdrawData, gas: 800_000n },
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
          event: "pooltogether_tpda_aweth_simulation_failed",
          attempt,
          targetBlock: targetBlock.toString(),
          results: simulation.results,
        }),
      );
      throw error;
    }
    const totalGas = gas.reduce((sum, value) => sum + value, 0n);
    // The EIP-1559 base fee of the immediate child block is deterministic
    // from the parent; use it for the economic gate while retaining the
    // worst-case value only as the signed fee-cap coverage check above.
    const targetGasCost =
      totalGas * (targetBaseFee + PRIORITY_FEE_PER_GAS);
    const expectedNet = amountOut - amountInMax - targetGasCost;

    console.log(
      JSON.stringify({
        event: "pooltogether_tpda_aweth_simulated",
        execute,
        attempt,
        targetBlock: targetBlock.toString(),
        targetBaseFeeGwei: formatGwei(targetBaseFee),
        worstCaseBaseFeeGwei: formatGwei(worstCaseTargetBaseFee),
        amountOutAweth: formatEther(amountOut),
        amountInWeth: formatEther(amountInMax),
        simulatedGas: gas.map(String),
        targetGasCostEth: formatEther(targetGasCost),
        expectedNetEth: formatEther(expectedNet),
      }),
    );

    if (!execute) break;
    if (expectedNet < MINIMUM_NET_WEI) {
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
        event: "pooltogether_tpda_aweth_submitted",
        attempt,
        targetBlock: targetBlock.toString(),
        hashes,
        relays: submissions.length,
        expectedNetEth: formatEther(expectedNet),
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
      `PoolTogether TPDA aWETH bundle was not included within ${attempts} target blocks`,
    );
  }

  const [afterEth, afterWeth] = await Promise.all([
    client.getBalance({ address: signer.address }),
    client.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [signer.address],
    }),
  ]);
  const wethProfit = afterWeth - beforeWeth;
  const ethSpent = beforeEth - afterEth;
  const realizedProfit = wethProfit - ethSpent;

  console.log(
    JSON.stringify({
      event: "pooltogether_tpda_aweth_confirmed",
      hashes: confirmed.hashes,
      block: confirmed.block.toString(),
      gasUsed: confirmed.gasUsed.toString(),
      wethProfit: formatEther(wethProfit),
      gasCostEth: formatEther(confirmed.gasCost),
      realizedProfitEth: formatEther(realizedProfit),
    }),
  );
  notifier?.notify({
    time: new Date().toISOString(),
    level: "info",
    event: "keeper_receipt",
    hash: confirmed.hashes[1],
    status: "success",
    kind: "pooltogether_tpda",
    label: "PoolTogether TPDA aWETH liquidation",
    block: confirmed.block.toString(),
    gasUsed: confirmed.gasUsed.toString(),
    paidReward: `${formatEther(wethProfit)} WETH`,
    gasCost: `${formatEther(confirmed.gasCost)} ETH`,
    realizedProfit: `${formatEther(realizedProfit)} ETH`,
  });
  await notifier?.flush();
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "pooltogether_tpda_aweth_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
