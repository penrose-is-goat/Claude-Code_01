import type { Metadata } from 'next';
import Link from 'next/link';
import { getUnseenEventCount } from '@/lib/db/queries';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zillow Tracker',
  description: 'Track listings and open houses in your neighborhoods',
};

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/', label: 'Search' },
  { href: '/listings', label: 'Listings' },
  { href: '/open-houses', label: 'Open Houses' },
  { href: '/saved', label: 'Saved' },
  { href: '/searches', label: 'Saved Searches' },
  { href: '/settings', label: 'Settings' },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let unseen = 0;
  try {
    unseen = await getUnseenEventCount();
  } catch {
    // Database not yet migrated — the app should still render its shell and say so
    // rather than showing a stack trace.
  }

  return (
    <html lang="en">
      <body>
        <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <nav style={{ maxWidth: 1400, margin: '0 auto', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
            <Link href="/" style={{ fontWeight: 700, fontSize: 16, textDecoration: 'none' }}>
              Zillow Tracker
            </Link>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} style={{ textDecoration: 'none' }}>
                  {n.label}
                  {n.href === '/' && unseen > 0 && (
                    <span
                      aria-label={`${unseen} unseen updates`}
                      style={{
                        marginLeft: 6, background: 'var(--accent)', color: 'var(--on-accent)',
                        borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700,
                      }}
                    >
                      {unseen}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </nav>
        </header>
        <main style={{ maxWidth: 1400, margin: '0 auto', padding: '20px' }}>{children}</main>
      </body>
    </html>
  );
}
