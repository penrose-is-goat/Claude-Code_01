import type { Prisma, PrismaClient } from '@prisma/client';
import type { NormalizedListing } from '../providers/normalized';
import type { AreaQuery, ListingFilters, ListingProvider } from '../providers/types';
import { fetchAll } from '../providers/types';
import { filterListingsToArea } from '../geo';
import { addressKey, contentHash } from './hash';
import { diffListing, type ListingEventInput, type PriorState } from './diff';
import { checkCanary, evaluateAbsence, type RunContext } from './absence';

/**
 * fetch -> normalize -> geofilter -> upsert -> diff -> events
 *
 * Ordering matters: the geo filter runs BEFORE the upsert so we never store listings
 * outside the area, and the diff runs against the pre-upsert state so we can still see
 * what changed.
 */

export interface AreaSpec {
  id: string;
  name: string;
  query: AreaQuery;
  filters?: ListingFilters;
}

export interface PollResult {
  runId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  listingsSeen: number;
  listingsNew: number;
  eventsCreated: number;
  requestsUsed: number;
  canaryOk: boolean;
  canaryReason?: string;
  delisted: number;
  errorMessage?: string;
}

export async function pollArea(
  db: PrismaClient,
  provider: ListingProvider<any>,
  area: AreaSpec,
  opts: { now?: Date } = {},
): Promise<PollResult> {
  const now = opts.now ?? new Date();

  const previousRun = await db.pollRun.findFirst({
    where: { areaId: area.id, providerId: provider.id, status: 'SUCCESS' },
    orderBy: { startedAt: 'desc' },
  });

  const run = await db.pollRun.create({
    data: { areaId: area.id, providerId: provider.id, status: 'RUNNING', startedAt: now },
  });

  try {
    const { raw, requestsUsed } = await fetchAll(provider, {
      area: area.query,
      filters: area.filters,
    });

    // A provider that throws on one bad row must not lose the other 39.
    const normalized: NormalizedListing[] = [];
    let skipped = 0;
    for (const r of raw) {
      try {
        normalized.push(provider.normalize(r));
      } catch {
        skipped++;
      }
    }

    const inArea = filterListingsToArea(normalized, area.query);

    const runCtx: RunContext = {
      status: 'SUCCESS',
      listingsSeen: inArea.length,
      previousListingsSeen: previousRun?.listingsSeen ?? null,
      startedAt: now,
    };

    const canary = checkCanary({
      listingsSeen: inArea.length,
      previousListingsSeen: previousRun?.listingsSeen ?? null,
      expectedSourceIds: [],
      seenSourceIds: new Set(inArea.map((l) => l.sourceListingId)),
    });

    let listingsNew = 0;
    let eventsCreated = 0;

    for (const listing of inArea) {
      const outcome = await upsertListing(db, listing, area.id, run.id, now);
      if (outcome.isNew) listingsNew++;
      eventsCreated += outcome.eventsCreated;
    }

    const delisted = await reconcileAbsent(
      db, provider.id, area.id, new Set(inArea.map((l) => l.sourceListingId)), runCtx, run.id, now,
    );

    const status = skipped > 0 ? 'PARTIAL' : 'SUCCESS';

    await db.pollRun.update({
      where: { id: run.id },
      data: {
        status, finishedAt: new Date(), listingsSeen: inArea.length, listingsNew,
        eventsCreated, requestsUsed, canaryOk: canary.ok, canaryReason: canary.reason,
        errorMessage: skipped > 0 ? `${skipped} record(s) could not be parsed` : null,
      },
    });

    return {
      runId: run.id, status, listingsSeen: inArea.length, listingsNew, eventsCreated,
      requestsUsed, canaryOk: canary.ok, canaryReason: canary.reason, delisted,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.pollRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: message },
    });
    return {
      runId: run.id, status: 'FAILED', listingsSeen: 0, listingsNew: 0, eventsCreated: 0,
      requestsUsed: 0, canaryOk: false, canaryReason: message, delisted: 0, errorMessage: message,
    };
  }
}

interface UpsertOutcome {
  isNew: boolean;
  changed: boolean;
  eventsCreated: number;
}

