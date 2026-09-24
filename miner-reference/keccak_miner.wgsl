// ============================================================
// keccak_miner.wgsl (hardened-v1) —— Domain-Separated Challenge 版
// 与 Mine.sol (hardened-v1) 完全对齐的 Keccak-256 PoW 挖矿 shader
// ============================================================
// 已验证：本 shader 的 keccak 实现与以太坊 keccak256 完全一致
//         （内置自检：keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470）
//
// 验证对象（必须与 Mine.isValidForChallenge 完全一致）：
//   消息 = abi.encodePacked(challenge[32字节], 玩家地址[20字节], nonce[uint64, 大端])，共 60 字节
//   keccak256(消息) 的 32 字节结果，按【大端】当作 256 位整数，高 bits 位全 0 即达标
//
// ⚠️ 字节序是最大的坑（务必看懂再改）：
//   消息字节布局：b0..b31 = challenge；b32..b51 = 地址；b52..b59 = nonce 大端；
//                 b60 = 0x01（keccak 填充）；b135 = 0x80（结束标记）
//   60 字节 < 136 字节 rate，单 block 吸收，无需多轮
//   keccak 状态按 lane 组织，每 lane 覆盖 8 字节，lane 的 lo/hi 两个 u32 都是【小端】装载
//   → 所以写入状态前要做 bswap32，读结果比较前也要做 bswap32
//
// 与 baseline 的唯一区别：消息前缀从 20B 地址变为 52B (challenge ‖ 地址)。
// 测试向量：contracts/spike/test-vectors.json（集成时必须通过同向量自检）
//
// 用法：每次 dispatch 覆盖 stride * ITER 个 nonce，host 每轮把 nonce_lo/hi 前移；
//       找到后 found 原子标志置 1，结果写在 result 里。
// ============================================================

struct Params {
    ch0: u32,        // challenge 字节 0..3（按十六进制字符串顺序解析出的 u32）
    ch1: u32,        // 字节 4..7
    ch2: u32,
    ch3: u32,
    ch4: u32,
    ch5: u32,
    ch6: u32,
    ch7: u32,        // 字节 28..31
    addr0: u32,      // 地址前 4 字节
    addr1: u32,      // 地址 4..7 字节
    addr2: u32,      // 地址 8..11 字节
    addr3: u32,      // 地址 12..15 字节
    addr4: u32,      // 地址 16..19 字节
    nonce_lo: u32,   // 本批起始 nonce 的低 32 位
    nonce_hi: u32,   // 本批起始 nonce 的高 32 位
    bits: u32,       // 当前难度（从合约 currentBits() 读取）
    stride: u32,     // 本批总线程数（host 传入，等于 dispatch 的线程总数）
    pad0: u32,       // uniform 16 字节对齐填充
    pad1: u32,
    pad2: u32,
};

@group(0) @binding(0) var<storage, read_write> found: atomic<u32>;
@group(0) @binding(1) var<storage, read_write> result: array<u32, 12>;
// result[0..7]  = hash 的 32 字节原始内容（lane0..lane3 的 lo/hi，小端序）
// result[8]     = 找到的 nonce 低 32 位
// result[9]     = 找到的 nonce 高 32 位
// result[10]    = 本次难度 bits
@group(0) @binding(2) var<uniform> p: Params;

const ITER: u32 = 256u; // 每个线程连续尝试的 nonce 个数

var<private> RCL: array<u32, 24> = array<u32, 24>(
    0x00000001u, 0x00008082u, 0x0000808Au, 0x80008000u, 0x0000808Bu, 0x80000001u, 0x80008081u, 0x00008009u,
    0x0000008Au, 0x00000088u, 0x80008009u, 0x8000000Au, 0x8000808Bu, 0x0000008Bu, 0x00008089u, 0x00008003u,
    0x00008002u, 0x00000080u, 0x0000800Au, 0x8000000Au, 0x80008081u, 0x00008080u, 0x80000001u, 0x80008008u);

var<private> RCH: array<u32, 24> = array<u32, 24>(
    0x00000000u, 0x00000000u, 0x80000000u, 0x80000000u, 0x00000000u, 0x00000000u, 0x80000000u, 0x80000000u,
    0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u, 0x80000000u, 0x80000000u, 0x80000000u,
    0x80000000u, 0x80000000u, 0x00000000u, 0x80000000u, 0x80000000u, 0x80000000u, 0x00000000u, 0x80000000u);

