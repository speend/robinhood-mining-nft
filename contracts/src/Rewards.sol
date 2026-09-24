// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IRewardsNotify, IRewardsWeight} from "./Interfaces.sol";

/// @title 分红池：接收 mint 收入的 70%（原生币），按质押权重即时分配，随时领取
contract Rewards is Ownable, ReentrancyGuard, IRewardsNotify, IRewardsWeight {
    uint256 public constant ACC_PRECISION = 1e18;

    address public mine;
    address public vault;

    uint256 public accPerWeight;
    uint256 public totalWeight;
    uint256 public undistributed;

    mapping(address => uint256) public weightOf;
    mapping(address => uint256) public debt;
    mapping(address => uint256) public claimable;

    event MineSet(address indexed mine);
    event VaultSet(address indexed vault);
    event Notified(uint256 amount);
    event WeightUpdated(address indexed user, uint256 newWeight);
    event Claimed(address indexed user, uint256 amount);

    error NotMine();
    error NotVault();
    error AlreadySet();
    error WrongPayment();
    error TransferFailed();
    error ZeroAddress();

    constructor(address owner_) Ownable(owner_) {}

    function setMine(address mine_) external onlyOwner {
        if (mine_ == address(0)) revert ZeroAddress();
        if (mine != address(0)) revert AlreadySet();
        mine = mine_;
        emit MineSet(mine_);
    }

    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        if (vault != address(0)) revert AlreadySet();
        vault = vault_;
        emit VaultSet(vault_);
    }

    function pending(address user) public view returns (uint256) {
        return claimable[user] + weightOf[user] * accPerWeight / ACC_PRECISION - debt[user];
    }

    function _settle(address user) internal {
        claimable[user] = pending(user);
        debt[user] = weightOf[user] * accPerWeight / ACC_PRECISION;
    }

    /// @notice Mine 每次 mint 后携带 70% 原生币调用
    /// @dev 无人质押时先暂存；等第一个质押者出现时一并计入（由他独享）
    function notify(uint256 amount) external payable {
        if (msg.sender != mine) revert NotMine();
        if (msg.value != amount) revert WrongPayment();

        uint256 total = amount + undistributed;
        if (totalWeight == 0) {
            undistributed = total;
        } else {
            undistributed = 0;
            accPerWeight += total * ACC_PRECISION / totalWeight;
        }
        emit Notified(amount);
    }

    /// @notice Vault 质押/赎回时调用；必须先结算旧权重再改权重
    function updateWeight(address user, uint256 newWeight) external {
        if (msg.sender != vault) revert NotVault();

        _settle(user);

        uint256 oldWeight = weightOf[user];
        uint256 oldTotal = totalWeight;
        weightOf[user] = newWeight;
        totalWeight = oldTotal - oldWeight + newWeight;
        debt[user] = newWeight * accPerWeight / ACC_PRECISION;

        // 第一个质押者出现：把此前无人可分而暂存的收入一次计入（由他独享，重奖最早质押者）
        if (oldTotal == 0 && totalWeight > 0 && undistributed > 0) {
            accPerWeight += undistributed * ACC_PRECISION / totalWeight;
            undistributed = 0;
        }

        emit WeightUpdated(user, newWeight);
    }

    function claim() external nonReentrant {
        _settle(msg.sender);
        uint256 amount = claimable[msg.sender];
        // 精度尘埃保护：pending() 的 floor 差可能使全体待领总额比余额多出几 wei
        // （floor(x+d)-floor(x) ≤ d+1，每人每次分账最多多计 1 wei）。
        // 不加这一行，最后一个领取者会因差 1 wei 永远 claim 失败（资金锁死）。
        uint256 bal = address(this).balance;
        if (amount > bal) amount = bal;
        claimable[msg.sender] -= amount;
        if (amount > 0) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
        emit Claimed(msg.sender, amount);
    }
}
