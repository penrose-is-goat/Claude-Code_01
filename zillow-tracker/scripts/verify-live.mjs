#!/usr/bin/env node
/**
 * The go/no-go check that CANNOT be run from a sandboxed CI container.
 *
 * This project was built in an environment whose egress proxy blocks zillow.com, so the
 * live fetch path is the one thing that could not be verified during development. Run
 * this on your own machine, on your own connection, to find out whether it actually
 * works from where you are.
 *
 * Usage:
 *   node scripts/verify-live.mjs                       # defaults to Boulder, CO
 *   node scripts/verify-live.mjs --city "Denver, CO"
 *   node scripts/verify-live.mjs --zip 80302
 *   node scripts/verify-live.mjs --for-sale            # for-sale instead of open houses
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const zip = flag('zip', null);
const cityArg = flag('city', 'Boulder, CO');
const openHouseOnly = !has('for-sale');

function buildUrl() {
  const suffix = openHouseOnly ? 'open-house/' : '';
  if (zip) return `https://www.zillow.com/${zip}/${suffix}`;
  const [city, state] = cityArg.split(',').map((s) => s.trim());
  const slug = `${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(state || '').toLowerCase()}`;
  return `https://www.zillow.com/${slug}/${suffix}`;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const url = buildUrl();
console.log(`\n  Fetching  ${url}`);
console.log('  (one request, logged out, no cookies)\n');

let html;
const started = Date.now();
try {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  console.log(`  HTTP ${res.status} in ${Date.now() - started}ms`);

  if (res.status === 403 || res.status === 429) {
    console.log(`\n  BLOCKED — Zillow declined the request (HTTP ${res.status}).`);
    console.log('  This is the expected outcome from datacenter IPs and sometimes from');
    console.log('  residential ones too. The app still works: use the CSV import path.');
    console.log('  Settings -> CSV import, with a Redfin "Download All" export.\n');
    process.exit(2);
  }
  if (!res.ok) {
    console.log(`\n  Unexpected status ${res.status}. Not a block, but not usable either.\n`);
    process.exit(3);
  }
  html = await res.text();
} catch (err) {
  console.log(`\n  NETWORK ERROR: ${err.message}`);
  console.log('  If you are inside a container or VPN, its egress policy may be blocking');
  console.log('  zillow.com. Try from your normal machine.\n');
  process.exit(4);
}

console.log(`  Received ${(html.length / 1024).toFixed(0)} KB`);

// Capture the real page so the parser test stops relying on a hand-written sample.
// This environment cannot reach zillow.com, so the committed fixture was constructed
// from the documented schema rather than captured. Running this on a machine that CAN
// reach it replaces that with the real thing.
try {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('fixtures/zillow', { recursive: true });
  writeFileSync('fixtures/zillow/live-capture.html', html);
  console.log('  Saved fixtures/zillow/live-capture.html — run `npm test` to exercise');
  console.log('  the parser against this real page instead of the constructed sample.');
} catch (err) {
  console.log(`  (could not save capture: ${err.message})`);
}

// Reuse the real parser rather than a copy, so this verifies the shipping code path.
register('tsx/esm', pathToFileURL('./'));
const { parseSearchPage, detectBlockPage } = await import('../src/lib/providers/zillow/parse.ts');

const challenge = detectBlockPage(html);
if (challenge) {
  console.log(`\n  CHALLENGED — page contains a ${challenge}.`);
  console.log('  Status was 200 but the body is an interstitial, not results.\n');
  process.exit(2);
}

let result;
try {
  result = parseSearchPage(html, { timezone: process.env.TZ || 'America/Denver', fetchedAt: new Date() });
} catch (err) {
  console.log(`\n  PARSE FAILED — ${err.message}`);
  console.log('  The page loaded but its data blob did not match any known shape.');
  console.log('  Zillow may have changed its schema; src/lib/providers/zillow/parse.ts');
  console.log('  is where that mapping lives.\n');
  process.exit(5);
}

const { listings, skipped } = result;
console.log(`  Parsed ${listings.length} listings (${skipped} skipped)\n`);

if (listings.length === 0) {
  console.log('  Zero listings parsed. Either the area genuinely has none, or the');
  console.log('  schema moved. Try a denser area before concluding it is broken.\n');
  process.exit(6);
}

const withOpenHouses = listings.filter((l) => l.openHouses.length > 0);

for (const l of listings.slice(0, 8)) {
  const price = l.listPrice ? `$${l.listPrice.toLocaleString()}` : '(no price)';
  console.log(`  ${price.padStart(12)}  ${l.addressLine1}, ${l.city} ${l.postalCode}`);
  console.log(
    `                ${l.beds ?? '?'}bd ${l.bathsTotal ?? '?'}ba ` +
    `${l.livingAreaSqft?.toLocaleString() ?? '?'}sqft · ${l.status}`,
  );
  for (const oh of l.openHouses) {
    console.log(`                OPEN: ${oh.startsAt.toLocaleString()} – ${oh.endsAt.toLocaleTimeString()}`);
  }
}
if (listings.length > 8) console.log(`  … and ${listings.length - 8} more`);

console.log(`\n  RESULT: live fetch works from this machine.`);
console.log(`  ${listings.length} listings, ${withOpenHouses.length} with open-house times.`);
if (withOpenHouses.length === 0 && openHouseOnly) {
  console.log('  Note: no open-house times came through. Zillow does not always embed');
  console.log('  them in the search blob; the detail page carries them more reliably.');
}
console.log('\n  You can enable the zillow provider on an area in the Areas table.\n');
