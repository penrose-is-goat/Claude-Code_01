import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedListing, PropertyType } from '../normalized';
import type {
  FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';
import { wallClockToUtc } from '../zillow/parse';

/**
 * Replays real listing data captured from public listing pages.
 *
 * This is NOT a fixture generator and it invents nothing. Every field it emits was
 * observed; fields the source did not expose (coordinates, year built, per-listing open
 * house windows) stay null rather than being filled in with plausible-looking values.
 * The capture's provenance — when, from where, and what was missing — travels with the
 * data and is surfaced on the Settings page.
 *
 * Change detection works by comparing snapshots taken at different times. With a single
 * capture, repeated polling correctly yields zero events; that is the honest result, and
 * it exercises the false-positive guards that matter most.
 */

/**
 * Top-level `snapshots/`, deliberately NOT inside `data/`.
 *
 * `data/` holds the SQLite database, which is disposable runtime state that gets wiped
 * and rebuilt. The captures are source data checked into the repo. Keeping them in the
 * same directory meant clearing runtime state destroyed the dataset.
 */
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR ?? join(process.cwd(), 'snapshots');

export interface SnapshotProvenance {
  capturedAt: string;
  method: string;
  sources: string[];
  knownGaps: string[];
  marketContext?: Record<string, unknown>;
  openHouseCounts?: Record<string, number>;
}

interface SnapshotOpenHouse {
  /** Local wall-clock, e.g. "2026-08-22T09:00". Converted using `timezone` on load. */
  localStart: string;
  localEnd: string;
  timezone: string;
  appointmentOnly?: boolean;
  virtual?: boolean;
}

interface SnapshotRow {
  sourceListingId: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  listPrice: number | null;
  beds: number | null;
  bathsTotal: number | null;
  livingAreaSqft: number | null;
  propertyType: string;
  lat?: number | null;
  lng?: number | null;
  yearBuilt?: number | null;
  listingUrl?: string | null;
  openHouses?: SnapshotOpenHouse[];
}

export interface SnapshotFile {
  provenance: SnapshotProvenance;
  listings: SnapshotRow[];
}

export class SnapshotProvider implements ListingProvider<NormalizedListing> {
  readonly id = 'snapshot' as const;
  readonly displayName = 'Captured snapshot (real data)';
  readonly capabilities: ProviderCapabilities = {
    // Zillow's public open-house pages do pair a window to an address, and the capture
    // carries those pairs, so this is now genuinely supported.
    supportsOpenHouses: true,
    supportsPolygonQuery: false,
    supportsRadiusQuery: false,
    supportsPhotos: false,
    supportsPriceHistory: false,
    rateLimit: null,
  };

  private loaded: { rows: NormalizedListing[]; provenance: SnapshotProvenance } | null = null;

  constructor(private dir = SNAPSHOT_DIR, private index = -1) {}

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const files = await this.list();
      if (files.length === 0) {
        return { ok: false, message: `No snapshots in ${this.dir}` };
      }
      const { rows, provenance } = await this.load();
      return {
        ok: rows.length > 0,
        message: `${rows.length} real listings captured ${provenance.capturedAt.slice(0, 10)} (${files.length} snapshot${files.length === 1 ? '' : 's'} available)`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async provenance(): Promise<SnapshotProvenance | null> {
    try {
      return (await this.load()).provenance;
    } catch {
      return null;
    }
  }

  async fetchPage(opts: FetchOptions): Promise<ProviderPage<NormalizedListing>> {
    const { rows } = await this.load();
    let raw = rows;

    const f = opts.filters;
    if (f) {
      raw = raw.filter((l) => {
        if (f.minPrice != null && (l.listPrice ?? 0) < f.minPrice) return false;
        if (f.maxPrice != null && (l.listPrice ?? Infinity) > f.maxPrice) return false;
        if (f.minBeds != null && (l.beds ?? 0) < f.minBeds) return false;
        if (f.minBaths != null && (l.bathsTotal ?? 0) < f.minBaths) return false;
        if (f.propertyTypes?.length && !f.propertyTypes.includes(l.propertyType)) return false;
        return true;
      });
    }

    return { raw, requestsUsed: 0 };
  }

  normalize(raw: NormalizedListing): NormalizedListing {
    return raw;
  }

  private async list(): Promise<string[]> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    return entries.filter((f) => f.endsWith('.json')).sort();
  }

  private async load(): Promise<{ rows: NormalizedListing[]; provenance: SnapshotProvenance }> {
    if (this.loaded) return this.loaded;

    const files = await this.list();
    if (files.length === 0) throw new Error(`No snapshot files found in ${this.dir}`);

    // An explicit index replays a single capture, which is how a real before/after
    // comparison is driven. Otherwise every capture is merged, because separate files
    // cover different slices (for-sale sweeps vs open-house sweeps) of the same market.
    const chosenFiles = this.index >= 0 ? [files[Math.min(this.index, files.length - 1)]] : files;

    const byId = new Map<string, NormalizedListing>();
    let newest: SnapshotProvenance | null = null;

    for (const file of chosenFiles) {
      const parsed = JSON.parse(await readFile(join(this.dir, file), 'utf8')) as SnapshotFile;
      if (!newest || parsed.provenance.capturedAt > newest.capturedAt) newest = parsed.provenance;
      for (const row of this.toListings(parsed)) byId.set(row.sourceListingId, row);
    }

    this.loaded = { rows: [...byId.values()], provenance: newest! };
    return this.loaded;
  }

  private toListings(parsed: SnapshotFile): NormalizedListing[] {
    const fetchedAt = new Date(parsed.provenance.capturedAt);
    return parsed.listings.map<NormalizedListing>((r) => ({
      providerId: 'snapshot',
      sourceListingId: r.sourceListingId,
      addressLine1: r.addressLine1,
      city: r.city,
      state: r.state,
      postalCode: r.postalCode,
      // Left undefined on purpose when the source did not publish them.
      lat: r.lat ?? undefined,
      lng: r.lng ?? undefined,
      status: 'ACTIVE',
      propertyType: normalizeType(r.propertyType),
      listPrice: r.listPrice ?? undefined,
      beds: r.beds ?? undefined,
      bathsTotal: r.bathsTotal ?? undefined,
      livingAreaSqft: r.livingAreaSqft ?? undefined,
      yearBuilt: r.yearBuilt ?? undefined,
      // Always link back to Zillow. This app tracks listings; it does not host them,
      // so every row is a pointer to the source rather than a replacement for it.
      listingUrl: r.listingUrl ?? zillowAddressUrl(r),
      photos: [],
      openHouses: (r.openHouses ?? []).flatMap((o) => {
        // Wall-clock plus zone, converted with the same helper the live parser uses,
        // rather than UTC computed by hand at capture time.
        const startsAt = wallClockToUtc(o.localStart, o.timezone);
        const endsAt = wallClockToUtc(o.localEnd, o.timezone);
        if (!startsAt || !endsAt || endsAt <= startsAt) return [];
        return [{
          startsAt, endsAt, timezone: o.timezone,
          appointmentOnly: o.appointmentOnly ?? false,
          virtual: o.virtual ?? false,
        }];
      }),
      raw: r,
      fetchedAt,
    }));
  }
}

/**
 * Zillow's address-search URL. Works without a zpid, so a listing captured from a
 * search page still deep-links to its own Zillow page.
 */
export function zillowAddressUrl(r: {
  addressLine1: string; city: string; state: string; postalCode: string;
}): string {
  const slug = [r.addressLine1, r.city, `${r.state} ${r.postalCode}`]
    .map((part) => part.trim().replace(/\s+/g, '-'))
    .join(',-');
  return `https://www.zillow.com/homes/${encodeURI(slug)}_rb/`;
}

function normalizeType(s: string): PropertyType {
  const known: PropertyType[] = [
    'SINGLE_FAMILY', 'CONDO', 'TOWNHOUSE', 'MULTI_FAMILY', 'LAND', 'MANUFACTURED', 'OTHER',
  ];
  return known.includes(s as PropertyType) ? (s as PropertyType) : 'OTHER';
}
