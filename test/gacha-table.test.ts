import { describe, expect, it } from "vitest";

import {
  GACHA_TABLE_DEFAULT_BOUNTY,
  gachaTableAcquisitionsAreTerminal,
  gachaTableDefaultCanExecuteInNextBlock,
  gachaTableDefaultDueAt,
  gachaTableExpectedBounty,
} from "../src/gacha-table.js";
import {
  GACHA_TABLE_ADDRESS,
  GACHA_TABLE_DEPLOYMENT_BLOCK,
  GACHA_TABLE_ESCROW_IMPLEMENTATION_ADDRESS,
  GACHA_TABLE_ESCROW_RUNTIME_CODE_HASH,
  GACHA_TABLE_RUNTIME_CODE_HASH,
} from "../src/constants.js";

describe("GachaTable keeper adapter", () => {
  it("pins the verified target and escrow runtimes", () => {
    expect(GACHA_TABLE_ADDRESS).toBe(
      "0xA936351838d1C85003e736deA03AC6666c1F9c73",
    );
    expect(GACHA_TABLE_DEPLOYMENT_BLOCK).toBe(25_744_145n);
    expect(GACHA_TABLE_RUNTIME_CODE_HASH).toBe(
      "0x2cba54c281d3c5b4b940484afba18291262b7a7d07d0791485ea36f80adb14c5",
    );
    expect(GACHA_TABLE_ESCROW_IMPLEMENTATION_ADDRESS).toBe(
      "0xbD361213eC3387a39D6E031d91E3C56e3662a1d0",
    );
    expect(GACHA_TABLE_ESCROW_RUNTIME_CODE_HASH).toBe(
      "0xc29dc6351b3ebdafff9480154fbaff49840f567100e40f7b314d161a6c2ac8e8",
    );
  });

  it("caps a default batch by the remaining fee pool", () => {
    expect(
      gachaTableExpectedBounty({
        feePool: 10n * GACHA_TABLE_DEFAULT_BOUNTY,
        bountyFlat: GACHA_TABLE_DEFAULT_BOUNTY,
        calls: 4,
      }),
    ).toBe(4n * GACHA_TABLE_DEFAULT_BOUNTY);
    expect(
      gachaTableExpectedBounty({
        feePool: GACHA_TABLE_DEFAULT_BOUNTY + 7n,
        bountyFlat: GACHA_TABLE_DEFAULT_BOUNTY,
        calls: 4,
      }),
    ).toBe(GACHA_TABLE_DEFAULT_BOUNTY + 7n);
  });

  it("settles only when all four FWA acquisitions are terminal", () => {
    expect(gachaTableAcquisitionsAreTerminal([2, 2, 3, 4])).toBe(true);
    expect(gachaTableAcquisitionsAreTerminal([2, 2, 2, 5])).toBe(false);
    expect(gachaTableAcquisitionsAreTerminal([2, 2, 2])).toBe(false);
  });

  it("arms a default for the exact immediate child slot", () => {
    expect(
      gachaTableDefaultDueAt({
        allocatedAt: 1_000n,
        settlementWindow: 86_400n,
      }),
    ).toBe(65_800n);
    expect(
      gachaTableDefaultCanExecuteInNextBlock({
        allocatedAt: 1_000n,
        settlementWindow: 86_400n,
        parentTimestamp: 65_788n,
      }),
    ).toBe(true);
    expect(
      gachaTableDefaultCanExecuteInNextBlock({
        allocatedAt: 1_000n,
        settlementWindow: 86_400n,
        parentTimestamp: 65_787n,
      }),
    ).toBe(false);
  });
});
