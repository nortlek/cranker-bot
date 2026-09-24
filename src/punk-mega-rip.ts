import {
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import { bufferedGas } from "./economics.js";
import { errorMessage, log } from "./format.js";
import type { KeeperJob } from "./strategy.js";

export const PUNK_MEGA_RIP_SERIES_ADDRESS =
  "0xcAc67d60Db1801522985A2380eB7c125aA0A32D4" as Address;
export const PUNK_MEGA_RIP_FWA_ADDRESS =
  "0x958C41181182e76F221331b2755b77D9e1426A98" as Address;
export const PUNK_MEGA_RIP_COLLECTION_ADDRESS =
  "0x000000000000003607fce1aC9e043a86675C5C2F" as Address;
export const PUNK_MEGA_RIP_ROUND_IMPLEMENTATION =
  "0xD3F06c5bBe90106B703CC4Ce778284772e8a5Bfd" as Address;
export const PUNK_MEGA_RIP_BATCH_MODULE =
  "0xdF996cFEbC51eC5045407862dE1209f54104259A" as Address;
export const PUNK_MEGA_RIP_LEDGER_MODULE =
  "0xd817f3C776F6b83d0592027f5fFbd4b5649A3427" as Address;
export const PUNK_MEGA_RIP_EXECUTION_MODULE =
  "0xF36355B6571491a428689bdA40D85458C684Dd80" as Address;
export const PUNK_MEGA_RIP_VALUE_MODULE =
  "0x22e3294A5b69DACDc02f610e3463209fA3eC7E5d" as Address;
export const PUNK_MEGA_RIP_RECOVERY_MODULE =
  "0xdeE151710B4F682994A5D6e3c2d74Ce971D9FBDf" as Address;
export const PUNK_MEGA_RIP_CONFIG_MODULE =
  "0xA4d8e7c8FE439b1F4D94120923403fc6b7EC027e" as Address;
export const PUNK_MEGA_RIP_ROUND_FACTORY =
  "0x7cBBe9299ae7F7d082D7d2Af2201da978c795406" as Address;
export const PUNK_MEGA_RIP_PURCHASE_ROUTER =
  "0xA7DEe9A1DA6bfCb7db12AEA6eDAA9e02aFEd6FED" as Address;
export const PUNK_MEGA_RIP_REWARD_VAULT =
  "0xEa20a110ad3Dfc483977d14f80203994E65D34FB" as Address;
export const PUNK_MEGA_RIP_ADAPTER_FACTORY =
  "0xe31158e344fc7279Ae5a5ff12d809bD95A147fE9" as Address;
export const PUNK_MEGA_RIP_VAULT_FACTORY =
  "0xf3381B259B2FE142c0A87bffF463695d935D6F66" as Address;
export const PUNK_MEGA_RIP_OPERATOR =
  "0xCB43078C32423F5348Cab5885911C3B5faE217F9" as Address;

export const PUNK_MEGA_RIP_SERIES_RUNTIME_CODE_HASH =
  "0x33e587cd74144bf54623c377055d76f35e83909268afc052931fe016f4ed9b3c" as Hex;
export const PUNK_MEGA_RIP_ROUND_RUNTIME_CODE_HASH =
  "0xc424297a1bc4cdf2cf1ed52cab98c33585cfbe14c47fb717f8947cd52184c9ff" as Hex;

const PINNED_COMPONENTS = [
  [PUNK_MEGA_RIP_ROUND_IMPLEMENTATION, "0x49c8ebc35799160ecab408e5136a5a600d5794acccd6bc16af6836f3d414dd72"],
  [PUNK_MEGA_RIP_BATCH_MODULE, "0x5dd910ba7ded754a03c2878616d19d936913a5d80982e4b56d4c6aa9509e6aa6"],
  [PUNK_MEGA_RIP_LEDGER_MODULE, "0x034c538fd2b0774e144ef32dbba5236b74c4aa139169be43a8e2226eca0502ed"],
  [PUNK_MEGA_RIP_EXECUTION_MODULE, "0x81274e3360bea4b80bea5708ed8ebfd17371e4e6a5a27298d94d6a7cbe4daba2"],
  [PUNK_MEGA_RIP_VALUE_MODULE, "0xf3c56e2ae1f86f2e7acf9fd9a1eb0957f6eb966fee0beb3709c1cbf0a012a201"],
  [PUNK_MEGA_RIP_RECOVERY_MODULE, "0x0778387143f76b33276d391002ef210a97bf90b6616753a3457fde4a2cfe9b29"],
  [PUNK_MEGA_RIP_CONFIG_MODULE, "0x73458d49395346a8aa75eb2961044bc77450b10d5826cc9cf7e8c6129fd240fd"],
  [PUNK_MEGA_RIP_ROUND_FACTORY, "0xa68695d5e90bd2c745b6287a959a18e223fed0c0ddceb413f1803e57bada1246"],
  [PUNK_MEGA_RIP_PURCHASE_ROUTER, "0xd795143208462b18640c0516de592af17ac9b6f71c7481e868aa170228013027"],
  [PUNK_MEGA_RIP_REWARD_VAULT, "0xf3df5842400cde6021f3e7709c584cadce5112370386761f77b257c0ca2743ce"],
  [PUNK_MEGA_RIP_ADAPTER_FACTORY, "0x37775a967923f23aef5dda718e81d5a22fc02da8e677f623cbf6614343ccd65e"],
  [PUNK_MEGA_RIP_VAULT_FACTORY, "0xc6ceb8b8615c8efb1bb31dfeecb13d72e58cb0f760b6216b4373319437e4f734"],
] as const satisfies readonly (readonly [Address, Hex])[];

export const punkMegaRipSeriesAbi = parseAbi([
  "function liveRounds() view returns (address[])",
  "function fundingRounds() view returns (address[])",
  "function isRound(address) view returns (bool)",
  "function FWA() view returns (address)",
  "function PUNK_COLLECTION() view returns (address)",
  "function ROUND_IMPLEMENTATION() view returns (address)",
  "function BATCH_MODULE() view returns (address)",
  "function LEDGER_MODULE() view returns (address)",
  "function EXECUTION_MODULE() view returns (address)",
  "function VALUE_MODULE() view returns (address)",
  "function RECOVERY_MODULE() view returns (address)",
  "function CONFIG_MODULE() view returns (address)",
  "function ROUND_FACTORY() view returns (address)",
  "function PURCHASE_ROUTER() view returns (address)",
  "function REWARD_VAULT() view returns (address)",
  "function ADAPTER_FACTORY() view returns (address)",
  "function VAULT_FACTORY() view returns (address)",
  "function operator() view returns (address)",
]);

export const punkMegaRipRoundAbi = parseAbi([
  "function SERIES() view returns (address)",
  "function FWA() view returns (address)",
  "function PUNK_COLLECTION() view returns (address)",
  "function BATCH_MODULE() view returns (address)",
  "function VALUE_MODULE() view returns (address)",
  "function RECOVERY_MODULE() view returns (address)",
  "function REWARD_VAULT() view returns (address)",
  "function PURCHASE_ROUTER() view returns (address)",
  "function state() view returns (uint8)",
  "function economicallySettled() view returns (bool)",
  "function bankroll() view returns (uint256)",
  "function maxPullCostWei() view returns (uint128)",
  "function pullCount() view returns (uint256)",
  "function outstanding() view returns (uint256)",
  "function pendingReadyToSync() view returns (uint256)",
  "function pendingSettles() view returns (uint256)",
  "function requiredGasBudget() view returns (uint256)",
  "function gasPriceCeiling() view returns (uint64)",
  "function priorityFeeCap() view returns (uint64)",
  "function requestBatchMax() view returns (uint8)",
  "function sweepBatchMax() view returns (uint8)",
  "function syncCursor() view returns (uint256)",
  "function targetListingId() view returns (uint256)",
  "function canRequest() view returns (bool,uint8)",
  "function requestPullBatch(uint256 expectedFirst,uint256 witnessListingId,uint256 maxCount)",
  "function syncAndSettle(uint256 expectedFirst,uint256 maxCount)",
  "event KeeperReimbursed(address indexed to,uint256 amount)",
  "event CustodyGasPaid(address indexed caller,uint256 amount)",
]);

export const PUNK_MEGA_RIP_STATE = {
  FUNDING: 0,
  CANCELLED: 1,
  HUNTING: 2,
  ENDING: 3,
  SETTLED: 4,
} as const;

const REQUEST_REIMBURSED_GAS_CAP = 1_500_000n;
const SYNC_SETTLE_REIMBURSED_GAS_CAP = 2_200_000n;
// The verified contract adds 60k gas to its measured body. The smallest
// receipt-normalized surplus across both public pilot rounds was 18,364 gas;
// this lower floor only admits signed simulation and does not replace it.
export const PUNK_MEGA_RIP_REIMBURSEMENT_GAS_BONUS_FLOOR = 15_000n;

interface RoundState {
  readonly state: number;
  readonly economicallySettled: boolean;
  readonly bankroll: bigint;
  readonly maxPullCostWei: bigint;
  readonly pullCount: bigint;
  readonly outstanding: bigint;
  readonly pendingReadyToSync: bigint;
  readonly pendingSettles: bigint;
  readonly requiredGasBudget: bigint;
  readonly gasPriceCeiling: bigint;
  readonly priorityFeeCap: bigint;
  readonly requestBatchMax: number;
  readonly sweepBatchMax: number;
  readonly syncCursor: bigint;
  readonly targetListingId: bigint;
  readonly canRequest: boolean;
}

export interface PunkMegaRipPlan {
  readonly liveRounds: readonly Address[];
  readonly fundingRounds: readonly Address[];
  readonly jobs: readonly KeeperJob[];
  readonly minimumViablePrefix: number;
}

function sameAddress(actual: Address, expected: Address): boolean {
  return isAddressEqual(actual, expected);
}

export async function verifyPunkMegaRipSeries(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
}): Promise<void> {
  const [seriesCode, ...componentCodes] = await Promise.all([
    parameters.client.getCode({ address: PUNK_MEGA_RIP_SERIES_ADDRESS, blockNumber: parameters.blockNumber }),
    ...PINNED_COMPONENTS.map(([address]) =>
      parameters.client.getCode({ address, blockNumber: parameters.blockNumber }),
    ),
  ]);
  if (seriesCode === undefined || keccak256(seriesCode) !== PUNK_MEGA_RIP_SERIES_RUNTIME_CODE_HASH) {
    throw new Error("Punk MegaRip series runtime does not match pinned code");
  }
  for (let index = 0; index < PINNED_COMPONENTS.length; index += 1) {
    const code = componentCodes[index];
    if (code === undefined || keccak256(code) !== PINNED_COMPONENTS[index]![1]) {
      throw new Error("Punk MegaRip component runtime does not match pinned code");
    }
  }
  const names = [
    "FWA", "PUNK_COLLECTION", "ROUND_IMPLEMENTATION", "BATCH_MODULE",
    "LEDGER_MODULE", "EXECUTION_MODULE", "VALUE_MODULE", "RECOVERY_MODULE",
    "CONFIG_MODULE", "ROUND_FACTORY", "PURCHASE_ROUTER", "REWARD_VAULT",
    "ADAPTER_FACTORY", "VAULT_FACTORY", "operator",
  ] as const;
  const expected = [
    PUNK_MEGA_RIP_FWA_ADDRESS, PUNK_MEGA_RIP_COLLECTION_ADDRESS,
    PUNK_MEGA_RIP_ROUND_IMPLEMENTATION, PUNK_MEGA_RIP_BATCH_MODULE,
    PUNK_MEGA_RIP_LEDGER_MODULE, PUNK_MEGA_RIP_EXECUTION_MODULE,
    PUNK_MEGA_RIP_VALUE_MODULE, PUNK_MEGA_RIP_RECOVERY_MODULE,
    PUNK_MEGA_RIP_CONFIG_MODULE, PUNK_MEGA_RIP_ROUND_FACTORY,
    PUNK_MEGA_RIP_PURCHASE_ROUTER, PUNK_MEGA_RIP_REWARD_VAULT,
    PUNK_MEGA_RIP_ADAPTER_FACTORY, PUNK_MEGA_RIP_VAULT_FACTORY,
    PUNK_MEGA_RIP_OPERATOR,
  ] as const;
  const actual = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: names.map((functionName) => ({
      address: PUNK_MEGA_RIP_SERIES_ADDRESS,
      abi: punkMegaRipSeriesAbi,
      functionName,
    })),
  });
  if (actual.some((value, index) => !sameAddress(value as Address, expected[index]!))) {
    throw new Error("Punk MegaRip series relationships are not canonical");
  }
}

