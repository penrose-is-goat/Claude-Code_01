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
          // Search DB first
          const local = PA.DB.selectAll(`SELECT ticker,name,exchange FROM securities WHERE ticker LIKE ? OR name LIKE ? LIMIT 5`,
            [`%${q}%`, `%${q}%`]);
          // Search API
          const remote = await PA.API.search(q);
          const results = [];
          const seen = new Set();
          [...local.map(l => ({symbol:l.ticker, shortname:l.name, exchange:l.exchange})),
           ...(remote||[]).map(r => ({symbol:r.symbol, shortname:r.shortname||r.longname||'', exchange:r.exchange||''}))
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
      document.getElementById('status-text').textContent = 'Ready';
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
      location.reload();
    }
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => PA.App.init());
