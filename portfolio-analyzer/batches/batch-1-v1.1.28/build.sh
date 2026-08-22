#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Assemble all parts into index.html
CSS=$(cat "$SCRIPT_DIR/styles.css")
JS_CORE=$(cat "$SCRIPT_DIR/app-core.js")
JS_CHARTS=$(cat "$SCRIPT_DIR/app-charts.js")
JS_FEATURES=$(cat "$SCRIPT_DIR/app-features.js")
JS_BACKTEST=$(cat "$SCRIPT_DIR/app-backtest.js")
JS_STRATEGY=$(cat "$SCRIPT_DIR/app-strategy-lab.js")
JS_MAIN=$(cat "$SCRIPT_DIR/app-main.js")

cat > "$SCRIPT_DIR/index.html" << HTMLEOF
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portfolio Analyzer Pro</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"></script>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
${CSS}
</style>
</head>
<body>

<!-- Toast Container -->
<div id="toast-container" class="toast-container"></div>

<!-- Header -->
<header class="header">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 5-9"/></svg>
    Portfolio Analyzer Pro
  </div>
  <div class="search-container">
    <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    <input class="search-input" id="search-input" type="text" placeholder="Search ticker symbol (e.g. AAPL, MSFT, SPY...)">
    <div class="search-dropdown" id="search-dropdown"></div>
  </div>
  <div class="header-actions">
    <button class="btn btn-sm" onclick="PA.App.exportDb()" title="Export Database">Export DB</button>
  </div>
</header>

<!-- Tab Bar -->
<nav class="tab-bar">
  <button class="tab-btn active" data-tab="dashboard">Dashboard</button>
  <button class="tab-btn" data-tab="ticker">Ticker Analysis</button>
  <button class="tab-btn" data-tab="portfolio">Portfolio Builder</button>
  <button class="tab-btn" data-tab="backtest">Backtesting</button>
  <button class="tab-btn" data-tab="strategy">Strategy Lab</button>
  <button class="tab-btn" data-tab="compare">Asset Comparison</button>
  <button class="tab-btn" data-tab="settings">Settings</button>
</nav>

