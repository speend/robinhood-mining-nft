'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { StatCard } from '@/components/StatCard';
import { TxStatus } from '@/components/TxStatus';
import { WrongNetworkBanner } from '@/components/WrongNetwork';
import { useStaking } from '@/hooks/useStaking';
import { useClaimTx } from '@/hooks/useTx';
import { formatCount, formatEth } from '@/lib/format';

export default function StakingPage() {
  const { address, isConnected } = useAccount();
  const { data, isLoading } = useStaking(address);
  const claimTx = useClaimTx();
  const queryClient = useQueryClient();

  if (!isConnected) {
    return (
      <div className="panel">
        <h2 className="panel-title">Staking</h2>
        <p className="muted">请先连接钱包查看质押看板。</p>
      </div>
    );
  }

  return (
    <div>
      <WrongNetworkBanner />
      <div className="panel glow">
        <h2 className="panel-title">Staking Dashboard</h2>

        {isLoading && <p className="muted">加载中…</p>}

        {data && (
          <>
            <div className="grid cols-3">
              <StatCard label="My Staked NFTs" value={formatCount(data.stakeCount)} />
              <StatCard label="Total Staked (Weight)" value={formatCount(data.totalWeight)} />
              <StatCard label="My Weight" value={formatCount(data.myWeight)} />
              <StatCard
                label="My Share"
                value={`${(data.myShare * 100).toFixed(2)}%`}
                accent={data.myShare > 0}
              />
              <StatCard
                label="Pending Rewards"
                value={`${formatEth(data.pending)} ETH`}
                accent={data.pending > 0n}
              />
              <StatCard
                label="Undistributed Pool"
                value={`${formatEth(data.undistributed)} ETH`}
                sub="无人质押期间进入分红池的份额暂存于此，有人质押后按规则分配"
              />
            </div>

            <div className="mt16">
              <button
                className="btn primary"
                disabled={data.pending <= 0n || claimTx.isPending || claimTx.isConfirming}
                onClick={() =>
                  claimTx
                    .send()
                    .then(() => queryClient.invalidateQueries({ queryKey: ['staking'] }))
                    .catch(() => {})
                }
              >
                {claimTx.isPending || claimTx.isConfirming ? 'CLAIMING…' : 'CLAIM REWARDS'}
              </button>
              <TxStatus tx={claimTx} />
            </div>

            <div className="mt24">
              <h3 className="panel-title">Staked Token IDs</h3>
              {data.stakedTokenIds.length === 0 ? (
                <p className="muted small">当前没有质押中的 NFT。去 Fleet 页面质押。</p>
              ) : (
                <div className="mono-box">
                  {data.stakedTokenIds.map((id) => (
                    <span key={id.toString()} className="hl" style={{ marginRight: 12 }}>
                      #{id.toString()}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
