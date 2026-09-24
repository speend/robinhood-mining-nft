/**
 * WebGPU 共享常量与编码工具。
 * 真正的 device/pipeline 生命周期在 miner.worker.ts（GPU 挖矿必须跑在 Worker，
 * 主线程零阻塞）；这里放主线程也会用到的东西：能力检测、uniform 布局编码、
 * hash 展示格式。
 */

export const WGSL_URL = '/miner/keccak_miner.wgsl';
export const THREADS = 1 << 20; // 每轮 dispatch 线程数
export const ITER = 256; // 与 shader 里的 ITER 保持一致
export const WORKGROUP_SIZE = 64; // 与 shader @workgroup_size(64) 一致
/** keccak256("")，shader selftest entrypoint 的预期输出 */
export const EXPECT_EMPTY_KECCAK =
  'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

export interface WebGpuSupport {
  supported: boolean;
  reason?: string;
}

/** 主线程能力检测（worker 内初始化失败也会走 error 消息上报） */
export function checkWebGpuSupport(): WebGpuSupport {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return {
      supported: false,
      reason: 'WebGPU not available — 请使用桌面版 Chrome / Edge。手机端不支持挖矿。',
    };
  }
  return { supported: true };
}

/** 地址 hex -> 5 个 u32（按 hex 字符串顺序每 8 字符一个 u32，与 WGSL uniform 布局一致） */
export function parseAddressWords(address: string): number[] {
  const h = address.replace(/^0x/i, '').padStart(40, '0');
  return [0, 1, 2, 3, 4].map((i) => parseInt(h.slice(i * 8, (i + 1) * 8), 16) >>> 0);
}

/** challenge hex -> 8 个 u32（同法） */
export function parseChallengeWords(challenge: string): number[] {
  const h = challenge.replace(/^0x/i, '').padStart(64, '0');
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => parseInt(h.slice(i * 8, (i + 1) * 8), 16) >>> 0);
}

/**
 * uniform Params（20 个 u32，80 字节，与 shader 严格一致）：
 * [ch0..ch7, addr0..addr4, nonce_lo, nonce_hi, bits, stride, pad0, pad1, pad2]
 */
export function buildParams(
  challenge: string,
  address: string,
  baseNonce: bigint,
  bits: number,
  stride: number,
): Uint32Array<ArrayBuffer> {
  const ch = parseChallengeWords(challenge);
  const addr = parseAddressWords(address);
  const lo = Number(baseNonce & 0xffffffffn);
  const hi = Number((baseNonce >> 32n) & 0xffffffffn);
  return new Uint32Array([...ch, ...addr, lo, hi, bits, stride, 0, 0, 0]);
}

/**
 * 把 shader 输出的 8 个 u32 lane 转成 hash hex。
 * 与 miner-reference/grinder.html 保持一致：每个 u32 按小端字节序输出（低字节在前）。
 */
export function hexFromWords(words: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const x = words[i];
    s +=
      (x & 255).toString(16).padStart(2, '0') +
      ((x >> 8) & 255).toString(16).padStart(2, '0') +
      ((x >> 16) & 255).toString(16).padStart(2, '0') +
      ((x >>> 24) & 255).toString(16).padStart(2, '0');
  }
  return s;
}
