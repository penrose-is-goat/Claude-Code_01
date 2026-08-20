import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Accepts either the root client or a transaction handle, so the same helpers run
 * inside and outside a transaction without duplication.
 */
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
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

/** How many recent runs contribute to the "is this run suspiciously short" baseline. */
const BASELINE_RUN_WINDOW = 5;
/** How many long-lived active listings act as canaries for a schema break. */
const CANARY_SAMPLE_SIZE = 5;

type PollStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

export interface SearchSpec {
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

export async function pollSearch(
  db: PrismaClient,
  provider: ListingProvider<any>,
  area: SearchSpec,
  opts: { now?: Date } = {},
): Promise<PollResult> {
  const now = opts.now ?? new Date();

  // Baseline from the best of several recent runs, not just the immediately preceding
  // one. With a single-run baseline a truncation becomes its own baseline on the very
  // next poll: 100 -> 50 is distrusted, but 50 -> 50 looks perfectly healthy, and the
  // run after that happily delists 50 homes that never left the market.
  const recentRuns = await db.pollRun.findMany({
    where: { searchId: area.id, providerId: provider.id, status: { in: ['SUCCESS', 'PARTIAL'] } },
    orderBy: { startedAt: 'desc' },
    take: BASELINE_RUN_WINDOW,
  });
  const baselineSeen = recentRuns.length
    ? Math.max(...recentRuns.map((r) => r.listingsSeen))
    : null;

  // Known-good listings that SHOULD come back. checkCanary documents these as the point
  // of the mechanism, but the only caller used to pass an empty array, leaving just the
  // zero-result and 50%-drop heuristics — neither of which fires when a source starts
  // returning a full page of entirely different data.
  const canaryIds = (
    await db.listing.findMany({
      where: {
        providerId: provider.id,
        removedAt: null,
        status: { in: ['ACTIVE', 'COMING_SOON'] },
        searches: { some: { searchId: area.id, absentSince: null } },
      },
      orderBy: { firstSeenAt: 'asc' },
      take: CANARY_SAMPLE_SIZE,
      select: { sourceListingId: true },
    })
  ).map((l) => l.sourceListingId);

  const run = await db.pollRun.create({
    data: { searchId: area.id, providerId: provider.id, status: 'RUNNING', startedAt: now },
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
    const seenIds = new Set(inArea.map((l) => l.sourceListingId));

    // Computed BEFORE the run context is built. Previously the context hardcoded
    // 'SUCCESS' and the real status was derived afterwards, so absence.ts's guard
    // against evicting on a PARTIAL run could never fire from its only caller — a
    // parser break would delist every row it failed to parse.
    const status: PollStatus = skipped > 0 ? 'PARTIAL' : 'SUCCESS';

    const canary = checkCanary({
      listingsSeen: inArea.length,
      previousListingsSeen: baselineSeen,
      expectedSourceIds: canaryIds,
      seenSourceIds: seenIds,
    });

    const runCtx: RunContext = {
      status,
      listingsSeen: inArea.length,
      previousListingsSeen: baselineSeen,
      recentListingsSeen: recentRuns.map((r) => r.listingsSeen),
      canaryOk: canary.ok,
      startedAt: now,
    };

    let listingsNew = 0;
    let eventsCreated = 0;

    // One query for the whole batch instead of a findUnique per listing. In the steady
    // state almost nothing has changed, and the old shape spent ~7 round trips per
    // unchanged listing to discover exactly that.
    const existingRows = await db.listing.findMany({
      where: { sourceKey: { in: inArea.map((l) => `${l.providerId}:${l.sourceListingId}`) } },
      include: {
        openHouses: { where: { cancelledAt: null } },
        searches: { where: { searchId: area.id } },
      },
    });
    const existingByKey = new Map(existingRows.map((r) => [r.sourceKey, r]));

    // Unchanged listings need only a lastSeenAt touch, which batches into one statement.
    const untouched: string[] = [];

    for (const listing of inArea) {
      const outcome = await upsertListing(
        db, listing, area.id, run.id, now,
        { existing: existingByKey.get(`${listing.providerId}:${listing.sourceListingId}`) ?? null,
          deferTouch: untouched },
      );
      if (outcome.isNew) listingsNew++;
      eventsCreated += outcome.eventsCreated;
    }

    if (untouched.length > 0) {
      await db.listing.updateMany({
        where: { id: { in: untouched } },
        data: { lastSeenAt: now, removedAt: null },
      });
      await db.listingSearch.updateMany({
        where: { searchId: area.id, listingId: { in: untouched } },
        data: { missedRunCount: 0, absentSince: null },
      });
    }

    const delisted = await reconcileAbsent(db, provider.id, area.id, seenIds, runCtx, run.id, now);

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

interface UpsertContext {
  /**
   * Prefetched row, so a batch of listings costs one query instead of N. Pass
   * `undefined` to let this function fetch it itself (used by tests and one-off calls).
   */
  existing?: ExistingListing | null;
  /**
   * Ids of listings that needed nothing but a lastSeenAt touch, collected so the caller
   * can flush them in a single statement.
   */
  deferTouch?: string[];
}

type ExistingListing = Awaited<ReturnType<typeof fetchExisting>>;

async function fetchExisting(db: PrismaClient, sourceKey: string, searchId: string) {
  return db.listing.findUnique({
    where: { sourceKey },
    include: {
      // Only live open houses form the "before" picture. Including cancelled ones made
      // every later edit re-emit OPEN_HOUSE_CANCELLED for the same event, and made a
      // reinstated open house silent because the stale row was still present.
      openHouses: { where: { cancelledAt: null } },
      searches: { where: { searchId } },
    },
  });
}

export async function upsertListing(
  db: PrismaClient,
  listing: NormalizedListing,
  searchId: string,
  pollRunId: string,
  now: Date,
  ctx: UpsertContext = {},
): Promise<UpsertOutcome> {
  const sourceKey = `${listing.providerId}:${listing.sourceListingId}`;
  const hash = contentHash(listing);
  const addrKey = addressKey(listing);

  const existing =
    ctx.existing !== undefined ? ctx.existing : await fetchExisting(db, sourceKey, searchId);

  const searchLink = existing?.searches[0];
  const wasAbsentHere = Boolean(searchLink?.absentSince);
  const wasRemoved = Boolean(existing?.removedAt);

  // Fast path: nothing meaningful changed. Touch lastSeenAt and stop — this is what
  // makes 15-minute polling cheap enough to leave running forever.
  if (existing && existing.contentHash === hash) {
    const events: ListingEventInput[] = [];

    // ...unless it had been written off. A listing coming back is the single most
    // actionable thing this app can tell you, and it used to slip through here
    // completely silently because unchanged content skipped event generation.
    if (wasRemoved || wasAbsentHere) {
      events.push({
        type: 'BACK_ON_MARKET',
        oldValue: 'DELISTED',
        newValue: listing.status,
        message: `Relisted: ${listing.addressLine1} is showing up again`,
      });
    }

    const alreadyLinked = Boolean(searchLink);

    // The overwhelmingly common case: unchanged, already linked, nothing to announce.
    // Hand it to the caller to flush in bulk rather than opening a transaction per row.
    if (events.length === 0 && alreadyLinked && ctx.deferTouch) {
      ctx.deferTouch.push(existing.id);
      return { isNew: false, changed: false, eventsCreated: 0 };
    }

    await db.$transaction(async (tx) => {
      await tx.listing.update({
        where: { id: existing.id },
        data: { lastSeenAt: now, removedAt: null },
      });
      await linkSearch(tx, existing.id, searchId, now);
      await writeEvents(tx, existing.id, events, pollRunId, now);
    });

    return { isNew: false, changed: false, eventsCreated: events.length };
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

  const events = diffListing(prior, listing, now);
  if (wasRemoved || wasAbsentHere) {
    events.unshift({
      type: 'BACK_ON_MARKET',
      oldValue: 'DELISTED',
      newValue: listing.status,
      message: `Relisted: ${listing.addressLine1} is showing up again`,
    });
  }

  const data = toRow(listing, sourceKey, addrKey, hash, now);

  // One transaction for the whole listing.
  //
  // The row carries contentHash, and an unchanged hash short-circuits all later work.
  // So writing the row before its events is only safe if the two cannot separate: a
  // throw in between used to leave the new hash committed with no event, and every
  // subsequent poll then took the fast path — losing that price drop permanently.
  await db.$transaction(async (tx) => {
    const saved = existing
      ? await tx.listing.update({
          where: { id: existing.id },
          data: { ...data, firstSeenAt: existing.firstSeenAt, lastChangedAt: now },
        })
      : await tx.listing.create({ data: { ...data, firstSeenAt: now, lastChangedAt: now } });

    await tx.listingSnapshot.create({
      data: {
        listingId: saved.id, contentHash: hash, listPrice: listing.listPrice ?? null,
        status: listing.status, payload: JSON.stringify(serializable(listing)), pollRunId,
      },
    });

    await syncOpenHouses(tx, saved.id, listing, now);
    await linkSearch(tx, saved.id, searchId, now);
    await writeEvents(tx, saved.id, events, pollRunId, now);
  });

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
    removedAt: null,
    contentHash: hash,
    raw: JSON.stringify(l.raw ?? null),
  };
}

/** Dates survive JSON.stringify as ISO strings; that's fine for the snapshot payload. */
function serializable(l: NormalizedListing): unknown {
  return { ...l, raw: undefined };
}

/** Links a listing to a search and clears any absence recorded for THAT search. */
async function linkSearch(
  db: TxClient, listingId: string, searchId: string, now: Date,
): Promise<void> {
  await db.listingSearch.upsert({
    where: { listingId_searchId: { listingId, searchId } },
    create: { listingId, searchId, matchedAt: now },
    update: { missedRunCount: 0, absentSince: null },
  });
}

async function syncOpenHouses(
  db: TxClient, listingId: string, l: NormalizedListing, now: Date,
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
        // Included deliberately: a corrected timezone otherwise never lands, and every
        // open-house view renders with `timeZone: oh.timezone`, so the user sees a wrong
        // hour that no amount of re-polling can repair.
        timezone: oh.timezone,
        note: oh.note ?? null,
      },
    });
  }

