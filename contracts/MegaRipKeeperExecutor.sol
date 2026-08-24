// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IMegaRipKeeperTarget {
    function pull(uint256 maxPulls) external;
    function crankReveal(uint256 maxCount) external;
    function settle(uint256 listingId) external;
    function syncStuck(uint256 listingId) external;
}

interface IFwaSequenceTarget {
    function nextSequenceToProcess() external view returns (uint64);
}

/// @notice Executes only owner-selected MegaRip keeper calls and proves the
///         minimum bounty before returning any reward to the owner.
/// @dev MegaRip pays `msg.sender`, so direct keeper calls cannot prove from a
///      successful return alone that a retryable settlement paid its bounty.
///      This executor turns the observed ETH delta into a fail-closed boundary:
///      insufficient reward reverts MegaRip and every call in the batch.
contract MegaRipKeeperExecutor {
    error EmptyBatch();
    error InvalidOwner();
    error PaymentFailed();
    error ProcessorMoved(uint64 expected, uint64 actual);
    error TooManyCalls();
    error Unauthorized();
    error UnauthorizedPayment();
    error UnexpectedBounty(uint256 actual, uint256 minimum);

    event RewardedExecution(bytes4 indexed selector, uint256 calls, uint256 bounty);

    uint256 public constant MAX_CALLS = 64;
    IMegaRipKeeperTarget public constant MEGA_RIP = IMegaRipKeeperTarget(0x58A1D8daf6d68EEC8b350684e8feCC4379D13D7D);
    IFwaSequenceTarget public constant FWA = IFwaSequenceTarget(0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c);
    address public immutable owner;

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    receive() external payable {
        if (msg.sender != address(MEGA_RIP)) revert UnauthorizedPayment();
    }

    function pullExact(uint256 maxPulls, uint256 minimumBounty) external returns (uint256 bounty) {
        _authorize();
        if (maxPulls == 0 || maxPulls > MAX_CALLS) revert TooManyCalls();
        uint256 beforeBalance = address(this).balance;
        MEGA_RIP.pull(maxPulls);
        bounty = _finish(beforeBalance, minimumBounty);
        emit RewardedExecution(IMegaRipKeeperTarget.pull.selector, maxPulls, bounty);
    }

    /// @notice Processes one exact FWA sequence prefix through MegaRip's
    ///         reveal crank and proves both pointer movement and reward.
    /// @dev This prevents a builder from moving the shared FWA queue ahead of
    ///      the priced prefix and making this call process different work.
    function crankRevealExact(uint64 expectedNext, uint64 expectedAfter, uint256 minimumBounty)
        external
        returns (uint256 bounty)
    {
        _authorize();
        if (expectedAfter <= expectedNext) revert EmptyBatch();
        uint256 count = uint256(expectedAfter - expectedNext);
        _validateLength(count);

        uint64 actual = FWA.nextSequenceToProcess();
        if (actual != expectedNext) revert ProcessorMoved(expectedNext, actual);

        uint256 beforeBalance = address(this).balance;
        MEGA_RIP.crankReveal(count);

        actual = FWA.nextSequenceToProcess();
        if (actual != expectedAfter) revert ProcessorMoved(expectedAfter, actual);

        bounty = _finish(beforeBalance, minimumBounty);
        emit RewardedExecution(IMegaRipKeeperTarget.crankReveal.selector, count, bounty);
    }

    function settleExact(uint256[] calldata listingIds, uint256 minimumBounty) external returns (uint256 bounty) {
        _authorize();
        uint256 length = listingIds.length;
        _validateLength(length);
        uint256 beforeBalance = address(this).balance;
        for (uint256 i; i < length; ++i) {
            MEGA_RIP.settle(listingIds[i]);
        }
        bounty = _finish(beforeBalance, minimumBounty);
        emit RewardedExecution(IMegaRipKeeperTarget.settle.selector, length, bounty);
    }

    function syncStuckExact(uint256[] calldata listingIds, uint256 minimumBounty) external returns (uint256 bounty) {
        _authorize();
        uint256 length = listingIds.length;
        _validateLength(length);
        uint256 beforeBalance = address(this).balance;
        for (uint256 i; i < length; ++i) {
            MEGA_RIP.syncStuck(listingIds[i]);
        }
        bounty = _finish(beforeBalance, minimumBounty);
        emit RewardedExecution(IMegaRipKeeperTarget.syncStuck.selector, length, bounty);
    }

    function _authorize() internal view {
        if (msg.sender != owner) revert Unauthorized();
    }

    function _validateLength(uint256 length) internal pure {
        if (length == 0) revert EmptyBatch();
        if (length > MAX_CALLS) revert TooManyCalls();
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
