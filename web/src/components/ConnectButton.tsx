'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { truncateHex } from '@/lib/format';
import { walletConnectEnabled } from '@/config/wagmi';

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  if (isConnected && address) {
    return (
      <div style={{ position: 'relative' }} ref={ref}>
        <button className="btn sm" onClick={() => setOpen((v) => !v)}>
          {truncateHex(address, 4, 4)}
        </button>
        {open && (
          <div className="connect-menu">
            <div className="connect-note">{address}</div>
            <button className="btn danger sm" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="btn primary sm" onClick={() => setOpen((v) => !v)} disabled={isPending}>
        Connect Wallet
      </button>
      {open && (
        <div className="connect-menu">
          {connectors.map((c) => (
            <button
              key={c.uid}
              className="btn sm"
              onClick={() => {
                connect({ connector: c });
                setOpen(false);
              }}
            >
              {c.name}
            </button>
          ))}
          {!walletConnectEnabled && (
            <div className="connect-note">
              WalletConnect 未启用（未配置 NEXT_PUBLIC_WC_PROJECT_ID），仅支持浏览器插件钱包
            </div>
          )}
        </div>
      )}
    </div>
  );
}
