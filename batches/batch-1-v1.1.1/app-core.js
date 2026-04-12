/* ============================================================
   Portfolio Analyzer Pro - Core JavaScript
   ============================================================ */
const PA = window.PA = {};

/* ---- Config ---- */
PA.Config = {
  APP_VERSION: 'Batch 1 v1.1.1',
  TD_BASE: 'https://api.twelvedata.com',
  DEFAULT_TWELVE_DATA_KEY: '42ec75497f5c4a50bef20661e1591daa',
  RISK_FREE: 0.05,
  COLORS: ['#4f8ff7','#34d399','#f87171','#fbbf24','#a78bfa','#fb923c','#22d3ee','#f472b6','#84cc16','#e879f9'],
  RANGES: {
    '1M':  { interval:'1day', outputsize:40, points:22 },
    '3M':  { interval:'1day', outputsize:90, points:66 },
    '6M':  { interval:'1day', outputsize:180, points:132 },
    'YTD': { interval:'1day', outputsize:400, mode:'ytd' },
    '1Y':  { interval:'1day', outputsize:300, points:252 },
    '3Y':  { interval:'1week', outputsize:180, points:156 },
    '5Y':  { interval:'1week', outputsize:300, points:260 },
    '10Y': { interval:'1month', outputsize:140, points:120 },
    'MAX': { interval:'1month', outputsize:5000 }
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

/* ---- API (Twelve Data) ---- */
PA.API = {
  cache: new Map(),
  CACHE_TTL: 30 * 60 * 1000,
  requestChain: Promise.resolve(),
  lastRequestAt: 0,

  getApiKey() {
    const key = localStorage.getItem('pa_twelve_data_key') || PA.Config.DEFAULT_TWELVE_DATA_KEY || '';
    return key.trim();
  },

  setApiKey(key) {
    const cleaned = (key || '').trim();
    if (cleaned) {
      localStorage.setItem('pa_twelve_data_key', cleaned);
    } else {
      localStorage.removeItem('pa_twelve_data_key');
    }
  },

  requireApiKey() {
    const key = this.getApiKey();
    if (!key) {
      throw new Error('Missing Twelve Data API key. Add it in Settings first.');
    }
    return key;
  },

  async fetchJson(endpoint, params={}) {
    const apikey = this.requireApiKey();
    this.requestChain = this.requestChain.then(async () => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < 250) {
        await new Promise(resolve => setTimeout(resolve, 250 - elapsed));
      }

      const url = new URL(`${PA.Config.TD_BASE}/${endpoint}`);
      Object.entries({ ...params, apikey }).forEach(([k, v]) => {
        if (v != null && v !== '') url.searchParams.set(k, v);
      });

      const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
      this.lastRequestAt = Date.now();
      if (!resp.ok) throw new Error(`API request failed (${resp.status})`);

      const data = await resp.json();
      if (data?.status === 'error') {
        throw new Error(data.message || 'Twelve Data request failed.');
      }
      return data;
    });
    return this.requestChain;
  },

  getCached(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.ts < this.CACHE_TTL) return item.data;
    return null;
  },

  setCache(key, data) {
    this.cache.set(key, { data, ts: Date.now() });
  },

  async getQuote(tickers) {
    const symbols = [...new Set((tickers || []).map(t => String(t).toUpperCase().trim()).filter(Boolean))];
    if (!symbols.length) return [];
    const key = `quote:${symbols.join(',')}`;
    const cached = this.getCached(key);
    if (cached) return cached;

    const raw = await this.fetchJson('quote', {
      symbol: symbols.join(','),
      interval: '1day'
    });
    const initial = this.normalizeQuoteBatch(raw, symbols);
    const quoteMap = new Map(initial.map(quote => [quote.symbol, quote]));
    const missing = symbols.filter(symbol => !quoteMap.has(symbol));

    for (const symbol of missing) {
      const fallbackRaw = await this.fetchJson('quote', { symbol, interval: '1day' });
      const fallbackQuote = this.normalizeQuote(fallbackRaw);
      if (fallbackQuote) {
        quoteMap.set(symbol, fallbackQuote);
      }
    }

    const unresolved = symbols.filter(symbol => !quoteMap.has(symbol));
    if (unresolved.length) {
      throw new Error(`No quote returned for ${unresolved.join(', ')} from Twelve Data.`);
    }

    const result = symbols.map(symbol => quoteMap.get(symbol)).filter(Boolean);
    this.setCache(key, result);
    return result;
  },

  async getQuoteSummary(ticker) {
    const key = `summary:${String(ticker).toUpperCase().trim()}`;
    const cached = this.getCached(key);
    if (cached) return cached;
    const result = {};
    this.setCache(key, result);
    return result;
  },

  async getHistory(ticker, rangeKey='1Y') {
    const symbol = String(ticker).toUpperCase().trim();
    const result = await this.getHistories([symbol], rangeKey);
    return result[symbol] || null;
  },

  async getHistories(tickers, rangeKey='1Y') {
    const cfg = PA.Config.RANGES[rangeKey] || PA.Config.RANGES['1Y'];
    const symbols = [...new Set((tickers || []).map(t => String(t).toUpperCase().trim()).filter(Boolean))];
    const results = {};
    const missing = [];

    symbols.forEach(symbol => {
      const cached = this.getCached(`hist:${symbol}:${rangeKey}`);
      if (cached) {
        results[symbol] = cached;
      } else {
        missing.push(symbol);
      }
    });

    if (missing.length) {
      const raw = await this.fetchJson('time_series', {
        symbol: missing.join(','),
        interval: cfg.interval,
        outputsize: cfg.outputsize,
        order: 'ASC'
      });

      const payloads = missing.length === 1 && raw?.meta ? { [missing[0]]: raw } : raw;
      missing.forEach(symbol => {
        const normalized = this.normalizeHistoryPayload(symbol, payloads?.[symbol], cfg, rangeKey);
        if (normalized) {
          results[symbol] = normalized;
          this.setCache(`hist:${symbol}:${rangeKey}`, normalized);
        }
      });

      const stillMissing = missing.filter(symbol => !results[symbol]);
      for (const symbol of stillMissing) {
        const fallbackRaw = await this.fetchJson('time_series', {
          symbol,
          interval: cfg.interval,
          outputsize: cfg.outputsize,
          order: 'ASC'
        });
        const normalized = this.normalizeHistoryPayload(symbol, fallbackRaw, cfg, rangeKey);
        if (normalized) {
          results[symbol] = normalized;
          this.setCache(`hist:${symbol}:${rangeKey}`, normalized);
        }
      }
    }

    const unresolved = symbols.filter(symbol => !results[symbol]);
    if (unresolved.length) {
      throw new Error(`No price history returned for ${unresolved.join(', ')} from Twelve Data.`);
    }

    return results;
  },

  async search(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const key = `search:${q.toUpperCase()}`;
    const cached = this.getCached(key);
    if (cached) return cached;

    const data = await this.fetchJson('symbol_search', { symbol: q });
    const result = (data?.data || [])
      .map(item => ({
        symbol: item.symbol,
        shortname: item.instrument_name || item.symbol,
        longname: item.instrument_name || item.symbol,
        exchange: item.exchange || '',
        country: item.country || '',
        quoteType: item.instrument_type || ''
      }))
      .sort((a, b) => {
        const aExact = a.symbol === q.toUpperCase() ? 1 : 0;
        const bExact = b.symbol === q.toUpperCase() ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        const aUs = a.country === 'United States' ? 1 : 0;
        const bUs = b.country === 'United States' ? 1 : 0;
        if (aUs !== bUs) return bUs - aUs;
        return a.symbol.localeCompare(b.symbol);
      });

    this.setCache(key, result);
    return result;
  },

  parseHistory(result) {
    if (!result) return { dates:[], prices:[], volumes:[] };
    return {
      dates: result.dates || [],
      prices: result.prices || [],
      volumes: result.volumes || []
    };
  },

  normalizeQuoteBatch(raw, symbols) {
    const payload = symbols.length === 1 && raw?.symbol ? { [symbols[0]]: raw } : raw;
    return symbols
      .map(symbol => this.normalizeQuote(payload?.[symbol]))
      .filter(Boolean);
  },

  normalizeQuote(raw) {
    if (!raw?.symbol) return null;
    const num = value => {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    return {
      symbol: raw.symbol,
      shortName: raw.name || raw.symbol,
      longName: raw.name || raw.symbol,
      regularMarketPrice: num(raw.close),
      regularMarketChange: num(raw.change),
      regularMarketChangePercent: num(raw.percent_change),
      regularMarketPreviousClose: num(raw.previous_close),
      regularMarketOpen: num(raw.open),
      regularMarketDayHigh: num(raw.high),
      regularMarketDayLow: num(raw.low),
      regularMarketVolume: parseInt(raw.volume || '0', 10),
      averageDailyVolume3Month: parseInt(raw.average_volume || '0', 10) || null,
      averageDailyVolume10Day: parseInt(raw.average_volume || '0', 10) || null,
      marketCap: null,
      trailingPE: null,
      forwardPE: null,
      trailingAnnualDividendYield: null,
      dividendRate: null,
      epsTrailingTwelveMonths: null,
      epsForward: null,
      priceToBook: null,
      bookValue: null,
      sharesOutstanding: null,
      fiftyTwoWeekHigh: num(raw.fifty_two_week?.high),
      fiftyTwoWeekLow: num(raw.fifty_two_week?.low),
      fiftyDayAverage: null,
      twoHundredDayAverage: null,
      marketState: raw.is_market_open ? 'REGULAR' : 'CLOSED',
      exDividendDate: null,
      currency: raw.currency || 'USD',
      exchange: raw.exchange || '',
      fullExchangeName: raw.exchange || '',
      quoteType: 'EQUITY'
    };
  },

  normalizeHistoryPayload(symbol, raw, cfg, rangeKey) {
    const values = raw?.values;
    if (!Array.isArray(values) || !values.length) return null;

    const entries = values
      .slice()
      .sort((a, b) => a.datetime.localeCompare(b.datetime))
      .map(point => ({
        date: point.datetime.split(' ')[0],
        price: parseFloat(point.close),
        volume: parseInt(point.volume || '0', 10)
      }))
      .filter(point => Number.isFinite(point.price));

    let filtered = entries;
    if (cfg.mode === 'ytd') {
      const year = new Date().getFullYear().toString();
      filtered = entries.filter(point => point.date.startsWith(year));
    } else if (cfg.points) {
      filtered = entries.slice(-cfg.points);
    }

    return {
      ticker: symbol,
      rangeKey,
      dates: filtered.map(point => point.date),
      prices: filtered.map(point => point.price),
      volumes: filtered.map(point => point.volume)
    };
  },

  averageOfTail(values, count) {
    if (!values?.length) return null;
    const tail = values.slice(-count).filter(value => value != null && !Number.isNaN(value));
    if (!tail.length) return null;
    return tail.reduce((sum, value) => sum + value, 0) / tail.length;
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
