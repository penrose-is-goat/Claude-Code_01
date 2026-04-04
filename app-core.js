/* ============================================================
   Portfolio Analyzer Pro - Core JavaScript
   ============================================================ */
const PA = window.PA = {};

/* ---- Config ---- */
PA.Config = {
  PROXIES: [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ],
  YF_BASE: 'https://query1.finance.yahoo.com',
  YF_BASE2: 'https://query2.finance.yahoo.com',
  RISK_FREE: 0.05,
  COLORS: ['#4f8ff7','#34d399','#f87171','#fbbf24','#a78bfa','#fb923c','#22d3ee','#f472b6','#84cc16','#e879f9'],
  RANGES: {
    '1M':  { range:'1mo',  interval:'1d' },
    '3M':  { range:'3mo',  interval:'1d' },
    '6M':  { range:'6mo',  interval:'1d' },
    'YTD': { range:'ytd',  interval:'1d' },
    '1Y':  { range:'1y',   interval:'1d' },
    '3Y':  { range:'3y',   interval:'1wk' },
    '5Y':  { range:'5y',   interval:'1wk' },
    '10Y': { range:'10y',  interval:'1mo' },
    'MAX': { range:'max',  interval:'1mo' }
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

/* ---- API (Yahoo Finance via CORS proxy) ---- */
PA.API = {
  cache: new Map(),
  CACHE_TTL: 60000,
  async fetchWithProxy(url) {
    for (const mkProxy of PA.Config.PROXIES) {
      try {
        const proxyUrl = mkProxy(url);
        const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
        if (resp.ok) { return await resp.json(); }
      } catch(e) { continue; }
    }
    // Try direct as last resort
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) return await resp.json();
    } catch(e) {}
    throw new Error('All API proxies failed for: ' + url);
  },
  getCached(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.ts < this.CACHE_TTL) return item.data;
    return null;
  },
  setCache(key, data) { this.cache.set(key, { data, ts: Date.now() }); },

  async getQuote(tickers) {
    const key = 'quote:' + tickers.join(',');
    let cached = this.getCached(key);
    if (cached) return cached;
    const url = `${PA.Config.YF_BASE}/v7/finance/quote?symbols=${tickers.join(',')}`;
    const data = await this.fetchWithProxy(url);
    const result = data?.quoteResponse?.result || [];
    this.setCache(key, result);
    return result;
  },

  async getQuoteSummary(ticker) {
    const key = 'summary:' + ticker;
    let cached = this.getCached(key);
    if (cached) return cached;
    const modules = 'defaultKeyStatistics,summaryDetail,financialData,price';
    const url = `${PA.Config.YF_BASE2}/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
    const data = await this.fetchWithProxy(url);
    const result = data?.quoteSummary?.result?.[0] || {};
    this.setCache(key, result);
    return result;
  },

  async getHistory(ticker, rangeKey='1Y') {
    const cfg = PA.Config.RANGES[rangeKey] || PA.Config.RANGES['1Y'];
    const key = `hist:${ticker}:${rangeKey}`;
    let cached = this.getCached(key);
    if (cached) return cached;
    const url = `${PA.Config.YF_BASE}/v8/finance/chart/${ticker}?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`;
    const data = await this.fetchWithProxy(url);
    const result = data?.chart?.result?.[0] || null;
    if (result) this.setCache(key, result);
    return result;
  },

  async search(query) {
    if (!query || query.length < 1) return [];
    const key = 'search:' + query;
    let cached = this.getCached(key);
    if (cached) return cached;
    const url = `${PA.Config.YF_BASE}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
    const data = await this.fetchWithProxy(url);
    const result = data?.quotes || [];
    this.setCache(key, result);
    return result;
  },

  parseHistory(result) {
    if (!result) return { dates:[], prices:[], volumes:[] };
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const adj = result.indicators?.adjclose?.[0]?.adjclose;
    const dates = ts.map(t => new Date(t * 1000).toISOString().split('T')[0]);
    const prices = (adj || q.close || []).map(v => v != null ? +v.toFixed(2) : null);
    const volumes = (q.volume || []);
    // Filter nulls
    const filtered = { dates:[], prices:[], volumes:[] };
    for (let i = 0; i < dates.length; i++) {
      if (prices[i] != null) {
        filtered.dates.push(dates[i]);
        filtered.prices.push(prices[i]);
        filtered.volumes.push(volumes[i] || 0);
      }
    }
    return filtered;
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
