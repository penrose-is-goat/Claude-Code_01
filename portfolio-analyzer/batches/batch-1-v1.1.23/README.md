# Portfolio Analyzer Pro

Portfolio-style analysis site inspired by Portfolio Visualizer, packaged as a browser app with a local in-browser SQLite cache and a single-file `index.html` deliverable.

This workspace is now organized by batches. The current stable target is:

- `Batch 1 v1.1.23`
- Provider: local Python market-data backend (`yfinance` + FRED for supported macro/index series)
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

What Batch 1 v1.1.23 is meant to handle well:

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
powershell -ExecutionPolicy Bypass -File .\start-v1.1.23.ps1
```

Or just double-click:

```text
start-v1.1.23.bat
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
  Local HTTP backend powered by `yfinance` plus FRED history support for selected macro/index series
- `backend/requirements.txt`
  Python dependencies for the backend

## Provider Notes

Batch 1 v1.1.23 uses a local market-data backend for:

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
- FRED macro/index history for supported Strategy Lab series such as `DGS10` and `SP500`

The frontend still computes portfolio analytics in other parts of the app, but the ticker page is now biased toward provider-owned fields first. One important nuance: Yahoo/yfinance ETF/fund `3Y` and `5Y` performance is presented on an annualized basis, so Batch `1.1.16` aligns those windows to that methodology instead of showing cumulative return.

## Testing Checklist

Use this list before moving to Batch 2:

1. Ticker lookup works for `NVDA`, `AAPL`, `MSFT`, `SPY`
2. Price chart updates when changing ranges
3. Portfolio Builder can add holdings and save allocations
4. Backtest runs on at least `1Y` and `3Y`
5. Compare works for 2-4 symbols
6. Settings `Test Backend` button passes
7. Footer shows `Batch 1 v1.1.23`
8. Settings diagnostics show the same backend version as the frontend batch
9. ETF top sectors / top holdings do not show `N/A` when Yahoo/yfinance returns them
10. ETF `NAV` is populated when Yahoo/yfinance exposes `navPrice`
11. Backtest panel clearly shows which portfolio is being tested
12. Ticker chart supports frequency, compare, line/candlestick, moving averages, and RSI/MACD controls

## v1.1.23 Fixes

- Strategy Lab now separates signal-definition series from tradable target proxies, which fixes the deeper logic bug where proxy behavior could distort signal timing
- Prompts like `10-Yr treasury yield hits a new year to date high` now keep the trigger on the canonical `DGS10` series instead of letting inverse bond ETFs redefine the event count
- Added a new `Series Resolution` section so each run explains which series were requested, which proxy candidates were audited, and why a proxy was accepted or rejected
- Added target proxy audits based on daily return correlation and signal proxy audits based on trigger overlap, so proxy substitution is now validated instead of assumed
- Strategy Lab still supports tradable ETF proxies where they are genuinely close enough, but it now falls back to the canonical series when the proxy fails the consistency check
- The earlier `v1.1.22` improvements remain in place: overlap table, FRED support, dashboard heatmap refresh, and full date labels on charts
- Added `start-v1.1.23.*` launchers plus a `batches/batch-1-v1.1.23/` snapshot so this release runs the same way as the prior packaged versions

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
