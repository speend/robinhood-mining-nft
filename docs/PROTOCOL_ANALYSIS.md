# PROTOCOL_ANALYSIS.md — Robinhood Chain 挖矿 NFT 协议分析

> 分析对象：`contracts.zip`（导入 commit `626e159`，分支 `baseline-original`）
> 分析日期：2026-09-24
> 分析方式：完整阅读全部源码 + `forge build` + `forge test`（23/23 PASS）+ hash 一致性实测验证

---

## 0. 代码资产清单（实际解压结果）

```
contracts/                        Foundry 项目
├── src/
│   ├── Mine.sol                  PoW 验证 + 阶梯定价 + 70/30 分账 + 触发铸卡
│   ├── CardNFT.sol               ERC-721，仅 Mine 可铸，tokenId 从 1 递增
│   ├── Vault.sol                 质押金库，锁仓 365 天，每张卡权重 1
│   ├── Rewards.sol               分红池（accPerWeight 模式），即时分配、随时领取
│   └── Interfaces.sol            ICardNFT / IRewardsNotify / IRewardsWeight
├── script/Deploy.s.sol           一键部署 + 接线 + 自动校验
├── test/Game.t.sol               23 个测试（全部 PASS）
├── foundry.toml                  solc ^0.8.24，optimizer 200 runs
├── .env.example                  PRIVATE_KEY / RPC_URL / TREASURY / 玩法参数
└── 部署指南.md                    人工部署手册

miner-reference/（原"交接包"）     WebGPU 矿机参考实现
├── keccak_miner.wgsl             已验证的 Keccak-256 挖矿 shader
├── grinder.html                  最小可运行挖矿 Demo 页
├── server.js                     本地测试静态服务（端口 8788）
├── 格式说明.md / 坑清单.md / 测试方法.md / README.md
```

**与任务预期的差异**：预期文件全部存在，无遗漏。WGSL/grinder/server.js 在 `交接包/` 而非 contracts 内。

---

## 1. 合约关系图

```
                ┌──────────────────────────────────────────────┐
                │                  Owner (EOA/多签)             │
                │  pause/unpause · setTreasury · setBaseURI     │
                │  freezeBaseURI · setMinter/setMine/setVault   │
                │  （后三项均只能设置一次）                      │
                └───────┬──────────────┬──────────────┬────────┘
                        │ owns         │ owns         │ owns
        ┌───────────────▼───┐   ┌──────▼───────┐   ┌──▼─────────────┐
        │     CardNFT       │   │   Rewards    │   │     Vault      │
        │  ERC-721          │   │  分红池       │   │  质押/锁仓      │
        │  minter = Mine    │   │  accPerWeight│   │  lockDuration  │
        └───────▲───────────┘   └──▲────────▲──┘   └──┬─────────┬──┘
                │ mint(to)         │notify  │update   │pull NFT │updateWeight
                │                  │{value} │Weight   │         ▼
        ┌───────┴──────────────────┴────────┴─────────┐   Rewards.updateWeight
        │                   Mine                       │◄──────────────
        │  mint(nonce) payable                         │  (Vault 回调)
        │  70% → Rewards.notify / 30% → Treasury       │
        └──────────────────▲───────────────────────────┘
                           │ payable mint
                        用户 (EOA)
```

依赖方向：`Mine → CardNFT, Rewards`；`Vault → CardNFT, Rewards`；`CardNFT → Mine`（minter）；`Rewards → Mine, Vault`（访问控制）。无循环依赖，接线顺序由 Deploy.s.sol 保证。

---

## 2. 部署顺序

`script/Deploy.s.sol` 已实现，顺序为硬性依赖：

1. `CardNFT(name, symbol, baseURI, owner)`
2. `Rewards(owner)`
3. `Vault(nft, rewards, lockDuration=365 days, owner)`
4. `Mine(nft, rewards, treasury, owner, baseBits=35, bitsPerTier=1, tierSize=500, startPrice=0.00025 ETH, maxMints=5000)`
5. 接线（均只能设一次，设错只能重部署）：
   - `nft.setMinter(mine)`
   - `rewards.setMine(mine)`
   - `rewards.setVault(vault)`
6. 若 `owner != deployer`：4 个合约 `transferOwnership(owner)`
7. `_verify()` 读回全部接线与初始状态，任何不符直接 revert

