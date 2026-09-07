import { prisma } from '@/lib/db/client';
import { findListings } from '@/lib/db/queries';
import { parseFilters, describeFilters, type SearchParams } from '@/lib/filters';
import { buildWorkbook, type ExportListing, type ExportOpenHouse, type ExportPriceEvent } from '@/lib/excel/workbook';

// Prisma and ExcelJS are Node-only; without this the route is attempted on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exports exactly what the Listings page is currently showing, by parsing the same query
 * string through the same parseFilters(). If those two ever diverge, "export what I see"
 * quietly becomes a lie.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sp: SearchParams = Object.fromEntries(url.searchParams.entries());
  const filters = parseFilters(sp);

  const listings = await findListings(filters, 5000);
  const listingIds = listings.map((l) => l.id);

  const [priceEvents, openHouses] = await Promise.all([
    prisma.listingEvent.findMany({
      where: { type: 'PRICE_CHANGE', listingId: { in: listingIds } },
      orderBy: { occurredAt: 'desc' },
      include: { listing: true },
    }),
    prisma.openHouse.findMany({
      where: { listingId: { in: listingIds }, cancelledAt: null, startsAt: { gte: new Date() } },
      orderBy: { startsAt: 'asc' },
      include: { listing: { include: { saved: true } } },
    }),
  ]);

  const exportListings: ExportListing[] = listings.map((l) => {
    const latestPriceEvent = l.events[0];
    return {
      addressLine1: l.addressLine1,
      city: l.city,
      state: l.state,
      postalCode: l.postalCode,
      status: l.status,
      propertyType: l.propertyType,
      listPrice: l.listPrice,
      beds: l.beds,
      bathsTotal: l.bathsTotal,
      livingAreaSqft: l.livingAreaSqft,
      lotSizeSqft: l.lotSizeSqft,
      yearBuilt: l.yearBuilt,
      hoaFeeMonthly: l.hoaFeeMonthly,
      listingUrl: l.listingUrl,
      firstSeenAt: l.firstSeenAt,
      lastSeenAt: l.lastSeenAt,
      daysTracked: Math.max(1, Math.round((Date.now() - l.firstSeenAt.getTime()) / 864e5)),
      priceChangePct: latestPriceEvent?.deltaPct ?? null,
      isFavorite: l.saved?.favorite ?? false,
      userStatus: l.saved?.userStatus ?? null,
      rating: l.saved?.rating ?? null,
      notes: l.saved?.notes ?? null,
      tags: l.saved ? safeTags(l.saved.tags) : [],
      nextOpenHouse: l.openHouses[0]?.startsAt ?? null,
    };
  });

  const exportPriceEvents: ExportPriceEvent[] = priceEvents.map((e) => ({
    addressLine1: e.listing.addressLine1,
    city: e.listing.city,
    occurredAt: e.occurredAt,
    oldValue: e.oldValue ? Number(e.oldValue) : null,
    newValue: e.newValue ? Number(e.newValue) : null,
    deltaAbs: e.deltaAbs,
    deltaPct: e.deltaPct,
  }));

  const exportOpenHouses: ExportOpenHouse[] = openHouses.map((o) => ({
    addressLine1: o.listing.addressLine1,
    city: o.listing.city,
    listPrice: o.listing.listPrice,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
    appointmentOnly: o.appointmentOnly,
    virtual: o.virtual,
    isFavorite: o.listing.saved?.favorite ?? false,
  }));

  const providerIds = [...new Set(listings.map((l) => l.providerId))];
  // There is no per-area filter on this page any more — a listing's provenance is which
  // saved search(es) found it (see the "Tracked by" fact on the listing detail page),
  // not a single area it belongs to, so there is nothing scalar to summarize here.
  const areaNames: string[] = [];

  const buffer = await buildWorkbook({
    listings: exportListings,
    priceEvents: exportPriceEvents,
    openHouses: exportOpenHouses,
    meta: {
      exportedAt: new Date(),
      providerIds: providerIds.length ? providerIds : ['(none)'],
      areaNames,
      filterSummary: describeFilters(filters),
      listingCount: exportListings.length,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `zillow-tracker-${stamp}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}

function safeTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
