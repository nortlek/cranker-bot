// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IApeballGame {
    function sync() external returns (uint256);
}
interface IApeballVault {
    function sweep() external returns (uint256);
}
interface IApeballBurner {
    function process(uint256 minOut) external returns (uint256);
}
/// @notice Zero-capital, owner-bound execution of the three paid Apeball calls.
/// @dev A successful but unpaid/underpaid branch reverts atomically. The gas
///      floor also protects against changed work consuming more gas than quoted.
contract ApeballKeeperExecutor {
    address public constant GAME = 0xb3388F9AdD2ea181fB578e18C324847D2F097Ab6;
    address public constant VAULT = 0xbA89F58e2ba3C15D63F4468b448C6e997c1F61dE;
    address public constant BURNER = 0x44F931cE249247E62fa4D311fBeaF3b2Cf68e2a7;
    uint256 public constant GAS_OVERHEAD = 80_000;
    address public immutable owner;
    error Unauthorized();
    error InvalidCall();
    error InsufficientReward(uint256 actual, uint256 required);
    error PaymentFailed();
    event RewardedExecution(uint8 indexed action, uint256 bounty, uint256 output);
    constructor(address owner_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
    }
    receive() external payable {
        if (msg.sender != GAME && msg.sender != VAULT && msg.sender != BURNER) revert Unauthorized();
    }
    function execute(uint8 action, uint256 minOut, uint256 minimumReward, uint256 minimumProfit)
        external returns (uint256 bounty, uint256 output)
    {
        uint256 startGas = gasleft();
        if (msg.sender != owner) revert Unauthorized();
        if (minimumReward == 0 || minimumProfit == 0 || action > 2 || (action != 2 && minOut != 0) || (action == 2 && minOut == 0)) revert InvalidCall();
        uint256 beforeBalance = address(this).balance;
        if (action == 0) IApeballGame(GAME).sync();
        else if (action == 1) IApeballVault(VAULT).sweep();
        else output = IApeballBurner(BURNER).process(minOut);
        bounty = address(this).balance - beforeBalance;
        uint256 required = (startGas - gasleft() + GAS_OVERHEAD) * tx.gasprice + minimumProfit;
        if (minimumReward > required) required = minimumReward;
        if (bounty < required) revert InsufficientReward(bounty, required);
        (bool paid,) = owner.call{value: bounty}("");
        if (!paid) revert PaymentFailed();
        emit RewardedExecution(action, bounty, output);
    }
}
