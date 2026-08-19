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

## Current state

Works, on real data: 28 real Boulder listings, 12 real open houses with correct local
times, change detection, saved listings/notes/tags, filters, Excel export (4 sheets),
the whole UI, rebuild-on-refresh.

Does not work here: the direct `zillow` provider records a real 403 and **has never
parsed a live Zillow page**. Its parser was cross-validated against `johnbalvin/pyzill`
and `@use_homi/real-estate-portal-schemas` — which found two live-breaking bugs
(HTML-entity-escaped blob; reading `listResults` instead of `mapResults`) — but no real
page has passed through it. `npm run verify-live` on a networked machine closes this and
saves the page as a fixture.

Not done: areas are Boulder ZIPs, not the user's own — **ask for their ZIP codes.** The
standalone `zillow-tracker` repo could not be created (403 from the GitHub App); the
subtree-split commands are in the README.

## Next step

Wire the WebSearch-based harvest into a repeatable command so a refresh pulls current
Zillow data rather than replaying a fixed capture.
