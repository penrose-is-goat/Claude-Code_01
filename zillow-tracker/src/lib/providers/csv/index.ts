import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { NormalizedListing } from '../normalized';
import type {
  FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';
import type { ListingStatus, PropertyType } from '../normalized';

/**
 * Ingests a CSV you exported yourself — Redfin's "Download All", an agent-emailed MLS
 * export, or anything with a header row.
 *
 * This is the honest fallback. It requires no API, breaks for nobody's reasons but your
 * own, and keeps the app fully functional if the live provider ever stops working.
 */

const COLUMN_ALIASES: Record<keyof MappedRow, string[]> = {
  addressLine1: ['address', 'street address', 'addressline1', 'full address', 'street'],
  city: ['city'],
  state: ['state', 'state or province', 'st'],
  postalCode: ['zip', 'zip code', 'postal code', 'zipcode', 'zip or postal code'],
  listPrice: ['price', 'list price', 'current price'],
  beds: ['beds', 'bedrooms', 'br'],
  bathsTotal: ['baths', 'bathrooms', 'total baths', 'ba'],
  livingAreaSqft: ['square feet', 'sqft', 'living area', 'sq ft', 'sqft total'],
  lotSizeSqft: ['lot size', 'lot size sqft', 'lot'],
  yearBuilt: ['year built', 'yearbuilt', 'year'],
  propertyType: ['property type', 'type', 'proptype', 'style'],
  status: ['status', 'mls status', 'listing status', 'standard status'],
  listingUrl: ['url', 'listing url', 'link'],
  lat: ['latitude', 'lat'],
  lng: ['longitude', 'lng', 'long'],
  mlsId: ['mls#', 'mls', 'mls number', 'mls id', 'listing id'],
  daysOnMarket: ['days on market', 'dom', 'cdom'],
};

interface MappedRow {
  addressLine1: string; city: string; state: string; postalCode: string;
  listPrice: string; beds: string; bathsTotal: string; livingAreaSqft: string;
  lotSizeSqft: string; yearBuilt: string; propertyType: string; status: string;
  listingUrl: string; lat: string; lng: string; mlsId: string; daysOnMarket: string;
}

export interface CsvProviderOptions {
  filePath?: string;
  csvText?: string;
  timezone?: string;
  now?: () => Date;
}

export class CsvImportProvider implements ListingProvider<NormalizedListing> {
  readonly id = 'csv' as const;
  readonly displayName = 'CSV import';
  readonly capabilities: ProviderCapabilities = {
    supportsOpenHouses: false, // most exports simply don't carry open-house times
    supportsPolygonQuery: false,
    supportsRadiusQuery: false,
    supportsPostalCodeQuery: false,
    supportsPhotos: false,
    supportsPriceHistory: false,
    rateLimit: null,
  };

  constructor(private options: CsvProviderOptions = {}) {}

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.options.filePath && !this.options.csvText) {
      return { ok: false, message: 'No CSV configured — upload one on the Settings page' };
    }
    try {
      const rows = await this.load();
      return { ok: rows.length > 0, message: `Parsed ${rows.length} rows` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async fetchPage(_opts: FetchOptions): Promise<ProviderPage<NormalizedListing>> {
    const raw = await this.load();
    return { raw, requestsUsed: 0 };
  }

  normalize(raw: NormalizedListing): NormalizedListing {
    return raw;
  }

  private async load(): Promise<NormalizedListing[]> {
    const text =
      this.options.csvText ??
      (this.options.filePath ? await readFile(this.options.filePath, 'utf8') : '');
    if (!text.trim()) return [];
    return parseCsvListings(text, this.options.now?.() ?? new Date());
  }
}

/** RFC4180-ish: handles quoted fields, embedded commas, escaped quotes, and CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }

  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function buildHeaderMap(header: string[]): Partial<Record<keyof MappedRow, number>> {
  const lowered = header.map((h) => h.trim().toLowerCase());
  const map: Partial<Record<keyof MappedRow, number>> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<[keyof MappedRow, string[]]>) {
    const idx = lowered.findIndex((h) => aliases.includes(h));
    if (idx >= 0) map[field] = idx;
  }
  return map;
}

export function parseCsvListings(text: string, fetchedAt: Date): NormalizedListing[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];

  const map = buildHeaderMap(rows[0]);
  if (map.addressLine1 == null) {
    throw new Error(
      `CSV has no recognizable address column. Saw: ${rows[0].join(', ')}`,
    );
  }

  const out: NormalizedListing[] = [];

  for (const row of rows.slice(1)) {
    const get = (f: keyof MappedRow): string => {
      const i = map[f];
      return i == null ? '' : (row[i] ?? '').trim();
    };

    const addressLine1 = get('addressLine1');
    if (!addressLine1) continue;

    const postalCode = get('postalCode');
    const city = get('city');
    const state = get('state');

    // No stable upstream id in a CSV, so derive one from the address. Deterministic, so
    // re-importing the same file updates rows instead of duplicating them.
    const sourceListingId =
      get('mlsId') ||
      createHash('sha1').update(`${addressLine1}|${city}|${state}|${postalCode}`).digest('hex').slice(0, 16);

    out.push({
      providerId: 'csv',
      sourceListingId,
      mlsId: get('mlsId') || undefined,
      addressLine1,
      city,
      state: state.toUpperCase(),
      postalCode,
      lat: numOrUndef(get('lat')),
      lng: numOrUndef(get('lng')),
      status: mapCsvStatus(get('status')),
      propertyType: mapCsvPropertyType(get('propertyType')),
      listPrice: intOrUndef(get('listPrice')),
      beds: numOrUndef(get('beds')),
      bathsTotal: numOrUndef(get('bathsTotal')),
      livingAreaSqft: intOrUndef(get('livingAreaSqft')),
      lotSizeSqft: intOrUndef(get('lotSizeSqft')),
      yearBuilt: intOrUndef(get('yearBuilt')),
      listingUrl: get('listingUrl') || undefined,
      providerDaysOnMarket: intOrUndef(get('daysOnMarket')),
      photos: [],
      openHouses: [],
      raw: Object.fromEntries(rows[0].map((h, i) => [h, row[i] ?? ''])),
      fetchedAt,
    });
  }

  return out;
}

function numOrUndef(s: string): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function intOrUndef(s: string): number | undefined {
  const n = numOrUndef(s);
  return n == null ? undefined : Math.round(n);
}

/**
 * CSV exports use human-facing vocabulary, not the portal's internal enums — Redfin
 * writes "Condo/Co-op" and "Single Family Residential" where Zillow's JSON says
 * "CONDO" and "SINGLE_FAMILY". Borrowing the Zillow mappers here silently produced
 * OTHER/UNKNOWN for every row, so this vocabulary is deliberately separate.
 *
 * Matching is substring-based because these labels vary between MLSs far more than
 * portal enums do, and an unrecognized label should degrade, never throw.
 */
export function mapCsvPropertyType(raw: string): PropertyType {
  const s = raw.toLowerCase();
  if (!s) return 'OTHER';
  if (s.includes('condo') || s.includes('co-op') || s.includes('coop')) return 'CONDO';
  if (s.includes('townhouse') || s.includes('townhome')) return 'TOWNHOUSE';
  if (s.includes('multi') || s.includes('duplex') || s.includes('triplex') || s.includes('fourplex')) return 'MULTI_FAMILY';
  if (s.includes('manufactured') || s.includes('mobile')) return 'MANUFACTURED';
  if (s.includes('land') || s.includes('lot') || s.includes('vacant')) return 'LAND';
  if (s.includes('single family') || s.includes('single-family') || s.includes('residential')) return 'SINGLE_FAMILY';
  return 'OTHER';
}

export function mapCsvStatus(raw: string): ListingStatus {
  const s = raw.toLowerCase().trim();
  // An export with no status column is a list of things currently for sale.
  if (!s) return 'ACTIVE';
  if (s.includes('pending')) return 'PENDING';
  if (s.includes('contingent') || s.includes('under contract')) return 'CONTINGENT';
  if (s.includes('sold') || s.includes('closed')) return 'SOLD';
  if (s.includes('coming soon')) return 'COMING_SOON';
  if (s.includes('withdrawn')) return 'WITHDRAWN';
  if (s.includes('expired')) return 'EXPIRED';
  if (s.includes('off market') || s.includes('off-market')) return 'OFF_MARKET';
  if (s.includes('active') || s.includes('for sale') || s.includes('mls listing')) return 'ACTIVE';
  return 'UNKNOWN';
}
