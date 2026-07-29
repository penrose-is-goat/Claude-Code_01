/* ============================================================
   Portfolio Analyzer Pro - Core JavaScript
   ============================================================ */
const PA = window.PA = {};

/* ---- Config ---- */
PA.Config = {
  FINNHUB_BASE: 'https://finnhub.io/api/v1',
  API_KEY: '',
  RISK_FREE: 0.05,
  COLORS: ['#4f8ff7','#34d399','#f87171','#fbbf24','#a78bfa','#fb923c','#22d3ee','#f472b6','#84cc16','#e879f9'],
  RANGE_DAYS: { '1M':30, '3M':90, '6M':180, 'YTD':0, '1Y':365, '3Y':1095, '5Y':1825, '10Y':3650, 'MAX':9999 },
  getApiKey() {
    if (this.API_KEY) return this.API_KEY;
    try { const s = localStorage.getItem('pa_api_key'); if (s) { this.API_KEY = s; return s; } } catch(e){}
    return '';
  },
  setApiKey(key) {
    this.API_KEY = key;
    try { localStorage.setItem('pa_api_key', key); } catch(e){}
  }
};

/* ---- Database ---- */
PA.DB = {
  db: null,
  async init() {
    const SQL = await initSqlJs({ locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${f}` });
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
      ['UNH','UnitedHealth Group','Healthcare','NYSE','equity'],
      ['AGG','iShares Core US Agg Bond','Fixed Income','NYSE','etf'],
      ['VNQ','Vanguard Real Estate ETF','Real Estate','NYSE','etf'],
      ['TLT','iShares 20+ Year Treasury','Fixed Income','NYSE','etf']
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

/* ---- API (Finnhub - CORS-friendly, 60 calls/min free) ---- */
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

  async finnhubFetch(endpoint) {
    const key = PA.Config.getApiKey();
    if (!key) throw new Error('NO_API_KEY');
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = PA.Config.FINNHUB_BASE + endpoint + sep + 'token=' + key;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (resp.status === 401 || resp.status === 403) throw new Error('INVALID_API_KEY');
    if (resp.status === 429) throw new Error('RATE_LIMITED');
    if (!resp.ok) throw new Error('API error: ' + resp.status);
    return await resp.json();
  },

  async getQuote(tickers) {
    // Finnhub only supports single-ticker quotes, so fetch in parallel
    const results = await Promise.all(tickers.map(async (ticker) => {
      const cacheKey = 'quote:' + ticker;
      let cached = this.getCached(cacheKey);
      if (cached) return cached;

      if (!this.hasApiKey()) {
        return PA.SampleData.getQuote(ticker);
      }

      try {
        // Fetch quote, profile, and metrics in parallel
        const [quote, profile, metrics] = await Promise.all([
          this.finnhubFetch('/quote?symbol=' + ticker),
          this.finnhubFetch('/stock/profile2?symbol=' + ticker).catch(() => null),
          this.finnhubFetch('/stock/metric?symbol=' + ticker + '&metric=all').catch(() => null)
        ]);

        if (!quote || quote.c === 0) return null;

        const m = metrics?.metric || {};
        const normalized = {
          symbol: ticker,
          shortName: profile?.name || ticker,
          longName: profile?.name || '',
          exchange: profile?.exchange || '',
          currency: profile?.currency || 'USD',
          marketState: 'REGULAR',
          regularMarketPrice: quote.c,
          regularMarketChange: quote.d || 0,
          regularMarketChangePercent: quote.dp || 0,
          regularMarketVolume: m.tenDayAverageTradingVolume ? Math.round(m.tenDayAverageTradingVolume * 1e6) : null,
          regularMarketOpen: quote.o,
          regularMarketDayHigh: quote.h,
          regularMarketDayLow: quote.l,
          regularMarketPreviousClose: quote.pc,
          marketCap: profile?.marketCapitalization ? profile.marketCapitalization * 1e6 : null,
          beta: m.beta || null,
          trailingPE: m.peBasicExclExtraTTM || m.peExclExtraTTM || null,
          forwardPE: m.forwardPE || m.peExclExtraAnnual || null,
          epsTrailingTwelveMonths: m.epsBasicExclExtraItemsTTM || null,
          epsForward: m.epsEstimateNextQuarter || null,
          trailingAnnualDividendYield: m.dividendYieldIndicatedAnnual ? m.dividendYieldIndicatedAnnual / 100 : null,
          fiftyTwoWeekHigh: m['52WeekHigh'] || quote.h,
          fiftyTwoWeekLow: m['52WeekLow'] || quote.l,
          fiftyDayAverage: m['10DayAverageTradingVolume'] || null,
          twoHundredDayAverage: null,
          sharesOutstanding: profile?.shareOutstanding ? profile.shareOutstanding * 1e6 : null,
          bookValue: m.bookValuePerShareQuarterly || null,
          priceToBook: m.pbQuarterly || null,
          averageDailyVolume3Month: m.threeMonthAverageTradingVolume ? Math.round(m.threeMonthAverageTradingVolume * 1e6) : null,
          _isSampleData: false
        };
        this.setCache(cacheKey, normalized);
        return normalized;
      } catch(e) {
        if (e.message === 'NO_API_KEY') return PA.SampleData.getQuote(ticker);
        throw e;
      }
    }));
    return results.filter(Boolean);
  },

  async getHistory(ticker, rangeKey) {
    rangeKey = rangeKey || '1Y';
    const cacheKey = 'hist:' + ticker + ':' + rangeKey;
    let cached = this.getCached(cacheKey);
    if (cached) return cached;

    if (!this.hasApiKey()) {
      return PA.SampleData.getHistory(ticker, rangeKey) || { dates:[], prices:[], volumes:[] };
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      let days = PA.Config.RANGE_DAYS[rangeKey] || 365;
      if (rangeKey === 'YTD') {
        days = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,1).getTime()) / 86400000);
      }
      const from = now - days * 86400;
      // Use daily resolution for up to 1Y, weekly for longer
      const res = days <= 365 ? 'D' : 'W';
      const data = await this.finnhubFetch(
        '/stock/candle?symbol=' + ticker + '&resolution=' + res + '&from=' + from + '&to=' + now
      );
      if (!data || data.s === 'no_data' || !data.c) {
        return PA.SampleData.getHistory(ticker, rangeKey) || { dates:[], prices:[], volumes:[] };
      }
      const result = {
        dates: data.t.map(t => new Date(t * 1000).toISOString().split('T')[0]),
        prices: data.c.map(p => Math.round(p * 100) / 100),
        volumes: data.v || data.t.map(() => 0)
      };
      this.setCache(cacheKey, result);
      return result;
    } catch(e) {
      if (e.message === 'NO_API_KEY') {
        return PA.SampleData.getHistory(ticker, rangeKey) || { dates:[], prices:[], volumes:[] };
      }
      throw e;
    }
  },

  async search(query) {
    if (!query || query.length < 1) return [];
    const key = 'search:' + query;
    let cached = this.getCached(key);
    if (cached) return cached;

    // Always search local DB
    const local = PA.DB.selectAll(
      'SELECT ticker, name, exchange FROM securities WHERE ticker LIKE ? OR name LIKE ? LIMIT 8',
      ['%' + query + '%', '%' + query + '%']
    ).map(r => ({ symbol: r.ticker, shortname: r.name, exchange: r.exchange }));

    if (!this.hasApiKey()) { this.setCache(key, local); return local; }

    try {
      const data = await this.finnhubFetch('/search?q=' + encodeURIComponent(query));
      const remote = (data?.result || [])
        .filter(r => r.type === 'Common Stock' || r.type === 'ETP' || r.type === 'ETF' || !r.type)
        .map(r => ({ symbol: r.symbol, shortname: r.description || '', exchange: r.exchange || '' }));
      const seen = new Set();
      const merged = [];
      [...local, ...remote].forEach(r => {
        if (r.symbol && !seen.has(r.symbol) && !r.symbol.includes('.')) {
          seen.add(r.symbol);
          merged.push(r);
        }
      });
      this.setCache(key, merged);
      return merged;
    } catch(e) { return local; }
  },

  parseHistory(result) {
    if (!result) return { dates:[], prices:[], volumes:[] };
    if (result.dates) return result;
    return { dates:[], prices:[], volumes:[] };
  }
};

/* ---- Sample Data (works without any API key) ---- */
PA.SampleData = {
  _generatePrices(basePrice, annualReturn, annualVol, days, seed) {
    const dt = 1/252;
    const drift = (annualReturn - 0.5*annualVol*annualVol)*dt;
    const diffusion = annualVol*Math.sqrt(dt);
    const prices = [basePrice];
    let s = Math.abs(seed) || 42;
    const rand = () => { s = (s * 16807 + 7) % 2147483647; return (s - 1) / 2147483646; };
    const boxMuller = () => { const u1 = Math.max(rand(), 0.0001), u2 = rand(); return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2); };
    for (let i = 1; i < days; i++) {
      const prev = prices[i-1];
      prices.push(Math.max(prev * Math.exp(drift + diffusion * boxMuller()), 0.01));
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
      if (dow === 0 || dow === 6) continue;
      dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
  },

  _stockProfiles: {
    SPY:  { price:585.50, ret:0.10, vol:0.15, name:'SPDR S&P 500 ETF Trust', beta:1.00, pe:23.5, fwdPe:21.2, cap:540e9, volume:75000000, yield:0.013, exchange:'NYSE ARCA', seed:100 },
    QQQ:  { price:512.30, ret:0.15, vol:0.20, name:'Invesco QQQ Trust', beta:1.15, pe:31.2, fwdPe:27.8, cap:250e9, volume:45000000, yield:0.006, exchange:'NASDAQ', seed:200 },
    DIA:  { price:425.80, ret:0.08, vol:0.14, name:'SPDR Dow Jones Industrial Average ETF', beta:0.95, pe:20.1, fwdPe:18.5, cap:35e9, volume:3500000, yield:0.017, exchange:'NYSE ARCA', seed:300 },
    IWM:  { price:224.70, ret:0.07, vol:0.22, name:'iShares Russell 2000 ETF', beta:1.20, pe:26.8, fwdPe:22.1, cap:65e9, volume:25000000, yield:0.012, exchange:'NYSE ARCA', seed:400 },
    VTI:  { price:290.15, ret:0.10, vol:0.15, name:'Vanguard Total Stock Market ETF', beta:1.00, pe:24.1, fwdPe:21.5, cap:420e9, volume:4000000, yield:0.013, exchange:'NYSE ARCA', seed:500 },
    VOO:  { price:538.20, ret:0.10, vol:0.15, name:'Vanguard S&P 500 ETF', beta:1.00, pe:23.5, fwdPe:21.2, cap:500e9, volume:5000000, yield:0.013, exchange:'NYSE ARCA', seed:600 },
    BND:  { price:72.45,  ret:0.03, vol:0.05, name:'Vanguard Total Bond Market ETF', beta:0.05, pe:null, fwdPe:null, cap:110e9, volume:7000000, yield:0.035, exchange:'NYSE ARCA', seed:700 },
    GLD:  { price:285.60, ret:0.08, vol:0.14, name:'SPDR Gold Shares', beta:0.05, pe:null, fwdPe:null, cap:75e9, volume:8000000, yield:0, exchange:'NYSE ARCA', seed:800 },
    TLT:  { price:91.80,  ret:0.02, vol:0.16, name:'iShares 20+ Year Treasury Bond ETF', beta:-0.30, pe:null, fwdPe:null, cap:55e9, volume:20000000, yield:0.038, exchange:'NYSE ARCA', seed:850 },
    AGG:  { price:100.25, ret:0.025, vol:0.04, name:'iShares Core US Aggregate Bond ETF', beta:0.03, pe:null, fwdPe:null, cap:95e9, volume:6000000, yield:0.033, exchange:'NYSE ARCA', seed:860 },
    VNQ:  { price:87.90,  ret:0.06, vol:0.20, name:'Vanguard Real Estate ETF', beta:0.85, pe:35.2, fwdPe:30.0, cap:35e9, volume:4000000, yield:0.038, exchange:'NYSE ARCA', seed:870 },
    AAPL: { price:234.82, ret:0.15, vol:0.25, name:'Apple Inc.', beta:1.21, pe:33.5, fwdPe:30.2, cap:3600e9, volume:55000000, yield:0.005, exchange:'NASDAQ', seed:1000 },
    MSFT: { price:454.27, ret:0.18, vol:0.24, name:'Microsoft Corporation', beta:0.90, pe:37.2, fwdPe:32.1, cap:3380e9, volume:22000000, yield:0.007, exchange:'NASDAQ', seed:2000 },
    GOOGL:{ price:186.45, ret:0.14, vol:0.26, name:'Alphabet Inc.', beta:1.08, pe:25.8, fwdPe:22.5, cap:2300e9, volume:25000000, yield:0.005, exchange:'NASDAQ', seed:3000 },
    AMZN: { price:224.92, ret:0.20, vol:0.30, name:'Amazon.com Inc.', beta:1.15, pe:62.5, fwdPe:38.2, cap:2350e9, volume:40000000, yield:0, exchange:'NASDAQ', seed:4000 },
    NVDA: { price:140.14, ret:0.35, vol:0.50, name:'NVIDIA Corporation', beta:1.65, pe:65.3, fwdPe:32.5, cap:3440e9, volume:250000000, yield:0.0003, exchange:'NASDAQ', seed:5000 },
    META: { price:618.73, ret:0.22, vol:0.35, name:'Meta Platforms Inc.', beta:1.25, pe:28.5, fwdPe:23.8, cap:1570e9, volume:15000000, yield:0.003, exchange:'NASDAQ', seed:6000 },
    TSLA: { price:352.60, ret:0.25, vol:0.55, name:'Tesla Inc.', beta:2.05, pe:95.2, fwdPe:65.0, cap:1130e9, volume:90000000, yield:0, exchange:'NASDAQ', seed:7000 },
    JPM:  { price:254.80, ret:0.12, vol:0.22, name:'JPMorgan Chase & Co.', beta:1.10, pe:12.5, fwdPe:11.8, cap:735e9, volume:9000000, yield:0.021, exchange:'NYSE', seed:8000 },
    V:    { price:318.45, ret:0.14, vol:0.20, name:'Visa Inc.', beta:0.95, pe:32.1, fwdPe:27.5, cap:620e9, volume:6000000, yield:0.007, exchange:'NYSE', seed:9000 },
    JNJ:  { price:158.32, ret:0.06, vol:0.15, name:'Johnson & Johnson', beta:0.55, pe:22.8, fwdPe:15.2, cap:385e9, volume:7000000, yield:0.031, exchange:'NYSE', seed:10000 },
    WMT:  { price:94.85,  ret:0.10, vol:0.18, name:'Walmart Inc.', beta:0.52, pe:37.5, fwdPe:30.2, cap:640e9, volume:8000000, yield:0.010, exchange:'NYSE', seed:11000 },
    XOM:  { price:111.70, ret:0.08, vol:0.25, name:'Exxon Mobil Corporation', beta:0.80, pe:14.2, fwdPe:13.5, cap:500e9, volume:14000000, yield:0.033, exchange:'NYSE', seed:12000 },
    PG:   { price:169.52, ret:0.07, vol:0.14, name:'Procter & Gamble Co.', beta:0.42, pe:28.5, fwdPe:24.2, cap:400e9, volume:6000000, yield:0.024, exchange:'NYSE', seed:13000 },
    HD:   { price:408.35, ret:0.12, vol:0.22, name:'The Home Depot Inc.', beta:1.05, pe:26.3, fwdPe:23.8, cap:400e9, volume:4000000, yield:0.023, exchange:'NYSE', seed:14000 },
    BAC:  { price:44.92,  ret:0.10, vol:0.28, name:'Bank of America Corp.', beta:1.35, pe:13.2, fwdPe:11.5, cap:355e9, volume:35000000, yield:0.024, exchange:'NYSE', seed:15000 },
    MA:   { price:533.18, ret:0.15, vol:0.21, name:'Mastercard Inc.', beta:1.08, pe:38.5, fwdPe:31.2, cap:500e9, volume:3000000, yield:0.005, exchange:'NYSE', seed:16000 },
    UNH:  { price:518.40, ret:0.14, vol:0.22, name:'UnitedHealth Group Inc.', beta:0.65, pe:32.1, fwdPe:18.5, cap:480e9, volume:3500000, yield:0.015, exchange:'NYSE', seed:17000 }
  },

  getQuote(ticker) {
    const p = this._stockProfiles[ticker.toUpperCase()];
    if (!p) return null;
    // Use deterministic "daily change" based on date so it doesn't jump on every call
    const dayNum = Math.floor(Date.now() / 86400000);
    const hashVal = ((dayNum * 31 + p.seed) % 200 - 100) / 10000;
    const change = Math.round(p.price * hashVal * 100) / 100;
    const changePct = Math.round(hashVal * 10000) / 100;
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
      regularMarketOpen: Math.round((p.price - change * 0.3) * 100) / 100,
      regularMarketDayHigh: Math.round((p.price + Math.abs(change) * 0.5) * 100) / 100,
      regularMarketDayLow: Math.round((p.price - Math.abs(change) * 0.5) * 100) / 100,
      regularMarketPreviousClose: Math.round((p.price - change) * 100) / 100,
      marketCap: p.cap,
      beta: p.beta,
      trailingPE: p.pe,
      forwardPE: p.fwdPe,
      epsTrailingTwelveMonths: p.pe ? Math.round(p.price / p.pe * 100) / 100 : null,
      epsForward: p.fwdPe ? Math.round(p.price / p.fwdPe * 100) / 100 : null,
      trailingAnnualDividendYield: p.yield,
      fiftyTwoWeekHigh: Math.round(p.price * 1.25 * 100) / 100,
      fiftyTwoWeekLow: Math.round(p.price * 0.78 * 100) / 100,
      fiftyDayAverage: Math.round(p.price * 0.98 * 100) / 100,
      twoHundredDayAverage: Math.round(p.price * 0.93 * 100) / 100,
      sharesOutstanding: Math.round(p.cap / p.price),
      bookValue: null,
      priceToBook: null,
      averageDailyVolume3Month: p.volume,
      _isSampleData: true
    };
  },

  getHistory(ticker, rangeKey) {
    rangeKey = rangeKey || '1Y';
    const p = this._stockProfiles[ticker.toUpperCase()];
    if (!p) return null;
    const rangeDays = PA.Config.RANGE_DAYS[rangeKey] || 365;
    const actualDays = rangeKey === 'YTD'
      ? Math.floor((Date.now() - new Date(new Date().getFullYear(),0,1).getTime()) / 86400000)
      : Math.min(rangeDays, 2600);
    const dates = this._generateDates(actualDays);
    const startPrice = p.price * Math.exp(-p.ret * (actualDays / 365));
    const prices = this._generatePrices(startPrice, p.ret, p.vol, dates.length, p.seed + rangeDays);
    // Scale so last price matches current
    const scale = p.price / (prices[prices.length - 1] || 1);
    const scaledPrices = prices.map(px => Math.round(px * scale * 100) / 100);
    const volumes = dates.map((_, i) => {
      const base = p.volume * (0.7 + 0.3 * Math.sin(i * 0.1 + p.seed));
      return Math.round(base);
    });
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
    if (arr.length < 2) return 0;
    const m = this.mean(arr);
    const variance = arr.reduce((s,v) => s + (v-m)**2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  },
  annualizedReturn(prices, tradingDays) {
    tradingDays = tradingDays || 252;
    if (prices.length < 2) return 0;
    const totalReturn = prices[prices.length-1] / prices[0];
    const years = (prices.length - 1) / tradingDays;
    if (years <= 0) return 0;
    return Math.pow(totalReturn, 1/years) - 1;
  },
  annualizedVolatility(returns, tradingDays) {
    tradingDays = tradingDays || 252;
    return this.stdDev(returns) * Math.sqrt(tradingDays);
  },
  sharpeRatio(returns, rf, tradingDays) {
    rf = rf || PA.Config.RISK_FREE;
    tradingDays = tradingDays || 252;
    const annRet = this.mean(returns) * tradingDays;
    const annVol = this.annualizedVolatility(returns, tradingDays);
    return annVol === 0 ? 0 : (annRet - rf) / annVol;
  },
  sortinoRatio(returns, rf, tradingDays) {
    rf = rf || PA.Config.RISK_FREE;
    tradingDays = tradingDays || 252;
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
    return { maxDD: maxDD, ddStart: ddStart, ddEnd: ddEnd };
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
  alpha(stockReturns, marketReturns, rf, tradingDays) {
    rf = rf || PA.Config.RISK_FREE;
    tradingDays = tradingDays || 252;
    const b = this.beta(stockReturns, marketReturns);
    const sRet = this.mean(stockReturns) * tradingDays;
    const mRet = this.mean(marketReturns) * tradingDays;
    return sRet - (rf + b * (mRet - rf));
  },
  delta(stockPrices, marketPrices) {
    const sR = this.dailyReturns(stockPrices);
    const mR = this.dailyReturns(marketPrices);
    return this.beta(sR, mR);
  },
  gamma(stockPrices, marketPrices, window) {
    window = window || 20;
    const sR = this.dailyReturns(stockPrices);
    const mR = this.dailyReturns(marketPrices);
    const deltas = [];
    for (let i = window; i <= sR.length; i++) {
      const sSub = sR.slice(i-window, i);
      const mSub = mR.slice(i-window, i);
      deltas.push(this.beta(sSub, mSub));
    }
    if (deltas.length < 2) return 0;
    const changes = this.dailyReturns(deltas.map(function(d) { return d + 2; }));
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
    const n = Math.min.apply(null, returnArrays.map(function(r) { return r.length; }));
    const pReturns = [];
    for (let i = 0; i < n; i++) {
      let dayReturn = 0;
      for (let j = 0; j < weights.length; j++) {
        dayReturn += weights[j] * (returnArrays[j][i] || 0);
      }
      pReturns.push(dayReturn);
    }
    return pReturns;
  },
  growthOf(initialValue, returns) {
    const growth = [initialValue];
    for (let i = 0; i < returns.length; i++) {
      growth.push(growth[growth.length-1] * (1 + returns[i]));
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
      result.push({ month: keys[i], return: (monthly[keys[i]].last / monthly[keys[i-1]].last) - 1 });
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
  currency(v, dec) {
    dec = dec != null ? dec : 2;
    if (v == null || isNaN(v)) return 'N/A';
    return '$' + Number(v).toLocaleString('en-US', {minimumFractionDigits:dec, maximumFractionDigits:dec});
  },
  pct(v, dec) {
    dec = dec != null ? dec : 2;
    if (v == null || isNaN(v)) return 'N/A';
    return (v * 100).toFixed(dec) + '%';
  },
  pctRaw(v, dec) {
    dec = dec != null ? dec : 2;
    if (v == null || isNaN(v)) return 'N/A';
    return Number(v).toFixed(dec) + '%';
  },
  number(v, dec) {
    dec = dec != null ? dec : 2;
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
  ratio(v, dec) {
    dec = dec != null ? dec : 2;
    if (v == null || isNaN(v)) return 'N/A';
    return Number(v).toFixed(dec);
  },
  colorClass(v) {
    if (v == null || isNaN(v)) return '';
    return v >= 0 ? 'positive' : 'negative';
  }
};
