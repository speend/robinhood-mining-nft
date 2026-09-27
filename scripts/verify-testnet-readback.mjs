// Testnet 部署后链上回读核对（viem，绕开 cast 的 TLS 抖动）
import { createPublicClient, http } from 'viem';
import { readFileSync } from 'fs';

const dep = JSON.parse(readFileSync(new URL('../deployments/robinhood-testnet.json', import.meta.url)));
const client = createPublicClient({ transport: http(dep.rpcUrl, { retryCount: 5, retryDelay: 2000 }) });

const MINE = dep.contracts.Mine.address;
const NFT = dep.contracts.CardNFT.address;
const VAULT = dep.contracts.Vault.address;
const REW = dep.contracts.Rewards.address;

const mineAbi = JSON.parse(readFileSync(new URL('../deployments/abi/Mine.json', import.meta.url)));
const nftAbi = JSON.parse(readFileSync(new URL('../deployments/abi/CardNFT.json', import.meta.url)));
const rewAbi = JSON.parse(readFileSync(new URL('../deployments/abi/Rewards.json', import.meta.url)));

const r = (addr, abi, fn) => client.readContract({ address: addr, abi, functionName: fn });

let fail = 0;
const check = (label, actual, expected) => {
  const a = String(actual).toLowerCase();
  const e = String(expected).toLowerCase();
  const ok = a === e;
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`);
};

const chainId = await client.getChainId();
check('chainId', chainId, 46630);
check('Mine.minted', await r(MINE, mineAbi, 'minted'), 0n);
check('Mine.currentBits', await r(MINE, mineAbi, 'currentBits'), 35n);
check('Mine.currentMintDue', await r(MINE, mineAbi, 'currentMintDue'), 250000000000000n);
check('Mine.currentTier', await r(MINE, mineAbi, 'currentTier'), 0n);
check('Mine.epoch', await r(MINE, mineAbi, 'epoch'), 0n);
check('Mine.treasury', await r(MINE, mineAbi, 'treasury'), dep.treasury);
check('Mine.owner', await r(MINE, mineAbi, 'owner'), dep.owner);
check('CardNFT.minter == Mine', await r(NFT, nftAbi, 'minter'), MINE);
check('Rewards.mine == Mine', await r(REW, rewAbi, 'mine'), MINE);
check('Rewards.vault == Vault', await r(REW, rewAbi, 'vault'), VAULT);
const ch = await r(MINE, mineAbi, 'currentChallenge');
console.log('currentChallenge:', ch);
const mineBal = await client.getBalance({ address: MINE });
const rewBal = await client.getBalance({ address: REW });
console.log('Mine balance:', mineBal, '| Rewards balance:', rewBal);

console.log(fail === 0 ? '\n全部回读核对通过' : `\n${fail} 项不符`);
process.exit(fail === 0 ? 0 : 1);
