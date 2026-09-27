// 从 forge broadcast 产物生成 deployments/<network>.json（部署事实来源）。
// 用法:
//   node scripts/finalize-deployment.mjs --network robinhood-testnet --chain-id 46630 \
//     --rpc https://rpc.testnet.chain.robinhood.com \
//     --explorer https://explorer.testnet.chain.robinhood.com
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const network = arg('network');
const chainId = Number(arg('chain-id'));
const rpcUrl = arg('rpc');
const explorer = arg('explorer');
if (!network || !chainId || !rpcUrl) {
  console.error('usage: finalize-deployment.mjs --network <name> --chain-id <id> --rpc <url> [--explorer <url>]');
  process.exit(1);
}

const broadcastPath = join(repoRoot, `contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`);
const broadcast = JSON.parse(readFileSync(broadcastPath, 'utf8'));

const contracts = {};
for (const tx of broadcast.transactions) {
  if (tx.transactionType !== 'CREATE') continue;
  if (!tx.hash) {
    console.error('broadcast 里没有交易 hash——这是 dry-run 产物，不能用于正式 deployment json');
    process.exit(1);
  }
  contracts[tx.contractName] = { address: tx.contractAddress, txHash: tx.hash };
}
for (const name of ['CardNFT', 'Rewards', 'Vault', 'Mine']) {
  if (!contracts[name]) {
    console.error(`broadcast 里缺少 ${name} 的 CREATE 交易`);
    process.exit(1);
  }
}

let blockNumber = null;
if (broadcast.receipts?.length) {
  const nums = broadcast.receipts
    .map((r) => (r.blockNumber ? parseInt(r.blockNumber, 16) : null))
    .filter((n) => n != null);
  if (nums.length) blockNumber = Math.min(...nums);
}

const commitHash = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
// 部署参数从 Mine constructor arguments 回读，避免手抄出错
const mineCreate = broadcast.transactions.find((t) => t.transactionType === 'CREATE' && t.contractName === 'Mine');
const a = mineCreate.arguments;
const deployer = mineCreate.transaction.from;

const out = {
  network,
  chainId,
  rpcUrl,
  explorer: explorer || null,
  deployedAt: new Date().toISOString(),
  commitHash,
  blockNumber,
  config: {
    baseBits: Number(a[4]),
    bitsPerTier: Number(a[5]),
    tierSize: Number(a[6]),
    startPriceWei: String(a[7]),
    maxMints: Number(a[8]),
    lockDuration: 31536000,
    epochDuration: Number(a[9]),
    gracePeriod: Number(a[10]),
  },
  deployer,
  owner: deployer,
  treasury: a[2],
  contracts,
};

const dest = join(repoRoot, `deployments/${network}.json`);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`written ${dest}`);
console.log(JSON.stringify(contracts, null, 2));
