# MAINNET_CHECKLIST.md — Robinhood Chain Mainnet 部署检查单

> **硬性门槛**：只有项目 Owner 明确说出「确认部署 RB 主网」后，才允许执行本检查单中的任何广播动作。
> 在此之前，本文件仅作准备参考。任何一项不通过都不得继续。

## 0. 授权与网络确认

- [ ] 收到 Owner 明确主网部署授权（文字确认）
- [ ] 重新查阅 Robinhood 官方文档，确认主网参数未变：
  - Chain ID: `4663`（当前预期，必须以官方文档为准）
  - RPC: `https://rpc.mainnet.chain.robinhood.com`
  - Explorer: `https://robinhoodchain.blockscout.com`
- [ ] `cast chain-id --rpc-url <主网RPC>` 实测返回值与文档一致

## 1. 代码冻结

- [ ] `git status` 干净，无未提交改动
- [ ] 锁定部署 commit，记录 commit hash
- [ ] 部署分支 = 经过 testnet 完整验证的同一 commit（禁止夹带未测改动）
- [ ] `forge build` 从零构建通过（`forge clean && forge build`）
- [ ] `forge test` 全绿（62+ tests，0 failed）
- [ ] Slither 重跑，无新增 High/Critical
- [ ] 记录 4 个合约的 bytecode hash（`forge inspect <C> deployedBytecode` | keccak）

## 2. 账户与资金

- [ ] Deployer 钱包确认（新地址，私钥仅存本地 `.env`，从未出现在 git 历史/日志/截图）
- [ ] Deployer 主网 ETH 余额充足（部署 ~6M gas，按当时 gas price 预算 + 50% 余量）
- [ ] **Owner = 多签地址**（禁止 EOA）
- [ ] **Treasury = 多签地址**（禁止 EOA；testnet 的 EOA 配置不得带入主网）
- [ ] `.env` 在 `.gitignore` 中，且 `git log -p` 确认无私钥泄漏历史

## 3. 构造参数逐项核对

- [ ] `BASE_BITS=35`、`TIER_SIZE=500`、`BITS_PER_TIER=1`
- [ ] `START_PRICE=250000000000000`（0.00025 ETH）
- [ ] `MAX_MINTS=5000`
- [ ] `LOCK_DURATION=31536000`（365 天，**生产值**，不得使用任何 test-only 短锁仓配置）
- [ ] `EPOCH_DURATION=86400`、`GRACE_PERIOD=600`
- [ ] `NFT_NAME` / `NFT_SYMBOL` 最终确认
- [ ] `BASE_URI` 指向最终 NFT metadata（图片已经 Owner 审核，不再是 placeholder）
- [ ] 经济参数与 `docs/PROTOCOL_ANALYSIS.md` 一致，无任何未告知的改动

## 4. Dry-run 与审批

- [ ] `forge script script/Deploy.s.sol --rpc-url <主网RPC>`（不带 `--broadcast`）模拟成功
- [ ] 把预计的 7 笔交易（4 CREATE + 3 接线 CALL）、总 gas、当前 gas price、总花费 ETH 展示给 Owner
- [ ] Owner 逐条批准后，才加 `--broadcast`

## 5. 部署后

- [ ] 生成 `deployments/robinhood-mainnet.json`（`node scripts/finalize-deployment.mjs`）
- [ ] 4 个合约全部在 Blockscout 验证源码
- [ ] 链上回读核对：owner / treasury / minter / mine / vault 接线正确
- [ ] 前端切主网（`sync-deployment.mjs robinhood-mainnet` + `NEXT_PUBLIC_CHAIN_ID=4663`）
- [ ] 用小额真实 mint 走一遍完整流程（GPU 挖矿 → mint → stake）
- [ ] 记录所有交易 hash 与 explorer 链接

## 6. 禁止事项（任何时候）

- 未经 Owner 明确授权广播主网交易
- 修改经济参数不告知
- 部署未验证源码
- 存在未解决的 Critical/High 安全问题
- 将 test-only 配置（短锁仓、低难度）带入主网