生产参数（`.env.example` 定稿）：`BASE_BITS=35, BITS_PER_TIER=1, TIER_SIZE=500, START_PRICE_WEI=250000000000000, MAX_MINTS=5000, LOCK_DURATION=31536000`。

---

## 3. Owner 权限

| 合约 | 方法 | 能力 | 限制 |
|---|---|---|---|
| Mine | `pause()` / `unpause()` | 暂停/恢复 mint（不影响 stake/unstake/claim） | 仅 owner |
| Mine | `setTreasury(addr)` | 改未来 mint 30% 收款地址 | 仅 owner；已 accrued 的钱仍只会打给 treasury |
| CardNFT | `setMinter(addr)` | 设唯一铸造者 | 仅 owner，**只能设一次** |
| CardNFT | `setBaseURI(uri)` | 改元数据 | 仅 owner，freeze 后失效 |
| CardNFT | `freezeBaseURI()` | 永久冻结元数据 | 仅 owner，不可逆 |
| Rewards | `setMine(addr)` / `setVault(addr)` | 接线 | 仅 owner，**各只能设一次** |
| Vault | 无 owner 方法 | — | — |

**关键结论：Owner 无法提取 Rewards 池中的用户资金，无法铸造 NFT，无法改经济参数。** 满足"Owner 不得能够随意提取 Rewards 用户资金"的要求。

## 4. Treasury 权限

Treasury 是纯收款地址，无任何合约内权限。Mine 每笔 mint 当场用 `call{value, gas:50_000}` 打 30%；若 treasury 是拒收合约，转入 `treasuryAccrued` 挂账，之后任何人可调用 `flushTreasury()` 触发补打（钱只会去 treasury，调用者无利可图）。Owner 可通过 `setTreasury` 改地址，但已打出的钱不可追回。

## 5. Mint 流程（`Mine.mint(uint64 nonce)`）

1. `nonReentrant` + `whenNotPaused`
2. `minted >= maxMints` → `SoldOut`
3. `nonceUsed[msg.sender][nonce]` → `NonceAlreadyUsed`（nonce 按用户隔离）
4. `isValidNonce(msg.sender, nonce, currentBits())` → `BadNonce`
5. 标记 nonce 已用
6. `msg.value != currentMintDue()` → `WrongPayment`（必须精确支付）
7. 70% → `rewards.notify{value}(toPool)`（**先记账**）
8. `nft.mint(msg.sender)`（`_safeMint`，此处有 onERC721Received 回调窗口）
9. 30% → `_payTreasury`（gas 限 50k，失败挂账不阻塞）
10. `emit Minted(user, tokenId, nonce, tier, price)`

步骤 7→8 的顺序是关键安全设计：先分账后铸卡，防止接收方在 ERC721 回调里抢质押分走自己这笔的分红（`test_Reentrancy_StakeInMintCallback_CannotCaptureOwnDividend` 已覆盖）。

## 6. PoW 验证流程（baseline 现状）

```solidity
hashFor(user, nonce)   = keccak256(abi.encodePacked(user /*20B*/, nonce /*uint64 BE 8B*/))  // 28 字节
isValidNonce(user, nonce, bits) = uint256(hashFor(...)) >> (256 - bits) == 0   // 大端，高 bits 位全 0
currentBits() = baseBits + (minted / tierSize) * bitsPerTier   // 35 → 44 bits
```

- hash 输入**只有 `wallet + nonce`**，无 chainId、无合约地址、无 challenge/epoch。
- WGSL shader（`keccak_miner.wgsl`）与 Solidity 的编码**已实测一致**：消息 = 地址 20B + nonce 大端 8B，keccak 填充 0x01/0x80，lane 小端装载、前后 bswap32。
- **一致性实测（2026-09-24，本机 cast）**：交接包记录 8 bits 下地址 `0xf39F...92266` 挖出 nonce `230690464`（`0x0dc00ea0`）。用 `cast keccak 0xf39f...9266_000000000dc00ea0` 复算 = `0x00c44eb8…cfd5d2`，与交接包记录的 GPU 结果 `00c44eb8...d5d2` **逐字节一致**，高 8 位为 0 满足 8 bits 难度。证明 WGSL keccak、消息编码、Solidity 校验三方对齐。✓

## 7. NFT Mint 流程

