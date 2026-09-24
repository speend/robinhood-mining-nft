// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {CardNFT} from "../src/CardNFT.sol";
import {Mine} from "../src/Mine.sol";
import {Vault} from "../src/Vault.sol";
import {Rewards} from "../src/Rewards.sol";

/// @dev 攻击者：在 onERC721Received 回调里抢先质押刚铸到的卡
contract MinerReceiver {
    Mine private immutable mine;
    Vault private immutable vault;
    CardNFT private immutable nft;

    constructor(Mine mine_, Vault vault_, CardNFT nft_) {
        mine = mine_;
        vault = vault_;
        nft = nft_;
    }

    function attack(uint64 nonce, uint256 value) external {
        mine.mint{value: value}(nonce);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        nft.approve(address(vault), tokenId);
        vault.stake(tokenId);
        return this.onERC721Received.selector;
    }
}

contract RejectingTreasury {
    receive() external payable {
        revert();
    }
}

contract GameTest is Test {
    CardNFT nft;
    Rewards rewards;
    Vault vault;
    Mine mine;

    address owner = address(0xA11CE);
    address treasury = address(0x7EA5);
    address alice = address(0xA1);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    uint256 constant BASE_BITS = 8;
    uint256 constant BITS_PER_TIER = 1;
    uint256 constant TIER_SIZE = 5;
    uint256 constant START_PRICE = 1 ether; // 测试用 1 ETH 起步，好读
    uint256 constant MAX_MINTS = 20; // 4 档
    uint256 constant LOCK = 365 days;

    function setUp() public {
        nft = new CardNFT("Mine Card", "MCARD", "ipfs://base/", owner);
        rewards = new Rewards(owner);
        vault = new Vault(nft, rewards, LOCK, owner);
        mine = new Mine(nft, rewards, treasury, owner, BASE_BITS, BITS_PER_TIER, TIER_SIZE, START_PRICE, MAX_MINTS, 24 hours, 10 minutes);

        vm.startPrank(owner);
        nft.setMinter(address(mine));
        rewards.setMine(address(mine));
        rewards.setVault(address(vault));
        vm.stopPrank();

        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < users.length; i++) {
            vm.deal(users[i], 1_000 ether);
            vm.prank(users[i]);
            nft.setApprovalForAll(address(vault), true);
        }
    }

    // ---------- helpers ----------

    function findNonce(address user) internal view returns (uint64) {
        uint256 bits = mine.currentBits();
        for (uint64 n = 0; n < type(uint64).max; n++) {
            if (mine.isValidNonce(user, n, bits) && !mine.nonceUsed(user, n)) return n;
        }
        revert("nonce not found");
    }

    function findNonceInvalidFor(address userA, address userB) internal view returns (uint64) {
        uint256 bits = mine.currentBits();
        for (uint64 n = 0; n < type(uint64).max; n++) {
            if (mine.isValidNonce(userA, n, bits) && !mine.isValidNonce(userB, n, bits)) return n;
        }
        revert("nonce not found");
    }

    function mintFor(address user) internal returns (uint64) {
        uint64 n = findNonce(user);
        uint256 due = mine.currentMintDue();
        vm.prank(user);
        mine.mint{value: due}(n);
        return n;
    }

    // ---------- 挖矿 / 定价 / 分账 ----------

    function test_Mint_ValidNonce_SplitsFunds() public {
        uint256 treasuryBefore = treasury.balance;
        mintFor(alice);

        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.ownerOf(1), alice);
        assertEq(mine.minted(), 1);
        assertEq(treasury.balance - treasuryBefore, 0.3 ether);
        assertEq(address(rewards).balance, 0.7 ether);
        assertEq(alice.balance, 1_000 ether - 1 ether);
    }

    function test_Mint_WrongPayment_Reverts() public {
        uint64 n = findNonce(alice);
        vm.prank(alice);
        vm.expectRevert(Mine.WrongPayment.selector);
        mine.mint{value: 1 ether - 1}(n);

        vm.prank(alice);
        vm.expectRevert(Mine.WrongPayment.selector);
        mine.mint{value: 1 ether + 1}(n);

        vm.prank(alice);
        vm.expectRevert(Mine.WrongPayment.selector);
        mine.mint(n); // 不付钱也不行
    }

    function test_Mint_BadNonce_Reverts() public {
        uint256 bits = mine.currentBits();
        uint64 bad = 0;
        while (mine.isValidNonce(alice, bad, bits)) {
            bad++;
        }
        vm.prank(alice);
        vm.expectRevert(Mine.BadNonce.selector);
        mine.mint{value: 1 ether}(bad);
    }

    function test_Mint_ReusedNonce_Reverts() public {
        uint64 n = mintFor(alice);
        vm.prank(alice);
        vm.expectRevert(Mine.NonceAlreadyUsed.selector);
        mine.mint{value: 1 ether}(n);
    }

    function test_Mint_OthersNonce_Reverts() public {
        uint64 n = findNonceInvalidFor(alice, bob);
        vm.prank(alice);
        mine.mint{value: 1 ether}(n);
        vm.prank(bob);
        vm.expectRevert(Mine.BadNonce.selector);
        mine.mint{value: 1 ether}(n);
    }

    function test_TieredPricing() public {
        for (uint256 i = 0; i < TIER_SIZE; i++) {
            mintFor(alice);
        }
        assertEq(mine.currentTier(), 1);
        assertEq(mine.currentMintDue(), 2 ether);
        assertEq(mine.currentBits(), BASE_BITS + BITS_PER_TIER);

        uint256 before = bob.balance;
        mintFor(bob);
        assertEq(before - bob.balance, 2 ether);
    }

    function test_SoldOut() public {
        for (uint256 i = 0; i < MAX_MINTS; i++) {
            mintFor(alice);
        }
        assertEq(mine.minted(), MAX_MINTS);

        uint64 n = findNonce(alice);
        uint256 due = mine.currentMintDue();
        vm.prank(alice);
        vm.expectRevert(Mine.SoldOut.selector);
        mine.mint{value: due}(n);
    }

    function test_Mint_OnlyMinterCanMintNFT() public {
        vm.prank(alice);
        vm.expectRevert(CardNFT.NotMinter.selector);
        nft.mint(alice);
    }

    function test_Pause_StopsMint_NotClaimNotUnstake() public {
        mintFor(alice);
        vm.prank(alice);
        vault.stake(1);
        mintFor(bob); // alice 累积待领分红

        vm.prank(owner);
        mine.pause();

        uint64 n = findNonce(carol);
        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mine.mint{value: 1 ether}(n);

        vm.prank(alice);
        rewards.claim(); // 暂停不影响领取

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        vault.unstake(1); // 暂停不影响赎回

        vm.prank(owner);
        mine.unpause();
        mintFor(carol); // 恢复后可以继续挖
        assertEq(mine.minted(), 3);
    }

    // ---------- 质押 ----------

    function test_Stake_Unstake() public {
        mintFor(alice);
        vm.prank(alice);
        vault.stake(1);

        assertEq(nft.ownerOf(1), address(vault));
        assertEq(vault.weightOf(alice), 1);
        assertEq(rewards.weightOf(alice), 1);
        assertEq(rewards.totalWeight(), 1);

        vm.prank(alice);
        vm.expectRevert(Vault.StillLocked.selector);
        vault.unstake(1);

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        vault.unstake(1);

        assertEq(nft.ownerOf(1), alice);
        assertEq(rewards.weightOf(alice), 0);
        assertEq(rewards.totalWeight(), 0);
    }

    function test_Stake_NotOwner_Reverts() public {
        mintFor(alice);
        vm.prank(bob);
        vm.expectRevert(Vault.NotTokenOwner.selector);
        vault.stake(1);
    }

    function test_Stake_AlreadyStaked_Reverts() public {
        mintFor(alice);
        vm.prank(alice);
        vault.stake(1);
        vm.prank(alice);
        vm.expectRevert(Vault.AlreadyStaked.selector);
        vault.stake(1);
    }

    // ---------- 分红 ----------

    function test_Rewards_FirstStakerGetsUndistributed() public {
        mintFor(alice);
        mintFor(bob);
        mintFor(carol);
        assertEq(rewards.undistributed(), 2.1 ether);
        assertEq(address(rewards).balance, 2.1 ether);

        vm.prank(alice);
        vault.stake(1); // 无人质押期间攒下的 2.1 ETH 全部归第一个质押者
        assertEq(rewards.pending(alice), 2.1 ether);
        assertEq(rewards.undistributed(), 0);

        vm.prank(alice);
        rewards.claim();
        assertEq(alice.balance, 1_000 ether - 1 ether + 2.1 ether);
    }

    function test_Rewards_SplitByWeight() public {
        mintFor(alice);
        mintFor(bob);
        vm.prank(alice);
        vault.stake(1); // 第一个质押者，独享暂存的 1.4 ETH
        vm.prank(bob);
        vault.stake(2);

        assertEq(rewards.pending(alice), 1.4 ether);
        assertEq(rewards.pending(bob), 0);

        mintFor(carol); // +0.7 ETH，此时两人按权重 1:1 分

        assertEq(rewards.pending(alice), 1.4 ether + 0.35 ether);
        assertEq(rewards.pending(bob), 0.35 ether);
        assertEq(rewards.pending(carol), 0); // 未质押 = 0

        vm.prank(alice);
        rewards.claim();
        vm.prank(bob);
        rewards.claim();
        assertEq(address(rewards).balance, 0);
    }

    function test_Rewards_WeightChangeSettlesFairly() public {
        mintFor(alice);
        mintFor(bob);
        vm.prank(alice);
        vault.stake(1);
        mintFor(carol); // +0.7 ETH 全归 alice
        assertEq(rewards.pending(alice), 2.1 ether);

        vm.prank(bob);
        vault.stake(2); // bob 此时才进场，不能分走 alice 已累计的
        assertEq(rewards.pending(alice), 2.1 ether);
        assertEq(rewards.pending(bob), 0);

        mintFor(carol); // +0.7 ETH，1:1
        assertEq(rewards.pending(alice), 2.1 ether + 0.35 ether);
        assertEq(rewards.pending(bob), 0.35 ether);
    }

    function test_PendingSurvivesUnstake() public {
        mintFor(alice); // 池 +0.7 ETH（暂存）
        vm.prank(alice);
        vault.stake(1); // 首个质押者独享暂存
        mintFor(bob); // 池 +0.7 ETH，全归 alice

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        vault.unstake(1);

        assertEq(rewards.pending(alice), 1.4 ether); // 赎回后仍可领
        vm.prank(alice);
        rewards.claim();
        assertEq(alice.balance, 1_000 ether - 1 ether + 1.4 ether);
    }

    function test_Rewards_WeightBackToZero_NewStakerCaptures() public {
        mintFor(alice);
        vm.prank(alice);
        vault.stake(1);
        mintFor(bob); // alice 累计：暂存 0.7 + 这笔 0.7 = 1.4

        vm.warp(block.timestamp + LOCK);
        vm.prank(alice);
        vault.unstake(1); // 权重归零
        vm.prank(alice);
        rewards.claim();
        assertEq(address(rewards).balance, 0);

        mintFor(bob); // 无人质押 → 暂存
        mintFor(carol);
        assertEq(rewards.undistributed(), 1.4 ether);

        vm.prank(bob);
        vault.stake(2); // bob 成为新的"第一个质押者"，独享暂存
        assertEq(rewards.pending(bob), 1.4 ether);
    }

    // ---------- 安全回归 ----------

    function test_Reentrancy_StakeInMintCallback_CannotCaptureOwnDividend() public {
        mintFor(alice);
        vm.prank(alice);
        vault.stake(1);
        mintFor(bob); // 让分红正常结算一轮
        assertEq(rewards.pending(alice), 1.4 ether);

        MinerReceiver mallory = new MinerReceiver(mine, vault, nft);
        vm.deal(address(mallory), 10 ether);
        uint64 n = findNonce(address(mallory));

        mallory.attack(n, 1 ether);

        assertEq(rewards.pending(alice), 2.1 ether); // 这笔的分红全归已有质押者
        assertEq(rewards.pending(address(mallory)), 0); // 回调里抢质押，分不到自己这笔
        assertEq(rewards.weightOf(address(mallory)), 1); // 质押本身生效，只影响以后
        assertEq(nft.ownerOf(3), address(vault));
    }

    function test_TreasuryRejects_MintStillWorks() public {
        RejectingTreasury rt = new RejectingTreasury();
        vm.prank(owner);
        mine.setTreasury(address(rt));

        mintFor(alice); // 不会因为 treasury 拒收而卡死
        assertEq(mine.minted(), 1);
        assertEq(mine.treasuryAccrued(), 0.3 ether);

        vm.prank(owner);
        mine.setTreasury(treasury);
        mine.flushTreasury(); // 任何人都能触发，钱只会打给 treasury
        assertEq(treasury.balance, 0.3 ether);
        assertEq(mine.treasuryAccrued(), 0);
    }

    function test_BaseURI_Freeze() public {
        vm.prank(owner);
        nft.setBaseURI("ipfs://new/");
        assertEq(nft.baseURI(), "ipfs://new/");

        vm.prank(owner);
        nft.freezeBaseURI();

        vm.prank(owner);
        vm.expectRevert(CardNFT.Frozen.selector);
        nft.setBaseURI("ipfs://hacked/");
    }

    function test_Setters_RejectZeroAddress() public {
        CardNFT n2 = new CardNFT("x", "y", "", owner);
        vm.prank(owner);
        vm.expectRevert(CardNFT.ZeroAddress.selector);
        n2.setMinter(address(0));

        Rewards r2 = new Rewards(owner);
        vm.prank(owner);
        vm.expectRevert(Rewards.ZeroAddress.selector);
        r2.setMine(address(0));
        vm.prank(owner);
        vm.expectRevert(Rewards.ZeroAddress.selector);
        r2.setVault(address(0));
    }

    function test_Constructor_RejectsBadConfig() public {
        vm.expectRevert(Mine.BadConfig.selector);
        new Mine(nft, rewards, treasury, owner, 0, 1, 500, 1 ether, 5000, 24 hours, 10 minutes); // 难度为 0

        vm.expectRevert(Mine.BadConfig.selector);
        new Mine(nft, rewards, treasury, owner, 35, 1, 0, 1 ether, 5000, 24 hours, 10 minutes); // 档位容量为 0

        vm.expectRevert(Mine.BadConfig.selector);
        new Mine(nft, rewards, treasury, owner, 200, 10, 500, 1 ether, 5000, 24 hours, 10 minutes); // 难度会顶穿 256

        vm.expectRevert(Mine.BadConfig.selector);
        new Mine(nft, rewards, treasury, owner, 35, 1, 1, 1, 300, 24 hours, 10 minutes); // 价格左移溢出

        vm.expectRevert(Mine.BadConfig.selector);
        new Mine(nft, rewards, address(0), owner, 35, 1, 500, 1 ether, 5000, 24 hours, 10 minutes); // 零地址
    }

    function test_Rewards_AccessControl() public {
        vm.prank(alice);
        vm.expectRevert(Rewards.NotMine.selector);
        rewards.notify{value: 1 ether}(1 ether);

        vm.prank(alice);
        vm.expectRevert(Rewards.NotVault.selector);
        rewards.updateWeight(alice, 1);
    }
}
