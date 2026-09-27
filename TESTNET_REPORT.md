# TESTNET_REPORT.md — Robinhood Chain Testnet 验收报告

- 日期：2026-09-27
- 分支：`hardened-v1`
- 基准 commit：`cbfc1b1d633a1d92e50f283ba46f322c61d71215`
  （注：部署后有未提交改动——`foundry.toml` 编译参数锁定、新增脚本与文档；部署用的字节码与最终工作区一致：solc 0.8.36 + evm cancun）
- 编译器：**solc 0.8.36 / evm_version cancun**（双锁定，原因见「修复的 Bug」）

---

## 1. 部署信息（最终版，第三次部署）

前两次部署因编译目标问题主动废弃（见第 5 节），链上无资金、无状态损失。

| 合约 | 地址 | 部署 Tx |
|---|---|---|
| CardNFT | `0xd90a29d4af4dc0395c5ff3059406d0c92da3ea62` | `0x83e08e8b4c91d9f72eda3a3e9c8b0ff699d27a21f107fa4e39527e0e2d85aaac` |
| Rewards | `0xcffa10acab59840b062ccfb6deb58af2dc052dd0` | `0x911b67090c34567892baa55cd11fe4e48e9328eebcbb757ac005b95603b4f750` |
| Vault | `0x51988fedd4ee1a5aa51995f5d0f11fcd6979683e` | `0xe82db6f9da054c0915782a421a2f0a77bcc1b923213168bf17db682f4f88bf7b` |
| Mine | `0xf6d8abc92587ddaf800b34ee89c0b19b825e906a` | `0x386c30440950fbcc2b06121f4bc8f86deddd2726216b7cc0714ba963ee6e84d5` |

- 网络：Robinhood Chain Testnet，chainId 46630（实测）
- 部署区块：见 `deployments/robinhood-testnet.json`（blockNumber 字段）
- Deployer / Owner / Treasury：`0x37db61aF355bA0612326d3a93C509f2b7c2D7C30`（**testnet 专用 EOA；主网必须改多签**）
- 部署参数（链上回读核实）：baseBits=35、tierSize=500、bitsPerTier=1、startPrice=0.00025 ETH、maxMints=5000、lock=365 天、epoch=24h、grace=10min
- Explorer 首页：https://explorer.testnet.chain.robinhood.com/address/0xf6d8abc92587ddaf800b34ee89c0b19b825e906a

## 2. Blockscout 源码验证

4/4 全部 `Pass - Verified`（`forge verify-contract --verifier blockscout --watch`）：

- https://explorer.testnet.chain.robinhood.com/address/0xd90a29d4af4dc0395c5ff3059406d0c92da3ea62
- https://explorer.testnet.chain.robinhood.com/address/0xcffa10acab59840b062ccfb6deb58af2dc052dd0
- https://explorer.testnet.chain.robinhood.com/address/0x51988fedd4ee1a5aa51995f5d0f11fcd6979683e
- https://explorer.testnet.chain.robinhood.com/address/0xf6d8abc92587ddaf800b34ee89c0b19b825e906a

## 3. 测试结果

| 项目 | 结果 |
|---|---|
| `forge test`（7 suites：Game / Challenge / Edge / DeployScript / TestVectors / ChallengePoW / Invariant） | **62/62 通过**（solc 0.8.36 + cancun 最终配置下复跑） |
| Anvil 全链路 E2E（最终字节码重跑）：挖矿→mint→stake→分红→claim→epoch 轮换→宽限期→过期拒绝→365 天锁仓 | **28/28 通过** |
| Testnet 部署后链上回读（chainId / minted=0 / 35bits / 0.00025 ETH / owner / treasury / minter / mine / vault 接线） | **11/11 通过**（`scripts/verify-testnet-readback.mjs`） |
| GPU↔JS↔Solidity 三方一致性（真实 testnet challenge，bits=8 模拟）：GPU 出 nonce 247464676 → viem 重算一致 → 链上 `isValidForChallenge` 接受；同 nonce 在 35 bits 下被链上拒绝 | **3/3 通过** |
| 前端构建（TS strict）+ 4 页面生产模式冒烟 | 通过（200×4） |
| 前端真浏览器逐页验证（headless Chrome）：无 pageerror；首页显示 Minted 0/5,000、Tier 0、0.00025 ETH、35 bits；/stats 全量链上数据加载 | **通过**（修复 bug 4/5/6 后复验） |
| Slither 0.11.6（过滤依赖） | 0 Critical / 0 High / 0 Medium，详见 `docs/SECURITY.md` |
| npm audit | 0 critical（2 high 为 WalletConnect 传递依赖 `ws`，无暴露面） |

