// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CardNFT} from "../src/CardNFT.sol";
import {Mine} from "../src/Mine.sol";
import {Vault} from "../src/Vault.sol";
import {Rewards} from "../src/Rewards.sol";

/// @title hardened-v1 Challenge 威胁模型测试（针对真实 Mine 合约，mint 全链路）
/// 覆盖：前置计算 / 跨链 / 跨合约 / nonce replay / challenge replay / 旧 epoch / 宽限期 / MEV copy
contract ChallengeTest is Test {
    uint256 constant EPOCH = 24 hours;
    uint256 constant GRACE = 10 minutes;
    uint256 constant BASE_BITS = 6;
    uint256 constant TIER_SIZE = 5;
    uint256 constant START_PRICE = 1 ether;
    uint256 constant MAX_MINTS = 20;
    uint256 constant LOCK = 365 days;

    CardNFT nft;
    Rewards rewards;
    Vault vault;
    Mine mine;

    address owner = address(0xA11CE);
    address treasury = address(0x7EA5);
    address alice = address(0xA1);
    address bob = address(0xB0B);

    function setUp() public {
        vm.chainId(46630);
        nft = new CardNFT("Mine Card", "MCARD", "", owner);
        rewards = new Rewards(owner);
        vault = new Vault(nft, rewards, LOCK, owner);
        mine = new Mine(nft, rewards, treasury, owner, BASE_BITS, 1, TIER_SIZE, START_PRICE, MAX_MINTS, EPOCH, GRACE);
        vm.startPrank(owner);
        nft.setMinter(address(mine));
        rewards.setMine(address(mine));
        rewards.setVault(address(vault));
        vm.stopPrank();
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    function _findNonceFor(bytes32 challenge, address user) internal view returns (uint64) {
        uint256 bits = mine.currentBits();
        for (uint64 n = 0; n < 1_000_000; n++) {
            if (mine.isValidForChallenge(challenge, user, n, bits) && !mine.nonceUsed(user, n)) return n;
        }
        revert("nonce not found");
    }

    function _rotate() internal {
        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        mine.rotate();
    }

    // ---------- 正常 mint（当前 challenge） ----------

    function test_Mint_CurrentChallenge() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        vm.prank(alice);
        mine.mint{value: 1 ether}(n);
        assertEq(mine.minted(), 1);
        assertEq(nft.ownerOf(1), alice);
    }

    // ---------- nonce replay ----------

    function test_NonceReplay_Reverts() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        vm.prank(alice);
        mine.mint{value: 1 ether}(n);
        vm.prank(alice);
        vm.expectRevert(Mine.NonceAlreadyUsed.selector);
        mine.mint{value: 1 ether}(n);
    }

    // ---------- MEV copy transaction ----------

    function test_MEVCopy_OtherSender_Reverts() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        vm.prank(bob); // 复制 alice 的 calldata
        vm.expectRevert(Mine.BadNonce.selector);
        mine.mint{value: 1 ether}(n);
    }

    // ---------- 跨合约复用 ----------

    function test_CrossContract_Replay_Fails() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        Mine other = new Mine(nft, rewards, treasury, owner, BASE_BITS, 1, TIER_SIZE, START_PRICE, MAX_MINTS, EPOCH, GRACE);
        // 同一地址在另一个 Mine 实例的 challenge 下无效
        assertFalse(other.isValidNonce(alice, n, BASE_BITS));
        vm.prank(alice);
        vm.expectRevert(); // BadNonce（other 未接线，但校验先于任何外部调用）
        other.mint{value: 1 ether}(n);
    }

    // ---------- 跨链复用 ----------

    function test_CrossChain_Replay_Fails() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        bytes32 ch46630 = mine.currentChallenge();
        vm.chainId(1);
        Mine mainnetCopy = new Mine(nft, rewards, treasury, owner, BASE_BITS, 1, TIER_SIZE, START_PRICE, MAX_MINTS, EPOCH, GRACE);
        assertTrue(mainnetCopy.currentChallenge() != ch46630, "challenge must differ across chains");
        assertFalse(mainnetCopy.isValidNonce(alice, n, BASE_BITS));
    }

    // ---------- 前置计算 ----------

    function test_Precomputation_FutureChallengeUnknown() public {
        bytes32 attackerGuess = keccak256(abi.encode(block.chainid, address(mine), 1, mine.epochSeed()));
        _rotate();
        assertTrue(mine.currentChallenge() != attackerGuess, "next challenge must be unpredictable");
    }

    // ---------- 旧 epoch nonce + 宽限期 ----------

    function test_OldChallenge_WithinGrace_Mints() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        _rotate();
        vm.prank(alice);
        mine.mint{value: 1 ether}(n); // 宽限期内旧码可用
        assertEq(mine.minted(), 1);
    }

    function test_OldChallenge_AfterGrace_Reverts() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        _rotate();
        vm.warp(block.timestamp + GRACE + 1);
        vm.prank(alice);
        vm.expectRevert(Mine.BadNonce.selector);
        mine.mint{value: 1 ether}(n);
    }

    function test_ChallengeReplay_TwoRotations_PermanentlyDead() public {
        uint64 n = _findNonceFor(mine.currentChallenge(), alice);
        _rotate();
        _rotate(); // 宽限只覆盖上一代
        vm.prank(alice);
        vm.expectRevert(Mine.BadNonce.selector);
        mine.mint{value: 1 ether}(n);
    }

    function test_Rotate_BeforeMaturity_Reverts() public {
        vm.expectRevert(Mine.EpochNotMature.selector);
        mine.rotate();
    }

    function test_Rotate_EmitsChallengeUpdated() public {
        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        vm.expectEmit(false, false, false, false);
        emit Mine.ChallengeUpdated(1, bytes32(0), 0, 0); // 值不校验，只校验事件存在
        mine.rotate();
        assertEq(mine.epoch(), 1);
        assertGt(mine.previousValidUntil(), block.timestamp);
    }

    // ---------- 构造参数校验 ----------

    function test_Constructor_RejectsBadEpochConfig() public {
        vm.expectRevert(Mine.BadConfig.selector);
        new Mine(nft, rewards, treasury, owner, BASE_BITS, 1, TIER_SIZE, START_PRICE, MAX_MINTS, 0, 10 minutes);
        vm.expectRevert(Mine.BadConfig.selector);
        new Mine(nft, rewards, treasury, owner, BASE_BITS, 1, TIER_SIZE, START_PRICE, MAX_MINTS, 10 minutes, 10 minutes);
    }
}
