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
  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
  errorText(error, fallback='Unexpected error while loading data.') {
    if (PA.API?.describeError) {
      return PA.API.describeError(error, fallback);
    }
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error.trim();
    return fallback;
  },
  renderError(target, title, error, hint='') {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    const message = this.escapeHtml(this.errorText(error));
    const hintHtml = hint
      ? `<p style="margin-top:8px;font-size:0.8rem;color:var(--text-muted)">${this.escapeHtml(hint)}</p>`
      : '';
    el.innerHTML = `
      <div class="empty-state">
        <h3>${this.escapeHtml(title)}</h3>
        <p>${message}</p>
        ${hintHtml}
      </div>
    `;
    if (PA.App?.refreshDiagnostics) {
      PA.App.refreshDiagnostics();
    }
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
  currentRange: '3Y',
  currentInterval: '1d',
  currentCompare: 'NONE',
  currentChartType: 'line',
  movingAverageInput: '',
  showVolume: true,
  showRSI: false,
  showMACD: false,

  async lookup(ticker, options={}) {
    ticker = ticker.toUpperCase().trim();
    if (!ticker) return;
    this.ensureRangeForInterval(this.currentInterval);
    PA.UI.loading('ticker-content');
    document.getElementById('ticker-content').style.display = 'block';
    const emptyEl = document.getElementById('ticker-empty');
    if (emptyEl) emptyEl.style.display = 'none';
    try {
      const compareTicker = this.currentCompare && this.currentCompare !== 'NONE' && this.currentCompare !== ticker
        ? this.currentCompare
        : null;
      const [quotes, history, analysisHistory, intradayHistory, summaryResult, compareHistory] = await Promise.allSettled([
        PA.API.getQuote([ticker]),
        PA.API.getHistory(ticker, this.currentRange, { interval: this.currentInterval }),
        PA.API.getHistory(ticker, '1Y', { interval: '1d' }),
        PA.API.getHistory(ticker, '1D', { interval: '15m' }),
        PA.API.getQuoteSummary(ticker),
        compareTicker ? PA.API.getHistory(compareTicker, this.currentRange, { interval: this.currentInterval }) : Promise.resolve(null)
      ]);
      const hist = history.status === 'fulfilled' ? history.value : null;
      const analysisHist = analysisHistory.status === 'fulfilled' && analysisHistory.value ? analysisHistory.value : hist;
      const intradayHist = intradayHistory.status === 'fulfilled' && intradayHistory.value ? intradayHistory.value : null;
      const summary = summaryResult.status === 'fulfilled'
        ? (summaryResult.value || {})
        : {};
      const compareHist = compareHistory.status === 'fulfilled' ? compareHistory.value : null;
      const failures = [quotes, history]
        .filter(result => result.status === 'rejected')
        .map(result => PA.UI.errorText(result.reason, 'Live market data request failed.'))
        .filter(Boolean);

      if (!hist && failures.length) {
        throw new Error(failures[0]);
      }

      if (!hist) {
        throw PA.API.recordError(
          new Error(`Live quote/history was incomplete for ${ticker}. Quote returned: false. History returned: ${Boolean(hist)}.`),
          { scope: 'ticker.lookup', ticker, quoteReturned: false, historyReturned: Boolean(hist) }
        );
      }

      const hData = PA.API.parseHistory(hist);
      const historyQuote = PA.API.buildQuoteFromHistory(ticker, hData);
      const liveQuote = quotes.status === 'fulfilled' ? (quotes.value[0] || null) : null;
      if (!liveQuote) {
        throw new Error(`Live provider quote was unavailable for ${ticker}.`);
      }
      const mergedQuote = PA.API.applySummaryToQuote(
        PA.API.mergeQuoteData(historyQuote, liveQuote),
        summary
      );
      this.applyDerivedStats(mergedQuote, hData);
      this.current = { ticker, quote: mergedQuote, hist, analysisHist, intradayHist, compareHist, summary };
      this.render();
      try {
        this.saveToDb(ticker, mergedQuote, summary, hist);
      } catch (dbError) {
        PA.API.recordError(dbError, { scope: 'db.saveToDb', ticker });
        console.warn('Local cache save failed:', dbError);
        PA.UI.toast('Live data loaded, but local cache save failed', 'error');
      }
      if (summaryResult.status === 'rejected' && !this.hasFundamentalData(summary)) {
        PA.UI.toast('Live price loaded, but some provider fundamentals were unavailable for this lookup', 'error');
      }
    } catch(e) {
      PA.UI.renderError(
        'ticker-content',
        'Error loading data',
        e,
        'Open Settings to review the latest provider diagnostics, then try the lookup again.'
      );
    }
  },

  supportedRanges(interval=this.currentInterval) {
    return PA.Config.CHART_INTERVALS[interval]?.ranges || Object.keys(PA.Config.RANGES);
  },

  ensureRangeForInterval(interval=this.currentInterval) {
    const allowed = this.supportedRanges(interval);
    if (!allowed.includes(this.currentRange)) {
      this.currentRange = allowed[0] || '1M';
    }
  },

  parseMovingAverages() {
    return [...new Set(
      String(this.movingAverageInput || '')
        .split(',')
        .map(part => parseInt(part.trim(), 10))
        .filter(value => Number.isFinite(value) && value > 1 && value <= 400)
    )].sort((a, b) => a - b).slice(0, 4);
  },

  chartHeight() {
    if (this.showRSI && this.showMACD) return 760;
    if (this.showRSI || this.showMACD) return 620;
    return 460;
  },

  extractSummaryText(summary, company={}) {
    const raw = summary?.providerRaw || {};
    const info = raw.info || {};
    const fundsData = raw.funds_data || {};
    const overview = fundsData.fund_overview || {};
    const candidates = [
      info.longBusinessSummary,
      raw.longBusinessSummary,
      fundsData.description,
      overview.longBusinessSummary,
      company.longBusinessSummary,
      company.description
    ];
    const match = candidates.find(value => typeof value === 'string' && value.trim());
    return match
      ? match.trim()
      : 'Live price, market data, and provider fundamentals are shown here. Use the compact chart controls below only when you want to layer on more analysis.';
  },

  async refreshChartData() {
    if (!this.current?.ticker) return;
    this.ensureRangeForInterval(this.currentInterval);
    const ticker = this.current.ticker;
    const compareTicker = this.currentCompare && this.currentCompare !== 'NONE' && this.currentCompare !== ticker
      ? this.currentCompare
      : null;
    const [histResult, compareResult, intradayResult] = await Promise.allSettled([
      PA.API.getHistory(ticker, this.currentRange, { interval: this.currentInterval }),
      compareTicker ? PA.API.getHistory(compareTicker, this.currentRange, { interval: this.currentInterval }) : Promise.resolve(null),
      this.current.intradayHist ? Promise.resolve(this.current.intradayHist) : PA.API.getHistory(ticker, '1D', { interval: '15m' }).catch(() => null)
    ]);
    if (histResult.status !== 'fulfilled') throw histResult.reason;
    this.current.hist = histResult.value;
    this.current.compareHist = compareResult.status === 'fulfilled' ? compareResult.value : null;
    this.current.intradayHist = intradayResult.status === 'fulfilled' ? intradayResult.value : this.current.intradayHist;
    this.render();
  },

  render(isCached=false) {
    if (!this.current) return;
    const { ticker, quote: q, hist, summary: s } = this.current;
    const ks = s?.defaultKeyStatistics || {};
    const sd = s?.summaryDetail || {};
    const earnings = s?.earnings || {};
    const company = s?.company || {};
    const fund = s?.fundProfile || {};
    const performance = s?.performance || {};
    const windowMeta = performance.windowMeta || {};
    const isEtf = q.quoteType === 'ETF' || !!fund.netAssets;

    const change = q.regularMarketChange;
    const changePct = q.regularMarketChangePercent;
    const changeClass = (change ?? 0) >= 0 ? 'positive' : 'negative';
    const changeSign = (change ?? 0) >= 0 ? '+' : '';
    const marketLabel = q.marketState === 'REGULAR'
      ? '<span class="positive">Open</span>'
      : q.marketState === 'UNKNOWN'
        ? '<span>Unknown</span>'
        : '<span class="negative">Closed</span>';

    // Get parsed history
    const hData = PA.API.parseHistory(hist);
    const analysisHist = this.current.analysisHist || hist;
    const analysisData = PA.API.parseHistory(analysisHist);
    const intradayData = PA.API.parseHistory(this.current.intradayHist);
    const compareData = PA.API.parseHistory(this.current.compareHist);
    const supportedRanges = this.supportedRanges(this.currentInterval);
    const movingAverages = this.parseMovingAverages();
    const chartHeight = this.chartHeight();
    this.applyDerivedStats(q, hData);

    // Extract values with fallbacks
    const providerBeta = this.v(ks.beta) ?? this.v(q.beta) ?? null;
    const pe = this.v(sd.trailingPE) ?? this.v(q.trailingPE) ?? null;
    const fwdPe = this.v(ks.forwardPE) ?? this.v(sd.forwardPE) ?? null;
    const mktCap = q.marketCap ?? this.v(sd.marketCap) ?? null;
    const netAssets = q.netAssets ?? fund.netAssets ?? null;
    const navPrice = q.navPrice ?? fund.navPrice ?? null;
    const expenseRatio = q.expenseRatio ?? fund.expenseRatio ?? null;
    const portfolioTurnover = q.portfolioTurnover ?? fund.portfolioTurnover ?? null;
    const volume = q.regularMarketVolume || null;
    const bid = q.bid ?? null;
    const ask = q.ask ?? null;
    const bidSize = q.bidSize ?? null;
    const askSize = q.askSize ?? null;
    const yld = this.v(sd.dividendYield) ?? q.trailingAnnualDividendYield ?? null;
    const dividendAmount = q.dividendRate ?? s?.dividends?.dividendPerShare ?? null;
    const fiftyTwoWeekLow = q.fiftyTwoWeekLow ?? this.v(sd.fiftyTwoWeekLow);
    const fiftyTwoWeekHigh = q.fiftyTwoWeekHigh ?? this.v(sd.fiftyTwoWeekHigh);
    const fiftyDayAverage = q.fiftyDayAverage ?? this.v(sd.fiftyDayAverage);
    const twoHundredDayAverage = q.twoHundredDayAverage ?? this.v(sd.twoHundredDayAverage);
    const epsTtm = q.epsTrailingTwelveMonths ?? this.v(earnings.eps);
    const bookValue = q.bookValue ?? this.v(s?.valuation?.bookValue);
    const sharesOutstanding = q.sharesOutstanding ?? this.v(ks.sharesOutstanding);
    const ytdReturn = performance.ytdReturn ?? this.calculateYtdReturn(analysisData);
    const oneYearReturn = performance.oneYearReturn
      ?? this.normalizeProviderReturn('oneYearReturn', q.oneYearReturn ?? null, s, q)
      ?? this.calculateCalendarReturn(analysisData, 365, 330);
    const threeYearReturn = performance.threeYearReturn ?? null;
    const fiveYearReturn = performance.fiveYearReturn ?? null;
    const threeYearLabel = windowMeta?.threeYearReturn?.annualized ? '3Y Ann. Return' : '3Y Return';
    const fiveYearLabel = windowMeta?.fiveYearReturn?.annualized ? '5Y Ann. Return' : '5Y Return';
    const oneDayReturn = changePct != null ? changePct / 100 : this.calculateCalendarReturn(analysisData, 1, 1);
    const oneMonthReturn = this.calculateCalendarReturn(analysisData, 30, 20);
    const threeMonthReturn = this.calculateCalendarReturn(analysisData, 91, 70);
    const intradayReturn = this.calculateIntradayReturn(q, intradayData);
    const returnSource = performance.returnMethod
      ? `${performance.returnMethod} (${performance.returnSource || 'yfinance'})${windowMeta?.threeYearReturn?.annualized || windowMeta?.fiveYearReturn?.annualized ? '; 3Y/5Y shown annualized' : ''}`
      : 'Adjusted close trailing total return fallback';
    const yieldDisplay = yld != null ? this.formatProviderPercent('trailingAnnualDividendYield', yld, s, q) : 'N/A';
    const dividendDisplay = dividendAmount != null ? PA.Fmt.currency(dividendAmount) : 'N/A';
    const expenseRatioDisplay = expenseRatio != null ? this.formatProviderPercent('expenseRatio', expenseRatio, s, q, 3) : 'N/A';
    const portfolioTurnoverDisplay = portfolioTurnover != null ? this.formatProviderPercent('portfolioTurnover', portfolioTurnover, s, q) : 'N/A';
    const dominantSector = this.formatSectorList(fund.sectors, 3);
    const topHoldings = this.formatHoldingsList(fund.holdings, 5);
    const issuer = fund.issuer ?? q.issuer ?? 'N/A';
    const trackedIndex = fund.trackedIndex ?? q.trackedIndex ?? 'N/A';
    const trackingError = fund.trackingError ?? q.trackingError ?? (this.currentCompare !== 'NONE' ? this.calculateTrackingError(analysisData, compareData) : null);
    const trackingErrorLabel = fund.trackingError ?? q.trackingError
      ? 'Tracking Error'
      : (this.currentCompare !== 'NONE' ? `Tracking Error vs ${this.currentCompare}` : 'Tracking Error');
    const providerMissing = s?.providerMissingFields || q?.providerMissingFields || [];
    const microFacts = [
      ['Volume', volume ? PA.Fmt.compact(volume) : 'N/A'],
      ['Bid', this.formatBidAsk(bid, bidSize)],
      ['Ask', this.formatBidAsk(ask, askSize)],
      ['Prev Close', PA.Fmt.currency(q.regularMarketPreviousClose)],
      ['Open', PA.Fmt.currency(q.regularMarketOpen)]
    ];
    const metricCard = (label, value, extra='') => `
      <div class="metric-card compact-metric-card">
        <div class="metric-label">${label}</div>
        <div class="metric-value" ${extra}>${value}</div>
      </div>
    `;
    const metricCards = isEtf
      ? [
          metricCard('NAV', navPrice != null ? PA.Fmt.currency(navPrice) : 'N/A'),
          metricCard('Expense Ratio', expenseRatioDisplay),
          metricCard('Net Assets', netAssets ? '$' + PA.Fmt.compact(netAssets) : 'N/A'),
          metricCard('Distribution Yield', yieldDisplay),
          metricCard('Turnover', portfolioTurnoverDisplay),
          metricCard('1Y Return', oneYearReturn != null ? PA.Fmt.pct(oneYearReturn) : 'N/A'),
          metricCard('52W Range', `${PA.Fmt.currency(fiftyTwoWeekLow,0)} - ${PA.Fmt.currency(fiftyTwoWeekHigh,0)}`, 'style="font-size:0.85rem"'),
          metricCard('Beta (Provider)', providerBeta != null ? PA.Fmt.ratio(providerBeta, 2) : 'N/A')
        ].join('')
      : [
          metricCard('P/E Ratio', pe != null ? PA.Fmt.ratio(pe) : 'N/A'),
          metricCard('Forward P/E', fwdPe != null ? PA.Fmt.ratio(fwdPe) : 'N/A'),
          metricCard('Market Cap', mktCap ? '$' + PA.Fmt.compact(mktCap) : 'N/A'),
          metricCard('Dividend', dividendDisplay),
          metricCard('Price/Book', PA.Fmt.ratio(q.priceToBook ?? this.v(sd.priceToBook))),
          metricCard('1Y Return', oneYearReturn != null ? PA.Fmt.pct(oneYearReturn) : 'N/A'),
          metricCard('52W Range', `${PA.Fmt.currency(fiftyTwoWeekLow,0)} - ${PA.Fmt.currency(fiftyTwoWeekHigh,0)}`, 'style="font-size:0.85rem"'),
          metricCard('Beta (Provider)', providerBeta != null ? PA.Fmt.ratio(providerBeta, 2) : 'N/A')
        ].join('');

    const returnsRows = [
      ['Live Feed Return (1D)', oneDayReturn != null ? PA.Fmt.pct(oneDayReturn) : 'N/A'],
      ['Session Return (Since Open)', intradayReturn != null ? PA.Fmt.pct(intradayReturn) : 'N/A'],
      ['1M Return', oneMonthReturn != null ? PA.Fmt.pct(oneMonthReturn) : 'N/A'],
      ['3M Return', threeMonthReturn != null ? PA.Fmt.pct(threeMonthReturn) : 'N/A'],
      ['1Y Return', oneYearReturn != null ? PA.Fmt.pct(oneYearReturn) : 'N/A'],
      ['YTD Return', ytdReturn != null ? PA.Fmt.pct(ytdReturn) : 'N/A'],
      [threeYearLabel, threeYearReturn != null ? PA.Fmt.pct(threeYearReturn) : 'N/A'],
      [fiveYearLabel, fiveYearReturn != null ? PA.Fmt.pct(fiveYearReturn) : 'N/A'],
      ['Return Source', returnSource]
    ];

    const statsRows = isEtf
      ? [
          ['Provider Beta', providerBeta != null ? PA.Fmt.ratio(providerBeta) : 'N/A'],
          ['NAV', navPrice != null ? PA.Fmt.currency(navPrice) : 'N/A'],
          ['Net Assets', netAssets ? '$' + PA.Fmt.compact(netAssets) : 'N/A'],
          ['Expense Ratio', expenseRatioDisplay],
          ['Portfolio Turnover', portfolioTurnoverDisplay],
          ['Distribution Yield', yieldDisplay],
          ['50-Day Avg', PA.Fmt.currency(fiftyDayAverage)],
          ['200-Day Avg', PA.Fmt.currency(twoHundredDayAverage)],
          ['Provider Gaps', providerMissing.length ? providerMissing.join(', ') : 'None']
        ]
      : [
          ['Provider Beta', providerBeta != null ? PA.Fmt.ratio(providerBeta) : 'N/A'],
          ['EPS (TTM)', PA.Fmt.currency(epsTtm)],
          ['Forward EPS', PA.Fmt.currency(q.epsForward)],
          ['Price/Book', PA.Fmt.ratio(q.priceToBook ?? this.v(sd.priceToBook))],
          ['Book Value', PA.Fmt.currency(bookValue)],
          ['Dividend', dividendDisplay],
          ['Avg Volume', (q.averageDailyVolume3Month ?? q.averageDailyVolume10Day) != null ? PA.Fmt.compact(q.averageDailyVolume3Month ?? q.averageDailyVolume10Day) : 'N/A'],
          ['Shares Out', sharesOutstanding ? PA.Fmt.compact(sharesOutstanding) : 'N/A'],
          ['Ex-Div Date', q.exDividendDate ? this.formatDate(q.exDividendDate) : 'N/A'],
          ['Provider Gaps', providerMissing.length ? providerMissing.join(', ') : 'None']
        ];

    const characteristicsRows = isEtf
      ? [
          ['Issuer', issuer || 'N/A'],
          ['Top Sector', dominantSector || 'N/A'],
          ['Tracked Index', trackedIndex || 'N/A'],
          [trackingErrorLabel, trackingError != null ? PA.Fmt.pct(trackingError) : 'N/A']
        ]
      : [
          ['Market Cap', mktCap ? '$' + PA.Fmt.compact(mktCap) : 'N/A'],
          ['Volume', volume ? PA.Fmt.compact(volume) : 'N/A'],
          ['Dividend', dividendDisplay],
          ['P/E', pe != null ? PA.Fmt.ratio(pe) : 'N/A'],
          ['Forward P/E', fwdPe != null ? PA.Fmt.ratio(fwdPe) : 'N/A']
        ];

    const summaryText = this.extractSummaryText(s, company);

    const html = `
      <div class="ticker-topbar">
        <div class="ticker-price-stack">
          <div class="ticker-header" style="margin-bottom:6px">
            <span class="ticker-symbol">${q.symbol || ticker}</span>
            <span class="ticker-name">${q.shortName || q.longName || company.name || ''}</span>
          </div>
          <div style="color:var(--text-muted);font-size:0.8rem">
            ${q.fullExchangeName || q.exchange || ''} &middot; ${q.currency || 'USD'} &middot;
            Market ${marketLabel}
            ${isCached ? ' &middot; <span>Cached data</span>' : ''}
          </div>
          <div class="ticker-price-panel">
            <div class="ticker-price">${PA.Fmt.currency(q.regularMarketPrice)}</div>
            <div class="ticker-change ${changeClass}">${change != null && changePct != null ? `${changeSign}${change.toFixed(2)} (${changeSign}${changePct.toFixed(2)}%)` : 'N/A'} <span style="font-size:0.72rem;opacity:0.8">1D</span></div>
            <div class="ticker-micro-grid">
              ${microFacts.map(([label, value]) => `
                <div class="ticker-micro-item">
                  <span>${label}</span>
                  <strong>${value}</strong>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="ticker-summary-text">
          <div class="ticker-summary-title">${isEtf ? 'Fund Summary' : 'Company Summary'}</div>
          <div class="ticker-summary-copy">${PA.UI.escapeHtml(summaryText)}</div>
        </div>
      </div>
      <div style="color:var(--text-muted);font-size:0.78rem;margin:-8px 0 16px">
        Displayed price move uses the provider live feed, while session return uses the current session/open-to-last move. YTD and 1Y use trailing total return; 3Y and 5Y follow Yahoo-style annualized return methodology.
      </div>

      <div class="ticker-metrics-grid" id="metrics-grid">${metricCards}</div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">Price History</div>
        <div class="chart-toolbar">
          <div class="chart-toolbar-row chart-toolbar-inline">
            <div class="range-selector" id="ticker-ranges"></div>
            <div class="chart-control-grid chart-control-grid-tight">
            <label class="form-group" style="margin:0">
              <span class="form-label">Freq</span>
              <select class="form-select" id="ticker-interval" onchange="PA.Ticker.changeInterval(this.value)">
                ${Object.entries(PA.Config.CHART_INTERVALS).map(([value, cfg]) => `
                  <option value="${value}" ${value === this.currentInterval ? 'selected' : ''}>${cfg.label}</option>
                `).join('')}
              </select>
            </label>
            <label class="form-group" style="margin:0">
              <span class="form-label">Compare</span>
              <select class="form-select" id="ticker-compare" onchange="PA.Ticker.changeCompare(this.value)">
                ${Object.entries(PA.Config.CHART_COMPARE_INDEXES).map(([value, label]) => `
                  <option value="${value}" ${value === this.currentCompare ? 'selected' : ''}>${label}</option>
                `).join('')}
              </select>
            </label>
            <label class="form-group" style="margin:0">
              <span class="form-label">Type</span>
              <select class="form-select" id="ticker-chart-type" onchange="PA.Ticker.changeChartType(this.value)">
                <option value="line" ${this.currentChartType === 'line' ? 'selected' : ''}>Line</option>
                <option value="candlestick" ${this.currentChartType === 'candlestick' ? 'selected' : ''}>Candlestick</option>
              </select>
            </label>
            <label class="form-group" style="margin:0">
              <span class="form-label">MA</span>
              <input class="form-input" id="ticker-ma-input" value="${PA.UI.escapeHtml(this.movingAverageInput)}" placeholder="20,50,200"
                onkeydown="if(event.key==='Enter'){PA.Ticker.updateMovingAverages(this.value)}"
                onchange="PA.Ticker.updateMovingAverages(this.value)">
            </label>
            <div class="form-group chart-toggle-row chart-toggle-inline" style="margin:0;display:flex;align-items:end">
              <label><input type="checkbox" ${this.showVolume ? 'checked' : ''} onchange="PA.Ticker.toggleIndicator('showVolume', this.checked)"> Vol</label>
              <label><input type="checkbox" ${this.showRSI ? 'checked' : ''} onchange="PA.Ticker.toggleIndicator('showRSI', this.checked)"> RSI</label>
              <label><input type="checkbox" ${this.showMACD ? 'checked' : ''} onchange="PA.Ticker.toggleIndicator('showMACD', this.checked)"> MACD</label>
            </div>
            <div class="form-group" style="margin:0;display:flex;align-items:end">
              <button class="btn btn-sm" style="width:100%" onclick="PA.Ticker.applyChartSettings()">Update</button>
            </div>
          </div>
          </div>
        </div>
        <div class="chart-container" style="height:${chartHeight}px"><div id="chart-price" class="plotly-chart"></div></div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-title">Returns</div>
          <table class="data-table" id="ticker-returns-table"></table>
        </div>
        <div class="card">
          <div class="card-title">${isEtf ? 'Fund Statistics' : 'Fundamentals'}</div>
          <table class="data-table" id="ticker-stats-table"></table>
        </div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-title">Drawdown</div>
          <div class="chart-container chart-sm"><canvas id="chart-ticker-dd"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title">${isEtf ? 'ETF Characteristics' : 'Additional Characteristics'}</div>
          <table class="data-table" id="ticker-extra-table"></table>
          ${isEtf ? `
            <div class="ticker-holdings-panel">
              <div class="ticker-holdings-title">Top 5 Holdings</div>
              <div class="ticker-holdings-list">${this.formatHoldingsHtml(fund.holdings, 5)}</div>
            </div>` : ''}
        </div>
      </div>

      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn" onclick="PA.Ticker.lookup('${ticker}', { forceLive: true })">Refresh Live</button>
        <button class="btn btn-primary" onclick="PA.Portfolio.addFromTicker()">Add to Portfolio</button>
        <button class="btn" onclick="PA.Ticker.addToWatchlist('${ticker}')">Add to Watchlist</button>
      </div>
    `;
    document.getElementById('ticker-content').innerHTML = html;

    // Render range buttons
    const rangeContainer = document.getElementById('ticker-ranges');
    supportedRanges.forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'range-btn' + (r === this.currentRange ? ' active' : '');
      btn.textContent = r;
      btn.onclick = () => this.changeRange(r);
      rangeContainer.appendChild(btn);
    });

    // Render charts
    if (hData.prices.length > 1) {
      PA.Charts.advancedTickerChart('chart-price', {
        ticker,
        history: hData,
        compareTicker: this.currentCompare !== 'NONE' ? this.currentCompare : null,
        compareHistory: compareData,
        chartType: this.currentChartType,
        movingAverages,
        showVolume: this.showVolume,
        showRSI: this.showRSI,
        showMACD: this.showMACD,
        rsiValues: PA.Compute.rsi(hData.prices),
        macd: PA.Compute.macd(hData.prices),
        height: chartHeight
      });
      const dd = PA.Compute.drawdownSeries(hData.prices);
      PA.Charts.drawdown('chart-ticker-dd', hData.dates, dd);
    }

    // Stats tables
    const returnsTable = document.getElementById('ticker-returns-table');
    const statsTable = document.getElementById('ticker-stats-table');
    const extraTable = document.getElementById('ticker-extra-table');
    if (returnsTable) {
      returnsTable.innerHTML = returnsRows.map(([k,v]) =>
        `<tr><td style="font-family:var(--font);color:var(--text-secondary)">${k}</td><td class="right">${v}</td></tr>`
      ).join('');
    }
    statsTable.innerHTML = statsRows.map(([k,v]) =>
      `<tr><td style="font-family:var(--font);color:var(--text-secondary)">${k}</td><td class="right">${v}</td></tr>`
    ).join('');
    if (extraTable) {
      extraTable.innerHTML = characteristicsRows.map(([k,v]) =>
      `<tr><td style="font-family:var(--font);color:var(--text-secondary)">${k}</td><td class="right">${v}</td></tr>`
      ).join('');
    }
  },

  calculateIntradayReturn(quote, intradayData) {
    const prices = intradayData?.prices || [];
    const first = prices.find(value => Number.isFinite(value) && value > 0);
    const last = [...prices].reverse().find(value => Number.isFinite(value));
    if (Number.isFinite(first) && Number.isFinite(last) && first !== 0) {
      return last / first - 1;
    }
    const open = Number(quote?.regularMarketOpen);
    const price = Number(quote?.regularMarketPrice);
    if (Number.isFinite(open) && open > 0 && Number.isFinite(price)) {
      return price / open - 1;
    }
    if (prices.length < 2) return null;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
    return last / first - 1;
  },

  async changeInterval(interval) {
    this.currentInterval = interval;
    this.ensureRangeForInterval(interval);
    try {
      await this.refreshChartData();
    } catch (e) {
      PA.UI.toast(PA.UI.errorText(e), 'error');
    }
  },

  async changeCompare(symbol) {
    this.currentCompare = symbol || 'NONE';
    try {
      await this.refreshChartData();
    } catch (e) {
      PA.UI.toast(PA.UI.errorText(e), 'error');
    }
  },

  changeChartType(type) {
    this.currentChartType = type === 'candlestick' ? 'candlestick' : 'line';
    this.render();
  },

  updateMovingAverages(value) {
    this.movingAverageInput = value || '';
    this.render();
  },

  async applyChartSettings() {
    try {
      await this.refreshChartData();
    } catch (e) {
      PA.UI.toast(PA.UI.errorText(e), 'error');
    }
  },

  toggleIndicator(key, checked) {
    this[key] = Boolean(checked);
    this.render();
  },

  parseHistoryDate(value) {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = raw.includes('T') ? raw : `${raw}T00:00:00`;
    let parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
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

  formatBidAsk(price, size=null) {
    if (price == null || Number.isNaN(price)) return 'N/A';
    return size != null && !Number.isNaN(size)
      ? `${PA.Fmt.currency(price)} x ${PA.Fmt.compact(size)}`
      : PA.Fmt.currency(price);
  },

  providerFieldMeta(summary, quote, field) {
    const fieldSources = summary?.providerFieldSources || quote?.providerFieldSources || {};
    const fieldUnits = summary?.providerFieldUnits || quote?.providerFieldUnits || {};
    return {
      source: fieldSources[field] || null,
      unit: fieldUnits[field] || null
    };
  },

  formatProviderPercent(field, value, summary, quote, dec=2) {
    if (value == null || Number.isNaN(value)) return 'N/A';
    const meta = this.providerFieldMeta(summary, quote, field);
    return PA.Fmt.providerPct(value, meta.unit || 'ratio', dec);
  },

  normalizeProviderReturn(field, value, summary, quote) {
    if (value == null || Number.isNaN(value)) return null;
    const meta = this.providerFieldMeta(summary, quote, field);
    if (meta.unit === 'percent') return value / 100;
    if (meta.unit === 'ratio') return value;
    if (field === 'ytdReturn' && Math.abs(value) > 1) {
      return value / 100;
    }
    return value;
  },

  calculateYtdReturn(historyData) {
    const dates = historyData?.dates || [];
    const adjusted = historyData?.adjustedPrices?.length === dates.length
      ? historyData.adjustedPrices
      : historyData?.prices || [];
    if (!Array.isArray(dates) || !Array.isArray(adjusted) || dates.length < 2) return null;
    const latestIndex = dates.length - 1;
    const latestDate = this.parseHistoryDate(dates[latestIndex]);
    if (!latestDate) return null;
    const yearStart = new Date(latestDate.getFullYear(), 0, 1);
    let anchorIndex = -1;
    for (let i = latestIndex - 1; i >= 0; i--) {
      const pointDate = this.parseHistoryDate(dates[i]);
      if (!pointDate) continue;
      if (pointDate <= yearStart) {
        anchorIndex = i;
        break;
      }
    }
    if (anchorIndex === -1) {
      for (let i = 0; i < latestIndex; i++) {
        const pointDate = this.parseHistoryDate(dates[i]);
        if (!pointDate) continue;
        if (pointDate >= yearStart) {
          anchorIndex = i;
          break;
        }
      }
    }
    if (anchorIndex === -1) return null;
    const start = adjusted[anchorIndex];
    const end = adjusted[latestIndex];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
    return end / start - 1;
  },

  calculateCalendarReturn(historyData, days, minDays=days) {
    const dates = historyData?.dates || [];
    const adjusted = historyData?.adjustedPrices?.length === dates.length
      ? historyData.adjustedPrices
      : historyData?.prices || [];
    if (!Array.isArray(dates) || !Array.isArray(adjusted) || dates.length < 2) return null;
    const latestIndex = dates.length - 1;
    const latestDate = this.parseHistoryDate(dates[latestIndex]);
    if (!latestDate) return null;
    const targetDate = new Date(latestDate);
    targetDate.setDate(targetDate.getDate() - days);
    let matchIndex = -1;
    for (let i = latestIndex - 1; i >= 0; i--) {
      const pointDate = this.parseHistoryDate(dates[i]);
      if (!pointDate) continue;
      if (pointDate <= targetDate) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex === -1) {
      for (let i = 0; i < latestIndex; i++) {
        const pointDate = this.parseHistoryDate(dates[i]);
        if (!pointDate) continue;
        if (pointDate >= targetDate) {
          matchIndex = i;
          break;
        }
      }
    }
    if (matchIndex === -1) return null;
    const matchDate = this.parseHistoryDate(dates[matchIndex]);
    if (!matchDate) return null;
    const dayDiff = Math.round((latestDate - matchDate) / 86400000);
    if (dayDiff < minDays) return null;
    const start = adjusted[matchIndex];
    const end = adjusted[latestIndex];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
    return end / start - 1;
  },

  formatSectorList(sectors, limit=3) {
    if (!Array.isArray(sectors) || !sectors.length) return null;
    return sectors
      .slice(0, limit)
      .map(entry => {
        const sector = entry?.sector || entry?.name || entry?.description;
        const weight = entry?.weight;
        if (!sector) return null;
        return weight != null && !Number.isNaN(weight)
          ? `${sector} (${PA.Fmt.providerPct(weight, Math.abs(weight) > 1 ? 'percent' : 'ratio', 2)})`
          : sector;
      })
      .filter(Boolean)
      .join(', ');
  },

  formatHoldingsList(holdings, limit=5) {
    if (!Array.isArray(holdings) || !holdings.length) return null;
    return holdings
      .slice(0, limit)
      .map(entry => {
        const label = entry?.symbol || entry?.description || entry?.name;
        const weight = entry?.weight;
        if (!label) return null;
        return weight != null && !Number.isNaN(weight)
          ? `${label} (${PA.Fmt.providerPct(weight, Math.abs(weight) > 1 ? 'percent' : 'ratio', 2)})`
          : label;
      })
      .filter(Boolean)
      .join(', ');
  },

  formatHoldingsHtml(holdings, limit=5) {
    if (!Array.isArray(holdings) || !holdings.length) {
      return '<div style="color:var(--text-muted)">No provider holdings returned for this ETF.</div>';
    }
    return holdings
      .slice(0, limit)
      .map((entry, idx) => {
        const label = entry?.symbol || entry?.description || entry?.name || `Holding ${idx + 1}`;
        const weight = entry?.weight;
        const weightText = weight != null && !Number.isNaN(weight)
          ? PA.Fmt.providerPct(weight, Math.abs(weight) > 1 ? 'percent' : 'ratio', 2)
          : 'N/A';
        return `
          <div class="ticker-holding-row">
            <span>${PA.UI.escapeHtml(label)}</span>
            <strong>${weightText}</strong>
          </div>
        `;
      })
      .join('');
  },

  calculateTrackingError(assetData, benchmarkData) {
    if (!assetData?.prices?.length || !benchmarkData?.prices?.length) return null;
    const aligned = PA.Compute.alignHistorySeries(assetData, benchmarkData);
    if (aligned.stockPrices.length < 30 || aligned.marketPrices.length < 30) return null;
    const assetReturns = PA.Compute.dailyReturns(aligned.stockPrices);
    const benchmarkReturns = PA.Compute.dailyReturns(aligned.marketPrices);
    if (!assetReturns.length || assetReturns.length !== benchmarkReturns.length) return null;
    const activeReturns = assetReturns.map((value, index) => value - benchmarkReturns[index]);
    return PA.Compute.stdDev(activeReturns) * Math.sqrt(252);
  },

  updateGreekDisplays({ beta=null, alpha=null, delta=null, gamma=null }={}) {
    const setEl = (id, val, dec=4) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (val == null || Number.isNaN(val)) {
        el.textContent = 'N/A';
        el.className = '';
        return;
      }
      el.textContent = PA.Fmt.ratio(val, dec);
      el.className = PA.Fmt.colorClass(val);
    };
    setEl('metric-alpha', alpha, 4);
    setEl('metric-delta', delta, 3);
    setEl('metric-gamma', gamma, 4);
    setEl('stat-beta', beta, 2);
    setEl('stat-alpha', alpha, 4);
    setEl('stat-delta', delta, 3);
    setEl('stat-gamma', gamma, 4);
  },

  async computeGreeks(ticker, stockDataOverride=null) {
    try {
      let stockData = stockDataOverride;
      let spyData = null;
      if (stockData?.prices?.length >= 180) {
        const spyHistoryMap = await PA.API.getHistories(['SPY'], '1Y');
        spyData = PA.API.parseHistory(spyHistoryMap.SPY);
      } else {
        const historyMap = await PA.API.getHistories([ticker, 'SPY'], '1Y');
        const stockHist = historyMap[ticker];
        const spyHist = historyMap.SPY;
        stockData = PA.API.parseHistory(stockHist);
        spyData = PA.API.parseHistory(spyHist);
      }
      const aligned = PA.Compute.alignHistorySeries(stockData, spyData);
      if (aligned.stockPrices.length < 30 || aligned.marketPrices.length < 30) return;

      const sReturns = PA.Compute.dailyReturns(aligned.stockPrices);
      const mReturns = PA.Compute.dailyReturns(aligned.marketPrices);

      const b = PA.Compute.beta(sReturns, mReturns);
      const a = PA.Compute.alpha(sReturns, mReturns);
      const d = PA.Compute.delta(aligned.stockPrices, aligned.marketPrices);
      const g = PA.Compute.gamma(aligned.stockPrices, aligned.marketPrices);

      this.updateGreekDisplays({ beta: b, alpha: a, delta: d, gamma: g });

      // Save to DB
      PA.DB.exec(`INSERT OR REPLACE INTO greeks(ticker,alpha,beta,delta,gamma,sharpe_ratio,sortino_ratio,std_dev,max_drawdown,calc_period)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [
        ticker, a, b, d, g,
        PA.Compute.sharpeRatio(sReturns),
        PA.Compute.sortinoRatio(sReturns),
        PA.Compute.annualizedVolatility(sReturns),
        PA.Compute.maxDrawdown(aligned.stockPrices).maxDD,
        '1Y_SPY'
      ]);
      PA.DB.save();
    } catch(e) { console.warn('Greek calc failed:', e); }
  },

  loadGreeksFromDb(ticker) {
    const greeks = PA.DB.selectOne(
      `SELECT alpha,beta,delta,gamma FROM greeks WHERE ticker=? ORDER BY calculated_at DESC LIMIT 1`,
      [ticker]
    );
    if (!greeks) return;
    this.updateGreekDisplays(greeks);
  },

  async changeRange(range) {
    this.currentRange = range;
    if (this.current) {
      try {
        await this.refreshChartData();
      } catch(e) {
        const hist = this.loadHistoryFromDb(this.current.ticker, range);
        if (!hist) throw e;
        this.current.hist = hist;
        PA.UI.toast('Loaded cached history because live API data is unavailable', 'info');
        this.render();
        return;
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
    const fund = summary?.fundProfile || {};
    PA.DB.exec(`INSERT OR REPLACE INTO securities(ticker,name,sector,industry,exchange,asset_type)
      VALUES(?,?,?,?,?,?)`, [
      ticker,
      quote.shortName || quote.longName || company.name || '',
      company.sector || quote.sector || fund.sectors?.[0]?.sector || '',
      company.industry || (quote.quoteType === 'ETF' ? 'ETF' : ''),
      quote.exchange || company.exchange || '',
      quote.quoteType === 'ETF' ? 'etf' : 'equity'
    ]);
    PA.DB.exec(`INSERT INTO quotes(ticker,price,open_price,high,low,close_price,prev_close,volume,avg_volume,
      market_cap,beta,pe_ratio,fwd_pe_ratio,eps,fwd_eps,dividend_yield,dividend_rate,ex_dividend_date,
      fifty_two_week_high,fifty_two_week_low,fifty_day_avg,two_hundred_day_avg,shares_outstanding,book_value,price_to_book,
      nav_price,net_assets,expense_ratio,portfolio_turnover,inception_date,leveraged)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      ticker, quote.regularMarketPrice, quote.regularMarketOpen, quote.regularMarketDayHigh,
      quote.regularMarketDayLow, quote.regularMarketPrice, quote.regularMarketPreviousClose,
      quote.regularMarketVolume, quote.averageDailyVolume3Month, quote.marketCap ?? this.v(sd.marketCap) ?? valuation.marketCap,
      this.v(ks.beta) ?? quote.beta, this.v(sd.trailingPE) ?? quote.trailingPE,
      this.v(ks.forwardPE) ?? this.v(sd.forwardPE), quote.epsTrailingTwelveMonths ?? earnings.eps, quote.epsForward,
      this.v(sd.dividendYield) ?? dividends.dividendYield, quote.dividendRate ?? dividends.dividendPerShare, quote.exDividendDate ?? dividends.exDividendDate,
      quote.fiftyTwoWeekHigh ?? this.v(sd.fiftyTwoWeekHigh), quote.fiftyTwoWeekLow ?? this.v(sd.fiftyTwoWeekLow),
      quote.fiftyDayAverage ?? this.v(sd.fiftyDayAverage), quote.twoHundredDayAverage ?? this.v(sd.twoHundredDayAverage), quote.sharesOutstanding ?? this.v(ks.sharesOutstanding),
      quote.bookValue ?? valuation.bookValue, quote.priceToBook ?? this.v(sd.priceToBook), quote.navPrice ?? fund.navPrice,
      quote.netAssets ?? fund.netAssets, quote.expenseRatio ?? fund.expenseRatio, quote.portfolioTurnover ?? fund.portfolioTurnover,
      quote.inceptionDate ?? fund.inceptionDate, quote.leveraged ?? fund.leveraged
    ]);
    // Save price history
    if (hist) {
      const hData = PA.API.parseHistory(hist);
      hData.dates.forEach((d, i) => {
        PA.DB.exec(`INSERT OR REPLACE INTO price_history(ticker,date,open_price,high,low,close_price,adj_close,volume)
          VALUES(?,?,?,?,?,?,?,?)`, [
          ticker,
          d,
          hData.opens?.[i],
          hData.highs?.[i],
          hData.lows?.[i],
          hData.prices[i],
          hData.adjustedPrices?.[i] ?? hData.prices[i],
          hData.volumes[i]
        ]);
      });
    }
    if ((fund.sectors?.length || 0) > 0 || (fund.holdings?.length || 0) > 0) {
      PA.DB.exec(`INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)`, [
        `fund_profile:${ticker}`,
        JSON.stringify({
          sectors: fund.sectors || [],
          holdings: fund.holdings || []
        })
      ]);
    }
    PA.DB.save();
    if (PA.App?.refreshDiagnostics) {
      PA.App.refreshDiagnostics();
    }
  },

  applyDerivedStats(quote, historyData) {
    return;
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
        navPrice: quoteRow.nav_price,
        bookValue: quoteRow.book_value,
        sharesOutstanding: quoteRow.shares_outstanding,
        fiftyTwoWeekHigh: quoteRow.fifty_two_week_high,
        fiftyTwoWeekLow: quoteRow.fifty_two_week_low,
        fiftyDayAverage: quoteRow.fifty_day_avg,
        twoHundredDayAverage: quoteRow.two_hundred_day_avg,
        exDividendDate: quoteRow.ex_dividend_date,
        netAssets: quoteRow.net_assets,
        expenseRatio: quoteRow.expense_ratio,
        portfolioTurnover: quoteRow.portfolio_turnover,
        inceptionDate: quoteRow.inception_date,
        leveraged: quoteRow.leveraged,
        marketState: 'UNKNOWN',
        currency: 'USD',
        exchange: security?.exchange || '',
        fullExchangeName: security?.exchange || '',
        quoteType: security?.asset_type === 'etf' ? 'ETF' : 'EQUITY'
      },
      hist,
      summary: this.loadSummaryFromDb(ticker)
    };
  },

  loadSummaryFromDb(ticker) {
    const security = PA.DB.selectOne(
      `SELECT ticker,name,sector,industry,exchange,asset_type FROM securities WHERE ticker=?`,
      [ticker]
    );
    const quoteRow = PA.DB.selectOne(
      `SELECT * FROM quotes WHERE ticker=? ORDER BY fetched_at DESC LIMIT 1`,
      [ticker]
    );
    const fundProfileRow = PA.DB.selectOne(
      `SELECT value FROM settings WHERE key=?`,
      [`fund_profile:${ticker}`]
    );
    if (!security && !quoteRow) return {};
    const wrap = value => value == null ? null : { raw: Number(value) };
    let storedFundProfile = {};
    if (fundProfileRow?.value) {
      try {
        storedFundProfile = JSON.parse(fundProfileRow.value) || {};
      } catch (e) {
        storedFundProfile = {};
      }
    }
    return {
      company: {
        name: security?.name || ticker,
        sector: security?.sector || '',
        industry: security?.industry || '',
        exchange: security?.exchange || ''
      },
      defaultKeyStatistics: {
        beta: wrap(quoteRow?.beta),
        forwardPE: wrap(quoteRow?.fwd_pe_ratio),
        sharesOutstanding: wrap(quoteRow?.shares_outstanding)
      },
      summaryDetail: {
        trailingPE: wrap(quoteRow?.pe_ratio),
        forwardPE: wrap(quoteRow?.fwd_pe_ratio),
        marketCap: wrap(quoteRow?.market_cap),
        dividendYield: wrap(quoteRow?.dividend_yield),
        fiftyTwoWeekLow: wrap(quoteRow?.fifty_two_week_low),
        fiftyTwoWeekHigh: wrap(quoteRow?.fifty_two_week_high),
        fiftyDayAverage: wrap(quoteRow?.fifty_day_avg),
        twoHundredDayAverage: wrap(quoteRow?.two_hundred_day_avg),
        priceToBook: wrap(quoteRow?.price_to_book)
      },
      earnings: {
        eps: quoteRow?.eps ?? null,
        forwardEps: quoteRow?.fwd_eps ?? null
      },
      valuation: {
        bookValue: quoteRow?.book_value ?? null,
        marketCap: quoteRow?.market_cap ?? null,
        priceToBook: quoteRow?.price_to_book ?? null
      },
      dividends: {
        dividendYield: quoteRow?.dividend_yield ?? null,
        dividendPerShare: quoteRow?.dividend_rate ?? null,
        exDividendDate: quoteRow?.ex_dividend_date ?? null
      },
      fundProfile: security?.asset_type === 'etf'
        ? {
            netAssets: quoteRow?.net_assets ?? null,
            navPrice: quoteRow?.nav_price ?? null,
            expenseRatio: quoteRow?.expense_ratio ?? null,
            portfolioTurnover: quoteRow?.portfolio_turnover ?? null,
            dividendYield: quoteRow?.dividend_yield ?? null,
            inceptionDate: quoteRow?.inception_date ?? null,
            leveraged: quoteRow?.leveraged ?? null,
            sectors: storedFundProfile?.sectors || [],
            holdings: storedFundProfile?.holdings || []
          }
        : null
    };
  },

  hasFundamentalData(summary) {
    const sd = summary?.summaryDetail || {};
    const valuation = summary?.valuation || {};
    const fund = summary?.fundProfile || {};
    return this.v(sd.marketCap) != null ||
      this.v(sd.trailingPE) != null ||
      valuation.bookValue != null ||
      this.v(sd.priceToBook) != null ||
      fund.netAssets != null ||
      fund.expenseRatio != null;
  },

  loadFreshFromDb(ticker, range='1Y') {
    const quoteRow = PA.DB.selectOne(
      `SELECT fetched_at FROM quotes WHERE ticker=? ORDER BY fetched_at DESC LIMIT 1`,
      [ticker]
    );
    if (!quoteRow?.fetched_at) return null;
    const fetchedAt = this.parseDbTimestamp(quoteRow.fetched_at);
    if (!fetchedAt) return null;
    if (Date.now() - fetchedAt.getTime() > PA.API.CACHE_TTL) return null;
    return this.loadFromDb(ticker, range);
  },

  parseDbTimestamp(value) {
    if (!value) return null;
    const iso = String(value).includes('T')
      ? String(value)
      : String(value).replace(' ', 'T') + 'Z';
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  },

  loadHistoryFromDb(ticker, range='1Y') {
    const cfg = PA.Config.RANGES[range] || PA.Config.RANGES['1Y'];
    const rows = PA.DB.selectAll(
      `SELECT date, open_price, high, low, COALESCE(adj_close, close_price) AS close_price, volume
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
      volumes: filtered.map(row => Number(row.volume || 0)),
      opens: filtered.map(row => row.open_price == null ? null : Number(row.open_price)),
      highs: filtered.map(row => row.high == null ? null : Number(row.high)),
      lows: filtered.map(row => row.low == null ? null : Number(row.low))
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
  currentName: 'Current Working Portfolio',

  init() {
    this.ensureDefaultPortfolios();
    this.loadFromDb();
    this.render();
    PA.Backtest?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioCompareOptions?.();
  },

  defaultPortfolios() {
    return [
      {
        name: 'Core 60/40',
        description: 'Balanced starter mix using broad U.S. equity and core investment-grade bonds.',
        benchmark: 'SPY',
        holdings: [
          { ticker: 'IVV', allocation: 60 },
          { ticker: 'AGG', allocation: 40 }
        ]
      },
      {
        name: 'Aggressive Growth',
        description: 'Growth-heavy blend tilted toward large-cap and Nasdaq-style growth exposure.',
        benchmark: 'QQQ',
        holdings: [
          { ticker: 'QQQ', allocation: 45 },
          { ticker: 'IWF', allocation: 35 },
          { ticker: 'IVV', allocation: 20 }
        ]
      },
      {
        name: 'Conservative Income',
        description: 'Income-first mix with core bonds, short Treasuries, low-volatility equity, and dividend quality.',
        benchmark: 'AGG',
        holdings: [
          { ticker: 'AGG', allocation: 40 },
          { ticker: 'SHY', allocation: 30 },
          { ticker: 'USMV', allocation: 20 },
          { ticker: 'SCHD', allocation: 10 }
        ]
      },
      {
        name: 'Fixed Income Core',
        description: 'Bond-focused allocation using aggregate bonds, short Treasuries, and inflation protection.',
        benchmark: 'AGG',
        holdings: [
          { ticker: 'AGG', allocation: 55 },
          { ticker: 'TIP', allocation: 25 },
          { ticker: 'SHY', allocation: 20 }
        ]
      },
      {
        name: 'Defensive Allocation',
        description: 'Defensive blend centered on minimum-volatility equity, dividend quality, and ballast from bonds/cash.',
        benchmark: 'SPY',
        holdings: [
          { ticker: 'USMV', allocation: 40 },
          { ticker: 'SCHD', allocation: 25 },
          { ticker: 'AGG', allocation: 20 },
          { ticker: 'SHY', allocation: 15 }
        ]
      },
      {
        name: 'Value Tilt',
        description: 'Value-oriented allocation emphasizing large-cap value and dividend quality.',
        benchmark: 'SPY',
        holdings: [
          { ticker: 'IWD', allocation: 50 },
          { ticker: 'SCHD', allocation: 30 },
          { ticker: 'IVV', allocation: 20 }
        ]
      }
    ];
  },

  ensureDefaultPortfolios() {
    this.defaultPortfolios().forEach(model => {
      let pid = null;
      const existing = PA.DB.selectOne(`SELECT id FROM portfolios WHERE name=? AND is_system=1`, [model.name]);
      if (existing?.id) {
        pid = existing.id;
        PA.DB.exec(`UPDATE portfolios SET description=?, benchmark=? WHERE id=?`, [model.description, model.benchmark || 'SPY', pid]);
        PA.DB.exec(`DELETE FROM portfolio_holdings WHERE portfolio_id=?`, [pid]);
      } else {
        PA.DB.exec(
          `INSERT INTO portfolios(name, description, benchmark, initial_balance, is_system) VALUES(?,?,?,?,1)`,
          [model.name, model.description, model.benchmark || 'SPY', 10000]
        );
        const row = PA.DB.selectOne(`SELECT last_insert_rowid() as id`);
        pid = row?.id;
      }
      if (!pid) return;
      model.holdings.forEach(h => {
        PA.DB.exec(
          `INSERT INTO portfolio_holdings(portfolio_id, ticker, allocation) VALUES(?,?,?)`,
          [pid, h.ticker, h.allocation]
        );
      });
    });
    PA.DB.save();
  },

  markWorkingCopy() {
    if (this.currentId != null) {
      this.currentId = null;
      this.currentName = 'Current Working Portfolio';
    }
  },

  addHolding(ticker, allocation) {
    ticker = ticker.toUpperCase().trim();
    if (!ticker) return;
    allocation = parseFloat(allocation) || 0;
    this.markWorkingCopy();
    const existing = this.holdings.find(h => h.ticker === ticker);
    if (existing) {
      existing.allocation = allocation;
    } else {
      this.holdings.push({ ticker, allocation });
    }
    this.render();
  },

  removeHolding(ticker) {
    this.markWorkingCopy();
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
    const activeLabel = this.currentId ? `${this.currentName || 'Saved Portfolio'} (saved)` : (this.currentName || 'Current Working Portfolio');

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px">Active Portfolio: <strong style="color:var(--text-primary)">${PA.UI.escapeHtml(activeLabel)}</strong></div>
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
    PA.Backtest?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioCompareOptions?.();
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
    if (h) {
      this.markWorkingCopy();
      h.allocation = parseFloat(value) || 0;
      this.render();
    }
  },

  normalize() {
    const total = this.getTotalAllocation();
    if (total === 0) return;
    this.markWorkingCopy();
    this.holdings.forEach(h => { h.allocation = (h.allocation / total) * 100; });
    this.render();
  },

  saveDialog() {
    const name = prompt('Portfolio name:', 'My Portfolio');
    if (!name) return;
    this.save(name);
  },

  save(name) {
    PA.DB.exec(`INSERT INTO portfolios(name, benchmark, initial_balance, is_system) VALUES(?,?,?,0)`,
      [name, 'SPY', 10000]);
    const row = PA.DB.selectOne(`SELECT last_insert_rowid() as id`);
    const pid = row.id;
    this.holdings.forEach(h => {
      PA.DB.exec(`INSERT INTO portfolio_holdings(portfolio_id, ticker, allocation) VALUES(?,?,?)`,
        [pid, h.ticker, h.allocation]);
    });
    this.currentId = pid;
    this.currentName = name;
    PA.DB.save();
    PA.UI.toast(`Portfolio "${name}" saved`, 'success');
    this.loadSavedList();
    PA.Backtest?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioCompareOptions?.();
  },

  loadFromDb() {
    const saved = PA.DB.selectAll(`SELECT * FROM portfolios WHERE COALESCE(is_system,0)=0 ORDER BY created_at DESC LIMIT 1`);
    if (saved.length) {
      this.currentId = saved[0].id;
      this.currentName = saved[0].name;
      const holdings = PA.DB.selectAll(`SELECT * FROM portfolio_holdings WHERE portfolio_id=?`, [this.currentId]);
      this.holdings = holdings.map(h => ({ ticker: h.ticker, allocation: h.allocation }));
    } else {
      this.currentId = null;
      this.currentName = 'Current Working Portfolio';
      this.holdings = [];
    }
  },

  loadPortfolio(id) {
    const portfolio = PA.DB.selectOne(`SELECT * FROM portfolios WHERE id=?`, [id]);
    const holdings = PA.DB.selectAll(`SELECT * FROM portfolio_holdings WHERE portfolio_id=?`, [id]);
    this.holdings = holdings.map(h => ({ ticker: h.ticker, allocation: h.allocation }));
    this.currentId = id;
    this.currentName = portfolio?.name || 'Saved Portfolio';
    this.render();
    PA.Backtest?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioCompareOptions?.();
    PA.UI.toast('Portfolio loaded', 'success');
  },

  loadSavedList() {
    const list = PA.DB.selectAll(`SELECT * FROM portfolios ORDER BY COALESCE(is_system,0) DESC, name ASC, created_at DESC`);
    const container = document.getElementById('saved-portfolios');
    if (!container) return;
    if (list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);padding:10px">No saved portfolios</div>';
      return;
    }
    container.innerHTML = list.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:600">${p.name} ${Number(p.is_system || 0) ? '<span style="font-size:0.72rem;color:var(--text-muted);font-weight:500">Default</span>' : ''}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">${PA.UI.escapeHtml(p.description || p.created_at || '')}</div>
        </div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" onclick="PA.Portfolio.loadPortfolio(${p.id})">Load</button>
          ${Number(p.is_system || 0)
            ? ''
            : `<button class="btn btn-sm btn-danger" onclick="PA.Portfolio.deletePortfolio(${p.id})">Del</button>`}
        </div>
      </div>
    `).join('');
    PA.Backtest?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioCompareOptions?.();
  },

  deletePortfolio(id) {
    const portfolio = PA.DB.selectOne(`SELECT is_system FROM portfolios WHERE id=?`, [id]);
    if (Number(portfolio?.is_system || 0)) {
      PA.UI.toast('Default model portfolios cannot be deleted', 'info');
      return;
    }
    PA.DB.exec(`DELETE FROM portfolios WHERE id=?`, [id]);
    PA.DB.exec(`DELETE FROM portfolio_holdings WHERE portfolio_id=?`, [id]);
    if (this.currentId === id) {
      this.currentId = null;
      this.currentName = 'Current Working Portfolio';
    }
    PA.DB.save();
    this.loadSavedList();
    this.render();
    PA.Backtest?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioOptions?.();
    PA.Compare?.syncPortfolioCompareOptions?.();
    PA.UI.toast('Portfolio deleted', 'info');
  },

  getSavedPortfolios() {
    return PA.DB.selectAll(`SELECT * FROM portfolios ORDER BY COALESCE(is_system,0) DESC, name ASC, created_at DESC`);
  },

  getPortfolioHoldingsById(id) {
    if (!id) return this.holdings.map(h => ({ ...h }));
    return PA.DB.selectAll(`SELECT * FROM portfolio_holdings WHERE portfolio_id=?`, [id])
      .map(h => ({ ticker: h.ticker, allocation: h.allocation }));
  },

  getPortfolioNameById(id) {
    if (!id) return this.currentName || 'Current Working Portfolio';
    const row = PA.DB.selectOne(`SELECT name FROM portfolios WHERE id=?`, [id]);
    return row?.name || 'Saved Portfolio';
  }
};
