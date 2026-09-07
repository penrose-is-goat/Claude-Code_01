import ExcelJS from 'exceljs';
import { applyAutoWidth } from './autoWidth';

/**
 * Three sheets plus a Meta block.
 *
 * Two rules drive every choice here, because they're what separates a spreadsheet you
 * can work in from one you have to clean up first:
 *   1. Prices are NUMBERS with a currency format, never "$450,000" strings — otherwise
 *      sorting and SUM() are broken from the moment the file opens.
 *   2. Dates are real Date objects with a numFmt, never ISO strings.
 */

export interface ExportListing {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  status: string;
  propertyType: string;
  listPrice: number | null;
  beds: number | null;
  bathsTotal: number | null;
  livingAreaSqft: number | null;
  lotSizeSqft: number | null;
  yearBuilt: number | null;
  hoaFeeMonthly: number | null;
  listingUrl: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  daysTracked: number;
  priceChangePct: number | null;
  isFavorite: boolean;
  userStatus: string | null;
  rating: number | null;
  notes: string | null;
  tags: string[];
  nextOpenHouse: Date | null;
}

export interface ExportPriceEvent {
  addressLine1: string;
  city: string;
  occurredAt: Date;
  oldValue: number | null;
  newValue: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
}

export interface ExportOpenHouse {
  addressLine1: string;
  city: string;
  listPrice: number | null;
  startsAt: Date;
  endsAt: Date;
  appointmentOnly: boolean;
  virtual: boolean;
  isFavorite: boolean;
}

export interface ExportMeta {
  exportedAt: Date;
  providerIds: string[];
  areaNames: string[];
  filterSummary: string;
  listingCount: number;
}


/**
 * Excel refuses to open a workbook containing a cell over 32,767 characters — it offers
 * to "repair" it, which silently drops content. Addresses and descriptions come from a
 * remote source and are unbounded all the way through the pipeline, so the clamp has to
 * happen here, at the last point before the file is written.
 */
const EXCEL_MAX_CELL_CHARS = 32_767;
const TRUNCATION_SUFFIX = '…[truncated]';

