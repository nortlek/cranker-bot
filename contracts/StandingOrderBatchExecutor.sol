// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Executes standing-order cranks with per-order builder bids.
/// @dev The owner must still exact-simulate the complete transaction. The
///      minimum owner return is an execution-time backstop for partial fills;
///      callers should set it to the signed transaction's maximum gas cost
///      plus the required retained profit.
contract StandingOrderBatchExecutor {
    struct OrderBid {
        address order;
        uint256 builderBidBps;
    }

    error EmptyBatch();
    error InvalidOwner();
    error OwnerReturnBelowMinimum(uint256 actual, uint256 minimum);
    error PaymentFailed();
    error ReentrantCall();
    error TooManyOrders();
    error Unauthorized();
    error UnexpectedBalance();

    event BatchExecuted(
        uint256 attempted, uint256 succeeded, uint256 grossReward, uint256 builderPayment, uint256 ownerReturn
    );

    uint256 public constant MAX_ORDERS = 64;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    bytes4 private constant CRANK_SELECTOR = bytes4(keccak256("crank()"));

    address payable public immutable owner;
    bool private executing;

    constructor(address payable owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    receive() external payable {}

    /// @param orders Canonical standing orders and their independent bids.
    /// @param minimumOwnerReturn Minimum ETH returned to the owner. Set this
    ///        to maximum signed gas cost plus the required profit floor.
    function execute(OrderBid[] calldata orders, uint256 minimumOwnerReturn)
        external
        returns (uint256 succeeded, uint256 grossReward, uint256 builderPayment)
    {
        if (msg.sender != owner) revert Unauthorized();
        if (executing) revert ReentrantCall();
        if (orders.length == 0) revert EmptyBatch();
        if (orders.length > MAX_ORDERS) revert TooManyOrders();
        if (minimumOwnerReturn == 0) {
            revert OwnerReturnBelowMinimum(0, 1);
        }

        executing = true;
        uint256 openingBalance = address(this).balance;

        for (uint256 index; index < orders.length; ++index) {
            OrderBid calldata orderBid = orders[index];
            uint256 balanceBefore = address(this).balance;
            (bool success,) = orderBid.order.call(abi.encodeWithSelector(CRANK_SELECTOR));
            if (!success) continue;

            uint256 reward = address(this).balance - balanceBefore;
            if (reward == 0) continue;

            ++succeeded;
            grossReward += reward;
            builderPayment += (reward * orderBid.builderBidBps) / BPS_DENOMINATOR;
        }

        uint256 ownerReturn = builderPayment > grossReward ? 0 : grossReward - builderPayment;
        if (ownerReturn < minimumOwnerReturn) {
            revert OwnerReturnBelowMinimum(ownerReturn, minimumOwnerReturn);
        }

        if (builderPayment != 0) {
            (bool builderPaid,) = block.coinbase.call{value: builderPayment}("");
            if (!builderPaid) revert PaymentFailed();
        }
        (bool ownerPaid,) = owner.call{value: ownerReturn}("");
        if (!ownerPaid) revert PaymentFailed();

        if (address(this).balance != openingBalance) revert UnexpectedBalance();
        executing = false;

        emit BatchExecuted(orders.length, succeeded, grossReward, builderPayment, ownerReturn);
    }
}
