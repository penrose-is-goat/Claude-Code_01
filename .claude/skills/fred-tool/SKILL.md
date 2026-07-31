---
name: fred-tool
description: Build or update a natural-language FRED chart tool - user types "show me the 10yr treasury, S&P 500 and fed funds rate for the last 10 years" and gets an interactive Chart.js graph of FRED economic data with playable controls (time range, dual axes, log scale, normalize, recession shading). Use when asked to add/modify FRED charts, economic data graphs, or macro dashboards.
---

# FRED Tool Skill

How to build a natural-language graphing tool over FRED (Federal Reserve
Economic Data) that runs entirely in the browser.

## Data access (the hard part)

FRED's official API (api.stlouisfed.org) does NOT allow CORS and requires an
API key, so it cannot be called from browser JavaScript. Use this fetch
chain, in order:

1. **fred.libhack.so** - free open proxy purpose-built for frontends.
   `GET https://fred.libhack.so/v0/observations?series_id=DGS10&observation_start=YYYY-MM-DD&observation_end=YYYY-MM-DD`
   Returns `[{"date":"2023-09-14","value":"4.29"}, ...]`. No key. CORS enabled.
2. **fredgraph.csv via generic CORS proxy** - FRED's public graph CSV export
   (`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=...&coed=...`)
   wrapped in `https://api.allorigins.win/raw?url=` or `https://corsproxy.io/?`.
   CSV format: header row `observation_date,SERIES_ID`, missing values are `.`.
   Fetch ONE series per request to keep parsing simple.
3. **Built-in demo data** - deterministic generated series, clearly labeled
   "DEMO DATA (offline)". Never show generated data without a label.

Cache every successful fetch in a Map keyed `seriesId:start:end`.

## Natural-language query parsing

Do NOT call an LLM. A keyword dictionary + regex time parser handles queries
like "show me the 10yr treasury yield, the s&p 500 and the federal funds rate
for the last 10 years".

### Series dictionary
Map each FRED series to: id, display name, aliases (lowercase substrings to
match), units group, and optional transform. Core set (~40 series):

| Aliases (any substring match) | FRED ID | Units |
|---|---|---|
| 10 year treasury, 10yr, 10-year yield | DGS10 | pct |
| 2 year treasury, 2yr | DGS2 | pct |
| 30 year treasury, 30yr treasury | DGS30 | pct |
| 3 month treasury, t-bill | DGS3MO | pct |
| fed funds, federal funds | DFF | pct |
| yield curve, 10-2, 2s10s | T10Y2Y | pct |
| mortgage rate, 30 year mortgage | MORTGAGE30US | pct |
| unemployment | UNRATE | pct |
| cpi, consumer price | CPIAUCSL | index |
| inflation rate, inflation | CPIAUCSL + transform:yoy | pct |
| core pce | PCEPILFE + transform:yoy | pct |
| high yield spread, credit spread | BAMLH0A0HYM2 | pct |
| prime rate | DPRIME | pct |
| s&p 500, sp500, s and p | SP500 | level |
| nasdaq | NASDAQCOM | level |
| dow, djia | DJIA | level |
| vix, volatility index | VIXCLS | level |
| gdp | GDP | usd_b |
| real gdp | GDPC1 | usd_b |
| m2, money supply | M2SL | usd_b |
| fed balance sheet, walcl | WALCL | usd_m |
| nonfarm payrolls, payrolls | PAYEMS | level |
| housing starts | HOUST | level |
| retail sales | RSAFS | usd_m |
| industrial production | INDPRO | index |
| consumer sentiment, michigan | UMCSENT | index |
| case-shiller, home price index | CSUSHPINSA | index |
| median home price | MSPUS | usd |
| oil, wti, crude | DCOILWTICO | usd |
| dollar index | DTWEXBGS | index |
| euro, eur/usd | DEXUSEU | level |
| bitcoin, btc | CBBTCUSD | usd |
| recession | USREC | flag |

Notes: SP500/DJIA/NASDAQCOM only have ~10 years of history on FRED
(licensing). USREC is a 0/1 monthly flag used for recession shading, not as
a plotted line. Transform `yoy` = percent change vs value 12 months earlier
(compute client-side after fetch; match by date offset, monthly series).

