import { NextResponse } from 'next/server';
import { z } from 'zod';
// TODO(backend): expects src/lib/db/searches.ts to export:
//   updateSavedSearch(id: string, patch: Partial<{ name, active, cron, notifyOnNew,
//     notifyOnPriceDrop, notifyOnOpenHouse }>): Promise<SavedSearchRecord>
//   deleteSavedSearch(id: string): Promise<void>
import { updateSavedSearch, deleteSavedSearch } from '@/lib/db/searches';

export const runtime = 'nodejs';

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  cron: z.string().max(60).nullable().optional(),
  notifyOnNew: z.boolean().optional(),
  notifyOnPriceDrop: z.boolean().optional(),
  notifyOnOpenHouse: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid update' }, { status: 400 });
  }

  try {
    const updated = await updateSavedSearch(id, parsed.data);
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not update search' },
      { status: 404 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteSavedSearch(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not delete search' },
      { status: 404 },
    );
  }
}
