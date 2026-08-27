// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Owner-bound, reward-gated executor for the pinned SAVE ETH FWAIR
///         drop round. The round catches some retryable failures and can return
///         successfully without reimbursing its caller; this wrapper turns the
///         observed aggregate ETH delta into an atomic fail-closed boundary.
contract FwairDropKeeperExecutor {
    error EmptyBatch();
    error InvalidCall();
    error InvalidOwner();
    error PaymentFailed();
    error TooManyCalls();
    error Unauthorized();
    error UnauthorizedPayment();
    error UnexpectedBounty(uint256 actual, uint256 minimum);

    event RewardedExecution(bytes32 indexed callsHash, uint256 calls, uint256 bounty);

    uint256 public constant MAX_CALLS = 4;
    address public constant ROUND = 0xdbDA2aFB2f824657dc70ED5465d44f0D91EdcdEE;
    address public immutable owner;

    bytes4 private constant LOCK = bytes4(keccak256("lock()"));
    bytes4 private constant REQUEST_PULL = bytes4(keccak256("requestPull(uint256)"));
    bytes4 private constant SYNC_REVEALS = bytes4(keccak256("syncReveals(uint256)"));
    bytes4 private constant RECOVER_VOIDED = bytes4(keccak256("recoverVoided(uint256)"));
    bytes4 private constant SETTLE_BACKSTOP = bytes4(keccak256("settleBackstop(uint256)"));
    bytes4 private constant RESCUE_FINALIZE = bytes4(keccak256("rescueFinalize(uint256)"));
    bytes4 private constant ABANDON_FORCED = bytes4(keccak256("abandonForced(uint256)"));
    bytes4 private constant BEGIN_ENDING = bytes4(keccak256("beginEnding()"));
    bytes4 private constant FINALIZE_ECONOMICS = bytes4(keccak256("finalizeEconomics()"));

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    receive() external payable {
        if (msg.sender != ROUND) revert UnauthorizedPayment();
    }

    function executeExact(bytes[] calldata calls, uint256 minimumBounty) external returns (uint256 bounty) {
        if (msg.sender != owner) revert Unauthorized();
        uint256 length = calls.length;
        if (length == 0) revert EmptyBatch();
        if (length > MAX_CALLS) revert TooManyCalls();

        uint256 beforeBalance = address(this).balance;
        for (uint256 i; i < length; ++i) {
            bytes calldata callData = calls[i];
            if (callData.length < 4 || !_allowed(bytes4(callData[:4]))) revert InvalidCall();
            (bool ok, bytes memory result) = ROUND.call(callData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(result, 32), mload(result))
                }
            }
        }

        bounty = address(this).balance - beforeBalance;
        if (minimumBounty == 0 || bounty < minimumBounty) {
            revert UnexpectedBounty(bounty, minimumBounty);
        }
        (bool paid,) = owner.call{value: bounty}("");
        if (!paid) revert PaymentFailed();
        emit RewardedExecution(keccak256(abi.encode(calls)), length, bounty);
    }

    function _allowed(bytes4 selector) private pure returns (bool) {
        return selector == LOCK || selector == REQUEST_PULL || selector == SYNC_REVEALS
            || selector == RECOVER_VOIDED || selector == SETTLE_BACKSTOP
            || selector == RESCUE_FINALIZE || selector == ABANDON_FORCED
            || selector == BEGIN_ENDING || selector == FINALIZE_ECONOMICS;
    }
}
