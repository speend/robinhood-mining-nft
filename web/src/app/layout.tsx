import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'Robinhood Mining NFT',
  description: 'PoW mining NFT console on Robinhood Chain',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <Nav />
          <main className="container">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
