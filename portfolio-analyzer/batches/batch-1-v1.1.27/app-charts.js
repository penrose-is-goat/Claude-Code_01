/* ============================================================
   Portfolio Analyzer Pro - Charts Module
   ============================================================ */
PA.Charts = {
  instances: {},

  parseDateLabel(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const text = String(value).trim();
    if (!text) return null;
    const parsed = text.includes('T') ? new Date(text) : new Date(`${text}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  },

  formatChartDate(value, { full=false }={}) {
    const date = this.parseDateLabel(value);
    if (!date) return String(value ?? '');
    const raw = String(value ?? '');
    const hasTime = raw.includes('T');
    if (full) {
      return hasTime
        ? date.toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })
        : date.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
    }
    if (hasTime) {
      return date.toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    }
    return date.toLocaleDateString(undefined, { month:'short', day:'numeric' });
  },

  formatAxisDate(value) {
    const date = this.parseDateLabel(value);
    if (!date) return String(value ?? '');
    const raw = String(value ?? '');
    if (raw.includes('T')) {
      return [
        date.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }),
        date.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' })
      ];
    }
    return [
      date.toLocaleDateString(undefined, { month:'short', day:'numeric' }),
      date.toLocaleDateString(undefined, { year:'numeric' })
    ];
  },

  timeScaleOptions(labels, extra={}) {
    return {
      grid: { color:'rgba(45,50,72,0.5)' },
      ticks: {
        color:'#6b7280',
        autoSkip: true,
        autoSkipPadding: 12,
        maxTicksLimit: 5,
        maxRotation: 0,
        minRotation: 0,
        callback: (_, index) => this.formatAxisDate(labels[index])
      },
      ...extra
    };
  },

  plotlyDateAxis(extra={}) {
    return {
      type: 'date',
      gridcolor: 'rgba(45,50,72,0.35)',
      tickfont: { color: '#6b7280' },
      tickformat: '%b %d, %Y',
      hoverformat: '%b %d, %Y',
      tickangle: -30,
      nticks: 6,
      automargin: true,
      ...extra
    };
  },

  destroy(id) {
    const existing = this.instances[id];
    if (!existing) return;
    if (existing.type === 'plotly' && window.Plotly) {
      try { Plotly.purge(existing.el); } catch (e) {}
    } else if (existing.type === 'chartjs') {
      try { existing.instance.destroy(); } catch (e) {}
    }
    delete this.instances[id];
  },

  getCtx(id) {
    this.destroy(id);
    const el = document.getElementById(id);
    if (!el || typeof el.getContext !== 'function') return null;
    return el.getContext('2d');
  },

  registerChartJs(id, instance) {
    this.instances[id] = { type: 'chartjs', instance };
  },

  registerPlotly(id, el) {
    this.instances[id] = { type: 'plotly', el };
  },

  plotlyLayoutBase(height) {
    return {
      height,
      paper_bgcolor: '#1e2233',
      plot_bgcolor: '#1e2233',
      font: { family: 'Inter, sans-serif', color: '#9aa0a6' },
      margin: { l: 56, r: 56, t: 20, b: 36 },
      hovermode: 'x unified',
      showlegend: true,
      legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 11 } }
    };
  },

  advancedTickerChart(containerId, options={}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    this.destroy(containerId);
    const history = options.history || {};
    const dates = history.dates || [];
    const prices = history.prices || [];
    const opens = history.opens || [];
    const highs = history.highs || [];
    const lows = history.lows || [];
    const volumes = history.volumes || [];
    if (!window.Plotly || dates.length < 2) {
      if (el.tagName && el.tagName.toLowerCase() !== 'canvas') {
        const fallbackId = `${containerId}-fallback`;
        el.innerHTML = `<canvas id="${fallbackId}" style="width:100%;height:100%"></canvas>`;
        return this.priceHistory(fallbackId, dates, prices, volumes, options.ticker || 'Price');
      }
      return this.priceHistory(containerId, dates, prices, volumes, options.ticker || 'Price');
    }

    const movingAverages = (options.movingAverages || []).map(period => ({
      period,
      values: PA.Compute.movingAverage(prices, period)
    }));
    const compareHistory = options.compareHistory || {};
    const compareDates = compareHistory.dates || [];
    const comparePrices = compareHistory.prices || [];
    const showRSI = Boolean(options.showRSI);
    const showMACD = Boolean(options.showMACD);
    const chartHeight = options.height || (showRSI && showMACD ? 760 : (showRSI || showMACD ? 620 : 460));
    const traces = [];

    if (options.chartType === 'candlestick') {
      traces.push({
        type: 'candlestick',
        x: dates,
        open: opens,
        high: highs,
        low: lows,
        close: prices,
        name: options.ticker || 'Price',
        increasing: { line: { color: '#34d399' } },
        decreasing: { line: { color: '#f87171' } },
        xaxis: 'x',
        yaxis: 'y'
      });
    } else {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: prices,
        name: options.ticker || 'Price',
        line: { color: '#4f8ff7', width: 2 },
        xaxis: 'x',
        yaxis: 'y'
      });
    }

    movingAverages.forEach((ma, idx) => {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: ma.values,
        name: `MA ${ma.period}`,
        line: { width: 1.5, color: PA.Config.COLORS[(idx + 1) % PA.Config.COLORS.length], dash: idx % 2 ? 'dot' : 'solid' },
        connectgaps: false,
        xaxis: 'x',
        yaxis: 'y'
      });
    });

    if (options.showVolume) {
      traces.push({
        type: 'bar',
        x: dates,
        y: volumes,
        name: 'Volume',
        yaxis: 'y2',
        xaxis: 'x',
        marker: { color: 'rgba(148,163,184,0.25)' },
        opacity: 0.35
      });
    }

    if (options.compareTicker && compareDates.length) {
      const compareMap = new Map(compareDates.map((date, i) => [date, comparePrices[i]]));
      const alignedDates = [];
      const alignedTickerPrices = [];
      const alignedComparePrices = [];
      dates.forEach((date, i) => {
        const comparePrice = compareMap.get(date);
        if (Number.isFinite(prices[i]) && Number.isFinite(comparePrice)) {
          alignedDates.push(date);
          alignedTickerPrices.push(prices[i]);
          alignedComparePrices.push(comparePrice);
        }
      });
      const tickerPerf = PA.Compute.normalizePerformance(alignedTickerPrices);
      const comparePerf = PA.Compute.normalizePerformance(alignedComparePrices);
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: alignedDates,
        y: tickerPerf,
        name: `${options.ticker} %`,
        xaxis: 'x',
        yaxis: 'y3',
        line: { color: '#a78bfa', width: 1.5, dash: 'dot' }
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: alignedDates,
        y: comparePerf,
        name: `${options.compareTicker} %`,
        xaxis: 'x',
        yaxis: 'y3',
        line: { color: '#fbbf24', width: 1.5 }
      });
    }

    const mainDomain = showRSI && showMACD
      ? [0.44, 1]
      : (showRSI || showMACD ? [0.32, 1] : [0, 1]);
    const rsiDomain = showRSI && showMACD
      ? [0.22, 0.38]
      : (showRSI ? [0, 0.24] : null);
    const macdDomain = showRSI && showMACD
      ? [0, 0.16]
      : (showMACD ? [0, 0.24] : null);

    if (showRSI) {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: options.rsiValues || [],
        name: 'RSI',
        line: { color: '#22d3ee', width: 1.8 },
        xaxis: 'x2',
        yaxis: 'y4'
      });
    }

    if (showMACD) {
      const macd = options.macd || {};
      const histogram = macd.histogram || [];
      traces.push({
        type: 'bar',
        x: dates,
        y: histogram,
        name: 'MACD Hist',
        xaxis: showRSI ? 'x3' : 'x2',
        yaxis: 'y5',
        marker: {
          color: histogram.map(value => (value ?? 0) >= 0 ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)')
        },
        opacity: 0.55
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: macd.macdLine || [],
        name: 'MACD',
        xaxis: showRSI ? 'x3' : 'x2',
        yaxis: 'y5',
        line: { color: '#4f8ff7', width: 1.8 }
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: macd.signalLine || [],
        name: 'Signal',
        xaxis: showRSI ? 'x3' : 'x2',
        yaxis: 'y5',
        line: { color: '#fbbf24', width: 1.4 }
      });
    }

    const layout = {
      ...this.plotlyLayoutBase(chartHeight),
      xaxis: this.plotlyDateAxis({
        domain: [0, 1],
        anchor: 'y',
        rangeslider: { visible: false },
        showticklabels: !(showRSI || showMACD)
      }),
      yaxis: {
        domain: mainDomain,
        side: 'right',
        gridcolor: 'rgba(45,50,72,0.35)',
        tickprefix: '$',
        tickfont: { color: '#6b7280' },
        title: { text: 'Price', font: { size: 11 } }
      },
      yaxis2: {
        overlaying: 'y',
        side: 'left',
        showgrid: false,
        visible: false
      },
      yaxis3: {
        overlaying: 'y',
        side: 'left',
        tickformat: '.0%',
        tickfont: { color: '#fbbf24' },
        showgrid: false,
        visible: Boolean(options.compareTicker)
      },
      xaxis2: this.plotlyDateAxis({
        domain: [0, 1],
        anchor: showRSI ? 'y4' : 'y5',
        matches: 'x',
        showticklabels: showRSI ? !showMACD : showMACD
      }),
      yaxis4: {
        domain: rsiDomain || [0, 0],
        gridcolor: 'rgba(45,50,72,0.35)',
        tickfont: { color: '#6b7280' },
        range: [0, 100],
        title: { text: showRSI ? 'RSI' : '', font: { size: 11 } },
        visible: showRSI
      },
      xaxis3: this.plotlyDateAxis({
        domain: [0, 1],
        anchor: 'y5',
        matches: 'x',
        showticklabels: showMACD
      }),
      yaxis5: {
        domain: macdDomain || [0, 0],
        gridcolor: 'rgba(45,50,72,0.35)',
        zerolinecolor: 'rgba(148,163,184,0.45)',
        tickfont: { color: '#6b7280' },
        title: { text: showMACD ? 'MACD' : '', font: { size: 11 } },
        visible: showMACD
      },
      shapes: showRSI ? [
        { type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y4', y0: 70, y1: 70, line: { color: '#f87171', width: 1, dash: 'dot' } },
        { type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y4', y0: 30, y1: 30, line: { color: '#34d399', width: 1, dash: 'dot' } }
      ] : [],
      barmode: 'overlay'
    };

    Plotly.newPlot(el, traces, layout, {
      responsive: true,
      displayModeBar: false
    });
    this.registerPlotly(containerId, el);
  },

  indicatorRSI(containerId, dates, rsiValues) {
    const el = document.getElementById(containerId);
    if (!el || !window.Plotly) return;
    this.destroy(containerId);
    const traces = [
      {
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: rsiValues,
        name: 'RSI',
        line: { color: '#22d3ee', width: 2 }
      }
    ];
    const layout = {
      ...this.plotlyLayoutBase(220),
      xaxis: this.plotlyDateAxis(),
      yaxis: {
        range: [0, 100],
        gridcolor: 'rgba(45,50,72,0.35)',
        tickfont: { color: '#6b7280' }
      },
      shapes: [
        { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 70, y1: 70, line: { color: '#f87171', width: 1, dash: 'dot' } },
        { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 30, y1: 30, line: { color: '#34d399', width: 1, dash: 'dot' } }
      ]
    };
    Plotly.newPlot(el, traces, layout, { responsive: true, displayModeBar: false });
    this.registerPlotly(containerId, el);
  },

  indicatorMACD(containerId, dates, macd={}) {
    const el = document.getElementById(containerId);
    if (!el || !window.Plotly) return;
    this.destroy(containerId);
    const histogram = macd.histogram || [];
    const traces = [
      {
        type: 'bar',
        x: dates,
        y: histogram,
        name: 'Histogram',
        marker: {
          color: histogram.map(value => (value ?? 0) >= 0 ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)')
        }
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: macd.macdLine || [],
        name: 'MACD',
        line: { color: '#4f8ff7', width: 2 }
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: macd.signalLine || [],
        name: 'Signal',
        line: { color: '#fbbf24', width: 1.8 }
      }
    ];
    const layout = {
      ...this.plotlyLayoutBase(220),
      xaxis: this.plotlyDateAxis(),
      yaxis: {
        gridcolor: 'rgba(45,50,72,0.35)',
        tickfont: { color: '#6b7280' },
        zerolinecolor: 'rgba(148,163,184,0.4)'
      },
      barmode: 'relative'
    };
    Plotly.newPlot(el, traces, layout, { responsive: true, displayModeBar: false });
    this.registerPlotly(containerId, el);
  },

  priceHistory(canvasId, dates, prices, volumes, label='Price') {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [{
          label: label,
          data: prices,
          borderColor: PA.Config.COLORS[0],
          backgroundColor: 'rgba(79,143,247,0.08)',
          fill: true,
          tension: 0.1,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode:'index', intersect:false },
        plugins: {
          legend: { display:false },
          tooltip: {
            backgroundColor: '#1e2233',
            titleColor: '#e8eaed',
            bodyColor: '#e8eaed',
            borderColor: '#2d3248',
            borderWidth: 1,
            callbacks: {
              title: items => this.formatChartDate(items?.[0]?.label, { full:true }),
              label: ctx => `${label}: $${ctx.parsed.y.toFixed(2)}`
            }
          }
        },
        scales: {
          x: this.timeScaleOptions(dates),
          y: {
            position: 'right',
            grid: { color:'rgba(45,50,72,0.5)' },
            ticks: { color:'#6b7280', callback: v => '$'+v.toFixed(0) }
          }
        }
      }
    });
    this.registerChartJs(canvasId, chart);
  },

  multiLine(canvasId, dates, datasets, opts={}) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: datasets.map((ds, i) => ({
          label: ds.label,
          data: ds.data,
          borderColor: ds.color || PA.Config.COLORS[i % PA.Config.COLORS.length],
          backgroundColor: 'transparent',
          tension: 0.1,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2,
          ...ds
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode:'index', intersect:false },
        plugins: {
          legend: { position:'top', labels:{color:'#9aa0a6', usePointStyle:true, pointStyle:'circle', padding:16 }},
          tooltip: {
            backgroundColor:'#1e2233', titleColor:'#e8eaed', bodyColor:'#e8eaed',
            borderColor:'#2d3248', borderWidth:1,
            callbacks: {
              title: items => this.formatChartDate(items?.[0]?.label, { full:true }),
              label: ctx => {
                const fmt = opts.pct ? PA.Fmt.pct(ctx.parsed.y) : ('$'+ctx.parsed.y.toFixed(2));
                return `${ctx.dataset.label}: ${fmt}`;
              }
            }
          }
        },
        scales: {
          x: this.timeScaleOptions(dates),
          y: {
            position:'right',
            grid:{color:'rgba(45,50,72,0.5)'},
            ticks:{
              color:'#6b7280',
              callback: v => opts.pct ? (v*100).toFixed(0)+'%' : '$'+v.toFixed(0)
            }
          }
        }
      }
    });
    this.registerChartJs(canvasId, chart);
  },

  drawdown(canvasId, dates, ddSeries, label='Drawdown') {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [{
          label: label,
          data: ddSeries,
          borderColor: '#f87171',
          backgroundColor: 'rgba(248,113,113,0.15)',
          fill: true,
          tension: 0.1,
          pointRadius: 0,
          borderWidth: 1.5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend:{display:false},
          tooltip:{
            backgroundColor:'#1e2233', titleColor:'#e8eaed', bodyColor:'#e8eaed',
            borderColor:'#2d3248', borderWidth:1,
            callbacks:{
              title: items => this.formatChartDate(items?.[0]?.label, { full:true }),
              label: ctx => `Drawdown: ${(ctx.parsed.y*100).toFixed(2)}%`
            }
          }
        },
        scales: {
          x: this.timeScaleOptions(dates),
          y:{ position:'right', grid:{color:'rgba(45,50,72,0.5)'}, ticks:{color:'#6b7280', callback:v=>(v*100).toFixed(0)+'%'} }
        }
      }
    });
    this.registerChartJs(canvasId, chart);
  },

  pie(canvasId, labels, values, colors) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    const chart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors || labels.map((_, i) => PA.Config.COLORS[i % PA.Config.COLORS.length]),
          borderColor: '#0f1117',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: { position:'right', labels:{color:'#9aa0a6', usePointStyle:true, pointStyle:'circle', padding:10, font:{size:12}} },
          tooltip: {
            backgroundColor:'#1e2233', titleColor:'#e8eaed', bodyColor:'#e8eaed',
            callbacks:{ label: ctx => `${ctx.label}: ${ctx.parsed.toFixed(1)}%` }
          }
        }
      }
    });
    this.registerChartJs(canvasId, chart);
  },

  bar(canvasId, labels, datasets) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: datasets.map(ds => ({
          label: ds.label,
          data: ds.data,
          backgroundColor: ds.data.map(v => v >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)'),
          borderColor: ds.data.map(v => v >= 0 ? '#34d399' : '#f87171'),
          borderWidth: 1,
          borderRadius: 3
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend:{display: datasets.length > 1, labels:{color:'#9aa0a6'}},
          tooltip:{
            backgroundColor:'#1e2233', titleColor:'#e8eaed', bodyColor:'#e8eaed',
            callbacks:{ label: ctx => `${ctx.dataset.label}: ${(ctx.parsed.y*100).toFixed(2)}%` }
          }
        },
        scales: {
          x:{grid:{display:false}, ticks:{color:'#6b7280'}},
          y:{grid:{color:'rgba(45,50,72,0.5)'}, ticks:{color:'#6b7280', callback:v=>(v*100).toFixed(0)+'%'}}
        }
      }
    });
    this.registerChartJs(canvasId, chart);
  },

  scatter(canvasId, points, opts={}) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    const chart = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          data: points.map(p => ({x:p.x, y:p.y})),
          backgroundColor: points.map((_, i) => PA.Config.COLORS[i % PA.Config.COLORS.length]),
          pointRadius: 8,
          pointHoverRadius: 10
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend:{display:false},
          tooltip:{
            backgroundColor:'#1e2233', titleColor:'#e8eaed', bodyColor:'#e8eaed',
            callbacks:{
              label: ctx => {
                const p = points[ctx.dataIndex];
                return `${p.label}: Risk ${(p.x*100).toFixed(1)}%, Return ${(p.y*100).toFixed(1)}%`;
              }
            }
          }
        },
        scales: {
          x:{title:{display:true, text:opts.xLabel||'Risk (Volatility)', color:'#9aa0a6'},
             grid:{color:'rgba(45,50,72,0.5)'}, ticks:{color:'#6b7280', callback:v=>(v*100).toFixed(0)+'%'}},
          y:{title:{display:true, text:opts.yLabel||'Return (CAGR)', color:'#9aa0a6'},
             grid:{color:'rgba(45,50,72,0.5)'}, ticks:{color:'#6b7280', callback:v=>(v*100).toFixed(0)+'%'}}
        }
      }
    });
    this.registerChartJs(canvasId, chart);
  }
};
