import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseTransaction,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { vrfCoordinatorAbi } from "../src/abi.js";
import {
  requestIdFromFulfillmentProof,
  validatePendingFwaFulfillment,
} from "../src/pending-fwa-fulfillment.js";

const oracle = privateKeyToAccount(`0x${"41".repeat(32)}`);
const coordinator = getAddress(
  "0xD7f86b4b8Cae7D942340FF628F82735b7A20893a",
);
const consumer = getAddress(
  "0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c",
);
const proof = {
  pk: [11n, 12n] as const,
  gamma: [13n, 14n] as const,
  c: 15n,
  s: 16n,
  seed: 17n,
  uWitness: oracle.address,
  cGammaWitness: [18n, 19n] as const,
  sHashWitness: [20n, 21n] as const,
  zInv: 22n,
};
const subId = 23n;
const requestId = requestIdFromFulfillmentProof({
  publicKey: proof.pk,
  seed: proof.seed,
});

async function signedFulfillment(overrides: {
  readonly to?: `0x${string}`;
  readonly consumer?: `0x${string}`;
  readonly subId?: bigint;
  readonly proofSeed?: bigint;
  readonly value?: bigint;
} = {}): Promise<Hex> {
  const configuredProof = {
    ...proof,
    seed: overrides.proofSeed ?? proof.seed,
  };
  const data = encodeFunctionData({
    abi: vrfCoordinatorAbi,
    functionName: "fulfillRandomWords",
    args: [
      configuredProof,
      {
        blockNum: 100n,
        subId: overrides.subId ?? subId,
        callbackGasLimit: 900_000,
        numWords: 1,
        sender: overrides.consumer ?? consumer,
        extraArgs:
          "0x92fd13380000000000000000000000000000000000000000000000000000000001",
      },
      false,
    ],
  });
  return oracle.signTransaction({
    chainId: 1,
    type: "eip1559",
    to: overrides.to ?? coordinator,
    value: overrides.value ?? 0n,
    data,
    gas: 1_000_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    nonce: 7,
  });
}

function rpcTransaction(rawTransaction: Hex) {
  const parsed = parseTransaction(rawTransaction);
  if (
    parsed.type === undefined ||
    parsed.chainId === undefined ||
    parsed.nonce === undefined ||
    parsed.to === undefined ||
    parsed.to === null
  ) {
    throw new Error("test fulfillment fixture is incomplete");
  }
  return {
    hash: keccak256(rawTransaction),
    from: oracle.address,
    nonce: parsed.nonce,
    chainId: parsed.chainId,
    type: parsed.type,
    to: parsed.to,
    value: parsed.value ?? 0n,
    input: parsed.data ?? "0x",
  };
}

describe("pending FWA fulfillment validation", () => {
  it("derives the exact request ID from the observed round-355 proof", () => {
    expect(
      requestIdFromFulfillmentProof({
        publicKey: [
          0xb2d22a361d7d2248b6f0b75f4e7ebd04cdfe234894dfd82244cb54d22fca9f9fn,
          0xe0c101fadf0cea73840557cfc071c8d7df88263ea32e79ab4715286c18bb0578n,
        ],
        seed:
          0xf4d763094447c231d46101631c5724e8f958dd5b1b1fbfcb3167661be7d1a1d8n,
      }),
    ).toBe(
      50122926248667946721162522793336820828918720156550601086430947954895331134129n,
    );
  });

  it("accepts an exact signed fulfillment for the pool request", async () => {
    const rawTransaction = await signedFulfillment();
    await expect(
      validatePendingFwaFulfillment({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: rpcTransaction(rawTransaction),
        expectedCoordinator: coordinator,
        expectedConsumer: consumer,
        expectedSubId: subId,
        expectedRequestId: requestId,
      }),
    ).resolves.toMatchObject({
      rawTransaction,
      hash: keccak256(rawTransaction),
      sender: oracle.address,
      coordinator,
      consumer,
      subId,
      requestId,
      value: 0n,
    });
  });

  it.each([
    [
      "consumer_mismatch",
      { consumer: oracle.address },
    ],
    ["subscription_mismatch", { subId: subId + 1n }],
    ["request_mismatch", { proofSeed: proof.seed + 1n }],
    ["value_not_zero", { value: 1n }],
  ] as const)("rejects %s", async (code, overrides) => {
    const rawTransaction = await signedFulfillment(overrides);
    await expect(
      validatePendingFwaFulfillment({
        rawTransaction,
        expectedHash: keccak256(rawTransaction),
        rpcTransaction: rpcTransaction(rawTransaction),
        expectedCoordinator: coordinator,
        expectedConsumer: consumer,
        expectedSubId: subId,
        expectedRequestId: requestId,
      }),
    ).rejects.toMatchObject({
      name: "PendingFwaFulfillmentValidationError",
      code,
    });
  });
});
