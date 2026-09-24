import { encodePacked, keccak256, type Address, type Hex } from 'viem';
import type { MineSolution } from './types';

/**
 * 纯 JS 本地复核：用 viem 的 keccak256 重算 PoW 消息，
 * 与合约 Mine.isValidForChallenge 及 WGSL shader 的消息格式完全一致：
 *   message = challenge[32B] ‖ address[20B] ‖ nonce[uint64 大端 8B]（60 字节）
 *   valid   = keccak256(message) 按大端视为 uint256，高 bits 位全 0
 */
export function computePowHash(challenge: Hex, address: Address, nonce: bigint): Hex {
  return keccak256(encodePacked(['bytes32', 'address', 'uint64'], [challenge, address, nonce]));
}

/** hash（大端 uint256）的高 bits 位是否全 0 */
export function meetsBits(hash: Hex, bits: number): boolean {
  if (bits <= 0) return true;
  if (bits >= 256) return BigInt(hash) === 0n;
  return BigInt(hash) >> BigInt(256 - bits) === 0n;
}

export interface LocalCheckResult {
  ok: boolean;
  reason?: string;
}

/** GPU 结果的本地复核：hash 重算一致 + 难度达标 + challenge 匹配 */
export function verifySolutionLocally(
  solution: MineSolution,
  address: Address,
  expectedChallenge: string,
): LocalCheckResult {
  if (solution.challenge.toLowerCase() !== expectedChallenge.toLowerCase()) {
    return { ok: false, reason: 'challenge-mismatch' };
  }
  const recomputed = computePowHash(
    solution.challenge as Hex,
    address,
    solution.nonce,
  );
  if (recomputed.toLowerCase() !== solution.hash.toLowerCase()) {
    return { ok: false, reason: 'hash-mismatch' };
  }
  if (!meetsBits(recomputed, solution.bits)) {
    return { ok: false, reason: 'bits-not-met' };
  }
  return { ok: true };
}
