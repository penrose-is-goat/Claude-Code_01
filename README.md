# Portfolio Analyzer Side Tools

Release: **side-tools.v1.3.0**

Three local, dependency-free tools:

- **Macro Data Lab** resolves plain-English chart and layout requests to explicit series, then provides a FRED-style editor for lines, transformations, frequencies, axes, colors, date ranges, and graph formatting while preserving a raw-source audit.
- **Fed Tracker** reconstructs FOMC target-range probabilities from 30-Day Fed Funds futures settlements and exposes Current, Compare, Probabilities, and Historical workflows organized by meeting.
- **Treasury Auction Tracker** maintains a normalized SQLite history of official auctions, live announcements, source documents, bidder metrics, deterministic keyword queries, and auditable custom charts.

## Recommended Launch: VS Code

1. Open `C:\Users\thleg\OneDrive\Documents\New project\side-tools` as the VS Code folder.
2. Open **Run and Debug**.
3. Choose **Run Portfolio Analyzer Side Tools** and press **F5**.

The launch configuration first runs a network preflight. If Windows or the parent application blocks Python sockets with `WinError 10013`, it stops before opening a nonfunctional app and reports `NETWORK_POLICY_DENIED`.

The optional direct launcher is `start-side-tools.bat`. It runs the same preflight and does not bypass VS Code security or Windows network policy.

## URLs

- Home: `http://127.0.0.1:8017/`
- Macro Data Lab: `http://127.0.0.1:8017/fred-tool.html`
- Fed Tracker: `http://127.0.0.1:8017/fed-tracker.html`
- Treasury Auction Tracker: `http://127.0.0.1:8017/treasury-auctions.html`

If port 8017 is occupied, the terminal prints the replacement port.

## Data Resolution

The resolver never asks a language model to invent a provider ID. It uses:

- A curated catalog for common U.S. macro, rates, housing, energy, and market-index requests.
- Direct U.S. Treasury XML data for Treasury yields from 1990 onward.
- Direct Federal Reserve Financial Accounts (Z.1) archives for broad U.S. public-equity market capitalization and total debt securities outstanding, with exact FRED mirrors as fallbacks.
- Treasury Fiscal Data's Debt to the Penny API for federal public debt, kept distinct from debt securities and credit-market debt definitions.
- Direct BLS API data for CPI, core CPI, unemployment, payrolls, job openings, and producer prices.
- Yahoo Finance for current market-index and commodity-proxy history, with overlapping source comparisons where available.
- The official World Bank Commodity Markets Pink Sheet for long monthly gold and silver history. When a current Yahoo continuation is needed, the app aggregates it to the same monthly cadence and combines the sources only after their overlap passes explicit correlation and level-difference checks.
- S&P Dow Jones Indices' archived official earnings workbooks for quarterly index operating EPS and validated sector earnings-contribution shares.
- SEC Company Facts for annual company revenue, income, EPS, assets, cash flow, and R&D requests that include an explicit ticker; annual-duration filters and approved taxonomy fallbacks prevent quarterly duplicates and truncated histories.
- World Bank API indicators for supported cross-country macro and development comparisons.
- An optional official FRED API search as the final metadata fallback, not the universal resolver.

To enable the final official FRED metadata search, create a free FRED API key and enter it under **Data settings** in Macro Data Lab. The key is stored outside the web-served folder under `%LOCALAPPDATA%\PortfolioAnalyzerSideTools\settings.json`; do not share that file. FRED responses are not written to the disk cache.

The archived workbook's quarterly S&P 500 operating-EPS history begins in 1988. The latest verified public snapshot's operating-earnings contribution table begins in 2019; a cached older official snapshot can extend contribution coverage to Q4 2017. Requests for longer ex-sector periods keep the requested window visible, chart only the verifiable overlap, and show the exact coverage gap. The ex-sector formula is `S&P 500 operating EPS * (1 - excluded-sector contribution shares)`. Standalone sector-index EPS values are never subtracted from S&P 500 EPS because those series use different index divisors.

### Graph Editor

Use **Edit graph** after any prompt to:

- Add, reorder, hide, or remove lines without retyping the prompt.
- Create safe formula lines such as `B - C` or `(A / B) * 100`; the UI shows which chart series each letter represents and never evaluates arbitrary code.
- Change each series between native units, index-to-100, changes, year-over-year changes, percent changes, and annualized transformations.
- Aggregate to weekly, monthly, quarterly, or annual frequency using average, sum, or end-of-period values.
- Assign each line to the left or right axis; change line, area, bar, or scatter type; and control color, line style, width, and markers.
- Set custom dates, graph and axis titles, axis bounds, log scales, reference lines, recession shading, legend placement, and chart colors.

Natural-language axis instructions are returned as an explicit chart specification. A phrase such as “Nasdaq Composite may be used as a substitute for S&P 500” is treated as a contingency, not an instruction to plot both; the substitute is used only if all configured S&P 500 sources fail.

