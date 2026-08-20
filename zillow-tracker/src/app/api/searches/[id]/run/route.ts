import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { getSavedSearch, markSearchRun } from '@/lib/db/searches';
import { runSearch } from '@/lib/search/service';

export const runtime = 'nodejs';

/** Re-runs a saved search's stored query on demand — the "Run" button on the dashboard
 * card and the "Refresh now" button on /searches both hit this. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const saved = await getSavedSearch(id);
  if (!saved) {
    return NextResponse.json({ error: 'Saved search not found' }, { status: 404 });
  }

  try {
    const outcome = await runSearch(prisma, saved.query, { signal: request.signal });
    // Best-effort: a stamp failure should not turn a successful search into an error.
    await markSearchRun(id, new Date()).catch(() => {});
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Search failed' },
      { status: 502 },
    );
  }
}
