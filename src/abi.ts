import { parseAbi, parseAbiItem } from "viem";

export const factoryAbi = parseAbi([
  "function POOL() view returns (address)",
  "function allOrders() view returns (address[])",
  "function orderCount() view returns (uint256)",
  "event OrderCreated(address indexed order, address indexed owner, uint32 ticketsPerRound, uint96 crankFee)",
]);

export const vaultFactoryAbi = parseAbi([
  "function POOL() view returns (address)",
  "function allVaults() view returns (address[])",
  "function vaultCount() view returns (uint256)",
  "event VaultCreated(address indexed vault, address indexed owner, uint32 ticketsPerRound, uint96 crankFee)",
]);

export const standingOrderAbi = parseAbi([
  "function OWNER() view returns (address)",
  "function POOL() view returns (address)",
  "function crankFee() view returns (uint96)",
  "function ticketsPerRound() view returns (uint32)",
  "function lastRoundBought() view returns (uint256)",
  "function crank()",
  "event Cranked(uint256 indexed roundId, uint32 tickets, uint256 cost, uint256 fee, address indexed caller)",
  "error AlreadyBought()",
  "error FeeAboveMax()",
  "error FwaNotPricing()",
  "error InsufficientBalance()",
  "error NotOwner()",
  "error PoolPaused()",
  "error RoundCovered()",
  "error RoundDeadlinePassed()",
  "error RoundFull()",
  "error ZeroTickets()",
]);

export const poolAbi = parseAbi([
  "function FWA() view returns (address)",
  "function FWA_TOKEN() view returns (address)",
  "function paused() view returns (bool)",
  "function roundCount() view returns (uint256)",
  "function ethPendingRound() view returns (uint256)",
  "function getRound(uint256 roundId) view returns ((uint96 ticketPrice, uint16 feeBps, uint16 headroomBps, uint16 feeCapBps, uint96 crankBountyCap, uint96 vrfAllowance, uint64 bountyTipWei, uint64 stallTimeout, uint64 fundingDeadline, uint32 ticketsSold, uint32 maxTickets, uint256 minPoolWeightedValue, uint256 escrow, uint256 feeOwed, uint256 refundPool, uint256 ethPot, uint256 tokenPot, uint256 fwaRequestId, uint256 acquisitionSpent, uint256 bidValue, uint256 listingId, uint64 allocatedAt, uint64 pullingAt, uint8 state, uint8 outcome, bool fwaResolved, bool feeClaimed, bool nftHeld, bool rewardCredited, uint128 creditTaken, uint128 rewardAmount))",
  "function ticketsNeeded(uint256 roundId) view returns (uint256)",
  "function config() view returns (uint96 ticketPrice, uint64 fundingDuration, uint16 headroomBps, uint16 feeCapBps, uint96 crankBountyCap, uint96 vrfAllowance, uint64 bountyTipWei, uint64 stallTimeout, uint32 maxTickets)",
  "function buyTickets(uint256 roundId, uint32 tickets, address recipient) payable",
  "function buyIntoCurrentRound(uint32 tickets, address recipient) payable",
  "function pull(uint256 roundId)",
  "function syncFwaResult(uint256 roundId)",
  "function settle(uint256 roundId)",
  "function settleForcedEth(uint256 roundId)",
  "event CrankBountyPaid(uint256 indexed roundId, address indexed cranker, uint256 amount)",
  "event Pulled(uint256 indexed roundId, uint256 fwaRequestId, uint256 spent, address indexed cranker)",
  "event RoundClaimable(uint256 indexed roundId, uint256 listingId)",
  "event RoundSettled(uint256 indexed roundId, uint8 outcome, uint256 tokenPot, uint256 ethPot)",
  "error FwaNotPricing()",
  "error ListingNotReady()",
  "error NotCovered()",
  "error PreviousRoundLive()",
  "error VrfLegTooHigh()",
  "error WrongState()",
]);

export const fwaAbi = parseAbi([
  "function acquisitions(uint256 requestId) view returns (address purchaser, uint256 requestBlock, uint256 priceEscrowed, uint256 listingId, uint8 status)",
  "function nextSequenceToProcess() view returns (uint64)",
  "function lastIssuedSequence() view returns (uint64)",
  "function requestIdAtSequence(uint64 sequence) view returns (uint256)",
  "function processAcquisitions(uint256 maxCount) returns (uint256 processed)",
  "event AcquisitionProcessed(uint256 indexed requestId, uint64 indexed sequence, uint8 status, address indexed processor)",
  "error AcquisitionStateLocked()",
  "error Reentrancy()",
]);