`CardNFT.mint(to)` 仅 `minter`（=Mine）可调用，`tokenId = ++totalMinted`（从 1 开始），`_safeMint`。总量上限 5000 **只在 Mine 层**强制执行（CardNFT 本身无 cap，但 minter 只能设一次，无绕过路径）。元数据 = `baseURI + tokenId`，baseURI 部署时可为空，后续 owner 设置、可 freeze。

## 8. Stake 流程（`Vault`）

- `stake(tokenId)`：`nonReentrant`；校验未质押 + `nft.ownerOf == msg.sender`；记录 `stakerOf/lockedAt`；`transferFrom` 拉入 Vault（**需用户预先 approve**）；`stakeCount+1` → `rewards.updateWeight(user, newCount)`。
- `unstake(tokenId)`：仅质押者本人；`block.timestamp >= lockedAt + lockDuration`（365 天，生产参数，测试用 `vm.warp` 覆盖）；先清状态、更新权重，再转回 NFT。
- 权重 = 质押卡数（每张权重 1），无档位加成。

## 9. Rewards 流程（`Rewards`，accPerWeight 模式）

- `notify(amount)`（仅 Mine，携带等额 value）：
  - `totalWeight == 0`（无人质押）→ 计入 `undistributed` 暂存
  - 否则 `accPerWeight += (amount + undistributed) * 1e18 / totalWeight`，清空暂存
- `updateWeight(user, newWeight)`（仅 Vault）：先 `_settle` 结算旧权重收益 → 改权重 → 重算 debt；**当从 0 出现第一个质押者时，`undistributed` 一次性全部分给他**（设计意图：重奖最早质押者）。
- `claim()`：`nonReentrant`；`_settle` 后清零并 `call{value}` 转账；0 余额也可调用（不 revert）。
- `pending(user) = claimable + weight*accPerWeight/1e18 - debt`。

## 10. 收入流向

```
用户支付 mint 价 P（tier t 时 P = 0.00025 ETH × 2^t，t = minted/500，t∈[0,9]）
   ├── 70% (0.7P) → Rewards 合约余额
   │       ├── 有人质押 → 当场按权重计入 accPerWeight（staker 可 claim）
   │       └── 无人质押 → undistributed 暂存 → 归第一个质押者
   └── 30% (0.3P) → Treasury（EOA/多签；拒收则 treasuryAccrued 挂账）
```

全部卖完总收入 ≈ 0.00025 × 500 × (2^10 − 1) ≈ **127.9 ETH**；Rewards 池 ≈ 89.5 ETH，Treasury ≈ 38.4 ETH。
**Owner/项目方无法触碰 Rewards 合约余额**，唯一出口是 staker 的 `claim()`。

## 11. 关键事件

| 合约 | Event | 用途 |
|---|---|---|
| Mine | `Minted(user, tokenId, nonce, tier, price)` | indexer/前端核心事件 |
| Mine | `TreasurySet` / `TreasuryAccrued` / `TreasuryFlushed` | 财务审计 |
| CardNFT | `MinterSet` + ERC721 标准 `Transfer` | NFT 追踪 |
| Vault | `Staked(user, tokenId)` / `Unstaked(user, tokenId)` | 质押看板 |
| Rewards | `Notified(amount)` / `WeightUpdated(user, w)` / `Claimed(user, amt)` / `MineSet` / `VaultSet` | 分红流水 |

baseline 无 challenge 相关事件（hardened-v1 将新增 `ChallengeUpdated`）。

## 12. 所有 External/Public 方法

**Mine**（Ownable/Pausable/ReentrancyGuard）
- `mint(uint64 nonce)` payable — 核心入口
- `pause()` / `unpause()` — onlyOwner
- `setTreasury(address)` — onlyOwner
- `flushTreasury()` — 任何人
- view：`currentTier()` `currentBits()` `currentMintDue()` `hashFor(user,nonce)` `isValidNonce(user,nonce,bits)` `nonceUsed(user,nonce)` `minted()` `treasury()` `treasuryAccrued()` + 常量/immutable getter（`BPS` `POOL_BPS` `nft` `rewards` `baseBits` `bitsPerTier` `tierSize` `startPrice` `maxMints`）

**CardNFT**（ERC721/Ownable）
- `mint(address to)` returns tokenId — 仅 minter
- `setMinter(address)` — onlyOwner，一次
- `setBaseURI(string)` / `freezeBaseURI()` — onlyOwner
- view：`minter()` `baseURI()` `baseURIFrozen()` `totalMinted()` + ERC721 全套

