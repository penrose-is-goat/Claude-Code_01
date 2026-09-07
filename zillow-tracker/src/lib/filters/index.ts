import type { ListingFilterInput } from '../db/queries';
import { humanize } from './format';

export type SearchParams = Record<string, string | string[] | undefined>;

export const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export const numOrUndef = (v: string | string[] | undefined): number | undefined => {
  const s = one(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * URL <-> filter state lives here so the listings page and the Excel export are
 * guaranteed to interpret the same query string identically. Exporting "what I'm
 * looking at" is only true if both sides parse it the same way.
 */
export function parseFilters(sp: SearchParams): ListingFilterInput {
  const status = one(sp.status);
  const propertyType = one(sp.type);
  return {
    q: one(sp.q) || undefined,
    minPrice: numOrUndef(sp.minPrice),
    maxPrice: numOrUndef(sp.maxPrice),
    minBeds: numOrUndef(sp.minBeds),
    minBaths: numOrUndef(sp.minBaths),
    status: status ? [status] : undefined,
    propertyType: propertyType ? [propertyType] : undefined,
    searchId: one(sp.searchId) || undefined,
    openHouseOnly: one(sp.openHouse) === '1',
    favoritesOnly: one(sp.favorites) === '1',
    // Carried through the query string so the Excel export matches the page. /saved
    // shows delisted favorites deliberately; without this the export dropped them and
    // said nothing, so the file quietly disagreed with the screen.
    includeRemoved: one(sp.includeRemoved) === '1',
    sort: (one(sp.sort) as ListingFilterInput['sort']) || 'newest',
  };
}

export function describeFilters(f: ListingFilterInput): string {
  const parts: string[] = [];
  if (f.q) parts.push(`search "${f.q}"`);
  if (f.minPrice != null) parts.push(`min $${f.minPrice.toLocaleString()}`);
  if (f.maxPrice != null) parts.push(`max $${f.maxPrice.toLocaleString()}`);
  if (f.minBeds != null) parts.push(`${f.minBeds}+ beds`);
  if (f.minBaths != null) parts.push(`${f.minBaths}+ baths`);
  if (f.status?.length) parts.push(`status ${f.status.map(humanize).join('/')}`);
  if (f.propertyType?.length) parts.push(`type ${f.propertyType.map(humanize).join('/')}`);
  if (f.openHouseOnly) parts.push('has upcoming open house');
  if (f.favoritesOnly) parts.push('favorites only');
  if (f.searchId) parts.push(`search ${f.searchId}`);
  if (f.includeRemoved) parts.push('including delisted');
  return parts.join(', ');
}
