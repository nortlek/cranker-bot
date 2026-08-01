import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseEther,
  parseGwei,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  accountStandingOrderBatchReceipt,
  planStandingOrderBatch,
  type KeeperTransactionRequest,
} from "../src/strategy.js";
import { standingOrderAbi } from "../src/abi.js";
import {
  encodeStandingOrderBatchExecution,
  SINGLETON_FACTORY_ADDRESS,
  SINGLETON_FACTORY_RUNTIME_CODE,
  singletonFactoryAbi,
  STANDING_ORDER_BATCH_EXECUTOR_SALT,
  standingOrderBatchEconomics,
  standingOrderBatchExecutorAbi,
  standingOrderBatchExecutorDeployment,
} from "../src/standing-order-batch-executor.js";

const OWNER = getAddress(
  "0xeAaf34AEaF4A10F9c5f5400E0bD6f9f5a8Ba2D48",
);
const ORDER_A = getAddress(
  "0x1000000000000000000000000000000000000001",
);
const ORDER_B = getAddress(
  "0x2000000000000000000000000000000000000002",
);

const members = [
  {
    order: ORDER_A,
    crankFee: parseEther("0.0002"),
    builderBidBps: 9_000n,
    poolVersion: "v2" as const,
  },
  {
    order: ORDER_B,
    crankFee: parseEther("0.0001"),
    builderBidBps: 2_000n,
    poolVersion: "v1" as const,
  },
];

function directPlan() {
  return {
    jobs: members.map((member) => ({
      kind: "standing_order" as const,
      label: `standing_order:${member.order}`,
      target: member.order,
      data: "0x1234" as const,
      gas: 300_000n,
      reward: {
        kind: "fixed" as const,
        amountWei: member.crankFee,
      },
      order: member.order,
      poolVersion: member.poolVersion,
    })),
    minimumViablePrefix: 1,
    orders: 2,
    skipped: new Map<string, number>(),
  };
}

