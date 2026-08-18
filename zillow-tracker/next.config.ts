import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['@prisma/client', 'exceljs'],
  images: {
    // Photos are hotlinked, never rehosted — listing images carry their own copyright.
    remotePatterns: [{ protocol: 'https', hostname: '**.zillowstatic.com' }],
  },
};

export default config;
