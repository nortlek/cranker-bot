// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FwairDropKeeperExecutor} from "../FwairDropKeeperExecutor.sol";

contract FwairDropKeeperExecutorTest {
    function testConstants() external {
        FwairDropKeeperExecutor executor = new FwairDropKeeperExecutor(address(this));
        require(executor.owner() == address(this));
        require(executor.ROUND() == 0xdbDA2aFB2f824657dc70ED5465d44f0D91EdcdEE);
        require(executor.MAX_CALLS() == 4);
    }

    function testRejectsEmptyBatch() external {
        FwairDropKeeperExecutor executor = new FwairDropKeeperExecutor(address(this));
        bytes[] memory calls = new bytes[](0);
        (bool ok,) = address(executor).call(
            abi.encodeCall(FwairDropKeeperExecutor.executeExact, (calls, 1))
        );
        require(!ok);
    }

    function testRejectsUnlistedSelector() external {
        FwairDropKeeperExecutor executor = new FwairDropKeeperExecutor(address(this));
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSignature("deposit()");
        (bool ok,) = address(executor).call(
            abi.encodeCall(FwairDropKeeperExecutor.executeExact, (calls, 1))
        );
        require(!ok);
    }
}
