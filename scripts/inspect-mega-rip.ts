import "dotenv/config";

import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";

import {
  FWA_TOKEN_ADDRESS,
  MEGA_RIP_ADDRESS,
  MEGA_RIP_DEPLOYMENT_BLOCK,
  MEGA_RIP_FWA_REWARDS_ADDRESS,
  MEGA_RIP_RUNTIME_CODE_HASH,
  PULL_POOL_FWA_ADDRESS,
} from "../src/constants.js";
import {
  MEGA_RIP_STATE,
  megaRipAbi,
  readMegaRipState,
  verifyMegaRipRuntime,
} from "../src/mega-rip.js";
import {
  MEGA_RIP_KEEPER_EXECUTOR_DEPLOY_GAS_LIMIT,
  megaRipKeeperExecutorDeployment,
} from "../src/mega-rip-keeper-executor.js";
import { errorFingerprint } from "../src/format.js";
import { SINGLETON_FACTORY_ADDRESS } from "../src/standing-order-batch-executor.js";

const CANONICAL_DEPLOYER = getAddress(
  "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
);
const DEPLOYMENT_TRANSACTION =
  "0x42b70312ce38793a8888b79150255f0b1356ea6d5248ef31ed04e6c195fb1667";
const DEPLOYER_NONCE = 3470;

const fwaInspectionAbi = parseAbi([
  "function quoteAcquisitionPrice() view returns (uint256 fee,uint256 vrf,uint256 total)",
  "function activeListingCount() view returns (uint256)",
  "function nextSequenceToProcess() view returns (uint64)",
  "function lastIssuedSequence() view returns (uint64)",
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
    Object.entries(MEGA_RIP_STATE).find(
      ([, value]) => value === state,
    )?.[0] ?? `UNKNOWN_${state}`
  );
}

function iso(timestamp: bigint): string | undefined {
  return timestamp === 0n
    ? undefined
    : new Date(Number(timestamp) * 1_000).toISOString();
}

