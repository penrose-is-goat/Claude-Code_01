import { createHash } from 'node:crypto';
import type { NormalizedListing, NormalizedOpenHouse } from '../providers/normalized';

/**
 * Identity for the SAME listing across DIFFERENT providers.
 *
 * This is what lets your saved favorites and notes survive a provider swap: the
 * SavedListing row is keyed on addressKey, not on a provider's internal id.
 */
export function addressKey(l: {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
}): string {
  // Some providers put the unit in line 2 rather than line 1. Folding both through the
  // same normalizer keeps "123 Oak St / Apt 4" and "123 Oak St Apt 4" on one key.
  const combined = [l.addressLine1, l.addressLine2].filter(Boolean).join(' ');
  const norm = normalizeStreet(combined);
  const zip5 = (l.postalCode || '').trim().slice(0, 5);
  const basis = `${norm}|${l.city.trim().toLowerCase()}|${l.state.trim().toUpperCase()}|${zip5}`;
  return createHash('sha1').update(basis).digest('hex');
}

const STREET_SUFFIXES: Record<string, string> = {
  street: 'st', str: 'st', st: 'st',
  avenue: 'ave', av: 'ave', ave: 'ave',
  road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  circle: 'cir', cir: 'cir',
  boulevard: 'blvd', blvd: 'blvd',
  place: 'pl', pl: 'pl',
  terrace: 'ter', ter: 'ter',
  parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  way: 'way', trail: 'trl', trl: 'trl',
};

const DIRECTIONALS: Record<string, string> = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

/**
 * "1234 North Elm Street  Apt. 2B" -> "1234 n elm st apt 2b"
 *
 * Deliberately conservative: we only fold well-known suffixes and directionals. Getting
 * clever here risks collapsing two genuinely different addresses into one key.
 */
export function normalizeStreet(raw: string): string {
  const unitFolded = raw
    .toLowerCase()
    // Providers disagree on unit syntax for the same door: Zillow emits "APT 3",
    // Redfin and MLS exports emit "Unit 3", humans write "#3". Fold them to one
    // token, otherwise the same home gets three addressKeys and a provider swap
    // loses the notes this key exists to protect.
    .replace(/[.,]/g, ' ')
    .replace(/\b(?:apartment|apt|unit|suite|ste|building|bldg|no)\b\s*#?\s*([a-z0-9-]+)/g, ' unit $1 ')
    .replace(/#\s*([a-z0-9-]+)/g, ' unit $1 ');

  return unitFolded
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((tok) => DIRECTIONALS[tok] ?? STREET_SUFFIXES[tok] ?? tok)
    .join(' ');
}

/**
 * Content fingerprint over the fields we consider "meaningful change".
 *
 * This is the gate that keeps the database small. If the hash is unchanged we bump
 * lastSeenAt and write nothing else — no snapshot, no event. A 40-listing area polled
 * every 15 minutes produces roughly zero rows/day when nothing is happening.
 *
 * Note what is EXCLUDED: fetchedAt, providerDaysOnMarket, and the raw payload. Those
 * change on every single poll and would defeat the whole mechanism.
 */
export function contentHash(l: NormalizedListing): string {
  const canonical = {
    status: l.status,
    listPrice: l.listPrice ?? null,
    beds: l.beds ?? null,
    bathsTotal: l.bathsTotal ?? null,
    livingAreaSqft: l.livingAreaSqft ?? null,
    lotSizeSqft: l.lotSizeSqft ?? null,
    yearBuilt: l.yearBuilt ?? null,
    hoaFeeMonthly: l.hoaFeeMonthly ?? null,
    description: l.description?.trim() ?? null,
    // Every field below is one the pipeline PERSISTS. The hash is not merely a
    // change detector here — an unchanged hash short-circuits the write entirely,
    // so anything omitted becomes write-once: the first value ever reported would
    // be permanent, and a corrected address or backfilled coordinate could never
    // land. Keep this in sync with toRow().
    addressLine1: l.addressLine1,
    addressLine2: l.addressLine2 ?? null,
    city: l.city,
    state: l.state,
    postalCode: l.postalCode,
    lat: l.lat ?? null,
    lng: l.lng ?? null,
    propertyType: l.propertyType,
    listingUrl: l.listingUrl ?? null,
    photos: l.photos.map((p) => p.url).sort(),
    openHouses: canonicalOpenHouses(l.openHouses),
  };
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex');
}

/** Order-independent so a provider reshuffling its array is not a "change". */
export function canonicalOpenHouses(ohs: NormalizedOpenHouse[]): string[] {
  return ohs
    .map((o) => `${o.startsAt.toISOString()}/${o.endsAt.toISOString()}/${o.timezone}/${o.appointmentOnly ? 'a' : ''}${o.virtual ? 'v' : ''}`)
    .sort();
}

/** Stable key for a single open-house occurrence within a listing. */
export function openHouseKey(o: NormalizedOpenHouse): string {
  return `${o.startsAt.toISOString()}|${o.endsAt.toISOString()}`;
}
