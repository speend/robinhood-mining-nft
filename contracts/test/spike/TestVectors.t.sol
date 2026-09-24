// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChallengePoW} from "../../src/spike/ChallengePoW.sol";

/// @title 跨实现测试向量：spike/test-vectors.json 由 scripts/gen-test-vectors.mjs (viem) 生成
/// @dev 证明 Solidity 的 keccak256(abi.encodePacked(challenge, user, nonce)) 与 JS/viem 逐字节一致。
///      WGSL 端将在前端集成阶段用同一组向量验证（grinder 自检测试同款思路）。
contract TestVectorsTest is Test {
    ChallengePoW pow_;

    function setUp() public {
        pow_ = new ChallengePoW(1000, 100);
    }

    function test_Vectors_MatchViem() public {
        string memory json = vm.readFile("spike/test-vectors.json");
        for (uint256 i = 0; i < 4; i++) {
            string memory base = string.concat(".vectors[", vm.toString(i), "]");
            bytes32 challenge = vm.parseJsonBytes32(json, string.concat(base, ".challenge"));
            address user = vm.parseJsonAddress(json, string.concat(base, ".user"));
            uint64 nonce = uint64(vm.parseJsonUint(json, string.concat(base, ".nonce")));
            bytes32 expectedHash = vm.parseJsonBytes32(json, string.concat(base, ".hash"));
            bool validAt8 = vm.parseJsonBool(json, string.concat(base, ".validAt8"));
            bool validAt16 = vm.parseJsonBool(json, string.concat(base, ".validAt16"));

            assertEq(pow_.hashFor(challenge, user, nonce), expectedHash, "hash mismatch vs viem");
            assertEq(pow_.isValidForChallenge(challenge, user, nonce, 8), validAt8, "validity@8 mismatch");
            assertEq(pow_.isValidForChallenge(challenge, user, nonce, 16), validAt16, "validity@16 mismatch");
        }
    }

    /// @dev 正向用例单独断言：JS 挖到的 8 bits nonce，Solidity 必须认
    function test_JsFoundNonce_AcceptedBySolidity() public {
        string memory json = vm.readFile("spike/test-vectors.json");
        bytes32 challenge = vm.parseJsonBytes32(json, ".vectors[3].challenge");
        address user = vm.parseJsonAddress(json, ".vectors[3].user");
        uint64 nonce = uint64(vm.parseJsonUint(json, ".vectors[3].nonce"));
        assertTrue(vm.parseJsonBool(json, ".vectors[3].validAt8"), "vector file broken");
        assertTrue(pow_.isValidForChallenge(challenge, user, nonce, 8), "solidity rejected js-found nonce");
    }
}
