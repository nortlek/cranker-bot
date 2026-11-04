import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, keccak256, parseEther, toHex, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { apeballExecutorDeployment } from "../src/apeball-keeper-executor.js";
import { APEBALL_PINS } from "../src/apeball-deployment.js";
import { planApeballJobs, apeballReceiptReward } from "../src/apeball-keeper.js";
import { errorFingerprint } from "../src/format.js";

// All mutations go exclusively to a new loopback Anvil fork. Never load a signer key.
const endpoint = process.env.DISCOVERY_RPC_URLS?.split(",").map(s=>s.trim()).find(Boolean)
  || process.env.DISCOVERY_RPC_URL || process.env.RPC_URL;
if (!endpoint) throw new Error("Read-only fork RPC required");
const port = randomInt(20000, 60000);
const localUrl = `http://127.0.0.1:${port}`;
const chain = {...mainnet, id:31337};
const remote = createPublicClient({chain:mainnet,transport:http(endpoint,{retryCount:0})});
const parent = await remote.getBlock();
const child = spawn(`${homedir()}/.foundry/bin/anvil`,["--host","127.0.0.1","--port",String(port),"--fork-url",endpoint,"--fork-block-number",String(parent.number),"--chain-id","31337","--silent"],{stdio:"ignore"});
try {
  const client = createPublicClient({chain:mainnet,transport:http(localUrl,{retryCount:0,timeout:10000})});
  for(let n=0;;n++) {
    if(child.exitCode !== null) throw new Error("Fork failed to start");
    try { assert.equal(await client.getChainId(),31337); break; } catch { if(n===30) throw new Error("Fork unavailable"); await new Promise(r=>setTimeout(r,200)); }
  }
  const request = async (method:string,params:unknown[]) => (client.request as (p: {method:string;params:unknown[]})=>Promise<unknown>)({method,params});
  const synthetic = privateKeyToAccount(generatePrivateKey());
  const owner = synthetic.address;
  await request("anvil_setBalance",[owner,toHex(parseEther("10"))]);
  const wallet = createWalletClient({chain,account:synthetic,transport:http(localUrl)});
  const params = {client,account:owner,blockNumber:parent.number,baseFeePerGas:parent.baseFeePerGas!,
    minProfitWei:10_000_000_000_000n,gasLimitMultiplierBps:12000n,builderBidBps:1000n};
  assert.equal((await planApeballJobs(params)).jobs.length,0,"canonical unfunded state must be idle");
  // Synthetic vault funding is a local fixture, never counted as bot profit.
  const funding = await wallet.sendTransaction({to:APEBALL_PINS.vault.address,value:parseEther("1")});
  assert.equal((await client.waitForTransactionReceipt({hash:funding})).status,"success");
  const block = await client.getBlock();
  const plan = await planApeballJobs({...params,blockNumber:block.number});
  assert.equal(plan.minimumViablePrefix,2);
  assert.deepEqual(plan.jobs.map(j=>j.kind),["apeball_executor_deploy","apeball_crank"]);
  assert.equal(plan.jobs[1]!.label,"apeball_sweep");
  const before = await client.getBalance({address:owner});
  let gasCost=0n, reward=0n;
  await request("evm_setAutomine",[false]);
  const nonce = await client.getTransactionCount({address:owner});
  const hashes: Hex[] = [];
  for(const [index,job] of plan.jobs.entries()) {
    hashes.push(await wallet.sendTransaction({to:job.target,data:job.data,gas:job.gas,nonce:nonce+index,maxFeePerGas:100_000_000n,maxPriorityFeePerGas:0n}));
  }
  await request("evm_mine",[]);
  await request("evm_setAutomine",[true]);
  const receiptBlocks = new Set<bigint>();
  for(const [index,job] of plan.jobs.entries()) {
    const receipt=await client.waitForTransactionReceipt({hash:hashes[index]!});
    receiptBlocks.add(receipt.blockNumber);
    assert.equal(receipt.status,"success");
    gasCost+=receipt.gasUsed*receipt.effectiveGasPrice;
    if(job.kind==="apeball_crank") reward=apeballReceiptReward(job.data,receipt.logs,job.target);
  }
  assert.equal(receiptBlocks.size,1,"mandatory pair must execute in the same block");
  const deployment=apeballExecutorDeployment(owner);
  assert.equal(keccak256((await client.getCode({address:deployment.address}))!),deployment.runtimeHash);
  const delta=(await client.getBalance({address:owner}))-before;
  assert.equal(delta,reward-gasCost);
  assert.ok(delta>params.minProfitWei);
  const next = await planApeballJobs({...params,blockNumber:await client.getBlockNumber({cacheTime:0})});
  assert.ok(next.jobs.every(j=>j.kind!=="apeball_executor_deploy"));
  console.log(JSON.stringify({event:"apeball_fork_verified",forkBlock:String(parent.number),syntheticFunding:true,
    deploymentAndSweep:true,runtimeMatched:true,reward:String(reward),gasCost:String(gasCost),walletDelta:String(delta),
    mainnetTransactions:0}));
} catch(error) {
  console.error(JSON.stringify({event:"apeball_fork_failed",...errorFingerprint(error)})); process.exitCode=1;
} finally { child.kill("SIGTERM"); }
