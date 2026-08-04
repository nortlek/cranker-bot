// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IFwaSequenceProcessor {
    function nextSequenceToProcess() external view returns (uint64);
    function processAcquisitions(uint256 maxCount) external returns (uint256 processed);
}

/// @notice Processes only the exact FWA sequence interval simulated by the keeper.
/// @dev A direct processAcquisitions(maxCount) call can spill into newly issued
///      acquisitions when another transaction advances the FIFO before bundle
///      inclusion. Binding both ends makes that position-dependent state change
///      revert the private bundle instead of exposing the signer to unpriced gas.
contract FwaSequenceExecutor {
    error EmptyInterval();
    error InvalidOwner();
    error ProcessorMoved(uint64 expected, uint64 actual);
    error ProcessingIncomplete(uint256 expectedCount, uint256 processed, uint64 expectedAfter, uint64 actualAfter);
    error Unauthorized();

    event ExactSequenceProcessed(uint64 indexed firstSequence, uint64 indexed afterSequence, uint256 processed);

    IFwaSequenceProcessor public constant FWA =
        IFwaSequenceProcessor(0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c);
    address public immutable owner;

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    function processExact(uint64 expectedNext, uint64 expectedAfter) external returns (uint256 processed) {
        if (msg.sender != owner) revert Unauthorized();
        if (expectedAfter <= expectedNext) revert EmptyInterval();

        uint64 actualNext = FWA.nextSequenceToProcess();
        if (actualNext != expectedNext) revert ProcessorMoved(expectedNext, actualNext);

        uint256 expectedCount = uint256(expectedAfter - expectedNext);
        processed = FWA.processAcquisitions(expectedCount);
        uint64 actualAfter = FWA.nextSequenceToProcess();
        if (processed != expectedCount || actualAfter != expectedAfter) {
            revert ProcessingIncomplete(expectedCount, processed, expectedAfter, actualAfter);
        }

        emit ExactSequenceProcessed(expectedNext, expectedAfter, processed);
    }
}
