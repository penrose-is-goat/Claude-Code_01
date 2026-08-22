/* ============================================================
   Portfolio Analyzer Pro - Main App Controller
   ============================================================ */
PA.App = {
  async init() {
    try {
      document.getElementById('status-text').textContent = 'Initializing database...';
      await PA.DB.init();
      this.injectApiSettings();
      this.refreshDiagnostics();
      document.getElementById('status-text').textContent = 'Database ready';
      document.getElementById('status-dot').className = 'status-dot online';

      // Set up tab navigation
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => PA.UI.showTab(btn.dataset.tab));
      });

      // Set up search
      const searchInput = document.getElementById('search-input');
      const dropdown = document.getElementById('search-dropdown');
      searchInput.addEventListener('input', PA.UI.debounce(async (e) => {
        const q = e.target.value.trim();
        if (q.length < 1) { dropdown.classList.remove('active'); return; }
        try {
          const remote = q.length >= 2 ? await PA.API.search(q) : [];
          const local = PA.DB.selectAll(`SELECT ticker,name,exchange FROM securities WHERE ticker LIKE ? OR name LIKE ? LIMIT 5`,
            [`%${q}%`, `%${q}%`]);
          const results = [];
          const seen = new Set();
          [
            { symbol: q.toUpperCase(), shortname: 'Lookup ticker directly', exchange: 'Direct' },
            ...remote.map(r => ({ symbol: r.symbol, shortname: r.shortname || r.longname, exchange: r.exchange || '' })),
            ...local.map(l => ({symbol:l.ticker, shortname:l.name, exchange:l.exchange}))
          ].forEach(r => {
            if (r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); results.push(r); }
          });
          if (results.length === 0) { dropdown.classList.remove('active'); return; }
          dropdown.innerHTML = results.slice(0,8).map(r => `
            <div class="search-item" onclick="PA.App.selectTicker('${r.symbol}')">
              <div><span class="ticker">${r.symbol}</span> <span class="name">${r.shortname}</span></div>
              <span class="exchange">${r.exchange}</span>
            </div>
          `).join('');
          dropdown.classList.add('active');
        } catch(e) { dropdown.classList.remove('active'); }
      }, 250));

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const q = searchInput.value.trim().toUpperCase();
          if (q) { PA.App.selectTicker(q); }
        }
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) dropdown.classList.remove('active');
      });

      // Initialize modules
      PA.Portfolio.init();
      PA.Portfolio.loadSavedList();
      PA.Backtest.init();
      PA.Compare.init();
      PA.Dashboard.init();
      PA.StrategyLab.init();

      PA.UI.showTab('dashboard');
      if (PA.API.getBackendUrl()) {
        try {
          const health = await PA.API.checkBackendHealth();
          if (health?.version && health.version !== PA.Config.APP_VERSION) {
            document.getElementById('status-text').textContent = `Backend version mismatch - restart ${PA.Config.APP_VERSION}`;
            document.getElementById('status-dot').className = 'status-dot offline';
          } else {
            document.getElementById('status-text').textContent = 'Ready (local market-data backend running)';
          }
        } catch (healthError) {
          document.getElementById('status-text').textContent = 'Backend offline - start backend\\start-backend.ps1';
          document.getElementById('status-dot').className = 'status-dot offline';
        }
      } else {
        document.getElementById('status-text').textContent = 'Add backend URL in Settings';
      }
    } catch(e) {
      console.error('Init failed:', e);
      document.getElementById('status-text').textContent = 'Init error: ' + PA.UI.errorText(e);
      document.getElementById('status-dot').className = 'status-dot offline';
    }
  },

  selectTicker(symbol) {
    document.getElementById('search-input').value = symbol;
    document.getElementById('search-dropdown').classList.remove('active');
    PA.Ticker.lookup(symbol);
    PA.UI.showTab('ticker');
  },

  injectApiSettings() {
    const settingsGrid = document.querySelector('#tab-settings .grid-2');
    if (!settingsGrid || document.getElementById('td-settings-card')) return;
    const batchLauncher = `start-${PA.Config.APP_VERSION.replace(/^Batch\s+\d+\s+/, '')}.ps1`;
    settingsGrid.insertAdjacentHTML('afterbegin', `
      <div class="card" id="td-settings-card">
        <div class="card-title">Live Data Backend</div>
        <div class="form-group">
          <label class="form-label">Backend URL</label>
          <input class="form-input" id="backend-url" type="text" placeholder="http://127.0.0.1:8765/api">
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
          <button class="btn btn-primary" onclick="PA.App.saveBackendConfig()">Save Backend</button>
          <button class="btn" onclick="PA.App.testBackend()">Test Backend</button>
          <button class="btn" onclick="PA.App.clearBackendConfig()">Clear</button>
        </div>
        <div style="margin-top:10px;font-size:0.8rem;color:var(--text-muted)">
          The frontend now expects a local Python backend that serves market quotes/history plus canonical macro/index fallbacks for Strategy Lab prompts such as 10-year Treasury yield and S&amp;P 500 event studies.
        </div>
        <div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">
          Provider fields should match backend values directly. Computed metrics such as alpha, delta, and gamma remain labeled as analysis outputs rather than provider facts.
        </div>
        <div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">
          Quick start: run <code>backend\\start-backend.ps1</code> or <code>${batchLauncher}</code> from PowerShell, then keep that terminal window open.
        </div>
        <div style="margin-top:12px;padding:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius)">
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:8px">Diagnostics</div>
          <div id="td-diagnostics" style="font-size:0.8rem;line-height:1.6;color:var(--text-secondary)">No recent API activity yet.</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
            <button class="btn btn-sm" onclick="PA.App.refreshDiagnostics()">Refresh Diagnostics</button>
            <button class="btn btn-sm" onclick="PA.App.clearDiagnostics()">Clear Diagnostics</button>
          </div>
        </div>
      </div>
    `);
    const input = document.getElementById('backend-url');
    if (input) input.value = PA.API.getBackendUrl();
    this.injectDocumentationCard();
    this.refreshDiagnostics();
  },

  injectDocumentationCard() {
    const settingsGrid = document.querySelector('#tab-settings .grid-2');
    if (!settingsGrid || document.getElementById('docs-settings-card')) return;
    settingsGrid.insertAdjacentHTML('beforeend', `
      <div class="card" id="docs-settings-card" style="grid-column:1 / -1">
        <div class="card-title">Documentation</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
          <a class="btn" href="https://github.com/penrose-is-goat/Claude-Code_01" target="_blank" rel="noreferrer">GitHub Repo</a>
          <button class="btn" onclick="PA.App.loadDocumentation()">Load README</button>
        </div>
        <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:12px">
          This panel mirrors the project README, including provider notes, version architecture, batch roadmap, and setup details.
        </div>
        <div id="docs-panel" class="doc-panel">Click "Load README" to view project documentation in-app.</div>
      </div>
    `);
  },

  async loadDocumentation() {
    const panel = document.getElementById('docs-panel');
    if (!panel) return;
    panel.textContent = 'Loading README...';
    try {
      const resp = await fetch('README.md');
      if (!resp.ok) throw new Error(`README request failed (${resp.status})`);
      const text = await resp.text();
      panel.textContent = text;
    } catch (e) {
      panel.textContent = `Unable to load README: ${PA.UI.errorText(e)}`;
    }
  },

  refreshDiagnostics() {
    const container = document.getElementById('td-diagnostics');
    if (!container || !PA.API?.getDiagnostics) return;
    const diagnostics = PA.API.getDiagnostics();
    const lastRequest = diagnostics.lastRequest
      ? `${diagnostics.lastRequest.provider || 'Unknown'} ${diagnostics.lastRequest.endpoint} ${diagnostics.lastRequest.symbol || ''} at ${new Date(diagnostics.lastRequest.at).toLocaleTimeString()}`
      : 'None yet';
    const lastError = diagnostics.lastError
      ? `${diagnostics.lastError.message} (${new Date(diagnostics.lastError.at).toLocaleTimeString()})`
      : 'None';
    const endpoint = diagnostics.lastError?.context?.endpoint || diagnostics.lastError?.context?.scope || 'N/A';
    const backendVersion = diagnostics.backendHealth?.version || 'Unknown';
    const backendMismatch = diagnostics.backendHealth?.version && diagnostics.backendHealth.version !== PA.Config.APP_VERSION;
    const current = PA.Ticker?.current || null;
    const currentSummary = current?.summary || null;
    const currentQuote = current?.quote || null;
    const pctFieldMeta = field => {
      const sources = currentSummary?.providerFieldSources || currentQuote?.providerFieldSources || {};
      const units = currentSummary?.providerFieldUnits || currentQuote?.providerFieldUnits || {};
      if (!current) return 'N/A';
      return `${sources[field] || 'N/A'}${units[field] ? ` (${units[field]})` : ''}`;
    };

    container.innerHTML = `
      <div><strong>Build:</strong> ${PA.UI.escapeHtml(diagnostics.version || 'Unknown')}</div>
      <div><strong>Provider:</strong> ${PA.UI.escapeHtml(diagnostics.provider || 'Unknown')}</div>
      <div><strong>Backend URL:</strong> ${PA.UI.escapeHtml(diagnostics.backendUrl || 'Missing')}</div>
      <div><strong>Backend Version:</strong> ${PA.UI.escapeHtml(backendVersion)}</div>
      <div><strong>Backend Match:</strong> ${PA.UI.escapeHtml(backendMismatch ? 'No - restart the current batch backend' : 'Yes')}</div>
      <div><strong>Last Request:</strong> ${PA.UI.escapeHtml(lastRequest)}</div>
      <div><strong>Last Error:</strong> ${PA.UI.escapeHtml(lastError)}</div>
      <div><strong>Error Scope:</strong> ${PA.UI.escapeHtml(endpoint)}</div>
      <div><strong>Current Ticker:</strong> ${PA.UI.escapeHtml(current?.ticker || 'None')}</div>
      <div><strong>Yield Field:</strong> ${PA.UI.escapeHtml(pctFieldMeta('trailingAnnualDividendYield'))}</div>
      <div><strong>NAV Field:</strong> ${PA.UI.escapeHtml(pctFieldMeta('navPrice'))}</div>
      <div><strong>Expense Ratio Field:</strong> ${PA.UI.escapeHtml(pctFieldMeta('expenseRatio'))}</div>
      <div><strong>Turnover Field:</strong> ${PA.UI.escapeHtml(pctFieldMeta('portfolioTurnover'))}</div>
      <div><strong>YTD Return Field:</strong> ${PA.UI.escapeHtml(pctFieldMeta('ytdReturn'))}</div>
      <div><strong>1Y Return Field:</strong> ${PA.UI.escapeHtml(pctFieldMeta('oneYearReturn'))}</div>
      <div><strong>Displayed Return Source:</strong> ${PA.UI.escapeHtml(currentSummary?.performance?.returnMethod ? `${currentSummary.performance.returnMethod} (${currentSummary.performance.returnSource || 'yfinance'})` : 'N/A')}</div>
    `;
  },

  saveBackendConfig() {
    const input = document.getElementById('backend-url');
    PA.API.setBackendUrl(input?.value || '');
    PA.API.cache.clear();
    document.getElementById('status-text').textContent = PA.API.getBackendUrl()
      ? 'Backend configured - click Test Backend'
      : 'Add backend URL in Settings';
    PA.UI.toast('Backend saved', 'success');
    this.refreshDiagnostics();
    PA.Dashboard.init();
  },

  async testBackend() {
    try {
      const health = await PA.API.fetchBackendJson('health');
      if (!health?.ok) throw new Error('Backend health check did not return ok=true.');
      PA.API.lastBackendHealth = health;
      if (health?.version && health.version !== PA.Config.APP_VERSION) {
        throw new Error(`Backend version mismatch: frontend is ${PA.Config.APP_VERSION} but backend is ${health.version}. Restart the backend for this batch.`);
      }
      const quotes = await PA.API.getQuote(['NVDA']);
      const quote = quotes?.[0];
      if (!quote?.regularMarketPrice) throw new Error('Backend quote test returned no NVDA price.');
      const histories = await PA.API.getHistories(['DGS10', 'SP500'], '1Y');
      const dgs10History = PA.API.parseHistory(histories?.DGS10);
      const sp500History = PA.API.parseHistory(histories?.SP500);
      if ((dgs10History?.dates || []).length < 20 || (sp500History?.dates || []).length < 20) {
        throw new Error('Backend history test returned too little canonical/fallback history for DGS10 or SP500.');
      }
      const describeHistory = history => {
        const fallback = history?.providerFallbackLabel || '';
        const provider = history?.providerSource || 'unknown';
        const symbol = history?.providerSeriesId || history?.providerSymbol || history?.ticker || '';
        return fallback || `${provider}${symbol ? ` ${symbol}` : ''}`;
      };
      const sourceSummary = `DGS10: ${describeHistory(dgs10History)} | SP500: ${describeHistory(sp500History)}`;
      document.getElementById('status-text').textContent = 'Ready (local market-data backend running)';
      document.getElementById('status-dot').className = 'status-dot online';
      PA.UI.toast(`Backend test passed: NVDA ${PA.Fmt.currency(quote.regularMarketPrice)} plus ${sourceSummary}`, 'success');
    } catch (e) {
      document.getElementById('status-text').textContent = 'Backend offline - start backend\\start-backend.ps1';
      document.getElementById('status-dot').className = 'status-dot offline';
      PA.UI.toast(`Backend test failed: ${PA.UI.errorText(e)}`, 'error');
    } finally {
      this.refreshDiagnostics();
    }
  },

  clearBackendConfig() {
    PA.API.setBackendUrl('');
    PA.API.cache.clear();
    const input = document.getElementById('backend-url');
    if (input) input.value = '';
    document.getElementById('status-text').textContent = 'Add backend URL in Settings';
    PA.UI.toast('Backend cleared', 'info');
    this.refreshDiagnostics();
  },

  clearDiagnostics() {
    PA.API.clearDiagnostics();
    this.refreshDiagnostics();
    PA.UI.toast('Diagnostics cleared', 'info');
  },

  exportDb() { PA.DB.exportFile(); PA.UI.toast('Database exported', 'success'); },

  clearCache() {
    PA.API.cache.clear();
    PA.UI.toast('Cache cleared', 'info');
    this.refreshDiagnostics();
  },

  clearAllData() {
    if (confirm('Delete all saved data? This cannot be undone.')) {
      localStorage.removeItem('pa_db');
      localStorage.removeItem('pa_backend_url');
      location.reload();
    }
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => PA.App.init());
