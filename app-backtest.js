/* ============================================================
   Portfolio Analyzer Pro - Backtest & Compare & Dashboard
   ============================================================ */

/* ---- Backtesting Engine ---- */
PA.Backtest = {
  async run() {
    const holdings = PA.Portfolio.holdings;
    if (holdings.length === 0) {
      PA.UI.toast('Add holdings to portfolio first', 'error');
      return;
    }
    const total = PA.Portfolio.getTotalAllocation();
    if (total === 0) { PA.UI.toast('Set allocations first', 'error'); return; }

    const resultsDiv = document.getElementById('backtest-results');
    PA.UI.loading(resultsDiv);
    resultsDiv.style.display = 'block';

    const benchmark = document.getElementById('bt-benchmark')?.value || 'SPY';
    const range = document.getElementById('bt-range')?.value || '5Y';
    const initial = parseFloat(document.getElementById('bt-initial')?.value) || 10000;

    try {
      // Fetch all histories in parallel
      const tickers = [...holdings.map(h => h.ticker), benchmark];
      const unique = [...new Set(tickers)];
      const histories = await PA.API.getHistories(unique, range);
      const dataMap = {};
      unique.forEach(t => { dataMap[t] = PA.API.parseHistory(histories[t]); });

      // Find common date range
      const allDates = unique.map(t => new Set(dataMap[t].dates));
      let commonDates = [...allDates[0]].filter(d => allDates.every(s => s.has(d))).sort();
      if (commonDates.length < 5) {
        resultsDiv.innerHTML = '<div class="empty-state"><h3>Insufficient overlapping data</h3></div>';
        return;
      }

      // Build aligned price arrays
      const aligned = {};
      unique.forEach(t => {
        const dateIdx = {};
        dataMap[t].dates.forEach((d, i) => { dateIdx[d] = i; });
        aligned[t] = commonDates.map(d => dataMap[t].prices[dateIdx[d]]);
      });

      // Compute portfolio daily returns
      const weights = holdings.map(h => h.allocation / total);
      const returnArrays = holdings.map(h => PA.Compute.dailyReturns(aligned[h.ticker]));
      const portReturns = PA.Compute.portfolioReturns(weights, returnArrays);
      const portGrowth = PA.Compute.growthOf(initial, portReturns);
      const bmReturns = PA.Compute.dailyReturns(aligned[benchmark]);
      const bmGrowth = PA.Compute.growthOf(initial, bmReturns);

      // Metrics
      const portAnnRet = PA.Compute.annualizedReturn(portGrowth);
      const portVol = PA.Compute.annualizedVolatility(portReturns);
      const portSharpe = PA.Compute.sharpeRatio(portReturns);
      const portSortino = PA.Compute.sortinoRatio(portReturns);
      const portDD = PA.Compute.maxDrawdown(portGrowth);
      const portDDSeries = PA.Compute.drawdownSeries(portGrowth);

      const bmAnnRet = PA.Compute.annualizedReturn(bmGrowth);
      const bmVol = PA.Compute.annualizedVolatility(bmReturns);
      const bmSharpe = PA.Compute.sharpeRatio(bmReturns);
      const bmSortino = PA.Compute.sortinoRatio(bmReturns);
      const bmDD = PA.Compute.maxDrawdown(bmGrowth);
      const bmDDSeries = PA.Compute.drawdownSeries(bmGrowth);

      const calmar = portDD.maxDD > 0 ? portAnnRet / portDD.maxDD : 0;
      const bmCalmar = bmDD.maxDD > 0 ? bmAnnRet / bmDD.maxDD : 0;

      const finalPort = portGrowth[portGrowth.length-1];
      const finalBm = bmGrowth[bmGrowth.length-1];
      const totalRetPort = (finalPort/initial - 1);
      const totalRetBm = (finalBm/initial - 1);

      resultsDiv.innerHTML = `
        <div class="card">
          <div class="card-title">Performance Summary</div>
          <div class="grid-2">
            <div>
              <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:8px">PORTFOLIO</div>
              <div style="font-size:1.8rem;font-weight:700;font-family:var(--font-mono);color:var(--accent)">${PA.Fmt.currency(finalPort)}</div>
              <div class="metric-sub ${PA.Fmt.colorClass(totalRetPort)}">${totalRetPort>=0?'+':''}${PA.Fmt.pct(totalRetPort)}</div>
            </div>
            <div>
              <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:8px">BENCHMARK (${benchmark})</div>
              <div style="font-size:1.8rem;font-weight:700;font-family:var(--font-mono)">${PA.Fmt.currency(finalBm)}</div>
              <div class="metric-sub ${PA.Fmt.colorClass(totalRetBm)}">${totalRetBm>=0?'+':''}${PA.Fmt.pct(totalRetBm)}</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Key Metrics</div>
          <table class="data-table">
            <thead><tr><th>Metric</th><th class="right">Portfolio</th><th class="right">${benchmark}</th></tr></thead>
            <tbody>
              <tr><td style="font-family:var(--font)">CAGR</td><td class="right ${PA.Fmt.colorClass(portAnnRet)}">${PA.Fmt.pct(portAnnRet)}</td><td class="right ${PA.Fmt.colorClass(bmAnnRet)}">${PA.Fmt.pct(bmAnnRet)}</td></tr>
              <tr><td style="font-family:var(--font)">Volatility</td><td class="right">${PA.Fmt.pct(portVol)}</td><td class="right">${PA.Fmt.pct(bmVol)}</td></tr>
              <tr><td style="font-family:var(--font)">Sharpe Ratio</td><td class="right">${PA.Fmt.ratio(portSharpe)}</td><td class="right">${PA.Fmt.ratio(bmSharpe)}</td></tr>
              <tr><td style="font-family:var(--font)">Sortino Ratio</td><td class="right">${PA.Fmt.ratio(portSortino)}</td><td class="right">${PA.Fmt.ratio(bmSortino)}</td></tr>
              <tr><td style="font-family:var(--font)">Max Drawdown</td><td class="right negative">-${PA.Fmt.pct(portDD.maxDD)}</td><td class="right negative">-${PA.Fmt.pct(bmDD.maxDD)}</td></tr>
              <tr><td style="font-family:var(--font)">Calmar Ratio</td><td class="right">${PA.Fmt.ratio(calmar)}</td><td class="right">${PA.Fmt.ratio(bmCalmar)}</td></tr>
              <tr><td style="font-family:var(--font)">Total Return</td><td class="right ${PA.Fmt.colorClass(totalRetPort)}">${PA.Fmt.pct(totalRetPort)}</td><td class="right ${PA.Fmt.colorClass(totalRetBm)}">${PA.Fmt.pct(totalRetBm)}</td></tr>
              <tr><td style="font-family:var(--font)">Final Value</td><td class="right">${PA.Fmt.currency(finalPort)}</td><td class="right">${PA.Fmt.currency(finalBm)}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-title">Portfolio Growth</div>
          <div class="chart-container chart-lg"><canvas id="chart-bt-growth"></canvas></div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-title">Drawdown</div>
            <div class="chart-container"><canvas id="chart-bt-dd"></canvas></div>
          </div>
          <div class="card">
            <div class="card-title">Annual Returns</div>
            <div class="chart-container"><canvas id="chart-bt-annual"></canvas></div>
          </div>
        </div>
      `;

      // Growth chart
      const growthDates = commonDates.slice(0, portGrowth.length);
      PA.Charts.multiLine('chart-bt-growth', growthDates, [
        { label:'Portfolio', data:portGrowth, color:PA.Config.COLORS[0] },
        { label:benchmark, data:bmGrowth, color:PA.Config.COLORS[2] }
      ]);

      // Drawdown chart
      PA.Charts.multiLine('chart-bt-dd', growthDates, [
        { label:'Portfolio', data:portDDSeries, color:'#f87171' },
        { label:benchmark, data:bmDDSeries, color:'#fbbf24' }
      ], { pct:true });

      // Annual returns
      const monthlyRet = PA.Compute.monthlyReturns(commonDates, portGrowth.slice(0, commonDates.length));
      const annualMap = {};
      monthlyRet.forEach(m => {
        const year = m.month.substring(0,4);
        if (!annualMap[year]) annualMap[year] = 1;
        annualMap[year] *= (1 + m.return);
      });
      const years = Object.keys(annualMap).sort();
      const annualReturns = years.map(y => annualMap[y] - 1);
      PA.Charts.bar('chart-bt-annual', years, [{ label:'Annual Return', data:annualReturns }]);

      PA.UI.toast('Backtest complete', 'success');
    } catch(e) {
      PA.UI.renderError(resultsDiv, 'Backtest Error', e, 'Try fewer tickers or a shorter range if you just hit the free-tier limit.');
    }
  }
};

