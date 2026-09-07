/**
 * Adversarial fuzzing of src/lib/providers/csv/index.ts.
 *
 * Tests named "DEFECT n" assert the behaviour the importer SHOULD have and currently
 * fail. Everything else passes; rejecting an unparseable value (European decimals,
 * accounting negatives, "1.2M") is correct behaviour, not a bug.
 */
import { describe, it, expect } from 'vitest';
import { parseCsvRows, parseCsvListings, CsvImportProvider } from '@/lib/providers/csv';

const NOW = new Date('2026-08-15T12:00:00Z');
const L = (text: string) => parseCsvListings(text, NOW);

// ---------------------------------------------------------------------------
// Behaviour that holds up
// ---------------------------------------------------------------------------

describe('csv import — cases that hold up', () => {
  it('a UTF-8 BOM on the header does not break column mapping', () => {
    const rows = L('﻿Address,City,State,Zip,Price\n1420 Pine St,Boulder,CO,80302,875000\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].addressLine1).toBe('1420 Pine St');
    expect(rows[0].listPrice).toBe(875000);
  });

  it('an empty file and a header-only file both yield zero rows without throwing', () => {
    expect(L('')).toEqual([]);
    expect(L('   \n  \n')).toEqual([]);
    expect(L('Address,City,Price\n')).toEqual([]);
  });

  it('a file with no recognizable address column fails loudly and names the headers', () => {
    expect(() => L('Foo,Bar\n1,2\n')).toThrow(/no recognizable address column.*Foo, Bar/);
  });

  it('embedded newlines inside quoted fields are preserved', () => {
    const rows = L('Address,City\n"1420 Pine St\nUnit 3",Boulder\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].addressLine1).toBe('1420 Pine St\nUnit 3');
  });

  it('escaped double quotes inside a quoted field survive', () => {
    expect(parseCsvRows('a,"say ""hi""",b\n')[0]).toEqual(['a', 'say "hi"', 'b']);
  });

  it('ragged rows are padded, not fatal', () => {
    const rows = L('Address,City,Price\n1420 Pine St\n3300 Folsom St,Boulder,875000,extra,cells\n');
    expect(rows).toHaveLength(2);
    expect(rows[0].city).toBe('');
    expect(rows[1].listPrice).toBe(875000);
  });

  it('duplicate headers resolve to the first occurrence', () => {
    const rows = L('Address,Address,Price\nreal,decoy,1\n');
    expect(rows[0].addressLine1).toBe('real');
  });

  it('CRLF line endings parse identically to LF', () => {
    const lf = L('Address,City\n1420 Pine St,Boulder\n');
    const crlf = L('Address,City\r\n1420 Pine St,Boulder\r\n');
    expect(crlf.map((r) => r.addressLine1)).toEqual(lf.map((r) => r.addressLine1));
  });

  it('a blank trailing line does not produce a phantom listing', () => {
    expect(L('Address,City\n1420 Pine St,Boulder\n\n\n,\n')).toHaveLength(1);
  });

  it('currency-formatted prices are parsed into whole dollars', () => {
    expect(L('Address,Price\nA,"$1,234,567.89"\n')[0].listPrice).toBe(1234568);
    expect(L('Address,Price\nA,$875000\n')[0].listPrice).toBe(875000);
  });

  it('prices it cannot defensibly read are rejected rather than guessed', () => {
    // Each of these is genuinely ambiguous, so dropping the value is correct.
    expect(L('Address,Price\nA,1.2M\n')[0].listPrice).toBeUndefined();       // shorthand
    expect(L('Address,Price\nA,(500)\n')[0].listPrice).toBeUndefined();      // accounting negative
    expect(L('Address,Price\nA,"1.234.567,89"\n')[0].listPrice).toBeUndefined(); // European
    expect(L('Address,Price\nA,   \n')[0].listPrice).toBeUndefined();
    expect(L('Address,Price\nA,n/a\n')[0].listPrice).toBeUndefined();
  });

  it('rows with an empty address are dropped instead of creating identity-less listings', () => {
    const rows = L('Address,City\n,Boulder\n1420 Pine St,Boulder\n');
    expect(rows).toHaveLength(1);
  });

  it('identical addresses derive identical deterministic ids (re-import updates, not duplicates)', () => {
    const rows = L('Address,City,State,Zip\n1420 Pine St,Boulder,CO,80302\n1420 Pine St,Boulder,CO,80302\n');
    expect(rows[0].sourceListingId).toBe(rows[1].sourceListingId);
  });

  it('a ~10MB file parses in reasonable time', () => {
    const lines = ['Address,City,State,Zip,Price,Beds,Baths,SqFt,Status,Type,URL'];
    let bytes = 0;
    for (let i = 0; bytes < 10 * 1024 * 1024; i++) {
      const line = `"${i} Main St, Unit ${i}",Boulder,CO,80302,"$${500000 + i}",3,2,1840,Active,Single Family Residential,https://x.example.com/${i}`;
      lines.push(line);
      bytes += line.length + 1;
    }
    const text = lines.join('\n');
    const t0 = Date.now();
    const rows = L(text);
    expect(rows.length).toBeGreaterThan(50_000);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 120000);

  it('the provider reports a useful health check instead of throwing', async () => {
    await expect(new CsvImportProvider().healthCheck())
      .resolves.toMatchObject({ ok: false });
    await expect(new CsvImportProvider({ csvText: 'Foo,Bar\n1,2\n' }).healthCheck())
      .resolves.toMatchObject({ ok: false });
    await expect(new CsvImportProvider({ csvText: 'Address\n1420 Pine St\n' }).healthCheck())
      .resolves.toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// DEFECTS
// ---------------------------------------------------------------------------

describe('csv import — DEFECTS', () => {
  it('DEFECT 1: CR-only line endings silently import zero rows', () => {
    // parseCsvRows drops '\r' unconditionally and only breaks a row on '\n', so a
    // classic-Mac / legacy Excel-for-Mac export collapses into ONE row. That trips the
    // `rows.length < 2` guard and returns [] with no error at all: the import reports
    // success and imports nothing.
    const cr = 'Address,City,Price\r1420 Pine St,Boulder,875000\r3300 Folsom St,Boulder,465000\r';
    expect(parseCsvRows(cr)).toHaveLength(3);
    expect(L(cr)).toHaveLength(2);
  });

  it('DEFECT 2: an unbalanced quote silently swallows every remaining row', () => {
    // One stray quote in row 1 puts the scanner in quoted mode for the rest of the file.
    // Two of the three listings disappear and nothing is reported — for a file the user
    // hand-edited, silent partial import is worse than a hard failure.
    const text = 'Address,City\n"1420 Pine St,Boulder\n3300 Folsom St,Boulder\n55 Baseline Rd,Boulder\n';
    expect(L(text)).toHaveLength(3);
  });

  it('DEFECT 3: JS numeric literal syntax is accepted for prices', () => {
    // Number() understands hex, binary, octal and exponent forms, so a mangled cell
    // becomes a confidently wrong price instead of being rejected like "1.2M" is.
    expect(L('Address,Price\nA,0x1F\n')[0].listPrice).toBeUndefined();
    expect(L('Address,Price\nA,0b101\n')[0].listPrice).toBeUndefined();
    expect(L('Address,Price\nA,1e21\n')[0].listPrice).toBeUndefined();
  });

  it('DEFECT 4: a quote appearing mid-field silently rewrites the value', () => {
    // Unquoted fields legitimately contain quote characters (`1420 Pine St "The Manor"`).
    // The scanner treats the first one as the start of a quoted section and deletes both
    // quotes from the stored address.
    expect(parseCsvRows('1420 Pine St "The Manor",Boulder\n')[0])
      .toEqual(['1420 Pine St "The Manor"', 'Boulder']);
  });
});