async function verifyRound(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly round: Address;
}): Promise<void> {
  const [registered, code, relationships] = await Promise.all([
    parameters.client.readContract({
      address: PUNK_MEGA_RIP_SERIES_ADDRESS,
      abi: punkMegaRipSeriesAbi,
      functionName: "isRound",
      args: [parameters.round],
      blockNumber: parameters.blockNumber,
    }),
    parameters.client.getCode({ address: parameters.round, blockNumber: parameters.blockNumber }),
    parameters.client.multicall({
      allowFailure: false,
      blockNumber: parameters.blockNumber,
      contracts: [
        ["SERIES", PUNK_MEGA_RIP_SERIES_ADDRESS],
        ["FWA", PUNK_MEGA_RIP_FWA_ADDRESS],
        ["PUNK_COLLECTION", PUNK_MEGA_RIP_COLLECTION_ADDRESS],
        ["BATCH_MODULE", PUNK_MEGA_RIP_BATCH_MODULE],
        ["VALUE_MODULE", PUNK_MEGA_RIP_VALUE_MODULE],
        ["RECOVERY_MODULE", PUNK_MEGA_RIP_RECOVERY_MODULE],
        ["REWARD_VAULT", PUNK_MEGA_RIP_REWARD_VAULT],
        ["PURCHASE_ROUTER", PUNK_MEGA_RIP_PURCHASE_ROUTER],
      ].map(([functionName]) => ({
        address: parameters.round,
        abi: punkMegaRipRoundAbi,
        functionName: functionName as "SERIES",
      })),
    }),
  ]);
  const expected = [
    PUNK_MEGA_RIP_SERIES_ADDRESS, PUNK_MEGA_RIP_FWA_ADDRESS,
    PUNK_MEGA_RIP_COLLECTION_ADDRESS, PUNK_MEGA_RIP_BATCH_MODULE,
    PUNK_MEGA_RIP_VALUE_MODULE, PUNK_MEGA_RIP_RECOVERY_MODULE,
    PUNK_MEGA_RIP_REWARD_VAULT, PUNK_MEGA_RIP_PURCHASE_ROUTER,
  ];
  if (!registered || code === undefined || keccak256(code) !== PUNK_MEGA_RIP_ROUND_RUNTIME_CODE_HASH) {
    throw new Error("Punk MegaRip round identity is not canonical");
  }
  if (relationships.some((value, index) => !sameAddress(value as Address, expected[index]!))) {
    throw new Error("Punk MegaRip round relationships are not canonical");
  }
}

