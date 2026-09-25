// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface VmPunkMegaRipFork {
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function deal(address account, uint256 newBalance) external;
    function prank(address msgSender) external;
    function txGasPrice(uint256 newGasPrice) external;
}

interface IPunkMegaRipRound {
    function requestPullBatch(uint256 expectedFirst, uint256 witnessListingId, uint256 maxCount) external;
    function syncAndSettle(uint256 expectedFirst, uint256 maxCount) external;
    function pullCount() external view returns (uint256);
    function syncCursor() external view returns (uint256);
    function bankroll() external view returns (uint256);
    function requiredGasBudget() external view returns (uint256);
}

contract PunkMegaRipLiveForkTest {
    VmPunkMegaRipFork internal constant vm =
        VmPunkMegaRipFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    IPunkMegaRipRound internal constant ROUND =
        IPunkMegaRipRound(0xDdd0c297BB34c8d2F41FaA0829898cDB0247BFaF);
    address internal constant CALLER = 0x1111111111111111111111111111111111111111;

    function testExactPilotParentSupportsBoundedRequestBatchWithProtectedBudget() external {
        string memory rpcUrl = vm.envOr("RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, 26_051_666);
        vm.deal(CALLER, 1 ether);
        vm.txGasPrice(156_539_530);
        uint256 balanceBefore = CALLER.balance;

        vm.prank(CALLER);
        ROUND.requestPullBatch(30, 55, 1);

        require(ROUND.pullCount() == 31, "request did not advance exact cursor");
        require(CALLER.balance > balanceBefore, "request reimbursement missing");
        require(ROUND.bankroll() >= ROUND.requiredGasBudget(), "protected gas budget breached");
    }

    function testExactPilotParentSupportsBoundedSyncAndSettle() external {
        string memory rpcUrl = vm.envOr("RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, 26_051_685);
        vm.deal(CALLER, 1 ether);
        vm.txGasPrice(154_763_686);
        uint256 balanceBefore = CALLER.balance;

        vm.prank(CALLER);
        ROUND.syncAndSettle(35, 1);

        require(ROUND.syncCursor() == 36, "sync did not advance exact cursor");
        require(CALLER.balance > balanceBefore, "sync reimbursement missing");
        require(ROUND.bankroll() >= ROUND.requiredGasBudget(), "protected gas budget breached");
    }
}
