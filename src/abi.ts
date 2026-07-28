import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "function POOL() view returns (address)",
  "function allOrders() view returns (address[])",
  "function orderCount() view returns (uint256)",
  "event OrderCreated(address indexed order, address indexed owner, uint32 ticketsPerRound, uint96 crankFee)",
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
  "function paused() view returns (bool)",
  "function roundCount() view returns (uint256)",
  "function ticketsNeeded(uint256 roundId) view returns (uint256)",
  "function config() view returns (uint96 ticketPrice, uint64 fundingDuration, uint16 headroomBps, uint16 feeCapBps, uint96 crankBountyCap, uint96 vrfAllowance, uint64 bountyTipWei, uint64 stallTimeout, uint32 maxTickets)",
]);
