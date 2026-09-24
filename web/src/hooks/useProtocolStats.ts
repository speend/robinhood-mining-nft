'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { mineAbi, rewardsAbi, vaultAbi } from '@/config/abis';
import { MINE_ADDRESS, REWARDS_ADDRESS, TARGET_CHAIN_ID } from '@/config/contracts';

export interface ProtocolStats {
  minted: bigint;
  maxMints: bigint;
  currentBits: bigint;
  currentTier: bigint;
  currentMintDue: bigint;
  epoch: bigint;
  epochStart: bigint;
  epochDuration: bigint;
  treasuryAccrued: bigint;
  totalWeight: bigint;
  undistributed: bigint;
  /** Rewards 合约当前余额 */
  rewardsBalance: bigint;
}

const POLL_MS = 15_000;

export function useProtocolStats() {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });
  return useQuery<ProtocolStats>({
    queryKey: ['protocolStats', TARGET_CHAIN_ID],
    enabled: Boolean(client),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      if (!client) throw new Error('public client unavailable');
      const mine = { address: MINE_ADDRESS, abi: mineAbi } as const;
      const rewards = { address: REWARDS_ADDRESS, abi: rewardsAbi } as const;
      const [r, rewardsBalance] = await Promise.all([
        client.multicall({
          allowFailure: false,
          contracts: [
            { ...mine, functionName: 'minted' },
            { ...mine, functionName: 'maxMints' },
            { ...mine, functionName: 'currentBits' },
            { ...mine, functionName: 'currentTier' },
            { ...mine, functionName: 'currentMintDue' },
            { ...mine, functionName: 'epoch' },
            { ...mine, functionName: 'epochStart' },
            { ...mine, functionName: 'epochDuration' },
            { ...mine, functionName: 'treasuryAccrued' },
            { ...rewards, functionName: 'totalWeight' },
            { ...rewards, functionName: 'undistributed' },
          ],
        }),
        client.getBalance({ address: REWARDS_ADDRESS }),
      ]);
      const [
        minted,
        maxMints,
        currentBits,
        currentTier,
        currentMintDue,
        epoch,
        epochStart,
        epochDuration,
        treasuryAccrued,
        totalWeight,
        undistributed,
      ] = r as bigint[];
      return {
        minted,
        maxMints,
        currentBits,
        currentTier,
        currentMintDue,
        epoch,
        epochStart,
        epochDuration,
        treasuryAccrued,
        totalWeight,
        undistributed,
        rewardsBalance,
      };
    },
  });
}
