# Claude-Code_01 — working notes

Claude Code loads this file automatically at the start of every session. It exists so a
fresh session resumes without re-litigating decisions already made.

## The project

`zillow-tracker/` — a personal web app that watches for-sale listings and open houses in
defined neighborhoods, detects changes, saves listings with notes, and exports to Excel.

- Branch: `claude/zillow-tracker-strategy-xkva7i`
- PR: penrose-is-goat/Claude-Code_01#1 (open, draft, CI green)
- Stack: Next.js 15 + TypeScript + Prisma + SQLite, worker as a separate process
- 284 tests + 13 browser checks (`npm test`, `npm run verify-ui`)

## Standing instructions from the user — do not violate these

1. **NO MOCK DATA. NO FABRICATED TESTS.** There is no mock provider and there must not be
   one. Every listing in `data/snapshots/` is real, captured from Zillow's public pages,
   with provenance recorded. Fields the source did not publish (coordinates, year built)
   are left null rather than filled in with plausible-looking values. If you cannot
   obtain something, say so — do not invent it.
2. **Track Zillow, do not copy it.** Every refresh rebuilds the listing store from what
   the source reports now; it does not accumulate a local replica. Every listing
   deep-links to its Zillow page. Descriptions and photos are not stored. Saved listings
   and the change history survive a rebuild — those are the user's data and the product,
   respectively.
3. **Test things; do not hand the user work you could do yourself.** Several times an
   apparent blocker turned out to be a failure of imagination. See below.

## The network constraint, precisely

This container's egress proxy denies nearly all outbound HTTPS. Verified across 12 hosts,
both Node proxy modes, curl, and real Chromium: `zillow.com`, `google.com`,
`api.census.gov` and `nominatim.openstreetmap.org` all return 403 at the CONNECT stage,
so no packet reaches the destination. Reachable: npm, PyPI, GitHub,
`raw.githubusercontent.com`.

**What works anyway, and matters most:** the `WebSearch` tool reaches Zillow's public
pages. `WebSearch` with `allowed_domains: ["zillow.com"]` returns open houses with the
time window paired to the address — the capability previously (wrongly) declared
impossible. That is how `data/snapshots/boulder-open-houses-2026-08-19.json` was built.
`WebFetch` is blocked; `WebSearch` is not. Do not confuse them.

## The `websearch` provider — how live data actually arrives

Zillow refuses direct fetches but publishes every listing to search engines. A
`/homedetails/` page carries address+zpid in its URL, address and (while the MLS record
is live) the MLS number in its `<title>`, and price/beds/baths/sqft/type/year in its
`<meta name="description">`. `src/lib/providers/websearch/` reads exactly that, through
an ordinary search API. It never contacts zillow.com.

Three things worth not rediscovering:

1. **The MLS tell.** `| MLS #123456` in the page title means a live MLS record; it
   disappears when the record closes. Checked against 27 results across four Boulder ZIPs
   on 2026-08-21 it agreed with for-sale status every time — including a slice where the
   search reported exactly one of ten homes as listed, and that one was the only title
   with an MLS number. It is the signal that keeps a genuinely listed home from being
   dropped when the snippet omits the price. Sale-history and rental language override it.
2. **Index titles publish the market size.** `Boulder CO Open Houses - 61 Upcoming`,
   `Boulder CO Single Family Homes For Sale - 406 Homes`. That is the coverage
   denominator, and the same pages expose Zillow's neighborhood slugs
   (`central-boulder-boulder-co`) for partitioning a sweep. Parse the count only at the
   END of the title — matching anywhere read the ZIP out of `80305 Real Estate - 80305
   Homes For Sale` and reported a market of eighty thousand homes.
3. **Enumeration is area × facet × street.** Streets are the strongest axis and are
   self-discovering: every harvested address yields one to sweep next.

`npm run harvest -- --place "City, ST" [--budget N] [--open-houses]` is the repeatable
refresh. `--from <capture.json>` replays search results collected elsewhere through the
identical parser — that is how a harvest gets done from this container, where search APIs
are blocked but the `WebSearch` tool is not. A capture holds real url+title only;
prose-relayed facts go in `observations[]` with a per-entry note and are merged only into
fields the parser left empty. Never synthesize a `description` — that would launder a
paraphrase into something indistinguishable from a capture.

## Current state

Works, on real data: 49 real Boulder listings (28 earlier capture + 21 harvested
2026-08-21 via websearch), 12 real open houses with correct local times, change
detection, saved listings/notes/tags, filters, Excel export, the whole UI. 372 unit tests
and 13/13 browser checks pass; production build clean.

Verified this session: `npx prisma generate && npx tsc --noEmit && npx vitest run &&
npm run build`, then app up on :3000, a drawn search created via `/api/searches`
(drawn needs no geocoder — the only offline-workable path), `npx tsx scripts/poll.ts`,
then `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node
scripts/verify-ui.mjs` → 13/13. Note the pinned Chromium is build **1194**; Playwright
wants 1234 and errors without that env var.

Does not work here: the direct `zillow` provider records a real 403 and has never parsed
a live page. Its 403 message now points at `websearch`, not CSV.

Not done: **the user's own location is still unknown — ask what area they want.** All
current data is Boulder, CO, which was only ever a test market. The standalone
`zillow-tracker` repo could not be created (403 from the GitHub App); subtree-split
commands are in the README.

## Next step

Coverage is 21 of the 406 Boulder homes Zillow publishes — the mechanism is proven, the
budget is not spent. Either run a bigger WebSearch capture here, or have the user set
`BRAVE_SEARCH_API_KEY` and run `npm run harvest -- --place "<their city>" --budget 80`
on their machine, which is the real answer.
