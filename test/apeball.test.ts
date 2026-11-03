import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import { apeballContracts, apeballPublicationStatus, inspectApeball, parseApeballPublication, type ApeballPublication, type ApeballReader } from "../src/apeball.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
function publication(): ApeballPublication {
  return { chainId: 1, deployed: true, addresses: Object.fromEntries(apeballContracts.map((name, i) => [name, address(i + 1)])) as ApeballPublication["addresses"] };
}
function fixture() {
  const p = publication();
  const reader: ApeballReader = {
    chainId: vi.fn(async () => 1),
    head: vi.fn(async () => ({ number: 123n, hash, timestamp: 456n })),
    code: vi.fn(async () => "0x6000" as Hex),
    read: vi.fn(async (_address, name) => name === "pool" ? address(100) : name === "owner" ? p.addresses.poolOwner : name in p.addresses ? p.addresses[name as keyof typeof p.addresses] : 0n),
    hashAt: vi.fn(async () => hash),
  };
  return { p, reader };
}

describe("Apeball discovery remains read-only", () => {
  it("parses the literal prelaunch publication without evaluating code", () => {
    const fields = apeballContracts.map((name) => `${name}:"${zeroAddress}"`).join(",");
    const parsed = parseApeballPublication(`throw new Error('never execute');t.exports={chainId:1,deployed:!1,${fields}}`)!;
    expect(apeballPublicationStatus(parsed)).toBe("unpublished");
    expect(parseApeballPublication("unrelated bundle")).toBeUndefined();
  });
  it("rejects ambiguous, incomplete, duplicate and wrong-chain publications", () => {
    const p = publication();
    const literal = JSON.stringify({ chainId: 1, deployed: true, ...p.addresses });
    expect(() => parseApeballPublication(literal + literal)).toThrow("Ambiguous");
    expect(() => parseApeballPublication(literal.replace('"chainId":1', '"chainId":2'))).toThrow("chain");
    expect(() => parseApeballPublication('{chainId:1,deployed:!0}')).toThrow("address");
    expect(() => parseApeballPublication(literal.replace('"deployed":true', '"deployed":true,"deployed":false'))).toThrow("Duplicate");
    p.addresses.game = zeroAddress;
    expect(() => apeballPublicationStatus(p)).toThrow("Incomplete");
    p.addresses.game = p.addresses.vault;
    expect(() => apeballPublicationStatus(p)).toThrow("aliased");
  });
  it("does not touch RPC when deployment is unpublished", async () => {
    const { p, reader } = fixture();
    p.deployed = false;
    expect(await inspectApeball(p, reader)).toMatchObject({ status: "unpublished", executionAllowed: false });
    expect(reader.chainId).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
  });
  it("pins every state/code read and never promotes observed hashes to execution authority", async () => {
    const { p, reader } = fixture();
    expect(await inspectApeball(p, reader)).toMatchObject({ status: "published_unverified", executionAllowed: false, block: { number: 123n } });
    for (const call of vi.mocked(reader.read).mock.calls) expect(call[2]).toBe(123n);
    for (const call of vi.mocked(reader.code).mock.calls) expect(call[1]).toBe(123n);
    expect(reader.hashAt).toHaveBeenCalledWith(123n);
  });
  it("rejects wrong RPC chain, missing runtime, mismatched relationships and reorganizations", async () => {
    let f = fixture();
    vi.mocked(f.reader.chainId).mockResolvedValue(8453);
    await expect(inspectApeball(f.p, f.reader)).rejects.toThrow("chain mismatch");
    expect(f.reader.head).not.toHaveBeenCalled();
    f = fixture();
    vi.mocked(f.reader.code).mockResolvedValue("0x");
    await expect(inspectApeball(f.p, f.reader)).rejects.toThrow("runtime");
    f = fixture();
    vi.mocked(f.reader.read).mockResolvedValue(zeroAddress);
    await expect(inspectApeball(f.p, f.reader)).rejects.toThrow("relationship");
    f = fixture();
    vi.mocked(f.reader.hashAt).mockResolvedValue(`0x${"cd".repeat(32)}`);
    await expect(inspectApeball(f.p, f.reader)).rejects.toThrow("reorganized");
  });
  it("fails inspection on read errors instead of reporting a zero reward or idle state", async () => {
    const { p, reader } = fixture();
    vi.mocked(reader.read).mockRejectedValue(new Error("unavailable"));
    await expect(inspectApeball(p, reader)).rejects.toThrow("unavailable");
  });
});
