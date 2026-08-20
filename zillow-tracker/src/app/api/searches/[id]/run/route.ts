import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
// TODO(backend): see TODOs in ../../route.ts and ../../../search/route.ts for the
// exact getSavedSearch / runSearch signatures this composes.
import { getSavedSearch } from '@/lib/db/searches';
import { runSearch } from '@/lib/search/service';

export const runtime = 'nodejs';

/** Re-runs a saved search's stored query on demand — the "Run" button on the dashboard
 * card and the "Refresh now" button on /searches both hit this. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const saved = await getSavedSearch(id).catch(() => null);
  if (!saved) {
    return NextResponse.json({ error: 'Saved search not found' }, { status: 404 });
  }

  try {
    // TODO(backend): stamping `lastRunAt` on manual runs (not just scheduled polls) is
    // left to the saved-search repo / ingest pipeline, whichever ends up owning writes
    // to that field, rather than duplicated here.
    const outcome = await runSearch(prisma, saved.query, { signal: request.signal });
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Search failed' },
      { status: 502 },
    );
  }
}
