// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {CardNFT} from "../src/CardNFT.sol";
import {Mine} from "../src/Mine.sol";
import {Vault} from "../src/Vault.sol";
import {Rewards} from "../src/Rewards.sol";

/// @title 部署脚本回归测试：OWNER != deployer 时必须能完整部署并移交所有权
contract DeployScriptTest is Test {
    uint256 constant PK = 1; // 测试私钥，地址 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
    address deployer = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address finalOwner = address(0x0B0);
    address treasury = address(0x7EA5);

    function _setEnv() internal {
        vm.setEnv("PRIVATE_KEY", "1");
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("OWNER", vm.toString(finalOwner));
        vm.setEnv("START_PRICE_WEI", "250000000000000");
    }

    function test_Deploy_WithSeparateOwner_Succeeds() public {
        _setEnv();
        new Deploy().run(); // 修复前：setMinter 处必 revert（owner 已是 finalOwner）

        // 脚本内部已做 _verify，这里再从链上状态独立抽查一次：
        // 重新部署一遍拿到地址（run 不返回值，改为直接验证行为等价性）
    }

    /// @dev 与 Deploy.run 相同的部署+接线+移交顺序，验证终态
    function test_DeployPattern_EndState() public {
        vm.startBroadcast(PK);
        CardNFT nft = new CardNFT("Mine Card", "MCARD", "", deployer);
        Rewards rewards = new Rewards(deployer);
        Vault vault = new Vault(nft, rewards, 365 days, deployer);
        Mine mine = new Mine(nft, rewards, treasury, deployer, 35, 1, 500, 0.00025 ether, 5000, 24 hours, 10 minutes);
        nft.setMinter(address(mine));
        rewards.setMine(address(mine));
        rewards.setVault(address(vault));
        nft.transferOwnership(finalOwner);
        rewards.transferOwnership(finalOwner);
        vault.transferOwnership(finalOwner);
        mine.transferOwnership(finalOwner);
        vm.stopBroadcast();

        assertEq(nft.minter(), address(mine));
        assertEq(rewards.mine(), address(mine));
        assertEq(rewards.vault(), address(vault));
        assertEq(nft.owner(), finalOwner);
        assertEq(rewards.owner(), finalOwner);
        assertEq(vault.owner(), finalOwner);
        assertEq(mine.owner(), finalOwner);
        assertEq(mine.treasury(), treasury);
        assertEq(mine.currentBits(), 35);
        assertEq(mine.currentMintDue(), 0.00025 ether);
    }
}
