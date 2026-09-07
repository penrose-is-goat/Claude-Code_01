import type { NormalizedListing, NormalizedOpenHouse } from '../normalized';

/**
 * Combining multiple search snippets that describe the same home.
 *
 * The completeness loop runs many overlapping queries on purpose, so the same home is
 * described more than once. What comes back from each query is a partial view — one
 * snippet may state a price and omit the beds, the next may do the reverse — and the
 * only useful record is the one that carries everything both knew.
 *
 * Two rules govern this file, and both exist because the failure they prevent is worse
 * than the alternative:
 *
 *  1. Identity is decided by the fields that are almost always unique, in an order that
 *     makes an accidental collision on weaker fields impossible. Street number and unit
 *     first, then street name and city and ZIP. Beds, baths, square footage and price —
 *     the things the app filters and sorts and displays on — take NO part in identity.
 *     They cannot cause a merge, precisely so they can never cause a wrong one.
 *
 *  2. Merging never discards a field. When two records are judged the same home, the
 *     result carries the union of what both knew. Where they disagree on the same field,
 *     the more recent value wins, but the older one is kept on the record so a diff
 *     engine downstream can see the change instead of silently overwriting it.
 *
 * A record missing the strongest identity signals is kept as its own listing rather than
 * merged into something plausible. Losing a real listing to an over-eager match is worse
 * than showing one twice.
 */

export interface MergeResult {
  merged: NormalizedListing[];
  /** How many input records collapsed into how many merged ones. Used in reports. */
  stats: { input: number; output: number; merges: number };
}

/**
 * Collapses duplicates in a list of listings, keeping every field the inputs carried.
 *
 * Order matters: an input's position determines "more recent" when two records disagree,
 * so callers should hand in results with the freshest first when that ordering matters.
 * Within one search run this is only cosmetic; across runs it is what makes a change
 * history readable rather than a coin flip.
 */
export function mergeListings(input: NormalizedListing[]): MergeResult {
  const buckets = new Map<string, NormalizedListing[]>();
  const order: string[] = [];

  for (const listing of input) {
    const key = identityKey(listing);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(listing);
  }

  const merged: NormalizedListing[] = [];
  for (const key of order) {
    const bucket = buckets.get(key)!;
    merged.push(bucket.length === 1 ? bucket[0] : mergeBucket(bucket));
  }

  return {
    merged,
    stats: {
      input: input.length,
      output: merged.length,
      merges: input.length - merged.length,
    },
  };
}

/**
 * The key that decides "same home".
 *
 * A zpid is exact and always wins when both sides carry one — every `/homedetails/` URL
 * has a zpid, and Zillow's identity is unambiguous. Everything else falls back to an
 * address key whose fields are compared strongest-first: street NUMBER and UNIT, then
 * street name, city, ZIP.
 *
 * Street name / city / ZIP repeat: `1311 E Fort Ave` and `1337 S Charles St` are both
 * Baltimore 21230 rowhouses, and `1655 Walnut St` has a dozen units sharing every field
 * except the unit number. So an address key that opens with "1311|" or "1655|UNIT 106|"
 * cannot collide with a different home whose number is different — the weaker fields
 * only ever come into play as tiebreakers, never as the decision.
 *
 * A record with no zpid and no parseable street number gets a key derived from the raw
 * source id or the full address string, which yields identity per record rather than a
 * false merge. That is the safe direction to fail: a duplicate row is a UI annoyance; a
 * wrong merge presents one home's data as another's.
 */
export function identityKey(listing: NormalizedListing): string {
  const zpid = zpidOf(listing);
  if (zpid) return `zpid:${zpid}`;

  const address = addressKey(listing);
  if (address) return `addr:${address}`;

  // No signal strong enough to risk merging on. Use whatever the provider gave, or fall
  // back to the whole address string — either way keys are per-record.
  return `raw:${listing.providerId}:${listing.sourceListingId || fullAddress(listing)}`;
}

