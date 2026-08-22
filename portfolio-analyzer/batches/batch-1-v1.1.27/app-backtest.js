/* ============================================================
   Portfolio Analyzer Pro - Backtest & Compare & Dashboard
   ============================================================ */

/* ---- Backtesting Engine ---- */
PA.Backtest = {
  init() {
    this.syncPortfolioOptions();
  },

  getSelectedPortfolioId() {
    const raw = document.getElementById('bt-portfolio')?.value || 'CURRENT';
    return raw === 'CURRENT' ? null : Number(raw);
  },

  getActivePortfolioSnapshot() {
    const portfolioId = this.getSelectedPortfolioId();
    const holdings = PA.Portfolio.getPortfolioHoldingsById(portfolioId);
    const row = portfolioId
      ? PA.DB.selectOne(`SELECT benchmark FROM portfolios WHERE id=?`, [portfolioId])
      : null;
    const name = portfolioId
      ? PA.Portfolio.getPortfolioNameById(portfolioId)
      : (PA.Portfolio.currentName || 'Current Working Portfolio');
    return { portfolioId, name, holdings, benchmark: row?.benchmark || 'SPY' };
  },

  intersectDates(dateArrays) {
    if (!dateArrays?.length) return [];
    let shared = new Set(dateArrays[0] || []);
    for (let i = 1; i < dateArrays.length; i++) {
      const next = new Set(dateArrays[i] || []);
      shared = new Set([...shared].filter(date => next.has(date)));
    }
    return [...shared].sort();
  },

  alignSeriesToDates(data, dates) {
    const indexByDate = new Map((data?.dates || []).map((date, index) => [date, index]));
    return dates.map(date => data?.prices?.[indexByDate.get(date)]);
  },

  renderSelectedPortfolioSummary() {
    const container = document.getElementById('bt-portfolio-summary');
    if (!container) return;
    const snapshot = this.getActivePortfolioSnapshot();
    const holdingsText = snapshot.holdings.length
      ? snapshot.holdings.map(h => `${h.ticker} ${Number(h.allocation).toFixed(1)}%`).join(', ')
      : 'No holdings selected yet.';
    container.innerHTML = `
      <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px">Backtest Portfolio</div>
      <div style="font-weight:700;color:var(--text-primary);margin-bottom:6px">${PA.UI.escapeHtml(snapshot.name)}</div>
      <div style="font-size:0.82rem;color:var(--text-secondary)">${PA.UI.escapeHtml(holdingsText)}</div>
    `;
  },

  syncPortfolioOptions() {
    const select = document.getElementById('bt-portfolio');
    if (!select) return;
    const saved = PA.Portfolio.getSavedPortfolios();
    const currentValue = select.value || 'CURRENT';
    select.innerHTML = `
      <option value="CURRENT">Current Working Portfolio</option>
      ${saved.map(p => `<option value="${p.id}">${PA.UI.escapeHtml(p.name)}</option>`).join('')}
    `;
    if ([...select.options].some(option => option.value === currentValue)) {
      select.value = currentValue;
    } else if (PA.Portfolio.currentId && [...select.options].some(option => option.value === String(PA.Portfolio.currentId))) {
      select.value = String(PA.Portfolio.currentId);
    } else {
      select.value = 'CURRENT';
    }
    this.renderSelectedPortfolioSummary();
  },

  changePortfolio(value) {
    const select = document.getElementById('bt-portfolio');
    if (select) select.value = value || 'CURRENT';
    this.renderSelectedPortfolioSummary();
  },

  async run() {
    const snapshot = this.getActivePortfolioSnapshot();
    const holdings = snapshot.holdings;
    if (holdings.length === 0) {
      PA.UI.toast('Add holdings to portfolio first', 'error');
      return;
    }
    const total = holdings.reduce((sum, holding) => sum + (parseFloat(holding.allocation) || 0), 0);
    if (total === 0) { PA.UI.toast('Set allocations first', 'error'); return; }

    const resultsDiv = document.getElementById('backtest-results');
    PA.UI.loading(resultsDiv);
    resultsDiv.style.display = 'block';

    const benchmark = document.getElementById('bt-benchmark')?.value || 'SPY';
    const range = document.getElementById('bt-range')?.value || '5Y';
    const initial = parseFloat(document.getElementById('bt-initial')?.value) || 10000;

    try {
      const portfolioTickers = [...new Set(holdings.map(h => h.ticker))];
      const unique = [...new Set([...portfolioTickers, benchmark])];
      const histories = await PA.API.getHistories(unique, range);
      const dataMap = {};
      unique.forEach(t => { dataMap[t] = PA.API.parseHistory(histories[t]); });

      const portfolioDateArrays = portfolioTickers.map(ticker => dataMap[ticker]?.dates || []);
      const portfolioCommonDates = this.intersectDates(portfolioDateArrays);
      const benchmarkDates = new Set(dataMap[benchmark]?.dates || []);
      const commonDates = portfolioCommonDates.filter(date => benchmarkDates.has(date));
      if (commonDates.length < 5) {
        resultsDiv.innerHTML = '<div class="empty-state"><h3>Insufficient overlapping data</h3></div>';
        return;
      }

      const aligned = {};
      unique.forEach(t => {
        aligned[t] = this.alignSeriesToDates(dataMap[t], commonDates);
      });

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
      const growthDates = commonDates.slice(0, portGrowth.length);
      const actualStart = growthDates[0];
      const actualEnd = growthDates[growthDates.length - 1];
      const limitingTicker = portfolioTickers
        .map(ticker => ({ ticker, start: dataMap[ticker]?.dates?.[0] || null }))
        .filter(entry => entry.start)
        .sort((a, b) => a.start.localeCompare(b.start))
        .pop();

      resultsDiv.innerHTML = `
        <div class="card">
          <div class="card-title">Backtest Context</div>
          <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap">
            <div>
              <div style="font-size:0.8rem;color:var(--text-muted)">Portfolio</div>
              <div style="font-weight:700">${PA.UI.escapeHtml(snapshot.name)}</div>
            </div>
            <div>
              <div style="font-size:0.8rem;color:var(--text-muted)">Holdings</div>
              <div style="font-family:var(--font-mono)">${holdings.map(h => `${h.ticker} ${Number(h.allocation).toFixed(1)}%`).join(' | ')}</div>
            </div>
            <div>
              <div style="font-size:0.8rem;color:var(--text-muted)">Requested Period</div>
              <div style="font-family:var(--font-mono)">${range}</div>
            </div>
            <div>
              <div style="font-size:0.8rem;color:var(--text-muted)">Actual Test Window</div>
              <div style="font-family:var(--font-mono)">${actualStart || 'N/A'} to ${actualEnd || 'N/A'}</div>
            </div>
          </div>
          <div style="margin-top:12px;font-size:0.8rem;color:var(--text-muted)">
            Benchmark performance is aligned to the portfolio's actual overlapping date window so the comparison uses the same trading days.
            ${limitingTicker ? ` The current window is being limited by ${limitingTicker.ticker}, whose provider history starts on ${limitingTicker.start}.` : ''}
          </div>
        </div>

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
      const monthlyRet = PA.Compute.monthlyReturns(growthDates, portGrowth);
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
  sourceLabel: 'Manual Entry',

  init() {
    this.syncPortfolioOptions();
    this.syncPortfolioCompareOptions();
    this.renderTags();
  },

  parseTickers(input) {
    return [...new Set(
      String(input || '')
        .split(/[\s,;]+/)
        .map(token => token.trim().toUpperCase())
        .filter(Boolean)
    )];
  },

  addTicker(ticker) {
    ticker = ticker.toUpperCase().trim();
    if (!ticker || this.tickers.includes(ticker)) return;
    if (this.tickers.length >= 15) { PA.UI.toast('Max 15 tickers', 'error'); return; }
    this.tickers.push(ticker);
    this.sourceLabel = 'Manual Entry';
    const select = document.getElementById('cmp-portfolio');
    if (select) select.value = 'NONE';
    this.renderTags();
  },

  addTickersFromInput(input, reset=false) {
    const parsed = this.parseTickers(input);
    if (!parsed.length) {
      PA.UI.toast('Enter at least one ticker', 'error');
      return;
    }
    if (reset) this.tickers = [];
    parsed.forEach(ticker => {
      if (!this.tickers.includes(ticker) && this.tickers.length < 15) {
        this.tickers.push(ticker);
      }
    });
    this.sourceLabel = 'Manual Entry';
    const select = document.getElementById('cmp-portfolio');
    if (select) select.value = 'NONE';
    this.renderTags();
  },

  removeTicker(ticker) {
    this.tickers = this.tickers.filter(t => t !== ticker);
    this.renderTags();
  },

  clear() {
    this.tickers = [];
    this.sourceLabel = 'Manual Entry';
    const input = document.getElementById('cmp-ticker');
    if (input) input.value = '';
    const select = document.getElementById('cmp-portfolio');
    if (select) select.value = 'NONE';
    this.renderTags();
  },

  intersectDates(dateArrays) {
    if (!dateArrays?.length) return [];
    let shared = new Set(dateArrays[0] || []);
    for (let i = 1; i < dateArrays.length; i++) {
      const next = new Set(dateArrays[i] || []);
      shared = new Set([...shared].filter(date => next.has(date)));
    }
    return [...shared].sort();
  },

  alignSeriesToDates(data, dates) {
    const indexByDate = new Map((data?.dates || []).map((date, index) => [date, index]));
    return dates.map(date => data?.prices?.[indexByDate.get(date)]);
  },

  syncPortfolioOptions() {
    const select = document.getElementById('cmp-portfolio');
    if (!select) return;
    const saved = PA.Portfolio.getSavedPortfolios();
    const currentValue = select.value || 'NONE';
    select.innerHTML = `
      <option value="NONE">Manual Entry</option>
      <option value="CURRENT">Current Working Portfolio</option>
      ${saved.map(p => `<option value="${p.id}">${PA.UI.escapeHtml(p.name)}</option>`).join('')}
    `;
    select.value = [...select.options].some(option => option.value === currentValue) ? currentValue : 'NONE';
  },

  syncPortfolioCompareOptions() {
    const select = document.getElementById('cmp-portfolio-compare');
    if (!select) return;
    const saved = PA.Portfolio.getSavedPortfolios();
    const selected = new Set([...select.options].filter(option => option.selected).map(option => option.value));
    select.innerHTML = `
      <option value="CURRENT">Current Working Portfolio</option>
      ${saved.map(p => `<option value="${p.id}">${PA.UI.escapeHtml(p.name)}</option>`).join('')}
    `;
    [...select.options].forEach(option => {
      if (selected.has(option.value)) option.selected = true;
    });
  },

  getSelectedPortfolioCompareValues() {
    const select = document.getElementById('cmp-portfolio-compare');
    if (!select) return [];
    return [...select.selectedOptions].map(option => option.value).filter(Boolean);
  },

  getPortfolioSnapshotByValue(value) {
    if (!value) return null;
    if (value === 'CURRENT') {
      return {
        name: PA.Portfolio.currentName || 'Current Working Portfolio',
        holdings: PA.Portfolio.holdings.map(holding => ({ ...holding })),
        benchmark: 'SPY'
      };
    }
    const row = PA.DB.selectOne(`SELECT id,name,benchmark FROM portfolios WHERE id=?`, [Number(value)]);
    if (!row?.id) return null;
    return {
      id: row.id,
      name: row.name,
      benchmark: row.benchmark || 'SPY',
      holdings: PA.Portfolio.getPortfolioHoldingsById(row.id)
    };
  },

  loadPortfolioSelection(value) {
    if (!value || value === 'NONE') {
      this.sourceLabel = 'Manual Entry';
      this.renderTags();
      return;
    }
    const holdings = value === 'CURRENT'
      ? PA.Portfolio.holdings.map(h => ({ ...h }))
      : PA.Portfolio.getPortfolioHoldingsById(Number(value));
    this.tickers = [...new Set(holdings.map(h => String(h.ticker || '').toUpperCase()).filter(Boolean))].slice(0, 15);
    this.sourceLabel = value === 'CURRENT'
      ? (PA.Portfolio.currentName || 'Current Working Portfolio')
      : (PA.Portfolio.getPortfolioNameById(Number(value)) || 'Saved Portfolio');
    this.renderTags();
  },

  renderTags() {
    const container = document.getElementById('compare-tags');
    if (!container) return;
    const chips = this.tickers.map(t =>
      `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:20px;font-size:0.85rem">
        <span style="font-weight:600;color:var(--accent)">${t}</span>
        <span style="cursor:pointer;color:var(--text-muted)" onclick="PA.Compare.removeTicker('${t}')">&times;</span>
      </span>`
    ).join(' ');
    container.innerHTML = `
      <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px">Source: ${PA.UI.escapeHtml(this.sourceLabel)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;min-height:30px">${chips || '<span style="color:var(--text-muted)">No comparison tickers selected yet.</span>'}</div>
    `;
  },

  buildCorrelationMatrix(labels, returnMap) {
    let html = '<div style="overflow-x:auto"><div style="display:inline-block"><div>';
    html += '<span class="heatmap-label"></span>';
    labels.forEach(label => { html += `<span class="heatmap-label">${PA.UI.escapeHtml(label)}</span>`; });
    html += '</div>';
    labels.forEach((labelA, rowIndex) => {
      html += `<div><span class="heatmap-label">${PA.UI.escapeHtml(labelA)}</span>`;
      labels.forEach((labelB, colIndex) => {
        const corr = rowIndex === colIndex ? 1 : PA.Compute.correlation(returnMap[labelA] || [], returnMap[labelB] || []);
        const safeCorr = Number.isFinite(corr) ? corr : 0;
        const r = Math.round(safeCorr * 127 + 128);
        const b = Math.round(128 - safeCorr * 127);
        html += `<span class="heatmap-cell" style="background:rgb(${safeCorr < 0 ? b : 40},${safeCorr > 0 ? r / 2 : 40},${safeCorr < 0 ? b : 40});color:#fff">${safeCorr.toFixed(2)}</span>`;
      });
      html += '</div>';
    });
    html += '</div></div>';
    return html;
  },

  averagePeerCorrelation(label, labels, returnMap) {
    const peers = labels.filter(peer => peer !== label);
    if (!peers.length) return null;
    const correlations = peers.map(peer => PA.Compute.correlation(returnMap[label] || [], returnMap[peer] || [])).filter(Number.isFinite);
    if (!correlations.length) return null;
    return correlations.reduce((sum, value) => sum + value, 0) / correlations.length;
  },

  buildPortfolioSeries(snapshot, dataMap) {
    const holdings = snapshot?.holdings || [];
    if (!holdings.length) return null;
    const total = holdings.reduce((sum, holding) => sum + (parseFloat(holding.allocation) || 0), 0);
    if (!total) return null;
    const tickers = [...new Set(holdings.map(holding => holding.ticker))];
    const commonDates = this.intersectDates(tickers.map(ticker => dataMap[ticker]?.dates || []));
    if (commonDates.length < 5) return null;
    const aligned = {};
    tickers.forEach(ticker => {
      aligned[ticker] = this.alignSeriesToDates(dataMap[ticker], commonDates);
    });
    const weights = holdings.map(holding => (parseFloat(holding.allocation) || 0) / total);
    const returnArrays = holdings.map(holding => PA.Compute.dailyReturns(aligned[holding.ticker]));
    const returns = PA.Compute.portfolioReturns(weights, returnArrays);
    const growth = PA.Compute.growthOf(100, returns);
    const dates = commonDates.slice(0, growth.length);
    return {
      name: snapshot.name,
      benchmark: snapshot.benchmark || 'SPY',
      holdings,
      dates,
      returns,
      growth,
      totalReturn: growth[growth.length - 1] / 100 - 1,
      cagr: PA.Compute.annualizedReturn(growth),
      vol: PA.Compute.annualizedVolatility(returns),
      sharpe: PA.Compute.sharpeRatio(returns),
      sortino: PA.Compute.sortinoRatio(returns),
      maxDD: PA.Compute.maxDrawdown(growth).maxDD
    };
  },

  async run() {
    if (this.tickers.length < 2) { PA.UI.toast('Add at least 2 tickers', 'error'); return; }
    const resultsDiv = document.getElementById('compare-results');
    PA.UI.loading(resultsDiv);
    resultsDiv.style.display = 'block';

    const range = document.getElementById('cmp-range')?.value || '1Y';

    try {
      const [quotes, histories] = await Promise.all([
        PA.API.getQuote(this.tickers),
        PA.API.getHistories(this.tickers, range)
      ]);

      const quoteMap = {};
      (quotes || []).forEach(q => { quoteMap[q.symbol] = q; });

      const dataMap = {};
      this.tickers.forEach(t => { dataMap[t] = PA.API.parseHistory(histories[t]); });

      const rows = [];
      this.tickers.forEach(t => {
        const q = quoteMap[t] || {};
        const d = dataMap[t];
        const returns = PA.Compute.dailyReturns(d.prices);
        rows.push({
          ticker: t,
          price: q.regularMarketPrice,
          change: q.regularMarketChangePercent,
          beta: q.beta ?? null,
          pe: q.trailingPE ?? null,
          marketCap: q.marketCap ?? null,
          volume: q.regularMarketVolume,
          yield: q.trailingAnnualDividendYield ?? null,
          cagr: PA.Compute.annualizedReturn(d.prices),
          vol: PA.Compute.annualizedVolatility(returns),
          maxDD: PA.Compute.maxDrawdown(d.prices).maxDD
        });
      });

      const metrics = [
        ['Price', r => PA.Fmt.currency(r.price)],
        ['Change (1D)', r => `<span class="${PA.Fmt.colorClass(r.change)}">${r.change!=null?(r.change>=0?'+':'')+r.change.toFixed(2)+'%':'N/A'}</span>`],
        ['Beta (Provider)', r => PA.Fmt.ratio(r.beta)],
        ['P/E', r => PA.Fmt.ratio(r.pe)],
        ['Market Cap', r => r.marketCap ? '$'+PA.Fmt.compact(r.marketCap) : 'N/A'],
        ['Volume', r => r.volume ? PA.Fmt.compact(r.volume) : 'N/A'],
        ['Yield', r => r.yield != null ? PA.Fmt.pct(r.yield) : 'N/A'],
        ['CAGR', r => `<span class="${PA.Fmt.colorClass(r.cagr)}">${PA.Fmt.pct(r.cagr)}</span>`],
        ['Volatility', r => PA.Fmt.pct(r.vol)],
        ['Max Drawdown', r => `<span class="negative">-${PA.Fmt.pct(r.maxDD)}</span>`]
      ];

      let tableHtml = `<table class="data-table compact-table"><thead><tr><th>Metric</th>`;
      this.tickers.forEach(t => { tableHtml += `<th class="right">${t}</th>`; });
      tableHtml += `</tr></thead><tbody>`;

      metrics.forEach(([label, fmt]) => {
        tableHtml += `<tr><td style="font-family:var(--font);color:var(--text-secondary)">${label}</td>`;
        rows.forEach(r => { tableHtml += `<td class="right">${fmt(r)}</td>`; });
        tableHtml += `</tr>`;
      });
      tableHtml += `</tbody></table>`;

      const common = this.intersectDates(this.tickers.map(t => dataMap[t].dates));
      if (common.length < 5) {
        throw new Error('Not enough overlapping history across the selected symbols to compare.');
      }

      const normalizedDS = this.tickers.map((t, i) => {
        const prices = this.alignSeriesToDates(dataMap[t], common);
        const base = prices[0] || 1;
        return { label: t, data: prices.map(p => (p/base)*100), color: PA.Config.COLORS[i] };
      });

      const drawdownDS = this.tickers.map((t, i) => {
        const prices = this.alignSeriesToDates(dataMap[t], common);
        return { label: t, data: PA.Compute.drawdownSeries(prices), color: PA.Config.COLORS[i] };
      });

      const returnMap = {};
      this.tickers.forEach(t => {
        const prices = this.alignSeriesToDates(dataMap[t], common);
        returnMap[t] = PA.Compute.dailyReturns(prices);
      });
      const corrHtml = this.buildCorrelationMatrix(this.tickers, returnMap);

      const scatterPoints = rows.map(r => ({
        label: r.ticker, x: r.vol, y: r.cagr
      }));

      resultsDiv.innerHTML = `
        <div class="card">
          <div class="card-title">Comparison Context</div>
          <div style="font-size:0.85rem;color:var(--text-secondary)">Source: ${PA.UI.escapeHtml(this.sourceLabel)} | Symbols: ${PA.UI.escapeHtml(this.tickers.join(', '))}</div>
        </div>
        <div class="card"><div class="card-title">Normalized Performance (Base=100)</div>
          <div class="chart-container chart-lg"><canvas id="chart-compare-norm"></canvas></div></div>
        <div class="grid-2">
          <div class="card"><div class="card-title">Drawdown Comparison</div>
            <div class="chart-container"><canvas id="chart-compare-dd"></canvas></div></div>
          <div class="card"><div class="card-title">Risk / Return</div>
            <div class="chart-container"><canvas id="chart-compare-scatter"></canvas></div></div>
        </div>
        <div class="grid-2">
          <div class="card"><div class="card-title">Correlation Matrix</div>${corrHtml}</div>
          <div class="card compare-metrics-card"><div class="card-title">Compact Metrics</div>${tableHtml}</div>
        </div>
      `;

      PA.Charts.multiLine('chart-compare-norm', common, normalizedDS);
      PA.Charts.multiLine('chart-compare-dd', common, drawdownDS, { pct:true });
      PA.Charts.scatter('chart-compare-scatter', scatterPoints);
      PA.UI.toast('Comparison complete', 'success');
    } catch(e) {
      PA.UI.renderError(resultsDiv, 'Comparison Error', e, 'Try 2-3 tickers first so we can isolate the failing request path.');
    }
  },

  async runPortfolioComparison() {
    const values = this.getSelectedPortfolioCompareValues();
    if (values.length < 2) {
      PA.UI.toast('Select at least 2 portfolios to compare', 'error');
      return;
    }
    const resultsDiv = document.getElementById('compare-portfolio-results');
    if (!resultsDiv) return;
    PA.UI.loading(resultsDiv);
    resultsDiv.style.display = 'block';

    const range = document.getElementById('cmp-range')?.value || '1Y';

    try {
      const snapshots = values
        .map(value => this.getPortfolioSnapshotByValue(value))
        .filter(snapshot => snapshot?.holdings?.length);
      if (snapshots.length < 2) {
        throw new Error('At least two portfolios with holdings are required for portfolio comparison.');
      }

      const uniqueTickers = [...new Set(snapshots.flatMap(snapshot => snapshot.holdings.map(holding => holding.ticker)))];
      const histories = await PA.API.getHistories(uniqueTickers, range);
      const dataMap = {};
      uniqueTickers.forEach(ticker => { dataMap[ticker] = PA.API.parseHistory(histories[ticker]); });

      const series = snapshots
        .map(snapshot => this.buildPortfolioSeries(snapshot, dataMap))
        .filter(Boolean);
      if (series.length < 2) {
        throw new Error('The selected portfolios do not share enough overlapping history to compare yet.');
      }

      const commonDates = this.intersectDates(series.map(entry => entry.dates));
      if (commonDates.length < 5) {
        throw new Error('The selected portfolios do not share enough overlapping dates to compare.');
      }

      const alignedSeries = series.map((entry, index) => {
        const growthByDate = new Map(entry.dates.map((date, idx) => [date, entry.growth[idx]]));
        const growth = commonDates.map(date => growthByDate.get(date));
        const returns = PA.Compute.dailyReturns(growth);
        return {
          ...entry,
          color: PA.Config.COLORS[index % PA.Config.COLORS.length],
          dates: commonDates,
          growth,
          returns,
          totalReturn: growth[growth.length - 1] / growth[0] - 1,
          cagr: PA.Compute.annualizedReturn(growth),
          vol: PA.Compute.annualizedVolatility(returns),
          sharpe: PA.Compute.sharpeRatio(returns),
          sortino: PA.Compute.sortinoRatio(returns),
          maxDD: PA.Compute.maxDrawdown(growth).maxDD
        };
      });

      const labels = alignedSeries.map(entry => entry.name);
      const returnMap = {};
      alignedSeries.forEach(entry => { returnMap[entry.name] = entry.returns; });
      const corrHtml = this.buildCorrelationMatrix(labels, returnMap);

      let tableHtml = `<table class="data-table compact-table"><thead><tr><th>Metric</th>`;
      labels.forEach(label => { tableHtml += `<th class="right">${PA.UI.escapeHtml(label)}</th>`; });
      tableHtml += `</tr></thead><tbody>`;
      const portfolioMetrics = [
        ['Total Return', entry => `<span class="${PA.Fmt.colorClass(entry.totalReturn)}">${PA.Fmt.pct(entry.totalReturn)}</span>`],
        ['CAGR', entry => `<span class="${PA.Fmt.colorClass(entry.cagr)}">${PA.Fmt.pct(entry.cagr)}</span>`],
        ['Volatility', entry => PA.Fmt.pct(entry.vol)],
        ['Sharpe', entry => PA.Fmt.ratio(entry.sharpe)],
        ['Sortino', entry => PA.Fmt.ratio(entry.sortino)],
        ['Max Drawdown', entry => `<span class="negative">-${PA.Fmt.pct(entry.maxDD)}</span>`],
        ['Avg Corr vs Peers', entry => PA.Fmt.ratio(this.averagePeerCorrelation(entry.name, labels, returnMap))]
      ];
      portfolioMetrics.forEach(([label, formatter]) => {
        tableHtml += `<tr><td style="font-family:var(--font);color:var(--text-secondary)">${label}</td>`;
        alignedSeries.forEach(entry => { tableHtml += `<td class="right">${formatter(entry)}</td>`; });
        tableHtml += `</tr>`;
      });
      tableHtml += `</tbody></table>`;

      const normalizedDS = alignedSeries.map(entry => ({
        label: entry.name,
        data: entry.growth,
        color: entry.color
      }));
      const drawdownDS = alignedSeries.map(entry => ({
        label: entry.name,
        data: PA.Compute.drawdownSeries(entry.growth),
        color: entry.color
      }));
      const scatterPoints = alignedSeries.map(entry => ({
        label: entry.name,
        x: entry.vol,
        y: entry.cagr
      }));

      resultsDiv.innerHTML = `
        <div class="card">
          <div class="card-title">Portfolio Comparison Context</div>
          <div class="compare-subtitle">Portfolios: ${PA.UI.escapeHtml(labels.join(' | '))}</div>
          <div style="font-size:0.82rem;color:var(--text-muted)">Aligned comparison window: ${PA.UI.escapeHtml(commonDates[0])} to ${PA.UI.escapeHtml(commonDates[commonDates.length - 1])}</div>
        </div>
        <div class="card">
          <div class="card-title">Portfolio Growth (Base=100)</div>
          <div class="chart-container chart-lg"><canvas id="chart-portfolio-compare-norm"></canvas></div>
        </div>
        <div class="grid-2">
          <div class="card">
            <div class="card-title">Portfolio Drawdown</div>
            <div class="chart-container"><canvas id="chart-portfolio-compare-dd"></canvas></div>
          </div>
          <div class="card">
            <div class="card-title">Portfolio Risk / Return</div>
            <div class="chart-container"><canvas id="chart-portfolio-compare-scatter"></canvas></div>
          </div>
        </div>
        <div class="grid-2">
          <div class="card"><div class="card-title">Portfolio Correlation Matrix</div>${corrHtml}</div>
          <div class="card compare-metrics-card"><div class="card-title">Portfolio Metrics</div>${tableHtml}</div>
        </div>
      `;

      PA.Charts.multiLine('chart-portfolio-compare-norm', commonDates, normalizedDS);
      PA.Charts.multiLine('chart-portfolio-compare-dd', commonDates, drawdownDS, { pct:true });
      PA.Charts.scatter('chart-portfolio-compare-scatter', scatterPoints);
      PA.UI.toast('Portfolio comparison complete', 'success');
    } catch (e) {
      PA.UI.renderError(resultsDiv, 'Portfolio Comparison Error', e, 'Select at least two saved or default portfolios with enough live history.');
    }
  }
};

/* ---- Dashboard ---- */
PA.Dashboard = {
  heatmapRange: '1D',
  heatmapMode: 'sectors',
  AUTO_REFRESH_MS: 60000,
  refreshTimer: null,
  isLoading: false,
  lastLoadedAt: null,
  heatmapModes: {
    sectors: {
      label: 'S&P 500 Sectors',
      title: 'S&P 500 Sector Heatmap',
      items: [
        { ticker:'XLK', name:'Technology', group:'S&P 500 Sectors' },
        { ticker:'XLF', name:'Financials', group:'S&P 500 Sectors' },
        { ticker:'XLV', name:'Health Care', group:'S&P 500 Sectors' },
        { ticker:'XLY', name:'Consumer Discretionary', group:'S&P 500 Sectors' },
        { ticker:'XLC', name:'Communication Services', group:'S&P 500 Sectors' },
        { ticker:'XLI', name:'Industrials', group:'S&P 500 Sectors' },
        { ticker:'XLP', name:'Consumer Staples', group:'S&P 500 Sectors' },
        { ticker:'XLE', name:'Energy', group:'S&P 500 Sectors' },
        { ticker:'XLU', name:'Utilities', group:'S&P 500 Sectors' },
        { ticker:'XLB', name:'Materials', group:'S&P 500 Sectors' },
        { ticker:'XLRE', name:'Real Estate', group:'S&P 500 Sectors' }
      ]
    },
    indexes: {
      label: 'Major Index ETFs',
      title: 'Major Index ETF Heatmap',
      items: [
        { ticker:'SPY', name:'S&P 500', group:'US Equity' },
        { ticker:'QQQ', name:'Nasdaq 100', group:'US Equity' },
        { ticker:'DIA', name:'Dow Industrials', group:'US Equity' },
        { ticker:'IWM', name:'Russell 2000', group:'US Equity' },
        { ticker:'VTI', name:'Total US Market', group:'US Equity' },
        { ticker:'RSP', name:'Equal Weight S&P 500', group:'US Equity' },
        { ticker:'MDY', name:'S&P MidCap 400', group:'US Equity' },
        { ticker:'IJR', name:'S&P SmallCap 600', group:'US Equity' }
      ]
    },
    assets: {
      label: 'Asset Classes',
      title: 'Asset Class ETF Heatmap',
      items: [
        { ticker:'SPY', name:'S&P 500', group:'US Equity' },
        { ticker:'QQQ', name:'Nasdaq 100', group:'US Equity' },
        { ticker:'DIA', name:'Dow Industrials', group:'US Equity' },
        { ticker:'IWM', name:'Russell 2000', group:'US Equity' },
        { ticker:'VTI', name:'Total US Market', group:'US Equity' },
        { ticker:'EFA', name:'Developed Markets', group:'International' },
        { ticker:'EEM', name:'Emerging Markets', group:'International' },
        { ticker:'TLT', name:'Long Treasuries', group:'Rates' },
        { ticker:'LQD', name:'Investment Grade Credit', group:'Credit' },
        { ticker:'HYG', name:'High Yield Credit', group:'Credit' },
        { ticker:'GLD', name:'Gold', group:'Real Assets' },
        { ticker:'UUP', name:'US Dollar', group:'FX' }
      ]
    }
  },

  currentUniverse() {
    return this.heatmapModes[this.heatmapMode]?.items || this.heatmapModes.sectors.items;
  },

  currentModeLabel() {
    return this.heatmapModes[this.heatmapMode]?.label || this.heatmapModes.sectors.label;
  },

  currentModeTitle() {
    return this.heatmapModes[this.heatmapMode]?.title || this.heatmapModes.sectors.title;
  },

  async init() {
    this.clearAutoRefresh();
    this.loadWatchlist();
    this.loadRecentQuotes();
    const container = document.getElementById('dash-market');
    if (!container) return;
    this.renderPlaceholder();
    await this.loadMarketOverview();
  },

  clearAutoRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  },

  scheduleAutoRefresh() {
    this.clearAutoRefresh();
    this.refreshTimer = setTimeout(() => {
      const dashboardTab = document.getElementById('tab-dashboard');
      if (document.hidden || !dashboardTab?.classList.contains('active')) {
        this.scheduleAutoRefresh();
        return;
      }
      this.loadMarketOverview({ silent: true });
    }, this.AUTO_REFRESH_MS);
  },

  autoRefreshLabel() {
    return `${Math.round(this.AUTO_REFRESH_MS / 1000)} seconds`;
  },

  lastLoadedLabel() {
    return this.lastLoadedAt
      ? this.lastLoadedAt.toLocaleString()
      : 'Not loaded yet';
  },

  renderPlaceholder(message=`Market heatmap auto-refreshes every ${this.autoRefreshLabel()} while the dashboard tab is open.`) {
    const container = document.getElementById('dash-market');
    if (!container) return;
    container.innerHTML = `
      <div class="market-dashboard-stack">
        <div class="market-toolbar">
          <div class="market-note">${PA.UI.escapeHtml(message)}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select class="form-select market-mode-select" onchange="PA.Dashboard.setHeatmapMode(this.value)">
              ${Object.entries(this.heatmapModes).map(([key, mode]) => `
                <option value="${key}" ${key === this.heatmapMode ? 'selected' : ''}>${PA.UI.escapeHtml(mode.label)}</option>
              `).join('')}
            </select>
            <div class="market-timeframe-buttons">
              ${['1D','1W','1M','YTD','1Y','10Y'].map(range => `
                <button class="range-btn ${range === this.heatmapRange ? 'active' : ''}" onclick="PA.Dashboard.setHeatmapRange('${range}')">${range}</button>
              `).join('')}
            </div>
            <button class="btn btn-sm" onclick="PA.Dashboard.loadMarketOverview()">Refresh Now</button>
          </div>
        </div>
      </div>
    `;
  },

  setHeatmapRange(range) {
    this.heatmapRange = range || '1D';
    this.loadMarketOverview();
  },

  setHeatmapMode(mode) {
    if (this.heatmapModes[mode]) {
      this.heatmapMode = mode;
    }
    this.loadMarketOverview();
  },

  requiredHistoryRange(windowKey) {
    switch (windowKey) {
      case '1D': return '5D';
      case '1W': return '1M';
      case '1M': return '3M';
      case 'YTD': return 'YTD';
      case '1Y': return '1Y';
      case '10Y': return '10Y';
      default: return '1Y';
    }
  },

  computeWindowReturn(history, windowKey, quote) {
    if (windowKey === '1D') {
      if (quote?.regularMarketChangePercent != null && !Number.isNaN(quote.regularMarketChangePercent)) {
        return quote.regularMarketChangePercent / 100;
      }
      return PA.Ticker.calculateCalendarReturn(history, 1, 1);
    }
    if (windowKey === '1W') return PA.Ticker.calculateCalendarReturn(history, 7, 4);
    if (windowKey === '1M') return PA.Ticker.calculateCalendarReturn(history, 30, 20);
    if (windowKey === 'YTD') return PA.Ticker.calculateYtdReturn(history);
    if (windowKey === '1Y') return PA.Ticker.calculateCalendarReturn(history, 365, 330);
    if (windowKey === '10Y') return PA.Ticker.calculateCalendarReturn(history, 3650, 3500);
    return null;
  },

  returnColor(value, scale=0.12) {
    if (value == null || Number.isNaN(value)) return 'rgba(71,85,105,0.45)';
    const bounded = Math.min(Math.abs(value) / Math.max(scale, 0.0001), 1);
    const alpha = 0.2 + bounded * 0.7;
    return value >= 0
      ? `rgba(52, 211, 153, ${alpha})`
      : `rgba(248, 113, 113, ${alpha})`;
  },

  buildHeatmapFallback(heatmapValues, maxAbs) {
    return `
      <div class="market-return-grid">
        ${heatmapValues.map(item => `
          <div class="market-return-tile" style="background:${this.returnColor(item.selectedReturn, maxAbs)}" onclick="PA.Ticker.lookup('${item.ticker}');PA.UI.showTab('ticker')">
            <div>
              <strong>${item.ticker}</strong>
              <span>${PA.UI.escapeHtml(item.name)}</span>
            </div>
            <div class="market-return-value">${item.selectedReturn != null ? PA.Fmt.pct(item.selectedReturn) : 'N/A'}</div>
          </div>
        `).join('')}
      </div>
    `;
  },

  weightedGroupReturn(items=[]) {
    let weighted = 0;
    let weightSum = 0;
    items.forEach(item => {
      const value = Number(item.selectedReturn);
      const weight = Number(item.tileValue || 1);
      if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) return;
      weighted += value * weight;
      weightSum += weight;
    });
    return weightSum > 0 ? weighted / weightSum : 0;
  },

  renderHeatmapChart(containerId, heatmapValues, maxAbs) {
    const el = document.getElementById(containerId);
    if (!el) return;
    PA.Charts.destroy(containerId);

    if (!window.Plotly) {
      el.innerHTML = this.buildHeatmapFallback(heatmapValues, maxAbs);
      return;
    }

    const leafItems = heatmapValues.map(item => {
      const assetScale = Number(item.quote?.netAssets ?? item.quote?.marketCap);
      return {
        ...item,
        tileValue: Number.isFinite(assetScale) && assetScale > 0 ? assetScale : 1
      };
    });
    const groupNames = [...new Set(leafItems.map(item => item.group || 'Other'))];
    const totalValue = leafItems.reduce((sum, item) => sum + item.tileValue, 0) || leafItems.length || 1;
    const groupItems = groupNames.map(group => {
      const children = leafItems.filter(item => (item.group || 'Other') === group);
      const groupValue = children.reduce((sum, item) => sum + item.tileValue, 0) || children.length || 1;
      return {
        id: `group:${group}`,
        label: group,
        value: groupValue,
        color: this.weightedGroupReturn(children)
      };
    });

    const ids = ['market', ...groupItems.map(group => group.id), ...leafItems.map(item => `ticker:${item.ticker}`)];
    const labels = ['ETF Market', ...groupItems.map(group => group.label), ...leafItems.map(item => item.ticker)];
    const parents = ['', ...groupItems.map(() => 'market'), ...leafItems.map(item => `group:${item.group || 'Other'}`)];
    const values = [totalValue, ...groupItems.map(group => group.value), ...leafItems.map(item => item.tileValue)];
    const colors = [
      0,
      ...groupItems.map(group => group.color),
      ...leafItems.map(item => Number.isFinite(item.selectedReturn) ? item.selectedReturn : 0)
    ];
    const text = [
      '',
      ...groupItems.map(group => PA.Fmt.pct(group.color)),
      ...leafItems.map(item => item.selectedReturn != null ? PA.Fmt.pct(item.selectedReturn) : 'N/A')
    ];
    const customdata = [
      ['Broad ETF heatmap', 'All groups', 'N/A', 'N/A', 'N/A', 'Tile size uses net assets or market cap when available.'],
      ...groupItems.map(group => [
        group.label,
        'Group',
        'N/A',
        PA.Fmt.pct(group.color),
        'N/A',
        `Group tile size: ${PA.Fmt.compact(group.value)}`
      ]),
      ...leafItems.map(item => [
        item.name,
        item.group,
        item.quote?.regularMarketPrice != null ? PA.Fmt.currency(item.quote.regularMarketPrice) : 'N/A',
        item.selectedReturn != null ? PA.Fmt.pct(item.selectedReturn) : 'N/A',
        item.dailyReturn != null ? PA.Fmt.pct(item.dailyReturn) : 'N/A',
        Number(item.quote?.netAssets) > 0
          ? `Net assets: ${PA.Fmt.compact(Number(item.quote.netAssets))}`
          : (Number(item.quote?.marketCap) > 0 ? `Market cap: ${PA.Fmt.compact(Number(item.quote.marketCap))}` : 'Equal-size tile')
      ])
    ];

    const trace = {
      type: 'treemap',
      ids,
      labels,
      parents,
      values,
      branchvalues: 'total',
      text,
      texttemplate: '<b>%{label}</b><br>%{text}',
      textfont: { color: '#f8fafc', size: 14 },
      marker: {
        colors,
        colorscale: [
          [0, '#7f1d1d'],
          [0.5, '#334155'],
          [1, '#14532d']
        ],
        cmin: -maxAbs,
        cmax: maxAbs,
        cmid: 0,
        line: { color: '#0f1117', width: 1.2 },
        colorbar: {
          title: this.heatmapRange,
          tickformat: '.0%'
        }
      },
      tiling: { pad: 5 },
      hovertemplate: `<b>%{label}</b><br>%{customdata[0]}<br>Group: %{customdata[1]}<br>Price: %{customdata[2]}<br>${this.heatmapRange}: %{customdata[3]}<br>1D: %{customdata[4]}<br>%{customdata[5]}<extra></extra>`,
      customdata,
      pathbar: { visible: false }
    };

    const layout = {
      ...PA.Charts.plotlyLayoutBase(460),
      margin: { l: 10, r: 10, t: 10, b: 10 },
      hovermode: 'closest',
      showlegend: false
    };

    const showFallback = error => {
      console.warn('Market heatmap Plotly render failed:', error);
      PA.Charts.destroy(containerId);
      el.innerHTML = this.buildHeatmapFallback(heatmapValues, maxAbs);
    };
    try {
      const plot = window.Plotly.newPlot(el, [trace], layout, { responsive: true, displayModeBar: false });
      if (plot && typeof plot.catch === 'function') {
        plot.catch(showFallback);
      }
    } catch (error) {
      showFallback(error);
      return;
    }
    el.on?.('plotly_click', event => {
      const pointId = event?.points?.[0]?.id || '';
      if (!String(pointId).startsWith('ticker:')) return;
      const ticker = String(pointId).replace('ticker:', '');
      PA.Ticker.lookup(ticker);
      PA.UI.showTab('ticker');
    });
    PA.Charts.registerPlotly(containerId, el);
  },

  async loadMarketOverview(options={}) {
    const container = document.getElementById('dash-market');
    if (!container) return;
    if (this.isLoading) return;
    this.isLoading = true;
    this.clearAutoRefresh();
    try {
      if (!options.silent || !container.innerHTML.trim()) {
        container.innerHTML = `<div class="loading"><div class="spinner"></div>Loading markets dashboard...</div>`;
      }
      const universe = this.currentUniverse();
      const tickers = universe.map(item => item.ticker);
      const [quotes, returnHistories, correlationHistories] = await Promise.all([
        PA.API.getQuote(tickers, { allowPartial: true }),
        PA.API.getHistories(tickers, this.requiredHistoryRange(this.heatmapRange), { allowPartial: true }),
        PA.API.getHistories(tickers, '1Y', { allowPartial: true })
      ]);
      const quoteMap = {};
      (quotes || []).forEach(q => { quoteMap[q.symbol] = q; });

      const returnDataMap = {};
      const correlationDataMap = {};
      tickers.forEach(ticker => {
        returnDataMap[ticker] = PA.API.parseHistory(returnHistories[ticker]);
        correlationDataMap[ticker] = PA.API.parseHistory(correlationHistories[ticker]);
      });

      const heatmapValues = universe.map(item => {
        const quote = quoteMap[item.ticker] || {};
        const history = returnDataMap[item.ticker];
        const dailyReturn = quote?.regularMarketChangePercent != null
          ? quote.regularMarketChangePercent / 100
          : this.computeWindowReturn(history, '1D', quote);
        return {
          ...item,
          quote,
          dailyReturn,
          selectedReturn: this.computeWindowReturn(history, this.heatmapRange, quote)
        };
      });
      const maxAbs = heatmapValues.reduce((max, item) => {
        const value = Math.abs(item.selectedReturn ?? 0);
        return value > max ? value : max;
      }, 0.01);

      const corrTickers = tickers.filter(ticker => (correlationDataMap[ticker]?.dates || []).length >= 30);
      const corrCommonDates = PA.Compare.intersectDates(corrTickers.map(ticker => correlationDataMap[ticker]?.dates || []));
      const corrReturnMap = {};
      corrTickers.forEach(ticker => {
        const prices = PA.Compare.alignSeriesToDates(correlationDataMap[ticker], corrCommonDates);
        corrReturnMap[ticker] = PA.Compute.dailyReturns(prices);
      });
      const corrHtml = corrTickers.length >= 2 && corrCommonDates.length >= 30
        ? PA.Compare.buildCorrelationMatrix(corrTickers, corrReturnMap)
        : '<div class="market-note">Correlation matrix needs at least two ETFs with overlapping 1Y history. The heatmap above can still render with partial quote/return data.</div>';

      const listHtml = `
        <div class="market-table-wrap">
          <table class="data-table market-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th>Group</th>
                <th class="right">Price</th>
                <th class="right">1D</th>
                <th class="right">${this.heatmapRange}</th>
              </tr>
            </thead>
            <tbody>
              ${heatmapValues.map(item => {
                return `
                  <tr>
                    <td style="color:var(--accent);font-weight:600;cursor:pointer" onclick="PA.Ticker.lookup('${item.ticker}');PA.UI.showTab('ticker')">${item.ticker}</td>
                    <td>${PA.UI.escapeHtml(item.name)}</td>
                    <td>${PA.UI.escapeHtml(item.group)}</td>
                    <td class="right">${PA.Fmt.currency(item.quote?.regularMarketPrice)}</td>
                    <td class="right ${PA.Fmt.colorClass(item.dailyReturn)}">${item.dailyReturn != null ? PA.Fmt.pct(item.dailyReturn) : 'N/A'}</td>
                    <td class="right ${PA.Fmt.colorClass(item.selectedReturn)}">${item.selectedReturn != null ? PA.Fmt.pct(item.selectedReturn) : 'N/A'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      this.lastLoadedAt = new Date();

      container.innerHTML = `
        <div class="market-dashboard-stack">
          <div class="market-toolbar">
            <div class="market-note">${PA.UI.escapeHtml(this.currentModeLabel())} using live quotes plus trailing return windows from the local backend. Last updated ${PA.UI.escapeHtml(this.lastLoadedLabel())}.</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <select class="form-select market-mode-select" onchange="PA.Dashboard.setHeatmapMode(this.value)">
                ${Object.entries(this.heatmapModes).map(([key, mode]) => `
                  <option value="${key}" ${key === this.heatmapMode ? 'selected' : ''}>${PA.UI.escapeHtml(mode.label)}</option>
                `).join('')}
              </select>
              <div class="market-timeframe-buttons">
                ${['1D','1W','1M','YTD','1Y','10Y'].map(range => `
                  <button class="range-btn ${range === this.heatmapRange ? 'active' : ''}" onclick="PA.Dashboard.setHeatmapRange('${range}')">${range}</button>
                `).join('')}
              </div>
              <button class="btn btn-sm" onclick="PA.Dashboard.loadMarketOverview()">Refresh Now</button>
            </div>
          </div>
          <div>
            <div class="market-section-title">${PA.UI.escapeHtml(this.currentModeTitle())} (${this.heatmapRange})</div>
            <div class="market-note" style="margin-bottom:10px">Color shows the selected return window. Tiles auto-refresh every ${this.autoRefreshLabel()} while this tab is open. This is a free polling dashboard, not an exchange-licensed streaming tape.</div>
            <div class="market-note" style="margin-bottom:12px">Click any tile to open the ticker page. Tile size uses ETF net assets or market cap when the backend has it, otherwise the map falls back to equal-size tiles.</div>
            <div id="market-heatmap-chart" class="plotly-chart" style="height:460px"></div>
          </div>
          <div>
            <div class="market-section-title">ETF Market List</div>
            ${listHtml}
          </div>
          <div>
            <div class="market-section-title">1Y Daily Return Correlation</div>
            ${corrHtml}
          </div>
        </div>
      `;
      this.renderHeatmapChart('market-heatmap-chart', heatmapValues, maxAbs);
    } catch (e) {
      container.innerHTML = `
        <div style="color:var(--text-muted);padding:10px">
          Unable to load live market dashboard right now.
          <div style="margin-top:8px;font-size:0.8rem">${PA.UI.escapeHtml(PA.UI.errorText(e))}</div>
        </div>
      `;
      if (PA.App?.refreshDiagnostics) {
        PA.App.refreshDiagnostics();
      }
    } finally {
      this.isLoading = false;
      this.scheduleAutoRefresh();
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
