'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { cardNftAbi, rewardsAbi, vaultAbi } from '@/config/abis';
import { NFT_ADDRESS, REWARDS_ADDRESS, TARGET_CHAIN_ID, VAULT_ADDRESS } from '@/config/contracts';

export interface StakingData {
  /** 我质押的 NFT 数量（Vault.stakeCount） */
  stakeCount: bigint;
  /** 我在 Vault 的权重 */
  myWeight: bigint;
  /** 全池总权重（Rewards.totalWeight） */
  totalWeight: bigint;
  /** 我的份额 0..1；totalWeight 为 0 时为 0 */
  myShare: number;
  /** 待领分红（wei） */
  pending: bigint;
  /** 无人质押时暂存的分红池（wei） */
  undistributed: bigint;
  lockDuration: bigint;
  /** 我质押中的 tokenId 列表 */
  stakedTokenIds: bigint[];
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const POLL_MS = 20_000;

export function useStaking(address: Address | undefined) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });
  return useQuery<StakingData>({
    queryKey: ['staking', TARGET_CHAIN_ID, address],
    enabled: Boolean(client && address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      if (!client || !address) throw new Error('client/address unavailable');
      const vault = { address: VAULT_ADDRESS, abi: vaultAbi } as const;
      const rewards = { address: REWARDS_ADDRESS, abi: rewardsAbi } as const;

      const [r, totalMinted] = await Promise.all([
        client.multicall({
          allowFailure: false,
          contracts: [
            { ...vault, functionName: 'stakeCount', args: [address] },
            { ...vault, functionName: 'weightOf', args: [address] },
            { ...rewards, functionName: 'totalWeight' },
            { ...rewards, functionName: 'pending', args: [address] },
            { ...rewards, functionName: 'undistributed' },
            { ...vault, functionName: 'lockDuration' },
          ],
        }),
        client.readContract({ address: NFT_ADDRESS, abi: cardNftAbi, functionName: 'totalMinted' }),
      ]);
      const [stakeCount, myWeight, totalWeight, pending, undistributed, lockDuration] =
        r as bigint[];
      const total = totalMinted as bigint;

      // 同 useFleet：本地链遍历 stakerOf 找出我质押的 tokenId；mainnet 需换事件索引
      let stakedTokenIds: bigint[] = [];
      if (stakeCount > 0n && total > 0n) {
        const n = Number(total);
        const stakers = await client.multicall({
          allowFailure: true,
          contracts: Array.from({ length: n }, (_, i) => ({
            ...vault,
            functionName: 'stakerOf',
            args: [BigInt(i + 1)],
          })),
        });
        stakedTokenIds = stakers
          .map((s, i) => ({ s, id: BigInt(i + 1) }))
          .filter(
            ({ s }) =>
              s.status === 'success' &&
              typeof s.result === 'string' &&
              s.result.toLowerCase() === address.toLowerCase() &&
              (s.result as string) !== ZERO_ADDRESS,
          )
          .map(({ id }) => id);
      }

      const myShare = totalWeight > 0n ? Number(myWeight) / Number(totalWeight) : 0;
      return {
        stakeCount,
        myWeight,
        totalWeight,
        myShare,
        pending,
        undistributed,
        lockDuration,
        stakedTokenIds,
      };
    },
  });
}
