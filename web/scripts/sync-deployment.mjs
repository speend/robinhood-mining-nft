// 把合约部署事实来源（deployments/<network>.json）和 ABI 复制进 web/src，
// 前端构建/运行时统一从这里读取，不散落 hardcode 地址。
// 用法:
//   node scripts/sync-deployment.mjs                 # 默认 anvil-31337（本地联调）
//   node scripts/sync-deployment.mjs robinhood-testnet
//   DEPLOYMENT=robinhood-testnet node scripts/sync-deployment.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');

// 优先级：CLI 参数 > DEPLOYMENT 环境变量 > web/.deployment 文件 > anvil-31337
// 注意：predev/prebuild 钩子会调用本脚本（无参数），切换网络务必写 .deployment 文件，
// 否则每次 build 都会被重置回 anvil。
const markerPath = join(webRoot, '.deployment');
const marker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
const deploymentName = process.argv[2] || process.env.DEPLOYMENT || marker || 'anvil-31337';

const files = [
  [join(repoRoot, `deployments/${deploymentName}.json`), join(webRoot, 'src/config/deployment.json')],
  [join(repoRoot, 'deployments/abi/Mine.json'), join(webRoot, 'src/abi/Mine.json')],
  [join(repoRoot, 'deployments/abi/CardNFT.json'), join(webRoot, 'src/abi/CardNFT.json')],
  [join(repoRoot, 'deployments/abi/Vault.json'), join(webRoot, 'src/abi/Vault.json')],
  [join(repoRoot, 'deployments/abi/Rewards.json'), join(webRoot, 'src/abi/Rewards.json')],
];

for (const [src, dest] of files) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`synced ${src} -> ${dest}`);
}
