'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { TARGET_CHAIN } from '@/config/contracts';

const LINKS = [
  { href: '/', label: 'Mining' },
  { href: '/fleet', label: 'Fleet' },
  { href: '/staking', label: 'Staking' },
  { href: '/stats', label: 'Stats' },
];

export function Nav() {
  const pathname = usePathname();
  const { chainId, isConnected } = useAccount();
  const wrongNetwork = isConnected && chainId !== TARGET_CHAIN.id;

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="nav-logo">
          ⛏ RH<span>-MINING</span>
        </Link>
        <nav className="nav-links">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`nav-link${pathname === l.href ? ' active' : ''}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="nav-right">
          <span className={`badge ${wrongNetwork ? 'err' : 'ok'}`}>
            {wrongNetwork ? 'WRONG NETWORK' : TARGET_CHAIN.name}
          </span>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
