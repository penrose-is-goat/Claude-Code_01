# Zillow Tracker

Watches for-sale listings and open houses in neighborhoods you define, remembers what
changed, lets you save the ones you care about with notes, and exports to a real Excel
workbook.

Runs locally with Docker Compose. Single user, SQLite, no accounts.

```bash
npm install
npm run db:push          # create the database
npm run seed             # add three demo areas
npm run poll             # pull data (mock provider — no credentials needed)
npm run dev              # http://localhost:3000
```

That gets you a fully working app in about a minute, with realistic demo data.

---

## Read this before pointing it at Zillow

**The honest position on data sources**, because it determines whether this thing keeps
working:

Zillow retired its public API in 2021. There is no supported replacement for an
individual — official access runs through Bridge Interactive, which requires MLS or
brokerage approval. Zillow's Terms of Use prohibit automated access, and the site runs
behavioral bot detection that challenges automated requests.

So this app is built to not care which source it uses. Everything normalizes to one
RESO-shaped listing type behind a provider interface. Three providers ship:

| Provider | Open houses | Credentials | Durability |
|---|---|---|---|
| **`mock`** (default) | Yes | None | Permanent — it's fixtures |
| **`zillow`** | Yes | None (logged out) | Best-effort; may be challenged |
| **`csv`** | No | None | Permanent — it's your own file |

**`mock` is the default on purpose.** Every feature here works fully against it, so you
can evaluate the app before deciding what to feed it.

**The `zillow` provider is off by default.** It reads public, logged-out pages — no
account, no cookies, ever. It makes one request per area per run, paces them at least
1.5 seconds apart, and stops at the first refusal rather than retrying. It contains no
evasion of any kind, by design. Whether to enable it is your call; enable it by adding
`"zillow"` to an area's `providerIds`.

**Never point this at a logged-in Zillow account.** That is the one configuration that
combines a clear terms breach with a real risk of losing the account you use for saved
searches. The provider has no login support and won't be given any.

**`csv` is the fallback that cannot be blocked.** Export a search yourself — Redfin's
"Download All" works, so does an agent-emailed MLS export — and drop the file in. It
carries no open-house times, which is a limitation of the export format, not a bug.

If you want open-house data that is both reliable and fully above board, the best option
is a licensed RESO feed (SimplyRETS has a `/openhouses` endpoint and a free sandbox), or
simply asking an agent to put you on their MLS client portal. Both give you MLS-sourced
open houses ahead of portal syndication. The provider interface is designed so either
drops in as one new file.

### Does the live fetch actually work?

This project was built inside a sandbox whose egress proxy blocks `zillow.com`, so the
live path is the one thing that could not be verified during development. Find out for
yourself, from your own connection:

```bash
npm run verify-live                      # Boulder, CO open houses
node scripts/verify-live.mjs --zip 80302
node scripts/verify-live.mjs --city "Denver, CO" --for-sale
```

It makes exactly one request and tells you plainly what happened: parsed listings with
open-house times, a block, a challenge page, or a schema change. Exit code 0 means the
live provider is usable from where you are. Anything else means use `csv`, and the app
works exactly the same.

---

## What it does

- **Change detection.** New listings, price drops and rises, status changes,
  back-on-market, open houses added and cancelled, new photos.
- **Open houses.** Grouped by day, so you can plan a Saturday.
- **Saved listings.** Favorites, notes, tags, 1–5 rating, and your own status
  (watching / toured / contacted / rejected / offer).
- **Excel export.** Four sheets — Listings, Price History, Open Houses, Meta — reflecting
  whatever filters you currently have applied.
- **Areas.** ZIP list, city + radius, or a drawn polygon.
- **Poll log.** Every run recorded, with a canary verdict.

### Two design decisions worth knowing

**Absence is not proof.** A listing missing from one poll usually means the fetch
truncated, not that the house sold. Delisting requires two consecutive misses from runs
that returned at least 80% of the previous count. Without that rule you get a wave of
false "sold" events the first time a request comes back short.

**Silence is reported.** A source that starts returning structurally valid but empty data
looks exactly like a quiet market. Every run asserts a plausible result count and flags
the difference, because a tracker that has quietly stopped working is worse than one
that visibly breaks.

---

## Architecture

```
src/lib/providers/     # types.ts, normalized.ts, registry.ts + mock/ zillow/ csv/
src/lib/ingest/        # hash, diff (pure), absence, pipeline, runner
src/lib/geo/           # turf point-in-polygon and radius
src/lib/excel/         # workbook builder
src/lib/db/            # prisma client + query repositories
src/app/               # Next App Router pages and API routes
src/worker/            # croner scheduler (separate process)
```

Next.js 15 + TypeScript + Prisma + SQLite. The worker is a **separate process** on
purpose: registering cron inside Next re-registers it on every dev hot reload.

`diff.ts` is a pure `(previous, next) => events[]` function with no database, network, or
clock, which is why it can be tested exhaustively.

Photo **URLs** are stored, never image bytes. Listing photographs carry copyright
independent of the listing facts.

---

## Docker

```bash
docker compose up --build     # web on :3000, worker polling every 15 min
```

Both services share `./data/app.db` via a bind mount. Backup is `cp data/app.db somewhere`.

---

## Tests

```bash
npm test          # 148 tests
npm run typecheck
```

Covers the diff engine, content hashing and address normalization, absence and canary
rules, geo filtering, CSV parsing, the Zillow parser against committed HTML fixtures
(including a challenge page), Excel output structure and cell types, and a full pipeline
integration test against a real SQLite database running all three mock scenarios.

No test touches the network.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./data/app.db` | SQLite location |
| `POLL_TOKEN` | `dev-local-token` | Bearer token for `POST /api/jobs/poll` |
| `POLL_CRON` | `*/15 * * * *` | Worker schedule |
| `TZ` | `America/Denver` | Timezone for open-house display |

---

## Splitting this into its own repository

This lives in a subdirectory of a larger repo. To give it a standalone repository with
its full history intact (three commits, not a squash):

```bash
# from a clone of the parent repo
git subtree split --prefix=zillow-tracker -b zillow-tracker-standalone

gh repo create zillow-tracker --private          # or create it in the GitHub UI
git push git@github.com:<you>/zillow-tracker.git zillow-tracker-standalone:main
```

The split branch has `zillow-tracker/` contents at the repo root, so `npm install` works
immediately after cloning. The one thing to adjust afterwards is the CI workflow, which
lives at `.github/workflows/zillow-tracker.yml` in the parent and assumes a
`working-directory: zillow-tracker` — in a standalone repo, drop that `defaults` block
and the `paths:` filters.
