// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FwaSequenceExecutor} from "../FwaSequenceExecutor.sol";

interface Vm {
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function prank(address sender) external;
}

contract MockFwaSequenceProcessor {
    uint64 public nextSequenceToProcess;
    bool public processOneFewer;

    function setState(uint64 nextSequence, bool oneFewer) external {
        nextSequenceToProcess = nextSequence;
        processOneFewer = oneFewer;
    }

    function processAcquisitions(uint256 maxCount) external returns (uint256 processed) {
        processed = processOneFewer ? maxCount - 1 : maxCount;
        nextSequenceToProcess += uint64(processed);
    }
}

contract FwaSequenceExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant FWA = 0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c;

    function installMock(uint64 nextSequence, bool oneFewer) internal {
        MockFwaSequenceProcessor implementation = new MockFwaSequenceProcessor();
        vm.etch(FWA, address(implementation).code);
        MockFwaSequenceProcessor(FWA).setState(nextSequence, oneFewer);
    }

    function testProcessesOnlyTheBoundExactInterval() external {
        installMock(120983, false);
        FwaSequenceExecutor executor = new FwaSequenceExecutor(address(this));

        uint256 processed = executor.processExact(120983, 120985);

        require(processed == 2, "wrong processed count");
        require(MockFwaSequenceProcessor(FWA).nextSequenceToProcess() == 120985, "wrong final pointer");
    }

    /// @dev Models target 25682761: another transaction moved the FIFO after
    ///      parent-state simulation. The executor must fail closed rather than
    ///      process a newer, unpriced acquisition.
    function testRevertsWhenTheProcessorMovedBeforeInclusion() external {
        installMock(120984, false);
        FwaSequenceExecutor executor = new FwaSequenceExecutor(address(this));

        (bool success,) = address(executor).call(abi.encodeCall(executor.processExact, (120983, 120985)));

        require(!success, "shifted processor succeeded");
        require(MockFwaSequenceProcessor(FWA).nextSequenceToProcess() == 120984, "shifted state changed");
    }

    function testRevertsAndRollsBackIncompleteProcessing() external {
        installMock(120983, true);
        FwaSequenceExecutor executor = new FwaSequenceExecutor(address(this));

        (bool success,) = address(executor).call(abi.encodeCall(executor.processExact, (120983, 120985)));

        require(!success, "short processing succeeded");
        require(MockFwaSequenceProcessor(FWA).nextSequenceToProcess() == 120983, "short processing did not roll back");
    }

    function testRejectsUnauthorizedCaller() external {
        installMock(120983, false);
        FwaSequenceExecutor executor = new FwaSequenceExecutor(address(this));

        vm.prank(address(0xBAD));
        (bool success,) = address(executor).call(abi.encodeCall(executor.processExact, (120983, 120985)));

        require(!success, "unauthorized caller succeeded");
    }
}