export async function upsertListing(
  db: PrismaClient,
  listing: NormalizedListing,
  areaId: string,
  pollRunId: string,
  now: Date,
): Promise<UpsertOutcome> {
  const sourceKey = `${listing.providerId}:${listing.sourceListingId}`;
  const hash = contentHash(listing);
  const addrKey = addressKey(listing);

  const existing = await db.listing.findUnique({
    where: { sourceKey },
    include: { openHouses: true },
  });

  // Fast path: nothing meaningful changed. Touch lastSeenAt and stop. This is what makes
  // 15-minute polling cheap enough to leave running forever.
  if (existing && existing.contentHash === hash) {
    await db.listing.update({
      where: { id: existing.id },
      data: { lastSeenAt: now, missedRunCount: 0, removedAt: null },
    });
    await linkArea(db, existing.id, areaId);
    return { isNew: false, changed: false, eventsCreated: 0 };
  }

  const prior: PriorState | null = existing
    ? {
        status: existing.status as PriorState['status'],
        listPrice: existing.listPrice,
        description: existing.description,
        photoCount: (JSON.parse(existing.photos) as unknown[]).length,
        openHouses: existing.openHouses.map((o) => ({
          startsAt: o.startsAt, endsAt: o.endsAt, timezone: o.timezone,
          appointmentOnly: o.appointmentOnly, virtual: o.virtual,
          note: o.note ?? undefined,
        })),
      }
    : null;

  const events = diffListing(prior, listing);
  const data = toRow(listing, sourceKey, addrKey, hash, now);

  const saved = existing
    ? await db.listing.update({
        where: { id: existing.id },
        data: { ...data, firstSeenAt: existing.firstSeenAt, lastChangedAt: now },
      })
    : await db.listing.create({ data: { ...data, firstSeenAt: now, lastChangedAt: now } });

  await db.listingSnapshot.create({
    data: {
      listingId: saved.id, contentHash: hash, listPrice: listing.listPrice ?? null,
      status: listing.status, payload: JSON.stringify(serializable(listing)), pollRunId,
    },
  });

  await syncOpenHouses(db, saved.id, listing, now);
  await linkArea(db, saved.id, areaId);
  await writeEvents(db, saved.id, events, pollRunId, now);

  return { isNew: !existing, changed: true, eventsCreated: events.length };
}

function toRow(
  l: NormalizedListing, sourceKey: string, addrKey: string, hash: string, now: Date,
): Prisma.ListingUncheckedCreateInput {
  return {
    providerId: l.providerId,
    sourceListingId: l.sourceListingId,
    sourceKey,
    addressKey: addrKey,
    mlsId: l.mlsId ?? null,
    mlsName: l.mlsName ?? null,
    addressLine1: l.addressLine1,
    addressLine2: l.addressLine2 ?? null,
    city: l.city,
    state: l.state,
    postalCode: l.postalCode,
    county: l.county ?? null,
    lat: l.lat ?? null,
    lng: l.lng ?? null,
    status: l.status,
    propertyType: l.propertyType,
    listPrice: l.listPrice ?? null,
    originalListPrice: l.originalListPrice ?? null,
    beds: l.beds ?? null,
    bathsFull: l.bathsFull ?? null,
    bathsHalf: l.bathsHalf ?? null,
    bathsTotal: l.bathsTotal ?? null,
    livingAreaSqft: l.livingAreaSqft ?? null,
    lotSizeSqft: l.lotSizeSqft ?? null,
    yearBuilt: l.yearBuilt ?? null,
    stories: l.stories ?? null,
    garageSpaces: l.garageSpaces ?? null,
    hoaFeeMonthly: l.hoaFeeMonthly ?? null,
    taxAnnual: l.taxAnnual ?? null,
    listingUrl: l.listingUrl ?? null,
    listingAgentName: l.listingAgentName ?? null,
    listingOfficeName: l.listingOfficeName ?? null,
    description: l.description ?? null,
    photos: JSON.stringify(l.photos),
    listedAt: l.listedAt ?? null,
    providerDaysOnMarket: l.providerDaysOnMarket ?? null,
    statusChangedAt: l.statusChangedAt ?? null,
    lastSeenAt: now,
    missedRunCount: 0,
    removedAt: null,
    contentHash: hash,
    raw: JSON.stringify(l.raw ?? null),
  };
}

