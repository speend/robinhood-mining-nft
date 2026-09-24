// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {ICardNFT, IRewardsNotify} from "./Interfaces.sol";

/// @title 挖矿：验证 PoW nonce、阶梯定价、70/30 当场分账（原生币）、铸卡
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

    mapping(address => mapping(uint64 => bool)) public nonceUsed;

    event Minted(address indexed user, uint256 indexed tokenId, uint64 nonce, uint256 tier, uint256 price);
    event TreasurySet(address indexed treasury);
    event TreasuryAccrued(uint256 amount);
    event TreasuryFlushed(uint256 amount);

    error BadNonce();
    error NonceAlreadyUsed();
    error SoldOut();
    error WrongPayment();
    error TransferFailed();
    error BadConfig();

    constructor(
        ICardNFT nft_,
        IRewardsNotify rewards_,
        address treasury_,
        address owner_,
        uint256 baseBits_,
        uint256 bitsPerTier_,
        uint256 tierSize_,
        uint256 startPrice_,
        uint256 maxMints_
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

        nft = nft_;
        rewards = rewards_;
        treasury = treasury_;
        baseBits = baseBits_;
        bitsPerTier = bitsPerTier_;
        tierSize = tierSize_;
        startPrice = startPrice_;
        maxMints = maxMints_;
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

    function currentTier() public view returns (uint256) {
        return minted / tierSize;
    }

    function currentBits() public view returns (uint256) {
        return baseBits + currentTier() * bitsPerTier;
    }

    function currentMintDue() public view returns (uint256) {
        return startPrice << currentTier();
    }

    function hashFor(address user, uint64 nonce) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(user, nonce));
    }

    /// @dev bytes32 按大端当 256 位整数，高 bits 位全 0 即达标
    function isValidNonce(address user, uint64 nonce, uint256 bits) public pure returns (bool) {
        return uint256(hashFor(user, nonce)) >> (256 - bits) == 0;
    }

    function mint(uint64 nonce) external payable nonReentrant whenNotPaused {
        if (minted >= maxMints) revert SoldOut();
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();

        if (!isValidNonce(msg.sender, nonce, currentBits())) revert BadNonce();
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