<!-- Main Content -->
<main class="main">

  <!-- Dashboard Tab -->
  <div class="tab-panel active" id="tab-dashboard">
    <h2 style="margin-bottom:20px;font-size:1.3rem">Markets Dashboard</h2>
    <div class="card">
      <div class="card-title">ETF Market Heatmap</div>
      <div id="dash-market">
        <div class="loading"><div class="spinner"></div>Loading market data...</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-title">Watchlist</div>
        <div id="dash-watchlist"><div style="color:var(--text-muted);padding:10px">Loading...</div></div>
      </div>
      <div class="card">
        <div class="card-title">Recent Lookups</div>
        <div id="dash-recent"><div style="color:var(--text-muted);padding:10px">Loading...</div></div>
      </div>
    </div>
  </div>

  <!-- Ticker Analysis Tab -->
  <div class="tab-panel" id="tab-ticker">
    <div id="ticker-content" style="display:none">
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <h3>Search for a Ticker</h3>
        <p>Enter a stock symbol in the search bar above to view detailed analysis</p>
      </div>
    </div>
    <div class="empty-state" id="ticker-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <h3>Search for a Ticker</h3>
      <p>Enter a stock symbol in the search bar above to view detailed analysis including price, beta, P/E, forward P/E, delta, gamma, alpha, market cap, volume, and yield.</p>
    </div>
  </div>

  <!-- Portfolio Builder Tab -->
  <div class="tab-panel" id="tab-portfolio">
    <h2 style="margin-bottom:20px;font-size:1.3rem">Portfolio Builder</h2>
    <div class="grid-2">
      <div>
        <div class="card">
          <div class="card-title">Holdings</div>
          <div id="portfolio-holdings"></div>
        </div>
        <div class="card">
          <div class="card-title">Saved Portfolios</div>
          <div id="saved-portfolios"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="card-title">Allocation</div>
          <div class="chart-container"><canvas id="chart-allocation"></canvas></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Backtesting Tab -->
  <div class="tab-panel" id="tab-backtest">
    <h2 style="margin-bottom:20px;font-size:1.3rem">Portfolio Backtesting</h2>
    <div class="card">
      <div class="card-title">Backtest Configuration</div>
      <div class="grid-5">
        <div class="form-group">
          <label class="form-label">Portfolio</label>
          <select class="form-select" id="bt-portfolio" onchange="PA.Backtest.changePortfolio(this.value)">
            <option value="CURRENT">Current Working Portfolio</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Benchmark</label>
          <select class="form-select" id="bt-benchmark">
            <option value="SPY">SPY - S&amp;P 500</option>
            <option value="QQQ">QQQ - Nasdaq 100</option>
            <option value="DIA">DIA - Dow Jones</option>
            <option value="IWM">IWM - Russell 2000</option>
            <option value="VTI">VTI - Total Market</option>
            <option value="AGG">AGG - US Agg Bond</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Time Period</label>
          <select class="form-select" id="bt-range">
            <option value="1Y">1 Year</option>
            <option value="3Y">3 Years</option>
            <option value="5Y" selected>5 Years</option>
            <option value="10Y">10 Years</option>
            <option value="MAX">Max Available</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Initial Investment</label>
          <input class="form-input" id="bt-initial" type="number" value="10000" min="100" step="100">
        </div>
        <div class="form-group" style="display:flex;align-items:end">
          <button class="btn btn-primary" onclick="PA.Backtest.run()" style="width:100%">Run Backtest</button>
        </div>
      </div>
      <div id="bt-portfolio-summary" class="subtle-panel" style="margin-top:12px"></div>
      <div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">
        Select a saved portfolio or use the current working portfolio from the Portfolio Builder tab.
      </div>
    </div>
    <div id="backtest-results" style="display:none;margin-top:16px"></div>
  </div>

  <!-- Strategy Lab Tab -->
  <div class="tab-panel" id="tab-strategy">
    <div class="card strategy-hero">
      <div class="strategy-hero-content">
        <div>
          <div class="strategy-hero-eyebrow">Quant Strategy Lab</div>
          <h2>Type a market idea. Get a testable event study.</h2>
          <p>
            This workflow turns a plain-English strategy prompt into a structured research spec, keeps the assumptions visible,
            and runs a first-pass event study against live history from the local market-data backend. It is built to answer questions
            like whether SPY tends to be down a week after the VIX and S&amp;P move in the same direction three days in a week.
          </p>
        </div>
        <div class="strategy-hero-stats">
          <div class="strategy-mini-stat">
            <div class="label">Best First Tool</div>
            <div class="value">Event Study</div>
            <div class="detail">Use conditional forward returns before you trust a polished backtest.</div>
          </div>
          <div class="strategy-mini-stat">
            <div class="label">Trust Rules</div>
            <div class="value">Show Assumptions</div>
            <div class="detail">Keep symbols, threshold, overlap handling, and entry timing visible at all times.</div>
          </div>
          <div class="strategy-mini-stat">
            <div class="label">Next Step</div>
            <div class="value">Graduate Carefully</div>
            <div class="detail">If the effect survives, move into a rule-based backtest with costs and walk-forward checks.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="strategy-grid" style="margin-top:16px">
      <div class="card">
        <div class="card-title">Strategy Composer</div>
        <div class="form-group">
          <label class="form-label">Describe the hypothesis in plain English</label>
          <textarea class="form-input strategy-prompt" id="sl-prompt" placeholder="Example: Test how often the S&amp;P is down one week after the VIX and S&amp;P move the same for more than two days in a week."></textarea>
        </div>
        <div class="chip-row" id="sl-example-chips" style="margin-bottom:14px"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="sl-parse-btn">Parse Prompt</button>
          <button class="btn btn-primary" id="sl-run-btn">Run Event Study</button>
        </div>
        <div class="strategy-note" style="margin-top:10px">
          Run always uses the latest prompt. "Parse Prompt" is optional when you want to inspect or tweak the assumptions first.
        </div>
      </div>

      <div class="card">
        <div class="card-title">What This Tab Does Well</div>
        <div class="strategy-flow-list">
          <div class="strategy-flow-item">
            <div class="strategy-flow-index">1</div>
            <div class="strategy-flow-copy">Translate a sentence into symbols, signal window, threshold, horizon, and entry convention.</div>
          </div>
          <div class="strategy-flow-item">
            <div class="strategy-flow-index">2</div>
            <div class="strategy-flow-copy">Compare the conditional forward-return distribution against all valid unconditional windows.</div>
          </div>
          <div class="strategy-flow-item">
            <div class="strategy-flow-index">3</div>
            <div class="strategy-flow-copy">Flag thin samples, overlap risk, and weak baselines before you over-trust the result.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-title">Study Assumptions</div>
      <div class="strategy-form-grid">
        <div class="form-group">
          <label class="form-label">Study Type</label>
          <select class="form-select" id="sl-study-type">
            <option value="event-study">Event Study</option>
            <option value="rule-based-backtest">Rule-Based Backtest</option>
            <option value="forecast-model">Forecast Model</option>
            <option value="cross-sectional-model">Cross-Sectional Model</option>
            <option value="portfolio-construction">Portfolio Construction</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Target Symbol</label>
          <input class="form-input" id="sl-target" type="text" placeholder="SPY or SP500">
        </div>
        <div class="form-group">
          <label class="form-label" id="sl-context-label">Context Symbol</label>
          <input class="form-input" id="sl-context" type="text" placeholder="^VIX or DGS10">
        </div>
        <div class="form-group">
          <label class="form-label" id="sl-relation-label">Relation</label>
          <select class="form-select" id="sl-relation">
            <option value="same-direction">Same Direction</option>
            <option value="opposite-direction">Opposite Direction</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" id="sl-window-label">Lookback Window</label>
          <input class="form-input" id="sl-window" type="number" min="2" step="1" value="5">
        </div>
        <div class="form-group">
          <label class="form-label" id="sl-threshold-label">Min Matching Days</label>
          <input class="form-input" id="sl-threshold" type="number" min="1" step="1" value="3">
        </div>
        <div class="form-group">
          <label class="form-label">Forward Sessions</label>
          <input class="form-input" id="sl-forward" type="number" min="1" step="1" value="5">
        </div>
        <div class="form-group">
          <label class="form-label">Expected Outcome</label>
          <select class="form-select" id="sl-outcome">
            <option value="down">Down</option>
            <option value="up">Up</option>
            <option value="either">Either</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">History Range</label>
          <select class="form-select" id="sl-range">
            <option value="3Y">3 Years</option>
            <option value="5Y">5 Years</option>
            <option value="10Y" selected>10 Years</option>
            <option value="MAX">Max Available</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Entry Timing</label>
          <select class="form-select" id="sl-entry">
            <option value="signal-close" selected>Signal Close</option>
            <option value="next-open">Next Open</option>
          </select>
        </div>
        <div class="form-group" style="display:flex;align-items:end">
          <label class="strategy-checkbox">
            <input id="sl-overlap" type="checkbox" checked>
            <span>Suppress overlapping events</span>
          </label>
        </div>
      </div>
      <div id="sl-mode-hint" class="strategy-note" style="margin-top:12px"></div>
      <div id="sl-summary-panel" class="subtle-panel" style="margin-top:14px"></div>
    </div>

    <div id="strategy-results" style="display:none;margin-top:16px"></div>
  </div>

  <!-- Asset Comparison Tab -->
  <div class="tab-panel" id="tab-compare">
    <h2 style="margin-bottom:20px;font-size:1.3rem">Asset Comparison</h2>
    <div class="card">
      <div class="card-title">Compare Assets</div>
      <div class="chart-control-grid" style="margin-bottom:12px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Tickers</label>
          <textarea class="form-input" id="cmp-ticker" rows="2" placeholder="e.g. AAPL, MSFT, NVDA, SPY" style="resize:vertical;text-transform:uppercase"></textarea>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Saved Portfolio</label>
          <select class="form-select" id="cmp-portfolio" onchange="PA.Compare.loadPortfolioSelection(this.value)">
            <option value="NONE">Manual Entry</option>
            <option value="CURRENT">Current Working Portfolio</option>
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Period</label>
          <select class="form-select" id="cmp-range">
            <option value="1Y">1 Year</option>
            <option value="3Y">3 Years</option>
            <option value="5Y">5 Years</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;display:flex;align-items:end;gap:8px">
          <button class="btn btn-primary" onclick="PA.Compare.addTickersFromInput(document.getElementById('cmp-ticker').value, true)" style="height:36px">Load List</button>
          <button class="btn" onclick="PA.Compare.clear()" style="height:36px">Clear</button>
          <button class="btn btn-success" onclick="PA.Compare.run()" style="height:36px">Compare Assets</button>
        </div>
      </div>
      <div id="compare-tags" style="min-height:30px"></div>
      <div class="subtle-panel" style="margin-top:14px">
        <div class="card-title" style="margin-bottom:10px">Portfolio vs Portfolio</div>
        <div class="compare-subtitle">Select two or more saved or default portfolios to compare allocation behavior, drawdown, and peer correlation.</div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end">
          <div class="form-group" style="margin:0">
            <label class="form-label">Portfolios</label>
            <select class="form-select" id="cmp-portfolio-compare" multiple size="6"></select>
          </div>
          <div class="form-group" style="margin:0;display:flex;align-items:end">
            <button class="btn btn-primary" onclick="PA.Compare.runPortfolioComparison()" style="height:36px">Compare Portfolios</button>
          </div>
        </div>
      </div>
    </div>
    <div id="compare-results" style="display:none;margin-top:16px"></div>
    <div id="compare-portfolio-results" style="display:none;margin-top:16px"></div>
  </div>

  <!-- Settings Tab -->
  <div class="tab-panel" id="tab-settings">
    <h2 style="margin-bottom:20px;font-size:1.3rem">Settings</h2>
    <div class="grid-2">
      <div class="card">
        <div class="card-title">Data Management</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn" onclick="PA.App.exportDb()">Export Database (.sqlite)</button>
          <button class="btn" onclick="PA.App.clearCache()">Clear API Cache</button>
          <button class="btn btn-danger" onclick="PA.App.clearAllData()">Reset All Data</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">About</div>
        <div style="color:var(--text-secondary);font-size:0.9rem;line-height:1.6">
          <p><strong>Portfolio Analyzer Pro</strong></p>
          <p>A comprehensive portfolio analysis tool with live market data, backtesting, and risk analytics.</p>
          <p style="margin-top:8px"><strong>Data Sources:</strong> Local Python market-data backend (yfinance + Yahoo chart + FRED fallbacks, Batch 1 v1.1.28)</p>
          <p><strong>Metrics:</strong> Provider beta, P/E, Forward P/E, Market Cap, Volume, stock dividends, ETF distribution yield, plus computed portfolio analytics such as alpha, delta, gamma, Sharpe Ratio, Sortino Ratio, Max Drawdown, and CAGR</p>
          <p style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">
            Provider-sourced fields should match yfinance values directly. Computed metrics are labeled separately from provider facts.
          </p>
        </div>
      </div>
    </div>
  </div>
</main>

<!-- Status Bar -->
<footer class="status-bar">
  <div><span id="status-dot" class="status-dot offline"></span><span id="status-text">Initializing...</span></div>
  <div>Portfolio Analyzer Pro Batch 1 v1.1.28</div>
</footer>

<script>
${JS_CORE}
</script>
<script>
${JS_CHARTS}
</script>
<script>
${JS_FEATURES}
</script>
<script>
${JS_BACKTEST}
</script>
<script>
${JS_STRATEGY}
</script>
<script>
${JS_MAIN}
</script>
</body>
</html>
HTMLEOF
echo "index.html assembled successfully"
wc -l "$SCRIPT_DIR/index.html"
