/* ============================================================
   Portfolio Analyzer Pro - Feature Modules
   ============================================================ */

/* ---- UI Utilities ---- */
PA.UI = {
  toast(msg, type='info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  },
  showTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById('tab-'+name);
    const btn = document.querySelector(`[data-tab="${name}"]`);
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
  },
  loading(el, show=true) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    if (show) {
      el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading data...</div>';
    }
  },
  debounce(fn, ms=300) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }
};

/* ---- Ticker Analysis ---- */
PA.Ticker = {
  current: null,
  currentRange: '1Y',

  async lookup(ticker) {
    ticker = ticker.toUpperCase().trim();
    if (!ticker) return;
    PA.UI.loading('ticker-content');
    document.getElementById('ticker-content').style.display = 'block';
    const emptyEl = document.getElementById('ticker-empty');
    if (emptyEl) emptyEl.style.display = 'none';
    try {
      const [quotes, history] = await Promise.allSettled([
        PA.API.getQuote([ticker]),
        PA.API.getHistory(ticker, this.currentRange)
      ]);
      const quote = quotes.status === 'fulfilled' ? (quotes.value[0] || null) : null;
      const hist = history.status === 'fulfilled' ? history.value : null;
      const failures = [quotes, history]
        .filter(result => result.status === 'rejected')
        .map(result => result.reason?.message)
        .filter(Boolean);

      if ((!hist || !quote) && failures.length) {
        const cached = this.loadFromDb(ticker, this.currentRange);
        if (cached) {
          this.current = cached;
          this.render(true);
          PA.UI.toast('Loaded cached data because live API data is unavailable', 'info');
          return;
        }
        throw new Error(failures[0]);
      }

      if (!hist || !quote) {
        const cached = this.loadFromDb(ticker, this.currentRange);
        if (cached) {
          this.current = cached;
          this.render(true);
          PA.UI.toast('Loaded cached data because live API data is unavailable', 'info');
          return;
        }
        document.getElementById('ticker-content').innerHTML =
          `<div class="empty-state"><h3>Ticker "${ticker}" not found</h3><p>Please check the symbol and try again.</p></div>`;
        return;
      }

      const hData = PA.API.parseHistory(hist);
      this.applyDerivedStats(quote, hData);
      this.current = { ticker, quote, hist, summary: {} };
      this.render();
      // Save to DB
      this.saveToDb(ticker, quote, {}, hist);
    } catch(e) {
      document.getElementById('ticker-content').innerHTML =
        `<div class="empty-state"><h3>Error loading data</h3><p>${e.message}</p><p style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">Check your Twelve Data API key in Settings, then try again.</p></div>`;
    }
  },

  render(isCached=false) {
    if (!this.current) return;
    const { ticker, quote: q, hist, summary: s } = this.current;
    const ks = s?.defaultKeyStatistics || {};
    const sd = s?.summaryDetail || {};
    const earnings = s?.earnings || {};
    const company = s?.company || {};

    const change = q.regularMarketChange || 0;
    const changePct = q.regularMarketChangePercent || 0;
    const changeClass = change >= 0 ? 'positive' : 'negative';
    const changeSign = change >= 0 ? '+' : '';
    const marketLabel = q.marketState === 'REGULAR'
      ? '<span class="positive">Open</span>'
      : q.marketState === 'UNKNOWN'
        ? '<span>Unknown</span>'
        : '<span class="negative">Closed</span>';

    // Get parsed history
    const hData = PA.API.parseHistory(hist);
    this.applyDerivedStats(q, hData);
    // Compute Greeks from history
    if (hData.prices.length > 30) {
      // We need SPY data for comparison
      this.computeGreeks(ticker, hData);
    }

    // Extract values with fallbacks
    const beta = this.v(ks.beta) ?? this.v(q.beta) ?? null;
    const pe = this.v(sd.trailingPE) ?? this.v(q.trailingPE) ?? null;
    const fwdPe = this.v(ks.forwardPE) ?? this.v(sd.forwardPE) ?? null;
    const mktCap = q.marketCap ?? this.v(sd.marketCap) ?? null;
    const volume = q.regularMarketVolume || null;
    const yld = this.v(sd.dividendYield) ?? (q.trailingAnnualDividendYield || null);
    const fiftyTwoWeekLow = q.fiftyTwoWeekLow ?? this.v(sd.fiftyTwoWeekLow);
    const fiftyTwoWeekHigh = q.fiftyTwoWeekHigh ?? this.v(sd.fiftyTwoWeekHigh);
    const fiftyDayAverage = q.fiftyDayAverage ?? this.v(sd.fiftyDayAverage);
    const twoHundredDayAverage = q.twoHundredDayAverage ?? this.v(sd.twoHundredDayAverage);
    const epsTtm = q.epsTrailingTwelveMonths ?? this.v(earnings.eps);
    const bookValue = q.bookValue ?? this.v(s?.valuation?.bookValue);
    const sharesOutstanding = q.sharesOutstanding ?? this.v(ks.sharesOutstanding);

    const html = `
      <div class="ticker-header">
        <span class="ticker-symbol">${q.symbol || ticker}</span>
        <span class="ticker-name">${q.shortName || q.longName || company.name || ''}</span>
        <span style="flex:1"></span>
        <span class="ticker-price">${PA.Fmt.currency(q.regularMarketPrice)}</span>
        <span class="ticker-change ${changeClass}">${changeSign}${change.toFixed(2)} (${changeSign}${changePct.toFixed(2)}%)</span>
      </div>
      <div style="color:var(--text-muted);font-size:0.8rem;margin-bottom:20px">
        ${q.fullExchangeName || q.exchange || ''} &middot; ${q.currency || 'USD'} &middot;
        Market ${marketLabel}
        ${isCached ? ' &middot; <span>Cached data</span>' : ''}
      </div>

      <div class="grid-5" id="metrics-grid">
        <div class="metric-card">
          <div class="metric-label">Beta</div>
          <div class="metric-value">${beta != null ? PA.Fmt.ratio(beta) : '<span id="metric-beta">--</span>'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">P/E Ratio</div>
          <div class="metric-value">${pe != null ? PA.Fmt.ratio(pe) : 'N/A'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Forward P/E</div>
          <div class="metric-value">${fwdPe != null ? PA.Fmt.ratio(fwdPe) : 'N/A'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Delta</div>
          <div class="metric-value" id="metric-delta">--</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Gamma</div>
          <div class="metric-value" id="metric-gamma">--</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Alpha</div>
          <div class="metric-value" id="metric-alpha">--</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Market Cap</div>
          <div class="metric-value">${mktCap ? '$'+PA.Fmt.compact(mktCap) : 'N/A'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Volume</div>
          <div class="metric-value">${volume ? PA.Fmt.compact(volume) : 'N/A'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Yield</div>
          <div class="metric-value">${yld != null ? PA.Fmt.pct(yld) : 'N/A'}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">52W Range</div>
          <div class="metric-value" style="font-size:0.85rem">
            ${PA.Fmt.currency(fiftyTwoWeekLow,0)} - ${PA.Fmt.currency(fiftyTwoWeekHigh,0)}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">Price History</div>
        <div class="range-selector" id="ticker-ranges"></div>
        <div class="chart-container chart-lg"><canvas id="chart-price"></canvas></div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-title">Drawdown</div>
          <div class="chart-container chart-sm"><canvas id="chart-ticker-dd"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">Additional Stats</div>
          <table class="data-table" id="ticker-stats-table"></table>
        </div>
      </div>

      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn btn-primary" onclick="PA.Portfolio.addFromTicker()">Add to Portfolio</button>
        <button class="btn" onclick="PA.Ticker.addToWatchlist('${ticker}')">Add to Watchlist</button>
      </div>
    `;
    document.getElementById('ticker-content').innerHTML = html;

    // Render range buttons
    const rangeContainer = document.getElementById('ticker-ranges');
    Object.keys(PA.Config.RANGES).forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'range-btn' + (r === this.currentRange ? ' active' : '');
      btn.textContent = r;
      btn.onclick = () => this.changeRange(r);
      rangeContainer.appendChild(btn);
    });

    // Render charts
    if (hData.prices.length > 1) {
      PA.Charts.priceHistory('chart-price', hData.dates, hData.prices, hData.volumes, ticker);
      const dd = PA.Compute.drawdownSeries(hData.prices);
      PA.Charts.drawdown('chart-ticker-dd', hData.dates, dd);
    }

    // Stats table
    const statsTable = document.getElementById('ticker-stats-table');
    const stats = [
      ['EPS (TTM)', PA.Fmt.currency(epsTtm)],
      ['Forward EPS', PA.Fmt.currency(q.epsForward)],
      ['Price/Book', PA.Fmt.ratio(q.priceToBook ?? this.v(sd.priceToBook))],
      ['Book Value', PA.Fmt.currency(bookValue)],
      ['50-Day Avg', PA.Fmt.currency(fiftyDayAverage)],
      ['200-Day Avg', PA.Fmt.currency(twoHundredDayAverage)],
      ['Avg Volume', q.averageDailyVolume3Month ? PA.Fmt.compact(q.averageDailyVolume3Month || q.averageDailyVolume10Day) : 'N/A'],
      ['Shares Out', sharesOutstanding ? PA.Fmt.compact(sharesOutstanding) : 'N/A'],
      ['Ex-Div Date', q.exDividendDate ? this.formatDate(q.exDividendDate) : 'N/A']
    ];
    statsTable.innerHTML = stats.map(([k,v]) =>
      `<tr><td style="font-family:var(--font);color:var(--text-secondary)">${k}</td><td class="right">${v}</td></tr>`
    ).join('');
  },

  v(obj) {
    if (obj == null) return null;
    if (typeof obj === 'object' && 'raw' in obj) return obj.raw;
    if (typeof obj === 'number') return obj;
    return null;
  },

  formatDate(value) {
    if (!value) return 'N/A';
    if (typeof value === 'number') return new Date(value * 1000).toLocaleDateString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
  },

  async computeGreeks(ticker) {
    try {
      const historyMap = await PA.API.getHistories([ticker, 'SPY'], this.currentRange);
      const stockHist = historyMap[ticker];
      const spyHist = historyMap.SPY;
      const stockData = PA.API.parseHistory(stockHist);
      const spyData = PA.API.parseHistory(spyHist);
      if (stockData.prices.length < 20 || spyData.prices.length < 20) return;

      const sReturns = PA.Compute.dailyReturns(stockData.prices);
      const mReturns = PA.Compute.dailyReturns(spyData.prices);

      const b = PA.Compute.beta(sReturns, mReturns);
      const a = PA.Compute.alpha(sReturns, mReturns);
      const d = PA.Compute.delta(stockData.prices, spyData.prices);
      const g = PA.Compute.gamma(stockData.prices, spyData.prices);

      const setEl = (id, val, dec=4) => {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = PA.Fmt.ratio(val, dec);
          el.className = PA.Fmt.colorClass(val);
        }
      };
      setEl('metric-beta', b, 2);
      setEl('metric-delta', d, 3);
      setEl('metric-gamma', g, 4);
      setEl('metric-alpha', a, 4);

      // Save to DB
      PA.DB.exec(`INSERT OR REPLACE INTO greeks(ticker,alpha,beta,delta,gamma,sharpe_ratio,sortino_ratio,std_dev,max_drawdown,calc_period)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [
        ticker, a, b, d, g,
        PA.Compute.sharpeRatio(sReturns),
        PA.Compute.sortinoRatio(sReturns),
        PA.Compute.annualizedVolatility(sReturns),
        PA.Compute.maxDrawdown(stockData.prices).maxDD,
        this.currentRange
      ]);
      PA.DB.save();
    } catch(e) { console.warn('Greek calc failed:', e); }
  },

  async changeRange(range) {
    this.currentRange = range;
    if (this.current) {
      let hist = null;
      try {
        hist = await PA.API.getHistory(this.current.ticker, range);
      } catch(e) {
        hist = this.loadHistoryFromDb(this.current.ticker, range);
        if (!hist) throw e;
        PA.UI.toast('Loaded cached history because live API data is unavailable', 'info');
      }
      this.current.hist = hist;
      const hData = PA.API.parseHistory(hist);
      this.applyDerivedStats(this.current.quote, hData);
      // Update range buttons
      document.querySelectorAll('#ticker-ranges .range-btn').forEach(b => {
        b.classList.toggle('active', b.textContent === range);
      });
      if (hData.prices.length > 1) {
        PA.Charts.priceHistory('chart-price', hData.dates, hData.prices, hData.volumes, this.current.ticker);
        const dd = PA.Compute.drawdownSeries(hData.prices);
        PA.Charts.drawdown('chart-ticker-dd', hData.dates, dd);
      }
    }
  },

  saveToDb(ticker, quote, summary, hist) {
    const ks = summary?.defaultKeyStatistics || {};
    const sd = summary?.summaryDetail || {};
    const company = summary?.company || {};
    const earnings = summary?.earnings || {};
    const valuation = summary?.valuation || {};
    const dividends = summary?.dividends || {};
    PA.DB.exec(`INSERT OR REPLACE INTO securities(ticker,name,sector,exchange,asset_type)
      VALUES(?,?,?,?,?)`, [
      ticker, quote.shortName || quote.longName || company.name || '', company.sector || quote.sector || '', quote.exchange || company.exchange || '',
      quote.quoteType === 'ETF' ? 'etf' : 'equity'
    ]);
    PA.DB.exec(`INSERT INTO quotes(ticker,price,open_price,high,low,close_price,prev_close,volume,avg_volume,
      market_cap,beta,pe_ratio,fwd_pe_ratio,eps,fwd_eps,dividend_yield,fifty_two_week_high,fifty_two_week_low,
      fifty_day_avg,two_hundred_day_avg,shares_outstanding,book_value,price_to_book)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      ticker, quote.regularMarketPrice, quote.regularMarketOpen, quote.regularMarketDayHigh,
      quote.regularMarketDayLow, quote.regularMarketPrice, quote.regularMarketPreviousClose,
      quote.regularMarketVolume, quote.averageDailyVolume3Month, quote.marketCap ?? this.v(sd.marketCap) ?? valuation.marketCap,
      this.v(ks.beta) ?? quote.beta, this.v(sd.trailingPE) ?? quote.trailingPE,
      this.v(ks.forwardPE) ?? this.v(sd.forwardPE), quote.epsTrailingTwelveMonths ?? earnings.eps, quote.epsForward,
      this.v(sd.dividendYield) ?? dividends.dividendYield, quote.fiftyTwoWeekHigh ?? this.v(sd.fiftyTwoWeekHigh), quote.fiftyTwoWeekLow ?? this.v(sd.fiftyTwoWeekLow),
      quote.fiftyDayAverage ?? this.v(sd.fiftyDayAverage), quote.twoHundredDayAverage ?? this.v(sd.twoHundredDayAverage), quote.sharesOutstanding ?? this.v(ks.sharesOutstanding),
      quote.bookValue ?? valuation.bookValue, quote.priceToBook ?? this.v(sd.priceToBook)
    ]);
    // Save price history
    if (hist) {
      const hData = PA.API.parseHistory(hist);
      hData.dates.forEach((d, i) => {
        PA.DB.exec(`INSERT OR IGNORE INTO price_history(ticker,date,close_price,adj_close,volume)
          VALUES(?,?,?,?,?)`, [ticker, d, hData.prices[i], hData.prices[i], hData.volumes[i]]);
      });
    }
    PA.DB.save();
  },

  applyDerivedStats(quote, historyData) {
    if (!quote || !historyData) return;
    if (!quote.fiftyDayAverage) {
      quote.fiftyDayAverage = PA.API.averageOfTail(historyData.prices, 50);
    }
    if (!quote.twoHundredDayAverage) {
      quote.twoHundredDayAverage = PA.API.averageOfTail(historyData.prices, 200);
    }
    if (!quote.averageDailyVolume3Month) {
      quote.averageDailyVolume3Month = PA.API.averageOfTail(historyData.volumes, 60);
      quote.averageDailyVolume10Day = quote.averageDailyVolume3Month;
    }
    if ((!quote.fiftyTwoWeekHigh || !quote.fiftyTwoWeekLow) && historyData.prices.length) {
      const trailingYear = historyData.prices.slice(-252);
      if (trailingYear.length) {
        quote.fiftyTwoWeekHigh = quote.fiftyTwoWeekHigh ?? Math.max(...trailingYear);
        quote.fiftyTwoWeekLow = quote.fiftyTwoWeekLow ?? Math.min(...trailingYear);
      }
    }
  },

  loadFromDb(ticker, range='1Y') {
    const security = PA.DB.selectOne(
      `SELECT ticker,name,sector,exchange,asset_type FROM securities WHERE ticker=?`,
      [ticker]
    );
    const quoteRow = PA.DB.selectOne(
      `SELECT * FROM quotes WHERE ticker=? ORDER BY fetched_at DESC LIMIT 1`,
      [ticker]
    );
    const hist = this.loadHistoryFromDb(ticker, range);
    if (!quoteRow || !hist) return null;

    const prevClose = quoteRow.prev_close ?? quoteRow.close_price;
    const price = quoteRow.price ?? quoteRow.close_price;
    const change = prevClose ? price - prevClose : 0;
    const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

    return {
      ticker,
      quote: {
        symbol: ticker,
        shortName: security?.name || ticker,
        longName: security?.name || ticker,
        regularMarketPrice: price,
        regularMarketChange: change,
        regularMarketChangePercent: changePct,
        regularMarketPreviousClose: prevClose,
        regularMarketOpen: quoteRow.open_price,
        regularMarketDayHigh: quoteRow.high,
        regularMarketDayLow: quoteRow.low,
        regularMarketVolume: quoteRow.volume,
        averageDailyVolume3Month: quoteRow.avg_volume,
        averageDailyVolume10Day: quoteRow.avg_volume,
        marketCap: quoteRow.market_cap,
        trailingPE: quoteRow.pe_ratio,
        forwardPE: quoteRow.fwd_pe_ratio,
        trailingAnnualDividendYield: quoteRow.dividend_yield,
        dividendRate: quoteRow.dividend_rate,
        epsTrailingTwelveMonths: quoteRow.eps,
        epsForward: quoteRow.fwd_eps,
        priceToBook: quoteRow.price_to_book,
        bookValue: quoteRow.book_value,
        sharesOutstanding: quoteRow.shares_outstanding,
        fiftyTwoWeekHigh: quoteRow.fifty_two_week_high,
        fiftyTwoWeekLow: quoteRow.fifty_two_week_low,
        fiftyDayAverage: quoteRow.fifty_day_avg,
        twoHundredDayAverage: quoteRow.two_hundred_day_avg,
        exDividendDate: quoteRow.ex_dividend_date,
        marketState: 'UNKNOWN',
        currency: 'USD',
        exchange: security?.exchange || '',
        fullExchangeName: security?.exchange || '',
        quoteType: security?.asset_type === 'etf' ? 'ETF' : 'EQUITY'
      },
      hist,
      summary: {}
    };
  },

  loadHistoryFromDb(ticker, range='1Y') {
    const cfg = PA.Config.RANGES[range] || PA.Config.RANGES['1Y'];
    const rows = PA.DB.selectAll(
      `SELECT date, COALESCE(adj_close, close_price) AS close_price, volume
       FROM price_history
       WHERE ticker=?
       ORDER BY date ASC`,
      [ticker]
    );
    if (!rows.length) return null;
    let filtered = rows;
    if (cfg.mode === 'ytd') {
      const year = new Date().getFullYear().toString();
      filtered = rows.filter(row => String(row.date).startsWith(year));
    } else if (cfg.points) {
      filtered = rows.slice(-cfg.points);
    }
    if (!filtered.length) return null;
    return {
      ticker,
      rangeKey: range,
      dates: filtered.map(row => row.date),
      prices: filtered.map(row => Number(row.close_price)),
      volumes: filtered.map(row => Number(row.volume || 0))
    };
  },

  addToWatchlist(ticker) {
    PA.DB.exec(`INSERT OR IGNORE INTO watchlist(ticker) VALUES(?)`, [ticker]);
    PA.DB.save();
    PA.UI.toast(`${ticker} added to watchlist`, 'success');
    PA.Dashboard.loadWatchlist();
  }
};

