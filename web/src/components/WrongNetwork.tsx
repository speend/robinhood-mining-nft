'use client';

import { useAccount, useSwitchChain } from 'wagmi';
import { TARGET_CHAIN_ID } from '@/config/contracts';

/** 连错网络时的明显提示 + 切换按钮 */
export function WrongNetworkBanner() {
  const { chainId, isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === TARGET_CHAIN_ID) return null;

  return (
    <div className="banner err">
      <span>当前连接的网络不是目标链（chainId {chainId}），请切换到 chainId {TARGET_CHAIN_ID}</span>
      <button
        className="btn amber sm"
        disabled={isPending}
        onClick={() => switchChain({ chainId: TARGET_CHAIN_ID })}
      >
        {isPending ? '切换中…' : '切换网络'}
      </button>
    </div>
  );
}
