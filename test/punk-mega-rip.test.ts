import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import {
  PUNK_MEGA_RIP_ROUND_IMPLEMENTATION,
  PUNK_MEGA_RIP_ROUND_RUNTIME_CODE_HASH,
  PUNK_MEGA_RIP_REIMBURSEMENT_GAS_BONUS_FLOOR,
  PUNK_MEGA_RIP_SERIES_ADDRESS,
  PUNK_MEGA_RIP_SERIES_RUNTIME_CODE_HASH,
  punkMegaRipRequestData,
  punkMegaRipRoundAbi,
  punkMegaRipSyncData,
} from "../src/punk-mega-rip.js";
import { estimatedJobReward, type KeeperJob } from "../src/strategy.js";

describe("Punk MegaRip batch keeper", () => {
  it("pins the active Punk or Bust successor generation", () => {
    expect(PUNK_MEGA_RIP_SERIES_ADDRESS.toLowerCase()).toBe(
      "0x0b6b58578c74012c0c0294d5b7e181b680934e6a",
    );
    expect(PUNK_MEGA_RIP_ROUND_IMPLEMENTATION.toLowerCase()).toBe(
      "0x76b60f60c95bf4598a7e62492c6172e439c36eed",
    );
    expect(PUNK_MEGA_RIP_SERIES_RUNTIME_CODE_HASH).toBe(
      "0xd20d08aa5d46fe7fc30d5b0479d09c7498be5871e51512f41484fb037ce53844",
    );
    expect(PUNK_MEGA_RIP_ROUND_RUNTIME_CODE_HASH).toBe(
      "0x32a78ba12be40d3ba0ee6445bd2834ab8cc456bef2fb2a2212d69a97fb3e5b55",
    );
  });

  it("binds request batches to the exact next pull and witness", () => {
    const decoded = decodeFunctionData({
      abi: punkMegaRipRoundAbi,
      data: punkMegaRipRequestData({
        expectedFirst: 2n,
        witnessListingId: 55n,
      }),
    });

    expect(decoded.functionName).toBe("requestPullBatch");
    expect(decoded.args).toEqual([2n, 55n, 1n]);
  });

  it("binds sync batches to the exact cursor", () => {
    const decoded = decodeFunctionData({
      abi: punkMegaRipRoundAbi,
      data: punkMegaRipSyncData({ expectedFirst: 1n }),
    });

    expect(decoded.functionName).toBe("syncAndSettle");
    expect(decoded.args).toEqual([1n, 1n]);
  });

  it("prices only the conservative verified reimbursement surplus", () => {
    const job = {
      kind: "punk_mega_rip_request",
      label: "test",
      target: "0x0000000000000000000000000000000000000001",
      data: "0x",
      gas: 1_000_000n,
      reward: {
        kind: "gas_reimbursement",
        flatProfitWei: 0n,
        callCount: 1n,
        gasPriceCeiling: 1_200_000_000n,
        priorityFeeCap: 2_000_000_000n,
        executorGasDiscount: 0n,
        reimbursementGasBonus:
          PUNK_MEGA_RIP_REIMBURSEMENT_GAS_BONUS_FLOOR,
        reimbursedGasCap: 1_500_000n,
        maximumPayoutWei: 2_000_000_000_000_000n,
      },
    } satisfies KeeperJob;

    expect(
      estimatedJobReward({
        job,
        gasUsed: 1_000_000n,
        baseFeePerGas: 100_000_000n,
        transactionGasPricePerGas: 200_000_000n,
        poolBountyEstimateBps: 10_000n,
        poolPullBountyEstimateBps: 10_000n,
      }),
    ).toBe(1_015_000n * 200_000_000n);
  });
});
