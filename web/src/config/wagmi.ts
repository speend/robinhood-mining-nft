import { createConfig, http, injected, type CreateConnectorFn } from 'wagmi';
import { walletConnect } from 'wagmi/connectors';
import { anvilLocal, robinhoodTestnet } from './chains';
import { WC_PROJECT_ID } from './contracts';

const connectors: CreateConnectorFn[] = [injected()];

// 没有 projectId 时禁用 WalletConnect，只保留 injected（UI 上有注明）
if (WC_PROJECT_ID) {
  connectors.push(walletConnect({ projectId: WC_PROJECT_ID }));
}

export const wagmiConfig = createConfig({
  chains: [anvilLocal, robinhoodTestnet],
  connectors,
  transports: {
    [anvilLocal.id]: http(anvilLocal.rpcUrls.default.http[0]),
    [robinhoodTestnet.id]: http(robinhoodTestnet.rpcUrls.default.http[0]),
  },
});

export const walletConnectEnabled = Boolean(WC_PROJECT_ID);
