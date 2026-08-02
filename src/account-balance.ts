import {
  formatUnits,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { chainlinkPriceFeedAbi, erc20Abi } from "./abi.js";
import {
  CRV_ADDRESS,
  CRV_USD_FEED_ADDRESS,
  CVX_ADDRESS,
  CVX_USD_FEED_ADDRESS,
  DAI_ADDRESS,
  DAI_USD_FEED_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  FIRM_DOLA_ADDRESS,
  FIRM_DOLA_USD_FEED_ADDRESS,
  WETH_ADDRESS,
} from "./constants.js";
import {
  conservativeDolaToUsd,
  firmOracleRoundStatus,
} from "./firm.js";

const TOKEN_ORACLE_MAX_AGE_SECONDS = 90_000n;
const USD_DECIMALS = 8;
const TOKEN_SCALE = 10n ** 18n;

type OracleRound = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

export interface KeeperAccountBalance {
  readonly totalEthEquivalentWei: bigint;
  readonly totalUsd: number;
}

function oracleStatus(parameters: {
  readonly round: OracleRound;
  readonly nowSeconds: bigint;
  readonly maximumAgeSeconds: bigint;
}): ReturnType<typeof firmOracleRoundStatus> {
  return firmOracleRoundStatus({
    round: {
      roundId: parameters.round[0],
      answer: parameters.round[1],
      updatedAt: parameters.round[3],
      answeredInRound: parameters.round[4],
    },
    nowSeconds: parameters.nowSeconds,
    maximumAgeSeconds: parameters.maximumAgeSeconds,
  });
}

function requireFreshHeldAsset(parameters: {
  readonly symbol: string;
  readonly balance: bigint;
  readonly status: ReturnType<typeof firmOracleRoundStatus>;
}): void {
  if (parameters.balance > 0n && parameters.status !== "fresh") {
    throw new Error(
      `${parameters.symbol}/USD oracle is ${parameters.status}`,
    );
  }
}

function tokenUsd8(
  balance: bigint,
  round: OracleRound,
  status: ReturnType<typeof firmOracleRoundStatus>,
): bigint {
  return status === "fresh"
    ? (balance * round[1]) / TOKEN_SCALE
    : 0n;
}

export async function readKeeperAccountBalance(parameters: {
  readonly client: PublicClient<Transport, Chain>;
  readonly account: Address;
  readonly ethOracleMaxAgeSeconds: number;
  readonly dolaOracleMaxAgeSeconds: number;
  readonly dolaValuationHaircutBps: bigint;
}): Promise<KeeperAccountBalance> {
  const [
    eth,
    weth,
    dai,
    dola,
    crv,
    cvx,
    ethRound,
    daiRound,
    dolaRound,
    dolaUsdDecimals,
    crvRound,
    cvxRound,
    latestBlock,
  ] = await Promise.all([
    parameters.client.getBalance({ address: parameters.account }),
    parameters.client.readContract({
      address: WETH_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [parameters.account],
    }),
    parameters.client.readContract({
      address: DAI_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [parameters.account],
    }),
    parameters.client.readContract({
      address: FIRM_DOLA_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [parameters.account],
    }),
    parameters.client.readContract({
      address: CRV_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [parameters.account],
    }),
    parameters.client.readContract({
      address: CVX_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [parameters.account],
    }),
    parameters.client.readContract({
      address: ETH_USD_FEED_ADDRESS,
      abi: chainlinkPriceFeedAbi,
      functionName: "latestRoundData",
    }),
    parameters.client.readContract({
      address: DAI_USD_FEED_ADDRESS,
      abi: chainlinkPriceFeedAbi,
      functionName: "latestRoundData",
    }),
    parameters.client.readContract({
      address: FIRM_DOLA_USD_FEED_ADDRESS,
      abi: chainlinkPriceFeedAbi,
      functionName: "latestRoundData",
    }),
    parameters.client.readContract({
      address: FIRM_DOLA_USD_FEED_ADDRESS,
      abi: chainlinkPriceFeedAbi,
      functionName: "decimals",
    }),
    parameters.client.readContract({
      address: CRV_USD_FEED_ADDRESS,
      abi: chainlinkPriceFeedAbi,
      functionName: "latestRoundData",
    }),
    parameters.client.readContract({
      address: CVX_USD_FEED_ADDRESS,
      abi: chainlinkPriceFeedAbi,
      functionName: "latestRoundData",
    }),
    parameters.client.getBlock({ blockTag: "latest" }),
  ]);

  const ethStatus = oracleStatus({
    round: ethRound,
    nowSeconds: latestBlock.timestamp,
    maximumAgeSeconds: BigInt(
      parameters.ethOracleMaxAgeSeconds,
    ),
  });
  if (ethStatus !== "fresh") {
    throw new Error(`ETH/USD oracle is ${ethStatus}`);
  }
  const daiStatus = oracleStatus({
    round: daiRound,
    nowSeconds: latestBlock.timestamp,
    maximumAgeSeconds: TOKEN_ORACLE_MAX_AGE_SECONDS,
  });
  const dolaStatus = oracleStatus({
    round: dolaRound,
    nowSeconds: latestBlock.timestamp,
    maximumAgeSeconds: BigInt(
      parameters.dolaOracleMaxAgeSeconds,
    ),
  });
  const crvStatus = oracleStatus({
    round: crvRound,
    nowSeconds: latestBlock.timestamp,
    maximumAgeSeconds: TOKEN_ORACLE_MAX_AGE_SECONDS,
  });
  const cvxStatus = oracleStatus({
    round: cvxRound,
    nowSeconds: latestBlock.timestamp,
    maximumAgeSeconds: TOKEN_ORACLE_MAX_AGE_SECONDS,
  });
  requireFreshHeldAsset({ symbol: "DAI", balance: dai, status: daiStatus });
  requireFreshHeldAsset({
    symbol: "DOLA",
    balance: dola,
    status: dolaStatus,
  });
  requireFreshHeldAsset({ symbol: "CRV", balance: crv, status: crvStatus });
  requireFreshHeldAsset({ symbol: "CVX", balance: cvx, status: cvxStatus });

  const ethAssets = eth + weth;
  const ethAssetsUsd8 = (ethAssets * ethRound[1]) / TOKEN_SCALE;
  const daiUsd8 = tokenUsd8(dai, daiRound, daiStatus);
  const dolaUsd8 =
    dolaStatus === "fresh"
      ? conservativeDolaToUsd({
          dolaAmount: dola,
          dolaUsd: dolaRound[1],
          dolaUsdDecimals,
          outputUsdDecimals: USD_DECIMALS,
          haircutBps: parameters.dolaValuationHaircutBps,
        })
      : 0n;
  const crvUsd8 = tokenUsd8(crv, crvRound, crvStatus);
  const cvxUsd8 = tokenUsd8(cvx, cvxRound, cvxStatus);
  const otherAssetsUsd8 = daiUsd8 + dolaUsd8 + crvUsd8 + cvxUsd8;
  const totalUsd8 = ethAssetsUsd8 + otherAssetsUsd8;
  const totalEthEquivalentWei =
    ethAssets + (otherAssetsUsd8 * TOKEN_SCALE) / ethRound[1];

  return {
    totalEthEquivalentWei,
    totalUsd: Number(formatUnits(totalUsd8, USD_DECIMALS)),
  };
}
