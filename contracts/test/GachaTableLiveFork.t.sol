// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GachaTableKeeperExecutor} from "../GachaTableKeeperExecutor.sol";

interface VmGachaFork {
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function warp(uint256 newTimestamp) external;
}

interface IGachaTableForkTarget {
    function feePool() external view returns (uint256);
}

contract GachaTableLiveForkTest {
    VmGachaFork internal constant vm = VmGachaFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    IGachaTableForkTarget internal constant GACHA_TABLE =
        IGachaTableForkTarget(0xA936351838d1C85003e736deA03AC6666c1F9c73);

    receive() external payable {}

    function testBattle21BatchesFourExactRewardedDefaults() external {
        string memory rpcUrl = vm.envOr("RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, 25_754_823);
        vm.warp(1_786_740_875);
        GachaTableKeeperExecutor executor = new GachaTableKeeperExecutor(address(this));
        uint8[] memory legs = new uint8[](4);
        for (uint8 leg; leg < 4; ++leg) {
            legs[leg] = leg;
        }
        uint256 ownerBalanceBefore = address(this).balance;
        uint256 feePoolBefore = GACHA_TABLE.feePool();

        uint256 bounty = executor.crankDefaultsExact(21, legs, 0.004 ether);

        require(bounty == 0.004 ether, "unexpected bounty");
        require(address(this).balance - ownerBalanceBefore == bounty, "bounty was not forwarded");
        require(feePoolBefore - GACHA_TABLE.feePool() == bounty, "fee pool delta did not match bounty");
    }
}
