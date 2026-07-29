import {
  createPublicClient,
  formatGwei,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";

const FACTORY = getAddress("0xa99b3a8503260ab32753c382eac297acd4a43908");
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const DAI_USD_FEED = getAddress(
  "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
);
const USDC_USD_FEED = getAddress(
  "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
);

const factoryAbi = parseAbi([
  "function totalPairs() view returns(uint256)",
  "function allPairs(uint256) view returns(address)",
]);
const pairAbi = parseAbi([
  "function source() view returns(address)",
  "function tokenIn() view returns(address)",
  "function tokenOut() view returns(address)",
  "function maxAmountOut() view returns(uint256)",
  "function computeExactAmountIn(uint256) view returns(uint256)",
  "function lastAuctionAt() view returns(uint64)",
  "function lastAuctionPrice() view returns(uint192)",
  "function targetAuctionPeriod() view returns(uint256)",
]);
const tokenAbi = parseAbi([
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)",
]);
const vaultAbi = parseAbi([
  "function asset() view returns(address)",
  "function convertToAssets(uint256) view returns(uint256)",
  "function previewRedeem(uint256) view returns(uint256)",
]);
const aTokenAbi = parseAbi([
  "function UNDERLYING_ASSET_ADDRESS() view returns(address)",
]);
const chainlinkAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

