import {
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { loadConfig } from "../src/config.js";
import {
  CVX_ADDRESS,
  CVX_USD_FEED_ADDRESS,
  FIRM_DOLA_ADDRESS,
  FIRM_DOLA_USD_FEED_ADDRESS,
} from "../src/constants.js";
import {
  conservativeDolaToUsd,
  firmOracleRoundStatus,
} from "../src/firm.js";

const BASELINE_ETH = 11_476_458_190_761_693n;
const GOAL_USD = process.env.PROFIT_GOAL_USD ?? "250";
const GOAL_DEADLINE =
  process.env.PROFIT_GOAL_DEADLINE ??
  "2026-07-30T23:59:00-06:00";
const GOAL_USD_8 = parseUnits(GOAL_USD, 8);
const TOKEN_ORACLE_MAX_AGE_SECONDS = 90_000n;
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const DAI = getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F");
const CRV = getAddress("0xD533a949740bb3306d119CC777fa900bA034cd52");
const ETH_USD_FEED = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const DAI_USD_FEED = getAddress(
  "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
);
const CRV_USD_FEED = getAddress(
  "0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f",
);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
]);
const chainlinkAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

async function main(): Promise<void> {
  if (GOAL_USD_8 <= 0n) {
    throw new Error("PROFIT_GOAL_USD must be positive");
  }
  const config = loadConfig();
  if (config.privateKey === undefined) {
    throw new Error("PRIVATE_KEY is required");
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
    latestNonce,
    pendingNonce,
    latestBlock,
  ] = await Promise.all([
      client.getBalance({ address: account.address }),
      client.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      client.readContract({
        address: DAI,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      client.readContract({
        address: FIRM_DOLA_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      client.readContract({
        address: CRV,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      client.readContract({
        address: CVX_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      client.readContract({
        address: ETH_USD_FEED,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: DAI_USD_FEED,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: FIRM_DOLA_USD_FEED_ADDRESS,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: FIRM_DOLA_USD_FEED_ADDRESS,
        abi: chainlinkAbi,
        functionName: "decimals",
      }),
      client.readContract({
        address: CRV_USD_FEED,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: CVX_USD_FEED_ADDRESS,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      client.getTransactionCount({
        address: account.address,
        blockTag: "latest",
      }),
      client.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
      client.getBlock({ blockTag: "latest" }),
    ]);
  const roundStatus = (
    round: readonly [bigint, bigint, bigint, bigint, bigint],
    maximumAgeSeconds: bigint,
  ) =>
    firmOracleRoundStatus({
      round: {
        roundId: round[0],
        answer: round[1],
        updatedAt: round[3],
        answeredInRound: round[4],
      },
      nowSeconds: latestBlock.timestamp,
      maximumAgeSeconds,
    });
  const ethOracleStatus = roundStatus(
    ethRound,
    BigInt(config.firmEthOracleMaxAgeSeconds),
  );
  if (ethOracleStatus !== "fresh") {
    throw new Error(`ETH/USD oracle is ${ethOracleStatus}`);
  }
  const daiOracleStatus = roundStatus(
    daiRound,
    TOKEN_ORACLE_MAX_AGE_SECONDS,
  );
  const crvOracleStatus = roundStatus(
    crvRound,
    TOKEN_ORACLE_MAX_AGE_SECONDS,
  );
  const cvxOracleStatus = roundStatus(
    cvxRound,
    TOKEN_ORACLE_MAX_AGE_SECONDS,
  );

  const ethAssetDelta = eth + weth - BASELINE_ETH;
  const ethDeltaUsd8 = (ethAssetDelta * ethRound[1]) / 10n ** 18n;
  const daiUsd8 =
    daiOracleStatus === "fresh"
      ? (dai * daiRound[1]) / 10n ** 18n
      : 0n;
  const dolaOracleStatus = firmOracleRoundStatus({
    round: {
      roundId: dolaRound[0],
      answer: dolaRound[1],
      updatedAt: dolaRound[3],
      answeredInRound: dolaRound[4],
    },
    nowSeconds: latestBlock.timestamp,
    maximumAgeSeconds: BigInt(
      config.firmDolaOracleMaxAgeSeconds,
    ),
  });
  const dolaUsdScale = 10n ** BigInt(dolaUsdDecimals);
  const cappedDolaUsd =
    dolaRound[1] <= 0n
      ? 0n
      : dolaRound[1] < dolaUsdScale
        ? dolaRound[1]
        : dolaUsdScale;
  const dolaUsd8 =
    dolaOracleStatus === "fresh"
      ? conservativeDolaToUsd({
          dolaAmount: dola,
          dolaUsd: dolaRound[1],
          dolaUsdDecimals,
          outputUsdDecimals: 8,
          haircutBps: config.firmRewardHaircutBps,
        })
      : 0n;
  const crvUsd8 =
    crvOracleStatus === "fresh"
      ? (crv * crvRound[1]) / 10n ** 18n
      : 0n;
  const cvxUsd8 =
    cvxOracleStatus === "fresh"
      ? (cvx * cvxRound[1]) / 10n ** 18n
      : 0n;
  const netUsd8 =
    ethDeltaUsd8 + daiUsd8 + dolaUsd8 + crvUsd8 + cvxUsd8;
  const netEthEquivalent =
    ethAssetDelta +
    ((daiUsd8 + dolaUsd8 + crvUsd8 + cvxUsd8) * 10n ** 18n) /
      ethRound[1];

  console.log(
    JSON.stringify({
      event: "goal_status",
      account: account.address,
      eth: formatEther(eth),
      weth: formatEther(weth),
      dai: formatEther(dai),
      dola: formatEther(dola),
      crv: formatEther(crv),
      cvx: formatEther(cvx),
      baselineEth: formatEther(BASELINE_ETH),
      netEthEquivalent: formatEther(netEthEquivalent),
      ethUsd: formatUnits(ethRound[1], 8),
      ethOracleStatus,
      daiUsd: formatUnits(daiRound[1], 8),
      daiOracleStatus,
      dolaUsd: formatUnits(dolaRound[1], dolaUsdDecimals),
      dolaUsdCapped: formatUnits(
        cappedDolaUsd,
        dolaUsdDecimals,
      ),
      dolaOracleStatus,
      dolaValuationHaircutBps:
        config.firmRewardHaircutBps.toString(),
      dolaValuationUsd: formatUnits(dolaUsd8, 8),
      crvUsd: formatUnits(crvRound[1], 8),
      crvOracleStatus,
      cvxUsd: formatUnits(cvxRound[1], 8),
      cvxOracleStatus,
      netUsd: formatUnits(netUsd8, 8),
      goalUsd: formatUnits(GOAL_USD_8, 8),
      goalDeadline: GOAL_DEADLINE,
      progressBps: ((netUsd8 * 10_000n) / GOAL_USD_8).toString(),
      latestNonce,
      pendingNonce,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "goal_status_failed",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
