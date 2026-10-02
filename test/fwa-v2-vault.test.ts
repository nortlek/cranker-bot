import { describe, expect, it } from "vitest";

import {
  FWA_V2_ADDRESS,
  FWA_V2_VAULT,
  FWA_V2_VAULT_FACTORY,
  FWA_V2_VAULT_IMPLEMENTATION,
  FWA_V2_VAULT_ROUTER,
  fwaV2VaultSyncBounty,
  fwaV2VaultAbi,
} from "../src/fwa-v2-vault.js";

describe("FWA V2 autonomous vault", () => {
  it("pins the canonical factory, implementation, vault, FWA, and router", () => {
    expect(FWA_V2_VAULT_FACTORY).toBe("0x2D774bE0c47902306D911b049E03D02dD7E399C6");
    expect(FWA_V2_VAULT_IMPLEMENTATION).toBe("0x0e4bC3E18919cDD4A83746F030b7b89f9Dc522F1");
    expect(FWA_V2_VAULT).toBe("0x12E9aC05B754D9000D5d1D66046457CaBad3D2b6");
    expect(FWA_V2_ADDRESS).toBe("0x958C41181182e76F221331b2755b77D9e1426A98");
    expect(FWA_V2_VAULT_ROUTER).toBe("0x186F4c10152f9a902573b3Fe07F48689Fa8a4927");
  });

  it("decodes every permissionless action and exact payout event", () => {
    const names = new Set<string>(fwaV2VaultAbi.map((item) => "name" in item ? item.name : ""));
    for (const name of ["requestPulls", "sync", "finalizeAuction", "KeeperReimbursed", "BountyPaid"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("reproduces the verified linear sync-bounty ramp", () => {
    const bounty = 300_000_000_000_000n;
    const maximum = 3_000_000_000_000_000n;
    expect(fwaV2VaultSyncBounty({ bounty, maximum, oldestAllocatedAt: 0n, blockTimestamp: 2_000n })).toBe(bounty);
    expect(fwaV2VaultSyncBounty({ bounty, maximum, oldestAllocatedAt: 1_400n, blockTimestamp: 2_000n })).toBe(1_650_000_000_000_000n);
    expect(fwaV2VaultSyncBounty({ bounty, maximum, oldestAllocatedAt: 1n, blockTimestamp: 2_000n })).toBe(maximum);
  });
});
