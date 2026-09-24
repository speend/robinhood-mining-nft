'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import type { MinerStats, MineSolution, MiningStatus, WorkerOutMessage } from '@/miner/types';
import { verifySolutionLocally } from '@/miner/hash';
import { verifySolutionOnChain } from '@/miner/verify';
import { checkWebGpuSupport } from '@/miner/webgpu';
import { TARGET_CHAIN_ID } from '@/config/contracts';

export type VerifyState = 'idle' | 'checking' | 'ok' | 'challenge-expired' | 'failed';

export interface MiningController {
  status: MiningStatus;
  stats: MinerStats;
  solution: MineSolution | null;
  /** 本地 + 链上复核状态；只有 'ok' 时才允许点 MINT */
  verifyState: VerifyState;
  error: string | null;
  webGpuSupported: boolean;
  webGpuReason?: string;
  /** 当前挖矿使用的 challenge（用于检测 challenge 轮换） */
  activeChallenge: string | null;
  start: (challenge: string, bits: number, opts?: { keepAttempts?: boolean }) => void;
  stop: () => void;
  /** mint 成功或放弃当前 solution 后重置 */
  reset: () => void;
}

const ZERO_STATS: MinerStats = { hashrate: 0, attempts: 0n, elapsedMs: 0 };

export function useMining(address: Address | undefined): MiningController {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });
  const workerRef = useRef<Worker | null>(null);
  const [status, setStatus] = useState<MiningStatus>('idle');
  const [stats, setStats] = useState<MinerStats>(ZERO_STATS);
  const [solution, setSolution] = useState<MineSolution | null>(null);
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeChallenge, setActiveChallenge] = useState<string | null>(null);
  const addressRef = useRef(address);
  addressRef.current = address;
  const clientRef = useRef(client);
  clientRef.current = client;

  const [support] = useState(() => checkWebGpuSupport());

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    workerRef.current?.postMessage({ type: 'stop' });
  }, []);

  const reset = useCallback(() => {
    workerRef.current?.postMessage({ type: 'stop' });
    setStatus('idle');
    setSolution(null);
    setVerifyState('idle');
    setError(null);
    setStats(ZERO_STATS);
    setActiveChallenge(null);
  }, []);

  const handleWorkerMessage = useCallback((msg: WorkerOutMessage) => {
    switch (msg.type) {
      case 'selftest-ok':
        setStatus((s) => (s === 'initializing' ? 'mining' : s));
        break;
      case 'progress':
        setStats({
          hashrate: msg.stats.hashrate,
          attempts: BigInt(msg.stats.attempts),
          elapsedMs: msg.stats.elapsedMs,
        });
        setStatus((s) => (s === 'initializing' ? 'mining' : s));
        break;
      case 'found': {
        const addr = addressRef.current;
        const sol: MineSolution = {
          nonce: BigInt(msg.solution.nonce),
          hash: msg.solution.hash,
          bits: msg.solution.bits,
          challenge: msg.solution.challenge,
        };
        // 1) 本地复核（viem keccak256 重算）
        if (!addr || !verifySolutionLocally(sol, addr, sol.challenge).ok) {
          setStatus('error');
          setError('GPU 结果本地复核失败（hash 重算不一致），请重试');
          return;
        }
        setSolution(sol);
        setStatus('found');
        // 2) 链上复核：challenge 未轮换 + isValidNonce 通过，通过后才点亮 MINT
        setVerifyState('checking');
        const c = clientRef.current;
        if (!c) {
          setVerifyState('failed');
          return;
        }
        verifySolutionOnChain(c, {
          challenge: sol.challenge as `0x${string}`,
          address: addr,
          nonce: sol.nonce,
          bits: sol.bits,
        })
          .then((r) => {
            setVerifyState(
              r.ok ? 'ok' : r.reason === 'challenge-expired' ? 'challenge-expired' : 'failed',
            );
          })
          .catch(() => setVerifyState('failed'));
        break;
      }
      case 'stopped':
        setStatus((s) => (s === 'mining' || s === 'initializing' ? 'stopped' : s));
        break;
      case 'error':
        setStatus('error');
        setError(msg.message);
        break;
    }
  }, []);

  const start = useCallback(
    (challenge: string, bits: number, opts?: { keepAttempts?: boolean }) => {
      const addr = addressRef.current;
      if (!addr) {
        setError('请先连接钱包');
        return;
      }
      if (!support.supported) {
        setStatus('error');
        setError(support.reason ?? 'WebGPU not available');
        return;
      }
      if (!workerRef.current) {
        const w = new Worker(new URL('../miner/miner.worker.ts', import.meta.url));
        w.onmessage = (e: MessageEvent<WorkerOutMessage>) => handleWorkerMessage(e.data);
        w.onerror = (e) => {
          setStatus('error');
          setError(e.message || 'Worker error');
        };
        workerRef.current = w;
      }
      setError(null);
      setSolution(null);
      setVerifyState('idle');
      setActiveChallenge(challenge);
      // challenge 轮换后重挖时保留已尝试计数
      setStats((prev) => (opts?.keepAttempts ? { ...prev, hashrate: 0, elapsedMs: 0 } : ZERO_STATS));
      setStatus('initializing');
      workerRef.current.postMessage({
        type: 'start',
        challenge,
        address: addr,
        bits,
        startNonce: '0',
      });
    },
    [handleWorkerMessage, support],
  );

  return {
    status,
    stats,
    solution,
    verifyState,
    error,
    webGpuSupported: support.supported,
    webGpuReason: support.reason,
    activeChallenge,
    start,
    stop,
    reset,
  };
}
