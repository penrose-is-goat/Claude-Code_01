import type { PrismaClient } from '@prisma/client';
import { getProvider } from '../providers/registry';
import type { AreaQuery, ListingFilters, ProviderId } from '../providers/types';
import { pollArea, type AreaSpec, type PollResult } from './pipeline';

/**
 * Turns stored Area rows into pipeline runs. Shared by the API route and the worker so
 * both take exactly the same path — a scheduled poll and a button press must not be able
 * to behave differently.
 */

export function areaToQuery(area: {
  kind: string; postalCodes: string | null; city: string | null; state: string | null;
  centerLat: number | null; centerLng: number | null; radiusMiles: number | null; polygon: string | null;
}): AreaQuery {
  switch (area.kind) {
    case 'POSTAL_CODES': {
      const codes = safeJson<string[]>(area.postalCodes, []);
      return { kind: 'postalCodes', codes };
    }
    case 'CITY_RADIUS':
      return {
        kind: 'cityRadius',
        city: area.city ?? '',
        state: area.state ?? '',
        centerLat: area.centerLat ?? undefined,
        centerLng: area.centerLng ?? undefined,
        radiusMiles: area.radiusMiles ?? 5,
      };
    case 'POLYGON':
      return { kind: 'polygon', ring: safeJson<Array<[number, number]>>(area.polygon, []) };
    default:
      throw new Error(`Unknown area kind: ${area.kind}`);
  }
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface RunnerOptions {
  areaId?: string;
  now?: Date;
}

export async function runAllAreas(
  db: PrismaClient,
  opts: RunnerOptions = {},
): Promise<Array<PollResult & { areaName: string; providerId: string }>> {
  const areas = await db.area.findMany({
    where: { active: true, ...(opts.areaId ? { id: opts.areaId } : {}) },
  });

  const results: Array<PollResult & { areaName: string; providerId: string }> = [];

  for (const area of areas) {
    const providerIds = safeJson<ProviderId[]>(area.providerIds, ['zillow']);
    const spec: AreaSpec = {
      id: area.id,
      name: area.name,
      query: areaToQuery(area),
      filters: safeJson<ListingFilters | undefined>(area.filters, undefined),
    };

    for (const providerId of providerIds) {
      // One provider failing must not abort the remaining areas — pollArea already
      // records a FAILED run, so the log tells the story.
      const provider = getProvider(providerId);
      const result = await pollArea(db, provider, spec, { now: opts.now });
      results.push({ ...result, areaName: area.name, providerId });
    }
  }

  return results;
}
