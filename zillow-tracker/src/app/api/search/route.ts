import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
// TODO(backend): expects src/lib/search/service.ts to export
// `runSearch(db: PrismaClient, query: SearchQuery, opts?: { signal?: AbortSignal }): Promise<SearchOutcome>`
// per the contract in src/lib/search/types.ts. Not present yet as of this write — see
// src/lib/search/geocode.ts for the Geocoder this presumably composes with providers.
import { runSearch } from '@/lib/search/service';
import { SearchQuerySchema } from '../_lib/searchQuerySchema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ad-hoc search — does not persist anything. "Track this search" (POST /api/searches)
 * is the separate, explicit save step; running a search must never silently start
 * tracking it.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = SearchQuerySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid search query' }, { status: 400 });
  }

  try {
    const outcome = await runSearch(prisma, parsed.data, { signal: request.signal });
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Search failed' },
      { status: 502 },
    );
  }
}
