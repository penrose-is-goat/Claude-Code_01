/* ============================================================
   Portfolio Analyzer Pro - Charts Module
   ============================================================ */
PA.Charts = {
  instances: {},
  destroy(id) {
    if (this.instances[id]) { this.instances[id].destroy(); delete this.instances[id]; }
  },
  getCtx(id) {
    this.destroy(id);
    const el = document.getElementById(id);
    if (!el) return null;
    return el.getContext('2d');
  },
  priceHistory(canvasId, dates, prices, volumes, label='Price') {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    this.instances[canvasId] = new Chart(ctx, {
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
              label: ctx => `${label}: $${ctx.parsed.y.toFixed(2)}`
            }
          }
        },
        scales: {
          x: {
            grid: { color:'rgba(45,50,72,0.5)' },
            ticks: { color:'#6b7280', maxTicksLimit:8, maxRotation:0 }
          },
          y: {
            position: 'right',
            grid: { color:'rgba(45,50,72,0.5)' },
            ticks: { color:'#6b7280', callback: v => '$'+v.toFixed(0) }
          }
        }
      }
    });
  },
  multiLine(canvasId, dates, datasets, opts={}) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    this.instances[canvasId] = new Chart(ctx, {
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
              label: ctx => {
                const fmt = opts.pct ? PA.Fmt.pct(ctx.parsed.y) : ('$'+ctx.parsed.y.toFixed(2));
                return `${ctx.dataset.label}: ${fmt}`;
              }
            }
          }
        },
        scales: {
          x: { grid:{color:'rgba(45,50,72,0.5)'}, ticks:{color:'#6b7280', maxTicksLimit:8, maxRotation:0} },
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
  },
  drawdown(canvasId, dates, ddSeries, label='Drawdown') {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    this.instances[canvasId] = new Chart(ctx, {
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
            callbacks:{ label: ctx => `Drawdown: ${(ctx.parsed.y*100).toFixed(2)}%` }
          }
        },
        scales: {
          x:{ grid:{color:'rgba(45,50,72,0.5)'}, ticks:{color:'#6b7280', maxTicksLimit:8, maxRotation:0} },
          y:{ position:'right', grid:{color:'rgba(45,50,72,0.5)'}, ticks:{color:'#6b7280', callback:v=>(v*100).toFixed(0)+'%'} }
        }
      }
    });
  },
  pie(canvasId, labels, values, colors) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    this.instances[canvasId] = new Chart(ctx, {
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
  },
  bar(canvasId, labels, datasets) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    this.instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: datasets.map((ds, i) => ({
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
  },
  scatter(canvasId, points, opts={}) {
    const ctx = this.getCtx(canvasId);
    if (!ctx) return;
    this.instances[canvasId] = new Chart(ctx, {
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
  }
};
