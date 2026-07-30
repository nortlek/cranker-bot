import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  PendingFundingExecutionController,
  SignerSubmissionCoordinator,
  signerNonceIsUsable,
} from "../src/signer-coordinator.js";

const account = getAddress(
  "0x0000000000000000000000000000000000000001",
);

describe("SignerSubmissionCoordinator", () => {
  it("allows only one signer decision for a target block", () => {
    const coordinator = new SignerSubmissionCoordinator();
    const normal = coordinator.tryReserve({
      targetBlock: 101n,
      nonce: 7,
      lane: "normal",
    });

    expect(normal).toBeDefined();
    expect(
      coordinator.tryReserve({
        targetBlock: 101n,
        nonce: 7,
        lane: "pending_funding",
      }),
    ).toBeUndefined();
    expect(coordinator.reservationFor(101n)?.lane).toBe("normal");
  });

  it("retains an accepted reservation until its block is observed", () => {
    const coordinator = new SignerSubmissionCoordinator();
    const reservation = coordinator.tryReserve({
      targetBlock: 101n,
      nonce: 7,
      lane: "pending_funding",
    });

    expect(reservation).toBeDefined();
    coordinator.observeHead(100n);
    expect(coordinator.reservationFor(101n)).toBe(reservation);
    coordinator.observeHead(101n);
    expect(coordinator.reservationFor(101n)).toBeUndefined();
  });

  it("releases only the matching reservation", () => {
    const coordinator = new SignerSubmissionCoordinator();
    const reservation = coordinator.tryReserve({
      targetBlock: 101n,
      nonce: 7,
      lane: "normal",
    })!;

    expect(
      coordinator.release({
        ...reservation,
        id: Symbol("stale"),
      }),
    ).toBe(false);
    expect(coordinator.release(reservation)).toBe(true);
    expect(coordinator.reservationFor(101n)).toBeUndefined();
  });
});

describe("signerNonceIsUsable", () => {
  it("requires latest, pending, and expected nonces to match", () => {
    expect(
      signerNonceIsUsable({
        account,
        expectedNonce: 7,
        latestNonce: 7,
        pendingNonce: 7,
      }),
    ).toBe(true);
    expect(
      signerNonceIsUsable({
        account,
        expectedNonce: 7,
        latestNonce: 7,
        pendingNonce: 8,
      }),
    ).toBe(false);
    expect(
      signerNonceIsUsable({
        account,
        expectedNonce: 7,
        latestNonce: 8,
        pendingNonce: 8,
      }),
    ).toBe(false);
  });
});

describe("PendingFundingExecutionController", () => {
  it("keeps pending signer work disarmed until lease handoff", async () => {
    const controller =
      new PendingFundingExecutionController(false);
    const task = vi.fn(async () => undefined);

    expect(controller.enabled).toBe(false);
    expect(controller.start(task)).toBeUndefined();
    expect(task).not.toHaveBeenCalled();

    expect(controller.activate()).toBe(true);
    await controller.start(task);

    expect(controller.enabled).toBe(true);
    expect(task).toHaveBeenCalledOnce();
  });

  it("aborts and drains active signer work before shutdown completes", async () => {
    const controller = new PendingFundingExecutionController();
    let taskFinished = false;
    let releaseTask: (() => void) | undefined;
    const task = controller.start(
      async (signal) =>
        new Promise<void>((resolve) => {
          const observeAbort = (): void => {
            releaseTask = () => {
              taskFinished = true;
              resolve();
            };
          };
          if (signal.aborted) observeAbort();
          else {
            signal.addEventListener(
              "abort",
              observeAbort,
              { once: true },
            );
          }
        }),
    );

    expect(task).toBeDefined();
    const drain = controller.stopAndDrain();
    await vi.waitFor(() =>
      expect(releaseTask).toBeDefined(),
    );
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseTask?.();
    await drain;
    expect(taskFinished).toBe(true);
    expect(controller.active).toBe(false);
    expect(controller.stopping).toBe(true);
    expect(controller.enabled).toBe(false);
    expect(controller.activate()).toBe(false);
    expect(
      controller.start(async () => undefined),
    ).toBeUndefined();
  });
});