async function readRoundState(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly blockNumber: bigint;
  readonly round: Address;
}): Promise<RoundState> {
  const values = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: [
      "state", "economicallySettled", "bankroll", "maxPullCostWei", "pullCount", "outstanding",
      "pendingReadyToSync", "pendingSettles", "requiredGasBudget",
      "gasPriceCeiling", "priorityFeeCap", "requestBatchMax", "sweepBatchMax",
      "syncCursor", "targetListingId", "canRequest",
    ].map((functionName) => ({
      address: parameters.round,
      abi: punkMegaRipRoundAbi,
      functionName: functionName as "state",
    })),
  }) as unknown as readonly [
    number, boolean, bigint, bigint, bigint, bigint, bigint, bigint,
    bigint, bigint, bigint, number, number, bigint, bigint,
    readonly [boolean, number],
  ];
  const [
    state, economicallySettled, bankroll, maxPullCostWei, pullCount, outstanding,
    pendingReadyToSync, pendingSettles, requiredGasBudget, gasPriceCeiling,
    priorityFeeCap, requestBatchMax, sweepBatchMax, syncCursor,
    targetListingId, canRequest,
  ] = values;
  return {
    state: Number(state), economicallySettled,
    bankroll, maxPullCostWei, pullCount,
    outstanding,
    pendingReadyToSync,
    pendingSettles,
    requiredGasBudget,
    gasPriceCeiling,
    priorityFeeCap,
    requestBatchMax: Number(requestBatchMax), sweepBatchMax: Number(sweepBatchMax),
    syncCursor, targetListingId,
    canRequest: canRequest[0],
  };
}

