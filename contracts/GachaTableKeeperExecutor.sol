// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IGachaTableKeeperTarget {
    function fire(uint256 battleId) external;
    function settle(uint256 battleId) external;
    function crankDefault(uint256 battleId, uint8 leg) external;
}

/// @notice Executes only owner-selected, bounty-paying GachaTable keeper work.
/// @dev GachaTable's `settle` may make partial FWA progress and return without a
///      bounty. Requiring the exact ETH delta makes that branch, stale defaults,
///      and every other unrewarded call revert atomically before keeper gas is
///      committed on chain.
contract GachaTableKeeperExecutor {
    error EmptyBatch();
    error InvalidOwner();
    error PaymentFailed();
    error TooManyCalls();
    error Unauthorized();
    error UnauthorizedPayment();
    error UnexpectedBounty(uint256 actual, uint256 minimum);

    event RewardedExecution(bytes4 indexed selector, uint256 indexed battleId, uint256 calls, uint256 bounty);

    uint256 public constant MAX_DEFAULTS = 4;
    IGachaTableKeeperTarget public constant GACHA_TABLE =
        IGachaTableKeeperTarget(0xA936351838d1C85003e736deA03AC6666c1F9c73);
    address public immutable owner;

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    receive() external payable {
        if (msg.sender != address(GACHA_TABLE)) revert UnauthorizedPayment();
    }

    function fireExact(uint256 battleId, uint256 minimumBounty) external returns (uint256 bounty) {
        _authorize();
        uint256 beforeBalance = address(this).balance;
        GACHA_TABLE.fire(battleId);
        bounty = _finish(beforeBalance, minimumBounty);
        emit RewardedExecution(IGachaTableKeeperTarget.fire.selector, battleId, 1, bounty);
    }

    function settleExact(uint256 battleId, uint256 minimumBounty) external returns (uint256 bounty) {
        _authorize();
        uint256 beforeBalance = address(this).balance;
        GACHA_TABLE.settle(battleId);
        bounty = _finish(beforeBalance, minimumBounty);
        emit RewardedExecution(IGachaTableKeeperTarget.settle.selector, battleId, 1, bounty);
    }

    function crankDefaultsExact(uint256 battleId, uint8[] calldata legs, uint256 minimumBounty)
        external
        returns (uint256 bounty)
    {
        _authorize();
        uint256 length = legs.length;
        if (length == 0) revert EmptyBatch();
        if (length > MAX_DEFAULTS) revert TooManyCalls();
        uint256 beforeBalance = address(this).balance;
        for (uint256 i; i < length; ++i) {
            GACHA_TABLE.crankDefault(battleId, legs[i]);
        }
        bounty = _finish(beforeBalance, minimumBounty);
        emit RewardedExecution(IGachaTableKeeperTarget.crankDefault.selector, battleId, length, bounty);
    }

    function _authorize() internal view {
        if (msg.sender != owner) revert Unauthorized();
    }

    function _finish(uint256 beforeBalance, uint256 minimumBounty) internal returns (uint256 bounty) {
        bounty = address(this).balance - beforeBalance;
        if (minimumBounty == 0 || bounty < minimumBounty) {
            revert UnexpectedBounty(bounty, minimumBounty);
        }
        (bool paid,) = owner.call{value: bounty}("");
        if (!paid) revert PaymentFailed();
    }
}
