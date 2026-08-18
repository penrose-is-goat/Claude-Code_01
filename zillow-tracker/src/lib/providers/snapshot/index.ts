import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedListing, PropertyType } from '../normalized';
import type {
  FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';

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

const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR ?? join(process.cwd(), 'data', 'snapshots');

export interface SnapshotProvenance {
  capturedAt: string;
  method: string;
  sources: string[];
  knownGaps: string[];
  marketContext?: Record<string, unknown>;
  openHouseCounts?: Record<string, number>;
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
}

export interface SnapshotFile {
  provenance: SnapshotProvenance;
  listings: SnapshotRow[];
}

export class SnapshotProvider implements ListingProvider<NormalizedListing> {
  readonly id = 'snapshot' as const;
  readonly displayName = 'Captured snapshot (real data)';
  readonly capabilities: ProviderCapabilities = {
    // The capture did not pair open-house windows to specific addresses, so this
    // provider declares it cannot supply them rather than inventing the join.
    supportsOpenHouses: false,
    supportsPolygonQuery: false,
    supportsRadiusQuery: false,
    supportsPostalCodeQuery: true,
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

    // Default to the most recent capture; an explicit index allows replaying an older
    // one, which is how a real before/after comparison is driven.
    const chosen = this.index >= 0 ? files[Math.min(this.index, files.length - 1)] : files[files.length - 1];
    const parsed = JSON.parse(await readFile(join(this.dir, chosen), 'utf8')) as SnapshotFile;

    const fetchedAt = new Date(parsed.provenance.capturedAt);
    const rows = parsed.listings.map<NormalizedListing>((r) => ({
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
      listingUrl: r.listingUrl ?? undefined,
      photos: [],
      openHouses: [],
      raw: r,
      fetchedAt,
    }));

    this.loaded = { rows, provenance: parsed.provenance };
    return this.loaded;
  }
}

function normalizeType(s: string): PropertyType {
  const known: PropertyType[] = [
    'SINGLE_FAMILY', 'CONDO', 'TOWNHOUSE', 'MULTI_FAMILY', 'LAND', 'MANUFACTURED', 'OTHER',
  ];
  return known.includes(s as PropertyType) ? (s as PropertyType) : 'OTHER';
}
