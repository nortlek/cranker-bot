import "dotenv/config";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { planApeballJobs } from "../src/apeball-keeper.js";
import { errorFingerprint } from "../src/format.js";

// No key, wallet client, database, or transaction submission is constructed.
try {
  const endpoint = process.env.DISCOVERY_RPC_URLS?.split(",").map((s) => s.trim()).find(Boolean)
    || process.env.DISCOVERY_RPC_URL || process.env.RPC_URL;
  if (!endpoint) throw new Error("Read-only RPC required");
  const client = createPublicClient({ chain: mainnet, transport: http(endpoint, { retryCount: 0, timeout: 15_000 }) });
  const block = await client.getBlock();
  if (!block.number || block.baseFeePerGas === null) throw new Error("Incomplete parent");
  const targetGas = block.gasLimit / 2n;
  const baseFee = block.gasUsed > targetGas
    ? block.baseFeePerGas + (block.baseFeePerGas * (block.gasUsed - targetGas) / targetGas / 8n || 1n)
    : block.baseFeePerGas - block.baseFeePerGas * (targetGas - block.gasUsed) / targetGas / 8n;
  const plan = await planApeballJobs({
    client, account: "0x0000000000000000000000000000000000000001",
    blockNumber: block.number, baseFeePerGas: baseFee,
    minProfitWei: 10_000_000_000_000n, gasLimitMultiplierBps: 12_000n, builderBidBps: 1_000n,
  });
  if ((await client.getBlock({blockNumber: block.number})).hash !== block.hash) throw new Error("Inspection parent reorganized");
  console.log(JSON.stringify({ event: "apeball_keeper_plan", block: block.number, blockHash: block.hash,
    syntheticCaller: true, liveAuthorized: false, minimumViablePrefix: plan.minimumViablePrefix,
    jobs: plan.jobs.map(({kind, gas, reward}) => ({kind, gas, reward})) },
    (_, value) => typeof value === "bigint" ? value.toString() : value));
} catch(error) {
  console.error(JSON.stringify({event: "apeball_keeper_inspection_failed", ...errorFingerprint(error)}));
  process.exitCode = 1;
}