export function clampCell(v: string | null | undefined): string {
  if (!v) return '';
  if (v.length <= EXCEL_MAX_CELL_CHARS) return v;
  return v.slice(0, EXCEL_MAX_CELL_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * NaN and ±Infinity are legal `number` values but serialize into the sheet XML as
 * literal `NaN` / `Infinity`, which produces a file that passes every structural check
 * and still fails to open. Neither is reachable from the shipped providers today; this
 * is the guard that keeps that true when a new provider is added.
 */
export function safeNumber(n: number | null | undefined): number | null {
  if (n == null) return null;
  return Number.isFinite(n) ? n : null;
}

/** Excel's date system has no representation before 1900; negative serials render as ####. */
export function safeDate(d: Date | null | undefined): Date | null {
  if (!d) return null;
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  return d.getUTCFullYear() < 1900 ? null : d;
}

/** Only http(s) may become a clickable link; anything else is rendered as plain text. */
export function safeHyperlink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const CURRENCY = '$#,##0';
const DATE_FMT = 'yyyy-mm-dd';
const DATETIME_FMT = 'yyyy-mm-dd hh:mm AM/PM';
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' },
};

export async function buildWorkbook(data: {
  listings: ExportListing[];
  priceEvents: ExportPriceEvent[];
  openHouses: ExportOpenHouse[];
  meta: ExportMeta;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zillow Tracker';
  wb.created = data.meta.exportedAt;

  addListingsSheet(wb, data.listings);
  addPriceHistorySheet(wb, data.priceEvents);
  addOpenHousesSheet(wb, data.openHouses);
  addMetaSheet(wb, data.meta);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

function styleHeader(ws: ExcelJS.Worksheet): void {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 20;
}

function addListingsSheet(wb: ExcelJS.Workbook, listings: ExportListing[]): void {
  const ws = wb.addWorksheet('Listings', {
    // Freeze the header AND the address column, so you keep your bearings when scrolling
    // right through 20 columns.
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
  });

  ws.columns = [
    { header: 'Address', key: 'addressLine1' },
    { header: 'City', key: 'city' },
    { header: 'State', key: 'state' },
    { header: 'ZIP', key: 'postalCode' },
    { header: 'Price', key: 'listPrice', style: { numFmt: CURRENCY } },
    { header: 'Price Chg %', key: 'priceChangePct', style: { numFmt: '0.0%' } },
    { header: 'Beds', key: 'beds' },
    { header: 'Baths', key: 'bathsTotal' },
    { header: 'SqFt', key: 'livingAreaSqft', style: { numFmt: '#,##0' } },
    { header: 'Lot SqFt', key: 'lotSizeSqft', style: { numFmt: '#,##0' } },
    { header: '$/SqFt', key: 'pricePerSqft', style: { numFmt: CURRENCY } },
    { header: 'Year', key: 'yearBuilt' },
    { header: 'HOA/mo', key: 'hoaFeeMonthly', style: { numFmt: CURRENCY } },
    { header: 'Status', key: 'status' },
    { header: 'Type', key: 'propertyType' },
    { header: 'Next Open House', key: 'nextOpenHouse', style: { numFmt: DATETIME_FMT } },
    { header: 'Fav', key: 'favorite' },
    { header: 'My Status', key: 'userStatus' },
    { header: 'Rating', key: 'rating' },
    { header: 'Tags', key: 'tags' },
    { header: 'Notes', key: 'notes' },
    { header: 'First Seen', key: 'firstSeenAt', style: { numFmt: DATE_FMT } },
    { header: 'Days Tracked', key: 'daysTracked' },
  ];

  const rows = listings.map((l) => {
    const link = safeHyperlink(l.listingUrl);
    const address = clampCell(l.addressLine1);
    const price = safeNumber(l.listPrice);
    const sqft = safeNumber(l.livingAreaSqft);
    return {
      addressLine1: link ? { text: address, hyperlink: link } : address,
      city: clampCell(l.city),
      state: clampCell(l.state),
      postalCode: clampCell(l.postalCode),
      listPrice: price,
      // Excel's percent format multiplies by 100, so store the fraction.
      priceChangePct: safeNumber(l.priceChangePct) == null ? null : l.priceChangePct! / 100,
      beds: safeNumber(l.beds),
      bathsTotal: safeNumber(l.bathsTotal),
      livingAreaSqft: sqft,
      lotSizeSqft: safeNumber(l.lotSizeSqft),
      pricePerSqft: price != null && sqft ? Math.round(price / sqft) : null,
      yearBuilt: safeNumber(l.yearBuilt),
      hoaFeeMonthly: safeNumber(l.hoaFeeMonthly),
      status: humanize(l.status),
      propertyType: humanize(l.propertyType),
      nextOpenHouse: safeDate(l.nextOpenHouse),
      favorite: l.isFavorite ? 'Yes' : '',
      userStatus: typeof l.userStatus === 'string' && l.userStatus ? humanize(l.userStatus) : '',
      rating: safeNumber(l.rating),
      tags: clampCell(Array.isArray(l.tags) ? l.tags.join(', ') : ''),
      notes: clampCell(l.notes),
      firstSeenAt: safeDate(l.firstSeenAt),
      daysTracked: safeNumber(l.daysTracked),
    };
  });

  rows.forEach((r) => ws.addRow(r));
  styleHeader(ws);

  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  }

  // Bold favourites FIRST. Setting a row font after styling a cell overwrites that
  // cell's font wholesale, which previously wiped hyperlink styling on exactly the rows
  // the user cares most about.
  listings.forEach((l, i) => {
    if (l.isFavorite) ws.getRow(i + 2).font = { bold: true };
  });

  // ExcelJS does not style hyperlinks for you — and only style cells that really are
  // links, otherwise a URL-less address is painted blue and underlined but does nothing.
  ws.getColumn('addressLine1').eachCell({ includeEmpty: false }, (cell, rowNumber) => {
    if (rowNumber === 1) return;
    const isLink = typeof cell.value === 'object' && cell.value !== null && 'hyperlink' in cell.value;
    if (!isLink) return;
    cell.font = {
      color: { argb: 'FF0563C1' },
      underline: true,
      bold: listings[rowNumber - 2]?.isFavorite ?? false,
    };
  });

  if (rows.length > 0) {
    const lastRow = rows.length + 1;
    // Price drops green, rises red. Conditional formatting needs a dxf-shaped style.
    ws.addConditionalFormatting({
      ref: `F2:F${lastRow}`,
      rules: [
        {
          type: 'cellIs', operator: 'lessThan', formulae: ['0'], priority: 1,
          style: {
            font: { color: { argb: 'FF006100' }, bold: true },
            fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC6EFCE' } },
          },
        },
        {
          type: 'cellIs', operator: 'greaterThan', formulae: ['0'], priority: 2,
          style: {
            font: { color: { argb: 'FF9C0006' } },
            fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } },
          },
        },
      ],
    });
  }

  // Hyperlink cells are objects; measuring them directly pins the Address column at the
  // width of the string "[object Object]".
  applyAutoWidth(ws as never, rows.map((r) => ({
    ...r,
    addressLine1:
      r.addressLine1 && typeof r.addressLine1 === 'object' ? r.addressLine1.text : r.addressLine1 ?? '',
  })) as never);
  ws.getColumn('notes').width = 40;
}

