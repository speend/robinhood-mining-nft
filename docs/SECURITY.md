# SECURITY.md — hardened-v1 安全审计报告

- 分支：`hardened-v1`
- 工具：Slither 0.11.6（102 detectors，过滤 lib/test/script）、forge fuzz + invariant、`npm audit`
- 审计日期：2026-09-24
- 范围：`contracts/src/{Mine,CardNFT,Vault,Rewards}.sol`、`src/spike/ChallengePoW.sol`、`web/`（依赖层面）

## 结论摘要

| 等级 | 数量 | 状态 |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 3 | 已确认缓解措施 / 设计如此 |
| Informational | 6 | 误报或有意设计 |

历史已修复问题见文末「已修复 Bug」。

---

## Low

### L1. Treasury 收款地址可被 Owner 改向（arbitrary-send-eth）

- Slither：`Mine._payTreasury` / `Mine.flushTreasury` 向 `treasury` 转账。
- 事实：`treasury` 由 `onlyOwner` 的 `setTreasury` 设置。Owner 可以把 **30% Treasury 份额** 导向任意地址。
- 缓解：Owner **无法** 触达 Rewards 池（70% 用户资金）——`Rewards` 合约没有 owner 提取函数，只有质押者 `claim()`。资金流向 70/30 由代码固化，不可配置。
- 主网要求：Treasury 必须使用多签，不得使用 EOA（见 MAINNET_CHECKLIST）。
- 状态：**接受**（协议设计），主网前落实多签。

### L2. `_payTreasury` 调用后写状态（reentrancy-benign）

- Slither：`treasuryAccrued += amount` 在 `treasury.call` 之后写入。
- 缓解：`mint()` 有 `nonReentrant`，外部入口全部带 ReentrancyGuard（mint/stake/unstake/claim）；call 限 50,000 gas 且失败不阻塞铸造，失败部分记入 `treasuryAccrued` 由 `flushTreasury()`（CEI 顺序正确）补发。
- 状态：**已缓解**。

### L3. Epoch 种子在轮换瞬间可被旁观者预知（预计算窗口）

- `_freshSeed` = keccak256(blockhash(n-1), prevrandao, timestamp, salt)。轮换交易进入 mempool 后、打包前，观察者能算出下一 epoch 的 challenge，提前最多一个区块时间开始挖。
- 影响：约 12 秒级的抢先窗口，相对 24h epoch 可忽略；无法跨 epoch 预计算（种子在轮换前不存在）。
- 状态：**接受**。详见 `docs/SPIKE_CHALLENGE.md` 威胁模型。

---

## Informational（Slither 告警复核结论）

| 检测器 | 位置 | 结论 |
|---|---|---|
| divide-before-multiply | `Mine.constructor` 上界检查 | 整数截断只会让检查更严格（算出的 tier 位数 ≤ 真实值），不会放行非法配置。安全。 |
| incorrect-equality | `isValidForChallenge` 的 `hash >> (256-bits) == 0` | 这就是 PoW 判定本身，有意为之。 |
| timestamp | `rotate` / `mint` / `unstake` | 24h epoch、10min 宽限、365d 锁仓，矿工可操纵的时间尺度（秒级）不影响正确性。 |
| return-bomb | `_payTreasury` 50k gas 上限 | 有意的防 griefing 设计。 |
| reentrancy-events | `flushTreasury` 事件在 call 之后 | 状态（`treasuryAccrued = 0`）已在 call 前清零，仅事件顺序问题，无影响。 |
| solc-version / 依赖告警 | `lib/openzeppelin-contracts` | 库文件 pragma 范围告警，已过滤；实际编译锁定 solc 0.8.x（见 foundry.toml）。 |

重入防护复核：`Mine.mint`、`Vault.stake/unstake`、`Rewards.claim` 全部 `nonReentrant`；「mint 回调内抢先质押分自己分红」路径已由 `rewards.notify` 先于 `nft.mint` 的记账顺序封堵，并有专项测试覆盖。

---

## 已修复 Bug（开发期发现）

1. **`Deploy.s.sol` owner 分离必炸**（部署阻断级）：constructor 直接把 NFT/Vault/Rewards 的 owner 设为 `OWNER`，导致 deployer 后续无法执行 `setMinter`/`setMine`/`setVault` 接线。修复：先以 deployer 为 owner 部署接线，最后 `transferOwnership`。
2. **`Rewards.claim()` 尘埃锁死**（资金卡死级）：整除尘埃使最后一个领取者差几 wei 永远无法 `claim`（`amount > balance` revert）。修复：`amount = min(pending, address(this).balance)`。有回归测试。

## 测试覆盖（forge，62 tests / 7 suites 全绿）

- Mint 成功 / 错误 nonce / nonce 重放 / 难度与价格 tier 边界 / maxSupply 5000 / 支付不足
- 70/30 分账、多用户权重分红、首质押者 undistributed 行为
- Stake / 重复 stake / 非 owner stake / claim / 0 rewards claim / `vm.warp` 365 天解锁
- ERC721 callback 重入、mint 回调内质押、重放（跨链 / 跨合约 / 旧 epoch / 过期 challenge / 抢跑复制）
- fuzz + accounting invariant

## 前端 / 依赖

- `npm audit`（registry.npmjs.org）：0 critical；2 high 为 WalletConnect 传递依赖 `ws`，仅构建期/中继客户端使用，无私钥暴露面。前端不接触私钥，所有交易经钱包确认。

## 已知风险（上线前持续关注）

- Testnet Treasury/Owner 暂为同一 EOA；**主网必须改多签**。
- WGSL GPU miner 尚未在真实 GPU 浏览器环境验证（testnet E2E 验收项）。
- Robinhood Chain 出块/预编译行为以 testnet 实测为准。