var<private> ROTC: array<u32, 24> = array<u32, 24>(
    1u, 3u, 6u, 10u, 15u, 21u, 28u, 36u, 45u, 55u, 2u, 14u, 27u, 41u, 56u, 8u, 25u, 43u, 62u, 18u, 39u, 61u, 20u, 44u);

var<private> PILN: array<u32, 24> = array<u32, 24>(
    10u, 7u, 11u, 17u, 18u, 3u, 5u, 16u, 8u, 21u, 24u, 4u, 15u, 23u, 19u, 13u, 12u, 2u, 20u, 14u, 22u, 9u, 6u, 1u);

fn rotl64(lo: u32, hi: u32, n: u32) -> vec2<u32> {
    if (n == 0u) { return vec2<u32>(lo, hi); }
    if (n < 32u) { return vec2<u32>((lo << n) | (hi >> (32u - n)), (hi << n) | (lo >> (32u - n))); }
    if (n == 32u) { return vec2<u32>(hi, lo); }
    return vec2<u32>((hi << (n - 32u)) | (lo >> (64u - n)), (lo << (n - 32u)) | (hi >> (64u - n)));
}

fn keccak_perm(st: ptr<function, array<u32, 50>>) {
    var bc: array<u32, 10>;
    for (var r = 0u; r < 24u; r = r + 1u) {
        for (var i = 0u; i < 5u; i = i + 1u) {
            bc[2u * i] = (*st)[2u * i] ^ (*st)[2u * (i + 5u)] ^ (*st)[2u * (i + 10u)] ^ (*st)[2u * (i + 15u)]
                ^ (*st)[2u * (i + 20u)];
            bc[2u * i + 1u] = (*st)[2u * i + 1u] ^ (*st)[2u * (i + 5u) + 1u] ^ (*st)[2u * (i + 10u) + 1u]
                ^ (*st)[2u * (i + 15u) + 1u] ^ (*st)[2u * (i + 20u) + 1u];
        }
        for (var i = 0u; i < 5u; i = i + 1u) {
            let j4 = 2u * ((i + 4u) % 5u);
            let j1 = 2u * ((i + 1u) % 5u);
            let r1 = rotl64(bc[j1], bc[j1 + 1u], 1u);
            let tl = bc[j4] ^ r1.x;
            let th = bc[j4 + 1u] ^ r1.y;
            for (var j = 0u; j < 25u; j = j + 5u) {
                (*st)[2u * (j + i)] = (*st)[2u * (j + i)] ^ tl;
                (*st)[2u * (j + i) + 1u] = (*st)[2u * (j + i) + 1u] ^ th;
            }
        }
        var tlo = (*st)[2u];
        var thi = (*st)[3u];
        for (var i = 0u; i < 24u; i = i + 1u) {
            let j = PILN[i];
            let slo = (*st)[2u * j];
            let shi = (*st)[2u * j + 1u];
            let rr = rotl64(tlo, thi, ROTC[i]);
            (*st)[2u * j] = rr.x;
            (*st)[2u * j + 1u] = rr.y;
            tlo = slo;
            thi = shi;
        }
        for (var j = 0u; j < 25u; j = j + 5u) {
            for (var i = 0u; i < 5u; i = i + 1u) {
                bc[2u * i] = (*st)[2u * (j + i)];
                bc[2u * i + 1u] = (*st)[2u * (j + i) + 1u];
            }
            for (var i = 0u; i < 5u; i = i + 1u) {
                let c1 = 2u * ((i + 1u) % 5u);
                let c2 = 2u * ((i + 2u) % 5u);
                (*st)[2u * (j + i)] = (*st)[2u * (j + i)] ^ ((~bc[c1]) & bc[c2]);
                (*st)[2u * (j + i) + 1u] = (*st)[2u * (j + i) + 1u] ^ ((~bc[c1 + 1u]) & bc[c2 + 1u]);
            }
        }
        (*st)[0] = (*st)[0] ^ RCL[r];
        (*st)[1] = (*st)[1] ^ RCH[r];
    }
}