export function punkMegaRipRequestData(parameters: {
  readonly expectedFirst: bigint;
  readonly witnessListingId: bigint;
  readonly maxCount?: bigint;
}): Hex {
  return encodeFunctionData({
    abi: punkMegaRipRoundAbi,
    functionName: "requestPullBatch",
    args: [parameters.expectedFirst, parameters.witnessListingId, parameters.maxCount ?? 1n],
  });
}

export function punkMegaRipSyncData(parameters: {
  readonly expectedFirst: bigint;
  readonly maxCount?: bigint;
}): Hex {
  return encodeFunctionData({
    abi: punkMegaRipRoundAbi,
    functionName: "syncAndSettle",
    args: [parameters.expectedFirst, parameters.maxCount ?? 1n],
  });
}

async function buildJob(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly round: Address;
  readonly state: RoundState;
  readonly kind: "punk_mega_rip_request" | "punk_mega_rip_sync_settle";
  readonly data: Hex;
  readonly reimbursedGasCap: bigint;
  readonly additionalProtectedWei?: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly builderBidBps: bigint;
}): Promise<KeeperJob | undefined> {
  const protectedWei =
    parameters.state.requiredGasBudget +
    (parameters.additionalProtectedWei ?? 0n);
  const maximumPayoutWei =
    parameters.state.bankroll > protectedWei
      ? parameters.state.bankroll - protectedWei
      : 0n;
  if (maximumPayoutWei === 0n) return undefined;
  try {
    const gas = bufferedGas(
      await parameters.client.estimateGas({
        account: parameters.account,
        to: parameters.round,
        data: parameters.data,
        blockNumber: parameters.blockNumber,
      }),
      parameters.gasLimitMultiplierBps,
    );
    return {
      kind: parameters.kind,
      label: `${parameters.kind}:${parameters.round}`,
      target: parameters.round,
      data: parameters.data,
      gas,
      reward: {
        kind: "gas_reimbursement",
        flatProfitWei: 0n,
        callCount: 1n,
        gasPriceCeiling: parameters.state.gasPriceCeiling,
        priorityFeeCap: parameters.state.priorityFeeCap,
        executorGasDiscount: 0n,
        reimbursementGasBonus: PUNK_MEGA_RIP_REIMBURSEMENT_GAS_BONUS_FLOOR,
        reimbursedGasCap: parameters.reimbursedGasCap,
        maximumPayoutWei,
      },
      configuredBuilderBidBps: parameters.builderBidBps,
      requiresBundleSimulation: true,
    };
  } catch (error) {
    log("debug", "punk_mega_rip_action_not_ready", {
      round: parameters.round,
      action: parameters.kind,
      reason: errorMessage(error),
    });
    return undefined;
  }
}

