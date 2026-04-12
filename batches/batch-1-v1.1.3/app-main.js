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
          // Search DB first
          const local = PA.DB.selectAll(`SELECT ticker,name,exchange FROM securities WHERE ticker LIKE ? OR name LIKE ? LIMIT 5`,
            [`%${q}%`, `%${q}%`]);
          const results = [];
          const seen = new Set();
          [
            { symbol: q.toUpperCase(), shortname: 'Lookup ticker directly', exchange: 'Direct' },
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
      PA.Dashboard.init();

      PA.UI.showTab('dashboard');
      document.getElementById('status-text').textContent = PA.API.getApiKey()
        ? 'Ready (Twelve Data)'
        : 'Add Twelve Data API key in Settings';
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
    settingsGrid.insertAdjacentHTML('afterbegin', `
      <div class="card" id="td-settings-card">
        <div class="card-title">Twelve Data API</div>
        <div class="form-group">
          <label class="form-label">API Key</label>
          <input class="form-input" id="td-api-key" type="password" placeholder="Paste your Twelve Data API key">
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
          <button class="btn btn-primary" onclick="PA.App.saveApiKey()">Save Key</button>
          <button class="btn" onclick="PA.App.testApiKey()">Test API</button>
          <button class="btn" onclick="PA.App.clearApiKey()">Clear</button>
        </div>
        <div style="margin-top:10px;font-size:0.8rem;color:var(--text-muted)">
          Get a free key from https://twelvedata.com/pricing
        </div>
        <div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">
          Free keys are limited to 8 credits per minute. Search suggestions use direct symbol entry only to conserve credits.
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
    const input = document.getElementById('td-api-key');
    if (input) input.value = PA.API.getApiKey();
    this.refreshDiagnostics();
  },

  refreshDiagnostics() {
    const container = document.getElementById('td-diagnostics');
    if (!container || !PA.API?.getDiagnostics) return;
    const diagnostics = PA.API.getDiagnostics();
    const lastRequest = diagnostics.lastRequest
      ? `${diagnostics.lastRequest.endpoint} ${diagnostics.lastRequest.symbol || ''} at ${new Date(diagnostics.lastRequest.at).toLocaleTimeString()}`
      : 'None yet';
    const lastError = diagnostics.lastError
      ? `${diagnostics.lastError.message} (${new Date(diagnostics.lastError.at).toLocaleTimeString()})`
      : 'None';
    const endpoint = diagnostics.lastError?.context?.endpoint || diagnostics.lastError?.context?.scope || 'N/A';

    container.innerHTML = `
      <div><strong>Build:</strong> ${PA.UI.escapeHtml(diagnostics.version || 'Unknown')}</div>
      <div><strong>Provider:</strong> ${PA.UI.escapeHtml(diagnostics.provider || 'Unknown')}</div>
      <div><strong>API Key:</strong> ${diagnostics.hasApiKey ? 'Detected' : 'Missing'}</div>
      <div><strong>Last Request:</strong> ${PA.UI.escapeHtml(lastRequest)}</div>
      <div><strong>Last Error:</strong> ${PA.UI.escapeHtml(lastError)}</div>
      <div><strong>Error Scope:</strong> ${PA.UI.escapeHtml(endpoint)}</div>
    `;
  },

  saveApiKey() {
    const input = document.getElementById('td-api-key');
    PA.API.setApiKey(input?.value || '');
    PA.API.cache.clear();
    document.getElementById('status-text').textContent = PA.API.getApiKey()
      ? 'Ready (Twelve Data)'
      : 'Add Twelve Data API key in Settings';
    PA.UI.toast('Twelve Data API key saved', 'success');
    this.refreshDiagnostics();
    PA.Dashboard.init();
  },

  async testApiKey() {
    try {
      const quotes = await PA.API.getQuote(['NVDA']);
      const quote = quotes?.[0];
      if (!quote) {
        throw new Error('API test returned no NVDA quote data.');
      }
      PA.UI.toast(`API test passed: NVDA ${PA.Fmt.currency(quote.regularMarketPrice)}`, 'success');
    } catch (e) {
      PA.UI.toast(`API test failed: ${PA.UI.errorText(e)}`, 'error');
    } finally {
      this.refreshDiagnostics();
    }
  },

  clearApiKey() {
    PA.API.setApiKey('');
    PA.API.cache.clear();
    const input = document.getElementById('td-api-key');
    if (input) input.value = '';
    document.getElementById('status-text').textContent = 'Add Twelve Data API key in Settings';
    PA.UI.toast('API key cleared', 'info');
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
      localStorage.removeItem('pa_twelve_data_key');
      localStorage.removeItem('pa_alpha_vantage_key');
      location.reload();
    }
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => PA.App.init());
