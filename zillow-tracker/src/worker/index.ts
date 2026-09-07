import { Cron } from 'croner';
import { PrismaClient } from '@prisma/client';
import { runAllSearches } from '../lib/ingest/runner';

/**
 * Separate process, deliberately.
 *
 * Registering cron inside Next would re-register on every hot reload in dev and would
 * tie the schedule to a request lifecycle in production. This just runs.
 */
const prisma = new PrismaClient();

const SCHEDULE = process.env.POLL_CRON ?? '*/15 * * * *';

async function poll(): Promise<void> {
  const started = Date.now();
  try {
    const results = await runAllSearches(prisma);
    const seen = results.reduce((n, r) => n + r.listingsSeen, 0);
    const events = results.reduce((n, r) => n + r.eventsCreated, 0);
    console.log(
      `[worker] ${new Date().toISOString()} — ${results.length} run(s), ` +
      `${seen} listings, ${events} event(s) in ${Date.now() - started}ms`,
    );
    for (const r of results.filter((x) => !x.canaryOk)) {
      console.warn(`[worker] canary warning on ${r.searchName}: ${r.canaryReason}`);
    }
  } catch (err) {
    console.error('[worker] poll failed:', err);
  }
}

// `protect` stops a slow run from overlapping itself — the guard that matters most when
// a source gets slow rather than failing outright.
const job = new Cron(SCHEDULE, { protect: true }, poll);

console.log(`[worker] started; schedule "${SCHEDULE}"`);
console.log(`[worker] next run: ${job.nextRun()?.toISOString() ?? 'unknown'}`);

void poll(); // don't make the operator wait a full interval to see it work

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[worker] ${signal} — shutting down`);
    job.stop();
    void prisma.$disconnect().then(() => process.exit(0));
  });
}
