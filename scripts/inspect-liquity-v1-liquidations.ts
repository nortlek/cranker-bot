import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";

const TROVE_MANAGER = getAddress(
  "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
);
const PRICE_FEED = getAddress(
  "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De",
);
const SORTED_TROVES = getAddress(
  "0x8FdD3fbFEb32b28fb73555518f8b361bCeA741A6",
);

const troveManagerAbi = parseAbi([
  "function getCurrentICR(address,uint256) view returns(uint256)",
  "function getEntireDebtAndColl(address) view returns(uint256 debt,uint256 coll,uint256 pendingLUSDDebtReward,uint256 pendingETHReward)",
  "function getTCR(uint256) view returns(uint256)",
  "function checkRecoveryMode(uint256) view returns(bool)",
  "function liquidateTroves(uint256)",
]);
const priceFeedAbi = parseAbi([
  "function lastGoodPrice() view returns(uint256)",
]);
const sortedTrovesAbi = parseAbi([
  "function getSize() view returns(uint256)",
  "function getLast() view returns(address)",
]);

function percent(value: bigint): string {
  const basisPoints = (value * 10_000n) / 10n ** 18n;
  return `${basisPoints / 100n}.${(basisPoints % 100n)
    .toString()
    .padStart(2, "0")}%`;
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
  const account =
    config.privateKey === undefined
      ? config.simulationAccount
      : privateKeyToAccount(config.privateKey);
  const [size, lowest, price] = await Promise.all([
    client.readContract({
      address: SORTED_TROVES,
      abi: sortedTrovesAbi,
      functionName: "getSize",
    }),
    client.readContract({
      address: SORTED_TROVES,
      abi: sortedTrovesAbi,
      functionName: "getLast",
    }),
    client.readContract({
      address: PRICE_FEED,
      abi: priceFeedAbi,
      functionName: "lastGoodPrice",
    }),
  ]);
  const [icr, trove, tcr, recoveryMode] = await Promise.all([
    client.readContract({
      address: TROVE_MANAGER,
      abi: troveManagerAbi,
      functionName: "getCurrentICR",
      args: [lowest, price],
    }),
    client.readContract({
      address: TROVE_MANAGER,
      abi: troveManagerAbi,
      functionName: "getEntireDebtAndColl",
      args: [lowest],
    }),
    client.readContract({
      address: TROVE_MANAGER,
      abi: troveManagerAbi,
      functionName: "getTCR",
      args: [price],
    }),
    client.readContract({
      address: TROVE_MANAGER,
      abi: troveManagerAbi,
      functionName: "checkRecoveryMode",
      args: [price],
    }),
  ]);
  let estimatedGas: bigint | undefined;
  let simulationError: string | undefined;
  try {
    estimatedGas = await client.estimateContractGas({
      account,
      address: TROVE_MANAGER,
      abi: troveManagerAbi,
      functionName: "liquidateTroves",
      args: [1n],
    });
  } catch (error) {
    simulationError =
      error instanceof Error ? error.message.split("\n")[0] : String(error);
  }

  console.log(
    JSON.stringify({
      event: "liquity_v1_liquidation_scan",
      troveManager: TROVE_MANAGER,
      troves: size.toString(),
      lowestTrove: lowest,
      lowestIcr: percent(icr),
      lowestDebtLusd: formatEther(trove[0]),
      lowestCollateralEth: formatEther(trove[1]),
      priceUsd: formatEther(price),
      tcr: percent(tcr),
      recoveryMode,
      liquidatable: estimatedGas !== undefined,
      ...(estimatedGas === undefined
        ? { simulationError }
        : { estimatedGas: estimatedGas.toString() }),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "liquity_v1_liquidation_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
