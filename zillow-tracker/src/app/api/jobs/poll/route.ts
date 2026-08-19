import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { runAllAreas } from '@/lib/ingest/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manual and scheduled entry point. The worker calls the same code path directly, so
 * "Run poll now" in the UI and the 15-minute cron exercise identical logic.
 *
 * Guarded by a bearer token when POLL_TOKEN is set, so exposing this host doesn't hand
 * anyone a way to drive outbound requests on your behalf.
 */
export async function POST(request: Request) {
  const expected = process.env.POLL_TOKEN;
  if (expected) {
    const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const sameOrigin = request.headers.get('sec-fetch-site') === 'same-origin';
    if (provided !== expected && !sameOrigin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  const areaId = url.searchParams.get('areaId') ?? undefined;

  try {
    // Same tracker semantics as the CLI: refresh replaces, it does not accumulate.
    const rebuild = url.searchParams.get('merge') !== '1';
    const results = await runAllAreas(prisma, { areaId, rebuild });
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ hint: 'POST to this endpoint to trigger a poll' });
}
