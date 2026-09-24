'use client';

import { useCallback } from 'react';
import { usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { Address } from 'viem';
import { cardNftAbi, mineAbi, rewardsAbi, vaultAbi } from '@/config/abis';
import {
  MINE_ADDRESS,
  NFT_ADDRESS,
  REWARDS_ADDRESS,
  TARGET_CHAIN_ID,
  VAULT_ADDRESS,
} from '@/config/contracts';
import { fetchCurrentMintDue } from '@/miner/verify';

export interface TxState {
  hash: `0x${string}` | undefined;
  /** 钱包确认中 */
  isPending: boolean;
  /** 已发出，等待上链 */
  isConfirming: boolean;
  isSuccess: boolean;
  error: Error | null;
  reset: () => void;
}

function useTxBase() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash, chainId: TARGET_CHAIN_ID });
  const state: TxState = {
    hash,
    isPending,
    isConfirming: receipt.isLoading,
    isSuccess: receipt.isSuccess,
    error: (error ?? receipt.error) as Error | null,
    reset,
  };
  return { writeContractAsync, state };
}

/** mint：提交前重读 currentMintDue()，value 精确等于它 */
export function useMintTx() {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const { writeContractAsync, state } = useTxBase();
  const send = useCallback(
    async (nonce: bigint) => {
      if (!client) throw new Error('public client unavailable');
      const due = await fetchCurrentMintDue(client);
      await writeContractAsync({
        address: MINE_ADDRESS,
        abi: mineAbi,
        functionName: 'mint',
        args: [nonce],
        value: due,
        chainId: TARGET_CHAIN_ID,
      });
    },
    [client, writeContractAsync],
  );
  return { send, ...state };
}

/** 授权 Vault 操作全部 NFT（stake 前置步骤） */
export function useApproveVaultTx() {
  const { writeContractAsync, state } = useTxBase();
  const send = useCallback(async () => {
    await writeContractAsync({
      address: NFT_ADDRESS,
      abi: cardNftAbi,
      functionName: 'setApprovalForAll',
      args: [VAULT_ADDRESS, true],
      chainId: TARGET_CHAIN_ID,
    });
  }, [writeContractAsync]);
  return { send, ...state };
}

export function useStakeTx() {
  const { writeContractAsync, state } = useTxBase();
  const send = useCallback(
    async (tokenId: bigint) => {
      await writeContractAsync({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'stake',
        args: [tokenId],
        chainId: TARGET_CHAIN_ID,
      });
    },
    [writeContractAsync],
  );
  return { send, ...state };
}

export function useUnstakeTx() {
  const { writeContractAsync, state } = useTxBase();
  const send = useCallback(
    async (tokenId: bigint) => {
      await writeContractAsync({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'unstake',
        args: [tokenId],
        chainId: TARGET_CHAIN_ID,
      });
    },
    [writeContractAsync],
  );
  return { send, ...state };
}

export function useClaimTx() {
  const { writeContractAsync, state } = useTxBase();
  const send = useCallback(async () => {
    await writeContractAsync({
      address: REWARDS_ADDRESS,
      abi: rewardsAbi,
      functionName: 'claim',
      chainId: TARGET_CHAIN_ID,
    });
  }, [writeContractAsync]);
  return { send, ...state };
}

/** 辅助：统一把 unknown 错误转成可读消息 */
export function txErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    // viem 的错误信息很长，取第一行
    return e.message.split('\n')[0].slice(0, 300);
  }
  return String(e);
}

export type { Address };
