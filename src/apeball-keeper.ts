import { BaseError, ContractFunctionRevertedError, decodeFunctionData, decodeEventLog, encodeFunctionData, isAddressEqual, keccak256, parseAbi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { APEBALL_PINS, APEBALL_LINKS } from "./apeball-deployment.js";
import { apeballExecutorAbi, apeballExecutorDeployment, APEBALL_DEPLOY_GAS } from "./apeball-keeper-executor.js";
import { SINGLETON_FACTORY_ADDRESS, SINGLETON_FACTORY_RUNTIME_CODE } from "./standing-order-batch-executor.js";
import { bufferedGas } from "./economics.js";
import type { KeeperJob } from "./strategy.js";

export const APEBALL_ACTIONS = ["sync", "sweep", "process"] as const;
const GAS_ENVELOPE = 16_000_000n;
const linkAbi = parseAbi([...new Set(APEBALL_LINKS.map((l) => l.method)), "game", "vault", "burner", "poolOwner", "collection", "adapter", "owner"].map((name) => `function ${name}() view returns (address)`));
const extraLinks = [
  { from: "vault", method: "game", address: APEBALL_PINS.game.address },
  { from: "vault", method: "poolOwner", address: APEBALL_PINS.poolOwner.address },
  { from: "vault", method: "burner", address: APEBALL_PINS.burner.address },
  { from: "vault", method: "adapter", address: APEBALL_PINS.adapter.address },
  { from: "poolOwner", method: "game", address: APEBALL_PINS.game.address },
  { from: "poolOwner", method: "vault", address: APEBALL_PINS.vault.address },
  { from: "poolOwner", method: "pool", address: APEBALL_PINS.pool.address },
  { from: "burner", method: "game", address: APEBALL_PINS.game.address },
  { from: "burner", method: "poolOwner", address: APEBALL_PINS.poolOwner.address },
  { from: "pool", method: "owner", address: APEBALL_PINS.poolOwner.address },
] as const;
export async function verifyApeballRuntime(client: PublicClient<Transport, Chain>, blockNumber: bigint) {
  // Revalidate mutable wiring and code every pass, always at the planning parent.
  if (client.chain.id !== 1) throw new Error("Apeball requires mainnet");
  const codes = await Promise.all(Object.values(APEBALL_PINS).map(async (pin) => {
    const code = await client.getCode({ address: pin.address, blockNumber });
    return code !== undefined && keccak256(code) === pin.hash;
  }));
  if (codes.some((valid) => !valid)) throw new Error("Apeball runtime pin mismatch");
  await Promise.all([...APEBALL_LINKS, ...extraLinks].map(async (link) => {
    const actual = await client.readContract({ address: APEBALL_PINS[link.from].address, abi: linkAbi, functionName: link.method, blockNumber });
    if (!isAddressEqual(actual as Address, link.address)) throw new Error("Apeball relationship pin mismatch");
  }));
}
export interface ApeballPlan { readonly jobs: readonly KeeperJob[]; readonly minimumViablePrefix: number }
export function apeballMandatoryPlan(action: KeeperJob | undefined, deploy: KeeperJob | undefined): ApeballPlan {
  if (!action) return { jobs: [], minimumViablePrefix: 0 };
  const jobs = deploy ? [deploy, action] : [action];
  return { jobs, minimumViablePrefix: jobs.length };
}
export async function planApeballJobs(p: {
  client: PublicClient<Transport, Chain>; account: Account | Address; blockNumber: bigint;
  baseFeePerGas: bigint; minProfitWei: bigint; gasLimitMultiplierBps: bigint; builderBidBps: bigint;
}): Promise<ApeballPlan> {
  await verifyApeballRuntime(p.client, p.blockNumber);
  const owner = typeof p.account === "string" ? p.account : p.account.address;
  const deployment = apeballExecutorDeployment(owner);
  const code = await p.client.getCode({ address: deployment.address, blockNumber: p.blockNumber });
  const absent = code === undefined || code === "0x";
  if (!absent && keccak256(code) !== deployment.runtimeHash) throw new Error("Apeball executor pin mismatch");
  let deploy: KeeperJob | undefined;
  if (absent) {
    if (await p.client.getCode({ address: SINGLETON_FACTORY_ADDRESS, blockNumber: p.blockNumber }) !== SINGLETON_FACTORY_RUNTIME_CODE) throw new Error("Apeball singleton factory mismatch");
    deploy = { kind: "apeball_executor_deploy", label: "apeball_executor_deploy", target: SINGLETON_FACTORY_ADDRESS, data: deployment.deployData,
      gas: APEBALL_DEPLOY_GAS, reward: { kind: "fixed", amountWei: 0n }, configuredBuilderBidBps: 0n, requiresBundleSimulation: true };
  }
  const minimumProfit = p.minProfitWei > 0n ? p.minProfitWei : 1n;
  // Use a zero-price discovery call to measure the flat-fee-only payout, a
  // conservative reward floor independent of target base-fee changes and bids.
  // Exact signed bundle simulations remain mandatory and price the actual gas.
  const stateOverride = absent ? [{ address: deployment.address, code: deployment.runtime }] : undefined;
  let best: KeeperJob | undefined;
  let bestNet = 0n;
  for (const action of [0, 1, 2] as const) {
    try {
      const common = { address: deployment.address, abi: apeballExecutorAbi, functionName: "execute" as const,
        account: p.account, blockNumber: p.blockNumber, gas: GAS_ENVELOPE, gasPrice: 0n,
        ...(stateOverride ? { stateOverride } : {}) };
      const quote = await p.client.simulateContract({ ...common, args: [action, action === 2 ? 1n : 0n, 1n, minimumProfit] });
      const [reward, output] = quote.result;
      const minOut = action === 2 ? (output * 9_900n / 10_000n || 1n) : 0n;
      const args = [action, minOut, reward, minimumProfit] as const;
      const data = encodeFunctionData({ abi: apeballExecutorAbi, functionName: "execute", args });
      const gas = bufferedGas(await p.client.estimateGas({ account: p.account, to: deployment.address, data,
        blockNumber: p.blockNumber, gasPrice: 0n, ...(stateOverride ? { stateOverride } : {}) }), p.gasLimitMultiplierBps);
      if (gas > GAS_ENVELOPE) continue;
      const totalGas = gas + (deploy?.gas ?? 0n);
      const net = reward - totalGas * p.baseFeePerGas - reward * p.builderBidBps / 10_000n;
      if (net < minimumProfit || net <= bestNet) continue;
      bestNet = net;
      best = { kind: "apeball_crank", label: `apeball_${APEBALL_ACTIONS[action]}`, target: deployment.address, data, gas,
        reward: { kind: "fixed", amountWei: reward }, configuredBuilderBidBps: p.builderBidBps, requiresBundleSimulation: true };
    } catch (error) {
      // Only EVM reverts mean no executable action. RPC/provider failures must
      // reach the shared exact-block retry/fail-closed boundary.
      if (!(error instanceof BaseError) || !error.walk((e) => e instanceof ContractFunctionRevertedError)) throw error;
    }
  }
  return apeballMandatoryPlan(best, deploy);
}

export function apeballReceiptReward(data: Hex, logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], executor: Address): bigint {
  // Only our exact executor event is authoritative; target KeeperPaid events
  // are not added again. Match the action and enforce the signed reward floor.
  const { args } = decodeApeballCall(data);
  const matches: bigint[] = [];
  for (const entry of logs) {
    if (!isAddressEqual(entry.address, executor)) continue;
    try {
      const event = decodeEventLog({ abi: apeballExecutorAbi, data: entry.data, topics: entry.topics as [Hex, ...Hex[]] });
      if (event.eventName === "RewardedExecution" && event.args.action === args[0] && event.args.bounty >= args[2] && (args[0] !== 2 || event.args.output >= args[1])) matches.push(event.args.bounty);
    } catch { /* Other logs are not keeper revenue. */ }
  }
  if (matches.length !== 1) throw new Error("Missing or ambiguous Apeball reward receipt");
  return matches[0]!;
}
export function decodeApeballCall(data: Hex) { return decodeFunctionData({ abi: apeballExecutorAbi, data }); }
