/**
 * GPU 挖矿 Worker —— 所有 WebGPU dispatch 都在这里跑，主线程零阻塞。
 *
 * 消息协议（见 types.ts）：
 *   in : { type:'start', challenge, address, bits, startNonce } / { type:'stop' }
 *   out: { type:'selftest-ok' } / { type:'progress', stats } /
 *        { type:'found', solution } / { type:'stopped' } / { type:'error', message }
 *
 * WGSL / buffer 布局与 miner-reference/grinder.html 完全一致：
 *   found(16B storage) | result(48B storage) | uniform(80B) | readback(256B MAP_READ)
 *   每轮 dispatch 覆盖 THREADS*ITER 个 nonce，之后 nonce base += THREADS*ITER。
 */
import {
  EXPECT_EMPTY_KECCAK,
  ITER,
  THREADS,
  WGSL_URL,
  WORKGROUP_SIZE,
  buildParams,
  hexFromWords,
} from './webgpu';
import type { WorkerInMessage, WorkerOutMessage } from './types';

export {};

// tsconfig 使用 dom lib（页面代码为主），DedicatedWorkerGlobalScope 在 webworker lib 中，
// 两者混用会冲突，这里只声明 worker 需要的最小接口
interface WorkerScope {
  postMessage(msg: WorkerOutMessage): void;
  onmessage: ((e: MessageEvent<WorkerInMessage>) => void) | null;
}
declare const self: WorkerScope;

function post(msg: WorkerOutMessage): void {
  self.postMessage(msg);
}

interface GpuContext {
  device: GPUDevice;
  grindPipe: GPUComputePipeline;
  selfPipe: GPUComputePipeline;
  foundBuf: GPUBuffer;
  resultBuf: GPUBuffer;
  uniBuf: GPUBuffer;
  readBuf: GPUBuffer;
}

let gpu: GpuContext | null = null;
let initPromise: Promise<GpuContext> | null = null;
let running = false;
let runId = 0;

async function init(): Promise<GpuContext> {
  if (gpu) return gpu;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!navigator.gpu) {
      throw new Error('浏览器不支持 WebGPU（请用桌面版 Chrome / Edge，手机端不支持挖矿）');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('没有找到可用的 GPU adapter');
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => {
      post({ type: 'error', message: `GPU error: ${e.error.message}` });
    });

    const res = await fetch(WGSL_URL);
    if (!res.ok) throw new Error(`WGSL 加载失败: HTTP ${res.status}`);
    const code = await res.text();
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      throw new Error(
        'WGSL 编译失败: ' + errors.map((m) => `L${m.lineNum}: ${m.message}`).join('; '),
      );
    }

    const ctx: GpuContext = {
      device,
      foundBuf: device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
      resultBuf: device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      uniBuf: device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      readBuf: device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      grindPipe: device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'grind' },
      }),
      selfPipe: device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'selftest' },
      }),
    };

    await selftest(ctx);
    gpu = ctx;
    return ctx;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/** keccak 自检：selftest entrypoint 的输出必须等于 keccak256("") */
async function selftest(ctx: GpuContext): Promise<void> {
  const bg = ctx.device.createBindGroup({
    layout: ctx.selfPipe.getBindGroupLayout(0),
    entries: [{ binding: 1, resource: { buffer: ctx.resultBuf } }],
  });
  const enc = ctx.device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(ctx.selfPipe);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(1);
  pass.end();
  enc.copyBufferToBuffer(ctx.resultBuf, 0, ctx.readBuf, 0, 32);
  ctx.device.queue.submit([enc.finish()]);

  await ctx.readBuf.mapAsync(GPUMapMode.READ);
  const words = new Uint32Array(ctx.readBuf.getMappedRange().slice(0, 32));
  ctx.readBuf.unmap();

  const hex = hexFromWords(words);
  if (hex !== EXPECT_EMPTY_KECCAK) {
    throw new Error(`keccak 自检失败: ${hex}（应为 ${EXPECT_EMPTY_KECCAK}）`);
  }
}

async function grind(
  ctx: GpuContext,
  id: number,
  params: { challenge: string; address: string; bits: number; startNonce: bigint },
): Promise<void> {
  const grindBg = ctx.device.createBindGroup({
    layout: ctx.grindPipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: ctx.foundBuf } },
      { binding: 1, resource: { buffer: ctx.resultBuf } },
      { binding: 2, resource: { buffer: ctx.uniBuf } },
    ],
  });

  let base = params.startNonce;
  let attempts = 0n;
  const t0 = performance.now();
  let lastProgress = 0;
  const batchSize = BigInt(THREADS) * BigInt(ITER);

  while (running && id === runId) {
    ctx.device.queue.writeBuffer(
      ctx.uniBuf,
      0,
      buildParams(params.challenge, params.address, base, params.bits, THREADS),
    );
    ctx.device.queue.writeBuffer(ctx.foundBuf, 0, new Uint32Array([0]));

    const enc = ctx.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(ctx.grindPipe);
    pass.setBindGroup(0, grindBg);
    pass.dispatchWorkgroups(THREADS / WORKGROUP_SIZE);
    pass.end();
    enc.copyBufferToBuffer(ctx.foundBuf, 0, ctx.readBuf, 0, 4);
    enc.copyBufferToBuffer(ctx.resultBuf, 0, ctx.readBuf, 16, 48);
    ctx.device.queue.submit([enc.finish()]);

    await ctx.readBuf.mapAsync(GPUMapMode.READ);
    const view = new Uint32Array(ctx.readBuf.getMappedRange().slice(0, 64));
    ctx.readBuf.unmap();

    attempts += batchSize;

    if (view[0] !== 0) {
      // result[0..7] = hash lanes，result[8..9] = nonce lo/hi，result[10] = bits
      const r = view.slice(4, 16);
      const nonce = (BigInt(r[9]) << 32n) | BigInt(r[8]);
      const hash = '0x' + hexFromWords(r.slice(0, 8));
      post({
        type: 'found',
        solution: {
          nonce: nonce.toString(),
          hash,
          bits: r[10],
          challenge: params.challenge,
        },
      });
      running = false;
      return;
    }

    base += batchSize;

    const elapsedMs = performance.now() - t0;
    if (elapsedMs - lastProgress >= 500) {
      lastProgress = elapsedMs;
      post({
        type: 'progress',
        stats: {
          hashrate: elapsedMs > 0 ? Number(attempts) / (elapsedMs / 1000) : 0,
          attempts: attempts.toString(),
          elapsedMs: Math.round(elapsedMs),
        },
      });
    }
  }

  post({ type: 'stopped' });
}

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    running = false;
    runId += 1; // 让进行中的 grind 循环失效
    return;
  }
  if (msg.type === 'start') {
    runId += 1;
    const id = runId;
    running = true;
    init()
      .then((ctx) => {
        if (id !== runId) return; // init 期间已被 stop/重新 start
        post({ type: 'selftest-ok' });
        return grind(ctx, id, {
          challenge: msg.challenge,
          address: msg.address,
          bits: msg.bits,
          startNonce: BigInt(msg.startNonce),
        });
      })
      .catch((err: unknown) => {
        running = false;
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  }
};