/** Dates survive JSON.stringify as ISO strings; that's fine for the snapshot payload. */
function serializable(l: NormalizedListing): unknown {
  return { ...l, raw: undefined };
}

async function linkArea(db: PrismaClient, listingId: string, areaId: string): Promise<void> {
  await db.listingArea.upsert({
    where: { listingId_areaId: { listingId, areaId } },
    create: { listingId, areaId },
    update: {},
  });
}

async function syncOpenHouses(
  db: PrismaClient, listingId: string, l: NormalizedListing, now: Date,
): Promise<void> {
  for (const oh of l.openHouses) {
    await db.openHouse.upsert({
      where: {
        listingId_startsAt_endsAt: { listingId, startsAt: oh.startsAt, endsAt: oh.endsAt },
      },
      create: {
        listingId, startsAt: oh.startsAt, endsAt: oh.endsAt, timezone: oh.timezone,
        appointmentOnly: oh.appointmentOnly, virtual: oh.virtual,
        note: oh.note ?? null, sourceOpenHouseId: oh.sourceOpenHouseId ?? null,
      },
      update: {
        lastSeenAt: now, cancelledAt: null,
        appointmentOnly: oh.appointmentOnly, virtual: oh.virtual,
      },
    });
  }

  // Anything still in the future that the source stopped listing is a cancellation.
  const keep = new Set(l.openHouses.map((o) => `${o.startsAt.toISOString()}|${o.endsAt.toISOString()}`));
  const stored = await db.openHouse.findMany({ where: { listingId, cancelledAt: null } });
  for (const s of stored) {
    const key = `${s.startsAt.toISOString()}|${s.endsAt.toISOString()}`;
    if (!keep.has(key) && s.endsAt.getTime() > now.getTime()) {
      await db.openHouse.update({ where: { id: s.id }, data: { cancelledAt: now } });
    }
  }
}

async function writeEvents(
  db: PrismaClient, listingId: string, events: ListingEventInput[], pollRunId: string, now: Date,
): Promise<void> {
  if (events.length === 0) return;
  await db.listingEvent.createMany({
    data: events.map((e) => ({
      listingId, type: e.type, occurredAt: now,
      oldValue: e.oldValue ?? null, newValue: e.newValue ?? null,
      deltaAbs: e.deltaAbs ?? null, deltaPct: e.deltaPct ?? null,
      message: e.message, pollRunId,
    })),
  });
}

/**
 * Handle listings we did NOT see this run. See absence.ts for why this is deliberately
 * slow to conclude anything.
 */
async function reconcileAbsent(
  db: PrismaClient, providerId: string, areaId: string, seenIds: Set<string>,
  run: RunContext, pollRunId: string, now: Date,
): Promise<number> {
  const tracked = await db.listing.findMany({
    where: { providerId, removedAt: null, areas: { some: { areaId } } },
    select: { id: true, sourceListingId: true, missedRunCount: true, removedAt: true, addressLine1: true },
  });

  let delisted = 0;

  for (const t of tracked) {
    const seen = seenIds.has(t.sourceListingId);
    const decision = evaluateAbsence(
      { missedRunCount: t.missedRunCount, removedAt: t.removedAt }, seen, run,
    );

    if (decision.missedRunCount === t.missedRunCount && !decision.shouldMarkDelisted) continue;

    await db.listing.update({
      where: { id: t.id },
      data: {
        missedRunCount: decision.missedRunCount,
        removedAt: decision.shouldMarkDelisted ? now : null,
      },
    });

    if (decision.shouldMarkDelisted) {
      delisted++;
      await db.listingEvent.create({
        data: {
          listingId: t.id, type: 'DELISTED', occurredAt: now, pollRunId,
          message: `No longer listed: ${t.addressLine1}`,
        },
      });
    }
  }

  return delisted;
}