## 4. Gas 与挖矿性能

- 部署总 gas：约 5.77M（≈ 0.000115 ETH @ 0.01 gwei）
- 运行期 gas（forge gas report 均值）：mint ~142k，stake ~143k，claim ~41k，rotate ~87k，flushTreasury ~64k
- GPU 实测算力：**~110 MH/s**（AMD RDNA-2，WebGPU，keccak 自检通过）
- 35 bits 期望找到时间：2³⁵ / 110MH/s ≈ **312 秒（约 5 分钟）**，实际服从几何分布

## 5. 发现并修复的 Bug（本阶段）

1. **foundry 默认 `evm_version=osaka`** → Robinhood Chain（Arbitrum 系）Blockscout 完全不认，验证必失败；且字节码与 cancun 有实质差异（144 字节），存在潜在 opcode 兼容风险。修复：`foundry.toml` 固定 `cancun`，废弃第一次部署并重部署。
2. **solc 0.8.37 超出 Blockscout 支持列表**（实测验证配置接口最高 v0.8.36）→ 修复：固定 `solc_version = 0.8.36`，第三次部署后 4/4 验证一次通过。
3. `contracts/.env` 的 `NFT_NAME=Mine Card` 未加引号导致 `source .env` 报错 → 已修。
4. **前端 `contracts.ts` 用 `const env = process.env` 别名**——Next.js 只内联字面 `process.env.FOO`，别名导致浏览器运行时 `process is not defined` 整站崩溃（Application error）。→ 改为逐一字面引用。教训：curl 200 冒烟发现不了水合期崩溃，必须真浏览器验证。
5. **`web/package.json` 的 `prebuild`/`predev` 钩子无参调用 sync 脚本**，每次 build 把网络配置重置回 anvil（曾导致 testnet 构建实际打包 anvil 地址）。→ sync 脚本新增 `web/.deployment` 标记文件（已 gitignore），构建自动读 `robinhood-testnet`。
6. **`chains.ts` 未声明 multicall3 合约地址**——自定义链缺省导致 viem `multicall` 客户端报错，页面链上数据全为 "—"。已实测标准地址 `0xca11…ca11` 在 Robinhood testnet 存在（3808 bytes），补声明后 4 页数据全部实测加载成功（无头浏览器逐页验证，0 pageerror）。
7. （开发期已修，见 SECURITY.md）Deploy 脚本 owner 分离必炸；Rewards.claim 尘埃锁死。

## 6. 已知风险与未完成项

- **真实 35-bit 挖矿→mint 全流程未在 testnet 执行到底**（GPU 长跑被主动叫停，按设计该动作留给真实用户）。已验证：GPU 算力与 WGSL 正确性（自检 + bits=8 三方一致性），铸造/质押/分红/领取全流程在 anvil 上以同字节码 28 项通过。**剩余风险集中在 wagmi 钱包 UI 交互路径（Connect/切链/签名弹窗）未经人工实测。**
- testnet RPC 对 forge/cast 的 TLS 偶发握手失败（重试可解）；前端 viem 与 cast 读链正常。
- Owner/Treasury 为 testnet 同一 EOA——testnet 可接受，主网阻断项。
- NFT baseURI 为空（placeholder 阶段，待最终美术审核）。

## 7. Mainnet Blockers（全部清除前不得部署主网）

1. 真实用户在 testnet 前端完成至少一次完整闭环（GPU 挖矿→mint→stake→claim）
2. Owner / Treasury 改多签
3. 最终 NFT 图片与 metadata 经 Owner 审核，baseURI 上线后 freezeBaseURI
4. 主网参数以当时官方文档重新核实（当前预期 chainId 4663）
5. 完整走 `docs/MAINNET_CHECKLIST.md`（含 dry-run 审批）

## 8. 结论

**READY FOR OWNER REVIEW**

测试网目标已达成至可评审状态：合约部署、源码验证、协议参数、三方哈希一致性、全链路逻辑（anvil 同字节码）全部通过。唯一保留项是真实用户的页面端挖矿闭环（第 6 节）。主网部署未做任何准备性广播，等待 Owner 明确授权。
