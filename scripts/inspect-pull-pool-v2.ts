import {
  createPublicClient,
  formatEther,
  formatGwei,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
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
const SUCCESSOR_FACTORY = getAddress(
  "0xFba041453dabbFE8B34409Cf88417913Cc483D1E",
);
const LEGACY_POOL = getAddress(
  "0xB2D80254af189854Bf90D2C338d87236d67D2bF3",
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
const SUCCESSOR_FACTORY_CREATION_TRANSACTION =
  "0xdee71a3169b40b15be2abb1cbf518f9994c751755ae61ad53c6015bc013beb1c";
const V2_POOL_VERIFIED_SOURCE =
  "https://etherscan.io/address/0x03C45c9C594b19ca5Fde54f38C7e6b6A5f2329d7#code";
const V2_FACTORY_VERIFIED_SOURCE =
  "https://etherscan.io/address/0xc62cEF28ccDbaBE147eCD3Baf4492119aCf4c657#code";
const SUCCESSOR_FACTORY_VERIFIED_SOURCE =
  "https://repo.sourcify.dev/1/0xFba041453dabbFE8B34409Cf88417913Cc483D1E";

const ROUND_STATE_NAMES = [
  "none",
  "open",
  "pulling",
  "claimable",
  "settled",
  "refunding",
] as const;
const OUTCOME_NAMES = [
  "none",
  "tokens",
  "bid_to_eth",
  "forced_eth",
  "refunded",
] as const;

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
    label: "successor_order_factory",
    address: SUCCESSOR_FACTORY,
    codeHash:
      "0x52b7619ed66be42d34b84d32d4dafd9ead511fe74b024706de2ebf1c61280735",
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
  "function config() view returns(uint96 ticketPrice,uint64 fundingDuration,uint16 headroomBps,uint16 feeCapBps,uint96 crankBountyCap,uint96 vrfAllowance,uint64 bountyTipWei,uint64 stallTimeout,uint32 maxTickets,uint16 maxConcurrentOpen,uint16 maxConcurrentPulls,uint16 referralBps)",
  "function ticketsNeeded(uint256) view returns(uint256)",
  "function getRound(uint256 roundId) view returns ((uint96 ticketPrice,uint16 feeBps,uint16 headroomBps,uint16 feeCapBps,uint96 crankBountyCap,uint96 vrfAllowance,uint64 bountyTipWei,uint64 stallTimeout,uint64 fundingDeadline,uint32 ticketsSold,uint32 maxTickets,uint16 referralBps,uint32 referredTickets,uint256 minPoolWeightedValue,uint256 escrow,uint256 feeOwed,uint256 refundPool,uint256 ethPot,uint256 tokenPot,uint256 fwaRequestId,uint256 acquisitionSpent,uint256 bidValue,uint256 listingId,uint64 allocatedAt,uint64 pullingAt,uint8 state,uint8 outcome,bool fwaResolved,bool feeClaimed,bool nftHeld,bool rewardCredited,uint128 creditTaken,uint256 backingAtAlloc,uint128 forcedEthTaken,uint256 referralPool,uint128 rewardAmount))",
]);

const factoryAbi = parseAbi([
  "function POOL() pure returns(address)",
  "function orderCount() view returns(uint256)",
  "function allOrders() view returns(address[])",
]);

const successorFactoryAbi = parseAbi([
  "function LEGACY() view returns(address)",
  "function SUCCESSOR() view returns(address)",
  "function pool() view returns(address)",
  "function orderCount() view returns(uint256)",
  "function allOrders() view returns(address[])",
]);

const lifecycleAbi = parseAbi([
  "event RoundOpened(uint256 indexed roundId)",
  "event RoundSettled(uint256 indexed roundId,uint8 outcome,uint256 tokenPot,uint256 ethPot)",
  "event RoundVoided(uint256 indexed roundId,uint256 refundPool)",
]);

