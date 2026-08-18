import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsvRows, parseCsvListings, CsvImportProvider } from '@/lib/providers/csv';

const sample = readFileSync(
  fileURLToPath(new URL('../../fixtures/csv/redfin-sample.csv', import.meta.url)), 'utf8',
);
const NOW = new Date('2026-08-15T12:00:00Z');

describe('parseCsvRows', () => {
  it('handles quoted fields containing commas', () => {
    const rows = parseCsvRows('a,b\n"one, two",three');
    expect(rows[1]).toEqual(['one, two', 'three']);
  });

  it('handles escaped double quotes', () => {
    const rows = parseCsvRows('a\n"He said ""hi"""');
    expect(rows[1][0]).toBe('He said "hi"');
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvRows('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('drops fully blank lines', () => {
    expect(parseCsvRows('a,b\n\n1,2')).toHaveLength(2);
  });
});

describe('parseCsvListings', () => {
  const listings = parseCsvListings(sample, NOW);

  it('parses every data row', () => {
    expect(listings).toHaveLength(3);
  });

  it('maps Redfin column names', () => {
    const l = listings[0];
    expect(l.addressLine1).toBe('1420 Pine St');
    expect(l.city).toBe('Boulder');
    expect(l.state).toBe('CO');
    expect(l.postalCode).toBe('80302');
    expect(l.listPrice).toBe(875000);
    expect(l.beds).toBe(3);
    expect(l.livingAreaSqft).toBe(1840);
    expect(l.yearBuilt).toBe(1972);
  });

  it('maps property type and status', () => {
    expect(listings[1].propertyType).toBe('CONDO');
    expect(listings[0].status).toBe('ACTIVE');
  });

  it('handles a quoted address containing escaped quotes', () => {
    expect(listings[2].addressLine1).toBe('890 Alpine Ave, Unit "A"');
  });

  it('derives a deterministic id so re-import updates rather than duplicates', () => {
    const again = parseCsvListings(sample, new Date('2027-01-01T00:00:00Z'));
    expect(again.map((l) => l.sourceListingId)).toEqual(listings.map((l) => l.sourceListingId));
  });

  it('reports honestly that it carries no open houses', () => {
    expect(listings.every((l) => l.openHouses.length === 0)).toBe(true);
  });

  it('throws a helpful error when there is no address column', () => {
    expect(() => parseCsvListings('foo,bar\n1,2', NOW)).toThrow(/no recognizable address column/);
  });

  it('returns empty for a header-only file', () => {
    expect(parseCsvListings('ADDRESS,CITY\n', NOW)).toEqual([]);
  });
});

describe('CsvImportProvider', () => {
  it('reports unhealthy when nothing is configured', async () => {
    const r = await new CsvImportProvider().healthCheck();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No CSV configured/);
  });

  it('reports healthy with inline text', async () => {
    const r = await new CsvImportProvider({ csvText: sample }).healthCheck();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/3 rows/);
  });

  it('declares that it cannot supply open houses', () => {
    expect(new CsvImportProvider().capabilities.supportsOpenHouses).toBe(false);
  });
});
