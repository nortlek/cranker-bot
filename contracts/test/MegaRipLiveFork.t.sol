// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MegaRipKeeperExecutor} from "../MegaRipKeeperExecutor.sol";

interface VmFork {
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber)
        external
        returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue)
        external
        returns (string memory value);
    function warp(uint256 newTimestamp) external;
}

interface IMegaRipForkTarget {
    function fundingEndsAt() external view returns (uint64);
    function lock() external;
    function pullsDone() external view returns (uint256);
}

contract MegaRipLiveForkTest {
    VmFork internal constant vm =
        VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    IMegaRipForkTarget internal constant MEGA_RIP =
        IMegaRipForkTarget(0x68f8E0Bd62eD310F692Ae0D01F7e568948818D25);

    receive() external payable {}

    function testCurrentPoolSupportsAtomicLockAnd40RewardedPulls() external {
        string memory rpcUrl = vm.envOr("RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, 25_726_144);
        vm.warp(MEGA_RIP.fundingEndsAt());
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));
        uint256 balanceBefore = address(this).balance;

        MEGA_RIP.lock();
        uint256 bounty = executor.pullExact(40, 0.012 ether);

        require(MEGA_RIP.pullsDone() == 40, "unexpected pull count");
        require(bounty == 0.012 ether, "unexpected bounty");
        require(
            address(this).balance - balanceBefore == 0.012 ether,
            "bounty was not forwarded"
        );
    }
}
