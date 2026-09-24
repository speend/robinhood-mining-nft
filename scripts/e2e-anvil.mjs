// E2E 本地链全流程验证（hardened-v1）
// 在 live Anvil 上真实执行：CPU 挖矿 → 链上校验 → mint → stake → 第二账户 mint
// → 分红累积 → claim → 事件验证 → challenge 轮换/宽限期/过期路径
// 用法: anvil 运行中 + 已部署（deployments/anvil-31337.json）后: node scripts/e2e-anvil.mjs
import { createPublicClient, createWalletClient, http, keccak256, encodePacked, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';

const RPC = 'http://127.0.0.1:8545';
const dep = JSON.parse(readFileSync(new URL('../deployments/anvil-31337.json', import.meta.url)));
const MINE = dep.contracts.Mine.address;
const NFT = dep.contracts.CardNFT.address;
const VAULT = dep.contracts.Vault.address;
const REWARDS = dep.contracts.Rewards.address;

// anvil 默认账户：#0 部署者/owner，#2 #3 当矿工
const alice = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const bob = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');

const mineAbi = JSON.parse(readFileSync(new URL('../deployments/abi/Mine.json', import.meta.url)));
const nftAbi = JSON.parse(readFileSync(new URL('../deployments/abi/CardNFT.json', import.meta.url)));
const vaultAbi = JSON.parse(readFileSync(new URL('../deployments/abi/Vault.json', import.meta.url)));
const rewardsAbi = JSON.parse(readFileSync(new URL('../deployments/abi/Rewards.json', import.meta.url)));

const pub = createPublicClient({ transport: http(RPC) });
const walletOf = (acct) => createWalletClient({ account: acct, transport: http(RPC) });

let passed = 0;
function check(name, cond, extra = '') {
  if (!cond) {
    console.error(`❌ FAIL: ${name} ${extra}`);
    process.exit(1);
  }
  passed++;
  console.log(`✅ ${name} ${extra}`);
}

// CPU 挖矿（与前端 verify 同构：viem keccak256，8 bits 平均 256 次）
// 注意：nonceUsed 是 per-user 全局的（跨 challenge），已用 nonce 必须跳过
const usedNonces = new Map(); // address(lowercase) -> Set<bigint>
function cpuMine(challenge, address, bits) {
  const key = address.toLowerCase();
  if (!usedNonces.has(key)) usedNonces.set(key, new Set());
  const used = usedNonces.get(key);
  const t0 = Date.now();
  for (let n = 0n; ; n++) {
    if (used.has(n)) continue;
    const h = BigInt(keccak256(encodePacked(['bytes32', 'address', 'uint64'], [challenge, address, n])));
    if ((h >> (256n - BigInt(bits))) === 0n) {
      used.add(n);
      return { nonce: n, attempts: n + 1n, ms: Date.now() - t0 };
    }
  }
}

const r = (abi, address, functionName, args = []) =>
  pub.readContract({ address, abi, functionName, args });

console.log('=== Robinhood Mining NFT — Anvil E2E (hardened-v1) ===\n');

// ---------- 0. 链状态 ----------
const chainId = await pub.getChainId();
check('chainId = 31337', chainId === 31337);
const bits0 = await r(mineAbi, MINE, 'currentBits');
const due0 = await r(mineAbi, MINE, 'currentMintDue');
const challenge0 = await r(mineAbi, MINE, 'currentChallenge');
check('currentBits = 8 (TEST ONLY 配置)', bits0 === 8n);
check('currentMintDue = 0.00025 ETH', due0 === 250000000000000n);
check('currentChallenge 非零', challenge0 !== '0x' + '00'.repeat(32));

// ---------- 1. Alice 挖矿 + mint ----------
const m1 = cpuMine(challenge0, alice.address, 8);
console.log(`   [alice] CPU 挖出 nonce=${m1.nonce}，尝试 ${m1.attempts} 次，耗时 ${m1.ms}ms`);

// 前端同款的提交前校验：isValidNonce 链上复核
const valid1 = await r(mineAbi, MINE, 'isValidNonce', [alice.address, m1.nonce, 8n]);
check('链上 isValidNonce(alice, nonce, 8) = true', valid1 === true);

const w1 = walletOf(alice);
const tx1 = await w1.writeContract({
  address: MINE, abi: mineAbi, functionName: 'mint', args: [m1.nonce], value: due0,
  chain: null,
});
const rc1 = await pub.waitForTransactionReceipt({ hash: tx1 });
check('alice mint 成功', rc1.status === 'success', `tx=${tx1.slice(0, 18)}…`);
check('NFT #1 归 alice', (await r(nftAbi, NFT, 'ownerOf', [1n])).toLowerCase() === alice.address.toLowerCase());
check('minted = 1', (await r(mineAbi, MINE, 'minted')) === 1n);

// 70/30 分账验证
const rewardsBal1 = await pub.getBalance({ address: REWARDS });
check('Rewards 收到 70% = 0.000175 ETH', rewardsBal1 === 175000000000000n, formatEther(rewardsBal1));

// ---------- 2. Alice stake ----------
const w1approve = await w1.writeContract({
  address: NFT, abi: nftAbi, functionName: 'setApprovalForAll', args: [VAULT, true], chain: null,
});
await pub.waitForTransactionReceipt({ hash: w1approve });
const tx2 = await w1.writeContract({ address: VAULT, abi: vaultAbi, functionName: 'stake', args: [1n], chain: null });
await pub.waitForTransactionReceipt({ hash: tx2 });
check('alice stake #1 成功', true);
check('NFT #1 归 Vault', (await r(nftAbi, NFT, 'ownerOf', [1n])).toLowerCase() === VAULT.toLowerCase());
check('alice 权重 = 1', (await r(rewardsAbi, REWARDS, 'weightOf', [alice.address])) === 1n);
check('首个质押者独享 undistributed 0.000175', (await r(rewardsAbi, REWARDS, 'pending', [alice.address])) === 175000000000000n);

// ---------- 3. Bob 挖矿 + mint（验证分红按权重增长） ----------
const m2 = cpuMine(challenge0, bob.address, 8);
console.log(`   [bob]   CPU 挖出 nonce=${m2.nonce}，尝试 ${m2.attempts} 次`);
const w2 = walletOf(bob);
const due2 = await r(mineAbi, MINE, 'currentMintDue');
const tx3 = await w2.writeContract({
  address: MINE, abi: mineAbi, functionName: 'mint', args: [m2.nonce], value: due2, chain: null,
});
await pub.waitForTransactionReceipt({ hash: tx3 });
check('bob mint 成功（minted=2）', (await r(mineAbi, MINE, 'minted')) === 2n);
const pendingAlice = await r(rewardsAbi, REWARDS, 'pending', [alice.address]);
check('bob 的 mint 分红全归唯一质押者 alice', pendingAlice === 175000000000000n + 175000000000000n, formatEther(pendingAlice));

// ---------- 4. nonce replay / MEV copy（链上拒绝） ----------
let replayReverted = false;
try {
  await w1.writeContract({ address: MINE, abi: mineAbi, functionName: 'mint', args: [m1.nonce], value: due2, chain: null });
} catch { replayReverted = true; }
check('alice 重放同一 nonce 被拒（NonceAlreadyUsed）', replayReverted);

let mevReverted = false;
try {
  // bob 复制 alice 已用过的 nonce —— 首先 NonceAlreadyUsed 是 per-user 的，所以这里验证的是 hash 绑定：
  // bob 用 alice 的 nonce，hash 里地址是 bob → BadNonce
  const validAsBob = await r(mineAbi, MINE, 'isValidNonce', [bob.address, m1.nonce, 8n]);
  if (!validAsBob) mevReverted = true;
} catch { mevReverted = true; }
check("alice 的 nonce 对 bob 无效（MEV copy 防护）", mevReverted);

// ---------- 5. Claim ----------
const before = await pub.getBalance({ address: alice.address });
const tx4 = await w1.writeContract({ address: REWARDS, abi: rewardsAbi, functionName: 'claim', chain: null });
const rc4 = await pub.waitForTransactionReceipt({ hash: tx4 });
const after = await pub.getBalance({ address: alice.address });
const gained = after - before + (rc4.gasUsed * rc4.effectiveGasPrice);
check('alice claim 到账 ≈ 0.00035 ETH', gained === 350000000000000n, `实际 ${formatEther(gained)}`);
check('claim 后 pending = 0', (await r(rewardsAbi, REWARDS, 'pending', [alice.address])) === 0n);

// ---------- 6. 事件验证 ----------
const mintLogs = await pub.getLogs({
  address: MINE,
  event: { type: 'event', name: 'Minted', inputs: [
    { name: 'user', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'nonce', type: 'uint64' }, { name: 'tier', type: 'uint256' }, { name: 'price', type: 'uint256' },
  ]},
  fromBlock: 0n,
});
check('Minted 事件 × 2', mintLogs.length === 2);
const stakeLogs = await pub.getLogs({
  address: VAULT,
  event: { type: 'event', name: 'Staked', inputs: [
    { name: 'user', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true },
  ]},
  fromBlock: 0n,
});
check('Staked 事件 × 1', stakeLogs.length === 1);

// ---------- 7. Challenge 轮换 / 宽限期 / 过期 ----------
const epochDur = await r(mineAbi, MINE, 'epochDuration');
await pub.request({ method: 'evm_increaseTime', params: [Number(epochDur)] });
await pub.request({ method: 'evm_mine', params: [] });

// 宽限期内旧码仍可 mint（bob 再 mint 一张，用旧 challenge 的码）
const m3old = cpuMine(challenge0, bob.address, 8);
await walletOf(alice).writeContract({ address: MINE, abi: mineAbi, functionName: 'rotate', args: [], chain: null })
  .then((tx) => pub.waitForTransactionReceipt({ hash: tx }));
const challenge1 = await r(mineAbi, MINE, 'currentChallenge');
check('轮换后 challenge 改变', challenge1 !== challenge0);
check('epoch = 1', (await r(mineAbi, MINE, 'epoch')) === 1n);

const due3 = await r(mineAbi, MINE, 'currentMintDue');
const tx5 = await w2.writeContract({ address: MINE, abi: mineAbi, functionName: 'mint', args: [m3old.nonce], value: due3, chain: null });
await pub.waitForTransactionReceipt({ hash: tx5 });
check('宽限期内旧 challenge 的 nonce 仍可 mint（minted=3）', (await r(mineAbi, MINE, 'minted')) === 3n);

// 宽限期过后旧码作废
const grace = await r(mineAbi, MINE, 'gracePeriod');
await pub.request({ method: 'evm_increaseTime', params: [Number(grace) + 10] });
await pub.request({ method: 'evm_mine', params: [] });
const m4old = cpuMine(challenge0, alice.address, 8);
let expiredReverted = false;
try {
  await pub.estimateContractGas({ address: MINE, abi: mineAbi, functionName: 'mint', args: [m4old.nonce], value: due3, account: alice.address });
} catch { expiredReverted = true; }
check('宽限期过后旧 challenge nonce 被拒（Challenge expired）', expiredReverted);

// 新 challenge 正常 mint
const m5 = cpuMine(challenge1, alice.address, 8);
const tx6 = await w1.writeContract({ address: MINE, abi: mineAbi, functionName: 'mint', args: [m5.nonce], value: due3, chain: null });
await pub.waitForTransactionReceipt({ hash: tx6 });
check('新 challenge mint 成功（minted=4）', (await r(mineAbi, MINE, 'minted')) === 4n);

// ---------- 8. Unstake 锁仓 ----------
let earlyUnstakeReverted = false;
try {
  await pub.estimateContractGas({ address: VAULT, abi: vaultAbi, functionName: 'unstake', args: [1n], account: alice.address });
} catch { earlyUnstakeReverted = true; }
check('365 天前 unstake 被拒（StillLocked）', earlyUnstakeReverted);

await pub.request({ method: 'evm_increaseTime', params: [31536000] });
await pub.request({ method: 'evm_mine', params: [] });
const tx7 = await w1.writeContract({ address: VAULT, abi: vaultAbi, functionName: 'unstake', args: [1n], chain: null });
await pub.waitForTransactionReceipt({ hash: tx7 });
check('365 天后 unstake 成功，NFT 归还', (await r(nftAbi, NFT, 'ownerOf', [1n])).toLowerCase() === alice.address.toLowerCase());

console.log(`\n=== E2E 全部通过：${passed} 项检查 ✅ ===`);
