// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {ICardNFT, IRewardsNotify} from "./Interfaces.sol";

/// @title 挖矿（hardened-v1）：Domain-Separated Challenge PoW + 阶梯定价 + 70/30 当场分账（原生币）+ 铸卡
/// @notice 与 baseline 的差异仅在 PoW 部分：
///
///   challenge = keccak256(abi.encode(chainid, address(this), epoch, epochSeed))
///   PoW hash  = keccak256(abi.encodePacked(challenge[32B], user[20B], nonce[uint64 BE 8B]))
///
///   - 防预计算：种子取自轮换区块，挑战值出现前无法预知
///   - 防跨链/跨合约复用：chainid + address(this) 参与派生
///   - epoch 到期后任何人可 rotate()（无权限、不可被阻止）
///   - 旧 challenge 在 gracePeriod 内仍被接受，在挖工作不瞬间作废；宽限只覆盖上一代
///   机制验证见 src/spike/ChallengePoW.sol 与 docs/SPIKE_CHALLENGE.md
contract Mine is Ownable, Pausable, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant POOL_BPS = 7_000; // 70% 进分红池

    ICardNFT public immutable nft;
    IRewardsNotify public immutable rewards;

    uint256 public immutable baseBits;
    uint256 public immutable bitsPerTier;
    uint256 public immutable tierSize;
    uint256 public immutable startPrice;
    uint256 public immutable maxMints;

    address public treasury;
    uint256 public treasuryAccrued;
    uint256 public minted;

    // ---------- challenge / epoch ----------
    uint256 public immutable epochDuration;
    uint256 public immutable gracePeriod;

    uint256 public epoch;
    uint256 public epochStart;
    uint256 public epochSeed;
    bytes32 public currentChallenge;
    bytes32 public previousChallenge;
    uint256 public previousValidUntil; // 旧 challenge 宽限截止时间

    mapping(address => mapping(uint64 => bool)) public nonceUsed;

    event Minted(address indexed user, uint256 indexed tokenId, uint64 nonce, uint256 tier, uint256 price);
    event TreasurySet(address indexed treasury);
    event TreasuryAccrued(uint256 amount);
    event TreasuryFlushed(uint256 amount);
    event ChallengeUpdated(uint256 indexed epoch, bytes32 challenge, uint256 startedAt, uint256 graceUntil);

    error BadNonce();
    error NonceAlreadyUsed();
    error SoldOut();
    error WrongPayment();
    error TransferFailed();
    error BadConfig();
    error EpochNotMature();

    constructor(
        ICardNFT nft_,
        IRewardsNotify rewards_,
        address treasury_,
        address owner_,
        uint256 baseBits_,
        uint256 bitsPerTier_,
        uint256 tierSize_,
        uint256 startPrice_,
        uint256 maxMints_,
        uint256 epochDuration_,
        uint256 gracePeriod_
    ) Ownable(owner_) {
        if (address(nft_) == address(0) || address(rewards_) == address(0) || treasury_ == address(0)) {
            revert BadConfig();
        }
        if (baseBits_ == 0 || baseBits_ >= 256 || tierSize_ == 0 || startPrice_ == 0 || maxMints_ == 0) {
            revert BadConfig();
        }
        // 难度不能顶到 256 位，否则最后一档永远挖不出来
        if (baseBits_ + (maxMints_ - 1) / tierSize_ * bitsPerTier_ >= 256) revert BadConfig();
        // 价格左移溢出会变成 0，导致末档白送
        if (startPrice_ << ((maxMints_ - 1) / tierSize_) == 0) revert BadConfig();
        if (epochDuration_ == 0 || gracePeriod_ >= epochDuration_) revert BadConfig();

        nft = nft_;
        rewards = rewards_;
        treasury = treasury_;
        baseBits = baseBits_;
        bitsPerTier = bitsPerTier_;
        tierSize = tierSize_;
        startPrice = startPrice_;
        maxMints = maxMints_;

        epochDuration = epochDuration_;
        gracePeriod = gracePeriod_;
        epochStart = block.timestamp;
        epochSeed = _freshSeed(0);
        currentChallenge = _derive(epoch, epochSeed);
        emit ChallengeUpdated(epoch, currentChallenge, epochStart, 0);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert BadConfig();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @dev 限定 gas 且失败不阻塞铸造；收不下的部分记入 treasuryAccrued 待领
    function _payTreasury(uint256 amount) internal {
        (bool ok,) = treasury.call{value: amount, gas: 50_000}("");
        if (!ok) {
            treasuryAccrued += amount;
            emit TreasuryAccrued(amount);
        }
    }

    /// @dev 任何人都可触发，钱只会打给 treasury
    function flushTreasury() external {
        uint256 amount = treasuryAccrued;
        if (amount == 0) return;
        treasuryAccrued = 0;
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit TreasuryFlushed(amount);
    }

    /// @dev 只能暂停 mint，不影响质押/赎回/领取
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------- challenge ----------

    /// @dev 种子来源：前一区块 blockhash + prevrandao。轮换发生前不可预知 → 无法预计算未来 challenge
    function _freshSeed(uint256 salt) internal view returns (uint256) {
        return uint256(
            keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, block.timestamp, salt))
        );
    }

    function _derive(uint256 epoch_, uint256 seed_) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), epoch_, seed_));
    }

    /// @notice epoch 到期后任何人可触发轮换（无权限要求，无人可阻止矿工继续使用旧挑战之外的任何手段）
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

    /// @dev bytes32 按大端当 256 位整数，高 bits 位全 0 即达标
    function isValidForChallenge(bytes32 challenge, address user, uint64 nonce, uint256 bits)
        public
        pure
        returns (bool)
    {
        return uint256(hashFor(challenge, user, nonce)) >> (256 - bits) == 0;
    }

    /// @dev 针对当前 challenge 校验（前端本地验证用）
    function isValidNonce(address user, uint64 nonce, uint256 bits) public view returns (bool) {
        return isValidForChallenge(currentChallenge, user, nonce, bits);
    }

    function currentTier() public view returns (uint256) {
        return minted / tierSize;
    }

    function currentBits() public view returns (uint256) {
        return baseBits + currentTier() * bitsPerTier;
    }

    function currentMintDue() public view returns (uint256) {
        return startPrice << currentTier();
    }

    function mint(uint64 nonce) external payable nonReentrant whenNotPaused {
        if (minted >= maxMints) revert SoldOut();
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();

        // 优先当前 challenge；宽限期内接受上一 epoch（旧码宽限外作废）
        bool ok = isValidNonce(msg.sender, nonce, currentBits());
        if (!ok && epoch > 0 && block.timestamp <= previousValidUntil) {
            ok = isValidForChallenge(previousChallenge, msg.sender, nonce, currentBits());
        }
        if (!ok) revert BadNonce();
        nonceUsed[msg.sender][nonce] = true;

        uint256 tier = currentTier();
        uint256 due = currentMintDue();
        if (msg.value != due) revert WrongPayment();

        uint256 toPool = due * POOL_BPS / BPS;

        minted = minted + 1;
        // 先记分红账、后铸卡：防止接收方在 onERC721Received 回调里抢先质押、分走自己这笔的分红
        rewards.notify{value: toPool}(toPool);
        uint256 tokenId = nft.mint(msg.sender);
        _payTreasury(due - toPool);

        emit Minted(msg.sender, tokenId, nonce, tier, due);
    }
}
