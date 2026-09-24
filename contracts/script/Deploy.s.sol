// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CardNFT} from "../src/CardNFT.sol";
import {Mine} from "../src/Mine.sol";
import {Vault} from "../src/Vault.sol";
import {Rewards} from "../src/Rewards.sol";

/// @notice 一键部署 4 个合约、按正确顺序接线、自动校验。详细步骤见 部署指南.md
contract Deploy is Script {
    struct Config {
        uint256 pk;
        address owner;
        address treasury;
        uint256 baseBits;
        uint256 bitsPerTier;
        uint256 tierSize;
        uint256 startPrice;
        uint256 maxMints;
        uint256 lockDuration;
        string nftName;
        string nftSymbol;
        string baseURI;
    }

    function _loadConfig() internal view returns (Config memory c) {
        c.pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(c.pk);
        c.owner = vm.envOr("OWNER", deployer);
        c.treasury = vm.envAddress("TREASURY");
        c.baseBits = vm.envOr("BASE_BITS", uint256(35));
        c.bitsPerTier = vm.envOr("BITS_PER_TIER", uint256(1));
        c.tierSize = vm.envOr("TIER_SIZE", uint256(500));
        c.startPrice = vm.envUint("START_PRICE_WEI");
        c.maxMints = vm.envOr("MAX_MINTS", uint256(5000));
        c.lockDuration = vm.envOr("LOCK_DURATION", uint256(365 days));
        c.nftName = vm.envOr("NFT_NAME", string("Mine Card"));
        c.nftSymbol = vm.envOr("NFT_SYMBOL", string("MCARD"));
        c.baseURI = vm.envOr("BASE_URI", string(""));
    }

    function run() external {
        Config memory c = _loadConfig();

        console.log(unicode"===== 部署配置 =====");
        console.log("deployer    :", vm.addr(c.pk));
        console.log("owner       :", c.owner);
        console.log("treasury    :", c.treasury);
        console.log("baseBits    :", c.baseBits);
        console.log("tierSize    :", c.tierSize);
        console.log("startPrice  :", c.startPrice);
        console.log("maxMints    :", c.maxMints);
        console.log("lockSeconds :", c.lockDuration);

        vm.startBroadcast(c.pk);
        // 部署期间 owner 必须是 deployer，否则后续 onlyOwner 接线会 revert；
        // 全部接线完成后再移交给最终 owner。
        address deployer = vm.addr(c.pk);
        CardNFT nft = new CardNFT(c.nftName, c.nftSymbol, c.baseURI, deployer);
        Rewards rewards = new Rewards(deployer);
        Vault vault = new Vault(nft, rewards, c.lockDuration, deployer);
        Mine mine = new Mine(
            nft, rewards, c.treasury, deployer, c.baseBits, c.bitsPerTier, c.tierSize, c.startPrice, c.maxMints
        );

        // 接线（三处都只能设一次，地址错会直接失败）
        nft.setMinter(address(mine));
        rewards.setMine(address(mine));
        rewards.setVault(address(vault));

        if (c.owner != deployer) {
            nft.transferOwnership(c.owner);
            rewards.transferOwnership(c.owner);
            vault.transferOwnership(c.owner);
            mine.transferOwnership(c.owner);
        }
        vm.stopBroadcast();

        _verify(address(nft), address(rewards), address(vault), address(mine), c);

        console.log("");
        console.log(unicode"===== 部署完成，请记录以下地址 =====");
        console.log("CardNFT :", address(nft));
        console.log("Rewards :", address(rewards));
        console.log("Vault   :", address(vault));
        console.log("Mine    :", address(mine));
        console.log("");
        console.log(unicode"下一步：");
        console.log(unicode"1) 区块浏览器上验证 4 个合约源码");
        console.log(unicode"2) 图片上传 IPFS 后，用 setBaseURI 填入（上线前可 freezeBaseURI 冻结）");
        console.log(unicode"3) 把上面 4 个地址填进矿机和前端");
    }

    /// @dev 把接线和初始状态读回来核对，任何一项对不上直接失败
    function _verify(address nft, address rewards, address vault, address mine, Config memory c) internal view {
        require(CardNFT(nft).minter() == mine, "WIRING FAIL: nft.minter");
        require(Rewards(rewards).mine() == mine, "WIRING FAIL: rewards.mine");
        require(Rewards(rewards).vault() == vault, "WIRING FAIL: rewards.vault");
        require(CardNFT(nft).owner() == c.owner, "OWNER FAIL: nft");
        require(Rewards(rewards).owner() == c.owner, "OWNER FAIL: rewards");
        require(Mine(mine).owner() == c.owner, "OWNER FAIL: mine");
        require(Mine(mine).minted() == 0, "INIT FAIL: minted != 0");
        require(Rewards(rewards).totalWeight() == 0, "INIT FAIL: totalWeight != 0");
        require(Mine(mine).currentMintDue() == c.startPrice, "INIT FAIL: currentMintDue");
        require(Mine(mine).currentBits() == c.baseBits, "INIT FAIL: currentBits");
        require(Mine(mine).treasury() == c.treasury, "INIT FAIL: treasury");
    }
}
