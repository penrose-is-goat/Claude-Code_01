import { NextResponse } from 'next/server';
import { toggleFavorite } from '@/lib/db/queries';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const favorite = await toggleFavorite(id);
    return NextResponse.json({ ok: true, favorite });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 404 },
    );
  }
}
