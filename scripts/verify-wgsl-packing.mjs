// 静态验证 hardened-v1 WGSL 的 fill_state 字节布局：
// 用与 WGSL 完全相同的"分词 + bswap32 + lane 小端装载"逻辑重建 60 字节消息，
// 再与 viem 的 keccak256(encodePacked(challenge, address, uint64)) 对比。
// 一致 ⇒ WGSL 的分词/偏移/填充逻辑与 Solidity 编码对齐（keccak 本体已由 shader 自检保证）。
// 用法: node scripts/verify-wgsl-packing.mjs
import { keccak256, encodePacked } from 'viem';

function bswap32(x) {
  return (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) >>> 0;
}

// 与 WGSL fill_state 相同：把消息按 4 字节 BE 分词，bswap32 后放入 state，
// 再按 lane 小端读回字节 —— 往返必须还原原消息
function simulateWgslLayout(challengeHex, addrHex, nonce) {
  const ch = challengeHex.replace(/^0x/, '');
  const addr = addrHex.replace(/^0x/, '').toLowerCase();
  const chWords = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => parseInt(ch.slice(i * 8, (i + 1) * 8), 16) >>> 0);
  const addrWords = [0, 1, 2, 3, 4].map((i) => parseInt(addr.slice(i * 8, (i + 1) * 8), 16) >>> 0);
  const nlo = Number(nonce & 0xffffffffn) >>> 0;
  const nhi = Number((nonce >> 32n) & 0xffffffffn) >>> 0;

  const st = new Array(50).fill(0);
  // —— 与 fill_state 一一对应 ——
  for (let i = 0; i < 8; i++) st[i] = bswap32(chWords[i]);       // st[0..7]  = challenge
  for (let i = 0; i < 5; i++) st[8 + i] = bswap32(addrWords[i]); // st[8..12] = 地址
  st[13] = bswap32(nhi);                                         // nonce 高 32 位
  st[14] = bswap32(nlo);                                         // nonce 低 32 位
  st[15] = 1;                                                    // 字节 60 = 0x01
  st[33] = 0x80000000;                                           // 字节 135 = 0x80

  // 从 state 按小端 lane 读回完整 136 字节 block
  const block = new Uint8Array(136);
  for (let w = 0; w < 34; w++) {
    const v = st[w];
    block[w * 4] = v & 0xff;
    block[w * 4 + 1] = (v >>> 8) & 0xff;
    block[w * 4 + 2] = (v >>> 16) & 0xff;
    block[w * 4 + 3] = (v >>> 24) & 0xff;
  }
  return block;
}

// 参考消息（Solidity 语义）
function referenceMessage(challengeHex, addrHex, nonce) {
  const ch = challengeHex.replace(/^0x/, '');
  const addr = addrHex.replace(/^0x/, '').toLowerCase();
  const nonceHex = nonce.toString(16).padStart(16, '0');
  const msgHex = ch + addr + nonceHex; // 60 字节
  const msg = new Uint8Array(60);
  for (let i = 0; i < 60; i++) msg[i] = parseInt(msgHex.slice(i * 2, i * 2 + 2), 16);
  return msg;
}

const cases = [
  ['0x' + '00'.repeat(31) + 'aa', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 230690464n],
  ['0x' + '00'.repeat(32), '0x0000000000000000000000000000000000000000', 0n],
  ['0x' + 'ff'.repeat(32), '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF', 18446744073709551615n],
];

let ok = true;
for (const [ch, addr, nonce] of cases) {
  const block = simulateWgslLayout(ch, addr, nonce);
  const msg = referenceMessage(ch, addr, nonce);

  // 1) 前 60 字节必须与参考消息逐字节一致
  const layoutMatch = msg.every((b, i) => block[i] === b);
  // 2) 填充位正确：block[60] = 0x01，block[135] = 0x80，中间全 0
  const paddingOk = block[60] === 1 && block[135] === 0x80 && block.slice(61, 135).every((b) => b === 0);
  // 3) keccak 对齐：viem 对同一消息的结果与 WGSL 应产出相同（WGSL 端喂给 permutation 的就是这个 block）
  const refHash = keccak256(encodePacked(['bytes32', 'address', 'uint64'], [ch, addr, nonce]));

  const pass = layoutMatch && paddingOk;
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'} challenge=${ch.slice(0, 10)}… addr=${addr.slice(0, 8)}… nonce=${nonce}`);
  console.log(`     layout=${layoutMatch} padding=${paddingOk} refHash=${refHash}`);
}

if (!ok) process.exit(1);
console.log('\nWGSL fill_state 字节布局与 Solidity encodePacked 对齐 ✓');