export const fwaTokenAbi = parseAbi([
  "function BUYBACK_INCREMENT() view returns (uint256)",
  "function CALLER_REWARD_BPS() view returns (uint256)",
  "function buyback() returns (uint256 amountOut)",
  "event Bought(address indexed caller, uint256 ethSpent, uint256 amountBought, uint256 callerReward)",
  "error DelayNotMet()",
  "error NoEth()",
  "error PartialFill()",
]);

export const liveBidAdapterAbi = parseAbi([
  "function KEEPER_REWARD_BPS() view returns (uint256)",
  "function KEEPER_REWARD_CAP() view returns (uint256)",
  "function activationThreshold() view returns (uint256)",
  "function bufferedEth() view returns (uint256)",
  "function lastSweepBlock() view returns (uint256)",
  "function maxSweepWei() view returns (uint256)",
  "function minBlocksBetweenSweeps() view returns (uint256)",
  "function patron() view returns (address)",
  "function sweep() returns (uint256 ethForwarded)",
  "event KeeperReward(address indexed caller, uint256 amount)",
  "error SweepTooEarly(uint256 nextBlock)",
]);

export const liquityTroveManagerAbi = parseAbi([
  "function getTroveIdsCount() view returns(uint256)",
  "function getTroveFromTroveIdsArray(uint256) view returns(uint256)",
  "function getTroveStatus(uint256) view returns(uint8)",
  "function getCurrentICR(uint256,uint256) view returns(uint256)",
  "function batchLiquidateTroves(uint256[])",
]);

export const liquityPriceFeedAbi = parseAbi([
  "function fetchPrice() view returns(uint256,bool)",
]);

export const convexBoosterAbi = parseAbi([
  "function poolLength() view returns(uint256)",
  "function poolInfo(uint256) view returns(address lptoken,address token,address gauge,address crvRewards,address stash,bool shutdown)",
  "function staker() view returns(address)",
  "function earmarkIncentive() view returns(uint256)",
  "function earmarkRewards(uint256) returns(bool)",
]);

export const convexLockerAbi = parseAbi([
  "function kickExpiredLocks(address)",
  "function kickRewardPerEpoch() view returns(uint256)",
  "function lockedBalances(address) view returns(uint256 total,uint256 unlockable,uint256 locked,(uint112 amount,uint112 boosted,uint32 unlockTime)[] lockData)",
  "event KickReward(address indexed user,uint256 kicked,uint256 reward)",
]);

export const curveGaugeAbi = parseAbi([
  "function claimable_tokens(address) returns(uint256)",
]);

export const chainlinkPriceFeedAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);

export const firmDbrAbi = parseAbi([
  "function deficitOf(address user) view returns(uint256)",
  "function markets(address market) view returns(bool)",
  "function replenishmentPriceBps() view returns(uint256)",
  "event AddMarket(address indexed market)",
  "event ForceReplenish(address indexed account,address indexed replenisher,address indexed market,uint256 deficit,uint256 replenishmentCost,uint256 replenisherReward)",
]);

export const firmMarketAbi = parseAbi([
  "function dbr() view returns(address)",
  "function dola() view returns(address)",
  "function replenishmentIncentiveBps() view returns(uint256)",
  "function forceReplenish(address user,uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns(uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export const multicall3BalanceAbi = parseAbi([
  "function getEthBalance(address account) view returns(uint256)",
]);

export const firmAddMarketEvent = parseAbiItem(
  "event AddMarket(address indexed market)",
);

export const firmForceReplenishEvent = parseAbiItem(
  "event ForceReplenish(address indexed account,address indexed replenisher,address indexed market,uint256 deficit,uint256 replenishmentCost,uint256 replenisherReward)",
);

export const stakeDaoProtocolControllerAbi = parseAbi([
  "function vault(address gauge) view returns(address)",
  "function isShutdown(address gauge) view returns(bool)",
  "event VaultRegistered(address indexed gauge,address indexed vault,address indexed asset,address rewardReceiver,bytes4 protocolId)",
]);

export const stakeDaoVaultRegisteredEvent = parseAbiItem(
  "event VaultRegistered(address indexed gauge,address indexed vault,address indexed asset,address rewardReceiver,bytes4 protocolId)",
);

export const stakeDaoAccountantAbi = parseAbi([
  "function harvest(address[] gauges,bytes[] harvestData,address receiver)",
  "function getHarvestFeePercent() view returns(uint128)",
  "function vaults(address vault) view returns(uint256 integral,uint128 supply,uint128 feeSubjectAmount,uint128 totalAmount,uint128 netCredited,uint128 reservedHarvestFee,uint128 reservedProtocolFee)",
  "event Harvest(address indexed vault,uint256 integral,uint256 supply,uint256 amount,uint256 protocolFee,uint256 harvesterFee)",
]);
