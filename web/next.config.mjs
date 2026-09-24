/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { webpack }) => {
    // WalletConnect / pino 拉入 node-only 模块，浏览器 bundle 中屏蔽
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    // @base-org/account（被 wagmi/connectors 传递引入）依赖可选的 @x402/* 支付模块，
    // 与挖矿站点无关，统一忽略（导入得到空模块，相关代码路径不会执行）
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    // MetaMask SDK 的 React Native 可选依赖，浏览器端不需要
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@react-native-async-storage\/async-storage$/ }),
    );
    return config;
  },
};

export default nextConfig;
