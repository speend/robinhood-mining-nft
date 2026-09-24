// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICardNFT {
    function mint(address to) external returns (uint256);
}

interface IRewardsNotify {
    function notify(uint256 amount) external payable;
}

interface IRewardsWeight {
    function updateWeight(address user, uint256 newWeight) external;
}
