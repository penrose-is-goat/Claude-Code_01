/* ============================================================
   Portfolio Analyzer Pro - Core JavaScript
   ============================================================ */
const PA = window.PA = {};

/* ---- Config ---- */
PA.Config = {
  FMP_BASE: 'https://financialmodelingprep.com/api/v3',
  FMP_KEY: '', // Set via settings
  RISK_FREE: 0.05,
  COLORS: ['#4f8ff7','#34d399','#f87171','#fbbf24','#a78bfa','#fb923c','#22d3ee','#f472b6','#84cc16','#e879f9'],
  RANGE_DAYS: { '1M':30, '3M':90, '6M':180, 'YTD':0, '1Y':365, '3Y':1095, '5Y':1825, '10Y':3650, 'MAX':9999 },
  getApiKey() {
    if (this.FMP_KEY) return this.FMP_KEY;
    try { const s = localStorage.getItem('pa_fmp_key'); if (s) { this.FMP_KEY = s; return s; } } catch(e){}
    return '';
  },
  setApiKey(key) {
    this.FMP_KEY = key;
    try { localStorage.setItem('pa_fmp_key', key); } catch(e){}
  }
};

/* ---- Database ---- */
PA.DB = {
  db: null,
  async init() {
    const SQL = await initSqlJs({ locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${f}` });
    // Try to load from localStorage
    const saved = localStorage.getItem('pa_db');
    if (saved) {
      const buf = Uint8Array.from(atob(saved), c => c.charCodeAt(0));
      this.db = new SQL.Database(buf);
    } else {
      this.db = new SQL.Database();
    }
    this.runSchema();
    return this.db;
  },
  runSchema() {
    this.db.run(`CREATE TABLE IF NOT EXISTS securities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT UNIQUE NOT NULL, name TEXT,
      sector TEXT, industry TEXT, exchange TEXT, asset_type TEXT DEFAULT 'equity',
      currency TEXT DEFAULT 'USD', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, price REAL,
      open_price REAL, high REAL, low REAL, close_price REAL, prev_close REAL,
      volume INTEGER, avg_volume INTEGER, market_cap REAL, beta REAL,
      pe_ratio REAL, fwd_pe_ratio REAL, eps REAL, fwd_eps REAL,
      dividend_yield REAL, dividend_rate REAL, ex_dividend_date TEXT,
      fifty_two_week_high REAL, fifty_two_week_low REAL, fifty_day_avg REAL,
      two_hundred_day_avg REAL, shares_outstanding REAL, book_value REAL,
      price_to_book REAL, fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS greeks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL,
      alpha REAL, beta REAL, delta REAL, gamma REAL,
      sharpe_ratio REAL, sortino_ratio REAL, treynor_ratio REAL,
      r_squared REAL, std_dev REAL, max_drawdown REAL,
      calc_period TEXT DEFAULT '1Y',
      calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL,
      date TEXT NOT NULL, open_price REAL, high REAL, low REAL,
      close_price REAL, adj_close REAL, volume INTEGER,
      UNIQUE(ticker, date))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      description TEXT, benchmark TEXT DEFAULT 'SPY',
      initial_balance REAL DEFAULT 10000, start_date TEXT, end_date TEXT,
      rebalance_frequency TEXT DEFAULT 'monthly',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS portfolio_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio_id INTEGER NOT NULL,
      ticker TEXT NOT NULL, allocation REAL NOT NULL, shares REAL,
      cost_basis REAL, added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL UNIQUE,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP, notes TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // Seed popular tickers
    const seeds = [
      ['SPY','SPDR S&P 500 ETF','Index Fund','NYSE','etf'],
      ['QQQ','Invesco QQQ Trust','Index Fund','NASDAQ','etf'],
      ['DIA','SPDR Dow Jones ETF','Index Fund','NYSE','etf'],
      ['IWM','iShares Russell 2000 ETF','Index Fund','NYSE','etf'],
      ['VTI','Vanguard Total Stock Market','Index Fund','NYSE','etf'],
      ['VOO','Vanguard S&P 500 ETF','Index Fund','NYSE','etf'],
      ['BND','Vanguard Total Bond Market','Fixed Income','NYSE','etf'],
      ['GLD','SPDR Gold Shares','Commodities','NYSE','etf'],
      ['AAPL','Apple Inc.','Technology','NASDAQ','equity'],
      ['MSFT','Microsoft Corporation','Technology','NASDAQ','equity'],
      ['GOOGL','Alphabet Inc.','Technology','NASDAQ','equity'],
      ['AMZN','Amazon.com Inc.','Consumer Cyclical','NASDAQ','equity'],
      ['NVDA','NVIDIA Corporation','Technology','NASDAQ','equity'],
      ['META','Meta Platforms Inc.','Technology','NASDAQ','equity'],
      ['TSLA','Tesla Inc.','Consumer Cyclical','NASDAQ','equity'],
      ['JPM','JPMorgan Chase & Co.','Financial Services','NYSE','equity'],
      ['V','Visa Inc.','Financial Services','NYSE','equity'],
      ['JNJ','Johnson & Johnson','Healthcare','NYSE','equity'],
      ['WMT','Walmart Inc.','Consumer Defensive','NYSE','equity'],
      ['XOM','Exxon Mobil Corp.','Energy','NYSE','equity'],
      ['PG','Procter & Gamble','Consumer Defensive','NYSE','equity'],
      ['HD','Home Depot Inc.','Consumer Cyclical','NYSE','equity'],
      ['BAC','Bank of America','Financial Services','NYSE','equity'],
      ['MA','Mastercard Inc.','Financial Services','NYSE','equity'],
      ['UNH','UnitedHealth Group','Healthcare','NYSE','equity']
    ];
    seeds.forEach(s => {
      this.db.run(`INSERT OR IGNORE INTO securities(ticker,name,sector,exchange,asset_type) VALUES(?,?,?,?,?)`, s);
    });
  },
  exec(sql, params=[]) { return this.db.run(sql, params); },
  selectAll(sql, params=[]) {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },
  selectOne(sql, params=[]) {
    const rows = this.selectAll(sql, params);
    return rows.length ? rows[0] : null;
  },
  save() {
    try {
      const data = this.db.export();
      const b64 = btoa(String.fromCharCode(...data));
      localStorage.setItem('pa_db', b64);
    } catch(e) { console.warn('DB save failed:', e); }
  },
  exportFile() {
    const data = this.db.export();
    const blob = new Blob([data], {type:'application/x-sqlite3'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'portfolio_analyzer.db';
    a.click();
  }
};

/* ---- API (Financial Modeling Prep + Sample Data Fallback) ---- */
PA.API = {
  cache: new Map(),
  CACHE_TTL: 120000,
  getCached(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.ts < this.CACHE_TTL) return item.data;
    return null;
  },
  setCache(key, data) { this.cache.set(key, { data, ts: Date.now() }); },

  hasApiKey() { return !!PA.Config.getApiKey(); },

  async fmpFetch(endpoint) {
    const key = PA.Config.getApiKey();
    if (!key) throw new Error('NO_API_KEY');
    const url = `${PA.Config.FMP_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${key}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (resp.status === 401 || resp.status === 403) throw new Error('INVALID_API_KEY');
    if (resp.status === 429) throw new Error('RATE_LIMITED');
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return await resp.json();
  },

  // Get quote for one or more tickers (FMP returns array)
  async getQuote(tickers) {
    const tickerStr = tickers.join(',');
    const key = 'quote:' + tickerStr;
    let cached = this.getCached(key);
    if (cached) return cached;
    if (!this.hasApiKey()) return tickers.map(t => PA.SampleData.getQuote(t)).filter(Boolean);
    try {
      const data = await this.fmpFetch(`/quote/${tickerStr}`);
      const result = Array.isArray(data) ? data : [];
      // Normalize FMP fields to our standard format
      const normalized = result.map(q => ({
        symbol: q.symbol,
        shortName: q.name,
        longName: q.name,
        exchange: q.exchange,
        currency: 'USD',
        marketState: q.marketCap ? 'REGULAR' : 'CLOSED',
        regularMarketPrice: q.price,
        regularMarketChange: q.change,
        regularMarketChangePercent: q.changesPercentage,
        regularMarketVolume: q.volume,
        regularMarketOpen: q.open,
        regularMarketDayHigh: q.dayHigh,
        regularMarketDayLow: q.dayLow,
        regularMarketPreviousClose: q.previousClose,
        marketCap: q.marketCap,
        beta: q.beta || null,
        trailingPE: q.pe,
        forwardPE: q.forwardPE || null,
        epsTrailingTwelveMonths: q.eps,
        epsForward: null,
        trailingAnnualDividendYield: q.dividendYield ? q.dividendYield / 100 : null,
        fiftyTwoWeekHigh: q.yearHigh,
        fiftyTwoWeekLow: q.yearLow,
        fiftyDayAverage: q.priceAvg50,
        twoHundredDayAverage: q.priceAvg200,
        sharesOutstanding: q.sharesOutstanding,
        bookValue: null,
        priceToBook: null,
        averageDailyVolume3Month: q.avgVolume
      }));
      this.setCache(key, normalized);
      return normalized;
    } catch(e) {
      if (e.message === 'NO_API_KEY') return tickers.map(t => PA.SampleData.getQuote(t)).filter(Boolean);
      throw e;
    }
  },

  // Get detailed profile/stats
  async getProfile(ticker) {
    const key = 'profile:' + ticker;
    let cached = this.getCached(key);
    if (cached) return cached;
    if (!this.hasApiKey()) return null;
    try {
      const data = await this.fmpFetch(`/profile/${ticker}`);
      const result = Array.isArray(data) && data[0] ? data[0] : null;
      if (result) this.setCache(key, result);
      return result;
    } catch(e) { return null; }
  },

  // Get key metrics (P/E, fwd P/E, book value, etc)
  async getKeyMetrics(ticker) {
    const key = 'metrics:' + ticker;
    let cached = this.getCached(key);
    if (cached) return cached;
    if (!this.hasApiKey()) return null;
    try {
      const data = await this.fmpFetch(`/key-metrics-ttm/${ticker}`);
      const result = Array.isArray(data) && data[0] ? data[0] : null;
      if (result) this.setCache(key, result);
      return result;
    } catch(e) { return null; }
  },

  // Get historical prices
  async getHistory(ticker, rangeKey='1Y') {
    const cacheKey = `hist:${ticker}:${rangeKey}`;
    let cached = this.getCached(cacheKey);
    if (cached) return cached;
    if (!this.hasApiKey()) {
      const sample = PA.SampleData.getHistory(ticker, rangeKey);
      if (sample) return sample;
      return { dates:[], prices:[], volumes:[] };
    }
    try {
      const days = PA.Config.RANGE_DAYS[rangeKey] || 365;
      let endpoint;
      if (rangeKey === 'YTD') {
        const yr = new Date().getFullYear();
        endpoint = `/historical-price-full/${ticker}?from=${yr}-01-01`;
      } else if (days > 1825) {
        endpoint = `/historical-price-full/${ticker}`;
      } else {
        const to = new Date();
        const from = new Date(to);
        from.setDate(from.getDate() - days);
        endpoint = `/historical-price-full/${ticker}?from=${from.toISOString().split('T')[0]}&to=${to.toISOString().split('T')[0]}`;
      }
      const data = await this.fmpFetch(endpoint);
      const historical = data?.historical || [];
      // FMP returns newest first, reverse to oldest first
      const sorted = historical.slice().reverse();
      const result = {
        dates: sorted.map(d => d.date),
        prices: sorted.map(d => d.adjClose ?? d.close),
        volumes: sorted.map(d => d.volume || 0)
      };
      this.setCache(cacheKey, result);
      return result;
    } catch(e) {
      if (e.message === 'NO_API_KEY') {
        const sample = PA.SampleData.getHistory(ticker, rangeKey);
        return sample || { dates:[], prices:[], volumes:[] };
      }
      throw e;
    }
  },

  // Search tickers
  async search(query) {
    if (!query || query.length < 1) return [];
    const key = 'search:' + query;
    let cached = this.getCached(key);
    if (cached) return cached;
    // Always search local DB first
    const local = PA.DB.selectAll(
      `SELECT ticker, name, exchange FROM securities WHERE ticker LIKE ? OR name LIKE ? LIMIT 8`,
      [`%${query}%`, `%${query}%`]
    ).map(r => ({ symbol: r.ticker, shortname: r.name, exchange: r.exchange }));
    if (!this.hasApiKey()) { this.setCache(key, local); return local; }
    try {
      const data = await this.fmpFetch(`/search?query=${encodeURIComponent(query)}&limit=8`);
      const remote = (Array.isArray(data) ? data : []).map(r => ({
        symbol: r.symbol, shortname: r.name, exchange: r.exchangeShortName || r.exchange || ''
      }));
      // Merge local + remote, deduplicate
      const seen = new Set();
      const merged = [];
      [...local, ...remote].forEach(r => {
        if (r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); merged.push(r); }
      });
      this.setCache(key, merged);
      return merged;
    } catch(e) { return local; }
  },

  // Legacy compat - parseHistory now just returns the data as-is since getHistory already normalizes
  parseHistory(result) {
    if (!result) return { dates:[], prices:[], volumes:[] };
    // Already in {dates, prices, volumes} format from getHistory
    if (result.dates) return result;
    // Legacy Yahoo format fallback
    return { dates:[], prices:[], volumes:[] };
  }
};

/* ---- Sample Data (works without any API key) ---- */
PA.SampleData = {
  // Generate realistic price history using geometric brownian motion
  _generatePrices(basePrice, annualReturn, annualVol, days) {
    const dt = 1/252;
    const drift = (annualReturn - 0.5*annualVol*annualVol)*dt;
    const diffusion = annualVol*Math.sqrt(dt);
    const prices = [basePrice];
    // Use seeded pseudo-random for consistency
    let seed = basePrice * 1000;
    const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const boxMuller = () => { const u1=rand(), u2=rand(); return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2); };
    for (let i = 1; i < days; i++) {
      const prev = prices[i-1];
      prices.push(prev * Math.exp(drift + diffusion * boxMuller()));
    }
    return prices.map(p => Math.round(p * 100) / 100);
  },

  _generateDates(days) {
    const dates = [];
    const d = new Date();
    d.setDate(d.getDate() - days);
    for (let i = 0; i < days; i++) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
  },

  _stockProfiles: {
    SPY:  { price:585, ret:0.10, vol:0.15, name:'SPDR S&P 500 ETF', beta:1.00, pe:23.5, fwdPe:21.2, cap:540e9, volume:75e6, yield:0.013, sector:'Index Fund', exchange:'NYSE' },
    QQQ:  { price:510, ret:0.15, vol:0.20, name:'Invesco QQQ Trust', beta:1.15, pe:31.2, fwdPe:27.8, cap:250e9, volume:45e6, yield:0.006, sector:'Index Fund', exchange:'NASDAQ' },
    DIA:  { price:425, ret:0.08, vol:0.14, name:'SPDR Dow Jones ETF', beta:0.95, pe:20.1, fwdPe:18.5, cap:35e9, volume:3.5e6, yield:0.017, sector:'Index Fund', exchange:'NYSE' },
    IWM:  { price:225, ret:0.07, vol:0.22, name:'iShares Russell 2000', beta:1.20, pe:26.8, fwdPe:22.1, cap:65e9, volume:25e6, yield:0.012, sector:'Index Fund', exchange:'NYSE' },
    VTI:  { price:290, ret:0.10, vol:0.15, name:'Vanguard Total Stock Market', beta:1.00, pe:24.1, fwdPe:21.5, cap:420e9, volume:4e6, yield:0.013, sector:'Index Fund', exchange:'NYSE' },
    VOO:  { price:540, ret:0.10, vol:0.15, name:'Vanguard S&P 500 ETF', beta:1.00, pe:23.5, fwdPe:21.2, cap:500e9, volume:5e6, yield:0.013, sector:'Index Fund', exchange:'NYSE' },
    BND:  { price:72,  ret:0.03, vol:0.05, name:'Vanguard Total Bond Market', beta:0.05, pe:null, fwdPe:null, cap:110e9, volume:7e6, yield:0.035, sector:'Fixed Income', exchange:'NYSE' },
    GLD:  { price:285, ret:0.08, vol:0.14, name:'SPDR Gold Shares', beta:0.05, pe:null, fwdPe:null, cap:75e9, volume:8e6, yield:0, sector:'Commodities', exchange:'NYSE' },
    TLT:  { price:92,  ret:0.02, vol:0.16, name:'iShares 20+ Year Treasury', beta:-0.30, pe:null, fwdPe:null, cap:55e9, volume:20e6, yield:0.038, sector:'Fixed Income', exchange:'NYSE' },
    AAPL: { price:235, ret:0.15, vol:0.25, name:'Apple Inc.', beta:1.21, pe:33.5, fwdPe:30.2, cap:3.6e12, volume:55e6, yield:0.005, sector:'Technology', exchange:'NASDAQ' },
    MSFT: { price:455, ret:0.18, vol:0.24, name:'Microsoft Corporation', beta:0.90, pe:37.2, fwdPe:32.1, cap:3.4e12, volume:22e6, yield:0.007, sector:'Technology', exchange:'NASDAQ' },
    GOOGL:{ price:185, ret:0.14, vol:0.26, name:'Alphabet Inc.', beta:1.08, pe:25.8, fwdPe:22.5, cap:2.3e12, volume:25e6, yield:0.005, sector:'Technology', exchange:'NASDAQ' },
    AMZN: { price:225, ret:0.20, vol:0.30, name:'Amazon.com Inc.', beta:1.15, pe:62.5, fwdPe:38.2, cap:2.3e12, volume:40e6, yield:0, sector:'Consumer Cyclical', exchange:'NASDAQ' },
    NVDA: { price:140, ret:0.35, vol:0.50, name:'NVIDIA Corporation', beta:1.65, pe:65.3, fwdPe:32.5, cap:3.4e12, volume:250e6, yield:0.0003, sector:'Technology', exchange:'NASDAQ' },
    META: { price:620, ret:0.22, vol:0.35, name:'Meta Platforms Inc.', beta:1.25, pe:28.5, fwdPe:23.8, cap:1.6e12, volume:15e6, yield:0.003, sector:'Technology', exchange:'NASDAQ' },
    TSLA: { price:350, ret:0.25, vol:0.55, name:'Tesla Inc.', beta:2.05, pe:95.2, fwdPe:65.0, cap:1.1e12, volume:90e6, yield:0, sector:'Consumer Cyclical', exchange:'NASDAQ' },
    JPM:  { price:255, ret:0.12, vol:0.22, name:'JPMorgan Chase & Co.', beta:1.10, pe:12.5, fwdPe:11.8, cap:735e9, volume:9e6, yield:0.021, sector:'Financial Services', exchange:'NYSE' },
    V:    { price:320, ret:0.14, vol:0.20, name:'Visa Inc.', beta:0.95, pe:32.1, fwdPe:27.5, cap:620e9, volume:6e6, yield:0.007, sector:'Financial Services', exchange:'NYSE' },
    JNJ:  { price:160, ret:0.06, vol:0.15, name:'Johnson & Johnson', beta:0.55, pe:22.8, fwdPe:15.2, cap:385e9, volume:7e6, yield:0.031, sector:'Healthcare', exchange:'NYSE' },
    WMT:  { price:95,  ret:0.10, vol:0.18, name:'Walmart Inc.', beta:0.52, pe:37.5, fwdPe:30.2, cap:640e9, volume:8e6, yield:0.010, sector:'Consumer Defensive', exchange:'NYSE' },
    XOM:  { price:112, ret:0.08, vol:0.25, name:'Exxon Mobil Corp.', beta:0.80, pe:14.2, fwdPe:13.5, cap:500e9, volume:14e6, yield:0.033, sector:'Energy', exchange:'NYSE' },
    PG:   { price:170, ret:0.07, vol:0.14, name:'Procter & Gamble', beta:0.42, pe:28.5, fwdPe:24.2, cap:400e9, volume:6e6, yield:0.024, sector:'Consumer Defensive', exchange:'NYSE' },
    HD:   { price:410, ret:0.12, vol:0.22, name:'Home Depot Inc.', beta:1.05, pe:26.3, fwdPe:23.8, cap:400e9, volume:4e6, yield:0.023, sector:'Consumer Cyclical', exchange:'NYSE' },
    BAC:  { price:45,  ret:0.10, vol:0.28, name:'Bank of America', beta:1.35, pe:13.2, fwdPe:11.5, cap:355e9, volume:35e6, yield:0.024, sector:'Financial Services', exchange:'NYSE' },
    MA:   { price:535, ret:0.15, vol:0.21, name:'Mastercard Inc.', beta:1.08, pe:38.5, fwdPe:31.2, cap:500e9, volume:3e6, yield:0.005, sector:'Financial Services', exchange:'NYSE' },
    UNH:  { price:520, ret:0.14, vol:0.22, name:'UnitedHealth Group', beta:0.65, pe:32.1, fwdPe:18.5, cap:480e9, volume:3.5e6, yield:0.015, sector:'Healthcare', exchange:'NYSE' },
    AGG:  { price:100, ret:0.025, vol:0.04, name:'iShares Core US Agg Bond', beta:0.03, pe:null, fwdPe:null, cap:95e9, volume:6e6, yield:0.033, sector:'Fixed Income', exchange:'NYSE' },
    VNQ:  { price:88,  ret:0.06, vol:0.20, name:'Vanguard Real Estate ETF', beta:0.85, pe:35.2, fwdPe:30.0, cap:35e9, volume:4e6, yield:0.038, sector:'Real Estate', exchange:'NYSE' }
  },

  getQuote(ticker) {
    const p = this._stockProfiles[ticker.toUpperCase()];
    if (!p) return null;
    const change = Math.round((Math.random() - 0.48) * p.price * 0.03 * 100) / 100;
    const changePct = (change / p.price) * 100;
    return {
      symbol: ticker.toUpperCase(),
      shortName: p.name,
      longName: p.name,
      exchange: p.exchange,
      currency: 'USD',
      marketState: 'REGULAR',
      regularMarketPrice: p.price,
      regularMarketChange: change,
      regularMarketChangePercent: changePct,
      regularMarketVolume: p.volume,
      regularMarketOpen: p.price - change * 0.3,
      regularMarketDayHigh: p.price + Math.abs(change) * 0.5,
      regularMarketDayLow: p.price - Math.abs(change) * 0.5,
      regularMarketPreviousClose: p.price - change,
      marketCap: p.cap,
      beta: p.beta,
      trailingPE: p.pe,
      forwardPE: p.fwdPe,
      epsTrailingTwelveMonths: p.pe ? p.price / p.pe : null,
      epsForward: p.fwdPe ? p.price / p.fwdPe : null,
      trailingAnnualDividendYield: p.yield,
      fiftyTwoWeekHigh: Math.round(p.price * 1.25 * 100) / 100,
      fiftyTwoWeekLow: Math.round(p.price * 0.78 * 100) / 100,
      fiftyDayAverage: Math.round(p.price * 0.98 * 100) / 100,
      twoHundredDayAverage: Math.round(p.price * 0.93 * 100) / 100,
      sharesOutstanding: p.cap / p.price,
      bookValue: null,
      priceToBook: null,
      averageDailyVolume3Month: p.volume,
      _isSampleData: true
    };
  },

  getHistory(ticker, rangeKey='1Y') {
    const p = this._stockProfiles[ticker.toUpperCase()];
    if (!p) return null;
    const rangeDays = PA.Config.RANGE_DAYS[rangeKey] || 365;
    const actualDays = rangeKey === 'YTD' ? Math.floor((new Date() - new Date(new Date().getFullYear(),0,1)) / 86400000) : Math.min(rangeDays, 2600);
    const dates = this._generateDates(actualDays);
    const prices = this._generatePrices(p.price * 0.75, p.ret, p.vol, dates.length);
    // Scale so last price ~ current price
    const scale = p.price / prices[prices.length - 1];
    const scaledPrices = prices.map(px => Math.round(px * scale * 100) / 100);
    const volumes = dates.map(() => Math.round(p.volume * (0.7 + Math.random() * 0.6)));
    return { dates, prices: scaledPrices, volumes };
  }
};

/* ---- Compute (Financial Math) ---- */
PA.Compute = {
  dailyReturns(prices) {
    const r = [];
    for (let i = 1; i < prices.length; i++) {
      r.push(prices[i] / prices[i-1] - 1);
    }
    return r;
  },
  logReturns(prices) {
    const r = [];
    for (let i = 1; i < prices.length; i++) {
      r.push(Math.log(prices[i] / prices[i-1]));
    }
    return r;
  },
  cumulativeReturns(prices) {
    const base = prices[0];
    return prices.map(p => p / base);
  },
  mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s,v) => s+v, 0) / arr.length;
  },
  stdDev(arr) {
    const m = this.mean(arr);
    const variance = arr.reduce((s,v) => s + (v-m)**2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  },
  annualizedReturn(prices, tradingDays=252) {
    if (prices.length < 2) return 0;
    const totalReturn = prices[prices.length-1] / prices[0];
    const years = (prices.length - 1) / tradingDays;
    return Math.pow(totalReturn, 1/years) - 1;
  },
  annualizedVolatility(returns, tradingDays=252) {
    return this.stdDev(returns) * Math.sqrt(tradingDays);
  },
  sharpeRatio(returns, rf=PA.Config.RISK_FREE, tradingDays=252) {
    const annRet = this.mean(returns) * tradingDays;
    const annVol = this.annualizedVolatility(returns, tradingDays);
    return annVol === 0 ? 0 : (annRet - rf) / annVol;
  },
  sortinoRatio(returns, rf=PA.Config.RISK_FREE, tradingDays=252) {
    const annRet = this.mean(returns) * tradingDays;
    const downside = returns.filter(r => r < 0);
    const downDev = downside.length ? this.stdDev(downside) * Math.sqrt(tradingDays) : 0;
    return downDev === 0 ? 0 : (annRet - rf) / downDev;
  },
  maxDrawdown(prices) {
    let peak = prices[0], maxDD = 0, peakIdx = 0, ddStart = 0, ddEnd = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > peak) { peak = prices[i]; peakIdx = i; }
      const dd = (peak - prices[i]) / peak;
      if (dd > maxDD) { maxDD = dd; ddStart = peakIdx; ddEnd = i; }
    }
    return { maxDD, ddStart, ddEnd };
  },
  drawdownSeries(prices) {
    let peak = prices[0];
    return prices.map(p => {
      if (p > peak) peak = p;
      return (p - peak) / peak;
    });
  },
  beta(stockReturns, marketReturns) {
    const n = Math.min(stockReturns.length, marketReturns.length);
    if (n < 2) return 1;
    const sR = stockReturns.slice(0, n), mR = marketReturns.slice(0, n);
    const mMean = this.mean(mR), sMean = this.mean(sR);
    let cov = 0, mVar = 0;
    for (let i = 0; i < n; i++) {
      cov += (sR[i]-sMean)*(mR[i]-mMean);
      mVar += (mR[i]-mMean)**2;
    }
    return mVar === 0 ? 1 : cov / mVar;
  },
  alpha(stockReturns, marketReturns, rf=PA.Config.RISK_FREE, tradingDays=252) {
    const b = this.beta(stockReturns, marketReturns);
    const sRet = this.mean(stockReturns) * tradingDays;
    const mRet = this.mean(marketReturns) * tradingDays;
    return sRet - (rf + b * (mRet - rf));
  },
  delta(stockPrices, marketPrices) {
    // Regression coefficient: stock price change per unit market change
    const sR = this.dailyReturns(stockPrices);
    const mR = this.dailyReturns(marketPrices);
    return this.beta(sR, mR); // Delta = regression beta
  },
  gamma(stockPrices, marketPrices, window=20) {
    // Rate of change of delta over rolling windows
    const sR = this.dailyReturns(stockPrices);
    const mR = this.dailyReturns(marketPrices);
    const deltas = [];
    for (let i = window; i <= sR.length; i++) {
      const sSub = sR.slice(i-window, i);
      const mSub = mR.slice(i-window, i);
      deltas.push(this.beta(sSub, mSub));
    }
    if (deltas.length < 2) return 0;
    const changes = this.dailyReturns(deltas.map((d,i) => d + 2)); // offset to avoid negatives
    return this.mean(changes);
  },
  correlation(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    const aArr = a.slice(0,n), bArr = b.slice(0,n);
    const aMean = this.mean(aArr), bMean = this.mean(bArr);
    let cov=0, aVar=0, bVar=0;
    for (let i=0; i<n; i++) {
      cov += (aArr[i]-aMean)*(bArr[i]-bMean);
      aVar += (aArr[i]-aMean)**2;
      bVar += (bArr[i]-bMean)**2;
    }
    const denom = Math.sqrt(aVar*bVar);
    return denom === 0 ? 0 : cov / denom;
  },
  rSquared(stockReturns, marketReturns) {
    const c = this.correlation(stockReturns, marketReturns);
    return c * c;
  },
  portfolioReturns(weights, returnArrays) {
    // weights: array of decimals summing to 1
    // returnArrays: array of arrays of daily returns (same length)
    const n = Math.min(...returnArrays.map(r => r.length));
    const pReturns = [];
    for (let i = 0; i < n; i++) {
      let dayReturn = 0;
      for (let j = 0; j < weights.length; j++) {
        dayReturn += weights[j] * (returnArrays[j]?.[i] || 0);
      }
      pReturns.push(dayReturn);
    }
    return pReturns;
  },
  growthOf(initialValue, returns) {
    const growth = [initialValue];
    for (const r of returns) {
      growth.push(growth[growth.length-1] * (1 + r));
    }
    return growth;
  },
  monthlyReturns(dates, prices) {
    const monthly = {};
    for (let i = 0; i < dates.length; i++) {
      const ym = dates[i].substring(0,7);
      if (!monthly[ym]) monthly[ym] = { first: prices[i], last: prices[i] };
      monthly[ym].last = prices[i];
    }
    const result = [];
    const keys = Object.keys(monthly).sort();
    for (let i = 1; i < keys.length; i++) {
      result.push({
        month: keys[i],
        return: (monthly[keys[i]].last / monthly[keys[i-1]].last) - 1
      });
    }
    return result;
  },
  rollingReturns(prices, window) {
    const result = [];
    for (let i = window; i < prices.length; i++) {
      result.push(prices[i] / prices[i - window] - 1);
    }
    return result;
  }
};

/* ---- Formatting Utilities ---- */
PA.Fmt = {
  currency(v, dec=2) {
    if (v == null || isNaN(v)) return 'N/A';
    return '$' + Number(v).toLocaleString('en-US', {minimumFractionDigits:dec, maximumFractionDigits:dec});
  },
  pct(v, dec=2) {
    if (v == null || isNaN(v)) return 'N/A';
    return (v * 100).toFixed(dec) + '%';
  },
  pctRaw(v, dec=2) {
    if (v == null || isNaN(v)) return 'N/A';
    return Number(v).toFixed(dec) + '%';
  },
  number(v, dec=2) {
    if (v == null || isNaN(v)) return 'N/A';
    return Number(v).toLocaleString('en-US', {minimumFractionDigits:dec, maximumFractionDigits:dec});
  },
  compact(v) {
    if (v == null || isNaN(v)) return 'N/A';
    const abs = Math.abs(v);
    if (abs >= 1e12) return (v/1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return (v/1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (v/1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (v/1e3).toFixed(1) + 'K';
    return v.toFixed(2);
  },
  ratio(v, dec=2) {
    if (v == null || isNaN(v)) return 'N/A';
    return Number(v).toFixed(dec);
  },
  colorClass(v) {
    if (v == null || isNaN(v)) return '';
    return v >= 0 ? 'positive' : 'negative';
  }
};
