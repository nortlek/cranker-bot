import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";

const KNOWN_FWA = [
  getAddress("0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c"),
  getAddress("0xf8c39f5807bb6f312fc641f8039ba1d192810b5a"),
] as const;
// The default public RPC exposes only a narrow recent-log window without an
// archive token. Known contracts are still inspected regardless of history.
const BLOCK_LOOKBACK = 1_000n;
const BLOCK_CHUNK = 1_000n;

const processedEvent = parseAbiItem(
  "event AcquisitionProcessed(uint256 indexed requestId,uint64 indexed sequence,uint8 status,address indexed processor)",
);
const fwaAbi = parseAbi([
  "function owner() view returns(address)",
  "function token() view returns(address)",
  "function rewards() view returns(address)",
  "function vrfService() view returns(address)",
  "function acquisitionFee() view returns(uint256)",
  "function nextSequenceToProcess() view returns(uint64)",
  "function lastIssuedSequence() view returns(uint64)",
  "function pendingAcquisitionCount() view returns(uint256)",
  "function unsettledAcquisitionCount() view returns(uint256)",
  "function activeListingCount() view returns(uint256)",
  "function accruedOwnerFees() view returns(uint256)",
  "function requestIdAtSequence(uint64) view returns(uint256)",
  "function acquisitions(uint256) view returns(address,uint256,uint256,uint256,uint8)",
  "function processAcquisitions(uint256) returns(uint256)",
]);

function revertedErrorName(error: unknown): string {
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

async function optional<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.privateKey === undefined) {
    throw new Error("PRIVATE_KEY is required for processor simulation");
  }
  const account = privateKeyToAccount(config.privateKey);
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });
  const latestBlock = await client.getBlockNumber();
  const firstBlock =
    latestBlock > BLOCK_LOOKBACK ? latestBlock - BLOCK_LOOKBACK : 0n;
  const ranges: Array<{ readonly fromBlock: bigint; readonly toBlock: bigint }> =
    [];
  for (
    let fromBlock = firstBlock;
    fromBlock <= latestBlock;
    fromBlock += BLOCK_CHUNK
  ) {
    const toBlock =
      fromBlock + BLOCK_CHUNK - 1n > latestBlock
        ? latestBlock
        : fromBlock + BLOCK_CHUNK - 1n;
    ranges.push({ fromBlock, toBlock });
  }
  let logs: Awaited<ReturnType<typeof client.getLogs>> = [];
  try {
    logs = (
      await Promise.all(
        ranges.map(({ fromBlock, toBlock }) =>
          client.getLogs({
            event: processedEvent,
            fromBlock,
            toBlock,
          }),
        ),
      )
    ).flat();
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "fwa_processor_history_unavailable",
        reason: revertedErrorName(error),
      }),
    );
  }
  const history = new Map<
    Address,
    { count: number; lastBlock: bigint; processors: Set<Address> }
  >();
  for (const log of logs) {
    const address = getAddress(log.address);
    const existing = history.get(address) ?? {
      count: 0,
      lastBlock: 0n,
      processors: new Set<Address>(),
    };
    existing.count += 1;
    if (log.blockNumber > existing.lastBlock) {
      existing.lastBlock = log.blockNumber;
    }
    if (log.args.processor !== undefined) {
      existing.processors.add(getAddress(log.args.processor));
    }
    history.set(address, existing);
  }
  const addresses = [
    ...new Set([...KNOWN_FWA, ...history.keys()]),
  ].map((address) => getAddress(address));

  console.log(
    JSON.stringify({
      event: "fwa_processor_scan",
      fromBlock: firstBlock.toString(),
      toBlock: latestBlock.toString(),
      acquisitionProcessedLogs: logs.length,
      contracts: addresses.length,
    }),
  );

  for (const address of addresses) {
    try {
      const [
        owner,
        token,
        rewards,
        vrfService,
        acquisitionFee,
        nextSequence,
        lastIssuedSequence,
        pendingAcquisitions,
        unsettledAcquisitions,
        activeListings,
        accruedOwnerFees,
        balance,
        bytecode,
      ] = await Promise.all([
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "owner",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "token",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "rewards",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "vrfService",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "acquisitionFee",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "nextSequenceToProcess",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "lastIssuedSequence",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "pendingAcquisitionCount",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "unsettledAcquisitionCount",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "activeListingCount",
        })),
        optional(client.readContract({
          address,
          abi: fwaAbi,
          functionName: "accruedOwnerFees",
        })),
        client.getBalance({ address }),
        client.getCode({ address }),
      ]);
      let head:
        | {
            readonly requestId: string;
            readonly requestBlock: string;
            readonly status: number;
          }
        | undefined;
      if (
        nextSequence !== undefined &&
        lastIssuedSequence !== undefined &&
        nextSequence <= lastIssuedSequence
      ) {
        const requestId = await client.readContract({
          address,
          abi: fwaAbi,
          functionName: "requestIdAtSequence",
          args: [nextSequence],
        });
        const acquisition = await client.readContract({
          address,
          abi: fwaAbi,
          functionName: "acquisitions",
          args: [requestId],
        });
        head = {
          requestId: requestId.toString(),
          requestBlock: acquisition[1].toString(),
          status: Number(acquisition[4]),
        };
      }
      let process:
        | {
            readonly processed: string;
            readonly estimatedGas: string;
          }
        | { readonly error: string };
      try {
        const [simulation, estimatedGas] = await Promise.all([
          client.simulateContract({
            address,
            abi: fwaAbi,
            functionName: "processAcquisitions",
            args: [1n],
            account,
          }),
          client.estimateContractGas({
            address,
            abi: fwaAbi,
            functionName: "processAcquisitions",
            args: [1n],
            account,
          }),
        ]);
        process = {
          processed: simulation.result.toString(),
          estimatedGas: estimatedGas.toString(),
        };
      } catch (error) {
        process = { error: revertedErrorName(error) };
      }
      const activity = history.get(address);
      console.log(
        JSON.stringify({
          event: "fwa_processor_contract",
          address,
          owner,
          token,
          rewards,
          vrfService,
          acquisitionFeeEth:
            acquisitionFee === undefined
              ? undefined
              : formatEther(acquisitionFee),
          balanceEth: formatEther(balance),
          nextSequence: nextSequence?.toString(),
          lastIssuedSequence: lastIssuedSequence?.toString(),
          pendingAcquisitions: pendingAcquisitions?.toString(),
          unsettledAcquisitions: unsettledAcquisitions?.toString(),
          activeListings: activeListings?.toString(),
          accruedOwnerFeesEth:
            accruedOwnerFees === undefined
              ? undefined
              : formatEther(accruedOwnerFees),
          bytecodeHash:
            bytecode === undefined ? undefined : keccak256(bytecode),
          processedEvents: activity?.count ?? 0,
          lastProcessedBlock: activity?.lastBlock.toString(),
          uniqueProcessors: activity?.processors.size ?? 0,
          head,
          process,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "fwa_processor_contract_failed",
          address,
          reason: revertedErrorName(error),
        }),
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "fwa_processor_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
