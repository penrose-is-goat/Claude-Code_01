import { NextResponse } from 'next/server';
import { markAllEventsSeen } from '@/lib/db/queries';

export const runtime = 'nodejs';

export async function POST() {
  const count = await markAllEventsSeen();
  return NextResponse.json({ ok: true, marked: count });
}
