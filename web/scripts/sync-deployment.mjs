// 把合约部署事实来源（deployments/anvil-31337.json）和 ABI 复制进 web/src，
// 前端构建/运行时统一从这里读取，不散落 hardcode 地址。
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');

const files = [
  [join(repoRoot, 'deployments/anvil-31337.json'), join(webRoot, 'src/config/deployment.json')],
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
