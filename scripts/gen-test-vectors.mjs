// 生成 ChallengePoW 的跨实现测试向量（viem/JS ↔ Solidity）
// 用法: node scripts/gen-test-vectors.mjs
// 输出: contracts/spike/test-vectors.json（被 forge test 读取校验）
import { keccak256, encodePacked } from 'viem';
import { writeFileSync } from 'fs';

const cases = [
  {
    name: 'main-case',
    challenge: '0x' + '00'.repeat(31) + 'aa',
    user: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    nonce: 230690464n,
  },
  {
    name: 'all-zero',
    challenge: '0x' + '00'.repeat(32),
    user: '0x0000000000000000000000000000000000000000',
    nonce: 0n,
  },
  {
    name: 'max-nonce',
    challenge: '0x' + 'ff'.repeat(32),
    user: '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF',
    nonce: 18446744073709551615n, // uint64 max
  },
];

// 追加一个"正向命中"用例：JS 端搜索 8 bits 有效 nonce，Solidity 端必须同样判定有效
{
  const ch = '0x' + '00'.repeat(31) + 'aa';
  const usr = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  for (let n = 0n; n < 100000n; n++) {
    const h = BigInt(keccak256(encodePacked(['bytes32', 'address', 'uint64'], [ch, usr, n])));
    if ((h >> 248n) === 0n) {
      cases.push({ name: 'js-found-valid-8bits', challenge: ch, user: usr, nonce: n });
      break;
    }
  }
}

const vectors = cases.map((c) => {
  const hash = keccak256(encodePacked(['bytes32', 'address', 'uint64'], [c.challenge, c.user, c.nonce]));
  const h = BigInt(hash);
  return {
    name: c.name,
    challenge: c.challenge,
    user: c.user,
    nonce: c.nonce.toString(),
    hash,
    validAt8: (h >> 248n) === 0n,
    validAt16: (h >> 240n) === 0n,
  };
});

writeFileSync(
  new URL('../contracts/spike/test-vectors.json', import.meta.url),
  JSON.stringify({ vectors }, null, 2) + '\n'
);
console.log('written contracts/spike/test-vectors.json');
for (const v of vectors) console.log(v.name, v.hash, 'valid@8:', v.validAt8, 'valid@16:', v.validAt16);
