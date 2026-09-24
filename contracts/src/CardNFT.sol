// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ICardNFT} from "./Interfaces.sol";

/// @title 矿卡 NFT：只能由 Mine 合约铸造，tokenId 从 1 递增
contract CardNFT is ERC721, Ownable, ICardNFT {
    address public minter;
    string public baseURI;
    uint256 public totalMinted;

    event MinterSet(address indexed minter);

    bool public baseURIFrozen;

    error NotMinter();
    error MinterAlreadySet();
    error ZeroAddress();
    error Frozen();

    constructor(string memory name_, string memory symbol_, string memory baseURI_, address owner_)
        ERC721(name_, symbol_)
        Ownable(owner_)
    {
        baseURI = baseURI_;
    }

    function setMinter(address minter_) external onlyOwner {
        if (minter_ == address(0)) revert ZeroAddress();
        if (minter != address(0)) revert MinterAlreadySet();
        minter = minter_;
        emit MinterSet(minter_);
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        if (baseURIFrozen) revert Frozen();
        baseURI = uri;
    }

    /// @dev 冻结后元数据永久不可改（对玩家是信任凭证）
    function freezeBaseURI() external onlyOwner {
        baseURIFrozen = true;
    }

    function mint(address to) external returns (uint256 tokenId) {
        if (msg.sender != minter) revert NotMinter();
        tokenId = ++totalMinted;
        _safeMint(to, tokenId);
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }
}
