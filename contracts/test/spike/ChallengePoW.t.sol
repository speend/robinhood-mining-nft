// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChallengePoW} from "../../src/spike/ChallengePoW.sol";

/// @title ChallengePoW 威胁模型测试（Spike）
/// 覆盖：预计算 / 跨链复用 / 跨合约复用 / nonce replay / challenge replay /
///       旧 epoch nonce / 宽限期 / MEV copy transaction
contract ChallengePoWTest is Test {
    uint256 constant EPOCH = 1000; // spike 参数：1000 秒一轮换
    uint256 constant GRACE = 100; // 宽限 100 秒
    uint256 constant BITS = 6; // 低难度便于测试

    ChallengePoW pow_;
    address alice = address(0xA1);
    address bob = address(0xB0B);

    function setUp() public {
        vm.chainId(46630); // Robinhood testnet
        pow_ = new ChallengePoW(EPOCH, GRACE);
    }

    function _findNonceFor(bytes32 challenge, address user) internal view returns (uint64) {
        for (uint64 n = 0; n < 1_000_000; n++) {
            if (pow_.isValidForChallenge(challenge, user, n, BITS)) return n;
        }
        revert("nonce not found");
    }

    // ---------- 正常路径 ----------

    function test_Submit_ValidNonce() public {
        uint64 n = _findNonceFor(pow_.currentChallenge(), alice);
        vm.prank(alice);
        bool viaGrace = pow_.submit(n, BITS);
        assertFalse(viaGrace);
        assertTrue(pow_.nonceUsed(alice, n));
    }

    function test_Submit_BadNonce_Reverts() public {
        uint64 bad = 0;
        while (pow_.isValidForChallenge(pow_.currentChallenge(), alice, bad, BITS)) bad++;
        vm.prank(alice);
        vm.expectRevert(ChallengePoW.BadNonce.selector);
        pow_.submit(bad, BITS);
    }

    // ---------- T1: nonce replay ----------

    function test_NonceReplay_SameEpoch_Reverts() public {
        uint64 n = _findNonceFor(pow_.currentChallenge(), alice);
        vm.prank(alice);
        pow_.submit(n, BITS);
        vm.prank(alice);
        vm.expectRevert(ChallengePoW.NonceAlreadyUsed.selector);
        pow_.submit(n, BITS);
    }

    // ---------- T2: MEV copy transaction ----------

    function test_MEVCopy_OtherSender_Reverts() public {
        // 攻击者在 mempool 看到 alice 的 nonce，复制 calldata 换成自己发送
        uint64 n = _findNonceFor(pow_.currentChallenge(), alice);
        vm.prank(bob);
        vm.expectRevert(ChallengePoW.BadNonce.selector); // hash 绑定 msg.sender，复制无效
        pow_.submit(n, BITS);
    }

    // ---------- T3: 跨合约复用 ----------

    function test_CrossContract_Replay_Fails() public {
        ChallengePoW other = new ChallengePoW(EPOCH, GRACE); // 同链、同参数、不同地址
        uint64 n = _findNonceFor(pow_.currentChallenge(), alice);
        // 该 nonce 对另一个实例的 challenge 无效（address(this) 参与 challenge 派生）
        assertFalse(pow_.isValidForChallenge(other.currentChallenge(), alice, n, BITS));
        vm.prank(alice);
        vm.expectRevert(ChallengePoW.BadNonce.selector);
        other.submit(n, BITS);
    }

    // ---------- T4: 跨链复用 ----------

    function test_CrossChain_Replay_Fails() public {
        // 在 46630 上为 pow_ 挖的 nonce
        uint64 n = _findNonceFor(pow_.currentChallenge(), alice);
        // 同一套代码部署到另一条链（chainId 不同 → challenge 不同）
        vm.chainId(1);
        ChallengePoW mainnetCopy = new ChallengePoW(EPOCH, GRACE);
        assertFalse(pow_.isValidForChallenge(mainnetCopy.currentChallenge(), alice, n, BITS));
        vm.prank(alice);
        vm.expectRevert(ChallengePoW.BadNonce.selector);
        mainnetCopy.submit(n, BITS);
    }

    // ---------- T5: 前置计算（预挖） ----------

    function test_Precomputation_FutureChallengeUnknown() public {
        // 攻击者在 T 时刻掌握全部公开状态，尝试预算 epoch 1 的 challenge
        bytes32 attackerGuess = keccak256(abi.encode(block.chainid, address(pow_), 1, pow_.epochSeed()));
        // 真实轮换：种子来自未来区块的 blockhash，T 时刻不可知
        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        pow_.rotate();
        assertTrue(pow_.currentChallenge() != attackerGuess, "epoch+1 challenge must be unpredictable");
        assertEq(pow_.epoch(), 1);
    }

    // ---------- T6: 旧 epoch nonce + 宽限期 ----------

    function test_OldEpochNonce_WithinGrace_Accepted() public {
        bytes32 ch0 = pow_.currentChallenge();
        uint64 n = _findNonceFor(ch0, alice);

        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        pow_.rotate();

        // 宽限期内：旧 challenge 的 nonce 仍可提交（viaGrace）
        vm.prank(alice);
        bool viaGrace = pow_.submit(n, BITS);
        assertTrue(viaGrace);
    }

    function test_OldEpochNonce_AfterGrace_Reverts() public {
        bytes32 ch0 = pow_.currentChallenge();
        uint64 n = _findNonceFor(ch0, alice);

        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        pow_.rotate();

        // 宽限期过后：旧 nonce 作废
        vm.warp(block.timestamp + GRACE + 1);
        vm.prank(alice);
        vm.expectRevert(ChallengePoW.BadNonce.selector);
        pow_.submit(n, BITS);
    }

    function test_Rotation_BeforeMaturity_Reverts() public {
        vm.expectRevert(ChallengePoW.EpochNotMature.selector);
        pow_.rotate();
    }

    function test_NewEpoch_NewChallenge_Required() public {
        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        pow_.rotate();
        // 新 epoch 的 nonce 正常可用
        uint64 n = _findNonceFor(pow_.currentChallenge(), bob);
        vm.prank(bob);
        pow_.submit(n, BITS);
    }

    // ---------- T7: challenge replay（已用过的旧 challenge 不可复活） ----------

    function test_ChallengeReplay_TwoRotations_OldOldRejected() public {
        bytes32 ch0 = pow_.currentChallenge();
        uint64 n = _findNonceFor(ch0, alice);

        // 第一次轮换：ch0 变 previous（宽限内可用——已在上面验证）
        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        pow_.rotate();
        // 第二次轮换：ch0 彻底失效，宽限只覆盖上一代
        vm.warp(block.timestamp + EPOCH);
        vm.roll(block.number + 100);
        pow_.rotate();

        vm.prank(alice);
        vm.expectRevert(ChallengePoW.BadNonce.selector);
        pow_.submit(n, BITS);
    }

    // ---------- 编码一致性 fuzz ----------

    /// @dev 钉死消息编码：hashFor == keccak256(challenge ‖ user ‖ nonce-BE)
    function testFuzz_HashEncoding(bytes32 ch, address user, uint64 nonce, uint8 bits) public {
        vm.assume(bits > 0 && bits <= 64);
        bytes32 expected = keccak256(abi.encodePacked(ch, user, nonce));
        assertEq(pow_.hashFor(ch, user, nonce), expected);
        bool valid = uint256(expected) >> (256 - bits) == 0;
        assertEq(pow_.isValidForChallenge(ch, user, nonce, bits), valid);
    }
}
