# Portfolio Analyzer Pro

Portfolio-style analysis site inspired by Portfolio Visualizer, packaged as a browser app with a local in-browser SQLite cache and a single-file `index.html` deliverable.

This workspace is now organized by batches. The current stable target is:

- `Batch 1 v1.1.30.9`
- Provider: local Python market-data backend (`yfinance` + Yahoo chart + FRED fallback chain for supported macro/index series)
- Goal: live-first provider-exact ticker data from a backend instead of browser-side API stitching or cache-first behavior

## Project Links

- GitHub Repo: [penrose-is-goat/Claude-Code_01](https://github.com/penrose-is-goat/Claude-Code_01)
- Latest published Codex branch: check the GitHub repo branches or PRs, because local batch work can move ahead of the last pushed sync branch

## APIs and Data Sources

- Primary live provider: `yfinance` through the local Python backend
- Browser app dependencies: `sql.js`, `Chart.js`, and `Plotly`
- Local cache/persistence: in-browser SQLite via `sql.js`

## Roadmap

- `Batch 1.1.x`
  Stabilize live ticker lookup, provider-exact field mapping, backend behavior, ETF field handling, and diagnostics.
- `Batch 1.2.1`
  Build the portfolio analysis foundation: portfolio holdings engine, benchmark-aware analysis, saved portfolio workflows, and cleaner portfolio summary tables.
- `Batch 1.2.2`
  Tighten backtesting and comparison behavior: rebalancing controls, contribution assumptions, benchmark comparisons, drawdown tables, and exportable reports.
- `Batch 1.3.1`
  Add methodology-driven analytics: rolling returns, rolling volatility, risk metrics, correlation views, and closer Portfolio Visualizer-style statistics.
- `Batch 1.4.1`
  Expand persistence and customization: portfolio database workflows, saved screens, watchlists, presets, and import/export flows.
- `Batch 1.5.1`
  Final validation and polish: methodology cross-checks against the PDF, UI cleanup, performance tuning, and packaging/handoff improvements.

## Current Status

What Batch 1 v1.1.30.9 is meant to handle well:

- Live ticker lookup
- Price charts across multiple ranges
- Live ticker fundamentals sourced from `yfinance`
- ETF profile data sourced from `yfinance`
- Provider percent-field unit metadata so ETF yield / expense ratio / turnover render correctly
- ETF `NAV` sourced from `yfinance` when Yahoo exposes `navPrice`
- Provider beta shown separately from computed analytics
- Displayed `YTD` and `1Y` returns computed from adjusted-close total return
- Displayed `3Y` and `5Y` ETF/fund returns shown on the Yahoo-style annualized basis instead of cumulative return
- Live-first fetches that do not rely on cached DB values when the user requests current data
- Portfolio builder and saved allocations
- Built-in default model portfolios for quick testing and methodology scaffolding
- Backtesting against benchmark tickers with explicit portfolio selection and an explicit actual test window
- Multi-ticker comparison
- Bulk ticker entry and saved-portfolio loading in the comparison tab
- Correlation, drawdown, and risk/return views for both asset compare and portfolio compare
- Strategy Lab tab that turns a plain-English market hypothesis into a structured event study and runs it against live backend history
- Advanced ticker chart controls for interval, compare-to-index, moving averages, line/candlestick, volume, RSI, and MACD
- Cached fallback via the in-browser SQLite/localStorage database
- Diagnostics that show the last provider request/error instead of a blank `undefined` message
- Safe local DB writes when provider fields are missing

What is still deferred beyond Batch 1.1.x:

- Full fundamentals coverage for all tickers
- Methodology alignment against the attached Portfolio Visualizer PDF
- More precise portfolio analytics and advanced modules

## Quick Start

### Recommended: VS Code + Live Server + Python Backend

1. Open this folder in VS Code:
   `C:\Users\thleg\OneDrive\Documents\New project\portfolio-analyzer-fixed`
2. Install Python 3.11+
3. In PowerShell, run:

```powershell
cd "C:\Users\thleg\OneDrive\Documents\New project\portfolio-analyzer-fixed\backend"
python -m pip install -r .\requirements.txt
python .\server.py
```

4. Install the `Live Server` extension if needed
5. Right-click `index.html`
6. Click `Open with Live Server`
7. Open the `Settings` tab
8. Confirm the backend URL is `http://127.0.0.1:8765/api`
9. Click `Test Backend`
10. Search `NVDA`, `AAPL`, or `SPY`

### Faster start

From the project root, you can also run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-v1.1.30.9.ps1
```

Or just double-click:

```text
start-v1.1.30.9.bat
```

That opens a backend PowerShell window for you. Keep that window running while you use the site.

You only need to start the backend again if:

- the backend PowerShell window was closed
- `backend/server.py` changed
- Python packages were updated

If only the frontend changed, keep the backend running and just hard-refresh the browser.

### Rebuild the single-file deliverable

From PowerShell in this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

## Files

- `index.html`
  The rebuilt single-file app for easy testing in Live Server
- `app-core.js`
  Config, database, API provider integration, financial math
- `app-features.js`
  Ticker lookup, metrics rendering, cached fallback, portfolio UI logic
- `app-backtest.js`
  Backtesting, comparison, dashboard
- `app-strategy-lab.js`
  Natural-language strategy parsing, event-study workflow, and quant research UI
- `app-main.js`
  App bootstrapping, search, settings UI, API test button
- `build.ps1`
  Windows build script that assembles the deliverable
- `build.sh`
  Bash build script for non-Windows environments
- `portfolio_db.sql`
  Schema reference
- `backend/server.py`
  Local HTTP backend powered by `yfinance` plus fallback-capable canonical history support for selected macro/index series
- `backend/requirements.txt`
  Python dependencies for the backend

## Provider Notes

Batch 1 v1.1.30.9 uses a local market-data backend for:

- Quotes
- Historical price series
- Search
- Stock fundamentals
- ETF profile data
- ETF NAV
- Provider field source metadata
- Provider field unit metadata for percent-style ETF fields
- Fund holdings and sector-weighting normalization
- Backend health/version metadata so the frontend can detect stale backend sessions
- Trailing `YTD` and `1Y` total returns computed from adjusted-close history
- `3Y` and `5Y` annualized return handling for ETF/fund performance windows
- Intraday and multi-frequency ticker chart history (`15m`, `1h`, `1d`, `1wk`, `1mo`)
- Canonical macro/index history for supported Strategy Lab series such as `DGS10` and `SP500`, with fallback attempts across FRED, Yahoo, and direct Yahoo chart retrieval where applicable

The frontend still computes portfolio analytics in other parts of the app, but the ticker page is now biased toward provider-owned fields first. One important nuance: Yahoo/yfinance ETF/fund `3Y` and `5Y` performance is presented on an annualized basis, so Batch `1.1.16` aligns those windows to that methodology instead of showing cumulative return.

## Testing Checklist

Use this list before moving to Batch 2:

1. Ticker lookup works for `NVDA`, `AAPL`, `MSFT`, `SPY`
2. Price chart updates when changing ranges
3. Portfolio Builder can add holdings and save allocations
4. Backtest runs on at least `1Y` and `3Y`
5. Compare works for 2-4 symbols
6. Settings `Test Backend` button passes
7. Footer shows `Batch 1 v1.1.30.9`
8. Settings diagnostics show the same backend version as the frontend batch
9. ETF top sectors / top holdings do not show `N/A` when Yahoo/yfinance returns them
10. ETF `NAV` is populated when Yahoo/yfinance exposes `navPrice`
11. Backtest panel clearly shows which portfolio is being tested
12. Ticker chart supports frequency, compare, line/candlestick, moving averages, and RSI/MACD controls

## v1.1.27 Fixes

- Strategy Lab now separates signal-definition series from tradable target proxies, which fixes the deeper logic bug where proxy behavior could distort signal timing
- Prompts like `10-Yr treasury yield hits a new year to date high` now keep the trigger on the canonical `DGS10` series instead of letting inverse bond ETFs redefine the event count
- Added a new `Series Resolution` section so each run explains which series were requested, which proxy candidates were audited, and why a proxy was accepted or rejected
- Added target proxy audits based on daily return correlation and signal proxy audits based on trigger overlap, so proxy substitution is now validated instead of assumed
- Strategy Lab still supports tradable ETF proxies where they are genuinely close enough, but it now falls back to the canonical series when the proxy fails the consistency check
- Added multi-provider history ladders so Strategy Lab no longer hard-fails when one source such as FRED comes back empty for a canonical series
- Generic history requests now fall through `yfinance` to the direct Yahoo chart endpoint, and canonical series such as `SP500` / `DGS10` now try multiple source candidates automatically
- Frontend history parsing now preserves provider/fallback metadata, and Strategy Lab surfaces the actual source used plus the fallback path for both the target and signal series
- Settings `Test Backend` now reports the actual canonical/fallback history source instead of pretending the backend is FRED-only
- Strategy Lab now always starts each completed event study with the four required research metrics: signal count, win rate, forward return distribution, and hypothesis-side trade return
- Dashboard market heatmap rendering was rebuilt with explicit Plotly treemap root/group/ticker nodes plus a CSS fallback grid, and dashboard history/quote fetches now tolerate partial provider failures
- Strategy Lab now scopes high/low parsing to the actual trigger clause so proxy notes like `a new low in TLT would signal a new high in rates` cannot flip a requested `new high in 10-year yield` into a yield-low test
- Added `DG10` as a typo-tolerant alias for `DGS10`
- Strategy Lab now supports actual federal-funds-rate hike/cut event studies using FRED federal-funds-rate series, including prompts with `25 basis points or more`
- CME FedWatch probability-history comparisons are flagged as requiring licensed or supplied FedWatch data instead of being silently substituted with unrelated series
- Dashboard heatmap now defaults to S&P 500 sector ETFs and includes a dropdown for S&P 500 Sectors, Major Index ETFs, and Asset Classes
- Long/short signal outputs now explicitly say they are long or short the target asset after each signal
- Added `start-v1.1.27.*` launchers plus a `batches/batch-1-v1.1.27/` snapshot so this release runs the same way as the prior packaged versions

## v1.1.28 Fixes

- Strategy Lab now recognizes prompts such as `the Federal Reserve hikes by 25 basis points or more` as Fed policy rate-change event studies
- Fed/FOMC hike prompts now map the trigger/context to `DFEDTARU` by default, with backend fallback to `DFF` / `FEDFUNDS` if needed, instead of accidentally using one-letter ticker fragments
- Explicit ticker detection now ignores unprefixed one-letter fragments from phrases like `S&P`, while still allowing deliberate single-letter tickers when entered with a `$` prefix
- Added `start-v1.1.28.*` launchers plus a `batches/batch-1-v1.1.28/` snapshot so this release runs the same way as the prior packaged versions

## v1.1.29 Fixes

- Strategy Lab Fed-hike/cut prompts now have a non-FRED fallback using the Federal Reserve target-rate change table, so `DFEDTARU` no longer fails just because FRED returned empty
- Prompts like `Test how often the S&P is down 30 days after the federal reserve hikes interest rates` keep the trigger on the Fed policy-rate upper bound and default to a 25 bps hike threshold when no threshold is specified
- Dashboard heatmaps now render faster by using cached dashboard quote/history payloads, skipping history fetches for `1D` when quote change data is available, and loading the correlation matrix after the heatmap paints
- Dashboard heatmaps now include a `SPY Holdings` mode; clicking `SPY` from the index or asset heatmap drills into a holdings heatmap using backend ETF holdings when available
- Added `start-v1.1.29.*` launchers plus a `batches/batch-1-v1.1.29/` snapshot so this release runs the same way as the prior packaged versions

## v1.1.30 Fixes

- Dashboard top-level heatmap dropdowns stay limited to the three broad map families; holdings maps now open by clicking a tile such as `SPY` or `XLF` inside the same heatmap panel
- Dashboard top-level tile sizes now use representative market/index size estimates instead of ETF AUM; holdings drilldowns use fund holding weights when available
- Dashboard heatmap data now uses lighter historical-price requests and a backend bulk-history path instead of full quote/fundamental lookups for every tile, improving dropdown and holdings-map latency
- Strategy Lab now labels the second primary KPI exactly as `Win Rate` and defines it as the prompt-side trade winning: bearish prompts short the target, bullish prompts long the target
- Strategy Lab metric explanations now match the displayed metric cards, including the long/short target check and credibility read
- Strategy Lab audit charts now use the full analyzed sample window and plot all available signal points instead of clipping to a recent sub-window
- Added `start-v1.1.30.*` launchers plus a `batches/batch-1-v1.1.30/` snapshot so this release runs the same way as the prior packaged versions

## v1.1.30.1 Fixes

- Dashboard ETF drilldowns now use a dedicated backend holdings endpoint with provider-specific holdings files first: State Street daily SPDR `.xlsx`, iShares daily `.csv`, StockAnalysis ETF holdings tables, then yfinance only as a final fallback
- Clicking broad tiles such as `SPY`, `XLF`, or `IWM` keeps the user in the same heatmap panel and builds the constituent map from fund holdings, with tile size based on holding weight
- Holdings identity and price ticker are separated, so bond/cash rows can still display as holdings while only valid Yahoo-style tickers are bulk-priced for live coloring
- Holdings and price-history results are cached and large drilldowns skip correlation work, improving load speed while preserving the visible holdings table
- Added `start-v1.1.30.1.*` launchers plus a `batches/batch-1-v1.1.30.1/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.2 Fixes

- Dashboard now defaults to a true S&P 500 constituent treemap sourced from Vanguard VOO official holdings instead of showing only 11 sector ETF tiles under an S&P map label
- Vanguard official holdings JSON is now used for Vanguard ETFs such as `VTI` and `VOO`, so VTI returns the full holdings universe instead of a 25-row fallback table
- State Street/SPDR holdings weight parsing now treats XLSX weights as percent units, fixing the 100x tile-size bug where sub-1% weights could render as 70-99% positions
- SPDR sector ETF drilldowns are enriched with Vanguard VOO sector and market-value references when available, so XLK/XLF-style maps group holdings meaningfully instead of under `-`
- Dashboard tile area now uses market-cap-style sizing: represented universe value times holding weight when available, then reported market value, then reported weight as a fallback
- Constituent heatmap clicks open the stock ticker page, while top-level ETF/index tiles still drill into holdings inside the same dashboard panel
- Dashboard tables now avoid duplicate `1D` columns and disable sticky market-table headers so PDF/export views do not cover the heatmap content
- Added `start-v1.1.30.2.*` launchers plus a `batches/batch-1-v1.1.30.2/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.3 Fixes

- ETF holdings lookup is now a general issuer/provider ladder, not only a hardcoded `VTI` / `XLK` / `VOO` fix
- iShares/BlackRock holdings now use the current product-data API and dynamically discover US iShares product IDs from the iShares ETF list, so ETFs such as `TLT` and `IBIT` do not need one-off CSV IDs
- Vanguard and State Street provider attempts are now generic fallbacks beyond the fast-path seed tickers, so future dashboard maps can try issuer-owned holdings first before using third-party fallbacks
- The generic holdings parser preserves reported weights, asset class/sector, market value, and price tickers when a provider exposes them, and the heatmap display uses the same sizing logic for any ETF payload
- Third-party StockAnalysis/yfinance are now explicitly fallback providers rather than the first source for issuer families that expose official holdings
- Added `start-v1.1.30.3.*` launchers plus a `batches/batch-1-v1.1.30.3/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.4 Fixes

- Backend UTC timestamps now use timezone-aware Python 3.14-safe helpers, removing the repeated `datetime.utcnow()` / `utcfromtimestamp()` deprecation warnings
- Yahoo-facing symbols now normalize share-class tickers such as `BRK.B` and `BF.B` to Yahoo's `BRK-B` / `BF-B` format while preserving the app-facing ticker label
- Bulk yfinance history downloads now suppress provider console noise and return partial successes instead of filling the backend terminal with false delisting alarms
- Browser-canceled history responses are now treated as normal disconnects, so `ConnectionAbortedError` no longer prints scary stack traces when the dashboard refreshes or abandons a request
- Added `start-v1.1.30.4.*` launchers plus a `batches/batch-1-v1.1.30.4/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.5 Fixes

- Dashboard stock-index heatmaps now use real index constituent universes and company market caps instead of ETF weights, fixing price-weighted distortions such as Goldman Sachs appearing as a trillion-dollar Dow tile
- Added a backend `/api/index-constituents` endpoint for S&P 500, Nasdaq-100, and Dow 30 maps, with Nasdaq official constituent data plus StockAnalysis market-cap table fallbacks and Nasdaq screener sector/industry enrichment
- ETF holdings payloads are now enriched with company market caps, sector, industry, last price, and daily return when available, so ETF drilldowns also size tiles by market cap before falling back to fund market value or weight
- Dashboard clicks for `SPY`, `QQQ`, `DIA`, and `RSP` now open market-cap constituent maps instead of treating those index proxies as ordinary ETF-weight maps
- Heatmap colors were made brighter and more FinViz-like with stronger red/green saturation while preserving the selected-return color scale
- Added `start-v1.1.30.5.*` launchers plus a `batches/batch-1-v1.1.30.5/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.6 Fixes

- Dashboard asset tables now use the title `Assets` instead of `Constituent List` / `ETF Market List`
- Asset tables now have per-column filters for every displayed column
- Long asset tables now start with 15 rows, include a `Show More` button to reveal 25 on the first page, and paginate additional rows in 25-row pages
- Dashboard reference correlations now stay consistent across every heatmap mode, using compact Major Indexes, S&P Sectors, and Asset Classes reference groups instead of giant current-list constituent matrices
- Recent Lookups and Watchlist panels now refresh after ticker data is saved, so new searches/clicks surface without requiring a dashboard reload
- Added `start-v1.1.30.6.*` launchers plus a `batches/batch-1-v1.1.30.6/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.7 Fixes

- Dashboard `1D` constituent heatmaps now render from provider snapshot returns and last prices instead of blocking first paint on hundreds of extra 5-day history downloads
- Dashboard market/history cache windows were lengthened and force-refresh now correctly bypasses cached constituent/holding payloads
- Correlation loading and top-level heatmap prefetch now run after idle time so they do not compete with the first visible heatmap render
- Backend `/api/history` now caches recent history payloads, can serve stale cached history on refresh failure, and supports capped per-symbol fallbacks so large dashboard requests do not spiral into hundreds of slow retries
- Added `start-v1.1.30.7.*` launchers plus a `batches/batch-1-v1.1.30.7/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.8 Fixes

- Dashboard correlation now shows three always-visible fixed matrices: Major Indexes, Total Market / Asset Classes, and S&P Sectors
- Correlation matrices no longer turn into collapsed drilldown cards or current-holdings-specific matrices after clicking into ETFs
- S&P sector heatmap tile sizes now aggregate current S&P 500 constituent market caps by sector instead of using static sector estimates
- Top-level index and asset-class maps now dynamically size tiles from current index constituent market caps, ETF holdings market-cap sums when usable, or explicit proxy-adjusted represented-market baselines for non-equity markets
- Added BND as an aggregate US bond-market proxy alongside TLT, so Treasury exposure is not treated as the entire bond market
- Added `start-v1.1.30.8.*` launchers plus a `batches/batch-1-v1.1.30.8/` snapshot so this patch runs the same way as the prior packaged versions

## v1.1.30.9 Fixes

- Restored the old full correlation-matrix display style instead of collapsed summary/card panels
- Dashboard correlations are now always the same fixed three matrices under every heatmap/drilldown: S&P 500 Sectors, Total Market / Asset Classes, and Major Indexes
- Removed the idle/deferred correlation loader that could leave the dashboard stuck on `Loading correlation after the heatmap renders...`
- Each fixed matrix now loads independently, so one slow reference group does not block the other two matrices from displaying
- Added `start-v1.1.30.9.*` launchers plus a `batches/batch-1-v1.1.30.9/` snapshot so this patch runs the same way as the prior packaged versions

## Starter Model Portfolios

These built-in model portfolios are for testing, documentation, and future methodology work. They are not personalized advice.

- `Core 60/40`
  `IVV 60 / AGG 40` for a simple equity-bond baseline.
- `Aggressive Growth`
  `QQQ 45 / IWF 35 / IVV 20` for a higher-growth, large-cap-heavy tilt.
- `Conservative Income`
  `AGG 40 / SHY 30 / USMV 20 / SCHD 10` for lower-volatility income emphasis.
- `Fixed Income Core`
  `AGG 55 / TIP 25 / SHY 20` for a bond-centered allocation with inflation protection.
- `Defensive Allocation`
  `USMV 40 / SCHD 25 / AGG 20 / SHY 15` for a lower-beta, cash-and-bond-supported stance.
- `Value Tilt`
  `IWD 50 / SCHD 30 / IVV 20` for a value-and-dividend-leaning equity mix.

These models were chosen as broad ETF-based reference allocations so we can test portfolio workflows and document methodology before the full Batch 2 Portfolio Visualizer-style engine is implemented.

## Batch Plan

Batch `1.1.x` remains the data-foundation and ticker-correctness phase.
Batch `1.2.1` should focus on portfolio analysis flows and saved portfolio behavior.
Batch `1.2.2` should focus on backtest/report parity and comparison-table improvements.
Batch `1.3.1` should focus on methodology-driven analytics and Portfolio Visualizer-style rolling metrics.
Batch `1.4.1` should focus on persistence, presets, and user workflows.
Batch `1.5.1` should focus on validation, polish, and handoff quality.

## Batch Folder Convention

Batch artifacts should live under:

- `batches/batch-1-v1.1/`
- `batches/batch-2/`
- etc.

The root folder is the active working copy. The `batches/` folder is for easier handoff and testing snapshots.

## Project Architecture

- `backend/server.py`
  Local HTTP layer over `yfinance` for quote, summary, search, and history
- `app-core.js`
  Shared config, local DB schema, API transport, and common compute helpers
- `app-features.js`
  Ticker analysis, portfolio builder, saved portfolio state, and ticker chart controls
- `app-backtest.js`
  Backtesting, portfolio context, compare, and dashboard logic
- `app-charts.js`
  Shared chart renderers using `Chart.js` for general app charts and `Plotly` for advanced ticker charting
- `app-main.js`
  Bootstrapping, settings, diagnostics, and documentation loading

## Known Limitations

- Python is required locally to run the backend
- Some fields may still be unavailable if `yfinance`/Yahoo does not expose them for a symbol
- The methodology PDF has not been fully implemented yet
- Some advanced metrics are currently derived from price history only
- Browser-side API apps are still more fragile than a proper backend architecture
