'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { cardNftAbi, vaultAbi } from '@/config/abis';
import { NFT_ADDRESS, TARGET_CHAIN_ID, VAULT_ADDRESS } from '@/config/contracts';

export interface FleetItem {
  tokenId: bigint;
  /** 质押者地址；未质押为零地址 */
  staker: Address;
  staked: boolean;
  /** 解锁时间戳（秒）；未质押为 0 */
  unlockTime: bigint;
}

export interface FleetData {
  items: FleetItem[];
  /** 是否已授权 Vault 操作全部 NFT */
  approvedForVault: boolean;
  totalMinted: bigint;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const POLL_MS = 20_000;

/**
 * 枚举我的 NFT。
 * 注意：CardNFT 无 ERC721Enumerable 扩展，这里遍历 totalMinted 调 ownerOf ——
 * 本地链（Anvil）规模小可以接受；上 mainnet 必须换成 Transfer 事件索引 / Subgraph。
 */
export function useFleet(address: Address | undefined) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });
  return useQuery<FleetData>({
    queryKey: ['fleet', TARGET_CHAIN_ID, address],
    enabled: Boolean(client && address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      if (!client || !address) throw new Error('client/address unavailable');
      const nft = { address: NFT_ADDRESS, abi: cardNftAbi } as const;
      const totalMinted = (await client.readContract({
        ...nft,
        functionName: 'totalMinted',
      })) as bigint;

      const total = Number(totalMinted);
      const owned: bigint[] = [];
      if (total > 0) {
        const owners = await client.multicall({
          allowFailure: true,
          contracts: Array.from({ length: total }, (_, i) => ({
            ...nft,
            functionName: 'ownerOf',
            args: [BigInt(i + 1)], // tokenId 从 1 递增
          })),
        });
        owners.forEach((r, i) => {
          if (
            r.status === 'success' &&
            typeof r.result === 'string' &&
            r.result.toLowerCase() === address.toLowerCase()
          ) {
            owned.push(BigInt(i + 1));
          }
        });
      }

      let items: FleetItem[] = [];
      if (owned.length > 0) {
        const vault = { address: VAULT_ADDRESS, abi: vaultAbi } as const;
        const stakingInfo = await client.multicall({
          allowFailure: true,
          contracts: owned.flatMap((id) => [
            { ...vault, functionName: 'stakerOf', args: [id] },
            { ...vault, functionName: 'unlockTime', args: [id] },
          ]),
        });
        items = owned.map((id, i) => {
          const stakerRes = stakingInfo[i * 2];
          const unlockRes = stakingInfo[i * 2 + 1];
          const staker =
            stakerRes?.status === 'success' && typeof stakerRes.result === 'string'
              ? (stakerRes.result as Address)
              : ZERO_ADDRESS;
          const unlockTime =
            unlockRes?.status === 'success' && typeof unlockRes.result === 'bigint'
              ? unlockRes.result
              : 0n;
          return { tokenId: id, staker, staked: staker !== ZERO_ADDRESS, unlockTime };
        });
      }

      const approvedForVault = (await client.readContract({
        ...nft,
        functionName: 'isApprovedForAll',
        args: [address, VAULT_ADDRESS],
      })) as boolean;

      return { items, approvedForVault, totalMinted };
    },
  });
}