/* ---- Asset Comparison ---- */
PA.Compare = {
  tickers: [],

  addTicker(ticker) {
    ticker = ticker.toUpperCase().trim();
    if (!ticker || this.tickers.includes(ticker)) return;
    if (this.tickers.length >= 10) { PA.UI.toast('Max 10 tickers', 'error'); return; }
    this.tickers.push(ticker);
    this.renderTags();
  },

  removeTicker(ticker) {
    this.tickers = this.tickers.filter(t => t !== ticker);
    this.renderTags();
  },

  renderTags() {
    const container = document.getElementById('compare-tags');
    container.innerHTML = this.tickers.map(t =>
      `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:20px;font-size:0.85rem">
        <span style="font-weight:600;color:var(--accent)">${t}</span>
        <span style="cursor:pointer;color:var(--text-muted)" onclick="PA.Compare.removeTicker('${t}')">&times;</span>
      </span>`
    ).join(' ');
  },

  async run() {
    if (this.tickers.length < 2) { PA.UI.toast('Add at least 2 tickers', 'error'); return; }
    const resultsDiv = document.getElementById('compare-results');
    PA.UI.loading(resultsDiv);
    resultsDiv.style.display = 'block';

    const range = document.getElementById('cmp-range')?.value || '1Y';

    try {
      const [quotes, histories, spyHistoryMap] = await Promise.all([
        PA.API.getQuote(this.tickers),
        PA.API.getHistories(this.tickers, range),
        PA.API.getHistories(['SPY'], range)
      ]);

      const quoteMap = {};
      (quotes || []).forEach(q => { quoteMap[q.symbol] = q; });

      const dataMap = {};
      this.tickers.forEach(t => { dataMap[t] = PA.API.parseHistory(histories[t]); });

      // SPY benchmark for aligned risk metrics
      const spyData = PA.API.parseHistory(spyHistoryMap.SPY);

      // Build comparison table
      let tableHtml = `<table class="data-table"><thead><tr><th>Metric</th>`;
      this.tickers.forEach(t => { tableHtml += `<th class="right">${t}</th>`; });
      tableHtml += `</tr></thead><tbody>`;

      const rows = [];
      this.tickers.forEach(t => {
        const q = quoteMap[t] || {};
        const d = dataMap[t];
        const returns = PA.Compute.dailyReturns(d.prices);
        const aligned = PA.Compute.alignHistorySeries(d, spyData);
        const alignedReturns = PA.Compute.dailyReturns(aligned.stockPrices);
        const alignedSpyReturns = PA.Compute.dailyReturns(aligned.marketPrices);
        const hasAlignedRisk = aligned.stockPrices.length > 20 && aligned.marketPrices.length > 20;
        rows.push({
          ticker: t,
          price: q.regularMarketPrice,
          change: q.regularMarketChangePercent,
          beta: q.beta ?? null,
          computedBeta: hasAlignedRisk ? PA.Compute.beta(alignedReturns, alignedSpyReturns) : null,
          pe: q.trailingPE ?? null,
          fwdPe: q.forwardPE ?? null,
          delta: hasAlignedRisk ? PA.Compute.delta(aligned.stockPrices, aligned.marketPrices) : null,
          gamma: hasAlignedRisk ? PA.Compute.gamma(aligned.stockPrices, aligned.marketPrices) : null,
          alpha: hasAlignedRisk ? PA.Compute.alpha(alignedReturns, alignedSpyReturns) : null,
          marketCap: q.marketCap ?? null,
          volume: q.regularMarketVolume,
          yield: q.trailingAnnualDividendYield ?? null,
          cagr: PA.Compute.annualizedReturn(d.prices),
          vol: PA.Compute.annualizedVolatility(returns),
          sharpe: PA.Compute.sharpeRatio(returns),
          sortino: PA.Compute.sortinoRatio(returns),
          maxDD: PA.Compute.maxDrawdown(d.prices).maxDD
        });
      });

      const metrics = [
        ['Price', r => PA.Fmt.currency(r.price)],
        ['Change (1D)', r => `<span class="${PA.Fmt.colorClass(r.change)}">${r.change!=null?(r.change>=0?'+':'')+r.change.toFixed(2)+'%':'N/A'}</span>`],
        ['Beta (Provider)', r => PA.Fmt.ratio(r.beta)],
        ['Computed Beta (1Y vs SPY)', r => PA.Fmt.ratio(r.computedBeta)],
        ['P/E', r => PA.Fmt.ratio(r.pe)],
        ['Fwd P/E', r => PA.Fmt.ratio(r.fwdPe)],
        ['Computed Delta (1Y)', r => PA.Fmt.ratio(r.delta, 3)],
        ['Computed Gamma (1Y)', r => PA.Fmt.ratio(r.gamma, 4)],
        ['Computed Alpha (1Y)', r => `<span class="${PA.Fmt.colorClass(r.alpha)}">${PA.Fmt.ratio(r.alpha, 4)}</span>`],
        ['Market Cap', r => r.marketCap ? '$'+PA.Fmt.compact(r.marketCap) : 'N/A'],
        ['Volume', r => r.volume ? PA.Fmt.compact(r.volume) : 'N/A'],
        ['Yield', r => r.yield != null ? PA.Fmt.pct(r.yield) : 'N/A'],
        ['CAGR', r => `<span class="${PA.Fmt.colorClass(r.cagr)}">${PA.Fmt.pct(r.cagr)}</span>`],
        ['Volatility', r => PA.Fmt.pct(r.vol)],
        ['Sharpe', r => PA.Fmt.ratio(r.sharpe)],
        ['Sortino', r => PA.Fmt.ratio(r.sortino)],
        ['Max Drawdown', r => `<span class="negative">-${PA.Fmt.pct(r.maxDD)}</span>`]
      ];

      metrics.forEach(([label, fmt]) => {
        tableHtml += `<tr><td style="font-family:var(--font);color:var(--text-secondary)">${label}</td>`;
        rows.forEach(r => { tableHtml += `<td class="right">${fmt(r)}</td>`; });
        tableHtml += `</tr>`;
      });
      tableHtml += `</tbody></table>`;

      // Normalized price chart
      const allDates = this.tickers.map(t => new Set(dataMap[t].dates));
      let common = [...allDates[0]].filter(d => allDates.every(s => s.has(d))).sort();

      const normalizedDS = this.tickers.map((t, i) => {
        const dateIdx = {};
        dataMap[t].dates.forEach((d, j) => { dateIdx[d] = j; });
        const prices = common.map(d => dataMap[t].prices[dateIdx[d]]);
        const base = prices[0] || 1;
        return { label: t, data: prices.map(p => (p/base)*100), color: PA.Config.COLORS[i] };
      });

      // Correlation matrix
      const returnMap = {};
      this.tickers.forEach(t => {
        const dateIdx = {};
        dataMap[t].dates.forEach((d, j) => { dateIdx[d] = j; });
        const prices = common.map(d => dataMap[t].prices[dateIdx[d]]);
        returnMap[t] = PA.Compute.dailyReturns(prices);
      });

      let corrHtml = '<div style="overflow-x:auto"><div style="display:inline-block"><div>';
      corrHtml += '<span class="heatmap-label"></span>';
      this.tickers.forEach(t => { corrHtml += `<span class="heatmap-label">${t}</span>`; });
      corrHtml += '</div>';
      this.tickers.forEach((t1, i) => {
        corrHtml += `<div><span class="heatmap-label">${t1}</span>`;
        this.tickers.forEach((t2, j) => {
          const corr = i === j ? 1 : PA.Compute.correlation(returnMap[t1], returnMap[t2]);
          const r = Math.round(corr * 127 + 128);
          const b = Math.round(128 - corr * 127);
          corrHtml += `<span class="heatmap-cell" style="background:rgb(${corr<0?b:40},${corr>0?r/2:40},${corr<0?b:40});color:#fff">${corr.toFixed(2)}</span>`;
        });
        corrHtml += '</div>';
      });
      corrHtml += '</div></div>';

      // Risk/Return scatter
      const scatterPoints = rows.map(r => ({
        label: r.ticker, x: r.vol, y: r.cagr
      }));

      resultsDiv.innerHTML = `
        <div class="card"><div class="card-title">Comparison Table</div>${tableHtml}</div>
        <div class="card"><div class="card-title">Normalized Performance (Base=100)</div>
          <div class="chart-container chart-lg"><canvas id="chart-compare-norm"></canvas></div></div>
        <div class="grid-2">
          <div class="card"><div class="card-title">Correlation Matrix</div>${corrHtml}</div>
          <div class="card"><div class="card-title">Risk / Return</div>
            <div class="chart-container"><canvas id="chart-compare-scatter"></canvas></div></div>
        </div>
      `;

      PA.Charts.multiLine('chart-compare-norm', common, normalizedDS);
      PA.Charts.scatter('chart-compare-scatter', scatterPoints);
      PA.UI.toast('Comparison complete', 'success');
    } catch(e) {
      PA.UI.renderError(resultsDiv, 'Comparison Error', e, 'Try 2-3 tickers first so we can isolate the failing request path.');
    }
  }
};

