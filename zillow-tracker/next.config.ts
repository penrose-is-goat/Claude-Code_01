import type { NextConfig } from 'next';

const config: NextConfig = {
  // Next injects a floating dev-mode overlay ("Route / Try Turbopack") into every page
  // in `next dev`. It is Next's own widget, not part of this app, and it is off because
  // it clutters the UI while looking like something the app is doing.
  devIndicators: false,
  serverExternalPackages: ['@prisma/client', 'exceljs'],
  images: {
    // Photos are hotlinked, never rehosted — listing images carry their own copyright.
    remotePatterns: [{ protocol: 'https', hostname: '**.zillowstatic.com' }],
  },
};

export default config;
