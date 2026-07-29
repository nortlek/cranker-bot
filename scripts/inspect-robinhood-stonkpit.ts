import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  defineChain,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";

import {
  assessStonkPitCrank,
  ROBINHOOD_CHAIN_ID,
} from "../src/robinhood.js";

const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const BLOCKSCOUT_URL = "https://robinhoodchain.blockscout.com";
const LOCKER = getAddress("0xDeb8d589251717e367d0f3E9dDE5D4dB63968B40");
const EXPECTED = {
  pit: getAddress("0x6543B7746ca744C4bb2198191E71f40FF04C41b9"),
  weth: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  merchant: getAddress("0x3bFfE8c3c53d1432088a771D095Db018c3006Eb9"),
  treasury: getAddress("0x63F19619665bF970c2A78e5A463397a3829706ae"),
  greenMine: getAddress("0x2d0da469115232aD00159757f9d25f81D498206D"),
  blueMine: getAddress("0x6FeD5aE5d486A59081FDC040179CEBDA4be80511"),
  lpVault: getAddress("0xD66C4e61fe2D334a53Af8f595886F50Db32A5378"),
} as const;
const PROBE_ACCOUNT = getAddress(
  "0x1111111111111111111111111111111111111111",
);
const DEFAULT_LOOKBACK_BLOCKS = 100_000n;
const BLOCK_CHUNK = 10_000n;
const DEFAULT_MAX_RECEIPTS = 100;
const DEFAULT_MAX_BLOCKSCOUT_PAGES = 10;
const RECEIPT_DELAY_MS = 250;
const BPS = 10_000n;

const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
  blockExplorers: {
    default: { name: "Blockscout", url: BLOCKSCOUT_URL },
  },
});

const lockerAbi = parseAbi([
  "error NothingToCollect()",
  "function positionTokenId() view returns(uint256)",
  "function positionManager() view returns(address)",
  "function pit() view returns(address)",
  "function weth() view returns(address)",
  "function merchant() view returns(address)",
  "function treasury() view returns(address)",
  "function greenMine() view returns(address)",
  "function blueMine() view returns(address)",
  "function lpVault() view returns(address)",
  "function TIP_BPS() view returns(uint256)",
  "function MERCHANT_SHARE_BPS() view returns(uint256)",
  "function REFILL_BLUE_DIVISOR() view returns(uint256)",
  "function collect(address tipTo) returns(uint256 ethTotal,uint256 pitTotal)",
]);
const collectedEvent = parseAbiItem(
  "event Collected(address indexed caller,address indexed tipTo,uint256 ethTotal,uint256 pitTotal,uint256 tip,uint256 merchantEth,uint256 treasuryEth)",
);

interface BlockscoutTransaction {
  readonly block_number: number;
  readonly fee: { readonly value: string };
  readonly from: { readonly hash: string };
  readonly hash: string;
  readonly raw_input: string;
  readonly status: "ok" | "error";
}

interface BlockscoutTransactionsPage {
  readonly items: readonly BlockscoutTransaction[];
  readonly next_page_params: Record<string, string | number> | null;
}

interface CompetitorSummary {
  successfulCranks: number;
  failedCranks: number;
  successfulTip: bigint;
  successfulGas: bigint;
  failedGas: bigint;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function positiveBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = BigInt(raw);
  if (parsed < 1n) throw new Error(`${name} must be positive`);
  return parsed;
}

function errorName(error: unknown): string {
  if (!(error instanceof BaseError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const reverted = error.walk(
    (candidate) => candidate instanceof ContractFunctionRevertedError,
  );
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.data?.errorName ?? reverted.shortMessage;
  }
  return error.shortMessage;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status < 500 && response.status !== 429) {
      throw new Error(`Blockscout returned HTTP ${response.status}`);
    }
    await sleep(attempt * 500);
  }
  throw new Error("Blockscout retry limit exceeded");
}

async function fetchCrankTransactions(
  fromBlock: bigint,
  maxPages: number,
): Promise<readonly BlockscoutTransaction[]> {
  const endpoint = `${BLOCKSCOUT_URL}/api/v2/addresses/${LOCKER}/transactions`;
  let pageParams: Record<string, string | number> = { filter: "to" };
  const transactions: BlockscoutTransaction[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(pageParams)) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetchJson<BlockscoutTransactionsPage>(
      url.toString(),
    );
    const cranks = response.items.filter((transaction) =>
      transaction.raw_input.startsWith("0x06ec16f8"),
    );
    transactions.push(
      ...cranks.filter(
        (transaction) => BigInt(transaction.block_number) >= fromBlock,
      ),
    );
    const oldest = response.items.at(-1)?.block_number;
    if (
      response.next_page_params === null ||
      oldest === undefined ||
      BigInt(oldest) < fromBlock
    ) {
      break;
    }
    pageParams = { ...response.next_page_params, filter: "to" };
    await sleep(250);
  }

  return transactions;
}

