/**
 * Does a real browser get real Zillow data from THIS machine?
 *
 *   npm run verify-zillow -- --place "<City, ST>"
 *   npm run verify-zillow -- --place "<City, ST>" --open-houses
 *
 * Everything else about the browser transport is covered by tests that run a real
 * Chromium against a real server. The one thing no test can decide is how Zillow itself
 * answers a browser coming from a particular connection — so this asks it, once, and
 * reports exactly what came back.
 *
 * It makes a single request and prints what it parsed, because the failure that matters
 * is "the page loaded and yielded zero listings", which is indistinguishable from a
 * quiet market unless the reason is named.
 */
import { ZillowPublicProvider, buildSearchUrl } from '../src/lib/providers/zillow';
import { browserAvailable, closeBrowser, fetchRendered } from '../src/lib/providers/zillow/browser';
import { detectBlockPage, parseSearchPage } from '../src/lib/providers/zillow/parse';
import type { AreaQuery } from '../src/lib/providers/types';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const place = at('--place');
  if (!place) {
    console.error(
      'This app has no built-in area, so this check has none either.\n\n' +
      '  npm run verify-zillow -- --place "<City, ST>"\n\n' +
      'Any city works — it is only being used to build one Zillow URL to request.',
    );
    process.exit(2);
  }
  const openHouses = argv.includes('--open-houses');

  const m = place.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (!m) {
    console.error(`Could not read a city and state from "${place}". Use the form "City, ST".`);
    process.exit(2);
  }

  const area: AreaQuery = {
    kind: 'cityRadius', city: m[1].trim(), state: m[2].toUpperCase(), radiusMiles: 10,
  };
  const url = buildSearchUrl(area, 1, openHouses);

  console.log('Step 1 — is a browser installed?');
  const avail = await browserAvailable();
  console.log(`  ${avail.ok ? 'yes' : 'NO'} — ${avail.message}`);
  if (!avail.ok) {
    console.error('\nRun: npx playwright install chromium');
    process.exit(1);
  }

  console.log(`\nStep 2 — open the page in that browser.\n  ${url}`);
  let html: string;
  let status: number;
  try {
    ({ html, status } = await fetchRendered(url, { timeoutMs: 60_000 }));
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await closeBrowser();
    process.exit(1);
  }

  console.log(`  HTTP ${status}, ${html.length.toLocaleString('en-US')} bytes of rendered HTML`);

  if (status === 403 || status === 429) {
    console.error(
      `\n  Zillow refused a real browser from this connection (HTTP ${status}).\n` +
      '  That is a real answer. The "websearch" provider is the path that still works.',
    );
    await closeBrowser();
    process.exit(1);
  }

  const blocked = detectBlockPage(html);
  if (blocked) {
    console.error(`\n  Zillow served a challenge page instead of listings: ${blocked}`);
    await closeBrowser();
    process.exit(1);
  }

  console.log('\nStep 3 — parse it.');
  try {
    const { listings, skipped } = parseSearchPage(html, {
      timezone: process.env.TZ ?? 'America/New_York',
      fetchedAt: new Date(),
    });

    console.log(`  ${listings.length} listing(s) parsed${skipped ? `, ${skipped} skipped` : ''}`);

    for (const l of listings.slice(0, 8)) {
      const price = l.listPrice ? `$${l.listPrice.toLocaleString('en-US')}` : 'no price';
      const where = l.lat != null ? `${l.lat.toFixed(4)},${l.lng?.toFixed(4)}` : 'no coords';
      console.log(`    ${price.padStart(12)}  ${l.addressLine1}, ${l.city} ${l.postalCode}  [${where}]`);
      for (const oh of l.openHouses) {
        console.log(`                  open house: ${oh.startsAt.toISOString()} - ${oh.endsAt.toISOString()} (${oh.timezone})`);
      }
    }

    const withCoords = listings.filter((l) => l.lat != null).length;
    const withOpenHouses = listings.filter((l) => l.openHouses.length > 0).length;

    console.log(`\n  ${withCoords}/${listings.length} have coordinates, ${withOpenHouses} have open-house times.`);

    if (listings.length === 0) {
      console.error('  Page loaded and parsed, but yielded no listings — the schema may have moved.');
      process.exitCode = 1;
    } else {
      console.log('\nZillow works from this machine, through a real browser, with no API key.');
      // Prove the provider itself works, not just the pieces.
      const provider = new ZillowPublicProvider({ transport: 'browser' });
      const health = await provider.healthCheck(area);
      console.log(`Provider health: ${health.ok ? 'ok' : 'not ok'} — ${health.message}`);
    }
  } catch (err) {
    console.error(`  Parse failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }

  await closeBrowser();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await closeBrowser();
  process.exit(1);
});
