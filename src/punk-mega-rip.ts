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
  "0x0b6b58578c74012c0c0294d5b7e181b680934E6A" as Address;
export const PUNK_MEGA_RIP_FWA_ADDRESS =
  "0x958C41181182e76F221331b2755b77D9e1426A98" as Address;
export const PUNK_MEGA_RIP_COLLECTION_ADDRESS =
  "0x000000000000003607fce1aC9e043a86675C5C2F" as Address;
export const PUNK_MEGA_RIP_ROUND_IMPLEMENTATION =
  "0x76B60F60c95BF4598A7E62492c6172E439c36EED" as Address;
export const PUNK_MEGA_RIP_BATCH_MODULE =
  "0xe60DdF50ADF318F5eE47160eff07A8C7817a4DB6" as Address;
export const PUNK_MEGA_RIP_LEDGER_MODULE =
  "0x902ea2304289D0703196796F27189B300C1898B5" as Address;
export const PUNK_MEGA_RIP_EXECUTION_MODULE =
  "0xFe630e9EBF21f45Ff306CF2F9A33D9fa053573F2" as Address;
export const PUNK_MEGA_RIP_VALUE_MODULE =
  "0xa2AD7142Ddd4e0FaFDc5b9d67216711A1357F4Dd" as Address;
export const PUNK_MEGA_RIP_RECOVERY_MODULE =
  "0x8d686F85020E9943810332E7389573b7B4f44B46" as Address;
export const PUNK_MEGA_RIP_CONFIG_MODULE =
  "0x9BbA92c2279A7Ac419174cB1830eFcAc66407c2B" as Address;
export const PUNK_MEGA_RIP_ROUND_FACTORY =
  "0x78faDA455E0cb930a1D58281B95DaeCbDd0d6258" as Address;
export const PUNK_MEGA_RIP_PURCHASE_ROUTER =
  "0xd860d67119003E9F9d9139024C2fbC662278092c" as Address;
export const PUNK_MEGA_RIP_REWARD_VAULT =
  "0xEa20a110ad3Dfc483977d14f80203994E65D34FB" as Address;
export const PUNK_MEGA_RIP_ADAPTER_FACTORY =
  "0x3BD47be06151E5eD53648c3A37df756ba22Aa555" as Address;
export const PUNK_MEGA_RIP_VAULT_FACTORY =
  "0xf3381B259B2FE142c0A87bffF463695d935D6F66" as Address;
export const PUNK_MEGA_RIP_OPERATOR =
  "0xCB43078C32423F5348Cab5885911C3B5faE217F9" as Address;

export const PUNK_MEGA_RIP_SERIES_RUNTIME_CODE_HASH =
  "0xd20d08aa5d46fe7fc30d5b0479d09c7498be5871e51512f41484fb037ce53844" as Hex;
export const PUNK_MEGA_RIP_ROUND_RUNTIME_CODE_HASH =
  "0x32a78ba12be40d3ba0ee6445bd2834ab8cc456bef2fb2a2212d69a97fb3e5b55" as Hex;

const PINNED_COMPONENTS = [
  [PUNK_MEGA_RIP_ROUND_IMPLEMENTATION, "0xfeff0b4d4af45dd7435061565d8040e0556e61a04deba279fa09d4d683632798"],
  [PUNK_MEGA_RIP_BATCH_MODULE, "0xeaff6a4dd491a6c12f93e30d4a977d77140e61829f76503717431a3f194ac8ae"],
  [PUNK_MEGA_RIP_LEDGER_MODULE, "0x932ab0c6e3c387758fe68a6995e0464f94fbc137c7b46e6578054e92eb67d104"],
  [PUNK_MEGA_RIP_EXECUTION_MODULE, "0x8bf60d02cf6f9cc0408ad3eefae0d1eb6548fcfea2689fd7939bd25d509c525b"],
  [PUNK_MEGA_RIP_VALUE_MODULE, "0xbe9fe753961f5ba8c6dbce1169161d36a709c51c94438bb204f6d95fc12f6782"],
  [PUNK_MEGA_RIP_RECOVERY_MODULE, "0x0778387143f76b33276d391002ef210a97bf90b6616753a3457fde4a2cfe9b29"],
  [PUNK_MEGA_RIP_CONFIG_MODULE, "0x73458d49395346a8aa75eb2961044bc77450b10d5826cc9cf7e8c6129fd240fd"],
  [PUNK_MEGA_RIP_ROUND_FACTORY, "0xeb59e0c73c0778f37e56e8417903cd9c66dd3b7c6824b4ba1d910fb187b7f961"],
  [PUNK_MEGA_RIP_PURCHASE_ROUTER, "0xd795143208462b18640c0516de592af17ac9b6f71c7481e868aa170228013027"],
  [PUNK_MEGA_RIP_REWARD_VAULT, "0xf3df5842400cde6021f3e7709c584cadce5112370386761f77b257c0ca2743ce"],
  [PUNK_MEGA_RIP_ADAPTER_FACTORY, "0xefea08f9e02e608684fc2ead343e812302d5a689ba9b1023a0ee245d61a204c2"],
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
