/* ============================================================
   Portfolio Analyzer Pro - Main App Controller
   ============================================================ */
PA.App = {
  async init() {
    try {
      document.getElementById('status-text').textContent = 'Initializing database...';
      await PA.DB.init();
      this.injectApiSettings();
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
          const remote = q.length >= 2 ? await PA.API.search(q) : [];
          const results = [];
          const seen = new Set();
          [
            { symbol: q.toUpperCase(), shortname: 'Lookup ticker directly', exchange: 'Direct' },
            ...local.map(l => ({symbol:l.ticker, shortname:l.name, exchange:l.exchange})),
            ...remote.map(r => ({symbol:r.symbol, shortname:r.shortname || r.longname || '', exchange:r.exchange || ''}))
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
      document.getElementById('status-text').textContent = 'Init error: ' + e.message;
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
      </div>
    `);
    const input = document.getElementById('td-api-key');
    if (input) input.value = PA.API.getApiKey();
  },

  saveApiKey() {
    const input = document.getElementById('td-api-key');
    PA.API.setApiKey(input?.value || '');
    PA.API.cache.clear();
    document.getElementById('status-text').textContent = PA.API.getApiKey()
      ? 'Ready (Twelve Data)'
      : 'Add Twelve Data API key in Settings';
    PA.UI.toast('Twelve Data API key saved', 'success');
    PA.Dashboard.init();
  },

  async testApiKey() {
    try {
      const [quotes, hist] = await Promise.all([
        PA.API.getQuote(['NVDA']),
        PA.API.getHistory('NVDA', '1Y')
      ]);
      const quote = quotes?.[0];
      const points = PA.API.parseHistory(hist).prices.length;
      if (!quote || points < 5) {
        throw new Error('API test returned incomplete NVDA data.');
      }
      PA.UI.toast(`API test passed: NVDA ${PA.Fmt.currency(quote.regularMarketPrice)} with ${points} history points`, 'success');
    } catch (e) {
      PA.UI.toast(`API test failed: ${e.message}`, 'error');
    }
  },

  clearApiKey() {
    PA.API.setApiKey('');
    PA.API.cache.clear();
    const input = document.getElementById('td-api-key');
    if (input) input.value = '';
    document.getElementById('status-text').textContent = 'Add Twelve Data API key in Settings';
    PA.UI.toast('API key cleared', 'info');
  },

  exportDb() { PA.DB.exportFile(); PA.UI.toast('Database exported', 'success'); },

  clearCache() {
    PA.API.cache.clear();
    PA.UI.toast('Cache cleared', 'info');
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