/* ---- Dashboard ---- */
PA.Dashboard = {
  async init() {
    this.loadWatchlist();
    this.loadRecentQuotes();
    const container = document.getElementById('dash-market');
    if (!container) return;
    container.innerHTML = `
      <div style="padding:10px;color:var(--text-muted)">
        Market overview is manual in ${PA.Config.APP_VERSION} so the page does not spam the local yfinance backend on every refresh.
        <div style="margin-top:10px">
          <button class="btn btn-sm" onclick="PA.Dashboard.loadMarketOverview()">Load Market Overview</button>
        </div>
      </div>
    `;
  },

  async loadMarketOverview() {
    const container = document.getElementById('dash-market');
    if (!container) return;
    try {
      const indices = ['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'GLD'];
      const quotes = await PA.API.getQuote(indices);
      container.innerHTML = quotes.map(q => {
        const change = q.regularMarketChangePercent || 0;
        const cls = change >= 0 ? 'positive' : 'negative';
        const sign = change >= 0 ? '+' : '';
        return `<div class="metric-card" style="cursor:pointer" onclick="PA.Ticker.lookup('${q.symbol}');PA.UI.showTab('ticker')">
          <div class="metric-label">${q.symbol}</div>
          <div class="metric-value" style="font-size:1.1rem">${PA.Fmt.currency(q.regularMarketPrice)}</div>
          <div class="metric-sub ${cls}">${sign}${change.toFixed(2)}%</div>
        </div>`;
      }).join('');
    } catch (e) {
      container.innerHTML = `
        <div style="color:var(--text-muted);padding:10px">
          Unable to load live market overview right now.
          <div style="margin-top:8px;font-size:0.8rem">${PA.UI.escapeHtml(PA.UI.errorText(e))}</div>
        </div>
      `;
      if (PA.App?.refreshDiagnostics) {
        PA.App.refreshDiagnostics();
      }
    }
  },

  loadWatchlist() {
    const items = PA.DB.selectAll(`SELECT w.ticker, s.name FROM watchlist w LEFT JOIN securities s ON w.ticker=s.ticker ORDER BY w.added_at DESC`);
    const container = document.getElementById('dash-watchlist');
    if (!container) return;
    if (items.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);padding:10px">Watchlist empty. Search and add tickers.</div>';
      return;
    }
    container.innerHTML = items.map(w => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--accent);font-weight:600;cursor:pointer" onclick="PA.Ticker.lookup('${w.ticker}');PA.UI.showTab('ticker')">${w.ticker}</span>
        <span style="color:var(--text-secondary);font-size:0.85rem">${w.name||''}</span>
        <button class="btn btn-sm" onclick="PA.DB.exec('DELETE FROM watchlist WHERE ticker=?',['${w.ticker}']);PA.DB.save();PA.Dashboard.loadWatchlist()">Remove</button>
      </div>
    `).join('');
  },

  loadRecentQuotes() {
    const quotes = PA.DB.selectAll(`SELECT ticker,price,pe_ratio,market_cap,volume,fetched_at FROM quotes ORDER BY fetched_at DESC LIMIT 10`);
    const container = document.getElementById('dash-recent');
    if (!container) return;
    if (quotes.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);padding:10px">No recent lookups. Search for a ticker to get started.</div>';
      return;
    }
    let html = `<table class="data-table"><thead><tr><th>Ticker</th><th class="right">Price</th><th class="right">P/E</th><th class="right">Mkt Cap</th><th class="right">When</th></tr></thead><tbody>`;
    quotes.forEach(q => {
      html += `<tr>
        <td style="color:var(--accent);cursor:pointer;font-weight:600" onclick="PA.Ticker.lookup('${q.ticker}');PA.UI.showTab('ticker')">${q.ticker}</td>
        <td class="right">${PA.Fmt.currency(q.price)}</td>
        <td class="right">${PA.Fmt.ratio(q.pe_ratio)}</td>
        <td class="right">${q.market_cap ? '$'+PA.Fmt.compact(q.market_cap) : 'N/A'}</td>
        <td class="right" style="font-size:0.75rem;color:var(--text-muted)">${q.fetched_at||''}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
  }
};
