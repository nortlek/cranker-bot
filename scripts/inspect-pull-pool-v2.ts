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
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";

const DEPLOYER = getAddress(
  "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
);
const V2_POOL = getAddress(
  "0x03C45c9C594b19ca5Fde54f38C7e6b6A5f2329d7",
);
const V2_FACTORY = getAddress(
  "0xC62ceF28ccDBabE147ECD3baf4492119acf4C657",
);
const EXPECTED_FWA = getAddress(
  "0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c",
);
const EXPECTED_FWA_REWARDS = getAddress(
  "0x6a1a1C0CfB3D3C538e13D36d608a5bcaa992fc78",
);
const EXPECTED_FWA_TOKEN = getAddress(
  "0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845",
);
const V2_POOL_CREATION_TRANSACTION =
  "0x369e1819e8477df92540e26919a168d9bfd99d2b73907657b6fb0d9ca258f64c";
const V2_FACTORY_CREATION_TRANSACTION =
  "0x2a2ccc02b072fbd8e7133b4e8cc405a28b355d63d7f0eda17b24e7a334b55e1a";

const COMPONENTS = [
  {
    label: "pool",
    address: V2_POOL,
    codeHash:
      "0x9086cc5f10b8b8ee1a775ae683f0770d151665a56e7b5f9632cc2253ec68a792",
  },
  {
    label: "order_factory",
    address: V2_FACTORY,
    codeHash:
      "0x45ccf63419269cadbb49f4dc5b7496ddc5c2d813f71296e55a56dd522d1dab49",
  },
  {
    label: "component_a",
    address: getAddress(
      "0xA30360eAF3c21caF9F51b63a9F6531Ea026769A8",
    ),
    codeHash:
      "0x7686f7f71d828d45a06863d2b8f950164ae2dac445ce5ee313f959a84dcae4bc",
  },
  {
    label: "component_b",
    address: getAddress(
      "0x1496D556E8C3BE67f7329Dc4Ab57c392C4fd6e85",
    ),
    codeHash:
      "0xd787afc15d96c719d04f3fca98a23c7e5cdb1835ae460ef363b645236fed444d",
  },
  {
    label: "component_c",
    address: getAddress(
      "0xB7ec36CA1869E5112F87a6cDFb9baCBacc1c5AeC",
    ),
    codeHash:
      "0xafdd5ff2a26d9cb99e37c9dd0cb4c3be16c433845b18c08997f65d9975f42404",
  },
  {
    label: "component_d",
    address: getAddress(
      "0x5B786A97eFCB6A3A87E2b346Beee4fe469B8C9cA",
    ),
    codeHash:
      "0x9d13ad70cd4d282ea6454efc6e55c0f7117faaedde660ca2e225989febbc3d28",
  },
  {
    label: "config_guard",
    address: getAddress(
      "0xE9516162982A32cDb4619CF11b749A9e06dAA2F5",
    ),
    codeHash:
      "0xe1228ec0c807b2896f5aebd1bae3225a474dcd098c05c129425ad84555515dd0",
  },
] as const;

const poolAbi = parseAbi([
  "function owner() view returns(address)",
  "function paused() view returns(bool)",
  "function deprecated() view returns(bool)",
  "function roundCount() view returns(uint256)",
  "function firstOpenRound() view returns(uint256)",
  "function currentOpenRound() view returns(uint256)",
  "function pendingPullCount() view returns(uint256)",
  "function feeBps() view returns(uint16)",
  "function feeRecipient() view returns(address)",
  "function canPayTokens() view returns(bool)",
  "function accountedEth() view returns(uint256)",
  "function FWA() pure returns(address)",
  "function FWA_REWARDS() pure returns(address)",
  "function FWA_TOKEN() pure returns(address)",
  "function config() view returns(uint96,uint64,uint16,uint16,uint96,uint96,uint64,uint64,uint32,uint16,uint16,uint16)",
  "function ticketsNeeded(uint256) view returns(uint256)",
  "function getRound(uint256) view",
]);

const factoryAbi = parseAbi([
  "function POOL() pure returns(address)",
  "function orderCount() view returns(uint256)",
  "function allOrders() view returns(address[])",
]);

