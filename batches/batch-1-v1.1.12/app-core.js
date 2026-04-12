/* ============================================================
   Portfolio Analyzer Pro - Core JavaScript
   ============================================================ */
const PA = window.PA = {};

/* ---- Config ---- */
PA.Config = {
  APP_VERSION: 'Batch 1 v1.1.12',
  DEFAULT_BACKEND_URL: 'http://127.0.0.1:8765/api',
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
    this.ensureColumn('quotes', 'net_assets', 'REAL');
    this.ensureColumn('quotes', 'expense_ratio', 'REAL');
    this.ensureColumn('quotes', 'portfolio_turnover', 'REAL');
    this.ensureColumn('quotes', 'inception_date', 'TEXT');
    this.ensureColumn('quotes', 'leveraged', 'TEXT');
  },
  ensureColumn(table, column, type) {
    const result = this.db.exec(`PRAGMA table_info(${table})`);
    const values = result?.[0]?.values || [];
    const hasColumn = values.some(row => row?.[1] === column);
    if (!hasColumn) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  },
  normalizeValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  },
  normalizeParams(params=[]) {
    return (params || []).map(value => this.normalizeValue(value));
  },
  exec(sql, params=[]) {
    return this.db.run(sql, this.normalizeParams(params));
  },
  selectAll(sql, params=[]) {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(this.normalizeParams(params));
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

/* ---- API (Live Backend) ---- */
PA.API = {
  cache: new Map(),
  pending: new Map(),
  avPending: new Map(),
  CACHE_TTL: 30 * 60 * 1000,
  SUMMARY_TTL: 24 * 60 * 60 * 1000,
  requestChain: Promise.resolve(),
  avRequestChain: Promise.resolve(),
  lastRequestAt: 0,
  lastAlphaRequestAt: 0,
  lastError: null,
  lastBackendHealth: null,
  requestLog: [],

  getBackendUrl() {
    const url = localStorage.getItem('pa_backend_url') || PA.Config.DEFAULT_BACKEND_URL || '';
    return url.trim().replace(/\/$/, '');
  },

  setBackendUrl(url) {
    const cleaned = (url || '').trim().replace(/\/$/, '');
    if (cleaned) {
      localStorage.setItem('pa_backend_url', cleaned);
    } else {
      localStorage.removeItem('pa_backend_url');
    }
  },

  clearDiagnostics() {
    this.lastError = null;
    this.requestLog = [];
    this.lastBackendHealth = null;
  },

  describeError(error, fallback='Unexpected error while loading live market data.') {
    if (error instanceof Error && typeof error.message === 'string') {
      const message = error.message.trim();
      if (message && message !== 'undefined') return message;
    }
    if (typeof error === 'string') {
      const message = error.trim();
      if (message) return message;
    }
    if (error && typeof error === 'object') {
      if (typeof error.message === 'string') {
        const message = error.message.trim();
        if (message && message !== 'undefined') return message;
      }
      if (typeof error.statusText === 'string') {
        const statusText = error.statusText.trim();
        if (statusText) return statusText;
      }
      try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}' && serialized !== 'null') return serialized;
      } catch (e) {}
    }
    return fallback;
  },

  normalizeBackendError(error, requestUrl='') {
    const message = this.describeError(error);
    const unreachable =
      message === 'Failed to fetch' ||
      /failed to fetch/i.test(message) ||
      /networkerror/i.test(message) ||
      /load failed/i.test(message);
    if (!unreachable) return message;
    const target = requestUrl || this.getBackendUrl();
    return `Cannot reach the local yfinance backend at ${target}. Start backend\\start-backend.ps1 and keep it running, then click Test Backend in Settings.`;
  },

  recordRequest(provider, endpoint, params, requestUrl) {
    this.requestLog.unshift({
      at: new Date().toISOString(),
      provider,
      endpoint,
      symbol: params?.symbol || '',
      interval: params?.interval || '',
      url: requestUrl
    });
    this.requestLog = this.requestLog.slice(0, 10);
  },

  recordError(error, context={}) {
    const message = this.describeError(error);
    const normalized = error instanceof Error ? error : new Error(message);
    if (!normalized.message || normalized.message === 'undefined') {
      normalized.message = message;
    }
    normalized.context = context;
    this.lastError = {
      at: new Date().toISOString(),
      message,
      context
    };
    console.error('PA.API error:', message, context, error);
    return normalized;
  },

  getDiagnostics() {
    return {
      provider: 'Local yfinance backend',
      version: PA.Config.APP_VERSION,
      backendUrl: this.getBackendUrl(),
      hasBackendUrl: Boolean(this.getBackendUrl()),
      lastRequest: this.requestLog[0] || null,
      lastError: this.lastError,
      backendHealth: this.lastBackendHealth
    };
  },

  requireBackendUrl() {
    const url = this.getBackendUrl();
    if (!url) {
      throw new Error('Missing backend URL. Start the local yfinance backend and save its URL in Settings.');
    }
    return url;
  },

  getEasternMarketClock() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
      weekday: values.weekday,
      hour: Number(values.hour),
      minute: Number(values.minute)
    };
  },

  isUsMarketOpenNow() {
    const clock = this.getEasternMarketClock();
    const openDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    if (!openDays.includes(clock.weekday)) return false;
    const minutes = clock.hour * 60 + clock.minute;
    return minutes >= 570 && minutes < 960;
  },

  shouldUseLiveQuote(forceLive=false) {
    return true;
  },

  async checkBackendHealth() {
    const health = await this.fetchBackendJson('health');
    this.lastBackendHealth = health || null;
    return health;
  },

  async fetchBackendJson(endpoint, params={}) {
    const normalizedParams = Object.keys(params).sort().reduce((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});
    const requestKey = `backend:${endpoint}:${JSON.stringify(normalizedParams)}`;
    if (this.pending.has(requestKey)) {
      return this.pending.get(requestKey);
    }

    const task = (async () => {
      let requestUrl = '';
      try {
        const baseUrl = this.requireBackendUrl();
        const url = new URL(`${baseUrl}/${endpoint}`);
        Object.entries(normalizedParams).forEach(([k, v]) => {
          if (v != null && v !== '') url.searchParams.set(k, v);
        });
        requestUrl = url.toString();
        this.recordRequest('Local yfinance backend', endpoint, normalizedParams, requestUrl);
        const resp = await fetch(requestUrl);
        const text = await resp.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = { raw: text };
          }
        }
        if (!resp.ok) {
          throw new Error(data?.error || `Backend request failed (${resp.status})`);
        }
        if (data?.error) {
          throw new Error(data.error);
        }
        this.lastError = null;
        return data;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(this.normalizeBackendError(error, requestUrl));
        normalized.message = this.normalizeBackendError(normalized, requestUrl);
        throw this.recordError(normalized, { provider: 'Local yfinance backend', endpoint, params: normalizedParams, requestUrl });
      }
    })();
    this.pending.set(requestKey, task);
    try {
      return await task;
    } finally {
      this.pending.delete(requestKey);
    }
  },

  async fetchJson(endpoint, params={}) {
    const normalizedParams = Object.keys(params).sort().reduce((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});
    const requestKey = `${endpoint}:${JSON.stringify(normalizedParams)}`;
    if (this.pending.has(requestKey)) {
      return this.pending.get(requestKey);
    }

    const task = this.requestChain.then(async () => {
      let requestUrl = '';
      try {
        const elapsed = Date.now() - this.lastRequestAt;
        if (elapsed < 250) {
          await new Promise(resolve => setTimeout(resolve, 250 - elapsed));
        }

        const apikey = this.requireApiKey();
        const url = new URL(`${PA.Config.TD_BASE}/${endpoint}`);
        Object.entries({ ...params, apikey }).forEach(([k, v]) => {
          if (v != null && v !== '') url.searchParams.set(k, v);
        });
        requestUrl = url.toString();
        this.recordRequest('Twelve Data', endpoint, normalizedParams, requestUrl);

        const fetchOptions = {};
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          fetchOptions.signal = AbortSignal.timeout(15000);
        }
        const resp = await fetch(requestUrl, fetchOptions);
        this.lastRequestAt = Date.now();

        const text = await resp.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = { raw: text };
          }
        }

        if (!resp.ok) {
          const message =
            data?.message ||
            data?.status ||
            (typeof data?.raw === 'string' ? data.raw : '') ||
            `API request failed (${resp.status})`;
          throw new Error(message);
        }

        if (data?.status === 'error') {
          throw new Error(data.message || 'Twelve Data request failed.');
        }

        if (data == null) {
          throw new Error('Twelve Data returned an empty response.');
        }

        this.lastError = null;
        return data;
      } catch (error) {
        throw this.recordError(error, { provider: 'Twelve Data', endpoint, params: normalizedParams, requestUrl });
      }
    });
    this.requestChain = task.catch(() => {});
    this.pending.set(requestKey, task);
    try {
      return await task;
    } finally {
      this.pending.delete(requestKey);
    }
  },

  async fetchAlphaVantageJson(params={}) {
    const normalizedParams = Object.keys(params).sort().reduce((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});
    const requestKey = `alphavantage:${JSON.stringify(normalizedParams)}`;
    if (this.avPending.has(requestKey)) {
      return this.avPending.get(requestKey);
    }

    const task = this.avRequestChain.then(async () => {
      let requestUrl = '';
      try {
        const elapsed = Date.now() - this.lastAlphaRequestAt;
        if (elapsed < 1000) {
          await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
        }

        const apikey = this.requireAlphaVantageKey();
        const url = new URL(PA.Config.AV_BASE);
        Object.entries({ ...params, apikey }).forEach(([k, v]) => {
          if (v != null && v !== '') url.searchParams.set(k, v);
        });
        requestUrl = url.toString();
        this.recordRequest('Alpha Vantage', 'query', normalizedParams, requestUrl);

        const fetchOptions = {};
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          fetchOptions.signal = AbortSignal.timeout(15000);
        }
        const resp = await fetch(requestUrl, fetchOptions);
        this.lastAlphaRequestAt = Date.now();

        const text = await resp.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = { raw: text };
          }
        }

        if (!resp.ok) {
          const message =
            data?.message ||
            data?.['Error Message'] ||
            data?.Information ||
            data?.Note ||
            (typeof data?.raw === 'string' ? data.raw : '') ||
            `Alpha Vantage request failed (${resp.status})`;
          throw new Error(message);
        }

        if (data?.['Error Message']) throw new Error(data['Error Message']);
        if (data?.Information) throw new Error(data.Information);
        if (data?.Note) throw new Error(data.Note);
        if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
          throw new Error('Alpha Vantage returned no fundamentals data.');
        }

        this.lastError = null;
        return data;
      } catch (error) {
        throw this.recordError(error, { provider: 'Alpha Vantage', endpoint: 'query', params: normalizedParams, requestUrl });
      }
    });
    this.avRequestChain = task.catch(() => {});
    this.avPending.set(requestKey, task);
    try {
      return await task;
    } finally {
      this.avPending.delete(requestKey);
    }
  },

  getCached(key, ttlMs=this.CACHE_TTL) {
    return null;
  },

  setCache(key, data) {
    return null;
  },

  async getQuote(tickers) {
    const symbols = [...new Set((tickers || []).map(t => String(t).toUpperCase().trim()).filter(Boolean))];
    if (!symbols.length) return [];
    const data = await this.fetchBackendJson('quote', { symbols: symbols.join(',') });
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    const quoteMap = new Map(quotes.map(quote => [quote.symbol, quote]));
    const unresolved = symbols.filter(symbol => !quoteMap.has(symbol));
    if (unresolved.length) {
      throw this.recordError(
        new Error(`No quote returned by the local yfinance backend for ${unresolved.join(', ')}.`),
        { endpoint: 'quote', symbols: unresolved }
      );
    }
    return symbols.map(symbol => quoteMap.get(symbol)).filter(Boolean);
  },

  async getQuoteSummary(ticker) {
    const symbol = String(ticker).toUpperCase().trim();
    const data = await this.fetchBackendJson('summary', { symbol });
    if (!data?.summary) {
      throw this.recordError(
        new Error(`No summary returned by the local yfinance backend for ${symbol}.`),
        { endpoint: 'summary', symbol }
      );
    }
    return data.summary;
  },

  async getHistory(ticker, rangeKey='1Y') {
    const symbol = String(ticker).toUpperCase().trim();
    const result = await this.getHistories([symbol], rangeKey);
    return result[symbol] || null;
  },

  async getHistories(tickers, rangeKey='1Y') {
    const symbols = [...new Set((tickers || []).map(t => String(t).toUpperCase().trim()).filter(Boolean))];
    const data = await this.fetchBackendJson('history', {
      symbols: symbols.join(','),
      range: rangeKey
    });
    const results = data?.histories || {};
    const unresolved = symbols.filter(symbol => !results[symbol]);
    if (unresolved.length) {
      throw this.recordError(
        new Error(`No price history returned by the local yfinance backend for ${unresolved.join(', ')}.`),
        { endpoint: 'history', symbols: unresolved, rangeKey }
      );
    }

    return results;
  },

  async search(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const data = await this.fetchBackendJson('search', { q });
    const result = Array.isArray(data?.results) ? data.results : [];
    return result.sort((a, b) => {
      const aExact = a.symbol === q.toUpperCase() ? 1 : 0;
      const bExact = b.symbol === q.toUpperCase() ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    });
  },

  parseHistory(result) {
    if (!result) return { dates:[], prices:[], adjustedPrices:[], volumes:[] };
    return {
      dates: result.dates || [],
      prices: result.prices || [],
      adjustedPrices: result.adjustedPrices || [],
      volumes: result.volumes || [],
      opens: result.opens || [],
      highs: result.highs || [],
      lows: result.lows || []
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
        open: parseFloat(point.open),
        high: parseFloat(point.high),
        low: parseFloat(point.low),
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
      volumes: filtered.map(point => point.volume),
      opens: filtered.map(point => Number.isFinite(point.open) ? point.open : null),
      highs: filtered.map(point => Number.isFinite(point.high) ? point.high : null),
      lows: filtered.map(point => Number.isFinite(point.low) ? point.low : null)
    };
  },

  normalizeAlphaVantageOverview(raw) {
    if (!raw?.Symbol) {
      throw new Error('Alpha Vantage overview response was missing the symbol payload.');
    }
    const num = value => {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const wrapped = value => {
      const parsed = num(value);
      return parsed == null ? null : { raw: parsed };
    };

    return {
      company: {
        name: raw.Name || raw.Symbol,
        sector: raw.Sector || '',
        industry: raw.Industry || '',
        exchange: raw.Exchange || ''
      },
      defaultKeyStatistics: {
        beta: wrapped(raw.Beta),
        forwardPE: wrapped(raw.ForwardPE),
        sharesOutstanding: wrapped(raw.SharesOutstanding)
      },
      summaryDetail: {
        trailingPE: wrapped(raw.PERatio || raw.TrailingPE),
        forwardPE: wrapped(raw.ForwardPE),
        marketCap: wrapped(raw.MarketCapitalization),
        dividendYield: wrapped(raw.DividendYield),
        fiftyTwoWeekLow: wrapped(raw['52WeekLow']),
        fiftyTwoWeekHigh: wrapped(raw['52WeekHigh']),
        fiftyDayAverage: wrapped(raw['50DayMovingAverage']),
        twoHundredDayAverage: wrapped(raw['200DayMovingAverage']),
        priceToBook: wrapped(raw.PriceToBookRatio)
      },
      earnings: {
        eps: num(raw.EPS) ?? num(raw.DilutedEPSTTM),
        dilutedEpsTtm: num(raw.DilutedEPSTTM)
      },
      valuation: {
        bookValue: num(raw.BookValue),
        marketCap: num(raw.MarketCapitalization),
        priceToBook: num(raw.PriceToBookRatio)
      },
      dividends: {
        dividendYield: num(raw.DividendYield),
        dividendPerShare: num(raw.DividendPerShare),
        exDividendDate: raw.ExDividendDate || null,
        dividendDate: raw.DividendDate || null
      },
      raw
    };
  },

  normalizeAlphaVantageEtfProfile(raw, symbol) {
    const num = value => {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    if (!raw || (raw.net_assets == null && !Array.isArray(raw.holdings))) {
      throw new Error(`Alpha Vantage ETF profile response was missing ETF data for ${symbol}.`);
    }
    const sectors = Array.isArray(raw.sectors) ? raw.sectors : [];
    const holdings = Array.isArray(raw.holdings) ? raw.holdings : [];
    const dominantSector = sectors[0]?.sector || '';
    return {
      company: {
        name: symbol,
        sector: dominantSector,
        industry: 'ETF',
        exchange: ''
      },
      defaultKeyStatistics: {
        beta: null,
        forwardPE: null,
        sharesOutstanding: null
      },
      summaryDetail: {
        trailingPE: null,
        forwardPE: null,
        marketCap: null,
        dividendYield: num(raw.dividend_yield),
        fiftyTwoWeekLow: null,
        fiftyTwoWeekHigh: null,
        fiftyDayAverage: null,
        twoHundredDayAverage: null,
        priceToBook: null
      },
      earnings: {
        eps: null,
        dilutedEpsTtm: null
      },
      valuation: {
        bookValue: null,
        marketCap: null,
        priceToBook: null
      },
      dividends: {
        dividendYield: num(raw.dividend_yield),
        dividendPerShare: null,
        exDividendDate: null,
        dividendDate: null
      },
      fundProfile: {
        netAssets: num(raw.net_assets),
        expenseRatio: num(raw.net_expense_ratio),
        portfolioTurnover: num(raw.portfolio_turnover),
        dividendYield: num(raw.dividend_yield),
        inceptionDate: raw.inception_date || null,
        leveraged: raw.leveraged || null,
        sectors,
        holdings
      },
      raw
    };
  },

  summaryValue(value) {
    if (value == null) return null;
    if (typeof value === 'object' && 'raw' in value) return value.raw;
    return value;
  },

  applySummaryToQuote(quote, summary) {
    if (!quote || !summary) return quote;
    const ks = summary.defaultKeyStatistics || {};
    const sd = summary.summaryDetail || {};
    const earnings = summary.earnings || {};
    const valuation = summary.valuation || {};
    const dividends = summary.dividends || {};
    const company = summary.company || {};
    const fund = summary.fundProfile || {};

    quote.shortName = quote.shortName || company.name || quote.symbol;
    quote.longName = quote.longName || company.name || quote.symbol;
    quote.exchange = quote.exchange || company.exchange || '';
    quote.fullExchangeName = quote.fullExchangeName || company.exchange || '';
    quote.marketCap = quote.marketCap ?? this.summaryValue(sd.marketCap) ?? valuation.marketCap ?? null;
    quote.beta = quote.beta ?? this.summaryValue(ks.beta);
    quote.trailingPE = quote.trailingPE ?? this.summaryValue(sd.trailingPE);
    quote.forwardPE = quote.forwardPE ?? this.summaryValue(ks.forwardPE) ?? this.summaryValue(sd.forwardPE);
    quote.trailingAnnualDividendYield = quote.trailingAnnualDividendYield ?? this.summaryValue(sd.dividendYield) ?? dividends.dividendYield;
    quote.dividendRate = quote.dividendRate ?? dividends.dividendPerShare ?? null;
    quote.epsTrailingTwelveMonths = quote.epsTrailingTwelveMonths ?? earnings.eps ?? earnings.dilutedEpsTtm ?? null;
    if (quote.epsForward == null && quote.regularMarketPrice != null && quote.forwardPE) {
      quote.epsForward = quote.forwardPE ? quote.regularMarketPrice / quote.forwardPE : null;
    }
    quote.priceToBook = quote.priceToBook ?? this.summaryValue(sd.priceToBook) ?? valuation.priceToBook ?? null;
    quote.bookValue = quote.bookValue ?? valuation.bookValue ?? null;
    quote.sharesOutstanding = quote.sharesOutstanding ?? this.summaryValue(ks.sharesOutstanding) ?? null;
    quote.fiftyTwoWeekHigh = quote.fiftyTwoWeekHigh ?? this.summaryValue(sd.fiftyTwoWeekHigh) ?? null;
    quote.fiftyTwoWeekLow = quote.fiftyTwoWeekLow ?? this.summaryValue(sd.fiftyTwoWeekLow) ?? null;
    quote.fiftyDayAverage = quote.fiftyDayAverage ?? this.summaryValue(sd.fiftyDayAverage) ?? null;
    quote.twoHundredDayAverage = quote.twoHundredDayAverage ?? this.summaryValue(sd.twoHundredDayAverage) ?? null;
    quote.exDividendDate = quote.exDividendDate ?? dividends.exDividendDate ?? null;
    quote.netAssets = quote.netAssets ?? fund.netAssets ?? null;
    quote.expenseRatio = quote.expenseRatio ?? fund.expenseRatio ?? null;
    quote.portfolioTurnover = quote.portfolioTurnover ?? fund.portfolioTurnover ?? null;
    quote.inceptionDate = quote.inceptionDate ?? fund.inceptionDate ?? null;
    quote.leveraged = quote.leveraged ?? fund.leveraged ?? null;
    if (fund.netAssets != null) {
      quote.quoteType = 'ETF';
    }
    return quote;
  },

  mergeQuoteData(baseQuote, liveQuote) {
    const merged = { ...(baseQuote || {}) };
    Object.entries(liveQuote || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        merged[key] = value;
      }
    });
    return merged;
  },

  buildQuoteFromHistory(symbol, historyData) {
    const prices = historyData?.prices || [];
    if (!prices.length) return null;
    const lastIndex = prices.length - 1;
    const latest = prices[lastIndex];
    const prevClose = prices[lastIndex - 1] ?? latest;
    const change = latest - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const opens = historyData?.opens || [];
    const highs = historyData?.highs || [];
    const lows = historyData?.lows || [];
    const volumes = historyData?.volumes || [];

    return {
      symbol,
      shortName: symbol,
      longName: symbol,
      regularMarketPrice: latest,
      regularMarketChange: change,
      regularMarketChangePercent: changePct,
      regularMarketPreviousClose: prevClose,
      regularMarketOpen: opens[lastIndex] ?? null,
      regularMarketDayHigh: highs[lastIndex] ?? latest,
      regularMarketDayLow: lows[lastIndex] ?? latest,
      regularMarketVolume: volumes[lastIndex] ?? null,
      averageDailyVolume3Month: this.averageOfTail(volumes, 60),
      averageDailyVolume10Day: this.averageOfTail(volumes, 10),
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
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      fiftyDayAverage: null,
      twoHundredDayAverage: null,
      marketState: this.isUsMarketOpenNow() ? 'REGULAR' : 'CLOSED',
      exDividendDate: null,
      netAssets: null,
      expenseRatio: null,
      portfolioTurnover: null,
      inceptionDate: null,
      leveraged: null,
      currency: 'USD',
      exchange: '',
      fullExchangeName: '',
      quoteType: 'EQUITY'
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
  alignHistorySeries(stockData, marketData) {
    const stockMap = new Map((stockData?.dates || []).map((date, i) => [date, {
      price: stockData.prices?.[i],
      volume: stockData.volumes?.[i]
    }]));
    const alignedDates = [];
    const stockPrices = [];
    const marketPrices = [];
    (marketData?.dates || []).forEach((date, i) => {
      const stockPoint = stockMap.get(date);
      const marketPrice = marketData.prices?.[i];
      if (stockPoint && Number.isFinite(stockPoint.price) && Number.isFinite(marketPrice)) {
        alignedDates.push(date);
        stockPrices.push(stockPoint.price);
        marketPrices.push(marketPrice);
      }
    });
    return { dates: alignedDates, stockPrices, marketPrices };
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
  providerPct(v, unit='ratio', dec=2) {
    if (v == null || isNaN(v)) return 'N/A';
    return unit === 'percent' ? this.pctRaw(v, dec) : this.pct(v, dec);
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
