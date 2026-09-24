// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CardNFT} from "../src/CardNFT.sol";
import {Mine} from "../src/Mine.sol";
import {Vault} from "../src/Vault.sol";
import {Rewards} from "../src/Rewards.sol";

/// @dev 无法接收 ERC721 的合约（没有 onERC721Received）
contract NonReceiver {}

/// @title 边界与回归测试：补充 Game.t.sol 未覆盖的用例，不改变被测逻辑
contract EdgeTest is Test {
    CardNFT nft;
    Rewards rewards;
    Vault vault;
    Mine mine;

    address owner = address(0xA11CE);
    address treasury = address(0x7EA5);
    address alice = address(0xA1);
    address bob = address(0xB0B);

    uint256 constant BASE_BITS = 8;
    uint256 constant BITS_PER_TIER = 1;
    uint256 constant TIER_SIZE = 5;
    uint256 constant START_PRICE = 1 ether;
    uint256 constant MAX_MINTS = 20;
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

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.prank(alice);
        nft.setApprovalForAll(address(vault), true);
        vm.prank(bob);
        nft.setApprovalForAll(address(vault), true);
    }

    function findNonce(address user) internal view returns (uint64) {
        uint256 bits = mine.currentBits();
        for (uint64 n = 0; n < type(uint64).max; n++) {
            if (mine.isValidNonce(user, n, bits) && !mine.nonceUsed(user, n)) return n;
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

    // ---------- 回归：Deploy 脚本 owner 分离 bug ----------
    // 原脚本把 owner 直接传进 constructor，之后 deployer 再调 onlyOwner 的 setMinter 必然 revert。
    // 修复后的顺序：constructor(owner = deployer) → 接线 → transferOwnership。
    // 这里锁定"接线完成前 owner 必须是部署者"这一不变量。
    function test_Regression_DeployerMustBeOwnerDuringWiring() public {
        address deployer = address(this);
        address finalOwner = address(0x0B0);

        // 错误顺序（原脚本）：owner 直接给 finalOwner → 部署者接线被拒
        CardNFT bad = new CardNFT("x", "y", "", finalOwner);
        vm.expectRevert();
        bad.setMinter(address(0x1));

        // 正确顺序（修复后）：先 deployer 持有 → 接线 → 移交
        CardNFT good = new CardNFT("x", "y", "", deployer);
        good.setMinter(address(0x1));
        good.transferOwnership(finalOwner);
        assertEq(good.owner(), finalOwner);
        assertEq(good.minter(), address(0x1));
    }

    // ---------- 0 分红 Claim ----------

    function test_Claim_ZeroRewards_Succeeds() public {
        uint256 before = alice.balance;
        vm.prank(alice);
        rewards.claim(); // 不 revert
        assertEq(alice.balance, before); // 余额不变
        assertEq(rewards.pending(alice), 0);
    }

    // ---------- 365 天锁仓边界（生产参数，用 vm.warp 测，不改合约） ----------

    function test_Unstake_LockBoundary() public {
        mintFor(alice);
        vm.prank(alice);
        vault.stake(1);
        uint256 t0 = block.timestamp;

        vm.warp(t0 + LOCK - 1); // 差 1 秒：仍锁定
        vm.prank(alice);
        vm.expectRevert(Vault.StillLocked.selector);
        vault.unstake(1);

        vm.warp(t0 + LOCK); // 恰好 365 天：解锁
        vm.prank(alice);
        vault.unstake(1);
        assertEq(nft.ownerOf(1), alice);
    }

    // ---------- Tier 边界：涨价 + 升难度使旧 nonce 作废 ----------

    function test_TierBoundary_PriceDoublesAtExactMint() public {
        for (uint256 i = 0; i < TIER_SIZE - 1; i++) {
            mintFor(alice);
        }
        assertEq(mine.currentTier(), 0);
        assertEq(mine.currentMintDue(), 1 ether);

        mintFor(alice); // 本 tier 最后一张，仍按 1 ETH
        assertEq(mine.minted(), TIER_SIZE);
        assertEq(mine.currentTier(), 1);
        assertEq(mine.currentMintDue(), 2 ether);
        assertEq(mine.currentBits(), BASE_BITS + 1);
    }

    function test_TierBoundary_OldNonceInvalidated() public {
        for (uint256 i = 0; i < TIER_SIZE; i++) {
            mintFor(alice); // 跨档，难度升到 9 bits
        }
        // 跨档后找一个对 alice 在 8 bits 有效、但 9 bits 无效、且未被消耗过的 nonce
        uint64 n = 0;
        bool found;
        for (uint64 i = 0; i < type(uint64).max; i++) {
            if (
                mine.isValidNonce(alice, i, BASE_BITS) && !mine.isValidNonce(alice, i, BASE_BITS + 1)
                    && !mine.nonceUsed(alice, i)
            ) {
                n = i;
                found = true;
                break;
            }
        }
        require(found, "no boundary nonce");
        vm.prank(alice);
        vm.expectRevert(Mine.BadNonce.selector);
        mine.mint{value: 2 ether}(n); // 旧难度挖的码作废
    }

    // ---------- Mint 目标地址不能接收 NFT 时整笔回滚 ----------

    function test_Mint_ToNonReceiverContract_Reverts() public {
        NonReceiver nr = new NonReceiver();
        uint64 n = findNonce(address(nr));
        vm.deal(address(nr), 10 ether);
        vm.prank(address(nr));
        vm.expectRevert(); // ERC721InvalidReceiver
        mine.mint{value: 1 ether}(n);
        // 全部回滚：nonce 未被消耗、minted 不变、钱退回
        assertFalse(mine.nonceUsed(address(nr), n));
        assertEq(mine.minted(), 0);
        assertEq(address(nr).balance, 10 ether);
    }

    // ---------- Fuzz ----------

    /// @dev 任何不等于当前价格的支付都必须 revert
    function testFuzz_Mint_WrongPayment_Reverts(uint256 pay) public {
        uint256 due = mine.currentMintDue();
        vm.assume(pay != due);
        vm.assume(pay <= 100 ether); // 限制在打得起钱的范围
        uint64 n = findNonce(alice);
        vm.deal(alice, pay);
        vm.prank(alice);
        vm.expectRevert(Mine.WrongPayment.selector);
        mine.mint{value: pay}(n);
    }

    /// @dev 钉死 hash 编码（hardened-v1）：isValidForChallenge 必须等于
    ///      本地 keccak256(abi.encodePacked(challenge, user, nonce)) 的高 bits 判断
    function testFuzz_IsValidNonce_MatchesLocalEncoding(bytes32 ch, address user, uint64 nonce, uint8 bits) public {
        vm.assume(bits > 0 && bits <= 64);
        bytes32 h = keccak256(abi.encodePacked(ch, user, nonce));
        bool expected = uint256(h) >> (256 - bits) == 0;
        assertEq(mine.isValidForChallenge(ch, user, nonce, bits), expected);
        assertEq(mine.hashFor(ch, user, nonce), h);
    }

    /// @dev isValidNonce(user, nonce, bits) 是"当前 challenge"的便捷视图
    function testFuzz_IsValidNonce_UsesCurrentChallenge(address user, uint64 nonce) public {
        assertEq(
            mine.isValidNonce(user, nonce, 8),
            mine.isValidForChallenge(mine.currentChallenge(), user, nonce, 8)
        );
    }
}