function emptyCompetitorSummary(): CompetitorSummary {
  return {
    successfulCranks: 0,
    failedCranks: 0,
    successfulTip: 0n,
    successfulGas: 0n,
    failedGas: 0n,
  };
}

async function main(): Promise<void> {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const lookbackBlocks = positiveBigIntEnv(
    "ROBINHOOD_LOOKBACK_BLOCKS",
    DEFAULT_LOOKBACK_BLOCKS,
  );
  const maxReceipts = positiveIntegerEnv(
    "ROBINHOOD_MAX_RECEIPTS",
    DEFAULT_MAX_RECEIPTS,
  );
  const maxBlockscoutPages = positiveIntegerEnv(
    "ROBINHOOD_MAX_BLOCKSCOUT_PAGES",
    DEFAULT_MAX_BLOCKSCOUT_PAGES,
  );
  const client = createPublicClient({
    chain: robinhood,
    transport: http(rpcUrl, {
      retryCount: 5,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });

  const [chainId, latestBlock, gasPrice] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getGasPrice(),
  ]);
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `expected Robinhood Chain ID ${ROBINHOOD_CHAIN_ID}, received ${chainId}`,
    );
  }
  const fromBlock =
    latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

  const [
    positionTokenId,
    positionManager,
    pit,
    weth,
    merchant,
    treasury,
    greenMine,
    blueMine,
    lpVault,
    tipBps,
    merchantShareBps,
    refillBlueDivisor,
  ] = await Promise.all([
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "positionTokenId",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "positionManager",
    }),
    client.readContract({ address: LOCKER, abi: lockerAbi, functionName: "pit" }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "weth",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "merchant",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "treasury",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "greenMine",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "blueMine",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "lpVault",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "TIP_BPS",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "MERCHANT_SHARE_BPS",
    }),
    client.readContract({
      address: LOCKER,
      abi: lockerAbi,
      functionName: "REFILL_BLUE_DIVISOR",
    }),
  ]);
  const relationships = {
    pit: getAddress(pit) === EXPECTED.pit,
    weth: getAddress(weth) === EXPECTED.weth,
    merchant: getAddress(merchant) === EXPECTED.merchant,
    treasury: getAddress(treasury) === EXPECTED.treasury,
    greenMine: getAddress(greenMine) === EXPECTED.greenMine,
    blueMine: getAddress(blueMine) === EXPECTED.blueMine,
    lpVault: getAddress(lpVault) === EXPECTED.lpVault,
  };
  if (Object.values(relationships).some((valid) => !valid)) {
    throw new Error("StonkPit locker relationship validation failed");
  }

  let current:
    | {
        readonly eligible: true;
        readonly ethTotal: bigint;
        readonly pitTotal: bigint;
        readonly estimatedGas: bigint;
        readonly tip: bigint;
        readonly gasCost: bigint;
        readonly netProfit: bigint;
        readonly profitable: boolean;
        readonly minimumEthTotal: bigint;
      }
    | { readonly eligible: false; readonly reason: string };
  try {
    const [{ result }, estimatedGas] = await Promise.all([
      client.simulateContract({
        account: PROBE_ACCOUNT,
        address: LOCKER,
        abi: lockerAbi,
        functionName: "collect",
        args: [PROBE_ACCOUNT],
      }),
      client.estimateContractGas({
        account: PROBE_ACCOUNT,
        address: LOCKER,
        abi: lockerAbi,
        functionName: "collect",
        args: [PROBE_ACCOUNT],
      }),
    ]);
    const [ethTotal, pitTotal] = result;
    const economics = assessStonkPitCrank({
      ethTotal,
      tipBps,
      gas: estimatedGas,
      gasPrice,
    });
    current = {
      eligible: true,
      ethTotal,
      pitTotal,
      estimatedGas,
      tip: economics.tip,
      gasCost: economics.gasCost,
      netProfit: economics.netProfit,
      profitable: economics.profitable,
      minimumEthTotal: economics.minimumEthTotal,
    };
  } catch (error) {
    current = { eligible: false, reason: errorName(error) };
  }

  const logs: Array<Awaited<ReturnType<typeof client.getLogs>>[number]> = [];
  for (
    let chunkStart = fromBlock;
    chunkStart <= latestBlock;
    chunkStart += BLOCK_CHUNK
  ) {
    const chunkEnd =
      chunkStart + BLOCK_CHUNK - 1n > latestBlock
        ? latestBlock
        : chunkStart + BLOCK_CHUNK - 1n;
    logs.push(
      ...(await client.getLogs({
        address: LOCKER,
        event: collectedEvent,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      })),
    );
  }
  const receiptLogs = logs.slice(-maxReceipts);
  const receiptSampleFromBlock =
    receiptLogs.at(0)?.blockNumber ?? latestBlock;
  const receiptCosts = new Map<string, bigint>();
  for (const log of receiptLogs) {
    try {
      const receipt = await client.getTransactionReceipt({
        hash: log.transactionHash,
      });
      receiptCosts.set(
        log.transactionHash,
        receipt.gasUsed * receipt.effectiveGasPrice,
      );
    } catch {
      // A missing receipt is reported through receiptCoverage below.
    }
    await sleep(RECEIPT_DELAY_MS);
  }

  const crankTransactions = await fetchCrankTransactions(
    receiptSampleFromBlock,
    maxBlockscoutPages,
  );
  const failedTransactions = crankTransactions.filter(
    (transaction) => transaction.status !== "ok",
  );
  const competitors = new Map<Address, CompetitorSummary>();
  let successfulTip = 0n;
  let successfulGas = 0n;
  let profitableSuccesses = 0;
  let unprofitableSuccesses = 0;
  for (const log of receiptLogs) {
    const caller = getAddress(log.args.caller);
    const tip = log.args.tip;
    const gas = receiptCosts.get(log.transactionHash);
    const existing = competitors.get(caller) ?? emptyCompetitorSummary();
    existing.successfulCranks += 1;
    existing.successfulTip += tip;
    successfulTip += tip;
    if (gas !== undefined) {
      existing.successfulGas += gas;
      successfulGas += gas;
      if (tip > gas) profitableSuccesses += 1;
      else unprofitableSuccesses += 1;
    }
    competitors.set(caller, existing);
  }
  let failedGas = 0n;
  for (const transaction of failedTransactions) {
    const caller = getAddress(transaction.from.hash);
    const gas = BigInt(transaction.fee.value);
    const existing = competitors.get(caller) ?? emptyCompetitorSummary();
    existing.failedCranks += 1;
    existing.failedGas += gas;
    failedGas += gas;
    competitors.set(caller, existing);
  }
  const competitorRows = [...competitors.entries()]
    .map(([caller, summary]) => ({
      caller,
      successfulCranks: summary.successfulCranks,
      failedCranks: summary.failedCranks,
      successfulTipEth: formatEther(summary.successfulTip),
      successfulGasEth: formatEther(summary.successfulGas),
      failedGasEth: formatEther(summary.failedGas),
      netEth: formatEther(
        summary.successfulTip -
          summary.successfulGas -
          summary.failedGas,
      ),
    }))
    .sort(
      (left, right) =>
        right.successfulCranks +
        right.failedCranks -
        (left.successfulCranks + left.failedCranks),
    )
    .slice(0, 12);

  console.log(
    JSON.stringify(
      {
        event: "robinhood_stonkpit_inspection",
        chainId,
        latestBlock: latestBlock.toString(),
        locker: LOCKER,
        relationshipValidation: relationships,
        constants: {
          positionTokenId: positionTokenId.toString(),
          positionManager,
          tipBps: tipBps.toString(),
          merchantShareBps: merchantShareBps.toString(),
          treasuryShareOfPostTipBps: (
            BPS - merchantShareBps
          ).toString(),
          refillBlueDivisor: refillBlueDivisor.toString(),
        },
        current:
          current.eligible
            ? {
                eligible: true,
                ethTotal: formatEther(current.ethTotal),
                pitTotal: formatUnits(current.pitTotal, 18),
                estimatedDirectGas: current.estimatedGas.toString(),
                gasPriceGwei: formatUnits(gasPrice, 9),
                tipEth: formatEther(current.tip),
                gasCostEth: formatEther(current.gasCost),
                netProfitEth: formatEther(current.netProfit),
                profitable: current.profitable,
                minimumBreakEvenEthTotal: formatEther(
                  current.minimumEthTotal,
                ),
              }
            : current,
        history: {
          fromBlock: fromBlock.toString(),
          toBlock: latestBlock.toString(),
          collectedEvents: logs.length,
          receiptSampleFromBlock: receiptSampleFromBlock.toString(),
          receiptSampleSize: receiptLogs.length,
          receiptCoverage: receiptCosts.size,
          profitableSuccesses,
          unprofitableSuccesses,
          failedCranks: failedTransactions.length,
          successfulTipEth: formatEther(successfulTip),
          successfulGasEth: formatEther(successfulGas),
          failedGasEth: formatEther(failedGas),
          netAfterKnownGasEth: formatEther(
            successfulTip - successfulGas - failedGas,
          ),
          competitors: competitorRows,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(errorName(error));
  process.exitCode = 1;
});
