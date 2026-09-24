// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CardNFT} from "../src/CardNFT.sol";
import {Mine} from "../src/Mine.sol";
import {Vault} from "../src/Vault.sol";
import {Rewards} from "../src/Rewards.sol";

/// @dev 不变量测试 handler：随机执行 mint/stake/unstake/claim/warp
contract RewardsHandler is Test {
    CardNFT public nft;
    Rewards public rewards;
    Vault public vault;
    Mine public mine;

    address public treasury = address(0x7EA5);
    address[4] public users = [address(0xA1), address(0xB0B), address(0xCA401), address(0xD00D)];

    uint256 constant BASE_BITS = 6; // 低难度，保证 handler 里能快速找到 nonce
    uint256 constant TIER_SIZE = 3;
    uint256 constant START_PRICE = 0.01 ether;
    uint256 constant MAX_MINTS = 24;
    uint256 constant LOCK = 365 days;

    uint256 public ghostStaked; // 当前质押总数（= 应等于 rewards.totalWeight）
    uint256 public ghostNotifies; // mint 成功次数（= notify 次数，用于尘埃上界）

    constructor() {
        nft = new CardNFT("Mine Card", "MCARD", "", address(this));
        rewards = new Rewards(address(this));
        vault = new Vault(nft, rewards, LOCK, address(this));
        mine = new Mine(nft, rewards, treasury, address(this), BASE_BITS, 0, TIER_SIZE, START_PRICE, MAX_MINTS);
        nft.setMinter(address(mine));
        rewards.setMine(address(mine));
        rewards.setVault(address(vault));

        for (uint256 i = 0; i < users.length; i++) {
            vm.deal(users[i], 1_000 ether);
            vm.prank(users[i]);
            nft.setApprovalForAll(address(vault), true);
        }
        // 注意：vm.prank 只改 msg.sender，call 的 value 仍从 handler 余额扣，必须给 handler 充值
        vm.deal(address(this), 10_000 ether);
    }

    function _findNonce(address user) internal view returns (uint64) {
        uint256 bits = mine.currentBits();
        for (uint64 n = 0; n < 100_000; n++) {
            if (mine.isValidNonce(user, n, bits) && !mine.nonceUsed(user, n)) return n;
        }
        revert("nonce not found");
    }

    function mint(uint256 userIdx) external {
        if (mine.minted() >= MAX_MINTS) return;
        address user = users[userIdx % users.length];
        uint64 n = _findNonce(user);
        // 先读价格再 prank：否则 prank 会被内嵌的 currentMintDue() 外部调用消耗掉
        uint256 due = mine.currentMintDue();
        vm.prank(user);
        mine.mint{value: due}(n);
        ghostNotifies++;
    }

    function stake(uint256 userIdx, uint256 tokenPick) external {
        address user = users[userIdx % users.length];
        uint256 bal = nft.balanceOf(user);
        if (bal == 0) return;
        // 找一个该用户持有且未质押的 token
        uint256 max = mine.minted();
        uint256 start = tokenPick % (max == 0 ? 1 : max);
        for (uint256 i = 0; i < max; i++) {
            uint256 tokenId = (start + i) % max + 1;
            if (nft.ownerOf(tokenId) == user && vault.stakerOf(tokenId) == address(0)) {
                vm.prank(user);
                vault.stake(tokenId);
                ghostStaked++;
                return;
            }
        }
    }

    function unstake(uint256 userIdx, uint256 tokenPick) external {
        address user = users[userIdx % users.length];
        if (vault.stakeCount(user) == 0) return;
        uint256 max = mine.minted();
        if (max == 0) return;
        uint256 start = tokenPick % max;
        for (uint256 i = 0; i < max; i++) {
            uint256 tokenId = (start + i) % max + 1;
            if (vault.stakerOf(tokenId) == user && block.timestamp >= vault.lockedAt(tokenId) + LOCK) {
                vm.prank(user);
                vault.unstake(tokenId);
                ghostStaked--;
                return;
            }
        }
    }

    function claim(uint256 userIdx) external {
        address user = users[userIdx % users.length];
        vm.prank(user);
        rewards.claim();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + dt % 500 days);
    }
}

contract InvariantTest is Test {
    RewardsHandler h;

    function setUp() public {
        h = new RewardsHandler();
        targetContract(address(h));
    }

    /// @dev 偿付能力：
    ///  1) 严格方向——余额必须永远 >= undistributed（暂存部分一分不能少）
    ///  2) 待领部分允许 floor 尘埃：每人每次分账最多多计 1 wei，上界 = 用户数 × notify 次数。
    ///     claim() 内的余额封顶保证最后领取者不会被这几 wei 卡死。
    function invariant_Solvency() public view {
        Rewards rewards = h.rewards();
        assertGe(address(rewards).balance, rewards.undistributed(), "undistributed not backed");
        uint256 obligations = rewards.undistributed();
        for (uint256 i = 0; i < 4; i++) {
            obligations += rewards.pending(h.users(i));
        }
        uint256 dustBound = 4 * h.ghostNotifies(); // 4 个用户 × 每人每 notify ≤ 1 wei
        assertLe(obligations, address(rewards).balance + dustBound, "rewards insolvent beyond dust");
    }

    /// @dev 权重守恒：Rewards.totalWeight == Vault 实际质押数 == 各用户 stakeCount 之和
    function invariant_TotalWeight() public view {
        assertEq(h.rewards().totalWeight(), h.ghostStaked(), "totalWeight drift");
        uint256 sum;
        for (uint256 i = 0; i < 4; i++) {
            sum += h.vault().stakeCount(h.users(i));
            assertEq(h.rewards().weightOf(h.users(i)), h.vault().stakeCount(h.users(i)), "weight mismatch");
        }
        assertEq(sum, h.ghostStaked(), "stakeCount sum drift");
    }

    /// @dev 供应上限与 NFT 一致性
    function invariant_Supply() public view {
        assertLe(h.mine().minted(), 24, "over mint");
        assertEq(h.mine().minted(), h.nft().totalMinted(), "minted diverged");
    }

    /// @dev Mine 资金守恒：余额 == treasuryAccrued（mint 收入当场分清）
    function invariant_MineBalance() public view {
        assertEq(address(h.mine()).balance, h.mine().treasuryAccrued(), "mine holds stray funds");
    }
}
