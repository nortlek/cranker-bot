import { parseAbi, parseAbiItem } from "viem";

export const factoryAbi = parseAbi([
  "function POOL() view returns (address)",
  "function allOrders() view returns (address[])",
  "function orderCount() view returns (uint256)",
  "event OrderCreated(address indexed order, address indexed owner, uint32 ticketsPerRound, uint96 crankFee)",
]);

export const successorFactoryAbi = parseAbi([
  "function LEGACY() view returns (address)",
  "function SUCCESSOR() view returns (address)",
  "function pool() view returns (address)",
  "function allOrders() view returns (address[])",
  "function orderCount() view returns (uint256)",
  "event OrderCreated(address indexed order, address indexed owner, address recipient, address referrer, uint32 ticketsPerRound, uint96 crankFee, uint64 minSecondsBetweenBuys)",
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

export const standingOrderV2Abi = parseAbi([
  "function OWNER() view returns (address)",
  "function REFERRER() view returns (address)",
  "function pool() view returns (address)",
  "function recipient() view returns (address)",
  "function crankFee() view returns (uint96)",
  "function ticketsPerRound() view returns (uint32)",
  "function lastRoundBought() view returns (uint256)",
  "function lastPool() view returns (address)",
  "function minSecondsBetweenBuys() view returns (uint64)",
  "function lastBuyAt() view returns (uint64)",
  "function crank()",
  "event Cranked(uint256 indexed roundId, uint32 tickets, uint256 cost, uint256 fee, address indexed caller)",
  "error AlreadyBought()",
  "error BadPool()",
  "error BadRecipient()",
  "error FeeAboveMax()",
  "error FwaNotPricing()",
  "error InsufficientBalance()",
  "error IntervalAboveMax()",
  "error NotOwner()",
  "error PoolPaused()",
  "error RoundCovered()",
  "error RoundDeadlinePassed()",
  "error RoundFull()",
  "error TooSoon()",
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

export const poolV2Abi = parseAbi([
  "function FWA() pure returns (address)",
  "function FWA_REWARDS() pure returns (address)",
  "function FWA_TOKEN() pure returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function deprecated() view returns (bool)",
  "function roundCount() view returns (uint256)",
  "function firstOpenRound() view returns (uint256)",
  "function currentOpenRound() view returns (uint256)",
  "function pendingPullCount() view returns (uint256)",
  "function canPayTokens() view returns (bool)",
  "function ticketsNeeded(uint256 roundId) view returns (uint256)",
  "function getRound(uint256 roundId) view returns ((uint96 ticketPrice, uint16 feeBps, uint16 headroomBps, uint16 feeCapBps, uint96 crankBountyCap, uint96 vrfAllowance, uint64 bountyTipWei, uint64 stallTimeout, uint64 fundingDeadline, uint32 ticketsSold, uint32 maxTickets, uint16 referralBps, uint32 referredTickets, uint256 minPoolWeightedValue, uint256 escrow, uint256 feeOwed, uint256 refundPool, uint256 ethPot, uint256 tokenPot, uint256 fwaRequestId, uint256 acquisitionSpent, uint256 bidValue, uint256 listingId, uint64 allocatedAt, uint64 pullingAt, uint8 state, uint8 outcome, bool fwaResolved, bool feeClaimed, bool nftHeld, bool rewardCredited, uint128 creditTaken, uint256 backingAtAlloc, uint128 forcedEthTaken, uint256 referralPool, uint128 rewardAmount))",
  "function config() view returns (uint96 ticketPrice, uint64 fundingDuration, uint16 headroomBps, uint16 feeCapBps, uint96 crankBountyCap, uint96 vrfAllowance, uint64 bountyTipWei, uint64 stallTimeout, uint32 maxTickets, uint16 maxConcurrentOpen, uint16 maxConcurrentPulls, uint16 referralBps)",
  "function buyTickets(uint256 roundId, uint32 tickets, address recipient, address referrer) payable",
  "function buyIntoCurrentRound(uint32 tickets, address recipient, address referrer) payable",
  "function pull(uint256 roundId)",
  "function syncFwaResult(uint256 roundId)",
  "function settle(uint256 roundId)",
  "function settleForcedEth(uint256 roundId)",
  "event RoundOpened(uint256 indexed roundId)",
  "event CrankBountyPaid(uint256 indexed roundId, address indexed cranker, uint256 amount)",
  "event Pulled(uint256 indexed roundId, uint256 fwaRequestId, uint256 spent, address indexed cranker)",
  "event RoundClaimable(uint256 indexed roundId, uint256 listingId)",
  "event RoundSettled(uint256 indexed roundId, uint8 outcome, uint256 tokenPot, uint256 ethPot)",
  "event RoundVoided(uint256 indexed roundId, uint256 refundPool)",
  "error FwaNotPricing()",
  "error IsDeprecated()",
  "error IsPaused()",
  "error ListingNotReady()",
  "error NotCovered()",
  "error OpenCapReached()",
  "error PullCapReached()",
  "error VrfLegTooHigh()",
  "error WrongState()",
]);

export const poolV2LifecycleAbi = parseAbi([
  "event RoundOpened(uint256 indexed roundId)",
  "event RoundSettled(uint256 indexed roundId, uint8 outcome, uint256 tokenPot, uint256 ethPot)",
  "event RoundVoided(uint256 indexed roundId, uint256 refundPool)",
]);

export const groupPullAbi = parseAbi([
  "function pool() view returns (address)",
  "function paused() view returns (bool)",
  "function deprecated() view returns (bool)",
  "function roundCount() view returns (uint256)",
  "function liveRound() view returns (uint256)",
  "function buyingRounds() view returns (uint256)",
  "function currentTarget(uint256 roundId) view returns (uint256)",
  "function getRound(uint256 roundId) view returns ((uint96 entryPrice, uint96 incentivePerTicket, uint32 pullsPerRound, uint32 maxParticipants, uint64 sellsFrom, uint64 sellsUntil, uint64 entryDuration, uint64 submitWindow, uint32 ticketsSold, uint256 escrow, uint256 bountyPot, uint256 ethPool, uint256 ethPaid, uint256 fwaPot, uint256 fwaPaid, uint256 surchargePot, uint32 escalationThreshold, uint16 escalationRateBps, uint32 bought, uint32 pullsCollected, uint32 bountyShares, uint64 submitDeadline, bool aborted, uint8 state))",
  "function close(uint256 roundId)",
  "function submit(uint256 roundId, uint256 maxPoolRounds)",
  "function collect(uint256 roundId, uint256 maxPoolRounds)",
  "function roundPool(uint256 roundId) view returns (address)",
  "function poolRoundsOf(uint256 roundId) view returns (uint256[])",
  "function pullCollected(uint256 roundId, uint256 poolRoundId) view returns (bool)",
  "function enter(uint256 roundId, uint32 quantity, address beneficiary) payable returns (uint32 bought)",
  "event BountyPaid(uint256 indexed roundId, address indexed caller, uint256 amount)",
  "event RoundClosed(uint256 indexed roundId, uint32 ticketsSold, uint256 raised, uint64 submitDeadline)",
  "event RoundComplete(uint256 indexed roundId, uint256[] poolRoundIds)",
  "event PoolRoundCollected(uint256 indexed roundId, uint256 indexed poolRoundId, uint256 ethCollected, uint256 fwaCollected)",
]);

export const groupPullStandingOrderFactoryAbi = parseAbi([
  "function GROUP() view returns (address)",
  "function allOrders() view returns (address[])",
  "function isOrder(address order) view returns (bool)",
  "function orderCount() view returns (uint256)",
  "event OrderCreated(address indexed order, address indexed owner, address indexed recipient, uint32 ticketsPerRound, uint96 crankFee, uint64 minSecondsBetweenBuys)",
]);

export const groupPullStandingOrderAbi = parseAbi([
  "function groupPull() view returns (address)",
  "function crankFee() view returns (uint96)",
  "function crank()",
  "event Cranked(uint256 indexed roundId, uint32 tickets, uint256 cost, uint256 fee, address indexed caller)",
]);

export const fwaAbi = parseAbi([
  "function acquisitions(uint256 requestId) view returns (address purchaser, uint256 requestBlock, uint256 priceEscrowed, uint256 listingId, uint8 status)",
  "function nextSequenceToProcess() view returns (uint64)",
  "function lastIssuedSequence() view returns (uint64)",
  "function requestIdAtSequence(uint64 sequence) view returns (uint256)",
  "function vrfCoordinatorAndSubId() view returns (address coordinator, uint256 subId)",
  "function processAcquisitions(uint256 maxCount) returns (uint256 processed)",
  "event AcquisitionProcessed(uint256 indexed requestId, uint64 indexed sequence, uint8 status, address indexed processor)",
  "error AcquisitionStateLocked()",
  "error Reentrancy()",
]);

export const vrfCoordinatorAbi = parseAbi([
  "function fulfillRandomWords((uint256[2] pk,uint256[2] gamma,uint256 c,uint256 s,uint256 seed,address uWitness,uint256[2] cGammaWitness,uint256[2] sHashWitness,uint256 zInv) proof,(uint64 blockNum,uint256 subId,uint32 callbackGasLimit,uint32 numWords,address sender,bytes extraArgs) rc,bool onlyPremium) returns (uint96 payment)",
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