function addPriceHistorySheet(wb: ExcelJS.Workbook, events: ExportPriceEvent[]): void {
  const ws = wb.addWorksheet('Price History', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'Address', key: 'addressLine1' },
    { header: 'City', key: 'city' },
    { header: 'Date', key: 'occurredAt', style: { numFmt: DATE_FMT } },
    { header: 'From', key: 'oldValue', style: { numFmt: CURRENCY } },
    { header: 'To', key: 'newValue', style: { numFmt: CURRENCY } },
    { header: 'Change', key: 'deltaAbs', style: { numFmt: CURRENCY } },
    { header: 'Change %', key: 'deltaPct', style: { numFmt: '0.0%' } },
  ];

  const rows = events.map((e) => ({
    addressLine1: clampCell(e.addressLine1),
    city: clampCell(e.city),
    occurredAt: safeDate(e.occurredAt),
    oldValue: safeNumber(e.oldValue),
    newValue: safeNumber(e.newValue),
    deltaAbs: safeNumber(e.deltaAbs),
    deltaPct: safeNumber(e.deltaPct) == null ? null : e.deltaPct! / 100,
  }));

  rows.forEach((r) => ws.addRow(r));
  styleHeader(ws);
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    ws.addConditionalFormatting({
      ref: `F2:G${rows.length + 1}`,
      rules: [
        {
          type: 'cellIs', operator: 'lessThan', formulae: ['0'], priority: 1,
          style: { font: { color: { argb: 'FF006100' }, bold: true } },
        },
      ],
    });
  }
  applyAutoWidth(ws as never, rows as never);
}

function addOpenHousesSheet(wb: ExcelJS.Workbook, ohs: ExportOpenHouse[]): void {
  const ws = wb.addWorksheet('Open Houses', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'Date', key: 'day', style: { numFmt: 'ddd yyyy-mm-dd' } },
    { header: 'Starts', key: 'startsAt', style: { numFmt: 'hh:mm AM/PM' } },
    { header: 'Ends', key: 'endsAt', style: { numFmt: 'hh:mm AM/PM' } },
    { header: 'Address', key: 'addressLine1' },
    { header: 'City', key: 'city' },
    { header: 'Price', key: 'listPrice', style: { numFmt: CURRENCY } },
    { header: 'Fav', key: 'favorite' },
    { header: 'Notes', key: 'kind' },
  ];

  const sorted = [...ohs].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const rows = sorted.map((o) => ({
    day: safeDate(o.startsAt),
    startsAt: safeDate(o.startsAt),
    endsAt: safeDate(o.endsAt),
    addressLine1: clampCell(o.addressLine1),
    city: clampCell(o.city),
    listPrice: safeNumber(o.listPrice),
    favorite: o.isFavorite ? 'Yes' : '',
    kind: [o.appointmentOnly ? 'By appointment' : null, o.virtual ? 'Virtual' : null]
      .filter(Boolean).join(', '),
  }));

  rows.forEach((r) => ws.addRow(r));
  styleHeader(ws);
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  }
  applyAutoWidth(ws as never, rows as never);
}

/**
 * Without this you cannot tell, six months later, what a saved file actually represents.
 */
function addMetaSheet(wb: ExcelJS.Workbook, meta: ExportMeta): void {
  const ws = wb.addWorksheet('Meta');
  ws.columns = [{ header: 'Field', key: 'k', width: 22 }, { header: 'Value', key: 'v', width: 60 }];

  const rows = [
    { k: 'Exported at', v: meta.exportedAt.toISOString() },
    { k: 'Listings in export', v: String(meta.listingCount) },
    { k: 'Areas', v: meta.areaNames.join(', ') || '(all)' },
    { k: 'Providers', v: meta.providerIds.join(', ') },
    { k: 'Filters', v: meta.filterSummary || '(none)' },
  ];
  rows.forEach((r) => ws.addRow(r));
  styleHeader(ws);
}

/**
 * Null-tolerant on purpose. These values come from the database and from providers, and
 * one unexpected null used to reject the whole download rather than blanking one cell.
 */
function humanize(s: string | null | undefined): string {
  if (typeof s !== 'string' || !s) return '';
  return s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
