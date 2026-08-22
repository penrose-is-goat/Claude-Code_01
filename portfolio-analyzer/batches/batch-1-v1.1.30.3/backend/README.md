# Portfolio Analyzer Market-Data Backend

This backend serves live market data to the frontend using `yfinance`, direct Yahoo chart fallbacks, and canonical macro/index fallback chains for supported Strategy Lab series such as `DGS10` and `SP500`.

## Endpoints

- `GET /api/health`
- `GET /api/search?q=nvda`
- `GET /api/quote?symbols=NVDA,SPY`
- `GET /api/summary?symbol=NVDA`
- `GET /api/history?symbols=NVDA,SPY&range=1Y`

## Setup

1. Install Python 3.11 or newer
2. Open PowerShell in this folder
3. Run:

```powershell
python -m pip install -r .\requirements.txt
python .\server.py
```

The backend will listen on:

`http://127.0.0.1:8765`

## Notes

- The frontend is configured to talk to `http://127.0.0.1:8765/api` by default.
- Live ticker values are returned from `yfinance` field lookups rather than browser-side calculations.
- If a field is unavailable from the provider, the backend returns `null` and includes provider field metadata so the frontend can explain the gap instead of fabricating a value.
- Percent-style provider fields now include unit metadata so ETF values such as expense ratio, turnover, and yield can render in the same units Yahoo/yfinance intended.
- ETF `NAV` is passed through from `info.navPrice` when Yahoo/yfinance exposes it.
- Displayed `YTD` and `1Y` returns come from adjusted-close total return on the backend.
- Displayed ETF/fund `3Y` and `5Y` returns are aligned to Yahoo-style annualized performance rather than cumulative total return.
- History requests now support multiple chart intervals for ticker analysis (`15m`, `1h`, `1d`, `1wk`, `1mo`).
- Strategy Lab can request supported canonical macro/index series directly, and the backend will fall through multiple providers when one source comes back empty.
- The health endpoint reports the backend batch version so the frontend can detect stale backend sessions after a backend update.
- If `python` is not on PATH but `py` is, use [start-backend.ps1](C:/Users/thleg/OneDrive/Documents/New%20project/portfolio-analyzer-fixed/backend/start-backend.ps1) or [start-backend.bat](C:/Users/thleg/OneDrive/Documents/New%20project/portfolio-analyzer-fixed/backend/start-backend.bat).
