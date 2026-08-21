/**
 * One real search, to prove the keyless backend works from this machine.
 *
 *   npm run verify-search
 *   npm run verify-search -- --place "Silver Spring, MD"
 *
 * The HTML parsers were written against the structure a maintained scraper uses, but
 * this project's own environment cannot reach either search engine, so nothing here was
 * confirmed against a live page. This is that confirmation, and it spends one request.
 *
 * It prints what came back rather than a pass/fail, because the interesting failure is
 * "the page loaded and parsed to zero results", which needs the raw shape to diagnose.
 */
import { DuckDuckGoBackend, MojeekBackend, type SearchBackend } from '../src/lib/providers/websearch/backends';
import { toListing } from '../src/lib/providers/websearch/parse';

async function main(): Promise<void> {
  const i = process.argv.indexOf('--place');
  const place = i >= 0 ? process.argv[i + 1] : 'Silver Spring, MD';
  const query = `site:zillow.com/homedetails "${place}"`;

  console.log(`Query: ${query}\n`);

  let anyWorked = false;

  for (const backend of [new DuckDuckGoBackend(), new MojeekBackend()] as SearchBackend[]) {
    process.stdout.write(`${backend.displayName.padEnd(28)} `);
    try {
      const results = await backend.search(query);
      console.log(`${results.length} result(s)`);

      if (results.length === 0) {
        console.log('  Reached the engine but parsed nothing. Either the query is too narrow,');
        console.log('  or the page markup changed and the parser needs updating.\n');
        continue;
      }

      anyWorked = true;
      let listings = 0;
      for (const r of results.slice(0, 5)) {
        const { listing, dropped } = toListing(r, { fetchedAt: new Date() });
        if (listing) {
          listings++;
          const price = listing.listPrice ? `$${listing.listPrice.toLocaleString('en-US')}` : 'no price';
          console.log(`  ${price.padStart(12)}  ${listing.addressLine1}, ${listing.city} ${listing.postalCode}`);
        } else {
          console.log(`  ${'skipped'.padStart(12)}  ${dropped?.reason}`);
        }
      }
      console.log(`  -> ${listings} of the first ${Math.min(5, results.length)} are live for-sale listings\n`);
    } catch (err) {
      console.log('FAILED');
      console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (!anyWorked) {
    console.error('No backend returned usable results. Paste this output back.');
    process.exit(1);
  }
  console.log('Search works from this machine with no API key.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
