/* ============================================================
   Portfolio Analyzer Pro - Main App Controller
   ============================================================ */
PA.App = {
  async init() {
    try {
      document.getElementById('status-text').textContent = 'Initializing database...';
      await PA.DB.init();
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
          const results = await PA.API.search(q);
          if (results.length === 0) { dropdown.classList.remove('active'); return; }
          dropdown.innerHTML = results.slice(0,8).map(r =>
            '<div class="search-item" onclick="PA.App.selectTicker(\'' + r.symbol + '\')">' +
            '<div><span class="ticker">' + r.symbol + '</span> <span class="name">' + (r.shortname||'') + '</span></div>' +
            '<span class="exchange">' + (r.exchange||'') + '</span></div>'
          ).join('');
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

      // Update API key display in settings
      this.updateApiKeyDisplay();

      // Show data mode in status bar
      const mode = PA.API.hasApiKey() ? 'Live Data (FMP)' : 'Demo Mode';
      document.getElementById('status-text').textContent = 'Ready - ' + mode;

      PA.UI.showTab('dashboard');
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

  exportDb() { PA.DB.exportFile(); PA.UI.toast('Database exported', 'success'); },

  clearCache() {
    PA.API.cache.clear();
    PA.UI.toast('Cache cleared', 'info');
  },

  clearAllData() {
    if (confirm('Delete all saved data? This cannot be undone.')) {
      localStorage.removeItem('pa_db');
      localStorage.removeItem('pa_fmp_key');
      location.reload();
    }
  },

  saveApiKey() {
    const input = document.getElementById('api-key-input');
    const key = input ? input.value.trim() : '';
    if (key) {
      PA.Config.setApiKey(key);
      PA.API.cache.clear();
      PA.UI.toast('API key saved! You now have access to live data for any ticker.', 'success');
      this.updateApiKeyDisplay();
      document.getElementById('status-text').textContent = 'Ready - Live Data (FMP)';
    } else {
      PA.UI.toast('Please enter an API key', 'error');
    }
  },

  removeApiKey() {
    PA.Config.FMP_KEY = '';
    localStorage.removeItem('pa_fmp_key');
    PA.API.cache.clear();
    PA.UI.toast('API key removed. Using demo data.', 'info');
    this.updateApiKeyDisplay();
    document.getElementById('status-text').textContent = 'Ready - Demo Mode';
  },

  updateApiKeyDisplay() {
    const statusEl = document.getElementById('api-key-status');
    if (!statusEl) return;
    if (PA.API.hasApiKey()) {
      const key = PA.Config.getApiKey();
      statusEl.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--green-bg);border:1px solid var(--green);border-radius:var(--radius)">' +
        '<span class="status-dot online"></span>' +
        '<span style="color:var(--green);font-weight:600">Live Mode</span>' +
        '<span style="color:var(--text-muted);font-size:0.8rem">Key: ' + key.substring(0,6) + '...</span>' +
        '<button class="btn btn-sm" onclick="PA.App.removeApiKey()" style="margin-left:auto">Remove Key</button></div>';
    } else {
      statusEl.innerHTML =
        '<div style="padding:8px 12px;background:var(--red-bg);border:1px solid var(--red);border-radius:var(--radius);color:var(--red);font-size:0.85rem">' +
        '<strong>Demo Mode</strong> - Using sample data for 28 popular tickers. Add a free API key below for live data on any ticker.</div>';
    }
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => PA.App.init());