type V2Round = {
  readonly ticketPrice: bigint;
  readonly feeBps: number;
  readonly headroomBps: number;
  readonly feeCapBps: number;
  readonly crankBountyCap: bigint;
  readonly vrfAllowance: bigint;
  readonly bountyTipWei: bigint;
  readonly stallTimeout: bigint;
  readonly fundingDeadline: bigint;
  readonly ticketsSold: number;
  readonly maxTickets: number;
  readonly referralBps: number;
  readonly referredTickets: number;
  readonly minPoolWeightedValue: bigint;
  readonly escrow: bigint;
  readonly feeOwed: bigint;
  readonly refundPool: bigint;
  readonly ethPot: bigint;
  readonly tokenPot: bigint;
  readonly fwaRequestId: bigint;
  readonly acquisitionSpent: bigint;
  readonly bidValue: bigint;
  readonly listingId: bigint;
  readonly allocatedAt: bigint;
  readonly pullingAt: bigint;
  readonly state: number;
  readonly outcome: number;
  readonly fwaResolved: boolean;
  readonly feeClaimed: boolean;
  readonly nftHeld: boolean;
  readonly rewardCredited: boolean;
  readonly creditTaken: bigint;
  readonly backingAtAlloc: bigint;
  readonly forcedEthTaken: bigint;
  readonly referralPool: bigint;
  readonly rewardAmount: bigint;
};

function namedValue(names: readonly string[], value: number): string {
  return names[value] ?? `unknown_${value}`;
}

