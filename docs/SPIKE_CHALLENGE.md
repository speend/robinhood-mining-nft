# SPIKE_CHALLENGE.md — Domain-Separated Challenge 机制验证报告

> 分支：`hardened-v1`　日期：2026-09-24　性质：**Spike（机制验证，非生产代码）**
> 目的：在改动 Mine.sol 之前，用最小合约证明防预计算挑战机制在 EVM 上成立。

## 1. Spike 设计

`contracts/src/spike/ChallengePoW.sol`：

```
challenge = keccak256(abi.encode(chainid, address(this), epoch, epochSeed))
PoW hash  = keccak256(abi.encodePacked(challenge[32B], user[20B], nonce[8B-BE]))   // 60 字节，单 block
```

- **epoch 轮换**：`epochDuration` 到期后任何人可 `rotate()`（无权限、不可被阻止）；种子 = `keccak256(blockhash(n-1), prevrandao, timestamp, salt)` —— 轮换区块确认前不可预知。
- **宽限期**：轮换后旧 challenge 在 `gracePeriod` 内仍被接受（`submit` 返回 `viaGrace=true`），在挖工作不瞬间作废；宽限只覆盖上一代，老老代永久失效。
- **nonce 防重放**：`nonceUsed[user][nonce]` + hash 绑定 `msg.sender`。

## 2. 威胁模型覆盖（13 项测试，全部 PASS）

| 威胁 | 测试 | 结果 |
|---|---|---|
| 前置计算（上线前/epoch 前预挖） | `test_Precomputation_FutureChallengeUnknown`：攻击者用 T 时刻全部公开状态推导 epoch+1 challenge ≠ 真实值 | ✓ |
| 跨链复用 | `test_CrossChain_Replay_Fails`：46630 挖的 nonce 在 chainId=1 的同款合约上 BadNonce | ✓ |
| 跨合约复用 | `test_CrossContract_Replay_Fails`：同链第二实例 BadNonce | ✓ |
| nonce replay | `test_NonceReplay_SameEpoch_Reverts` | ✓ |
| challenge replay | `test_ChallengeReplay_TwoRotations_OldOldRejected`：两次轮换后 ch0 永久失效 | ✓ |
| 旧 epoch nonce | 宽限内接受 / 宽限后拒绝（两个测试） | ✓ |
| MEV copy transaction | `test_MEVCopy_OtherSender_Reverts`：换 sender 后 BadNonce | ✓ |
| 编码一致性 | `testFuzz_HashEncoding`（256 runs） | ✓ |

## 3. 跨实现测试向量（Solidity ↔ JS/viem）

`scripts/gen-test-vectors.mjs`（viem 2.56.8）生成 `contracts/spike/test-vectors.json`，forge test 读取并逐条断言：

| 用例 | 结果 |
|---|---|
| main-case（固定 challenge/user/nonce） | hash 一致 ✓ |
| all-zero | hash 一致 ✓ |
| max-nonce（uint64 上限） | hash 一致 ✓ |
| js-found-valid-8bits（JS 端真搜出的 8bits nonce） | Solidity `isValidForChallenge` 判 true ✓ |

**WGSL 侧**：本环境无 GPU 无法实测；但消息 60B 仍在 keccak 单 block（136B rate）内，填充位与 baseline 相同（b60=0x01，b135=0x80），改动只是消息前缀从 20B 地址变成 52B（challenge+地址）。已实测 baseline WGSL 与 Solidity 逐字节一致（见 PROTOCOL_ANALYSIS §6），同构改动风险低。**前端集成阶段必须用同一组 test-vectors.json 对 WGSL 做一次自检**（grinder 的 selftest 同款思路），通过后才算 WGSL 对齐。

## 4. Spike 结论

机制验证**通过**，可进入 hardened-v1 实现阶段（移植进 Mine.sol + WGSL 升级 + 前端 miner）。

## 5. 遗留决策（等 Owner 确认）

1. epoch 时长：spike 用 1000s；建议生产 24h + 10min 宽限。**待确认**。
2. L2 上 `blockhash(n-1)` 与 `prevrandao` 的实际熵质量需在 Robinhood testnet 实测（Orbit 链 prevrandao 行为与 L1 不同——若返回常数，则种子熵退化为 blockhash+timestamp，仍可防"上线前预计算"，但防不了"轮换后立即知悉"。这对 PoW 公平性已足够：所有矿工同时得知）。
3. `submit` 的宽限路径需要第二次哈希验证，mint gas 略增（可接受）。
