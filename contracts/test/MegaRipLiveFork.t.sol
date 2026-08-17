// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MegaRipKeeperExecutor} from "../MegaRipKeeperExecutor.sol";

interface VmFork {
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function warp(uint256 newTimestamp) external;
}

interface IMegaRipForkTarget {
    function fundingEndsAt() external view returns (uint64);
    function lock() external;
    function pullsDone() external view returns (uint256);
}

interface ISingletonFactory {
    function deploy(bytes memory initCode, bytes32 salt) external returns (address payable createdContract);
}

contract MegaRipLiveForkTest {
    VmFork internal constant vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    IMegaRipForkTarget internal constant MEGA_RIP = IMegaRipForkTarget(0x6769944589f5CC96d5F900F06539681Db84AC5c6);
    ISingletonFactory internal constant SINGLETON_FACTORY =
        ISingletonFactory(0xce0042B868300000d44A59004Da54A005ffdcf9f);
    bytes32 internal constant EXECUTOR_SALT = keccak256("pull-pool-keeper/MegaRipKeeperExecutor/v2");

    receive() external payable {}

    function testCurrentPoolSupportsAtomicLockAndOnePacedRewardedPull() external {
        string memory rpcUrl = vm.envOr("RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, 25_772_203);
        vm.warp(MEGA_RIP.fundingEndsAt());
        bytes memory initCode = abi.encodePacked(type(MegaRipKeeperExecutor).creationCode, abi.encode(address(this)));
        MegaRipKeeperExecutor executor = MegaRipKeeperExecutor(SINGLETON_FACTORY.deploy(initCode, EXECUTOR_SALT));
        uint256 balanceBefore = address(this).balance;

        MEGA_RIP.lock();
        uint256 bounty = executor.pullExact(1, 0.0003 ether);

        require(MEGA_RIP.pullsDone() == 1, "unexpected pull count");
        require(bounty == 0.0003 ether, "unexpected bounty");
        require(address(this).balance - balanceBefore == 0.0003 ether, "bounty was not forwarded");
    }
}
