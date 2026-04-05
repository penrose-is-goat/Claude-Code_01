# Portfolio Analyzer Pro

A comprehensive, self-contained portfolio analysis website inspired by [Portfolio Visualizer](https://www.portfoliovisualizer.com/analysis). Built as a single HTML file with an in-browser SQLite database, live market data, backtesting, and full risk analytics.

![License](https://img.shields.io/badge/license-MIT-blue)
![HTML](https://img.shields.io/badge/HTML-Single%20File-orange)
![JS](https://img.shields.io/badge/JavaScript-Vanilla-yellow)

---

## Features

| Feature | Description |
|---------|-------------|
| **Ticker Search** | Search any stock/ETF with autocomplete. 28 tickers in demo mode, unlimited with free API key |
| **Live Prices** | Real-time price, daily change, market state indicator |
| **Key Metrics** | Beta, P/E, Forward P/E, Delta, Gamma, Alpha, Market Cap, Volume, Yield |
| **Price Charts** | Interactive Chart.js charts with 9 time ranges (1M, 3M, 6M, YTD, 1Y, 3Y, 5Y, 10Y, MAX) |
| **Drawdown Analysis** | Peak-to-trough decline visualization |
| **Portfolio Builder** | Add holdings with % allocations, normalize to 100%, save/load multiple portfolios |
| **Backtesting** | Historical simulation vs benchmark (SPY, QQQ, DIA, IWM, VTI, AGG) |
| **Backtest Metrics** | CAGR, Volatility, Sharpe Ratio, Sortino Ratio, Max Drawdown, Calmar Ratio, Annual Returns |
| **Asset Comparison** | Compare up to 10 tickers side-by-side with all metrics |
| **Correlation Matrix** | Color-coded heatmap of pairwise return correlations |
| **Risk/Return Scatter** | Visual risk vs return scatter plot |
| **Watchlist** | Save tickers for quick access on the dashboard |
| **SQLite Database** | In-browser SQLite (sql.js) with localStorage auto-save and `.sqlite` file export |
| **Dark Theme** | Professional dark UI, fully responsive for mobile/tablet/desktop |

---

## Metrics Explained

| Metric | Definition |
|--------|-----------|
| **Beta** | Systematic risk vs S&P 500. Beta > 1 = more volatile than market |
| **P/E Ratio** | Trailing 12-month price-to-earnings ratio |
| **Forward P/E** | Price-to-earnings based on forward earnings estimates |
| **Delta** | Regression sensitivity of stock returns to SPY returns (similar to beta, computed from recent data) |
| **Gamma** | Rate of change of delta over rolling 20-day windows (convexity measure) |
| **Alpha** | Jensen's Alpha via CAPM: excess return beyond what beta predicts. Positive = outperformance |
| **Market Cap** | Total market capitalization (price x shares outstanding) |
| **Volume** | Current trading day volume |
| **Yield** | Trailing annual dividend yield |
| **Sharpe Ratio** | Risk-adjusted return: (Return - Risk-Free Rate) / Volatility |
| **Sortino Ratio** | Like Sharpe but only penalizes downside volatility |
| **Max Drawdown** | Largest peak-to-trough decline in the period |
| **CAGR** | Compound Annual Growth Rate |

---

## Two Modes: Demo & Live

The app works in **two modes**:

| Mode | How | What You Get |
|------|-----|-------------|
| **Demo Mode** | Just open `index.html` - no setup needed | 28 popular tickers (AAPL, NVDA, SPY, etc.) with simulated prices and real fundamental metrics |
| **Live Mode** | Add a free API key in Settings | Any ticker worldwide, real-time prices from Financial Modeling Prep (250 requests/day free) |

### Getting a Free API Key (for Live Mode)

1. Go to [financialmodelingprep.com/developer/docs](https://financialmodelingprep.com/developer/docs/)
2. Click **"Get Free API Key"** (no credit card needed)
3. Copy your key, open the app, go to **Settings** tab
4. Paste it and click **Save Key**

---

## Quick Start

### Option 1: Just Open the File (Simplest)

1. Download `index.html` from this repository
2. Double-click to open in any modern browser (Chrome, Firefox, Edge, Safari)
3. Start searching for tickers in the search bar (try AAPL, NVDA, SPY, TSLA, etc.)
4. The app starts in **Demo Mode** with sample data for 28 popular tickers
5. For live data on any ticker, add a free API key in the **Settings** tab

That's it. No server, no installation, no dependencies to install.

---

### Option 2: Google Colab (Best for Sharing)

This is the recommended approach if you want to share the app with others or run it from anywhere.

**Step-by-step:**

1. **Open Google Colab**: Go to [https://colab.research.google.com](https://colab.research.google.com) and create a new notebook

2. **Cell 1 - Clone the repository:**
```python
!git clone https://github.com/penrose-is-goat/Claude-Code_01.git
%cd Claude-Code_01
```

3. **Cell 2 - Serve the website with a tunnel:**
```python
# Install localtunnel for public URL
!npm install -g localtunnel

# Start a simple HTTP server in the background
import subprocess
import time

server = subprocess.Popen(
    ['python3', '-m', 'http.server', '8080'],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE
)
time.sleep(2)
print("Local server started on port 8080")

# Create a public tunnel
!lt --port 8080
```
> When localtunnel gives you a URL, click it to open your Portfolio Analyzer.
> You may need to click "Click to Continue" on the tunnel page first.

4. **Alternative Cell 2 - Using Colab's built-in display:**
```python
from IPython.display import IFrame, display, HTML

# Read the HTML file
with open('index.html', 'r') as f:
    html_content = f.read()

# Display inline (some features may be limited due to iframe sandboxing)
display(HTML(f'<iframe srcdoc="{html_content.replace(chr(34), "&quot;")}" width="100%" height="800px" style="border:none"></iframe>'))
```

5. **Alternative Cell 2 - Using Google Colab's port forwarding (most reliable):**
```python
from google.colab import output
import subprocess, time

# Start HTTP server
server = subprocess.Popen(['python3', '-m', 'http.server', '8080'])
time.sleep(1)

# This opens a proxied URL in Colab
output.serve_kernel_port_as_window(8080)
```

6. **To download the HTML file from Colab:**
```python
from google.colab import files
files.download('index.html')
```

---

### Option 3: VS Code (Local Development)

**Step-by-step:**

1. **Clone the repository:**
```bash
git clone https://github.com/penrose-is-goat/Claude-Code_01.git
cd Claude-Code_01
```

2. **Option A - Live Server Extension (Recommended):**
   - Install the **"Live Server"** extension by Ritwick Dey in VS Code
   - Open the project folder in VS Code: `code .`
   - Right-click on `index.html` in the file explorer
   - Select **"Open with Live Server"**
   - Your browser will open automatically at `http://127.0.0.1:5500`
   - The page auto-reloads when you make changes

3. **Option B - Python HTTP Server:**
```bash
# If you have Python installed
python3 -m http.server 8080
# Then open http://localhost:8080 in your browser
```

4. **Option C - Node.js HTTP Server:**
```bash
# If you have Node.js installed
npx serve .
# Then open the URL shown in the terminal
```

5. **Option D - Just open the file directly:**
```bash
# macOS
open index.html

# Linux
xdg-open index.html

# Windows
start index.html
```

---

### Option 4: GitHub Pages (Free Permanent Hosting)

Host the site for free so anyone can access it with a URL:

1. Go to your repository on GitHub
2. Click **Settings** > **Pages** (in the left sidebar)
3. Under "Source", select **Branch: main** (or your branch), folder: **/ (root)**
4. Click **Save**
5. Wait 1-2 minutes, then your site will be live at:
   `https://penrose-is-goat.github.io/Claude-Code_01/`

---

## Project Structure

```
Claude-Code_01/
├── index.html          # Complete self-contained app (HTML + CSS + JS) - THE DELIVERABLE
├── portfolio_db.sql    # SQLite database schema + seed data - THE DELIVERABLE
├── styles.css          # CSS source (embedded in index.html)
├── app-core.js         # Core modules: Config, Database, API, Compute, Formatters
├── app-charts.js       # Chart.js wrapper functions
├── app-features.js     # UI utilities, Ticker analysis, Portfolio builder
├── app-backtest.js     # Backtesting engine, Asset comparison, Dashboard
├── app-main.js         # App controller, search, initialization
├── build.sh            # Script to assemble source files into index.html
└── README.md           # This file
```

### How the Build Works

The source JS/CSS files are kept separate for maintainability. `build.sh` assembles them into the single `index.html`:

```bash
# To rebuild after making changes to source files:
bash build.sh
```

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| **Vanilla JavaScript** | No frameworks - runs anywhere, zero build step |
| **[sql.js](https://github.com/sql-js/sql.js/)** | SQLite compiled to WebAssembly, runs in-browser |
| **[Chart.js](https://www.chartjs.org/)** | Interactive, responsive charts |
| **[Financial Modeling Prep](https://financialmodelingprep.com/)** | Live stock quotes, historical prices, fundamentals (free API key) |
| **Built-in Sample Data** | 28 popular tickers with realistic simulated data for demo mode |
| **localStorage** | Automatic database persistence between sessions |

---

## Database Schema

The `portfolio_db.sql` file defines 11 tables:

- **`securities`** - Master ticker registry (25 popular stocks/ETFs seeded)
- **`quotes`** - Cached live quote data with all fundamentals
- **`greeks`** - Computed risk metrics (alpha, beta, delta, gamma, Sharpe, etc.)
- **`price_history`** - Historical OHLCV price data
- **`portfolios`** - Saved portfolio definitions (3 sample portfolios seeded)
- **`portfolio_holdings`** - Portfolio allocations
- **`portfolio_performance`** - Performance snapshots
- **`analysis_results`** - Cached analysis outputs
- **`correlations`** - Pairwise correlation cache
- **`watchlist`** - User watchlist
- **`settings`** - App configuration

---

## How to Use the App

### 1. Search a Ticker
Type any stock symbol (e.g., `AAPL`, `MSFT`, `SPY`) in the search bar and press Enter or click a result. You'll see:
- Live price and daily change
- All 9 key metrics (beta, P/E, fwd P/E, delta, gamma, alpha, market cap, volume, yield)
- Interactive price chart with range selector
- Drawdown chart
- Additional statistics table

### 2. Build a Portfolio
- Click "Add to Portfolio" from any ticker page, or go to the Portfolio tab
- Enter tickers and allocation percentages
- Use "Normalize to 100%" to auto-balance
- Save with a name for later use

### 3. Run a Backtest
- Go to the Backtesting tab
- Select a benchmark, time period, and initial investment amount
- Click "Run Backtest"
- View growth charts, drawdown, annual returns, and all risk metrics vs the benchmark

### 4. Compare Assets
- Go to the Asset Comparison tab
- Add 2-10 tickers
- Click "Compare" to see a side-by-side metrics table, normalized performance chart, correlation matrix, and risk/return scatter plot

### 5. Export Data
- Click "Export DB" in the header to download your SQLite database file
- Go to Settings to clear cache or reset all data

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Ticker not found" in demo mode | Only 28 popular tickers work without an API key. Add a free key in Settings for any ticker. |
| "Invalid API key" | Double-check your FMP key in Settings. Get a new one at [financialmodelingprep.com](https://financialmodelingprep.com/developer/docs/) |
| "Rate limited" | Free FMP tier allows 250 requests/day. Wait until tomorrow or upgrade your key. |
| Charts not loading | Ensure you have internet access (Chart.js and sql.js load from CDN) |
| Data looks stale | Click Settings > Clear API Cache, then re-search the ticker |
| Database lost on refresh | The app auto-saves to localStorage. If localStorage is full, export the DB file first. |
| DEMO DATA badge showing | This means you're in demo mode. Add a free API key for real-time data. |
| Slow on mobile | Large backtests with 10Y of data can be heavy. Use shorter time ranges on mobile. |

---

## License

MIT License - Free to use, modify, and distribute.
