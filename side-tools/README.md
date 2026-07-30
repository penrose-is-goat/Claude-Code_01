# Side Tools

Standalone, self-contained finance tools that complement the main Portfolio
Analyzer Pro app (`../index.html`). Each is a single HTML file — download it,
double-click it, done. No server, no build step, no API key required (tools
fall back to clearly-labeled demo data when live sources are unreachable).

| Tool | File | What it does |
|------|------|--------------|
| **FRED Tool** | `fred-tool.html` | Type a plain-English request like *"show me the 10yr treasury yield, the s&p 500 and the federal funds rate for the last 10 years"* and get an interactive chart of FRED economic data. Play with it: time-range presets + custom dates, per-series left/right axis toggles, log scales, normalize-to-100 mode, and recession shading. ~32 series supported (treasuries, fed funds, CPI/inflation, unemployment, GDP, M2, S&P 500, VIX, mortgage rates, oil, bitcoin, and more). |
| **Fed Rate Tracker** | `fed-tracker.html` | CME FedWatch-style FOMC rate-change probabilities computed from 30-Day Fed Fund futures prices. Editable futures prices recompute probabilities live. |

## FRED Tool data sources

1. [`fred.libhack.so`](https://github.com/proprietary/stlouisfed-fred-web-proxy) — free open CORS proxy for FRED, no key needed (primary)
2. FRED's public `fredgraph.csv` export via generic CORS proxies (fallback)
3. Built-in deterministic demo data, labeled **DEMO DATA** (offline fallback)

A green **LIVE FRED DATA** / yellow **DEMO DATA** badge under the chart always
tells you which mode you're in.

## Fed Rate Tracker data

Ships with illustrative ZQ futures prices (dated in the UI). Refresh them in
seconds from CME's public 30-Day Fed Funds quotes page — probabilities
recompute as you type.

## Skills

Each tool has a matching skill documenting its methodology so it can be
rebuilt or extended:

- `.claude/skills/fred-tool/SKILL.md`
- `.claude/skills/fed-tracker/SKILL.md`

## Testing

Pure logic (query parser, time parser, CSV parsing, YoY transform,
forward-fill alignment, probability math) is headless-tested with Node
before each change. Live network fetches degrade gracefully to demo mode.
