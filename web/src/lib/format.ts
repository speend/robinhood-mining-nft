import { formatEther } from 'viem';

export function truncateHex(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head + 2)}…${hex.slice(-tail)}`;
}

export function formatEth(wei: bigint, maxDecimals = 6): string {
  const s = formatEther(wei);
  const [int, frac] = s.split('.');
  if (!frac) return int;
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : int;
}

export function formatHashrate(hps: number): string {
  if (!Number.isFinite(hps) || hps <= 0) return '0 H/s';
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(1)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} KH/s`;
  return `${hps.toFixed(0)} H/s`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return '—';
  if (totalSeconds < 0) totalSeconds = 0;
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 预期平均时间：2^bits / hashrate（秒） */
export function expectedSeconds(bits: number, hashrate: number): number {
  if (hashrate <= 0) return Number.POSITIVE_INFINITY;
  return Math.pow(2, bits) / hashrate;
}

export function formatCount(n: bigint): string {
  return n.toLocaleString('en-US');
}
