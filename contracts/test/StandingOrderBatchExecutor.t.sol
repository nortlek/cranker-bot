// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StandingOrderBatchExecutor} from "../StandingOrderBatchExecutor.sol";

interface Vm {
    function coinbase(address newCoinbase) external;
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256 forkId);
    function deal(address account, uint256 newBalance) external;
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function prank(address sender) external;
}

contract PayingOrder {
    uint256 public immutable reward;

    constructor(uint256 reward_) payable {
        reward = reward_;
    }

    function crank() external {
        (bool paid,) = msg.sender.call{value: reward}("");
        require(paid, "reward payment failed");
    }
}

contract FailingOrder {
    function crank() external pure {
        revert("already cranked");
    }
}

contract ZeroRewardOrder {
    function crank() external pure {}
}

contract RejectingReceiver {
    receive() external payable {
        revert("no payment");
    }
}

contract StandingOrderBatchExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    receive() external payable {}

    event ForkReplay(uint256 gasUsed, uint256 grossReward, uint256 ownerReturn);

    function testPaysOnlyForSuccessfulRewardProducingCranks() external {
        vm.deal(address(this), 10 ether);
        StandingOrderBatchExecutor executor = new StandingOrderBatchExecutor(payable(address(this)));
        PayingOrder first = new PayingOrder{value: 1 ether}(1 ether);
        FailingOrder failed = new FailingOrder();
        PayingOrder second = new PayingOrder{value: 2 ether}(2 ether);
        ZeroRewardOrder zeroReward = new ZeroRewardOrder();
        address builder = address(0xB01D);
        vm.coinbase(builder);

        StandingOrderBatchExecutor.OrderBid[] memory orders = new StandingOrderBatchExecutor.OrderBid[](4);
        orders[0] = StandingOrderBatchExecutor.OrderBid(address(first), 1_000);
        orders[1] = StandingOrderBatchExecutor.OrderBid(address(failed), 10_000);
        orders[2] = StandingOrderBatchExecutor.OrderBid(address(second), 5_000);
        orders[3] = StandingOrderBatchExecutor.OrderBid(address(zeroReward), 10_000);

        uint256 ownerBefore = address(this).balance;
        (uint256 succeeded, uint256 gross, uint256 builderPayment) = executor.execute(orders, 1 ether);

        require(succeeded == 2, "wrong success count");
        require(gross == 3 ether, "wrong gross reward");
        require(builderPayment == 1.1 ether, "wrong builder payment");
        require(builder.balance == 1.1 ether, "builder not paid");
        require(address(this).balance == ownerBefore + 1.9 ether, "owner not paid");
        require(address(executor).balance == 0, "executor retained ETH");
    }

    function testPartialSuccessRevertsBelowOwnerReturnFloor() external {
        vm.deal(address(this), 2 ether);
        StandingOrderBatchExecutor executor = new StandingOrderBatchExecutor(payable(address(this)));
        PayingOrder paying = new PayingOrder{value: 1 ether}(1 ether);
        FailingOrder failed = new FailingOrder();

        StandingOrderBatchExecutor.OrderBid[] memory orders = new StandingOrderBatchExecutor.OrderBid[](2);
        orders[0] = StandingOrderBatchExecutor.OrderBid(address(paying), 9_000);
        orders[1] = StandingOrderBatchExecutor.OrderBid(address(failed), 9_000);

        (bool success,) = address(executor).call(abi.encodeCall(executor.execute, (orders, 0.2 ether)));
        require(!success, "unsafe partial batch succeeded");
        require(address(paying).balance == 1 ether, "crank was not rolled back");
        require(address(executor).balance == 0, "executor balance changed");
    }

    function testAllowsCrossSubsidizedBidAboveOneOrdersReward() external {
        vm.deal(address(this), 3 ether);
        StandingOrderBatchExecutor executor = new StandingOrderBatchExecutor(payable(address(this)));
        PayingOrder first = new PayingOrder{value: 1 ether}(1 ether);
        PayingOrder second = new PayingOrder{value: 1 ether}(1 ether);
        address builder = address(0xB01D);
        vm.coinbase(builder);

        StandingOrderBatchExecutor.OrderBid[] memory orders = new StandingOrderBatchExecutor.OrderBid[](2);
        orders[0] = StandingOrderBatchExecutor.OrderBid(address(first), 15_000);
        orders[1] = StandingOrderBatchExecutor.OrderBid(address(second), 0);

        (, uint256 gross, uint256 builderPayment) = executor.execute(orders, 0.5 ether);
        require(gross == 2 ether, "wrong gross reward");
        require(builderPayment == 1.5 ether, "bid was capped");
        require(builder.balance == 1.5 ether, "builder not paid");
    }

    function testRejectsUnauthorizedCaller() external {
        StandingOrderBatchExecutor executor = new StandingOrderBatchExecutor(payable(address(this)));
        StandingOrderBatchExecutor.OrderBid[] memory orders = new StandingOrderBatchExecutor.OrderBid[](1);
        orders[0] = StandingOrderBatchExecutor.OrderBid(address(1), 1_000);

        vm.prank(address(0xBAD));
        (bool success,) = address(executor).call(abi.encodeCall(executor.execute, (orders, 1)));
        require(!success, "unauthorized caller succeeded");
    }

    function testBuilderPaymentFailureRollsBackCranks() external {
        vm.deal(address(this), 2 ether);
        StandingOrderBatchExecutor executor = new StandingOrderBatchExecutor(payable(address(this)));
        PayingOrder paying = new PayingOrder{value: 1 ether}(1 ether);
        RejectingReceiver rejectingBuilder = new RejectingReceiver();
        vm.coinbase(address(rejectingBuilder));

        StandingOrderBatchExecutor.OrderBid[] memory orders = new StandingOrderBatchExecutor.OrderBid[](1);
        orders[0] = StandingOrderBatchExecutor.OrderBid(address(paying), 1_000);

        (bool success,) = address(executor).call(abi.encodeCall(executor.execute, (orders, 1)));
        require(!success, "failed builder payment did not revert");
        require(address(paying).balance == 1 ether, "crank was not rolled back");
    }

    /// @dev Replays the eight-order opportunity lost at target block 25656381.
    ///      It is skipped when the discovery endpoint is unavailable (for
    ///      ordinary offline unit-test runs).
    function testForkReplaysEightOrderOpportunity() external {
        string memory rpcUrl = vm.envOr("DISCOVERY_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl, 25_656_380);

        StandingOrderBatchExecutor executor = new StandingOrderBatchExecutor(payable(address(this)));
        vm.coinbase(address(0xB01D));

        StandingOrderBatchExecutor.OrderBid[] memory orders = new StandingOrderBatchExecutor.OrderBid[](8);
        orders[0] = StandingOrderBatchExecutor.OrderBid(0xA9Cd1a00bBf8B03DE3b01B050691EF260fD9a542, 9_503);
        orders[1] = StandingOrderBatchExecutor.OrderBid(0xc496D45265a7D7a61EA9Bc7180c351A98FD8caee, 1_000);
        orders[2] = StandingOrderBatchExecutor.OrderBid(0xCee71C92cCE29238520400f5ddAdc89A24E7Adf8, 9_503);
        orders[3] = StandingOrderBatchExecutor.OrderBid(0x06c49C51E445D4e69c8F3d1325A1cC80cBE297Fb, 9_503);
        orders[4] = StandingOrderBatchExecutor.OrderBid(0x20537147391a1C6dEe78b1597e9aBf749E761162, 3_119);
        orders[5] = StandingOrderBatchExecutor.OrderBid(0x97dC37214E2A75D6FFa1f4e46806EFc324552B4F, 9_503);
        orders[6] = StandingOrderBatchExecutor.OrderBid(0xd4BC6D9Ab8F5fBf2994f7a880f8daCb5a7ad09D9, 9_503);
        orders[7] = StandingOrderBatchExecutor.OrderBid(0xd94940eA4F3fFcfBEf3656a72519CeC2eB4e89e8, 9_503);

        uint256 gasBefore = gasleft();
        (uint256 succeeded, uint256 gross, uint256 builderPayment) = executor.execute(orders, 0.00028 ether);
        uint256 gasUsed = gasBefore - gasleft();

        require(succeeded == 8, "not every historical order succeeded");
        require(gross == 0.0011 ether, "historical reward changed");
        require(builderPayment == 0.00081143 ether, "historical bid changed");
        require(gasUsed < 1_250_000, "batch gas saving regressed");
        emit ForkReplay(gasUsed, gross, gross - builderPayment);
    }
}