function dataWords(data: Hex | undefined): readonly string[] {
  if (data === undefined || data === "0x") return [];
  const body = data.slice(2);
  if (body.length % 64 !== 0) {
    throw new Error("V2 getRound returned malformed ABI data");
  }
  return Array.from(
    { length: body.length / 64 },
    (_, index) => `0x${body.slice(index * 64, (index + 1) * 64)}`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.discoveryRpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const blockNumber = await client.getBlockNumber();
  const [
    componentCodes,
    poolCreation,
    poolCreationReceipt,
    factoryCreation,
    factoryCreationReceipt,
    owner,
    paused,
    deprecated,
    roundCount,
    firstOpenRound,
    currentOpenRound,
    pendingPullCount,
    feeBps,
    feeRecipient,
    canPayTokens,
    accountedEth,
    fwa,
    fwaRewards,
    fwaToken,
    poolConfig,
    factoryPool,
    orderCount,
    orders,
  ] = await Promise.all([
    Promise.all(
      COMPONENTS.map((component) =>
        client.getBytecode({
          address: component.address,
          blockNumber,
        }),
      ),
    ),
    client.getTransaction({
      hash: V2_POOL_CREATION_TRANSACTION,
    }),
    client.getTransactionReceipt({
      hash: V2_POOL_CREATION_TRANSACTION,
    }),
    client.getTransaction({
      hash: V2_FACTORY_CREATION_TRANSACTION,
    }),
    client.getTransactionReceipt({
      hash: V2_FACTORY_CREATION_TRANSACTION,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "owner",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "paused",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "deprecated",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "roundCount",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "firstOpenRound",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "currentOpenRound",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "pendingPullCount",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "feeBps",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "feeRecipient",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "canPayTokens",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "accountedEth",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "FWA",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "FWA_REWARDS",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "FWA_TOKEN",
      blockNumber,
    }),
    client.readContract({
      address: V2_POOL,
      abi: poolAbi,
      functionName: "config",
      blockNumber,
    }),
    client.readContract({
      address: V2_FACTORY,
      abi: factoryAbi,
      functionName: "POOL",
      blockNumber,
    }),
    client.readContract({
      address: V2_FACTORY,
      abi: factoryAbi,
      functionName: "orderCount",
      blockNumber,
    }),
    client.readContract({
      address: V2_FACTORY,
      abi: factoryAbi,
      functionName: "allOrders",
      blockNumber,
    }),
  ]);

  const components = COMPONENTS.map((component, index) => {
    const code = componentCodes[index];
    const observedCodeHash =
      code === undefined || code === "0x" ? undefined : keccak256(code);
    return {
      label: component.label,
      address: component.address,
      expectedCodeHash: component.codeHash,
      observedCodeHash,
      matches: observedCodeHash === component.codeHash,
    };
  });
  const poolCreatedAddress = poolCreationReceipt.contractAddress;
  const factoryCreatedAddress =
    factoryCreationReceipt.contractAddress;
  const relationshipsValid =
    getAddress(owner) === DEPLOYER &&
    getAddress(poolCreation.from) === DEPLOYER &&
    getAddress(factoryCreation.from) === DEPLOYER &&
    poolCreatedAddress !== null &&
    poolCreatedAddress !== undefined &&
    getAddress(poolCreatedAddress) === V2_POOL &&
    factoryCreatedAddress !== null &&
    factoryCreatedAddress !== undefined &&
    getAddress(factoryCreatedAddress) === V2_FACTORY &&
    getAddress(factoryPool) === V2_POOL &&
    getAddress(fwa) === EXPECTED_FWA &&
    getAddress(fwaRewards) === EXPECTED_FWA_REWARDS &&
    getAddress(fwaToken) === EXPECTED_FWA_TOKEN;
  const bytecodeValid = components.every((component) => component.matches);
  if (!bytecodeValid || !relationshipsValid) {
    throw new Error("PullPool V2 bytecode or deployment relationships changed");
  }

  let currentRound:
    | {
        readonly roundId: string;
        readonly ticketsNeeded: string;
        readonly rawWordCount: number;
        readonly rawWords: readonly string[];
      }
    | undefined;
  if (currentOpenRound > 0n) {
    const [ticketsNeeded, rawRound] = await Promise.all([
      client.readContract({
        address: V2_POOL,
        abi: poolAbi,
        functionName: "ticketsNeeded",
        args: [currentOpenRound],
        blockNumber,
      }),
      client.call({
        to: V2_POOL,
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "getRound",
          args: [currentOpenRound],
        }),
        blockNumber,
      }),
    ]);
    const rawWords = dataWords(rawRound.data);
    currentRound = {
      roundId: currentOpenRound.toString(),
      ticketsNeeded: ticketsNeeded.toString(),
      rawWordCount: rawWords.length,
      rawWords,
    };
  }

  console.log(
    JSON.stringify({
      event: "pull_pool_v2_inspection",
      blockNumber: blockNumber.toString(),
      canonical: {
        deployer: DEPLOYER,
        pool: V2_POOL,
        poolCreationTransaction: V2_POOL_CREATION_TRANSACTION,
        poolCreationBlock:
          poolCreationReceipt.blockNumber.toString(),
        factory: V2_FACTORY,
        factoryCreationTransaction: V2_FACTORY_CREATION_TRANSACTION,
        factoryCreationBlock:
          factoryCreationReceipt.blockNumber.toString(),
      },
      bytecodeValid,
      relationshipsValid,
      components,
      state: {
        owner,
        paused,
        deprecated,
        roundCount: roundCount.toString(),
        firstOpenRound: firstOpenRound.toString(),
        currentOpenRound: currentOpenRound.toString(),
        pendingPullCount: pendingPullCount.toString(),
        feeBps: feeBps.toString(),
        feeRecipient,
        canPayTokens,
        accountedEth: formatEther(accountedEth),
      },
      immutableRelationships: {
        fwa,
        fwaRewards,
        fwaToken,
        factoryPool,
      },
      config: {
        ticketPriceEth: formatEther(poolConfig[0]),
        fundingDurationSeconds: poolConfig[1].toString(),
        headroomBps: poolConfig[2].toString(),
        feeCapBps: poolConfig[3].toString(),
        crankBountyCapEth: formatEther(poolConfig[4]),
        vrfAllowanceEth: formatEther(poolConfig[5]),
        bountyTipGwei: formatGwei(poolConfig[6]),
        stallTimeoutSeconds: poolConfig[7].toString(),
        maxTickets: poolConfig[8].toString(),
        extra9: poolConfig[9].toString(),
        extra10: poolConfig[10].toString(),
        extra11: poolConfig[11].toString(),
      },
      factory: {
        orderCount: orderCount.toString(),
        orders: orders.map((address: Address) => getAddress(address)),
      },
      ...(currentRound === undefined ? {} : { currentRound }),
      launchReady:
        bytecodeValid &&
        relationshipsValid &&
        !paused &&
        !deprecated &&
        roundCount > 0n,
      action: paused
        ? "wait_for_unpause_and_source_verification"
        : roundCount === 0n
          ? "wait_for_first_round"
          : "decode_round_and_dry_run_before_live_enablement",
    }),
  );
}

await main();