  // Anything still in the future that the source stopped listing is a cancellation.
  const keep = new Set(l.openHouses.map((o) => `${o.startsAt.toISOString()}|${o.endsAt.toISOString()}`));
  const stored = await db.openHouse.findMany({ where: { listingId, cancelledAt: null } });
  for (const st of stored) {
    const key = `${st.startsAt.toISOString()}|${st.endsAt.toISOString()}`;
    if (!keep.has(key) && st.endsAt.getTime() > now.getTime()) {
      await db.openHouse.update({ where: { id: st.id }, data: { cancelledAt: now } });
    }
  }
}

async function writeEvents(
  db: TxClient, listingId: string, events: ListingEventInput[], pollRunId: string, now: Date,
): Promise<void> {
  if (events.length === 0) return;
  await db.listingEvent.createMany({
    data: events.map((e) => ({
      listingId, type: e.type, occurredAt: now,
      oldValue: e.oldValue ?? null, newValue: e.newValue ?? null,
      deltaAbs: Number.isFinite(e.deltaAbs) ? e.deltaAbs! : null,
      deltaPct: Number.isFinite(e.deltaPct) ? e.deltaPct! : null,
      message: e.message, pollRunId,
    })),
  });
}

/**
 * Handles listings this search did NOT see. Absence accrues per SEARCH — see the note
 * on the ListingSearch model for why a single per-listing counter was wrong in both
 * directions once more than one search was in play.
 *
 * A listing is only marked removed once every search tracking it has given up on it.
 */
