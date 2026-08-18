import type { NormalizedListing, NormalizedOpenHouse, ListingStatus } from '../providers/normalized';
import { openHouseKey } from './hash';

/**
 * The heart of the app. Kept a PURE function of (previous, next) so it can be exhaustively
 * unit-tested without a database, a network, or a clock.
 */

export type ListingEventType =
  | 'NEW_LISTING'
  | 'PRICE_CHANGE'
  | 'STATUS_CHANGE'
  | 'BACK_ON_MARKET'
  | 'OPEN_HOUSE_ADDED'
  | 'OPEN_HOUSE_CHANGED'
  | 'OPEN_HOUSE_CANCELLED'
  | 'PHOTOS_ADDED'
  | 'DESCRIPTION_CHANGED'
  | 'DELISTED';

export interface ListingEventInput {
  type: ListingEventType;
  oldValue?: string;
  newValue?: string;
  /** Price delta in whole dollars. Negative means a price DROP (the good kind). */
  deltaAbs?: number;
  deltaPct?: number;
  /** Pre-rendered so the UI and the Excel export never re-derive prose. */
  message: string;
}

/** Statuses that mean "you can still buy this". */
const ON_MARKET: ReadonlySet<ListingStatus> = new Set<ListingStatus>([
  'ACTIVE',
  'COMING_SOON',
]);

/** The previous state we need in order to diff. Mirrors the stored Listing row. */
export interface PriorState {
  status: ListingStatus;
  listPrice?: number | null;
  description?: string | null;
  photoCount: number;
  openHouses: NormalizedOpenHouse[];
}

export function diffListing(
  prev: PriorState | null,
  next: NormalizedListing,
): ListingEventInput[] {
  if (prev === null) {
    return [
      {
        type: 'NEW_LISTING',
        newValue: next.listPrice != null ? String(next.listPrice) : undefined,
        message: `New listing: ${next.addressLine1}, ${next.city}${
          next.listPrice != null ? ` — ${usd(next.listPrice)}` : ''
        }`,
      },
      // A listing that appears with open houses already attached should surface those
      // too, otherwise a Saturday open house discovered on first sight is invisible.
      ...next.openHouses.map(openHouseAdded),
    ];
  }

  const events: ListingEventInput[] = [];

  events.push(...diffPrice(prev, next));
  events.push(...diffStatus(prev, next));
  events.push(...diffOpenHouses(prev.openHouses, next.openHouses));

  if (next.photos.length > prev.photoCount) {
    events.push({
      type: 'PHOTOS_ADDED',
      oldValue: String(prev.photoCount),
      newValue: String(next.photos.length),
      message: `${next.photos.length - prev.photoCount} new photo(s) added`,
    });
  }

  const prevDesc = prev.description?.trim() ?? '';
  const nextDesc = next.description?.trim() ?? '';
  if (prevDesc !== nextDesc && nextDesc.length > 0) {
    events.push({
      type: 'DESCRIPTION_CHANGED',
      message: 'Listing description was updated',
    });
  }

  return events;
}

function diffPrice(prev: PriorState, next: NormalizedListing): ListingEventInput[] {
  const before = prev.listPrice ?? null;
  const after = next.listPrice ?? null;
  if (before == null || after == null || before === after) return [];

  const deltaAbs = after - before;
  const deltaPct = before === 0 ? 0 : (deltaAbs / before) * 100;
  const direction = deltaAbs < 0 ? 'dropped' : 'increased';

  return [
    {
      type: 'PRICE_CHANGE',
      oldValue: String(before),
      newValue: String(after),
      deltaAbs,
      deltaPct: round2(deltaPct),
      message: `Price ${direction} ${usd(Math.abs(deltaAbs))} (${
        deltaAbs < 0 ? '' : '+'
      }${round2(deltaPct)}%) — ${usd(before)} to ${usd(after)}`,
    },
  ];
}

function diffStatus(prev: PriorState, next: NormalizedListing): ListingEventInput[] {
  if (prev.status === next.status) return [];

  const events: ListingEventInput[] = [
    {
      type: 'STATUS_CHANGE',
      oldValue: prev.status,
      newValue: next.status,
      message: `Status changed: ${humanStatus(prev.status)} to ${humanStatus(next.status)}`,
    },
  ];

  // Coming back to market after pending/contingent is the single most actionable signal
  // in the whole app — a deal fell through and almost nobody else is watching for it.
  if (!ON_MARKET.has(prev.status) && ON_MARKET.has(next.status)) {
    events.push({
      type: 'BACK_ON_MARKET',
      oldValue: prev.status,
      newValue: next.status,
      message: `Back on market (was ${humanStatus(prev.status)})`,
    });
  }

  return events;
}

/**
 * Open houses are matched on their start/end window, not on array position or on a
 * provider-supplied id — providers reorder freely and often omit ids entirely.
 */
function diffOpenHouses(
  before: NormalizedOpenHouse[],
  after: NormalizedOpenHouse[],
): ListingEventInput[] {
  const beforeMap = new Map(before.map((o) => [openHouseKey(o), o]));
  const afterMap = new Map(after.map((o) => [openHouseKey(o), o]));
  const events: ListingEventInput[] = [];

  for (const [key, oh] of afterMap) {
    if (!beforeMap.has(key)) {
      events.push(openHouseAdded(oh));
      continue;
    }
    const old = beforeMap.get(key)!;
    if (old.appointmentOnly !== oh.appointmentOnly || old.virtual !== oh.virtual) {
      events.push({
        type: 'OPEN_HOUSE_CHANGED',
        oldValue: describeOpenHouse(old),
        newValue: describeOpenHouse(oh),
        message: `Open house details changed: ${describeOpenHouse(oh)}`,
      });
    }
  }

  for (const [key, oh] of beforeMap) {
    if (afterMap.has(key)) continue;
    // A past open house simply ageing out of the feed is not a cancellation.
    if (oh.endsAt.getTime() < Date.now()) continue;
    events.push({
      type: 'OPEN_HOUSE_CANCELLED',
      oldValue: describeOpenHouse(oh),
      message: `Open house cancelled: ${describeOpenHouse(oh)}`,
    });
  }

  return events;
}

function openHouseAdded(oh: NormalizedOpenHouse): ListingEventInput {
  return {
    type: 'OPEN_HOUSE_ADDED',
    newValue: describeOpenHouse(oh),
    message: `Open house scheduled: ${describeOpenHouse(oh)}`,
  };
}

export function describeOpenHouse(o: NormalizedOpenHouse): string {
  const day = o.startsAt.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: o.timezone,
  });
  const from = o.startsAt.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: o.timezone,
  });
  const to = o.endsAt.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: o.timezone,
  });
  const tags = [o.appointmentOnly ? 'by appointment' : null, o.virtual ? 'virtual' : null]
    .filter(Boolean)
    .join(', ');
  return `${day} ${from}–${to}${tags ? ` (${tags})` : ''}`;
}

export function humanStatus(s: ListingStatus): string {
  return s.toLowerCase().replace(/_/g, ' ');
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