async function main(): Promise<void> {
  const block = await client.getBlock();
  if (block.number === null) throw new Error("latest block has no number");
  await verifyMegaRipRuntime({
    client,
    blockNumber: block.number,
  });

  const [
    state,
    code,
    deployment,
    deploymentReceipt,
    quote,
    activeListings,
    nextSequence,
    lastIssuedSequence,
    keeperLatestNonce,
    keeperPendingNonce,
    deployerLatestNonce,
    deployerPendingNonce,
  ] = await Promise.all([
    readMegaRipState({ client, blockNumber: block.number }),
    client.getCode({
      address: MEGA_RIP_ADDRESS,
      blockNumber: block.number,
    }),
    client.getTransaction({ hash: DEPLOYMENT_TRANSACTION }),
    client.getTransactionReceipt({ hash: DEPLOYMENT_TRANSACTION }),
    client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: fwaInspectionAbi,
      functionName: "quoteAcquisitionPrice",
      blockNumber: block.number,
    }),
    client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: fwaInspectionAbi,
      functionName: "activeListingCount",
      blockNumber: block.number,
    }),
    client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: fwaInspectionAbi,
      functionName: "nextSequenceToProcess",
      blockNumber: block.number,
    }),
    client.readContract({
      address: PULL_POOL_FWA_ADDRESS,
      abi: fwaInspectionAbi,
      functionName: "lastIssuedSequence",
      blockNumber: block.number,
    }),
    client.getTransactionCount({
      address: account,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: account,
      blockTag: "pending",
    }),
    client.getTransactionCount({
      address: CANONICAL_DEPLOYER,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: CANONICAL_DEPLOYER,
      blockTag: "pending",
    }),
  ]);

  if (
    code === undefined ||
    keccak256(code) !== MEGA_RIP_RUNTIME_CODE_HASH
  ) {
    throw new Error("MegaRip runtime mismatch");
  }
  if (
    deployment.blockNumber !== MEGA_RIP_DEPLOYMENT_BLOCK ||
    deployment.nonce !== DEPLOYER_NONCE ||
    deployment.to !== null ||
    !isAddressEqual(deployment.from, CANONICAL_DEPLOYER) ||
    deploymentReceipt.contractAddress === null ||
    !isAddressEqual(
      deploymentReceipt.contractAddress,
      MEGA_RIP_ADDRESS,
    )
  ) {
    throw new Error("MegaRip creation provenance mismatch");
  }

  const [fwa, token, rewards] = await Promise.all([
    client.readContract({
      address: MEGA_RIP_ADDRESS,
      abi: megaRipAbi,
      functionName: "FWA",
      blockNumber: block.number,
    }),
    client.readContract({
      address: MEGA_RIP_ADDRESS,
      abi: megaRipAbi,
      functionName: "FWA_TOKEN",
      blockNumber: block.number,
    }),
    client.readContract({
      address: MEGA_RIP_ADDRESS,
      abi: megaRipAbi,
      functionName: "FWA_REWARDS",
      blockNumber: block.number,
    }),
  ]);
  if (
    !isAddressEqual(fwa, PULL_POOL_FWA_ADDRESS) ||
    !isAddressEqual(token, FWA_TOKEN_ADDRESS) ||
    !isAddressEqual(rewards, MEGA_RIP_FWA_REWARDS_ADDRESS)
  ) {
    throw new Error("MegaRip immutable relationship mismatch");
  }

  const unitCost = quote[2] + state.bounty * 3n;
  const fundingAffordablePulls =
    unitCost === 0n ? 0n : state.totalDeposited / unitCost;
  const executor = megaRipKeeperExecutorDeployment(account);
  const executorCode = await client.getCode({
    address: executor.address,
    blockNumber: block.number,
  });
  if (
    executorCode !== undefined &&
    executorCode !== "0x" &&
    keccak256(executorCode) !== executor.expectedRuntimeCodeHash
  ) {
    throw new Error("MegaRip executor runtime mismatch");
  }
  const executorDeployGas =
    executorCode !== undefined && executorCode !== "0x"
      ? 0n
      : await client.estimateGas({
          account,
          to: SINGLETON_FACTORY_ADDRESS,
          data: executor.deployData,
          blockNumber: block.number,
        });
  if (
    executorDeployGas > MEGA_RIP_KEEPER_EXECUTOR_DEPLOY_GAS_LIMIT
  ) {
    throw new Error("MegaRip executor deployment exceeds gas envelope");
  }

  console.log(
    JSON.stringify(
      {
        block: block.number.toString(),
        blockTimestamp: block.timestamp.toString(),
        blockTime: iso(block.timestamp),
        deployment: {
          address: MEGA_RIP_ADDRESS,
          transaction: DEPLOYMENT_TRANSACTION,
          block: MEGA_RIP_DEPLOYMENT_BLOCK.toString(),
          deployer: CANONICAL_DEPLOYER,
          nonce: DEPLOYER_NONCE,
          runtimeBytes: (code.length - 2) / 2,
          runtimeHash: keccak256(code),
        },
        relationships: { fwa, token, rewards },
        state: {
          name: stateName(state.state),
          code: state.state,
          fundingEndsAt: state.fundingEndsAt.toString(),
          fundingEndsAtIso: iso(state.fundingEndsAt),
          totalDepositedEth: formatEther(state.totalDeposited),
          pullsDone: state.pullsDone.toString(),
          estimatedPullsRemaining:
            state.estimatedPullsRemaining.toString(),
          pendingSyncCount: state.pendingSyncCount.toString(),
          minRequestInterval: state.minRequestInterval.toString(),
          lastRequestAt: state.lastRequestAt.toString(),
          crankBountyEth: formatEther(state.bounty),
        },
        economics: {
          acquisitionFeeEth: formatEther(quote[0]),
          vrfFeeEth: formatEther(quote[1]),
          acquisitionTotalEth: formatEther(quote[2]),
          threeLegUnitCostEth: formatEther(unitCost),
          fundingAffordablePulls:
            fundingAffordablePulls.toString(),
          fundingGrossBountyInventoryEth: formatEther(
            fundingAffordablePulls * state.bounty * 3n,
          ),
          activeFwaListings: activeListings.toString(),
        },
        fwaQueue: {
          nextSequence: nextSequence.toString(),
          lastIssuedSequence: lastIssuedSequence.toString(),
        },
        executor: {
          address: executor.address,
          deployed:
            executorCode !== undefined && executorCode !== "0x",
          expectedRuntimeHash: executor.expectedRuntimeCodeHash,
          deployGasEstimate: executorDeployGas.toString(),
          deployGasLimit:
            MEGA_RIP_KEEPER_EXECUTOR_DEPLOY_GAS_LIMIT.toString(),
        },
        nonceGate: {
          account,
          latest: keeperLatestNonce,
          pending: keeperPendingNonce,
          clear: keeperLatestNonce === keeperPendingNonce,
        },
        deployerBoundary: {
          latest: deployerLatestNonce,
          pending: deployerPendingNonce,
        },
      },
      null,
      2,
    ),
  );
}

await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "mega_rip_inspection_failed",
      ...errorFingerprint(error),
    }),
  );
  process.exitCode = 1;
});