### Matching rule (fuzzy - NOT plain substrings)
Plain substring matching fails on real queries ("10 year US treasury
yields" breaks the substring "10 year treasury"). Use token-based fuzzy
matching; there is no LLM involved - it is all local:

1. **Normalize**: lowercase; "&" -> " and "; "10-year"/"10yr"/"10 yr" ->
   "10 year"; number words (ten->10); singularize (yields->yield,
   treasuries->treasury); "s and p 500" -> "sp500".
2. **Content tokens**: run BOTH the query and every alias through the same
   tokenizer, dropping stopwords (show/me/the/us/for...) but KEEPING soft
   domain words (index/rate/yield/price) and all numbers. Never put
   "year"/"month" in the stopword list - they carry maturity meaning.
3. **Fuzzy token equality**: exact match; else Damerau-Levenshtein <=1 for
   len>=5 tokens, <=2 for len>=8 (tresury->treasury, willshire->wilshire);
   prefix match for len>=4. NUMBERS MUST MATCH EXACTLY ("2" never fuzzes
   to "20").
4. **Alias matching**: alias tokens must appear in order in the query with
   at most 2 gap tokens between them ("10 year US treasury" matches alias
   [10, year, treasury] with 1 gap). Fallback: unordered matching for
   digit-free aliases only, max 1 gap ("spread high yield").
5. **Scoring & consumption**: score = avg similarity + 0.15*aliasLength -
   0.05*gaps; accept >= 0.9. Process matches best-first, consuming query
   token positions - a match whose tokens are ALL consumed is dropped
   (stops "cpi" double-charting inside "core cpi").
6. **No match**: run a per-token fuzzy scan to build "Did you mean ..."
   suggestions instead of a generic error.

Headless-test this parser with 50+ cases (misspellings, word gaps,
reversed order, maturity-vs-duration number collisions) before shipping.

### Time parsing (regex, first match wins)
- `last|past N years|yrs|y` and bare `N years` -> start = today - N years
- `last|past N months` -> today - N months
- `since YYYY` -> start = YYYY-01-01
- `from YYYY to YYYY` / `YYYY-YYYY` / `between YYYY and YYYY` -> both ends
- `ytd` -> Jan 1 current year
- `max|all time|entire history` -> start = 1900-01-01
- default -> 10 years

### Time parsing gotcha
normalizeQuery collapses plurals and hyphens BEFORE time parsing, so "last
10 years" arrives as "last 10 year" - identical to a maturity phrase. Parse
duration ONLY with a last/past/for prefix, or with a negative lookahead
excluding maturity words (treasury/yield/note/bond/mortgage/rate/...).
Also support "since YYYY", "from YYYY to YYYY", bare "YYYY YYYY" (hyphens
became spaces), "ytd", "max/all time/going back". Wilshire 5000 and other
long-history series pair naturally with "max".

## Chart rendering (self-contained canvas - no Chart.js)

The tool ships its own ~150-line canvas renderer instead of Chart.js so the
single file works offline and inside CSP-restricted hosted previews:
multi-series lines with null-skip, dual y-axes with per-axis linear/log,
grid + compact tick formatting (K/M/B), rotated axis titles, recession
bands, hover crosshair with per-series dots and an HTML tooltip,
devicePixelRatio-aware sizing, resize redraw.

- Multi-series line chart, `pointRadius:0`, distinct palette colors.
- **Dual y-axes**: group series by units. First unit group -> left axis 'yL',
  every other group -> right axis 'yR'. If >2 groups, suggest Normalize mode.
  Each series chip gets an L/R toggle to override.
- **Normalize mode**: rebase every series to 100 at its first visible point
  (single axis). Essential when mixing e.g. SP500 (thousands) with rates (%).
- **Log scale** checkbox per axis (`type:'logarithmic'`).
- **Recession shading**: fetch USREC, convert consecutive 1-months to
  [start,end] bands, draw grey translucent rects with a Chart.js plugin
  (`beforeDraw` using `chart.chartArea` + x-scale `getPixelForValue`).
- **Date alignment**: series have different frequencies (daily/monthly/
  quarterly). Build the union of all dates sorted; use `spanGaps:true` and
  connect nulls; or forward-fill lower-frequency series. Forward-fill gives
  cleaner tooltips - preferred.
- Range buttons (1Y/5Y/10Y/25Y/MAX) + two date inputs for custom ranges;
  refetch (or slice cache) on change.

## UI checklist ("playable")

- One big text input + Go button + example query chips.
- Active-series chips: color dot, name, axis L/R toggle, x remove.
- Controls row: range buttons, custom dates, Normalize / Log L / Log R /
  Recessions checkboxes.
- Footnote: data source citation "Source: FRED, Federal Reserve Bank of
  St. Louis" + live/demo mode label + last-refresh time.
- Everything recomputes without page reload.

## Testing

Headless-test the pure functions with node + a DOM stub before shipping:
query parser (series + time), CSV parser (`.` -> null), yoy transform,
forward-fill alignment, normalize math, recession band extraction.
Live fetches can't be tested in sandboxes without network - state that
clearly rather than faking success.

## Integration notes for Portfolio Analyzer Pro

- Standalone file lives in `side-tools/fred-tool.html` (dark theme matches
  the main app).
- To embed as a tab: port the JS into a `PA.Fred` module, add a "FRED
  Charts" tab in build.sh, reuse PA.Charts palette; persist last query in
  the settings table. Rebuild with `bash build.sh`.
