/**
 * 提交前校验（链上）：challenge 未过期 + isValidNonce 通过。
 * 实现在 challenge.ts 的 verifySolutionOnChain；本模块保留为独立出口，
 * 便于调用方按"本地复核 hash.ts -> 链上复核 verify.ts"的语义引用。
 */
export { verifySolutionOnChain, fetchCurrentMintDue } from './challenge';
export type { ChainVerifyResult } from './challenge';
