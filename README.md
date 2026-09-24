# Robinhood Mining NFT

Robinhood Chain 上的 GPU 挖矿 NFT 协议：WebGPU 搜索有效 nonce → 链上 PoW 验证 → Mint NFT → Stake → 按权重分享 mint 收入。

## 仓库结构

```
contracts/          Foundry 项目（4 个合约 + 测试 + 部署脚本）
web/                Next.js 前端（Mining / Fleet / Staking / Stats）
miner-reference/    原始交接包 + hardened-v1 WGSL shader + grinder demo
deployments/        部署记录 JSON + 合约 ABI（前端配置的唯一事实来源）
scripts/            测试向量生成 / WGSL 打包验证 / Anvil E2E
docs/               协议分析 / Spike 报告
```

## 快速开始（本地联调）

```bash
# 1. 起本地链
anvil --port 8545 --chain-id 31337

# 2. 部署（TEST ONLY 低难度 8 bits，秒挖；生产参数见 contracts/.env.example）
cd contracts
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
TREASURY=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
START_PRICE_WEI=250000000000000 BASE_BITS=8 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast

# 3. 链上 E2E（28 项检查：挖矿→mint→stake→分红→claim→轮换→解锁）
cd .. && node scripts/e2e-anvil.mjs

# 4. 前端
cd web && npm install && npm run dev   # http://localhost:3000
```

## 测试

```bash
cd contracts
forge build && forge test          # 62 tests / 7 suites
node ../scripts/gen-test-vectors.mjs && forge test --match-contract TestVectorsTest  # 跨实现向量
node ../scripts/verify-wgsl-packing.mjs   # WGSL 字节布局静态验证
```

## 分支

- `baseline-original` — contracts.zip 原始协议 + 最小修复（Deploy owner 分离、Rewards claim 尘埃锁死）+ 补齐测试
- `hardened-v1` — 上线候选：Domain-Separated Challenge 防预计算 PoW + 全套威胁模型测试 + 前端

## 文档

- `docs/PROTOCOL_ANALYSIS.md` — 协议分析（合约关系/权限/收入流/攻击面/主网风险）
- `docs/SPIKE_CHALLENGE.md` — Challenge 机制 Spike 验证报告
- `docs/ARCHITECTURE.md` — 系统架构
- `miner-reference/格式说明.md`、`坑清单.md` — PoW 编码规则（原始交接文档）

## 安全边界

- 私钥只存在本地 `.env`（已 gitignore），前端绝不接触私钥
- 所有写操作需钱包确认；找到 nonce 后不会自动发交易
- **未获 Owner 明确授权前，禁止部署 Robinhood Chain Mainnet**