interface TokenMetadata {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

function decimalRatio(
  numerator: bigint,
  numeratorDecimals: number,
  denominator: bigint,
  denominatorDecimals: number,
): string {
  if (denominator === 0n) return "n/a";
  const scale = 1_000_000n;
  const scaled =
    (numerator * 10n ** BigInt(denominatorDecimals) * scale) /
    (denominator * 10n ** BigInt(numeratorDecimals));
  return `${scaled / scale}.${(scaled % scale).toString().padStart(6, "0")}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 20_000,
    }),
  });

  const metadataCache = new Map<Address, Promise<TokenMetadata>>();
  const metadata = (address: Address): Promise<TokenMetadata> => {
    const normalized = getAddress(address);
    const cached = metadataCache.get(normalized);
    if (cached !== undefined) return cached;
    const pending = Promise.all([
      client.readContract({
        address: normalized,
        abi: tokenAbi,
        functionName: "symbol",
      }),
      client.readContract({
        address: normalized,
        abi: tokenAbi,
        functionName: "decimals",
      }),
    ]).then(([symbol, decimals]) => ({
      address: normalized,
      symbol,
      decimals,
    }));
    metadataCache.set(normalized, pending);
    return pending;
  };

  const usdPrice = async (token: TokenMetadata): Promise<number | undefined> => {
    let feed: Address | undefined;
    if (token.address === WETH) feed = ETH_USD_FEED;
    if (token.symbol === "DAI") feed = DAI_USD_FEED;
    if (token.symbol === "USDC") feed = USDC_USD_FEED;
    if (feed === undefined) return undefined;
    const [decimals, round] = await Promise.all([
      client.readContract({
        address: feed,
        abi: chainlinkAbi,
        functionName: "decimals",
      }),
      client.readContract({
        address: feed,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
    ]);
    if (round[1] <= 0n) return undefined;
    return Number(formatUnits(round[1], decimals));
  };

  const [totalPairs, block] = await Promise.all([
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "totalPairs",
    }),
    client.getBlock(),
  ]);
  const pairAddresses = await Promise.all(
    Array.from({ length: Number(totalPairs) }, (_, index) =>
      client
        .readContract({
          address: FACTORY,
          abi: factoryAbi,
          functionName: "allPairs",
          args: [BigInt(index)],
        })
        .then(getAddress),
    ),
  );

  console.log(
    JSON.stringify({
      event: "pooltogether_tpda_scan",
      block: block.number.toString(),
      pairs: pairAddresses.length,
      baseFeeGwei:
        block.baseFeePerGas === null
          ? undefined
          : formatGwei(block.baseFeePerGas),
    }),
  );

  for (const [index, pair] of pairAddresses.entries()) {
    const [source, tokenInAddress, tokenOutAddress, maxAmountOut, lastAuctionAt] =
      await Promise.all([
        client.readContract({
          address: pair,
          abi: pairAbi,
          functionName: "source",
        }),
        client.readContract({
          address: pair,
          abi: pairAbi,
          functionName: "tokenIn",
        }),
        client.readContract({
          address: pair,
          abi: pairAbi,
          functionName: "tokenOut",
        }),
        client.readContract({
          address: pair,
          abi: pairAbi,
          functionName: "maxAmountOut",
        }),
        client.readContract({
          address: pair,
          abi: pairAbi,
          functionName: "lastAuctionAt",
        }),
      ]);
    const [tokenIn, tokenOut] = await Promise.all([
      metadata(tokenInAddress),
      metadata(tokenOutAddress),
    ]);
    const amountIn =
      maxAmountOut === 0n
        ? 0n
        : await client.readContract({
            address: pair,
            abi: pairAbi,
            functionName: "computeExactAmountIn",
            args: [maxAmountOut],
          });

    let redeemAsset: TokenMetadata | undefined;
    let redeemAssets: bigint | undefined;
    try {
      const assetAddress = await client.readContract({
        address: tokenOut.address,
        abi: vaultAbi,
        functionName: "asset",
      });
      redeemAsset = await metadata(assetAddress);
      redeemAssets = await client.readContract({
        address: tokenOut.address,
        abi: vaultAbi,
        functionName: "previewRedeem",
        args: [maxAmountOut],
      });
    } catch {
      // Not every output token is an ERC-4626 vault.
    }
    if (redeemAsset === undefined) {
      try {
        const assetAddress = await client.readContract({
          address: tokenOut.address,
          abi: aTokenAbi,
          functionName: "UNDERLYING_ASSET_ADDRESS",
        });
        redeemAsset = await metadata(assetAddress);
        // Aave aTokens are denominated one-for-one with their underlying.
        redeemAssets = maxAmountOut;
      } catch {
        // Not every output token is an Aave receipt token.
      }
    }

    const [inputUsdPrice, outputUsdPrice] = await Promise.all([
      usdPrice(tokenIn),
      redeemAsset === undefined ? usdPrice(tokenOut) : usdPrice(redeemAsset),
    ]);
    const inputUsd =
      inputUsdPrice === undefined
        ? undefined
        : Number(formatUnits(amountIn, tokenIn.decimals)) * inputUsdPrice;
    const valuedOutput = redeemAssets ?? maxAmountOut;
    const valuedOutputToken = redeemAsset ?? tokenOut;
    const outputUsd =
      outputUsdPrice === undefined
        ? undefined
        : Number(formatUnits(valuedOutput, valuedOutputToken.decimals)) *
          outputUsdPrice;

    console.log(
      JSON.stringify({
        event: "pooltogether_tpda_pair",
        index,
        pair,
        source,
        tokenIn: tokenIn.symbol,
        tokenInAddress: tokenIn.address,
        tokenOut: tokenOut.symbol,
        tokenOutAddress: tokenOut.address,
        maxAmountOut: formatUnits(maxAmountOut, tokenOut.decimals),
        amountIn: formatUnits(amountIn, tokenIn.decimals),
        outputPerInput: decimalRatio(
          maxAmountOut,
          tokenOut.decimals,
          amountIn,
          tokenIn.decimals,
        ),
        lastAuctionAt: new Date(Number(lastAuctionAt) * 1_000).toISOString(),
        redeemAsset: redeemAsset?.symbol,
        redeemAssets:
          redeemAssets === undefined || redeemAsset === undefined
            ? undefined
            : formatUnits(redeemAssets, redeemAsset.decimals),
        inputUsd,
        outputUsd,
        grossUsd:
          inputUsd === undefined || outputUsd === undefined
            ? undefined
            : outputUsd - inputUsd,
      }),
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "pooltogether_tpda_scan_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