**Vault**（Ownable/ReentrancyGuard）
- `stake(uint256 tokenId)` / `unstake(uint256 tokenId)`
- view：`weightOf(user)` `unlockTime(tokenId)` `stakerOf` `lockedAt` `stakeCount` `nft` `rewards` `lockDuration`

**Rewards**（Ownable/ReentrancyGuard）
- `notify(uint256 amount)` payable — 仅 Mine
- `updateWeight(address user, uint256 newWeight)` — 仅 Vault
- `claim()`
- `setMine` / `setVault` — onlyOwner，各一次
- view：`pending(user)` `accPerWeight` `totalWeight` `undistributed` `weightOf` `debt` `claimable` `mine` `vault`

**Deploy.s.sol**：`run()`，env 驱动，含 `_verify` 自动校验。

## 13. 潜在攻击面（baseline）

| # | 严重度 | 问题 | 说明 |
|---|---|---|---|
| A1 | **Critical** | PoW 可预计算 | hash 只含 `wallet+nonce`。攻击者上线前可用 GPU 为自有地址预算各难度 nonce；且难度单调上升 → 按最高 tier（44 bits）预挖的 nonce 在低 tier 同样有效，可瞬间扫空全部 5000 张 |
| A2 | **Critical** | 跨链/跨合约复用 | 无 chainId、无合约地址绑定。同一 nonce 在任何部署了该合约副本的链上都有效 |
| A3 | Medium | "第一个质押者"虹吸 | 设计上无人质押期收入全归首位质押者（`undistributed`）。若早期长期无人质押，早期矿工的 70% 贡献全归后来者一人——属已定经济设计，但需向用户明示 |
| A4 | Medium | tier 跳变使交易 revert | 挖到 nonce 后若他人先 mint 跨过 tier 边界，难度+1/价格×2，交易以 `BadNonce`/`WrongPayment` 失败，浪费 gas。前端必须提交前重读 |
| A5 | Medium | Rewards 精度损耗 | 除法截断的 dust 永久滞留合约（每次 notify 最多损失 totalWeight−1 wei 量级）。无数值风险，属已知取舍 |
| A6 | Low | MEV copy transaction | nonce 与 msg.sender 绑定，他人复制 calldata 无效；但区块构建者可观察到"某地址已解出"并抢先自己挖同 tier（竞争关系，非资金风险） |
| A7 | Low | treasury 拒收 DoS | 已被 `treasuryAccrued` + `flushTreasury` 缓解，mint 不阻塞 |
| A8 | Low | `_safeMint` 回调抢质押 | 已被"先 notify 后 mint"顺序修复并有回归测试 |
| A9 | Info | nonce 空间 | uint64/人，2^64 无耗尽可能；grinder 每次从 0 开始，前端需持久化已用 nonce |
| A10 | Info | CardNFT 无独立 supply cap | cap 由 Mine 单点强制，minter 一次设定，无绕过路径 |

## 14. Mainnet 上线风险

