import { getAddress, isAddressEqual, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";

// Frontend interfaces are research evidence, not a verified deployment manifest.
// Nothing in this module creates KeeperJobs or authorizes signing.
export const APEBALL_ORIGIN = "https://apeball.fun";
export const apeballContracts = ["game", "vault", "poolOwner", "burner", "hook", "token", "adapter", "collection"] as const;
export type ApeballContract = typeof apeballContracts[number];
export interface ApeballPublication {
  chainId: number;
  deployed: boolean;
  addresses: Record<ApeballContract, Address>;
}

export function parseApeballPublication(source: string): ApeballPublication | undefined {
  // Parse only a literal object. Never evaluate JavaScript supplied by a website.
  const objects = [...source.matchAll(/\{\s*(?:"chainId"|chainId)\s*:\s*\d+\s*,\s*(?:"deployed"|deployed)\s*:\s*(?:!0|!1|true|false)\s*(?:,[^{}]*)?\}/g)];
  if (objects.length === 0) return undefined;
  if (objects.length !== 1) throw new Error("Ambiguous Apeball deployment publication");
  const literal = objects[0]![0].replace(/([,{]\s*)([A-Za-z][A-Za-z0-9]*)\s*:/g, '$1"$2":').replace(/:\s*!0(?=\s*[,}])/g, ":true").replace(/:\s*!1(?=\s*[,}])/g, ":false");
  const fields = JSON.parse(literal) as Record<string, unknown>;
  // JSON.parse silently accepts duplicate keys; deployment identity must not.
  const keys = [...literal.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*:/g)].map((m) => m[1]);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate deployment field");
  if (fields.chainId !== 1 || typeof fields.deployed !== "boolean") throw new Error("Unsupported Apeball chain");
  const addresses = {} as Record<ApeballContract, Address>;
  for (const name of apeballContracts) {
    const value = fields[name];
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Invalid Apeball address");
    addresses[name] = getAddress(value);
  }
  return { chainId: 1, deployed: fields.deployed, addresses };
}

export function apeballPublicationStatus(publication: ApeballPublication): "unpublished" | "published_unverified" {
  if (publication.chainId !== 1) throw new Error("Unsupported Apeball chain");
  if (!publication.deployed) return "unpublished";
  const values = apeballContracts.map((name) => publication.addresses[name]);
  if (values.some((address) => isAddressEqual(address, zeroAddress)) || new Set(values.map((a) => a.toLowerCase())).size !== values.length) {
    throw new Error("Incomplete or aliased Apeball deployment");
  }
  return "published_unverified";
}

export const apeballInspectionAbi = parseAbi([
  "function game() view returns (address)",
  "function vault() view returns (address)",
  "function poolOwner() view returns (address)",
  "function burner() view returns (address)",
  "function adapter() view returns (address)",
  "function collection() view returns (address)",
  "function token() view returns (address)",
  "function hook() view returns (address)",
  "function pool() view returns (address)",
  "function owner() view returns (address)",
  "function keeperParams() view returns ((uint256 maxGasPrice,uint256 gasOverhead,uint256 flatFee,uint256 payDelay))",
  "function keeperAllowance() view returns (uint256)",
  "function keeperAvailable() view returns (uint256)",
  "function keeperPaid() view returns (uint256)",
  "function lastUpkeepAt() view returns (uint256)",
  "function lastMaintenanceAt() view returns (uint256)",
  "function activated() view returns (bool)",
  "function paused() view returns (bool)",
  "function retiring() view returns (bool)",
  "function retired() view returns (bool)",
  "function replacementsOwed() view returns (uint256)",
  "function seenSeq() view returns (uint256)",
  "function REWARD_BPS() view returns (uint256)",
  "function REWARD_CAP() view returns (uint256)",
  "function nextSweepBlock() view returns (uint256)",
  "function generalBalance() view returns (uint256)",
  "function liveBid() view returns (uint256)",
  "function sweepRewards() view returns (uint256)",
  "function bidParams() view returns ((uint256 thresholdBps,uint256 maxSweepWei,uint256 minBlocksBetweenSweeps,uint256 maxPrice,uint256 ceilingBps,uint256 slowSweepWei,uint256 maxDropBps))",
  "function nextSlice() view returns (uint256 amount,bool milestone,uint256 runAt)",
  "function priceOk() view returns (bool)",
  "function MAX_TIP_BPS() view returns (uint256)",
  "function milestoneBalance() view returns (uint256)",
  "function ongoingBalance() view returns (uint256)",
  "function cadence() view returns ((uint256 baseSliceWei,uint256 perDrawWei,uint256 backlogBps,uint256 maxSliceWei,uint256 idleSpacing,uint256 minSpacing,uint256 drawsToHalve,uint256 maxImpactBps,uint256 maxDeviationBps))",
]);
export type ApeballRead = typeof apeballInspectionAbi[number]["name"];

