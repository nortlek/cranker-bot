import "dotenv/config";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { APEBALL_ORIGIN, apeballInspectionAbi, inspectApeball, parseApeballPublication, type ApeballPublication } from "../src/apeball.js";
import { errorFingerprint } from "../src/format.js";

// Only fetch same-origin static assets, never execute the site's JavaScript.
async function fetchText(path: string): Promise<string> {
  const response = await fetch(new URL(path, APEBALL_ORIGIN), { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error("Apeball publication unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 5_000_000) throw new Error("Apeball publication too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const html = await fetchText("/");
  const paths = [...new Set([...html.matchAll(/<script\b[^>]*\bsrc="(\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js)"/g)].map((m) => m[1]!))];
  if (!paths.length || paths.length > 40) throw new Error("Unexpected Apeball asset manifest");
  let publication: ApeballPublication | undefined;
  let sourcePath: string | undefined;
  // Small batches keep discovery bounded while avoiding a long serial crawl.
  for (let i = 0; i < paths.length; i += 4) {
    const batch = paths.slice(i, i + 4);
    const results = await Promise.all(batch.map(async (path) => ({ path, parsed: parseApeballPublication(await fetchText(path)) })));
    for (const { path, parsed } of results) {
      if (!parsed) continue;
      if (publication) throw new Error("Multiple Apeball deployment publications");
      publication = parsed;
      sourcePath = path;
    }
  }
  if (!publication) throw new Error("Apeball deployment publication not found");
  const endpoint = process.env.DISCOVERY_RPC_URLS?.split(",").map((s) => s.trim()).find(Boolean)
    || process.env.DISCOVERY_RPC_URL || "https://ethereum-rpc.publicnode.com";
  const client = createPublicClient({ chain: mainnet, transport: http(endpoint, { retryCount: 0, timeout: 15_000 }) });
  const result = await inspectApeball(publication, {
    chainId: () => client.getChainId(),
    head: async () => {
      const block = await client.getBlock();
      if (block.number === null || block.hash === null) throw new Error("Missing Apeball inspection head");
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    code: (address, blockNumber) => client.getCode({ address, blockNumber }),
    read: (address, functionName, blockNumber) => client.readContract({ address, abi: apeballInspectionAbi, functionName, blockNumber }),
    hashAt: async (blockNumber) => (await client.getBlock({ blockNumber })).hash,
  });
  console.log(JSON.stringify({ event: "apeball_inspection", source: `${APEBALL_ORIGIN}${sourcePath}`, ...result }, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "apeball_inspection_failed", ...errorFingerprint(error) }));
  process.exitCode = 1;
});
