import { defineChain } from 'viem';

/** Multicall3 标准地址（anvil 自动部署；Robinhood testnet 链上已实测存在，3808 bytes） */
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as const;

/** 本地 Anvil 开发链 */
export const anvilLocal = defineChain({
  id: 31337,
  name: 'Anvil Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

/** Robinhood Chain Testnet */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  contracts: { multicall3: { address: MULTICALL3 } },
});