export interface ApeballReader {
  chainId(): Promise<number>;
  head(): Promise<{ number: bigint; hash: Hex; timestamp: bigint }>;
  code(address: Address, block: bigint): Promise<Hex | undefined>;
  read(address: Address, name: ApeballRead, block: bigint): Promise<unknown>;
  hashAt(block: bigint): Promise<Hex>;
}

const stateReads = {
  game: ["keeperParams", "keeperAllowance", "keeperAvailable", "keeperPaid", "lastUpkeepAt", "lastMaintenanceAt", "activated", "paused", "retiring", "retired", "replacementsOwed", "seenSeq"],
  vault: ["REWARD_BPS", "REWARD_CAP", "nextSweepBlock", "generalBalance", "liveBid", "sweepRewards", "bidParams"],
  burner: ["nextSlice", "priceOk", "MAX_TIP_BPS", "keeperPaid", "milestoneBalance", "ongoingBalance", "cadence"],
} as const satisfies Partial<Record<ApeballContract, readonly ApeballRead[]>>;

const relationships = {
  game: ["vault", "poolOwner", "burner"],
  vault: ["game", "poolOwner", "burner", "adapter", "collection"],
  poolOwner: ["game", "vault", "collection"],
  burner: ["game", "poolOwner", "token", "hook"],
} as const;

export async function inspectApeball(publication: ApeballPublication, reader: ApeballReader) {
  const status = apeballPublicationStatus(publication);
  if (status === "unpublished") return { status, executionAllowed: false as const, reason: "No published deployment" };
  if (await reader.chainId() !== 1) throw new Error("Apeball RPC chain mismatch");
  const head = await reader.head();
  const runtimeHashes: Partial<Record<ApeballContract, Hex>> = {};
  for (const name of apeballContracts) {
    const code = await reader.code(publication.addresses[name], head.number);
    if (!code || code === "0x") throw new Error("Missing Apeball runtime");
    runtimeHashes[name] = keccak256(code);
  }
  for (const [from, targets] of Object.entries(relationships)) {
    for (const target of targets) {
      const actual = await reader.read(publication.addresses[from as ApeballContract], target, head.number);
      if (typeof actual !== "string" || !isAddressEqual(actual as Address, publication.addresses[target])) throw new Error("Apeball relationship mismatch");
    }
  }
  const pool = await reader.read(publication.addresses.game, "pool", head.number);
  const ownerPool = await reader.read(publication.addresses.poolOwner, "pool", head.number);
  if (typeof pool !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(pool) || isAddressEqual(pool as Address, zeroAddress) || typeof ownerPool !== "string" || !isAddressEqual(pool as Address, ownerPool as Address)) throw new Error("Apeball pool mismatch");
  const poolCode = await reader.code(pool as Address, head.number);
  if (!poolCode || poolCode === "0x") throw new Error("Missing Apeball pool runtime");
  const poolOwner = await reader.read(pool as Address, "owner", head.number);
  if (typeof poolOwner !== "string" || !isAddressEqual(poolOwner as Address, publication.addresses.poolOwner)) throw new Error("Apeball pool owner mismatch");
  const state: Record<string, Record<string, unknown>> = {};
  for (const [name, reads] of Object.entries(stateReads)) {
    const values: Record<string, unknown> = {};
    for (const method of reads) values[method] = await reader.read(publication.addresses[name as ApeballContract], method, head.number);
    state[name] = values;
  }
  if (await reader.hashAt(head.number) !== head.hash) throw new Error("Apeball inspection block reorganized");
  return {
    status, executionAllowed: false as const,
    reason: "Runtime hashes are observed, not trusted pins; verified source, reward semantics and fork validation still required",
    block: head, addresses: publication.addresses, runtimeHashes,
    pool, poolRuntimeHash: keccak256(poolCode), state,
  };
}
