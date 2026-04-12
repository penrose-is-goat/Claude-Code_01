$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$css = Get-Content -LiteralPath (Join-Path $scriptDir 'styles.css') -Raw
$jsCore = Get-Content -LiteralPath (Join-Path $scriptDir 'app-core.js') -Raw
$jsCharts = Get-Content -LiteralPath (Join-Path $scriptDir 'app-charts.js') -Raw
$jsFeatures = Get-Content -LiteralPath (Join-Path $scriptDir 'app-features.js') -Raw
$jsBacktest = Get-Content -LiteralPath (Join-Path $scriptDir 'app-backtest.js') -Raw
$jsMain = Get-Content -LiteralPath (Join-Path $scriptDir 'app-main.js') -Raw

$html = @"
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
<style>
$css
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
  <button class="tab-btn" data-tab="compare">Asset Comparison</button>
  <button class="tab-btn" data-tab="settings">Settings</button>
</nav>

<!-- Main Content -->
<main class="main">

  <!-- Dashboard Tab -->
  <div class="tab-panel active" id="tab-dashboard">
    <h2 style="margin-bottom:20px;font-size:1.3rem">Market Overview</h2>
    <div class="card">
      <div class="card-title">Major Indices &amp; ETFs</div>
      <div class="grid-3" id="dash-market">
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
      <div class="grid-4">
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
      <div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">
        Uses current portfolio holdings. Make sure allocations sum to 100%.
      </div>
    </div>
    <div id="backtest-results" style="display:none;margin-top:16px"></div>
  </div>

  <!-- Asset Comparison Tab -->
  <div class="tab-panel" id="tab-compare">
    <h2 style="margin-bottom:20px;font-size:1.3rem">Asset Comparison</h2>
    <div class="card">
      <div class="card-title">Compare Assets</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;align-items:end">
        <div class="form-group" style="flex:1;margin:0">
          <label class="form-label">Add Ticker</label>
          <input class="form-input" id="cmp-ticker" placeholder="e.g. AAPL" style="text-transform:uppercase"
            onkeydown="if(event.key==='Enter'){PA.Compare.addTicker(this.value);this.value=''}">
        </div>
        <div class="form-group" style="width:120px;margin:0">
          <label class="form-label">Period</label>
          <select class="form-select" id="cmp-range">
            <option value="1Y">1 Year</option>
            <option value="3Y">3 Years</option>
            <option value="5Y">5 Years</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="PA.Compare.addTicker(document.getElementById('cmp-ticker').value);document.getElementById('cmp-ticker').value=''" style="height:36px">Add</button>
        <button class="btn btn-success" onclick="PA.Compare.run()" style="height:36px">Compare</button>
      </div>
      <div id="compare-tags" style="display:flex;flex-wrap:wrap;gap:6px;min-height:30px"></div>
    </div>
    <div id="compare-results" style="display:none;margin-top:16px"></div>
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
          <p style="margin-top:8px"><strong>Data Sources:</strong> Local Python yfinance backend (Batch 1 v1.1.9)</p>
          <p><strong>Metrics:</strong> Provider beta, P/E, Forward P/E, Market Cap, Volume, Yield, plus computed portfolio analytics such as alpha, delta, gamma, Sharpe Ratio, Sortino Ratio, Max Drawdown, and CAGR</p>
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
  <div>Portfolio Analyzer Pro Batch 1 v1.1.9</div>
</footer>

<script>
$jsCore
</script>
<script>
$jsCharts
</script>
<script>
$jsFeatures
</script>
<script>
$jsBacktest
</script>
<script>
$jsMain
</script>
</body>
</html>
"@

$target = Join-Path $scriptDir 'index.html'
Set-Content -LiteralPath $target -Value $html -Encoding UTF8
Write-Host "index.html assembled successfully"
Get-Item -LiteralPath $target | Select-Object FullName, Length, LastWriteTime