async function reconcileAbsent(
  db: PrismaClient, providerId: string, searchId: string, seenIds: Set<string>,
  run: RunContext, pollRunId: string, now: Date,
): Promise<number> {
  const links = await db.listingSearch.findMany({
    where: { searchId, listing: { providerId } },
    include: {
      listing: { select: { id: true, sourceListingId: true, addressLine1: true, removedAt: true } },
    },
  });

  let delisted = 0;

  for (const link of links) {
    const seen = seenIds.has(link.listing.sourceListingId);
    const decision = evaluateAbsence(
      { missedRunCount: link.missedRunCount, removedAt: link.absentSince },
      seen,
      run,
    );

    const unchanged =
      decision.missedRunCount === link.missedRunCount && !decision.shouldMarkDelisted;
    if (unchanged) continue;

    await db.listingSearch.update({
      where: { listingId_searchId: { listingId: link.listingId, searchId } },
      data: {
        missedRunCount: decision.missedRunCount,
        absentSince: decision.shouldMarkDelisted ? now : link.absentSince,
      },
    });

    if (!decision.shouldMarkDelisted) continue;

    // Only announce it as gone if no other search can still see it.
    const stillVisibleElsewhere = await db.listingSearch.count({
      where: { listingId: link.listingId, searchId: { not: searchId }, absentSince: null },
    });
    if (stillVisibleElsewhere > 0) continue;
    if (link.listing.removedAt) continue;

    delisted++;
    await db.$transaction(async (tx) => {
      await tx.listing.update({ where: { id: link.listingId }, data: { removedAt: now } });
      await tx.listingEvent.create({
        data: {
          listingId: link.listingId, type: 'DELISTED', occurredAt: now, pollRunId,
          message: `No longer listed: ${link.listing.addressLine1}`,
        },
      });
    });
  }

  return delisted;
}
