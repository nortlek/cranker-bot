import "dotenv/config";

import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

import { fwaAbi } from "../src/abi.js";
import { GACHA_TABLE_ADDRESS, PULL_POOL_FWA_ADDRESS } from "../src/constants.js";
import {
  GACHA_TABLE_STATE,
  ETHEREUM_SLOT_SECONDS,
  gachaTableAbi,
  gachaTableAcquisitionsAreTerminal,
  gachaTableDefaultDueAt,
  readGachaTableSnapshot,
  verifyGachaTableRuntime,
} from "../src/gacha-table.js";
import { gachaTableKeeperExecutorDeployment } from "../src/gacha-table-keeper-executor.js";

const fwaInspectionAbi = parseAbi([
  "function settlementWindow() view returns (uint256)",
  "function listings(uint256 listingId) view returns (address collection,address depositor,address purchaser,uint256 tokenId,uint256 weight,uint256 value,uint256 feeShare,uint256 feeDebt,uint256 slot,uint64 allocatedAt,uint8 status)",
]);

const client = createPublicClient({
  chain: mainnet,
  transport: http(
    process.env.RPC_URL || "https://ethereum-rpc.publicnode.com",
  ),
});
const account = getAddress(
  process.env.SIMULATION_ACCOUNT ||
    "0x000000000000000000000000000000000000dEaD",
);

function stateName(state: number): string {
  return (
    Object.entries(GACHA_TABLE_STATE).find(([, value]) => value === state)?.[0] ??
    `UNKNOWN_${state}`
  );
}

async function estimateReady(parameters: {
  readonly functionName: "fire" | "crankDefault";
  readonly args: readonly [bigint] | readonly [bigint, number];
}): Promise<boolean> {
  try {
    await client.estimateContractGas({
      account,
      address: GACHA_TABLE_ADDRESS,
      abi: gachaTableAbi,
      functionName: parameters.functionName,
      args: parameters.args as never,
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const block = await client.getBlock();
  if (block.number === null) throw new Error("latest block has no number");
  await verifyGachaTableRuntime({ client, blockNumber: block.number });
  const [snapshot, settlementWindow] = await Promise.all([
    readGachaTableSnapshot({ client, blockNumber: block.number }),
    client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: fwaInspectionAbi,
      functionName: "settlementWindow",
      blockNumber: block.number,
    }),
  ]);
  const executor = gachaTableKeeperExecutorDeployment(account);
  const executorCode = await client.getCode({
    address: executor.address,
    blockNumber: block.number,
  });
  const battles: unknown[] = [];
  for (const entry of snapshot.battles) {
    const { battleId, battle } = entry;
    if (
      battle.state === GACHA_TABLE_STATE.CLOSED ||
      battle.state === GACHA_TABLE_STATE.VOID
    ) {
      continue;
    }
    if (battle.state === GACHA_TABLE_STATE.FILLED) {
      battles.push({
        battleId: battleId.toString(),
        state: stateName(battle.state),
        filledAt: battle.filledAt.toString(),
        fireReady: await estimateReady({
          functionName: "fire",
          args: [battleId],
        }),
      });
      continue;
    }
    if (battle.state === GACHA_TABLE_STATE.FIRED) {
      const acquisitions = await client.multicall({
        allowFailure: false,
        blockNumber: block.number,
        contracts: battle.requestIds.map((requestId) => ({
          address: PULL_POOL_FWA_ADDRESS,
          abi: fwaAbi,
          functionName: "acquisitions" as const,
          args: [requestId] as const,
        })),
      });
      const statuses = acquisitions.map((acquisition) => acquisition[4]);
      battles.push({
        battleId: battleId.toString(),
        state: stateName(battle.state),
        requestIds: battle.requestIds.map(String),
        acquisitionStatuses: statuses,
        settleRewardReady: gachaTableAcquisitionsAreTerminal(statuses),
      });
      continue;
    }
    if (battle.state === GACHA_TABLE_STATE.SETTLED) {
      const legs = await client.multicall({
        allowFailure: false,
        blockNumber: block.number,
        contracts: Array.from({ length: 4 }, (_, leg) => ({
          address: GACHA_TABLE_ADDRESS,
          abi: gachaTableAbi,
          functionName: "legs" as const,
          args: [battleId, leg] as const,
        })),
      });
      const unresolved: unknown[] = [];
      for (let leg = 0; leg < legs.length; leg += 1) {
        const value = legs[leg];
        if (value === undefined || value.resolved) continue;
        const listing = await client.readContract({
          address: PULL_POOL_FWA_ADDRESS,
          abi: fwaInspectionAbi,
          functionName: "listings",
          args: [value.listingId],
          blockNumber: block.number,
        });
        const dueAt = gachaTableDefaultDueAt({
          allocatedAt: listing[9],
          settlementWindow,
        });
        unresolved.push({
          leg,
          listingId: value.listingId.toString(),
          allocatedAt: listing[9].toString(),
          dueAt: dueAt.toString(),
          due: block.timestamp >= dueAt,
          dueInNextBlock:
            dueAt <= block.timestamp + ETHEREUM_SLOT_SECONDS,
          defaultReady:
            block.timestamp >= dueAt &&
            (await estimateReady({
              functionName: "crankDefault",
              args: [battleId, leg],
            })),
        });
      }
      battles.push({
        battleId: battleId.toString(),
        state: stateName(battle.state),
        winner: battle.winner,
        unresolved,
      });
      continue;
    }
    battles.push({
      battleId: battleId.toString(),
      state: stateName(battle.state),
      seatsTaken: battle.seatsTaken,
      openedAt: battle.openedAt.toString(),
    });
  }

  console.log(
    JSON.stringify(
      {
        block: block.number.toString(),
        blockTimestamp: block.timestamp.toString(),
        currentBattleId: snapshot.currentBattleId.toString(),
        firstBattleIdScanned: snapshot.firstBattleId.toString(),
        scannedBattles: snapshot.battles.length,
        feePool: snapshot.feePool.toString(),
        bountyFlat: snapshot.bountyFlat.toString(),
        executor: {
          address: executor.address,
          deployed: executorCode !== undefined && executorCode !== "0x",
          runtimeMatches:
            executorCode !== undefined &&
            executorCode !== "0x" &&
            keccak256(executorCode) === executor.expectedRuntimeCodeHash,
        },
        battles,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
