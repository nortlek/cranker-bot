import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  type Account,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { factoryAbi, standingOrderAbi } from "./abi.js";
import { CHAIN_ID } from "./constants.js";
import { loadConfig } from "./config.js";
import {
  FlashbotsRelay,
  longestValidBundlePrefix,
  submitBundleToRelays,
} from "./flashbots.js";
import { errorMessage, eth, log } from "./format.js";
import { runPass, type KeeperContext } from "./keeper.js";

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`expected Ethereum mainnet chain id 1, received ${chainId}`);
  }

  const poolAddress = getAddress(
    await publicClient.readContract({
      address: config.factoryAddress,
      abi: factoryAbi,
      functionName: "POOL",
    }),
  );
  if (poolAddress !== config.expectedPoolAddress) {
    throw new Error(
      `factory pool ${poolAddress} does not match expected pool ${config.expectedPoolAddress}`,
    );
  }

  let account: Account | Address = config.simulationAccount;
  let sendCrank: KeeperContext["sendCrank"] = undefined;
  let sendCrankBatch: KeeperContext["sendCrankBatch"] = undefined;
  if (config.privateKey !== undefined) {
    const signer = privateKeyToAccount(config.privateKey);
    account = signer;
    const walletClient = createWalletClient({
      account: signer,
      chain: mainnet,
      transport: http(config.rpcUrl, {
        retryCount: 3,
        retryDelay: 500,
        timeout: 20_000,
      }),
    });
    if (config.submissionMode === "public") {
      sendCrank = async ({
        order,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
      }) =>
        walletClient.writeContract({
          address: order,
          abi: standingOrderAbi,
          functionName: "crank",
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        });
    } else {
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
      sendCrankBatch = async ({ requests, targetBlock }) => {
        const transactions = await Promise.all(
          requests.map((request) =>
            signer.signTransaction({
              chainId: mainnet.id,
              type: "eip1559",
              to: request.order,
              data: encodeFunctionData({
                abi: standingOrderAbi,
                functionName: "crank",
              }),
              gas: request.gas,
              maxFeePerGas: request.maxFeePerGas,
              maxPriorityFeePerGas: request.maxPriorityFeePerGas,
              nonce: request.nonce,
              value: 0n,
            }),
          ),
        );
        const prefixLength = await longestValidBundlePrefix(
          relays[0]!,
          transactions,
          targetBlock,
        );
        if (prefixLength === 0) {
          return { hashes: [], targetBlock, relayCount: 0 };
        }
        const selected = transactions.slice(0, prefixLength);
        const submissions = await submitBundleToRelays(
          relays,
          selected,
          targetBlock,
          config.flashbotsBuilders,
        );
        return {
          hashes: selected.map((transaction) => keccak256(transaction)),
          targetBlock,
          relayCount: submissions.length,
        };
      };
    }
  } else if (!config.dryRun) {
    throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  }

  const accountAddress =
    typeof account === "string" ? account : account.address;
  const balance = await publicClient.getBalance({ address: accountAddress });
  log("info", "keeper_started", {
    chainId,
    factory: config.factoryAddress,
    pool: poolAddress,
    account: accountAddress,
    accountBalance: eth(balance),
    dryRun: config.dryRun,
    runOnce: config.runOnce,
    submissionMode: config.submissionMode,
    relayCount: config.flashbotsRelayUrls.length,
    builderCount: config.flashbotsBuilders.length,
  });

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let lastProcessedBlock = -1n;
  do {
    try {
      const block = await publicClient.getBlockNumber();
      if (block !== lastProcessedBlock) {
        lastProcessedBlock = block;
        log("debug", "new_block", { block: block.toString() });
        await runPass({
          publicClient,
          account,
          config,
          sendCrank,
          sendCrankBatch,
        });
        if (config.runOnce) break;
      }
    } catch (error) {
      log("error", "keeper_pass_failed", { reason: errorMessage(error) });
      if (config.runOnce) throw error;
    }
    if (!stopping) await sleep(config.blockPollMs);
  } while (!stopping);

  log("info", "keeper_stopped");
}

main().catch((error: unknown) => {
  log("error", "fatal", { reason: errorMessage(error) });
  process.exitCode = 1;
});
