'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { formatEther, parseAbiItem } from 'viem';
import { Countdown } from '@/components/Countdown';
import { StatCard } from '@/components/StatCard';
import { MINE_ADDRESS, PROTOCOL_CONFIG, TARGET_CHAIN_ID } from '@/config/contracts';
import { useProtocolStats } from '@/hooks/useProtocolStats';
import { formatCount, formatEth, truncateHex } from '@/lib/format';

const mintedEvent = parseAbiItem(
  'event Minted(address indexed user, uint256 indexed tokenId, uint64 nonce, uint256 tier, uint256 price)',
);
const challengeUpdatedEvent = parseAbiItem(
  'event ChallengeUpdated(uint256 indexed epoch, bytes32 challenge, uint256 startedAt, uint256 graceUntil)',
);

interface EventRow {
  kind: 'mint' | 'challenge';
  blockNumber: bigint;
  text: string;
}

function useRecentEvents() {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });
  return useQuery<EventRow[]>({
    queryKey: ['recentEvents', TARGET_CHAIN_ID],
    enabled: Boolean(client),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!client) throw new Error('public client unavailable');
      const latest = await client.getBlockNumber();
      const fromBlock = latest > 5000n ? latest - 5000n : 0n;
      const logs = await client.getLogs({
        address: MINE_ADDRESS,
        events: [mintedEvent, challengeUpdatedEvent],
        fromBlock,
        toBlock: latest,
      });
      const rows: EventRow[] = [];
      for (const log of logs) {
        if (log.eventName === 'Minted') {
          const a = log.args;
          rows.push({
            kind: 'mint',
            blockNumber: log.blockNumber,
            text: `Minted #${a.tokenId?.toString() ?? '?'} by ${truncateHex(a.user ?? '', 4, 4)} · tier ${a.tier?.toString() ?? '?'} · ${formatEther(a.price ?? 0n)} ETH`,
          });
        } else if (log.eventName === 'ChallengeUpdated') {
          const a = log.args;
          rows.push({
            kind: 'challenge',
            blockNumber: log.blockNumber,
            text: `ChallengeUpdated epoch ${a.epoch?.toString() ?? '?'} · ${truncateHex(a.challenge ?? '', 6, 4)}`,
          });
        }
      }
      // 最新在前，最多 50 条
      return rows.sort((x, y) => Number(y.blockNumber - x.blockNumber)).slice(0, 50);
    },
  });
}

export default function StatsPage() {
  const { data: stats } = useProtocolStats();
  const { data: events } = useRecentEvents();

  const epochEnd = stats ? stats.epochStart + stats.epochDuration : null;
  const minted = stats?.minted ?? 0n;
  const maxMints = stats?.maxMints ?? BigInt(PROTOCOL_CONFIG.maxMints);
  const remaining = maxMints > minted ? maxMints - minted : 0n;
  const currentTier = stats ? Number(stats.currentTier) : null;

  const tierCount = Math.ceil(PROTOCOL_CONFIG.maxMints / PROTOCOL_CONFIG.tierSize);

  return (
    <div>
      <div className="panel glow">
        <h2 className="panel-title">Protocol Dashboard</h2>
        <div className="grid cols-4">
          <StatCard label="Minted" value={formatCount(minted)} />
          <StatCard label="Remaining" value={formatCount(remaining)} />
          <StatCard
            label="Current Price"
            value={stats ? `${formatEth(stats.currentMintDue)} ETH` : '—'}
            accent
          />
          <StatCard label="Current Bits" value={stats ? stats.currentBits.toString() : '—'} />
          <StatCard label="Epoch" value={stats ? stats.epoch.toString() : '—'} />
          <div className="stat-card">
            <div className="stat-label">Epoch Ends In</div>
            <div className="stat-value">
              {epochEnd ? <Countdown targetUnixSec={epochEnd} /> : '—'}
            </div>
            <div className="stat-sub">到期后任何人可触发 rotate()</div>
          </div>
          <StatCard
            label="Rewards Balance"
            value={stats ? `${formatEth(stats.rewardsBalance)} ETH` : '—'}
          />
          <StatCard
            label="Treasury Accrued"
            value={stats ? `${formatEth(stats.treasuryAccrued)} ETH` : '—'}
            sub="treasury 收款失败时暂记的待领金额（另有已直付部分）"
          />
          <StatCard
            label="Total Staked (Weight)"
            value={stats ? formatCount(stats.totalWeight) : '—'}
          />
          <StatCard
            label="Undistributed"
            value={stats ? `${formatEth(stats.undistributed)} ETH` : '—'}
          />
        </div>
      </div>

      <div className="panel mt16">
        <h2 className="panel-title">Mining Difficulty History</h2>
        <p className="small muted">
          每 {PROTOCOL_CONFIG.tierSize} 张升一档：bits +{PROTOCOL_CONFIG.bitsPerTier}，价格 ×2
          （price = startPrice &lt;&lt; tier）。
          当前：tier {currentTier ?? '…'}，{stats ? `${stats.currentBits.toString()} bits` : '…'}。
        </p>
        <table className="table mt8">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Token Range</th>
              <th>Bits</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: tierCount }, (_, tier) => {
              const from = tier * PROTOCOL_CONFIG.tierSize + 1;
              const to = Math.min((tier + 1) * PROTOCOL_CONFIG.tierSize, PROTOCOL_CONFIG.maxMints);
              const bits = PROTOCOL_CONFIG.baseBits + tier * PROTOCOL_CONFIG.bitsPerTier;
              const price = PROTOCOL_CONFIG.startPriceWei << BigInt(tier);
              return (
                <tr key={tier} className={currentTier === tier ? 'current' : ''}>
                  <td>{tier}</td>
                  <td>
                    #{from} – #{to}
                  </td>
                  <td>{bits}</td>
                  <td>{formatEth(price)} ETH</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="panel mt16">
        <h2 className="panel-title">Recent Events（最近 5000 块，最多 50 条）</h2>
        {!events || events.length === 0 ? (
          <p className="muted small">暂无事件。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.blockNumber.toString()}-${i}`}>
                  <td className="muted">{e.blockNumber.toString()}</td>
                  <td className={e.kind === 'mint' ? '' : 'muted'}>{e.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
