import type { Address } from 'viem';
import { anvilLocal, robinhoodTestnet } from './chains';
import deployment from './deployment.json';

/**
 * 统一配置出口。
 * 优先级：NEXT_PUBLIC_* env > deployments/anvil-31337.json（构建时由
 * scripts/sync-deployment.mjs 复制到 src/config/deployment.json）。
 * 切换 Robinhood Chain Testnet：NEXT_PUBLIC_CHAIN_ID=46630（并用 env 提供
 * 对应的合约地址，否则回退到 anvil 部署地址，仅适合本地联调）。
 */

const env = process.env;

const parsedChainId = Number(env.NEXT_PUBLIC_CHAIN_ID ?? deployment.chainId);
if (parsedChainId !== anvilLocal.id && parsedChainId !== robinhoodTestnet.id) {
  throw new Error(`Unsupported NEXT_PUBLIC_CHAIN_ID: ${parsedChainId}`);
}

export const TARGET_CHAIN_ID = parsedChainId;
export const TARGET_CHAIN = TARGET_CHAIN_ID === robinhoodTestnet.id ? robinhoodTestnet : anvilLocal;

export const RPC_URL: string =
  env.NEXT_PUBLIC_RPC_URL ??
  (TARGET_CHAIN_ID === anvilLocal.id ? deployment.rpcUrl : robinhoodTestnet.rpcUrls.default.http[0]);

const defaultExplorer: string | null =
  TARGET_CHAIN_ID === anvilLocal.id
    ? deployment.explorer
    : robinhoodTestnet.blockExplorers.default.url;

export const EXPLORER_URL: string | null = env.NEXT_PUBLIC_EXPLORER_URL || defaultExplorer;

export const MINE_ADDRESS = (env.NEXT_PUBLIC_MINE_ADDRESS ?? deployment.contracts.Mine.address) as Address;
export const NFT_ADDRESS = (env.NEXT_PUBLIC_NFT_ADDRESS ?? deployment.contracts.CardNFT.address) as Address;
export const VAULT_ADDRESS = (env.NEXT_PUBLIC_VAULT_ADDRESS ?? deployment.contracts.Vault.address) as Address;
export const REWARDS_ADDRESS = (env.NEXT_PUBLIC_REWARDS_ADDRESS ?? deployment.contracts.Rewards.address) as Address;

export const WC_PROJECT_ID = env.NEXT_PUBLIC_WC_PROJECT_ID ?? '';

/** 部署时的协议参数（事实来源 = deployments/anvil-31337.json） */
export const PROTOCOL_CONFIG = {
  baseBits: deployment.config.baseBits,
  bitsPerTier: deployment.config.bitsPerTier,
  tierSize: deployment.config.tierSize,
  startPriceWei: BigInt(deployment.config.startPriceWei),
  maxMints: deployment.config.maxMints,
  lockDuration: deployment.config.lockDuration,
  epochDuration: deployment.config.epochDuration,
  gracePeriod: deployment.config.gracePeriod,
} as const;

export function explorerTxUrl(txHash: string): string | null {
  return EXPLORER_URL ? `${EXPLORER_URL}/tx/${txHash}` : null;
}

export function explorerAddressUrl(address: string): string | null {
  return EXPLORER_URL ? `${EXPLORER_URL}/address/${address}` : null;
}
