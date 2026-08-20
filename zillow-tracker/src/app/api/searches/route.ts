import { NextResponse } from 'next/server';
// TODO(backend): expects src/lib/db/searches.ts to export:
//   getSavedSearches(): Promise<SavedSearchRecord[]>
//   createSavedSearch(input: SavedSearchInput): Promise<SavedSearchRecord>
// where SavedSearchInput is the type of that name in src/lib/search/types.ts, and
// SavedSearchRecord additionally carries id/active/createdAt/lastRunAt with `query`
// and `resolved` already parsed back from their stored JSON text.
import { getSavedSearches, createSavedSearch } from '@/lib/db/searches';
import { SavedSearchInputSchema } from '../_lib/searchQuerySchema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const searches = await getSavedSearches();
  return NextResponse.json({ searches });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = SavedSearchInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid saved search' }, { status: 400 });
  }

  try {
    const saved = await createSavedSearch(parsed.data);
    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not save search' },
      { status: 500 },
    );
  }
}