function describeRound(
  roundId: bigint,
  round: V2Round,
  ticketsNeeded: bigint,
): Record<string, unknown> {
  return {
    roundId: roundId.toString(),
    stateCode: round.state,
    state: namedValue(ROUND_STATE_NAMES, round.state),
    outcomeCode: round.outcome,
    outcome: namedValue(OUTCOME_NAMES, round.outcome),
    ticketsNeeded: ticketsNeeded.toString(),
    snapshot: {
      ticketPriceEth: formatEther(round.ticketPrice),
      feeBps: round.feeBps,
      headroomBps: round.headroomBps,
      feeCapBps: round.feeCapBps,
      crankBountyCapEth: formatEther(round.crankBountyCap),
      vrfAllowanceEth: formatEther(round.vrfAllowance),
      bountyTipGwei: formatGwei(round.bountyTipWei),
      stallTimeoutSeconds: round.stallTimeout.toString(),
      fundingDeadline: round.fundingDeadline.toString(),
      ticketsSold: round.ticketsSold,
      maxTickets: round.maxTickets,
      referralBps: round.referralBps,
      referredTickets: round.referredTickets,
      minPoolWeightedValue: round.minPoolWeightedValue.toString(),
    },
    accounting: {
      escrowEth: formatEther(round.escrow),
      feeOwedEth: formatEther(round.feeOwed),
      refundPoolEth: formatEther(round.refundPool),
      ethPot: formatEther(round.ethPot),
      tokenPot: formatEther(round.tokenPot),
      acquisitionSpentEth: formatEther(round.acquisitionSpent),
      referralPoolEth: formatEther(round.referralPool),
      rewardAmount: formatEther(round.rewardAmount),
    },
    fwa: {
      requestId: round.fwaRequestId.toString(),
      bidValueEth: formatEther(round.bidValue),
      listingId: round.listingId.toString(),
      allocatedAt: round.allocatedAt.toString(),
      pullingAt: round.pullingAt.toString(),
      fwaResolved: round.fwaResolved,
      backingAtAllocEth: formatEther(round.backingAtAlloc),
      creditTakenEth: formatEther(round.creditTaken),
      forcedEthTakenEth: formatEther(round.forcedEthTaken),
    },
    flags: {
      feeClaimed: round.feeClaimed,
      nftHeld: round.nftHeld,
      rewardCredited: round.rewardCredited,
    },
  };
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
    successorFactoryCreation,
    successorFactoryCreationReceipt,
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
    successorLegacy,
    successorPool,
    successorCurrentPool,
    successorOrderCount,
    successorOrders,
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
    client.getTransaction({
      hash: SUCCESSOR_FACTORY_CREATION_TRANSACTION,
    }),
    client.getTransactionReceipt({
      hash: SUCCESSOR_FACTORY_CREATION_TRANSACTION,
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
    client.readContract({
      address: SUCCESSOR_FACTORY,
      abi: successorFactoryAbi,
      functionName: "LEGACY",
      blockNumber,
    }),
    client.readContract({
      address: SUCCESSOR_FACTORY,
      abi: successorFactoryAbi,
      functionName: "SUCCESSOR",
      blockNumber,
    }),
    client.readContract({
      address: SUCCESSOR_FACTORY,
      abi: successorFactoryAbi,
      functionName: "pool",
      blockNumber,
    }),
    client.readContract({
      address: SUCCESSOR_FACTORY,
      abi: successorFactoryAbi,
      functionName: "orderCount",
      blockNumber,
    }),
    client.readContract({
      address: SUCCESSOR_FACTORY,
      abi: successorFactoryAbi,
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
  const successorFactoryCreatedAddress =
    successorFactoryCreationReceipt.contractAddress;
  const relationshipsValid =
    getAddress(owner) === DEPLOYER &&
    getAddress(poolCreation.from) === DEPLOYER &&
    getAddress(factoryCreation.from) === DEPLOYER &&
    getAddress(successorFactoryCreation.from) === DEPLOYER &&
    poolCreatedAddress !== null &&
    poolCreatedAddress !== undefined &&
    getAddress(poolCreatedAddress) === V2_POOL &&
    factoryCreatedAddress !== null &&
    factoryCreatedAddress !== undefined &&
    getAddress(factoryCreatedAddress) === V2_FACTORY &&
    successorFactoryCreatedAddress !== null &&
    successorFactoryCreatedAddress !== undefined &&
    getAddress(successorFactoryCreatedAddress) ===
      SUCCESSOR_FACTORY &&
    getAddress(factoryPool) === V2_POOL &&
    getAddress(successorLegacy) === LEGACY_POOL &&
    getAddress(successorPool) === V2_POOL &&
    getAddress(successorCurrentPool) === V2_POOL &&
    getAddress(fwa) === EXPECTED_FWA &&
    getAddress(fwaRewards) === EXPECTED_FWA_REWARDS &&
    getAddress(fwaToken) === EXPECTED_FWA_TOKEN;
  const bytecodeValid = components.every((component) => component.matches);
  if (!bytecodeValid || !relationshipsValid) {
    throw new Error("PullPool V2 bytecode or deployment relationships changed");
  }

  const lifecycleLogs = await client.getLogs({
    address: V2_POOL,
    events: lifecycleAbi,
    fromBlock: poolCreationReceipt.blockNumber,
    toBlock: blockNumber,
    strict: true,
  });
  const activeRoundIds = new Set<bigint>();
  for (const log of lifecycleLogs) {
    const roundId = log.args.roundId;
    if (log.eventName === "RoundOpened") {
      activeRoundIds.add(roundId);
    } else {
      activeRoundIds.delete(roundId);
    }
  }
  const orderedActiveRoundIds = [...activeRoundIds].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const activeRounds = await Promise.all(
    orderedActiveRoundIds.map(async (roundId) => {
      const [round, ticketsNeeded] = await Promise.all([
        client.readContract({
          address: V2_POOL,
          abi: poolAbi,
          functionName: "getRound",
          args: [roundId],
          blockNumber,
        }),
        client.readContract({
          address: V2_POOL,
          abi: poolAbi,
          functionName: "ticketsNeeded",
          args: [roundId],
          blockNumber,
        }),
      ]);
      return describeRound(roundId, round as V2Round, ticketsNeeded);
    }),
  );
  if (
    activeRounds.length === 0 &&
    (currentOpenRound > 0n || pendingPullCount > 0n)
  ) {
    throw new Error(
      "PullPool V2 active-round event index disagrees with contract state",
    );
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
        successorFactory: SUCCESSOR_FACTORY,
        successorFactoryCreationTransaction:
          SUCCESSOR_FACTORY_CREATION_TRANSACTION,
        successorFactoryCreationBlock:
          successorFactoryCreationReceipt.blockNumber.toString(),
        verifiedSource: {
          pool: V2_POOL_VERIFIED_SOURCE,
          factory: V2_FACTORY_VERIFIED_SOURCE,
          successorFactory:
            SUCCESSOR_FACTORY_VERIFIED_SOURCE,
          match: "verified-creation-bytecode",
          compiler: "0.8.28",
          evmVersion: "cancun",
        },
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
        successorLegacy,
        successorPool,
        successorCurrentPool,
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
        maxConcurrentOpen: poolConfig[9].toString(),
        maxConcurrentPulls: poolConfig[10].toString(),
        referralBps: poolConfig[11].toString(),
      },
      factories: [
        {
          address: V2_FACTORY,
          orderCount: orderCount.toString(),
          orders: orders.map((address: Address) =>
            getAddress(address),
          ),
        },
        {
          address: SUCCESSOR_FACTORY,
          orderCount: successorOrderCount.toString(),
          orders: successorOrders.map((address: Address) =>
            getAddress(address),
          ),
        },
      ],
      activeRounds,
      launchReady:
        bytecodeValid &&
        relationshipsValid &&
        !paused &&
        !deprecated &&
        roundCount > 0n,
      action: paused
        ? "wait_for_unpause"
        : roundCount === 0n
          ? "wait_for_first_round"
          : "monitor_live_v2_and_both_order_factories",
    }),
  );
}

await main();
