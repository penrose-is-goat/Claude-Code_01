import { PrismaClient } from '@prisma/client';

/**
 * Next dev-mode hot reload re-evaluates modules, which would otherwise leak a new
 * PrismaClient (and a new SQLite handle) on every save.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
