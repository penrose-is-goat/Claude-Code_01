import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateSaved } from '@/lib/db/queries';

export const runtime = 'nodejs';

const Body = z.object({
  notes: z.string().max(10_000).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  userStatus: z.enum(['NEW', 'WATCHING', 'TOURED', 'CONTACTED', 'REJECTED', 'OFFER']).optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid body' }, { status: 400 });
  }

  try {
    const saved = await updateSaved(id, parsed.data);
    return NextResponse.json({ ok: true, saved });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 404 },
    );
  }
}
