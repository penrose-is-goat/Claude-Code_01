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
      // Fetch quote and history in parallel
      const [quotes, history] = await Promise.allSettled([
        PA.API.getQuote([ticker]),
        PA.API.getHistory(ticker, this.currentRange)
      ]);
      const quote = quotes.status === 'fulfilled' ? (quotes.value[0] || null) : null;
      const hist = history.status === 'fulfilled' ? history.value : null;

      if (!quote) {
        const isSample = !PA.API.hasApiKey();
        document.getElementById('ticker-content').innerHTML =
          '<div class="empty-state"><h3>Ticker "' + ticker + '" not found</h3><p>' +
          (isSample ? 'In demo mode, only 28 popular tickers are available. Add a free API key in Settings to search any ticker.' : 'Please check the symbol and try again.') +
          '</p></div>';
        return;
      }
      this.current = { ticker, quote, hist };
      this.render();
      this.saveToDb(ticker, quote, hist);
    } catch(e) {
      let msg = e.message;
      if (msg === 'INVALID_API_KEY') msg = 'Invalid API key. Please check your key in Settings.';
      else if (msg === 'RATE_LIMITED') msg = 'API rate limit reached. Free tier allows 250 requests/day. Try again later.';
      document.getElementById('ticker-content').innerHTML =
        '<div class="empty-state"><h3>Error loading data</h3><p>' + msg + '</p></div>';
    }
  },

  render() {
    if (!this.current) return;
    const { ticker, quote: q, hist } = this.current;

    const change = q.regularMarketChange || 0;
    const changePct = q.regularMarketChangePercent || 0;
    const changeClass = change >= 0 ? 'positive' : 'negative';
    const changeSign = change >= 0 ? '+' : '';

    // Get history data
    const hData = hist || { dates:[], prices:[], volumes:[] };
    // Async compute Greeks
    if (hData.prices.length > 30) {
      this.computeGreeks(ticker);
    }

    // Extract values directly from normalized quote
    const beta = q.beta;
    const pe = q.trailingPE;
    const fwdPe = q.forwardPE;
    const mktCap = q.marketCap;
    const volume = q.regularMarketVolume;
    const yld = q.trailingAnnualDividendYield;

    const sampleBadge = q._isSampleData ? '<span style="background:var(--yellow);color:#000;padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:700;margin-left:8px">DEMO DATA</span>' : '';

    const html = `
      <div class="ticker-header">
        <span class="ticker-symbol">${q.symbol || ticker}</span>
        <span class="ticker-name">${q.shortName || q.longName || ''}${sampleBadge}</span>
        <span style="flex:1"></span>
        <span class="ticker-price">${PA.Fmt.currency(q.regularMarketPrice)}</span>
        <span class="ticker-change ${changeClass}">${changeSign}${change.toFixed(2)} (${changeSign}${changePct.toFixed(2)}%)</span>
      </div>
      <div style="color:var(--text-muted);font-size:0.8rem;margin-bottom:20px">
        ${q.exchange || ''} &middot; ${q.currency || 'USD'} &middot;
        Market ${q.marketState === 'REGULAR' ? '<span class="positive">Open</span>' : '<span class="negative">Closed</span>'}
        ${q._isSampleData ? ' &middot; <span style="color:var(--yellow)">Add a free API key in Settings for live data</span>' : ''}
      </div>

      <div class="grid-5" id="metrics-grid">
        <div class="metric-card">
          <div class="metric-label">Beta</div>
          <div class="metric-value" id="metric-beta">${beta != null ? PA.Fmt.ratio(beta) : '--'}</div>
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
            ${PA.Fmt.currency(q.fiftyTwoWeekLow,0)} - ${PA.Fmt.currency(q.fiftyTwoWeekHigh,0)}
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
    Object.keys(PA.Config.RANGE_DAYS).forEach(r => {
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
      ['EPS (TTM)', PA.Fmt.currency(q.epsTrailingTwelveMonths)],
      ['Forward EPS', PA.Fmt.currency(q.epsForward)],
      ['Price/Book', PA.Fmt.ratio(q.priceToBook)],
      ['50-Day Avg', PA.Fmt.currency(q.fiftyDayAverage)],
      ['200-Day Avg', PA.Fmt.currency(q.twoHundredDayAverage)],
      ['Avg Volume', q.averageDailyVolume3Month ? PA.Fmt.compact(q.averageDailyVolume3Month) : 'N/A'],
      ['Shares Out', q.sharesOutstanding ? PA.Fmt.compact(q.sharesOutstanding) : 'N/A']
    ];
    statsTable.innerHTML = stats.map(([k,v]) =>
      '<tr><td style="font-family:var(--font);color:var(--text-secondary)">' + k + '</td><td class="right">' + v + '</td></tr>'
    ).join('');
  },

  async computeGreeks(ticker) {
    try {
      // Fetch SPY history for same range
      const spyHist = await PA.API.getHistory('SPY', this.currentRange);
      const stockData = this.current.hist || { dates:[], prices:[], volumes:[] };
      const spyData = spyHist || { dates:[], prices:[], volumes:[] };
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
      const hist = await PA.API.getHistory(this.current.ticker, range);
      this.current.hist = hist;
      const hData = hist || { dates:[], prices:[], volumes:[] };
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

  saveToDb(ticker, quote, hist) {
    PA.DB.exec(`INSERT OR REPLACE INTO securities(ticker,name,sector,exchange,asset_type)
      VALUES(?,?,?,?,?)`, [
      ticker, quote.shortName || quote.longName || '', '', quote.exchange || '', 'equity'
    ]);
    PA.DB.exec(`INSERT INTO quotes(ticker,price,open_price,high,low,close_price,prev_close,volume,avg_volume,
      market_cap,beta,pe_ratio,fwd_pe_ratio,eps,fwd_eps,dividend_yield,fifty_two_week_high,fifty_two_week_low,
      fifty_day_avg,two_hundred_day_avg,shares_outstanding,book_value,price_to_book)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      ticker, quote.regularMarketPrice, quote.regularMarketOpen, quote.regularMarketDayHigh,
      quote.regularMarketDayLow, quote.regularMarketPrice, quote.regularMarketPreviousClose,
      quote.regularMarketVolume, quote.averageDailyVolume3Month, quote.marketCap,
      quote.beta, quote.trailingPE, quote.forwardPE, quote.epsTrailingTwelveMonths, quote.epsForward,
      quote.trailingAnnualDividendYield, quote.fiftyTwoWeekHigh, quote.fiftyTwoWeekLow,
      quote.fiftyDayAverage, quote.twoHundredDayAverage, quote.sharesOutstanding,
      quote.bookValue, quote.priceToBook
    ]);
    // Save price history
    if (hist && hist.dates) {
      hist.dates.forEach((d, i) => {
        PA.DB.exec(`INSERT OR IGNORE INTO price_history(ticker,date,close_price,adj_close,volume)
          VALUES(?,?,?,?,?)`, [ticker, d, hist.prices[i], hist.prices[i], hist.volumes[i]]);
      });
    }
    PA.DB.save();
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
