import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Account,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { factoryAbi, standingOrderAbi } from "./abi.js";
import { CHAIN_ID } from "./constants.js";
import { loadConfig } from "./config.js";
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