1. **A1/A2 不修不能上主网** —— 这是 hardened-v1 的核心动因。
2. 经济参数全部 immutable，部署即定稿：难度曲线（35→44 bits）需在测试网实测 GPU 端可解（44 bits ≈ 1.76e13 次哈希，RTX 4060 @ 800 MH/s 约 6 小时/张，预期内但需实测确认末档可挖）。
3. baseURI 指向的 IPFS 资产需在 freeze 前最终确认；freeze 不可逆。
4. Treasury/Owner 建议多签；私钥管理按部署指南执行。
5. Robinhood Chain 为 Arbitrum Orbit L2：需确认 `block.timestamp` 行为、L1 重组对挑战生命周期的影响（hardened-v1 epoch 设计时考虑）。
6. 网络参数已从官方文档核实（2026-09-24，[docs.robinhood.com](https://docs.robinhood.com/chain/add-network-to-wallet/)）：
   - Testnet：Chain ID **46630**，RPC `https://rpc.testnet.chain.robinhood.com`，Explorer `explorer.testnet.chain.robinhood.com`，符号 ETH
   - Mainnet：Chain ID **4663**，RPC `https://rpc.mainnet.chain.robinhood.com/`，Explorer `robinhoodchain.blockscout.com`

---

# 附 A：baseline-original 修复清单

现状：`forge build` 通过（仅 2 条 lint 警告：事件在外部调用后发出——实际均有 nonReentrant/正确排序保护，保留说明即可），`forge test` **23/23 全部 PASS**，无编译错误、无失败测试。原始协议**可以完整运行**。

因此 baseline 不做任何逻辑修改，仅补齐工程缺口：

1. **测试补齐**（不改合约）：
   - fuzz：mint 支付金额 fuzz、nonce fuzz、多用户权重分红 fuzz
   - invariant：Rewards 余额 ≥ Σclaimable+Σ未结算；totalWeight = ΣstakeCount；minted ≤ maxMints；Mine 余额守恒（= treasuryAccrued）
   - 缺失用例：claim 0 余额、claim 重入、unstake 边界（恰好 365 天）、tier 边界 mint（第 500/5000 张）、5000 supply 边界、事件发射校验
2. **ABI 导出**：`forge build` 后导出 4 个合约 ABI 到 `deployments/abi/`（前端消费）
3. **`.env.example`**：保留部署变量，追加前端 `NEXT_PUBLIC_*` 段
4. **`deployments/` 目录结构**与部署记录 JSON 模板
5. **lint 警告处理**：为两处 event-after-call 加注释说明安全性（不重排代码）
6. README 更新为 monorepo 结构

# 附 B：hardened-v1 修改方案（待评审后实施）

## B1. Domain-Separated Challenge（核心）

将 PoW 消息从 `keccak256(user, nonce)` 改为：

```
challenge = keccak256(abi.encode(
    block.chainid,          // 防跨链复用（A2）
    address(this),          // 防跨合约复用（A2）
    epoch,                  // 当前 epoch 序号
    epochSeed               // epoch 开启时的不可预测种子
))                          // ← 部署后、每个 epoch 轮换，链上公开

hashFor(user, nonce) = keccak256(abi.encodePacked(challenge /*32B*/, user /*20B*/, nonce /*8B*/))
```

epoch 轮换设计（平衡"防预计算"与"不作废在挖工作"）：
- **Epoch 生命周期**：固定时长（如 ~24h 或 N 个区块，测试网可调），到期后任何人可触发轮换，`epochSeed = keccak256(上一 epoch seed, blockhash(轮换块−1), …)` —— 种子在 epoch 开启前不可预测，杜绝预计算（A1）
- **宽限期**：上一个 epoch 的 challenge 在轮换后仍接受一个短窗口（grace period，如 10 分钟），正在挖的用户不会瞬间全部作废；窗口外旧 nonce 拒绝（`ExpiredChallenge`）
- mint 时绑定 `(epoch, nonce)` 防 nonce replay；同 epoch 内 nonce 不可复用
- Threat model 覆盖：前置计算（种子不可预测 ✓）、跨链（chainid ✓）、跨合约（address(this) ✓）、nonce replay（nonceUsed ✓）、challenge replay（epoch 单调递增，旧 challenge 过期 ✓）、旧 epoch nonce（宽限期后拒绝 ✓）、MEV copy（msg.sender 绑定 ✓）

## B2. WGSL / 前端 miner 同步

- `keccak_miner.wgsl` 升级为 60 字节消息（challenge 32B + addr 20B + nonce 8B，单 block keccak 仍可一次吸收，136B rate 内）
- challenge 作为 uniform 参数传入；epoch 轮换/grace 到期时 worker 自动切换
- 集成进 `/src/miner/`（worker 隔离，主线程零阻塞）
- **Test Vector**：Solidity `hashFor` ↔ TS(viem keccak256) ↔ WGSL 三方对同一 (challenge,user,nonce) 输出一致，CI 固定向量回归

## B3. 其他加固

- 事件补全：`ChallengeUpdated(epoch, challenge, validUntil)`
- 测试增补：PoW replay / cross-chain（`vm.chainId`）/ cross-contract / expired challenge / old epoch nonce / front-running 场景
- Slither + invariant + gas report + SECURITY.md
- 经济参数一字不动（5000/500/35+1/×2/70-30/365d）

## B4. 不改动的部分

Vault 365 天锁仓、Rewards 分配逻辑（含首质押者规则——如需调整属经济决策，单独报批）、CardNFT 铸造权限模型、Deploy 接线顺序。
