'use client';

import { explorerTxUrl } from '@/config/contracts';
import { truncateHex } from '@/lib/format';
import type { TxState } from '@/hooks/useTx';

/** 交易 pending / 成功 / 失败 状态展示 + explorer 链接（本地链无 explorer 时只显示 hash） */
export function TxStatus({ tx }: { tx: TxState }) {
  if (tx.isPending) return <div className="small muted mt8 pulse">等待钱包确认…</div>;
  if (tx.isConfirming)
    return (
      <div className="small mt8 pulse" style={{ color: 'var(--amber)' }}>
        交易已发出，等待上链… {tx.hash && <TxLink hash={tx.hash} />}
      </div>
    );
  if (tx.isSuccess)
    return (
      <div className="banner ok mt8">✓ 交易成功 {tx.hash && <TxLink hash={tx.hash} />}</div>
    );
  if (tx.error)
    return (
      <div className="banner err mt8">✗ {tx.error.message.split('\n')[0].slice(0, 200)}</div>
    );
  return null;
}

export function TxLink({ hash }: { hash: string }) {
  const url = explorerTxUrl(hash);
  if (!url) return <span className="mono-box" style={{ display: 'inline' }}>{truncateHex(hash, 8, 6)}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {truncateHex(hash, 8, 6)} ↗
    </a>
  );
}
