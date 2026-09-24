'use client';

import { useEffect, useState } from 'react';

/** 到 targetUnixSec（秒）的倒计时文本，每秒刷新 */
export function Countdown({ targetUnixSec }: { targetUnixSec: bigint }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const remain = Number(targetUnixSec) - now;
  if (remain <= 0) return <span style={{ color: 'var(--accent)' }}>已解锁</span>;
  const d = Math.floor(remain / 86400);
  const h = Math.floor((remain % 86400) / 3600);
  const m = Math.floor((remain % 3600) / 60);
  const s = remain % 60;
  const text =
    d > 0
      ? `${d}d ${h}h ${m}m`
      : h > 0
        ? `${h}h ${m}m ${s}s`
        : m > 0
          ? `${m}m ${s}s`
          : `${s}s`;
  return <span>{text}</span>;
}

export function useNowSec(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
