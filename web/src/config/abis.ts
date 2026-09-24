import type { Abi } from 'viem';
import MineJson from '../abi/Mine.json';
import CardNftJson from '../abi/CardNFT.json';
import VaultJson from '../abi/Vault.json';
import RewardsJson from '../abi/Rewards.json';

/** ABI 事实来源：deployments/abi/*.json（sync-deployment.mjs 复制到 src/abi/） */
export const mineAbi = MineJson as Abi;
export const cardNftAbi = CardNftJson as Abi;
export const vaultAbi = VaultJson as Abi;
export const rewardsAbi = RewardsJson as Abi;
