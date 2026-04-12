# Portfolio Analyzer Pro

Portfolio-style analysis site inspired by Portfolio Visualizer, packaged as a browser app with a local in-browser SQLite cache and a single-file `index.html` deliverable.

This workspace is now organized by batches. The current stable target is:

- `Batch 1 v1.1.9`
- Provider: local Python `yfinance` backend
- Goal: live-first provider-exact ticker data from a backend instead of browser-side API stitching or cache-first behavior

## Current Status

What Batch 1 v1.1.9 is meant to handle well:

- Live ticker lookup
- Price charts across multiple ranges
- Live ticker fundamentals sourced from `yfinance`
- ETF profile data sourced from `yfinance`
- Provider beta shown separately from computed analytics
- Trailing 1D, 1M, 3M, and 1Y return labels plus a clearly labeled 1D price move
- Live-first fetches that do not rely on cached DB values when the user requests current data
- Portfolio builder and saved allocations
- Backtesting against benchmark tickers
- Multi-ticker comparison
- Correlation and risk/return views
- Cached fallback via the in-browser SQLite/localStorage database
- Diagnostics that show the last provider request/error instead of a blank `undefined` message
- Safe local DB writes when provider fields are missing

What is still deferred to Batch 2:

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
powershell -ExecutionPolicy Bypass -File .\start-v1.1.9.ps1
```

Or just double-click:

```text
start-v1.1.9.bat
```

That opens a backend PowerShell window for you. Keep that window running while you use the site.

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
- `app-main.js`
  App bootstrapping, search, settings UI, API test button
- `build.ps1`
  Windows build script that assembles the deliverable
- `build.sh`
  Bash build script for non-Windows environments
- `portfolio_db.sql`
  Schema reference
- `backend/server.py`
  Local HTTP backend powered by `yfinance`
- `backend/requirements.txt`
  Python dependencies for the backend

## Provider Notes

Batch 1 v1.1.9 uses a local `yfinance` backend for:

- Quotes
- Historical price series
- Search
- Stock fundamentals
- ETF profile data

The frontend still computes analysis metrics like alpha, delta, gamma, and backtest statistics, but provider-owned fields are intended to come directly from `yfinance`.

## Testing Checklist

Use this list before moving to Batch 2:

1. Ticker lookup works for `NVDA`, `AAPL`, `MSFT`, `SPY`
2. Price chart updates when changing ranges
3. Portfolio Builder can add holdings and save allocations
4. Backtest runs on at least `1Y` and `3Y`
5. Compare works for 2-4 symbols
6. Settings `Test Backend` button passes
7. Footer shows `Batch 1 v1.1.9`

## v1.1.9 Fixes

- Added a local Python backend powered by `yfinance`
- Switched the frontend to live-first backend fetches instead of cache-first browser-side provider calls
- Separated provider beta from computed beta
- Stopped deriving provider-owned quote/fundamental fields from history inside the frontend
- Added backend diagnostics and setup instructions
- Added clearer backend-offline detection so `Failed to fetch` becomes a specific startup instruction
- Added `backend\start-backend.ps1`, `backend\start-backend.bat`, `start-v1.1.9.ps1`, and `start-v1.1.9.bat` helper launchers

## Batch Plan

Batch 1 remains the data-foundation and ticker-correctness phase.
Batch 2 should focus on stronger portfolio analytics, compare-table fundamentals parity, and methodology alignment against the attached PDF.

## Batch Folder Convention

Batch artifacts should live under:

- `batches/batch-1-v1.1/`
- `batches/batch-2/`
- etc.

The root folder is the active working copy. The `batches/` folder is for easier handoff and testing snapshots.

## Known Limitations

- Python is required locally to run the backend
- Some fields may still be unavailable if `yfinance`/Yahoo does not expose them for a symbol
- The methodology PDF has not been fully implemented yet
- Some advanced metrics are currently derived from price history only
- Browser-side API apps are still more fragile than a proper backend architecture

## Next Step

Batch 2 should focus on:

- fundamentals source integration
- methodology-accurate metrics
- tighter portfolio analytics
- validation against the attached methodology document