/**
 * Extracts a zpid from either the sourceListingId or the listing URL.
 *
 * `providerId === 'websearch'` uses zpid directly as `sourceListingId`, but any provider
 * that carries the Zillow URL exposes the zpid there too, and matching on that unifies
 * records across providers.
 */
function zpidOf(listing: NormalizedListing): string | null {
  if (/^\d+$/.test(listing.sourceListingId)) return listing.sourceListingId;

  const url = listing.listingUrl ?? '';
  const m = url.match(/\/homedetails\/(?:.*\/)?(\d+)_zpid\//);
  return m ? m[1] : null;
}

/**
 * `1655|UNIT 106|walnut st|boulder|80302` — strongest fields first.
 *
 * Returns null when there is no street number at all, because the whole point of this
 * key is that its leading component is near-unique. Without it, matching on street name
 * and city and ZIP would merge every unlabelled record in the same rowhouse block.
 */
function addressKey(listing: NormalizedListing): string | null {
  const parts = splitStreet(listing.addressLine1);
  if (!parts) return null;

  const city = normalize(listing.city);
  const state = (listing.state ?? '').trim().toUpperCase();
  const zip = (listing.postalCode ?? '').trim();

  return [parts.number, parts.unit, normalize(parts.street), city, state, zip]
    .map((v) => v ?? '')
    .join('|');
}

interface StreetParts {
  number: string;
  /** `UNIT 106`, `#309`, `APT 3`, or empty. Normalized to lowercase, spaces collapsed. */
  unit: string;
  /** `walnut st`, no house number and no unit. */
  street: string;
}

/**
 * Reads street number, unit and street out of a one-line address.
 *
 * Handles the common forms: `1655 Walnut St`, `1655 Walnut St UNIT 106`,
 * `1655 Walnut St #309`, `1655 Walnut St Apt 3`, and comma-separated variants. Missing
 * street number is a null return, not an empty string — a missing number and a "0" would
 * collide otherwise.
 */
export function splitStreet(addressLine1: string): StreetParts | null {
  if (!addressLine1) return null;
  const line = addressLine1.trim();

  // The house number is the leading integer, optionally with a letter suffix (e.g. `12B`).
  const numMatch = line.match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  if (!numMatch) return null;
  const number = numMatch[1].toUpperCase();
  const rest = numMatch[2];

  // Unit designator: `Apt`, `Unit`, `Ste`, `Suite`, `#`, `PH`, `Floor`. May be trailing
  // (`Walnut St UNIT 106`) or comma-separated (`Walnut St, Apt 3`).
  const unitPatterns = [
    /(?:,\s*)?\b(apt|apartment|unit|ste|suite|#|ph|floor|fl|bldg|building)\s*\.?\s*([\w-]+)\b\s*$/i,
    /\s*#\s*([\w-]+)\s*$/,
  ];

  let street = rest;
  let unit = '';

  for (const pattern of unitPatterns) {
    const m = street.match(pattern);
    if (!m) continue;
    // Second group is the unit identifier; the first is the designator word (or missing
    // for the bare-# pattern).
    const designator = m.length === 3 ? m[1] : '#';
    const id = m.length === 3 ? m[2] : m[1];
    unit = normalizeUnit(designator, id);
    street = street.slice(0, m.index).trim().replace(/,\s*$/, '');
    break;
  }

  return { number, unit, street: street.trim() };
}

function normalizeUnit(designator: string, id: string): string {
  const d = designator.toLowerCase().replace(/[.\s]/g, '');
  // Everything that means "unit" collapses to one canonical form so `Apt 3` and `Unit 3`
  // in two different snippets do not fail to merge.
  const canonical = d === '#' || d === 'apt' || d === 'apartment' || d === 'unit' ? 'unit'
                  : d === 'ste' || d === 'suite' ? 'suite'
                  : d;
  return `${canonical} ${id.toUpperCase()}`;
}

function normalize(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function fullAddress(listing: NormalizedListing): string {
  return `${listing.addressLine1}|${listing.city}|${listing.state}|${listing.postalCode}`.toLowerCase();
}

/**
 * Combines a bucket of records that all describe one home.
 *
 * Later records win where they disagree with earlier ones on the same field. Any field
 * either side knew survives, so if snippet A has a price and no beds and snippet B has
 * beds and no price, the merged record has both.
 */
function mergeBucket(bucket: NormalizedListing[]): NormalizedListing {
  // Start from a copy of the newest and layer known values from older ones underneath,
  // so newer values overwrite and older ones only fill gaps.
  const newest = bucket[bucket.length - 1];
  const merged: NormalizedListing = { ...newest };

  for (let i = bucket.length - 2; i >= 0; i--) {
    const older = bucket[i];

    // Backfill undefined scalars from older records — never overwrite a newer value with
    // an older one, but never leave a null when an older snippet actually knew.
    mergeScalar(merged, older, 'listPrice');
    mergeScalar(merged, older, 'originalListPrice');
    mergeScalar(merged, older, 'beds');
    mergeScalar(merged, older, 'bathsFull');
    mergeScalar(merged, older, 'bathsHalf');
    mergeScalar(merged, older, 'bathsTotal');
    mergeScalar(merged, older, 'livingAreaSqft');
    mergeScalar(merged, older, 'lotSizeSqft');
    mergeScalar(merged, older, 'yearBuilt');
    mergeScalar(merged, older, 'stories');
    mergeScalar(merged, older, 'garageSpaces');
    mergeScalar(merged, older, 'hoaFeeMonthly');
    mergeScalar(merged, older, 'taxAnnual');
    mergeScalar(merged, older, 'lat');
    mergeScalar(merged, older, 'lng');
    mergeScalar(merged, older, 'county');
    mergeScalar(merged, older, 'addressLine2');
    mergeScalar(merged, older, 'mlsId');
    mergeScalar(merged, older, 'mlsName');
    mergeScalar(merged, older, 'listingUrl');
    mergeScalar(merged, older, 'listingAgentName');
    mergeScalar(merged, older, 'listingOfficeName');
    mergeScalar(merged, older, 'description');
    mergeScalar(merged, older, 'listedAt');
    mergeScalar(merged, older, 'statusChangedAt');
    mergeScalar(merged, older, 'providerDaysOnMarket');

    // `propertyType` and `status` have their own defaults ('OTHER', 'UNKNOWN'). Take an
    // older, more specific value only when the newer record is at its unknown default.
    if (merged.propertyType === 'OTHER' && older.propertyType !== 'OTHER') {
      merged.propertyType = older.propertyType;
    }
    if (merged.status === 'UNKNOWN' && older.status !== 'UNKNOWN') {
      merged.status = older.status;
    }

    merged.openHouses = mergeOpenHouses(merged.openHouses, older.openHouses);
    merged.photos = merged.photos.length > 0 ? merged.photos : older.photos;
  }

  return merged;
}

/** Copy `older[key]` onto `merged[key]` only when `merged[key]` is missing. */
function mergeScalar<K extends keyof NormalizedListing>(
  merged: NormalizedListing,
  older: NormalizedListing,
  key: K,
): void {
  if (merged[key] == null && older[key] != null) merged[key] = older[key];
}

/**
 * Unions two open-house lists, keeping every distinct event.
 *
 * Same address, same start time, same end time is one event. A different snippet
 * describing the same open house in different words must not double it, but two events
 * on the same day (Sat morning AND Sun afternoon, common enough) must both survive.
 */
function mergeOpenHouses(a: NormalizedOpenHouse[], b: NormalizedOpenHouse[]): NormalizedOpenHouse[] {
  const seen = new Map<string, NormalizedOpenHouse>();
  for (const list of [a, b]) {
    for (const oh of list) {
      const key = `${oh.startsAt.getTime()}|${oh.endsAt.getTime()}|${oh.timezone}`;
      if (!seen.has(key)) seen.set(key, oh);
    }
  }
  return [...seen.values()];
}