fn bswap32(x: u32) -> u32 {
    return ((x & 0x000000FFu) << 24u) | ((x & 0x0000FF00u) << 8u) | ((x & 0x00FF0000u) >> 8u)
        | ((x & 0xFF000000u) >> 24u);
}

/// 组装 "challenge(32B) + 地址(20B) + nonce(8B 大端) + 0x01 填充 + 0x80 结尾" 的 60 字节消息状态
fn fill_state(st: ptr<function, array<u32, 50>>, nlo: u32, nhi: u32) {
    for (var i = 0u; i < 50u; i = i + 1u) {
        (*st)[i] = 0u;
    }
    (*st)[0] = bswap32(p.ch0);   // challenge 字节 0..3
    (*st)[1] = bswap32(p.ch1);   // 字节 4..7
    (*st)[2] = bswap32(p.ch2);
    (*st)[3] = bswap32(p.ch3);
    (*st)[4] = bswap32(p.ch4);
    (*st)[5] = bswap32(p.ch5);
    (*st)[6] = bswap32(p.ch6);
    (*st)[7] = bswap32(p.ch7);   // 字节 28..31
    (*st)[8] = bswap32(p.addr0); // 地址字节 32..35（消息位置 32 = 地址开头）
    (*st)[9] = bswap32(p.addr1);
    (*st)[10] = bswap32(p.addr2);
    (*st)[11] = bswap32(p.addr3);
    (*st)[12] = bswap32(p.addr4); // 地址字节 48..51
    (*st)[13] = bswap32(nhi);    // 字节 52..55：nonce 高 32 位（大端）
    (*st)[14] = bswap32(nlo);    // 字节 56..59：nonce 低 32 位（大端）
    (*st)[15] = 1u;              // 字节 60 = 0x01，keccak（非 SHA3）填充
    (*st)[33] = 0x80000000u;     // 字节 135 = 0x80
}

/// 达标判断：结果按大端当 256 位整数，高 bits 位是否全 0（支持到 96 位，本项目最多 44 位）
fn meets_target(st: ptr<function, array<u32, 50>>, bits: u32) -> bool {
    let w0 = bswap32((*st)[0]); // 最高 32 位 = 字节 b0..b3
    if (bits < 32u) {
        return (w0 >> (32u - bits)) == 0u;
    }
    if (bits == 32u) {
        return w0 == 0u;
    }
    if (w0 != 0u) {
        return false;
    }
    let w1 = bswap32((*st)[1]); // 次高 32 位 = 字节 b4..b7
    if (bits < 64u) {
        return (w1 >> (64u - bits)) == 0u;
    }
    if (bits == 64u) {
        return w1 == 0u;
    }
    if (w1 != 0u) {
        return false;
    }
    if (bits > 96u) {
        return false; // 超出本 shader 支持范围
    }
    let w2 = bswap32((*st)[2]); // 字节 b8..b11
    if (bits == 96u) {
        return w2 == 0u;
    }
    return (w2 >> (96u - bits)) == 0u;
}

@compute @workgroup_size(64)
fn grind(@builtin(global_invocation_id) gid: vec3<u32>) {
    let tid = gid.x;
    var st: array<u32, 50>;
    var idx = tid;
    for (var k = 0u; k < ITER; k = k + 1u) {
        let nlo = p.nonce_lo + idx;
        var nhi = p.nonce_hi;
        if (nlo < p.nonce_lo) {
            nhi = nhi + 1u; // 低位进位
        }
        fill_state(&st, nlo, nhi);
        keccak_perm(&st);
        if (meets_target(&st, p.bits)) {
            let prev = atomicCompareExchangeWeak(&found, 0u, 1u);
            if (prev.exchanged) {
                for (var i = 0u; i < 8u; i = i + 1u) {
                    result[i] = st[i];
                }
                result[8] = nlo;
                result[9] = nhi;
                result[10] = p.bits;
            }
            break;
        }
        idx = idx + p.stride;
    }
}

// 自检：keccak256("") 应等于 c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
@compute @workgroup_size(1)
fn selftest() {
    var st: array<u32, 50>;
    for (var i = 0u; i < 50u; i = i + 1u) {
        st[i] = 0u;
    }
    st[0] = 1u;
    st[33] = 0x80000000u;
    keccak_perm(&st);
    for (var i = 0u; i < 8u; i = i + 1u) {
        result[i] = st[i];
    }
}