describe("standing-order batch executor integration", () => {
  it("derives a pinned CREATE2 deployment for the production signer", () => {
    const deployment =
      standingOrderBatchExecutorDeployment(OWNER);
    expect(deployment.address).toBe(
      "0x055A48a4C671E2bff6a576B341C10343126e06C2",
    );
    expect(deployment.expectedRuntimeCodeHash).toBe(
      "0xd487ff49e9638a7789bb825309a1216975f59967c6e6ba29f09b0a5cbd2974db",
    );
    expect(
      decodeFunctionData({
        abi: singletonFactoryAbi,
        data: deployment.deployData,
      }),
    ).toEqual({
      functionName: "deploy",
      args: [
        deployment.initCode,
        STANDING_ORDER_BATCH_EXECUTOR_SALT,
      ],
    });
  });

  it("accounts independent bids against only successful order rewards", () => {
    expect(standingOrderBatchEconomics(members)).toEqual({
      grossReward: parseEther("0.0003"),
      builderPayment: parseEther("0.0002"),
      ownerReturn: parseEther("0.0001"),
    });
    expect(
      decodeFunctionData({
        abi: standingOrderBatchExecutorAbi,
        data: encodeStandingOrderBatchExecution(members, 123n),
      }),
    ).toEqual({
      functionName: "execute",
      args: [
        [
          { order: ORDER_A, builderBidBps: 9_000n },
          { order: ORDER_B, builderBidBps: 2_000n },
        ],
        123n,
      ],
    });
  });

  it("plans deployment and execution as one inseparable profitable prefix", async () => {
    const deployment =
      standingOrderBatchExecutorDeployment(OWNER);
    const getCode = vi.fn(
      async ({ address }: { address: string }) =>
        address.toLowerCase() === deployment.address.toLowerCase()
          ? "0x"
          : SINGLETON_FACTORY_RUNTIME_CODE,
    );
    const planned = await planStandingOrderBatch({
      client: { getCode } as never,
      account: OWNER,
      blockNumber: 100n,
      executionGasPrice: parseGwei("0.05"),
      gasLimitMultiplierBps: 12_000n,
      minimumPriorityFeePerGas: parseGwei("1"),
      maxFeePerGasCap: parseGwei("2"),
      minProfitWei: 1n,
      bidBps: (order) =>
        order === ORDER_A ? 9_000n : 2_000n,
      plan: directPlan(),
    });

    expect(planned).toMatchObject({
      executor: deployment.address,
      deploymentIncluded: true,
      minimumViablePrefix: 2,
    });
    expect(planned?.jobs.map((job) => job.kind)).toEqual([
      "standing_order_batch_deploy",
      "standing_order_batch",
    ]);
    expect(planned?.jobs[0]?.target).toBe(
      SINGLETON_FACTORY_ADDRESS,
    );
  });

  it("uses and exactly gas-estimates a pinned deployed executor", async () => {
    const deployment =
      standingOrderBatchExecutorDeployment(OWNER);
    const estimateGas = vi.fn(async () => 400_000n);
    const planned = await planStandingOrderBatch({
      client: {
        getCode: vi.fn(async () => deployment.expectedRuntimeCode),
        estimateGas,
      } as never,
      account: OWNER,
      blockNumber: 101n,
      executionGasPrice: parseGwei("0.05"),
      gasLimitMultiplierBps: 12_000n,
      minimumPriorityFeePerGas: 0n,
      maxFeePerGasCap: parseGwei("2"),
      minProfitWei: 1n,
      bidBps: (order) =>
        order === ORDER_A ? 9_000n : 2_000n,
      plan: directPlan(),
    });

    expect(planned).toMatchObject({
      executor: deployment.address,
      deploymentIncluded: false,
      minimumViablePrefix: 1,
    });
    expect(planned?.jobs).toHaveLength(1);
    expect(planned?.jobs[0]).toMatchObject({
      kind: "standing_order_batch",
      target: deployment.address,
      gas: 480_000n,
    });
    expect(estimateGas).toHaveBeenCalledTimes(2);
  });

  it("keeps the more profitable direct plan instead of deploying", async () => {
    const deployment =
      standingOrderBatchExecutorDeployment(OWNER);
    const planned = await planStandingOrderBatch({
      client: {
        getCode: vi.fn(
          async ({ address }: { address: string }) =>
            address.toLowerCase() ===
            deployment.address.toLowerCase()
              ? "0x"
              : SINGLETON_FACTORY_RUNTIME_CODE,
        ),
      } as never,
      account: OWNER,
      blockNumber: 102n,
      executionGasPrice: parseGwei("0.05"),
      gasLimitMultiplierBps: 12_000n,
      minimumPriorityFeePerGas: 0n,
      maxFeePerGasCap: parseGwei("2"),
      minProfitWei: 1n,
      bidBps: (order) =>
        order === ORDER_A ? 9_000n : 2_000n,
      plan: directPlan(),
    });

    expect(planned).toBeUndefined();
  });

  it("rejects receipt accounting unless member logs and the batch event agree", () => {
    const request = {
      kind: "standing_order_batch",
      label: "standing_order_batch:2",
      target: standingOrderBatchExecutorDeployment(OWNER).address,
      data: "0x",
      gas: 600_000n,
      reward: { kind: "fixed", amountWei: parseEther("0.0001") },
      standingOrderBatchMembers: members,
      embeddedGrossReward: parseEther("0.0003"),
      embeddedBuilderPayment: parseEther("0.0002"),
      nonce: 1,
      maxFeePerGas: parseGwei("1"),
      maxPriorityFeePerGas: 0n,
    } satisfies KeeperTransactionRequest;

    expect(accountStandingOrderBatchReceipt(request, [])).toMatchObject({
      valid: false,
      reason: "batch_event_missing",
      includedOrders: [],
    });

    const crankLog = (order: typeof ORDER_A, fee: bigint) => ({
      address: order,
      topics: encodeEventTopics({
        abi: standingOrderAbi,
        eventName: "Cranked",
        args: { roundId: 1n, caller: request.target },
      }) as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters(
        [
          { type: "uint32" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [1, parseEther("0.005"), fee],
      ),
    });
    expect(
      accountStandingOrderBatchReceipt(request, [
        crankLog(ORDER_A, parseEther("0.0002")),
        crankLog(ORDER_B, parseEther("0.0001")),
        {
          address: request.target,
          topics: encodeEventTopics({
            abi: standingOrderBatchExecutorAbi,
            eventName: "BatchExecuted",
          }) as [`0x${string}`, ...`0x${string}`[]],
          data: encodeAbiParameters(
            [
              { type: "uint256" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "uint256" },
            ],
            [
              2n,
              2n,
              parseEther("0.0003"),
              parseEther("0.0002"),
              parseEther("0.0001"),
            ],
          ),
        },
      ]),
    ).toEqual({
      valid: true,
      attempted: 2n,
      succeeded: 2n,
      grossReward: parseEther("0.0003"),
      builderPayment: parseEther("0.0002"),
      ownerReturn: parseEther("0.0001"),
      includedOrders: [ORDER_A, ORDER_B],
    });
  });
});
