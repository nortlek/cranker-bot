import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { poolAbi, standingOrderAbi } from "../src/abi.js";
import {
  aggregateKnownCrankFees,
  aggregatePoolCrankBounties,
  calculateWinningBidBps,
  competitionRegistryBlockNumber,
} from "../src/competition.js";

const ORDER_A = getAddress(
  "0x1111111111111111111111111111111111111111",
);
const ORDER_B = getAddress(
  "0x2222222222222222222222222222222222222222",
);
const UNKNOWN_ORDER = getAddress(
  "0x3333333333333333333333333333333333333333",
);
const CALLER = getAddress(
  "0x4444444444444444444444444444444444444444",
);
const POOL = getAddress(
  "0x5555555555555555555555555555555555555555",
);

describe("competitionRegistryBlockNumber", () => {
  it("uses the fully available planning parent state", () => {
    expect(competitionRegistryBlockNumber(25_640_510n)).toBe(
      25_640_509n,
    );
  });

  it("rejects a target without a parent", () => {
    expect(() => competitionRegistryBlockNumber(0n)).toThrow(
      "must have a parent block",
    );
  });
});

function crankLog(address: Address, fee: bigint) {
  return {
    address,
    topics: encodeEventTopics({
      abi: standingOrderAbi,
      eventName: "Cranked",
      args: {
        roundId: 278n,
        caller: CALLER,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      parseAbiParameters("uint32,uint256,uint256"),
      [1, 1_000n, fee],
    ),
  };
}

describe("calculateWinningBidBps", () => {
  it("includes direct block-beneficiary payments", () => {
    const result = calculateWinningBidBps({
      totalCrankFees: 300_000_000_000_000n,
      gasUsed: 208_714n,
      effectiveGasPrice: 153_718_129n,
      baseFeePerGas: 153_718_129n,
      directBeneficiaryPayment: 257_883_747_012_408n,
    });

    expect(result.priorityPayment).toBe(0n);
    expect(result.winningBidBps).toBe(8_597n);
  });

  it("adds priority fees to a direct payment", () => {
    const result = calculateWinningBidBps({
      totalCrankFees: 1_000n,
      gasUsed: 10n,
      effectiveGasPrice: 12n,
      baseFeePerGas: 10n,
      directBeneficiaryPayment: 500n,
    });

    expect(result.priorityPayment).toBe(20n);
    expect(result.totalBuilderPayment).toBe(520n);
    expect(result.winningBidBps).toBe(5_200n);
  });
});

describe("aggregateKnownCrankFees", () => {
  it("uses every known order fee in one competitor receipt", () => {
    expect(
      aggregateKnownCrankFees(
        [
          crankLog(ORDER_A, 300_000_000_000_000n),
          crankLog(ORDER_B, 300_000_000_000_000n),
          crankLog(UNKNOWN_ORDER, 900_000_000_000_000n),
          {
            address: ORDER_A,
            topics: ["0x1234"] as readonly Hex[],
            data: "0x" as Hex,
          },
        ],
        [ORDER_A, ORDER_B],
      ),
    ).toEqual({
      orderCount: 2,
      totalCrankFees: 600_000_000_000_000n,
    });
  });
});

describe("aggregatePoolCrankBounties", () => {
  it("uses only the matching pool and lifecycle round", () => {
    const bountyLog = (
      address: Address,
      roundId: bigint,
      amount: bigint,
    ) => ({
      address,
      topics: encodeEventTopics({
        abi: poolAbi,
        eventName: "CrankBountyPaid",
        args: {
          roundId,
          cranker: CALLER,
        },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        parseAbiParameters("uint256"),
        [amount],
      ),
    });

    expect(
      aggregatePoolCrankBounties(
        [
          bountyLog(POOL, 302n, 800n),
          bountyLog(POOL, 302n, 400n),
          bountyLog(POOL, 301n, 900n),
          bountyLog(ORDER_A, 302n, 1_000n),
          {
            address: POOL,
            topics: ["0x1234"] as readonly Hex[],
            data: "0x" as Hex,
          },
        ],
        POOL,
        302n,
      ),
    ).toBe(1_200n);
  });
});
