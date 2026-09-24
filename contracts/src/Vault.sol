// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IRewardsWeight} from "./Interfaces.sol";

/// @title 质押金库：单档位、锁定 365 天、每张卡权重 1
contract Vault is Ownable, ReentrancyGuard {
    IERC721 public immutable nft;
    IRewardsWeight public immutable rewards;
    uint256 public immutable lockDuration;

    mapping(uint256 => address) public stakerOf;
    mapping(uint256 => uint256) public lockedAt;
    mapping(address => uint256) public stakeCount;

    event Staked(address indexed user, uint256 indexed tokenId);
    event Unstaked(address indexed user, uint256 indexed tokenId);

    error NotTokenOwner();
    error AlreadyStaked();
    error NotStaker();
    error StillLocked();
    error BadConfig();

    constructor(IERC721 nft_, IRewardsWeight rewards_, uint256 lockDuration_, address owner_) Ownable(owner_) {
        if (address(nft_) == address(0) || address(rewards_) == address(0) || lockDuration_ == 0) revert BadConfig();
        nft = nft_;
        rewards = rewards_;
        lockDuration = lockDuration_;
    }

    function stake(uint256 tokenId) external nonReentrant {
        if (stakerOf[tokenId] != address(0)) revert AlreadyStaked();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        stakerOf[tokenId] = msg.sender;
        lockedAt[tokenId] = block.timestamp;
        nft.transferFrom(msg.sender, address(this), tokenId);

        uint256 newCount = stakeCount[msg.sender] + 1;
        stakeCount[msg.sender] = newCount;
        rewards.updateWeight(msg.sender, newCount);

        emit Staked(msg.sender, tokenId);
    }

    function unstake(uint256 tokenId) external nonReentrant {
        if (stakerOf[tokenId] != msg.sender) revert NotStaker();
        if (block.timestamp < lockedAt[tokenId] + lockDuration) revert StillLocked();

        stakerOf[tokenId] = address(0);
        lockedAt[tokenId] = 0;
        uint256 newCount = stakeCount[msg.sender] - 1;
        stakeCount[msg.sender] = newCount;
        rewards.updateWeight(msg.sender, newCount);

        nft.transferFrom(address(this), msg.sender, tokenId);

        emit Unstaked(msg.sender, tokenId);
    }

    function weightOf(address user) external view returns (uint256) {
        return stakeCount[user];
    }

    function unlockTime(uint256 tokenId) external view returns (uint256) {
        if (stakerOf[tokenId] == address(0)) return 0;
        return lockedAt[tokenId] + lockDuration;
    }
}