Version 1.3.0 adds requested-window coverage planning before a chart can pass verification. A provider response that begins materially after the requested start is no longer accepted as complete; declared long-history sources are checked, compared on an overlapping cadence, and combined only after validation passes. The chart renderer now uses context-aware financial scales with zero baselines for automatically bounded linear charts, `1/2/2.5/5/10` tick steps, unit-aware labels, and decimals only when the selected step requires them. Presentation phrases such as `separate left and right scales` and request wrappers such as `build a macro chart comparing` are removed before provider resolution.

## Fed Tracker Method

The tracker uses the current EFFR and target range, then reconstructs pre- and post-meeting rates from monthly ZQ settlements. It counts the decision day at the old rate, anchors consecutive meeting months from the next non-meeting month, and convolves meeting-only moves into cumulative target-range probabilities. Meeting dates refresh from the official Federal Reserve calendar, with a bundled fallback if that page is unavailable.

Current or recent CME settlements can be reconstructed automatically when available. Deep historical FedWatch-equivalent results require imported official ZQ settlements or a licensed data feed; the app reports this limitation instead of substituting unrelated Yahoo history or scraping a webpage.

The **Compare** view independently requests the current, prior-business-day, prior-week, and prior-month dated CME strips. When older official strips are unavailable, it can use a clearly labeled indicative reconstruction from dated Yahoo ZQ closes plus official policy-rate history. The **Historical** view provides up to one year of daily indicative observations, lets users select any combination of target outcomes, and replaces same-date observations with archived official CME settlements whenever available.

## Treasury Auction Tracker Method

The tracker backfills the official Fiscal Data Treasury Securities Auctions dataset, then reconciles current announcements and results against TreasuryDirect. It stores normalized values and untouched source payloads in SQLite, using CUSIP plus auction date as the auction key because reopenings reuse CUSIPs.

Standard requests are parsed deterministically into a visible, allowlisted query specification. Macro Data Lab, Fed Tracker, and Auction Tracker share an optional Ollama integration using `qwen3.5:9b` only when unusual wording cannot be represented by the standard grammar. Model output cannot provide SQL, formulas, provider IDs, source URLs, observations, probabilities, or auction values; it must pass a tool-specific schema before the deterministic database or provider router runs.

Tenor studies use the original security term so reopened 30-year bonds are not lost when their current term is displayed as 29 years and several months. Bills, nominal coupon securities, TIPS, and FRNs retain their distinct stop-out fields. Missing pre-coverage values remain null instead of becoming zero.

Optional local model setup:

```powershell
winget install Ollama.Ollama
ollama pull qwen3.5:9b
```

Restart Side Tools after installation. The page-level model status shows whether Ollama and the configured model are ready. The entire dashboard, deterministic prompts, filters, standard charts, tables, exports, and PDFs work without Ollama.

## Sharing and Hosting

For the fastest tester link, first run `python .\serve.py --no-open`, then double-click `share-side-tools.bat` in a second window. The launcher uses the bundled, publisher-verified Cloudflare executable, verifies the public health endpoint, records the active URL, and prints it under `CURRENT SHAREABLE LINK`. It does not require a PowerShell execution-policy change or a PATH change. Run `python .\share_side_tools.py --status` to inspect the last recorded URL.

For an always-on deployment, use a small AWS Lightsail instance behind a named Cloudflare Tunnel. Exact commands, tradeoffs, and security cautions are in [HOSTING.md](HOSTING.md).

## Verification

```powershell
python serve.py --doctor
python serve.py --check
python -m unittest -v
python -m qa.runner --tool all --strict
python -m qa.v1_3_gate --strict --artifact-dir qa\artifacts\v1_3_0
```

`--doctor` distinguishes an execution-policy block from a provider outage. `--check` validates the macro providers, Fed inputs, and Treasury auction database coverage.
The semantic QA gate uses fixed Macro, Fed, and Treasury corpora with typo, metatext, and paraphrase variants; it also validates source, probability, observation, and auction invariants without calling a model.
The v1.3.0 release gate executes exactly 100,000 deterministic cases: the established 33,599 semantic/layout cases, 46,401 seeded complex prompt combinations, 10,000 provider coverage/failure cases, and 10,000 tests against the exported browser scale implementation. Network and model tripwires ensure the deterministic phases do not silently depend on a live source or local model.

## Important Limits

- Free sources cannot guarantee that every imaginable request resolves or that licensed exchange or index history is available.
- A FRED API key expands metadata search but does not make restricted third-party series freely redistributable.
- Cached non-FRED responses are labeled when stale data is used. Every chart retains provider, native series ID, date range, transformations, and validation details.
- Fed Tracker output is an independent settlement-based reconstruction, not the licensed CME FedWatch API or an intraday quote service.
- Structured auction history begins in late 1979, while individual fields have later start dates. Each auction chart reports effective metric coverage and missing values.
