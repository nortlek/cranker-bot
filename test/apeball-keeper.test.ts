import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Address, type Hex, type PublicClient, type Transport, type Chain } from "viem";
import { existsSync, readFileSync } from "node:fs";
import { APEBALL_PINS } from "../src/apeball-deployment.js";
import { apeballExecutorAbi, apeballExecutorDeployment, APEBALL_EXECUTOR_BYTECODE } from "../src/apeball-keeper-executor.js";
import { apeballMandatoryPlan, apeballReceiptReward, verifyApeballRuntime } from "../src/apeball-keeper.js";
import { loadConfig } from "../src/config.js";
import type { KeeperJob } from "../src/strategy.js";
const owner = "0x0000000000000000000000000000000000001234" as Address;
const deployment = apeballExecutorDeployment(owner);
const data = encodeFunctionData({abi: apeballExecutorAbi, functionName: "execute", args:[2,99n,100n,1n]});
function log(address = deployment.address, action = 2, bounty = 100n, output = 100n) {
  return {address, topics: encodeEventTopics({abi: apeballExecutorAbi, eventName:"RewardedExecution", args:{action}}) as Hex[],
    data: encodeAbiParameters([{type:"uint256"},{type:"uint256"}],[bounty,output])};
}
afterEach(() => vi.unstubAllEnvs());
describe("Apeball executor and receipts", () => {
  it("pins owner-specific CREATE2 runtime and address", () => {
    const other = apeballExecutorDeployment("0x0000000000000000000000000000000000005678");
    expect(other.address).not.toBe(deployment.address);
    expect(other.runtimeHash).not.toBe(deployment.runtimeHash);
    expect(deployment.runtime.toLowerCase()).toContain(owner.slice(2));
  });
  it.skipIf(!existsSync("out/ApeballKeeperExecutor.sol/ApeballKeeperExecutor.json"))("matches the compiled Solidity artifact", () => {
    // Compilation is a separate required release gate; never silently ignore a stale artifact.
    const artifact = JSON.parse(readFileSync("out/ApeballKeeperExecutor.sol/ApeballKeeperExecutor.json","utf8"));
    expect(APEBALL_EXECUTOR_BYTECODE).toBe(artifact.bytecode.object);
    let runtime = artifact.deployedBytecode.object.slice(2);
    for(const reference of Object.values(artifact.deployedBytecode.immutableReferences) as {start:number;length:number}[][]) {
      for(const {start,length} of reference) runtime = runtime.slice(0,start*2)+owner.slice(2).padStart(length*2,"0")+runtime.slice((start+length)*2);
    }
    expect(deployment.runtime).toBe("0x"+runtime);
  });
  it("accounts only the exact executor payout once", () => {
    expect(apeballReceiptReward(data,[log(APEBALL_PINS.game.address),log()],deployment.address)).toBe(100n);
    expect(() => apeballReceiptReward(data,[log(),log()],deployment.address)).toThrow("ambiguous");
  });
  it("rejects spoofed, wrong-action, underpaid and insufficient-output receipts", () => {
    for(const entry of [log(owner),log(deployment.address,1),log(deployment.address,2,99n),log(deployment.address,2,100n,98n)]) {
      expect(() => apeballReceiptReward(data,[entry],deployment.address)).toThrow();
    }
  });
  it("never admits executor deployment alone", () => {
    const deploy = {kind:"apeball_executor_deploy"} as KeeperJob;
    const action = {kind:"apeball_crank"} as KeeperJob;
    expect(apeballMandatoryPlan(undefined,deploy)).toEqual({jobs:[],minimumViablePrefix:0});
    expect(apeballMandatoryPlan(action,deploy)).toEqual({jobs:[deploy,action],minimumViablePrefix:2});
    expect(apeballMandatoryPlan(action,undefined)).toEqual({jobs:[action],minimumViablePrefix:1});
  });
  it("fails closed on chain, code and provider failures", async () => {
    await expect(verifyApeballRuntime({chain:{id:2}} as PublicClient<Transport,Chain>,1n)).rejects.toThrow("mainnet");
    const client = {chain:{id:1},getCode:vi.fn().mockResolvedValue("0x")} as unknown as PublicClient<Transport,Chain>;
    await expect(verifyApeballRuntime(client,42n)).rejects.toThrow("runtime");
    expect(client.getCode).toHaveBeenCalledWith(expect.objectContaining({blockNumber:42n}));
    const failure = new Error("provider unavailable");
    vi.mocked(client.getCode).mockRejectedValue(failure);
    await expect(verifyApeballRuntime(client,42n)).rejects.toBe(failure);
  });
});
describe("Apeball configuration", () => {
  it("defaults off", () => {
    vi.stubEnv("ENABLE_APEBALL","false");
    expect(loadConfig().enableApeball).toBe(false);
  });
  it("requires private submission and isolation", () => {
    vi.stubEnv("ENABLE_APEBALL","true");
    vi.stubEnv("SUBMISSION_MODE","public");
    expect(() => loadConfig()).toThrow("flashbots");
    vi.stubEnv("SUBMISSION_MODE","flashbots");
    vi.stubEnv("ENABLE_PULL_POOL_PLANNING","true");
    expect(() => loadConfig()).toThrow("ENABLE_APEBALL requires ENABLE_PULL_POOL_PLANNING=false");
  });
});
