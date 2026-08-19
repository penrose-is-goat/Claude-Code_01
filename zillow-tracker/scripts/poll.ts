import { PrismaClient } from '@prisma/client';
import { runAllAreas } from '../src/lib/ingest/runner';

/** One-shot poll from the CLI — the fastest way to see the pipeline do something. */
const prisma = new PrismaClient();

async function main() {
  // Rebuild by default: this is a tracker, so each refresh reflects the market as it is
  // now rather than accumulating a standing local copy. Pass --merge to keep the old
  // behaviour when comparing two captures.
  const rebuild = !process.argv.includes('--merge');
  const results = await runAllAreas(prisma, { rebuild });

  if (results.length === 0) {
    console.log('No active areas. Run `npm run seed` first.');
    return;
  }

  console.log('\n  area                  provider  status   seen  new  events');
  console.log('  ' + '-'.repeat(60));
  for (const r of results) {
    console.log(
      `  ${r.areaName.padEnd(21)} ${r.providerId.padEnd(9)} ${r.status.padEnd(8)} ` +
      `${String(r.listingsSeen).padStart(4)} ${String(r.listingsNew).padStart(4)} ${String(r.eventsCreated).padStart(7)}`,
    );
    if (!r.canaryOk) console.log(`    canary: ${r.canaryReason}`);
    if (r.delisted > 0) console.log(`    delisted: ${r.delisted}`);
    if (r.errorMessage) console.log(`    error: ${r.errorMessage}`);
  }
  console.log();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
