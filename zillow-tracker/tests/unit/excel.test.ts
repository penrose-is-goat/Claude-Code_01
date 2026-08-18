import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbook, type ExportListing, type ExportOpenHouse, type ExportPriceEvent } from '@/lib/excel/workbook';
import { computeWidth } from '@/lib/excel/autoWidth';

function listing(over: Partial<ExportListing> = {}): ExportListing {
  return {
    addressLine1: '4072 Crystal Ct', city: 'Boulder', state: 'CO', postalCode: '80302',
    status: 'ACTIVE', propertyType: 'SINGLE_FAMILY', listPrice: 875000, beds: 3,
    bathsTotal: 2, livingAreaSqft: 1840, lotSizeSqft: 7360, yearBuilt: 1972,
    hoaFeeMonthly: null, listingUrl: 'https://www.zillow.com/homedetails/1_zpid/',
    firstSeenAt: new Date('2026-08-01T00:00:00Z'), lastSeenAt: new Date('2026-08-15T00:00:00Z'),
    daysTracked: 14, priceChangePct: -5.7, isFavorite: false, userStatus: null,
    rating: null, notes: null, tags: [], nextOpenHouse: null, ...over,
  };
}

const priceEvent: ExportPriceEvent = {
  addressLine1: '4072 Crystal Ct', city: 'Boulder', occurredAt: new Date('2026-08-10T00:00:00Z'),
  oldValue: 925000, newValue: 875000, deltaAbs: -50000, deltaPct: -5.4,
};

const openHouse: ExportOpenHouse = {
  addressLine1: '4072 Crystal Ct', city: 'Boulder', listPrice: 875000,
  startsAt: new Date('2026-08-16T19:00:00Z'), endsAt: new Date('2026-08-16T22:00:00Z'),
  appointmentOnly: false, virtual: false, isFavorite: true,
};

const meta = {
  exportedAt: new Date('2026-08-15T12:00:00Z'), providerIds: ['snapshot'],
  areaNames: ['Central Boulder'], filterSummary: 'price <= 1000000', listingCount: 1,
};

async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}

describe('buildWorkbook', () => {
  it('produces a real, loadable xlsx', async () => {
    const buf = await buildWorkbook({
      listings: [listing()], priceEvents: [priceEvent], openHouses: [openHouse], meta,
    });
    // ZIP magic bytes — proves it is a genuine xlsx container, not HTML or CSV.
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const wb = await load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Listings', 'Price History', 'Open Houses', 'Meta']);
  });

  it('writes price as a NUMBER so sorting and SUM work', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing()], priceEvents: [], openHouses: [], meta }));
    const ws = wb.getWorksheet('Listings')!;
    const priceCell = ws.getRow(2).getCell(5);
    expect(typeof priceCell.value).toBe('number');
    expect(priceCell.value).toBe(875000);
    expect(priceCell.numFmt).toBe('$#,##0');
  });

  it('writes dates as real Date objects, not ISO strings', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing()], priceEvents: [], openHouses: [], meta }));
    const ws = wb.getWorksheet('Listings')!;
    const firstSeen = ws.getRow(2).getCell(22);
    expect(firstSeen.value).toBeInstanceOf(Date);
  });

  it('stores percentages as fractions so Excel percent format is correct', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing({ priceChangePct: -5.7 })], priceEvents: [], openHouses: [], meta }));
    const cell = wb.getWorksheet('Listings')!.getRow(2).getCell(6);
    expect(cell.value).toBeCloseTo(-0.057, 4);
  });

  it('makes the address a working hyperlink', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing()], priceEvents: [], openHouses: [], meta }));
    const cell = wb.getWorksheet('Listings')!.getRow(2).getCell(1);
    expect((cell.value as { hyperlink?: string }).hyperlink).toBe('https://www.zillow.com/homedetails/1_zpid/');
    expect((cell.value as { text?: string }).text).toBe('4072 Crystal Ct');
  });

  it('falls back to plain text when a listing has no URL', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing({ listingUrl: null })], priceEvents: [], openHouses: [], meta }));
    expect(wb.getWorksheet('Listings')!.getRow(2).getCell(1).value).toBe('4072 Crystal Ct');
  });

  it('freezes the header row and the address column', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing()], priceEvents: [], openHouses: [], meta }));
    const view = wb.getWorksheet('Listings')!.views[0] as { state: string; xSplit: number; ySplit: number };
    expect(view.state).toBe('frozen');
    expect(view.xSplit).toBe(1);
    expect(view.ySplit).toBe(1);
  });

  it('computes a derived $/sqft column', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing()], priceEvents: [], openHouses: [], meta }));
    expect(wb.getWorksheet('Listings')!.getRow(2).getCell(11).value).toBe(Math.round(875000 / 1840));
  });

  it('bolds favorites', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing({ isFavorite: true })], priceEvents: [], openHouses: [], meta }));
    expect(wb.getWorksheet('Listings')!.getRow(2).font?.bold).toBe(true);
  });

  it('sorts open houses chronologically', async () => {
    const later: ExportOpenHouse = { ...openHouse, startsAt: new Date('2026-08-20T19:00:00Z'), endsAt: new Date('2026-08-20T21:00:00Z') };
    const wb = await load(await buildWorkbook({
      listings: [], priceEvents: [], openHouses: [later, openHouse], meta,
    }));
    const ws = wb.getWorksheet('Open Houses')!;
    const first = ws.getRow(2).getCell(2).value as Date;
    const second = ws.getRow(3).getCell(2).value as Date;
    expect(first.getTime()).toBeLessThan(second.getTime());
  });

  it('records provenance in the Meta sheet', async () => {
    const wb = await load(await buildWorkbook({ listings: [listing()], priceEvents: [], openHouses: [], meta }));
    const ws = wb.getWorksheet('Meta')!;
    const values = ws.getSheetValues().flat().map(String);
    expect(values.some((v) => v.includes('Central Boulder'))).toBe(true);
    expect(values.some((v) => v.includes('price <= 1000000'))).toBe(true);
  });

  it('handles a completely empty export without throwing', async () => {
    const buf = await buildWorkbook({
      listings: [], priceEvents: [], openHouses: [],
      meta: { ...meta, listingCount: 0 },
    });
    const wb = await load(buf);
    expect(wb.getWorksheet('Listings')!.rowCount).toBe(1); // header only
  });

  it('does not crash on listings with null everything', async () => {
    const sparse = listing({
      listPrice: null, beds: null, bathsTotal: null, livingAreaSqft: null,
      lotSizeSqft: null, yearBuilt: null, priceChangePct: null, listingUrl: null,
    });
    await expect(buildWorkbook({ listings: [sparse], priceEvents: [], openHouses: [], meta })).resolves.toBeDefined();
  });
});

describe('computeWidth', () => {
  it('respects the floor and ceiling', () => {
    expect(computeWidth('ID', [])).toBe(8);
    expect(computeWidth('x', ['y'.repeat(500)])).toBe(60);
  });

  it('grows with content', () => {
    expect(computeWidth('Address', ['4072 Crystal Ctreet, Boulder'])).toBeGreaterThan(computeWidth('Address', ['1 A St']));
  });

  it('ignores nulls', () => {
    expect(computeWidth('Header', [null, undefined])).toBe(computeWidth('Header', []));
  });
});
