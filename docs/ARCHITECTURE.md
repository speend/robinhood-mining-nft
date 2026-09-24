# ARCHITECTURE.md

## 系统总览

```
┌─────────────────────────── 浏览器 ───────────────────────────┐
│  Next.js (web/)                                               │
│  ┌─────────────┐   主线程：UI / wagmi / 链上读取               │
│  │  4 个页面    │   / /fleet /staking /stats                  │
│  └─────────────┘                                             │
│  ┌─────────────┐   Web Worker：WebGPU 挖矿（miner.worker.ts） │
│  │ GPU Miner   │   keccak_miner.wgsl · grind/selftest        │
│  └─────────────┘                                             │
└──────────────┬───────────────────────────────────────────────┘
               │ JSON-RPC (viem/wagmi)
┌──────────────▼───────────────────────────────────────────────┐
│  Robinhood Chain (Testnet 46630 / Mainnet 4663 / Anvil 31337) │
│                                                               │
│  Mine.sol ──mint(nonce)──► 验证 PoW ──► 70% → Rewards.notify  │
│     │                                         30% → Treasury  │
│     └─► CardNFT.mint(user)                                    │
│  Vault.sol ◄─stake/unstake─ 用户（锁仓 365 天，权重 = 卡数）    │
│  Rewards.sol ─ accPerWeight 分配 ─ claim() ─► 用户            │
└───────────────────────────────────────────────────────────────┘
```

## PoW 协议（hardened-v1）

```
challenge = keccak256(abi.encode(chainid, mineAddress, epoch, epochSeed))
PoW hash  = keccak256(abi.encodePacked(challenge, user, nonce))   // 60B，单 block keccak
valid     = uint256(hash) >> (256 - bits) == 0                    // 大端高位前导零
```

- **epoch 轮换**：`epochDuration`（默认 24h）到期后任何人可 `rotate()`；`epochSeed = keccak256(blockhash(n-1), prevrandao, timestamp, salt)`，轮换前不可预知 → 防预计算
- **宽限期**：旧 challenge 在 `gracePeriod`（默认 10min）内仍可 mint；只覆盖上一代
- **重放防护**：`nonceUsed[user][nonce]` + hash 绑定 msg.sender（MEV copy 无效）

## 经济模型（不可变，constructor 锁死）

| 参数 | 值 |
|---|---|
| 总量 | 5000，每 500 张一档（tier 0–9） |
| 价格 | 0.00025 ETH 起，每档 ×2 |
| 难度 | 35 bits 起，每档 +1（末档 44） |
| 分账 | mint 收入 70% → Rewards（按质押权重分），30% → Treasury |
| 锁仓 | stake 后 365 天可 unstake |
| 首个质押者 | 无人质押期的累积分红（undistributed）归其所有 |

## 权限矩阵

| 角色 | 能做什么 | 不能做什么 |
|---|---|---|
| Owner | pause/unpause mint、setTreasury、setBaseURI/freezeBaseURI、一次性接线 | 碰 Rewards 资金、铸 NFT、改经济参数 |
| Treasury | 收 30% | 无任何链上权限 |
| 任何人 | rotate()、flushTreasury() | 资金只流向既定地址 |

## 前端数据流

- 配置：`deployments/<network>.json` →（sync-deployment.mjs）→ `web/src/config/deployment.json`，env `NEXT_PUBLIC_*` 可覆盖
- 读：wagmi publicClient + multicall；challenge 20s 轮询，stats 15s 轮询
- 写：mint / approve / stake / unstake / claim 全部钱包确认；mint 前重读 `currentMintDue()`
- mint 安全链：GPU 找到 nonce → hash.ts 本地复核 → verify.ts 链上复核（challenge 未过期，含宽限期路径）→ 用户手动点 MINT
- 事件：`Minted` / `Staked` / `Unstaked` / `Claimed` / `ChallengeUpdated`（stats 页 getLogs；mainnet 规模化后接 indexer，数据库只做 cache）

## 测试体系

| 层 | 内容 | 规模 |
|---|---|---|
| Foundry 单测 | Game（原 23）+ Edge 边界 + Challenge 威胁模型 + Deploy 回归 | 61 |
| Invariant | 偿付能力 / 权重守恒 / 供应上限 / Mine 资金守恒 | 256 runs × 128k calls |
| 跨实现向量 | Solidity ↔ viem/JS（spike/test-vectors.json） | 4 组 |
| WGSL 静态验证 | fill_state 字节布局 ↔ encodePacked | 3 组 |
| 链上 E2E | scripts/e2e-anvil.mjs 全流程 | 28 项检查 |

## 已知取舍

- NFT 枚举前端遍历 ownerOf（mainnet 前换事件索引/indexer）
- Rewards 精度尘埃：每人每次分账 pending 视图最多 +1 wei，claim 已做余额封顶防锁死
- L2 上 prevrandao 熵质量待 testnet 实测；退化为 blockhash+timestamp 时仍满足防预计算
