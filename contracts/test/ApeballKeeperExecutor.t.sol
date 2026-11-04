// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ApeballKeeperExecutor} from "../ApeballKeeperExecutor.sol";
interface VmApeball {
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function txGasPrice(uint256) external;
}
contract MockApeball {
    uint256 public bounty;
    uint256 public work;
    function configure(uint256 amount) external { bounty = amount; }
    function sync() external returns(uint256) { return perform(); }
    function sweep() external returns(uint256) { return perform(); }
    function process(uint256 minOut) external returns(uint256) { require(minOut <= 100, "slippage"); perform(); return 100; }
    function perform() internal returns(uint256) {
        work++;
        if (bounty > 0) { (bool ok,) = msg.sender.call{value:bounty}(""); require(ok); }
        return bounty;
    }
}
contract ApeballKeeperExecutorTest {
    VmApeball constant vm = VmApeball(address(uint160(uint256(keccak256("hevm cheat code")))));
    receive() external payable {}
    function setup(uint256 bounty) internal returns(ApeballKeeperExecutor e, MockApeball m) {
        e = new ApeballKeeperExecutor(address(this));
        MockApeball template = new MockApeball();
        vm.etch(e.GAME(), address(template).code);
        vm.etch(e.VAULT(), address(template).code);
        vm.etch(e.BURNER(), address(template).code);
        vm.deal(e.GAME(), 1 ether); vm.deal(e.VAULT(), 1 ether); vm.deal(e.BURNER(), 1 ether);
        m = MockApeball(e.GAME()); m.configure(bounty);
        MockApeball(e.VAULT()).configure(bounty); MockApeball(e.BURNER()).configure(bounty);
    }
    function testAllActionsPayOwner() external {
        (ApeballKeeperExecutor e,) = setup(0.001 ether);
        for(uint8 action; action < 3; action++) {
            uint256 beforeBalance = address(this).balance;
            (uint256 bounty,uint256 output) = e.execute(action, action == 2 ? 99 : 0, 0.001 ether, 1);
            require(bounty == 0.001 ether && address(this).balance-beforeBalance == bounty);
            require(output == (action == 2 ? 100 : 0));
        }
    }
    function testUnpaidWorkRollsBack() external {
        (ApeballKeeperExecutor e, MockApeball m) = setup(0);
        (bool ok,) = address(e).call(abi.encodeCall(e.execute,(0,0,1,1)));
        require(!ok && m.work() == 0);
    }
    function testPrefundedBalanceIsNotReward() external {
        (ApeballKeeperExecutor e, MockApeball m) = setup(0);
        vm.deal(address(e),1 ether);
        (bool ok,) = address(e).call(abi.encodeCall(e.execute,(0,0,1,1)));
        require(!ok && m.work() == 0 && address(e).balance == 1 ether);
    }
    function testRewardFloorRollsBack() external {
        (ApeballKeeperExecutor e, MockApeball m) = setup(99);
        (bool ok,) = address(e).call(abi.encodeCall(e.execute,(0,0,100,1)));
        require(!ok && m.work() == 0);
    }
    function testGasCostFloorRollsBack() external {
        (ApeballKeeperExecutor e, MockApeball m) = setup(0.00001 ether);
        vm.txGasPrice(1 gwei);
        (bool ok,) = address(e).call(abi.encodeCall(e.execute,(0,0,1,1)));
        require(!ok && m.work() == 0);
    }
    function testUnauthorizedCannotExecuteOrFund() external {
        (ApeballKeeperExecutor e, MockApeball m) = setup(100);
        vm.prank(address(42));
        (bool ok,) = address(e).call(abi.encodeCall(e.execute,(0,0,1,1)));
        require(!ok && m.work() == 0);
        (ok,) = address(e).call("");
        require(!ok);
    }
    function testInvalidInputsAndSlippageRevert() external {
        (ApeballKeeperExecutor e,) = setup(100);
        (bool ok,) = address(e).call(abi.encodeCall(e.execute,(3,0,1,1))); require(!ok);
        (ok,) = address(e).call(abi.encodeCall(e.execute,(0,1,1,1))); require(!ok);
        (ok,) = address(e).call(abi.encodeCall(e.execute,(0,0,0,1))); require(!ok);
        (ok,) = address(e).call(abi.encodeCall(e.execute,(0,0,1,0))); require(!ok);
        (ok,) = address(e).call(abi.encodeCall(e.execute,(2,0,1,1))); require(!ok);
        (ok,) = address(e).call(abi.encodeCall(e.execute,(2,101,1,1))); require(!ok);
    }
}
