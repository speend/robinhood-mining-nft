// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChallengePoW — Domain-Separated Challenge 机制 Spike（非生产合约，仅机制验证）
/// @notice 目标：证明以下机制在 EVM 上成立，再移植进 Mine.sol
///   1. challenge 绑定 chainId + 合约地址 + epoch + 不可预测种子 → 防预计算/跨链/跨合约复用
///   2. epoch 定期轮换，种子在轮换区块前不可知
///   3. 旧 challenge 有短宽限期，避免在挖工作瞬间作废
///   4. nonce 绑定 msg.sender + nonceUsed 防重放
/// @dev 消息格式（60 字节，单 block keccak，136B rate 内）：
///      abi.encodePacked(challenge[32B], user[20B], nonce[uint64 大端 8B])
contract ChallengePoW {
    uint256 public immutable epochDuration;
    uint256 public immutable gracePeriod;

    uint256 public epoch;
    uint256 public epochStart;
    uint256 public epochSeed;
    bytes32 public currentChallenge;
    bytes32 public previousChallenge;
    uint256 public previousValidUntil; // 旧 challenge 宽限截止时间

    mapping(address => mapping(uint64 => bool)) public nonceUsed;

    event ChallengeUpdated(uint256 indexed epoch, bytes32 challenge, uint256 startedAt, uint256 graceUntil);
    event Accepted(address indexed user, uint64 nonce, uint256 indexed epoch, bool viaGrace);

    error EpochNotMature();
    error BadNonce();
    error NonceAlreadyUsed();
    error BadConfig();

    constructor(uint256 epochDuration_, uint256 gracePeriod_) {
        if (epochDuration_ == 0 || gracePeriod_ >= epochDuration_) revert BadConfig();
        epochDuration = epochDuration_;
        gracePeriod = gracePeriod_;
        epochStart = block.timestamp;
        epochSeed = _freshSeed(0);
        currentChallenge = _derive(epoch, epochSeed);
        emit ChallengeUpdated(epoch, currentChallenge, epochStart, 0);
    }

    /// @dev 种子来源：前一区块 blockhash + prevrandao。轮换发生前不可预知 → 无法预计算未来 challenge
    function _freshSeed(uint256 salt) internal view returns (uint256) {
        return uint256(
            keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, block.timestamp, salt))
        );
    }

    function _derive(uint256 epoch_, uint256 seed_) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), epoch_, seed_));
    }

    /// @notice 任何人可在 epoch 到期后触发轮换（无权限要求，无人可阻止）
    function rotate() external {
        if (block.timestamp < epochStart + epochDuration) revert EpochNotMature();
        previousChallenge = currentChallenge;
        previousValidUntil = block.timestamp + gracePeriod;
        epoch += 1;
        epochStart = block.timestamp;
        epochSeed = _freshSeed(epoch);
        currentChallenge = _derive(epoch, epochSeed);
        emit ChallengeUpdated(epoch, currentChallenge, epochStart, previousValidUntil);
    }

    function hashFor(bytes32 challenge, address user, uint64 nonce) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(challenge, user, nonce));
    }

    function isValidForChallenge(bytes32 challenge, address user, uint64 nonce, uint256 bits)
        public
        pure
        returns (bool)
    {
        return uint256(hashFor(challenge, user, nonce)) >> (256 - bits) == 0;
    }

    /// @notice 模拟 mint 的验证路径：优先当前 challenge；宽限期内接受上一 epoch
    function submit(uint64 nonce, uint256 bits) external returns (bool viaGrace) {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();

        if (isValidForChallenge(currentChallenge, msg.sender, nonce, bits)) {
            nonceUsed[msg.sender][nonce] = true;
            emit Accepted(msg.sender, nonce, epoch, false);
            return false;
        }
        if (
            epoch > 0 && block.timestamp <= previousValidUntil
                && isValidForChallenge(previousChallenge, msg.sender, nonce, bits)
        ) {
            nonceUsed[msg.sender][nonce] = true;
            emit Accepted(msg.sender, nonce, epoch - 1, true);
            return true;
        }
        revert BadNonce();
    }
}
