# Portfolio Analyzer yfinance Backend

This backend serves live market data to the frontend using `yfinance`.

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
- Provider return fields now include unit metadata as well, because Yahoo/yfinance mixes ratio-style and percent-point-style return values across different summary fields.
- The health endpoint reports the backend batch version so the frontend can detect stale backend sessions after a backend update.
- If `python` is not on PATH but `py` is, use [start-backend.ps1](C:/Users/thleg/OneDrive/Documents/New%20project/portfolio-analyzer-fixed/backend/start-backend.ps1) or [start-backend.bat](C:/Users/thleg/OneDrive/Documents/New%20project/portfolio-analyzer-fixed/backend/start-backend.bat).
