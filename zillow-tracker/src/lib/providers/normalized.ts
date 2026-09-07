/**
 * The one shape every provider must produce.
 *
 * Modeled on the RESO Data Dictionary (notably the `OpenHouse` resource) so a licensed
 * MLS feed can be dropped in later without reshaping the database.
 */

export type ListingStatus =
  | 'ACTIVE'
  | 'COMING_SOON'
  | 'PENDING'
  | 'CONTINGENT'
  | 'SOLD'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'OFF_MARKET'
  | 'UNKNOWN';

export type PropertyType =
  | 'SINGLE_FAMILY'
  | 'CONDO'
  | 'TOWNHOUSE'
  | 'MULTI_FAMILY'
  | 'LAND'
  | 'MANUFACTURED'
  | 'OTHER';

/**
 * Photo URLs only, never the bytes. Listing photographs carry copyright independent of
 * the listing facts, so rehosting them is a separate and larger exposure than storing a
 * price. Hotlink or omit.
 */
export interface NormalizedPhoto {
  url: string;
  caption?: string;
  order: number;
}

export interface NormalizedOpenHouse {
  sourceOpenHouseId?: string;
  /** Stored UTC. Render in the listing's local timezone. */
  startsAt: Date;
  endsAt: Date;
  /** IANA zone, e.g. 'America/Denver'. */
  timezone: string;
  appointmentOnly: boolean;
  virtual: boolean;
  note?: string;
}

export interface NormalizedListing {
  // --- identity ---
  providerId: string;
  /** The provider's own stable id (zpid, MLS key, row hash...). */
  sourceListingId: string;
  mlsId?: string;
  mlsName?: string;

  // --- location ---
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  county?: string;
  lat?: number;
  lng?: number;

  // --- core facts ---
  status: ListingStatus;
  propertyType: PropertyType;
  /** Whole dollars, integer. Never a formatted string — Excel needs a real number. */
  listPrice?: number;
  originalListPrice?: number;
  beds?: number;
  bathsFull?: number;
  bathsHalf?: number;
  bathsTotal?: number;
  livingAreaSqft?: number;
  lotSizeSqft?: number;
  yearBuilt?: number;
  stories?: number;
  garageSpaces?: number;
  hoaFeeMonthly?: number;
  taxAnnual?: number;

  // --- listing meta ---
  listingUrl?: string;
  listedAt?: Date;
  /** Provider's own DOM figure. Shown as-is, but we also compute our own. */
  providerDaysOnMarket?: number;
  statusChangedAt?: Date;
  listingAgentName?: string;
  listingOfficeName?: string;
  description?: string;
  photos: NormalizedPhoto[];
  openHouses: NormalizedOpenHouse[];

  // --- provenance ---
  /** Raw provider payload, kept for debugging and future backfill. */
  raw: unknown;
  fetchedAt: Date;
}

/**
 * `firstSeenAt`, `lastSeenAt`, `contentHash` and `addressKey` are deliberately absent
 * here: those are computed by the ingest pipeline. A provider's only job is to report
 * what the source currently says.
 */