/* ---- Portfolio Manager ---- */
PA.Portfolio = {
  holdings: [],
  currentId: null,

  init() {
    this.loadFromDb();
    this.render();
  },

  addHolding(ticker, allocation) {
    ticker = ticker.toUpperCase().trim();
    if (!ticker) return;
    allocation = parseFloat(allocation) || 0;
    const existing = this.holdings.find(h => h.ticker === ticker);
    if (existing) {
      existing.allocation = allocation;
    } else {
      this.holdings.push({ ticker, allocation });
    }
    this.render();
  },

  removeHolding(ticker) {
    this.holdings = this.holdings.filter(h => h.ticker !== ticker);
    this.render();
  },

  addFromTicker() {
    if (!PA.Ticker.current) return;
    const ticker = PA.Ticker.current.ticker;
    const alloc = prompt(`Enter allocation % for ${ticker}:`, '10');
    if (alloc !== null) {
      this.addHolding(ticker, parseFloat(alloc));
      PA.UI.showTab('portfolio');
      PA.UI.toast(`${ticker} added to portfolio`, 'success');
    }
  },

  getTotalAllocation() {
    return this.holdings.reduce((s, h) => s + h.allocation, 0);
  },

  render() {
    const container = document.getElementById('portfolio-holdings');
    const total = this.getTotalAllocation();
    const allocColor = total > 100 ? 'var(--red)' : total === 100 ? 'var(--green)' : 'var(--yellow)';

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div>
          <span style="font-size:0.85rem;color:var(--text-secondary)">Total Allocation:</span>
          <span style="font-weight:700;color:${allocColor};margin-left:8px;font-family:var(--font-mono)">${total.toFixed(1)}%</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" onclick="PA.Portfolio.normalize()">Normalize to 100%</button>
          <button class="btn btn-sm btn-primary" onclick="PA.Portfolio.saveDialog()">Save Portfolio</button>
        </div>
      </div>
      <div class="alloc-bar"><div class="alloc-fill" style="width:${Math.min(total,100)}%;background:${allocColor}"></div></div>
    `;

    if (this.holdings.length === 0) {
      html += `<div class="empty-state" style="padding:30px"><h3>No holdings yet</h3><p>Search for a ticker and add it, or use the form below.</p></div>`;
    } else {
      html += `<table class="data-table"><thead><tr>
        <th>Ticker</th><th>Name</th><th class="right">Allocation %</th><th class="right">Actions</th>
      </tr></thead><tbody>`;
      this.holdings.forEach(h => {
        const sec = PA.DB.selectOne(`SELECT name FROM securities WHERE ticker=?`, [h.ticker]);
        html += `<tr>
          <td style="color:var(--accent);font-weight:600;cursor:pointer" onclick="PA.Ticker.lookup('${h.ticker}');PA.UI.showTab('ticker')">${h.ticker}</td>
          <td style="font-family:var(--font);color:var(--text-secondary)">${sec?.name || ''}</td>
          <td class="right">
            <input type="number" value="${h.allocation}" min="0" max="100" step="0.1"
              style="width:70px;text-align:right;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);padding:4px 6px;font-family:var(--font-mono)"
              onchange="PA.Portfolio.updateAllocation('${h.ticker}',this.value)">
          </td>
          <td class="right">
            <button class="btn btn-sm btn-danger" onclick="PA.Portfolio.removeHolding('${h.ticker}')">Remove</button>
          </td>
        </tr>`;
      });
      html += `</tbody></table>`;
    }

    // Add ticker form
    html += `
      <div style="display:flex;gap:8px;margin-top:16px;align-items:end">
        <div class="form-group" style="flex:1;margin:0">
          <label class="form-label">Ticker</label>
          <input class="form-input" id="port-add-ticker" placeholder="e.g. AAPL" style="text-transform:uppercase">
        </div>
        <div class="form-group" style="width:100px;margin:0">
          <label class="form-label">Allocation %</label>
          <input class="form-input" id="port-add-alloc" type="number" value="10" min="0" max="100" step="0.1">
        </div>
        <button class="btn btn-primary" onclick="PA.Portfolio.addFromForm()" style="height:36px">Add</button>
      </div>
    `;
    container.innerHTML = html;

    // Update pie chart
    if (this.holdings.length > 0) {
      PA.Charts.pie('chart-allocation',
        this.holdings.map(h => h.ticker),
        this.holdings.map(h => h.allocation)
      );
    }
  },

  addFromForm() {
    const ticker = document.getElementById('port-add-ticker').value;
    const alloc = document.getElementById('port-add-alloc').value;
    if (ticker) {
      this.addHolding(ticker, alloc);
      document.getElementById('port-add-ticker').value = '';
    }
  },

  updateAllocation(ticker, value) {
    const h = this.holdings.find(h => h.ticker === ticker);
    if (h) { h.allocation = parseFloat(value) || 0; this.render(); }
  },

  normalize() {
    const total = this.getTotalAllocation();
    if (total === 0) return;
    this.holdings.forEach(h => { h.allocation = (h.allocation / total) * 100; });
    this.render();
  },

  saveDialog() {
    const name = prompt('Portfolio name:', 'My Portfolio');
    if (!name) return;
    this.save(name);
  },

  save(name) {
    PA.DB.exec(`INSERT INTO portfolios(name, benchmark, initial_balance) VALUES(?,?,?)`,
      [name, 'SPY', 10000]);
    const row = PA.DB.selectOne(`SELECT last_insert_rowid() as id`);
    const pid = row.id;
    this.holdings.forEach(h => {
      PA.DB.exec(`INSERT INTO portfolio_holdings(portfolio_id, ticker, allocation) VALUES(?,?,?)`,
        [pid, h.ticker, h.allocation]);
    });
    this.currentId = pid;
    PA.DB.save();
    PA.UI.toast(`Portfolio "${name}" saved`, 'success');
    this.loadSavedList();
  },

  loadFromDb() {
    const saved = PA.DB.selectAll(`SELECT * FROM portfolios ORDER BY created_at DESC LIMIT 1`);
    if (saved.length) {
      this.currentId = saved[0].id;
      const holdings = PA.DB.selectAll(`SELECT * FROM portfolio_holdings WHERE portfolio_id=?`, [this.currentId]);
      this.holdings = holdings.map(h => ({ ticker: h.ticker, allocation: h.allocation }));
    }
  },

  loadPortfolio(id) {
    const holdings = PA.DB.selectAll(`SELECT * FROM portfolio_holdings WHERE portfolio_id=?`, [id]);
    this.holdings = holdings.map(h => ({ ticker: h.ticker, allocation: h.allocation }));
    this.currentId = id;
    this.render();
    PA.UI.toast('Portfolio loaded', 'success');
  },

  loadSavedList() {
    const list = PA.DB.selectAll(`SELECT * FROM portfolios ORDER BY created_at DESC`);
    const container = document.getElementById('saved-portfolios');
    if (!container) return;
    if (list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);padding:10px">No saved portfolios</div>';
      return;
    }
    container.innerHTML = list.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:600">${p.name}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">${p.created_at || ''}</div>
        </div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" onclick="PA.Portfolio.loadPortfolio(${p.id})">Load</button>
          <button class="btn btn-sm btn-danger" onclick="PA.Portfolio.deletePortfolio(${p.id})">Del</button>
        </div>
      </div>
    `).join('');
  },

  deletePortfolio(id) {
    PA.DB.exec(`DELETE FROM portfolios WHERE id=?`, [id]);
    PA.DB.exec(`DELETE FROM portfolio_holdings WHERE portfolio_id=?`, [id]);
    PA.DB.save();
    this.loadSavedList();
    PA.UI.toast('Portfolio deleted', 'info');
  }
};
