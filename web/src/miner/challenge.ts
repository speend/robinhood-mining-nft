import type { Address, Hex, PublicClient } from 'viem';
import { mineAbi } from '@/config/abis';
import { MINE_ADDRESS, TARGET_CHAIN_ID } from '@/config/contracts';

export interface ChallengeState {
  challenge: Hex;
  previousChallenge: Hex;
  previousValidUntil: bigint;
  epoch: bigint;
  epochStart: bigint;
  epochDuration: bigint;
  gracePeriod: bigint;
  bits: bigint;
  mintDue: bigint;
}

/** 一次性读取当前 challenge 相关状态（useChallenge hook 里用 react-query 轮询） */
export async function fetchChallengeState(client: PublicClient): Promise<ChallengeState> {
  const results = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'currentChallenge' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'previousChallenge' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'previousValidUntil' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'epoch' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'epochStart' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'epochDuration' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'gracePeriod' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'currentBits' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'currentMintDue' },
    ],
  });
  const [
    challenge,
    previousChallenge,
    previousValidUntil,
    epoch,
    epochStart,
    epochDuration,
    gracePeriod,
    bits,
    mintDue,
  ] = results as [Hex, Hex, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return {
    challenge,
    previousChallenge,
    previousValidUntil,
    epoch,
    epochStart,
    epochDuration,
    gracePeriod,
    bits,
    mintDue,
  };
}

/** 提交 mint 前重读当前价格（msg.value 必须精确等于 currentMintDue()） */
export async function fetchCurrentMintDue(client: PublicClient): Promise<bigint> {
  return (await client.readContract({
    address: MINE_ADDRESS,
    abi: mineAbi,
    functionName: 'currentMintDue',
  })) as bigint;
}

export interface ChainVerifyResult {
  ok: boolean;
  reason?: 'challenge-expired' | 'invalid-nonce';
}

/** 提交前链上复核：challenge 未轮换（或在宽限期内仍有效）+ PoW 校验通过 */
export async function verifySolutionOnChain(
  client: PublicClient,
  params: { challenge: Hex; address: Address; nonce: bigint; bits: number },
): Promise<ChainVerifyResult> {
  const [currentChallenge, previousChallenge, previousValidUntil] = (await client.multicall({
    allowFailure: false,
    contracts: [
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'currentChallenge' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'previousChallenge' },
      { address: MINE_ADDRESS, abi: mineAbi, functionName: 'previousValidUntil' },
    ],
  })) as [Hex, Hex, bigint];

  const mined = params.challenge.toLowerCase();
  let challengeOk = currentChallenge.toLowerCase() === mined;

  if (!challengeOk) {
    // 宽限期路径：挖的是上一代 challenge，且仍在 grace 内 → 合约 mint 也会接受
    const now = BigInt(Math.floor(Date.now() / 1000));
    const inGrace =
      previousChallenge.toLowerCase() === mined && previousValidUntil > 0n && now <= previousValidUntil;
    if (!inGrace) return { ok: false, reason: 'challenge-expired' };
    const validPrev = (await client.readContract({
      address: MINE_ADDRESS,
      abi: mineAbi,
      functionName: 'isValidForChallenge',
      args: [params.challenge, params.address, params.nonce, BigInt(params.bits)],
    })) as boolean;
    return validPrev ? { ok: true } : { ok: false, reason: 'invalid-nonce' };
  }

  const valid = (await client.readContract({
    address: MINE_ADDRESS,
    abi: mineAbi,
    functionName: 'isValidNonce',
    args: [params.address, params.nonce, BigInt(params.bits)],
  })) as boolean;
  return valid ? { ok: true } : { ok: false, reason: 'invalid-nonce' };
}