export async function planPunkMegaRipJobs(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Account | Address;
  readonly blockNumber: bigint;
  readonly gasLimitMultiplierBps: bigint;
  readonly builderBidBps: bigint;
}): Promise<PunkMegaRipPlan> {
  await verifyPunkMegaRipSeries(parameters);
  const [liveRounds, fundingRounds] = await parameters.client.multicall({
    allowFailure: false,
    blockNumber: parameters.blockNumber,
    contracts: ["liveRounds", "fundingRounds"].map((functionName) => ({
      address: PUNK_MEGA_RIP_SERIES_ADDRESS,
      abi: punkMegaRipSeriesAbi,
      functionName: functionName as "liveRounds",
    })),
  }) as unknown as readonly [readonly Address[], readonly Address[]];
  const jobs: KeeperJob[] = [];
  for (const round of liveRounds) {
    await verifyRound({ ...parameters, round });
    const state = await readRoundState({ ...parameters, round });
    if (state.economicallySettled || (state.state !== PUNK_MEGA_RIP_STATE.HUNTING && state.state !== PUNK_MEGA_RIP_STATE.ENDING)) {
      continue;
    }
    if (state.syncCursor < state.pullCount && state.sweepBatchMax > 0) {
      const job = await buildJob({
        ...parameters, round, state,
        kind: "punk_mega_rip_sync_settle",
        data: punkMegaRipSyncData({ expectedFirst: state.syncCursor }),
        reimbursedGasCap: SYNC_SETTLE_REIMBURSED_GAS_CAP,
      });
      if (job !== undefined) jobs.push(job);
    }
    if (
      state.state === PUNK_MEGA_RIP_STATE.HUNTING &&
      state.canRequest && state.requestBatchMax > 0 &&
      state.targetListingId !== 0n && state.pendingReadyToSync === 0n
    ) {
      const job = await buildJob({
        ...parameters, round, state,
        kind: "punk_mega_rip_request",
        data: punkMegaRipRequestData({
          expectedFirst: state.pullCount,
          witnessListingId: state.targetListingId,
        }),
        reimbursedGasCap: REQUEST_REIMBURSED_GAS_CAP,
        additionalProtectedWei:
          state.maxPullCostWei +
          4_200_000n * state.gasPriceCeiling,
      });
      if (job !== undefined) jobs.push(job);
    }
  }
  return { liveRounds, fundingRounds, jobs, minimumViablePrefix: jobs.length === 0 ? 0 : 1 };
}
