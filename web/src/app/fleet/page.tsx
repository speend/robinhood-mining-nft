'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { Countdown } from '@/components/Countdown';
import { TxStatus } from '@/components/TxStatus';
import { WrongNetworkBanner } from '@/components/WrongNetwork';
import { useFleet, type FleetItem } from '@/hooks/useFleet';
import { useApproveVaultTx, useStakeTx, useUnstakeTx } from '@/hooks/useTx';
import { useNowSec } from '@/components/Countdown';

/** CSS 生成的占位图：渐变 + 大字 token id（无外链图片） */
function NftArt({ tokenId, staked }: { tokenId: bigint; staked: boolean }) {
  const hue = (Number(tokenId) * 47) % 360;
  return (
    <div
      className="nft-art"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 60% 14%), hsl(${(hue + 60) % 360} 70% 26%))`,
      }}
    >
      <span className="id">#{tokenId.toString()}</span>
      <span className="tag">{staked ? 'STAKED' : 'MINED'}</span>
    </div>
  );
}

function NftCard({ item }: { item: FleetItem }) {
  const stakeTx = useStakeTx();
  const unstakeTx = useUnstakeTx();
  const queryClient = useQueryClient();
  const now = useNowSec();
  const unlocked = item.unlockTime > 0n && now >= Number(item.unlockTime);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['fleet'] });

  return (
    <div className="nft-card">
      <NftArt tokenId={item.tokenId} staked={item.staked} />
      <div className="nft-body">
        <div className="nft-row">
          <span>Token ID</span>
          <b>#{item.tokenId.toString()}</b>
        </div>
        <div className="nft-row">
          <span>状态</span>
          <b>{item.staked ? '已质押' : '未质押'}</b>
        </div>
        {item.staked && (
          <div className="nft-row">
            <span>解锁倒计时</span>
            <b>
              <Countdown targetUnixSec={item.unlockTime} />
            </b>
          </div>
        )}
        <div className="mt8">
          {item.staked ? (
            <button
              className="btn amber sm"
              style={{ width: '100%' }}
              disabled={!unlocked || unstakeTx.isPending || unstakeTx.isConfirming}
              onClick={() => unstakeTx.send(item.tokenId).then(refresh).catch(() => {})}
            >
              {unlocked ? 'UNSTAKE' : '锁定中'}
            </button>
          ) : (
            <button
              className="btn primary sm"
              style={{ width: '100%' }}
              disabled={stakeTx.isPending || stakeTx.isConfirming}
              onClick={() => stakeTx.send(item.tokenId).then(refresh).catch(() => {})}
            >
              STAKE
            </button>
          )}
        </div>
        <TxStatus tx={item.staked ? unstakeTx : stakeTx} />
      </div>
    </div>
  );
}

export default function FleetPage() {
  const { address, isConnected } = useAccount();
  const { data, isLoading } = useFleet(address);
  const approveTx = useApproveVaultTx();
  const queryClient = useQueryClient();

  if (!isConnected) {
    return (
      <div className="panel">
        <h2 className="panel-title">My Fleet</h2>
        <p className="muted">请先连接钱包查看你的 NFT。</p>
      </div>
    );
  }

  return (
    <div>
      <WrongNetworkBanner />
      <div className="panel">
        <h2 className="panel-title">My Fleet</h2>

        {isLoading && <p className="muted">扫描链上 NFT 中…</p>}

        {data && data.items.length === 0 && (
          <p className="muted">
            你还没有矿卡 NFT。去 <Link href="/">Mining</Link> 页面挖一张吧。
          </p>
        )}

        {data && data.items.length > 0 && !data.approvedForVault && (
          <div className="banner">
            <span>质押前需要先授权 Vault 合约操作你的 NFT（一次性 Approve）</span>
            <button
              className="btn primary sm"
              disabled={approveTx.isPending || approveTx.isConfirming}
              onClick={() =>
                approveTx
                  .send()
                  .then(() => queryClient.invalidateQueries({ queryKey: ['fleet'] }))
                  .catch(() => {})
              }
            >
              {approveTx.isPending || approveTx.isConfirming ? 'APPROVING…' : 'APPROVE VAULT'}
            </button>
          </div>
        )}
        <TxStatus tx={approveTx} />

        <div className="nft-grid mt16">
          {data?.items.map((item) => (
            <NftCard
              key={item.tokenId.toString()}
              item={item}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
