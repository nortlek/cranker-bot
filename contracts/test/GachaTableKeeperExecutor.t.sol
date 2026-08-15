// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GachaTableKeeperExecutor} from "../GachaTableKeeperExecutor.sol";

interface VmGacha {
    function deal(address target, uint256 balance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function prank(address sender) external;
}

contract MockGachaTable {
    uint256 public bounty;
    mapping(uint256 => bool) public fireReady;
    mapping(uint256 => bool) public settleReady;
    mapping(uint256 => mapping(uint8 => bool)) public defaultReady;
    mapping(uint256 => uint256) public partialSettlementProgress;

    receive() external payable {}

    function setBounty(uint256 amount) external {
        bounty = amount;
    }

    function setFire(uint256 battleId, bool ready) external {
        fireReady[battleId] = ready;
    }

    function setSettlement(uint256 battleId, bool ready) external {
        settleReady[battleId] = ready;
    }

    function setDefault(uint256 battleId, uint8 leg, bool ready) external {
        defaultReady[battleId][leg] = ready;
    }

    function fire(uint256 battleId) external {
        require(fireReady[battleId], "fire not ready");
        fireReady[battleId] = false;
        _pay(msg.sender);
    }

    function settle(uint256 battleId) external {
        if (!settleReady[battleId]) {
            partialSettlementProgress[battleId] += 1;
            return;
        }
        settleReady[battleId] = false;
        _pay(msg.sender);
    }

    function crankDefault(uint256 battleId, uint8 leg) external {
        require(defaultReady[battleId][leg], "default not ready");
        defaultReady[battleId][leg] = false;
        _pay(msg.sender);
    }

    function _pay(address to) internal {
        (bool success,) = to.call{value: bounty}("");
        require(success, "payment failed");
    }
}

contract GachaTableKeeperExecutorTest {
    VmGacha private constant vm = VmGacha(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant GACHA_TABLE = 0xA936351838d1C85003e736deA03AC6666c1F9c73;

    receive() external payable {}

    function installMock() internal returns (MockGachaTable mock) {
        MockGachaTable implementation = new MockGachaTable();
        vm.etch(GACHA_TABLE, address(implementation).code);
        mock = MockGachaTable(payable(GACHA_TABLE));
        vm.deal(GACHA_TABLE, 100 ether);
        mock.setBounty(0.001 ether);
    }

    function testFireReturnsTheExactBounty() external {
        MockGachaTable mock = installMock();
        mock.setFire(23, true);
        GachaTableKeeperExecutor executor = new GachaTableKeeperExecutor(address(this));
        uint256 beforeBalance = address(this).balance;

        uint256 bounty = executor.fireExact(23, 0.001 ether);

        require(bounty == 0.001 ether, "wrong bounty");
        require(address(this).balance - beforeBalance == bounty, "owner not paid");
    }

    function testUnrewardedSettlementRollsBackPartialProgress() external {
        MockGachaTable mock = installMock();
        GachaTableKeeperExecutor executor = new GachaTableKeeperExecutor(address(this));

        (bool success,) = address(executor).call(abi.encodeCall(executor.settleExact, (21, 0.001 ether)));

        require(!success, "unrewarded settlement succeeded");
        require(mock.partialSettlementProgress(21) == 0, "partial work persisted");
    }

    function testBatchesFourRewardedDefaults() external {
        MockGachaTable mock = installMock();
        GachaTableKeeperExecutor executor = new GachaTableKeeperExecutor(address(this));
        uint8[] memory legs = new uint8[](4);
        for (uint8 leg; leg < 4; ++leg) {
            legs[leg] = leg;
            mock.setDefault(21, leg, true);
        }

        uint256 bounty = executor.crankDefaultsExact(21, legs, 0.004 ether);

        require(bounty == 0.004 ether, "wrong default bounty");
    }

    function testUnrewardedDefaultRollsBackTheWholeBatch() external {
        MockGachaTable mock = installMock();
        GachaTableKeeperExecutor executor = new GachaTableKeeperExecutor(address(this));
        uint8[] memory legs = new uint8[](2);
        legs[0] = 0;
        legs[1] = 1;
        mock.setDefault(21, 0, true);

        (bool success,) = address(executor).call(abi.encodeCall(executor.crankDefaultsExact, (21, legs, 0.002 ether)));

        require(!success, "short default batch succeeded");
        require(mock.defaultReady(21, 0), "first default did not roll back");
    }

    function testRejectsUnauthorizedCaller() external {
        MockGachaTable mock = installMock();
        mock.setFire(23, true);
        GachaTableKeeperExecutor executor = new GachaTableKeeperExecutor(address(this));
        vm.prank(address(0xBAD));

        (bool success,) = address(executor).call(abi.encodeCall(executor.fireExact, (23, 0.001 ether)));

        require(!success, "unauthorized caller succeeded");
    }
}
