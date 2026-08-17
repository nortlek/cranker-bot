// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MegaRipKeeperExecutor} from "../MegaRipKeeperExecutor.sol";

interface Vm {
    function deal(address target, uint256 balance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function prank(address sender) external;
}

contract MockMegaRip {
    uint256 public pullsAvailable;
    uint256 public bounty;
    mapping(uint256 => bool) public rewardedSettlement;
    mapping(uint256 => bool) public rewardedRecovery;
    uint256 public revealBounties;

    address internal constant FWA = 0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c;

    receive() external payable {}

    function setPulls(uint256 count) external {
        pullsAvailable = count;
    }

    function setBounty(uint256 amount) external {
        bounty = amount;
    }

    function setSettlement(uint256 listingId, bool rewarded) external {
        rewardedSettlement[listingId] = rewarded;
    }

    function setRecovery(uint256 listingId, bool rewarded) external {
        rewardedRecovery[listingId] = rewarded;
    }

    function setRevealBounties(uint256 count) external {
        revealBounties = count;
    }

    function pull(uint256 maxPulls) external {
        uint256 made = maxPulls < pullsAvailable ? maxPulls : pullsAvailable;
        pullsAvailable -= made;
        _pay(msg.sender, made * bounty);
    }

    function crankReveal(uint256 maxCount) external {
        MockFwa(FWA).advance(maxCount);
        uint256 count = revealBounties;
        revealBounties = 0;
        _pay(msg.sender, count * bounty);
    }

    function settle(uint256 listingId) external {
        if (rewardedSettlement[listingId]) {
            rewardedSettlement[listingId] = false;
            _pay(msg.sender, bounty);
        }
    }

    function syncStuck(uint256 listingId) external {
        if (rewardedRecovery[listingId]) {
            rewardedRecovery[listingId] = false;
            _pay(msg.sender, bounty);
        }
    }

    function _pay(address to, uint256 amount) internal {
        (bool success,) = to.call{value: amount}("");
        require(success, "payment failed");
    }
}

contract MockFwa {
    uint64 public nextSequenceToProcess;

    function setNext(uint64 next) external {
        nextSequenceToProcess = next;
    }

    function advance(uint256 count) external {
        nextSequenceToProcess += uint64(count);
    }
}

contract MegaRipKeeperExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant MEGA_RIP = 0x6769944589f5CC96d5F900F06539681Db84AC5c6;
    address private constant FWA = 0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c;

    receive() external payable {}

    function installMock() internal returns (MockMegaRip mock) {
        MockMegaRip implementation = new MockMegaRip();
        vm.etch(MEGA_RIP, address(implementation).code);
        mock = MockMegaRip(payable(MEGA_RIP));
        vm.deal(MEGA_RIP, 100 ether);
        mock.setBounty(0.0003 ether);
    }

    function installFwaMock(uint64 next) internal returns (MockFwa mock) {
        MockFwa implementation = new MockFwa();
        vm.etch(FWA, address(implementation).code);
        mock = MockFwa(FWA);
        mock.setNext(next);
    }

    function testPullsManyAndReturnsTheExactBounty() external {
        MockMegaRip mock = installMock();
        mock.setPulls(20);
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));
        uint256 beforeBalance = address(this).balance;

        uint256 bounty = executor.pullExact(20, 20 * 0.0003 ether);

        require(bounty == 0.006 ether, "wrong bounty");
        require(address(this).balance - beforeBalance == bounty, "owner not paid");
        require(mock.pullsAvailable() == 0, "pulls remain");
    }

    function testInsufficientPullBountyRevertsAllState() external {
        MockMegaRip mock = installMock();
        mock.setPulls(2);
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));

        (bool success,) = address(executor).call(abi.encodeCall(executor.pullExact, (10, 10 * 0.0003 ether)));

        require(!success, "short pull succeeded");
        require(mock.pullsAvailable() == 2, "pull state did not roll back");
    }

    function testRevealBindsTheFwaPrefixAndReturnsTheExactBounty() external {
        MockMegaRip mock = installMock();
        MockFwa fwa = installFwaMock(100);
        mock.setRevealBounties(2);
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));

        uint256 bounty = executor.crankRevealExact(100, 103, 0.0006 ether);

        require(bounty == 0.0006 ether, "wrong reveal bounty");
        require(fwa.nextSequenceToProcess() == 103, "wrong FWA pointer");
    }

    function testRevealRejectsAMovedFwaPrefix() external {
        MockMegaRip mock = installMock();
        MockFwa fwa = installFwaMock(101);
        mock.setRevealBounties(2);
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));

        (bool success,) = address(executor).call(abi.encodeCall(executor.crankRevealExact, (100, 103, 0.0006 ether)));

        require(!success, "moved reveal succeeded");
        require(fwa.nextSequenceToProcess() == 101, "FWA pointer changed");
        require(mock.revealBounties() == 2, "reveal state changed");
    }

    function testBatchesRewardedSettlements() external {
        MockMegaRip mock = installMock();
        mock.setSettlement(11, true);
        mock.setSettlement(12, true);
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 11;
        ids[1] = 12;

        uint256 bounty = executor.settleExact(ids, 0.0006 ether);

        require(bounty == 0.0006 ether, "wrong settlement bounty");
    }

    function testUnrewardedSettlementRevertsTheWholeBatch() external {
        MockMegaRip mock = installMock();
        mock.setSettlement(11, true);
        mock.setSettlement(12, false);
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 11;
        ids[1] = 12;

        (bool success,) = address(executor).call(abi.encodeCall(executor.settleExact, (ids, 0.0006 ether)));

        require(!success, "unrewarded settlement succeeded");
        require(mock.rewardedSettlement(11), "first settlement did not roll back");
    }

    function testBatchesRewardedRecoveries() external {
        MockMegaRip mock = installMock();
        mock.setRecovery(21, true);
        mock.setRecovery(22, true);
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 21;
        ids[1] = 22;

        uint256 bounty = executor.syncStuckExact(ids, 0.0006 ether);

        require(bounty == 0.0006 ether, "wrong recovery bounty");
    }

    function testRejectsUnauthorizedCaller() external {
        installMock();
        MegaRipKeeperExecutor executor = new MegaRipKeeperExecutor(address(this));
        vm.prank(address(0xBAD));
        (bool success,) = address(executor).call(abi.encodeCall(executor.pullExact, (1, 0.0003 ether)));
        require(!success, "unauthorized caller succeeded");
    }
}
