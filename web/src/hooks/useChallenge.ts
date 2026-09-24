'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { fetchChallengeState } from '@/miner/challenge';
import { TARGET_CHAIN_ID } from '@/config/contracts';

const POLL_MS = 20_000;

/**
 * 轮询链上 challenge 状态（challenge / bits / price / epoch / 宽限期）。
 * challenge 轮换后 data.challenge 会变化，调用方据此提示或重启挖矿。
 */
export function useChallenge() {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });
  return useQuery({
    queryKey: ['challenge', TARGET_CHAIN_ID],
    queryFn: () => {
      if (!client) throw new Error('public client unavailable');
      return fetchChallengeState(client);
    },
    enabled: Boolean(client),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });
}
