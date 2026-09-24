'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@/components/ConnectButton';
import { StatCard } from '@/components/StatCard';
import { TxStatus } from '@/components/TxStatus';
import { WrongNetworkBanner } from '@/components/WrongNetwork';
import { useChallenge } from '@/hooks/useChallenge';
import { useMining } from '@/hooks/useMining';
import { useProtocolStats } from '@/hooks/useProtocolStats';
import { useMintTx } from '@/hooks/useTx';
import {
  expectedSeconds,
  formatCount,
  formatDuration,
  formatEth,
  formatHashrate,
  truncateHex,
} from '@/lib/format';

function statusLabel(status: string): { text: string; cls: string } {
  switch (status) {
    case 'mining':
      return { text: 'MINING', cls: 'ok' };
    case 'found':
      return { text: 'SOLUTION FOUND', cls: 'ok' };
    case 'initializing':
      return { text: 'INITIALIZING GPU', cls: 'warn' };
    case 'stopped':
      return { text: 'STOPPED', cls: 'warn' };
    case 'error':
      return { text: 'ERROR', cls: 'err' };
    default:
      return { text: 'IDLE', cls: '' };
  }
}

export default function MiningPage() {
  const { address, isConnected } = useAccount();
  const { data: challenge } = useChallenge();
  const { data: stats, refetch: refetchStats } = useProtocolStats();
  const mining = useMining(address);
  const mintTx = useMintTx();
  const queryClient = useQueryClient();

  // challenge 轮换：正在挖矿时自动用新 challenge 重启（保留已尝试计数）
  useEffect(() => {
    if (!challenge) return;
    if (
      mining.status === 'mining' &&
      mining.activeChallenge &&
      mining.activeChallenge.toLowerCase() !== challenge.challenge.toLowerCase()
    ) {
      mining.start(challenge.challenge, Number(challenge.bits), { keepAttempts: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.challenge]);

  // mint 成功后刷新统计并复位挖矿状态
  useEffect(() => {
    if (mintTx.isSuccess) {
      refetchStats();
      queryClient.invalidateQueries();
      mining.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintTx.isSuccess]);

  const bits = challenge ? Number(challenge.bits) : null;
  const expected = bits !== null ? expectedSeconds(bits, mining.stats.hashrate) : null;
  const mintReady = mining.status === 'found' && mining.verifyState === 'ok';
  const badge = statusLabel(mining.status);

  if (!isConnected) {
    return (
      <div>
        <WrongNetworkBanner />
        <div className="panel glow">
          <h2 className="panel-title">Protocol Overview</h2>
          <div className="grid cols-4">
            <StatCard
              label="Minted / Max"
              value={stats ? `${formatCount(stats.minted)} / ${formatCount(stats.maxMints)}` : '—'}
            />
            <StatCard label="Current Tier" value={stats ? stats.currentTier.toString() : '—'} />
            <StatCard
              label="Mint Price"
              value={stats ? `${formatEth(stats.currentMintDue)} ETH` : '—'}
            />
            <StatCard
              label="Difficulty"
              value={stats ? `${stats.currentBits.toString()} bits` : '—'}
            />
          </div>
          <div className="mt24" style={{ textAlign: 'center' }}>
            <p className="muted">
              连接钱包开始 PoW 挖矿。GPU 运算全部发生在本地浏览器（WebGPU Worker），
              找到合法 nonce 后由你手动确认 mint 交易。
            </p>
            <ConnectButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <WrongNetworkBanner />

      {!mining.webGpuSupported && (
        <div className="banner err">
          {mining.webGpuReason ?? 'WebGPU not available'} — Desktop GPU recommended，手机端不支持挖矿。
        </div>
      )}

      <div className="panel glow">
        <h2 className="panel-title">Mining Console</h2>

        <div className="mono-box mb16">
          challenge <span className="hl">{challenge ? truncateHex(challenge.challenge, 10, 8) : '…'}</span>
          {'  '}epoch <span className="hl">{challenge ? challenge.epoch.toString() : '…'}</span>
          {'  '}bits <span className="hl">{bits ?? '…'}</span>
          {'  '}price <span className="hl">{challenge ? `${formatEth(challenge.mintDue)} ETH` : '…'}</span>
          {'  '}minted{' '}
          <span className="hl">
            {stats ? `${formatCount(stats.minted)}/${formatCount(stats.maxMints)}` : '…'}
          </span>
        </div>

        <div className="grid cols-4">
          <div className="stat-card">
            <div className="stat-label">GPU Status</div>
            <div className="stat-value">
              <span className={`badge ${badge.cls}`}>{badge.text}</span>
            </div>
          </div>
          <StatCard label="Hashrate" value={formatHashrate(mining.stats.hashrate)} accent />
          <StatCard label="Nonce Attempts" value={formatCount(mining.stats.attempts)} />
          <StatCard
            label="Elapsed"
            value={formatDuration(mining.stats.elapsedMs / 1000)}
            sub={expected !== null ? `avg ≈ ${formatDuration(expected)}` : undefined}
          />
        </div>

        {mining.error && <div className="banner err mt16">✗ {mining.error}</div>}

        {mining.status === 'found' && mining.solution && (
          <div className="mt16">
            {mining.verifyState === 'checking' && (
              <div className="banner pulse">链上复核 solution 中（isValidNonce + challenge 未过期）…</div>
            )}
            {mining.verifyState === 'ok' && (
              <div className="banner ok">
                ✓ Solution verified — nonce {mining.solution.nonce.toString()}，hash{' '}
                {truncateHex(mining.solution.hash, 10, 8)}。点 MINT 提交交易。
              </div>
            )}
            {mining.verifyState === 'challenge-expired' && (
              <div className="banner err">
                Challenge expired — 链上 challenge 已轮换，该 nonce 失效。
                <button
                  className="btn amber sm"
                  onClick={() =>
                    challenge && mining.start(challenge.challenge, Number(challenge.bits))
                  }
                >
                  用新 challenge 重挖
                </button>
              </div>
            )}
            {mining.verifyState === 'failed' && (
              <div className="banner err">
                链上复核未通过（isValidNonce = false），请重新挖矿。
                <button
                  className="btn amber sm"
                  onClick={() =>
                    challenge && mining.start(challenge.challenge, Number(challenge.bits))
                  }
                >
                  重挖
                </button>
              </div>
            )}
          </div>
        )}

        <div className="btn-row mt16">
          {(mining.status === 'idle' ||
            mining.status === 'stopped' ||
            mining.status === 'error') && (
            <button
              className="btn primary"
              disabled={!challenge || !mining.webGpuSupported}
              onClick={() => challenge && mining.start(challenge.challenge, Number(challenge.bits))}
            >
              START MINING
            </button>
          )}
          {(mining.status === 'mining' || mining.status === 'initializing') && (
            <button className="btn danger" onClick={mining.stop}>
              STOP
            </button>
          )}
          <button
            className="btn primary"
            disabled={!mintReady || mintTx.isPending || mintTx.isConfirming}
            onClick={() => mining.solution && mintTx.send(mining.solution.nonce).catch(() => {})}
          >
            {mintTx.isPending || mintTx.isConfirming ? 'MINTING…' : 'MINT NFT'}
          </button>
        </div>

        <TxStatus tx={mintTx} />
      </div>

      <p className="small muted mt16">
        提示：epoch 每 {challenge ? formatDuration(Number(challenge.epochDuration)) : '…'} 轮换一次 challenge；
        旧 challenge 有 {challenge ? formatDuration(Number(challenge.gracePeriod)) : '…'} 宽限期。
        找到 nonce 后不会自动发交易，必须手动点 MINT。
      </p>
    </div>
  );
}
