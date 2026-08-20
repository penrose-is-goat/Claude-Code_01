import { z } from 'zod';

/**
 * Validates the wire shape of `SearchQuery` (src/lib/search/types.ts) at the API
 * boundary. Lives under src/app because src/lib is owned by the backend rebuild — this
 * mirrors that contract rather than importing a runtime validator from it.
 */
export const LocationSchema = z.union([
  z.object({
    kind: z.literal('place'),
    query: z.string().min(1).max(200),
    radiusMiles: z.number().positive().max(100),
  }),
  z.object({
    kind: z.literal('drawn'),
    ring: z.array(z.tuple([z.number(), z.number()])).min(3),
    label: z.string().max(200).optional(),
  }),
]);

export const ListingFiltersSchema = z.object({
  minPrice: z.number().nonnegative().optional(),
  maxPrice: z.number().nonnegative().optional(),
  minBeds: z.number().nonnegative().optional(),
  minBaths: z.number().nonnegative().optional(),
  propertyTypes: z
    .array(z.enum(['SINGLE_FAMILY', 'CONDO', 'TOWNHOUSE', 'MULTI_FAMILY', 'LAND', 'MANUFACTURED', 'OTHER']))
    .optional(),
  openHouseOnly: z.boolean().optional(),
});

export const SearchQuerySchema = z.object({
  location: LocationSchema,
  filters: ListingFiltersSchema.default({}),
  openHouseOnly: z.boolean().optional(),
});

export const SavedSearchInputSchema = z.object({
  name: z.string().min(1).max(120),
  query: SearchQuerySchema,
  cron: z.string().max(60).nullable().optional(),
  notifyOnNew: z.boolean().optional(),
  notifyOnPriceDrop: z.boolean().optional(),
  notifyOnOpenHouse: z.boolean().optional(),
});
