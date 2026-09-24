/** Miner 共享类型（主线程与 Web Worker 之间的消息协议也在这里） */

export type MiningStatus =
  | 'idle'
  | 'initializing'
  | 'mining'
  | 'found'
  | 'stopped'
  | 'error';

export interface MineSolution {
  nonce: bigint;
  /** keccak256(challenge ‖ address ‖ nonce)，0x 前缀 hex */
  hash: string;
  bits: number;
  /** 挖出该 nonce 时使用的 challenge（0x 前缀 hex） */
  challenge: string;
}

export interface MinerStats {
  /** 哈希速率，单位 H/s */
  hashrate: number;
  /** 已尝试 nonce 总数 */
  attempts: bigint;
  elapsedMs: number;
}

/** 主线程 -> Worker */
export type WorkerInMessage =
  | {
      type: 'start';
      challenge: string;
      address: string;
      bits: number;
      /** 十进制字符串（bigint 不能直接进 postMessage 的类型推导，序列化更稳） */
      startNonce: string;
    }
  | { type: 'stop' };

/** Worker -> 主线程 */
export type WorkerOutMessage =
  | { type: 'selftest-ok' }
  | { type: 'progress'; stats: { hashrate: number; attempts: string; elapsedMs: number } }
  | {
      type: 'found';
      solution: { nonce: string; hash: string; bits: number; challenge: string };
    }
  | { type: 'stopped' }
  | { type: 'error'; message: string };
