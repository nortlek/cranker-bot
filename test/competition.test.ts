import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiParameters,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { poolAbi, standingOrderAbi } from "../src/abi.js";
import {
  aggregateKnownCrankFees,
  aggregatePoolCrankBounties,
  calculateWinningBidBps,
  competitionRegistryBlockNumber,
  directBeneficiaryPaymentFromOperations,
  filterRelevantPoolPulls,
  groupRelevantPoolLifecycleBounties,
  isTransientCompetitionObservationError,
  receiptHasPoolCrankBounty,
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

describe("isTransientCompetitionObservationError", () => {
  it("recognizes only the observed untyped publication-race messages", () => {
    expect(
      isTransientCompetitionObservationError(
        new Error(
          "Invalid parameters were provided to the RPC method.",
        ),
      ),
    ).toBe(true);
    expect(
      isTransientCompetitionObservationError(
        new Error("Missing or invalid parameters."),
      ),
    ).toBe(true);
  });

  it("does not retry malformed requests or unrelated failures", () => {
    expect(
      isTransientCompetitionObservationError(
        new Error("invalid argument 0"),
      ),
    ).toBe(false);
    expect(
      isTransientCompetitionObservationError(
        new Error(
          "Invalid parameters were provided to the RPC method: invalid address",
        ),
      ),
    ).toBe(false);
    expect(
      isTransientCompetitionObservationError(
        "Invalid parameters were provided to the RPC method.",
      ),
    ).toBe(false);
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

describe("directBeneficiaryPaymentFromOperations", () => {
  const transactionHash =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash;
  const unrelatedHash =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hash;

  it("ignores an unrelated near-head trace response", () => {
    expect(
      directBeneficiaryPaymentFromOperations({
        transactionHash,
        beneficiary: CALLER,
        operations: [
          {
            txHash: unrelatedHash,
            to: CALLER,
            value: "900",
            status: true,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("sums only successful matching-transaction payments", () => {
    expect(
      directBeneficiaryPaymentFromOperations({
        transactionHash,
        beneficiary: CALLER,
        operations: [
          {
            txHash: transactionHash.toUpperCase(),
            to: CALLER.toLowerCase(),
            value: "500",
            status: true,
          },
          {
            txHash: transactionHash,
            to: CALLER,
            value: "400",
            status: false,
          },
          {
            txHash: unrelatedHash,
            to: CALLER,
            value: "800",
            status: true,
          },
        ],
      }),
    ).toBe(500n);
  });

  it("accepts an indexed matching transaction with no payment", () => {
    expect(
      directBeneficiaryPaymentFromOperations({
        transactionHash,
        beneficiary: CALLER,
        operations: [
          {
            txHash: transactionHash,
            to: ORDER_A,
            value: "0",
            status: true,
          },
        ],
      }),
    ).toBe(0n);
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

describe("receiptHasPoolCrankBounty", () => {
  it("excludes cross-lane order and pool wrappers from order bid learning", () => {
    const bounty = {
      address: POOL,
      topics: encodeEventTopics({
        abi: poolAbi,
        eventName: "CrankBountyPaid",
        args: { roundId: 54n, cranker: CALLER },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        parseAbiParameters("uint256"),
        [797_389_655_792_695n],
      ),
    };

    expect(
      receiptHasPoolCrankBounty(
        [crankLog(ORDER_A, 100_000_000_000_000n), bounty],
        [POOL],
      ),
    ).toBe(true);
    expect(
      receiptHasPoolCrankBounty(
        [crankLog(ORDER_A, 100_000_000_000_000n)],
        [POOL],
      ),
    ).toBe(false);
  });
});

describe("filterRelevantPoolPulls", () => {
  it("keeps only competitor pulls for the exact missed rounds", () => {
    const competitorHash =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash;
    const otherRoundHash =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hash;
    const ourHash =
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hash;

    expect(
      filterRelevantPoolPulls(
        [
          {
            transactionHash: competitorHash,
            args: { roundId: 46n, cranker: CALLER },
          },
          {
            transactionHash: otherRoundHash,
            args: { roundId: 47n, cranker: CALLER },
          },
          {
            transactionHash: ourHash,
            args: { roundId: 46n, cranker: CALLER },
          },
          {
            transactionHash: null,
            args: { roundId: 46n, cranker: CALLER },
          },
        ],
        {
          lostRoundIds: [46n],
          ourTransactionHashes: [ourHash],
        },
      ),
    ).toEqual([
      {
        transactionHash: competitorHash,
        roundId: 46n,
        cranker: CALLER,
      },
    ]);
  });
});

describe("groupRelevantPoolLifecycleBounties", () => {
  it("aggregates both lifecycle bounties and excludes our transaction", () => {
    const competitorHash =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash;
    const ourHash =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hash;

    expect(
      groupRelevantPoolLifecycleBounties(
        [
          {
            transactionHash: competitorHash,
            args: {
              roundId: 308n,
              cranker: CALLER,
              amount: 400n,
            },
          },
          {
            transactionHash: competitorHash,
            args: {
              roundId: 308n,
              cranker: CALLER,
              amount: 800n,
            },
          },
          {
            transactionHash: competitorHash,
            args: {
              roundId: 307n,
              cranker: CALLER,
              amount: 9_000n,
            },
          },
          {
            transactionHash: ourHash,
            args: {
              roundId: 308n,
              cranker: CALLER,
              amount: 2_000n,
            },
          },
          {
            transactionHash: null,
            args: {
              roundId: 308n,
              cranker: CALLER,
              amount: 3_000n,
            },
          },
        ],
        {
          lostRoundIds: [308n],
          ourTransactionHashes: [ourHash],
        },
      ),
    ).toEqual([
      {
        transactionHash: competitorHash,
        roundId: 308n,
        cranker: CALLER,
        grossPoolReward: 1_200n,
      },
    ]);
  });
});
