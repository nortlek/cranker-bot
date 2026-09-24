import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import {
  PUNK_MEGA_RIP_REIMBURSEMENT_GAS_BONUS_FLOOR,
  punkMegaRipRequestData,
  punkMegaRipRoundAbi,
  punkMegaRipSyncData,
} from "../src/punk-mega-rip.js";
import { estimatedJobReward, type KeeperJob } from "../src/strategy.js";

describe("Punk MegaRip batch keeper", () => {
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
