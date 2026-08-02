#!/usr/bin/env python3
"""
serve.py - run the tools with a real backend so they fetch their own data.

The HTML tools cannot call FRED or CME directly: browsers block cross-origin
requests (CORS). Python has no such restriction. This starts a small local
server that serves the pages AND proxies the data APIs, so the tools fetch
from their own origin and everything just works - no CSV downloading, no
copy-paste, no API key.

    python3 serve.py            # starts http://localhost:8000 and opens it
    python3 serve.py --port 9000
    python3 serve.py --no-open

Endpoints it exposes to the pages:
    /api/health                     -> {"ok":true}
    /api/fred?id=DGS10&start=&end=  -> {"id","obs":[[date,value],...],"source"}
    /api/zq                         -> {"contracts":[{ym,label,price}],"mid","source"}

Every response says where the data came from. If a source fails, the error is
reported - nothing is ever invented.
"""
import argparse, csv, io, json, os, re, ssl, sys, threading, time, urllib.error, urllib.parse, urllib.request, webbrowser
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
MONTHCODE = {"F":1,"G":2,"H":3,"J":4,"K":5,"M":6,"N":7,"Q":8,"U":9,"V":10,"X":11,"Z":12}
_cache, _cache_lock = {}, threading.Lock()
CACHE_TTL = 900   # 15 min


def http_get(url, headers=None, timeout=30):
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout,
                                context=ssl.create_default_context()) as r:
        return r.read().decode("utf-8", "replace")


def cached(key, fn):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (time.time(), val)
    return val


# ---------------------------------------------------------------- FRED
def fred_csv(series_id, start, end):
    """FRED's public CSV export. No API key."""
    url = ("https://fred.stlouisfed.org/graph/fredgraph.csv"
           f"?id={urllib.parse.quote(series_id)}&cosd={start}&coed={end}")
    text = http_get(url)
    if "<html" in text[:200].lower():
        raise ValueError("FRED returned HTML, not CSV (bad series id?)")
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2:
            continue
        d, v = row[0].strip(), row[1].strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d) or v in (".", ""):
            continue
        try:
            rows.append([d, float(v)])
        except ValueError:
            pass
    if len(rows) < 2:
        raise ValueError("no usable observations")
    return rows, "FRED fredgraph.csv"


def fred_api(series_id, start, end, key):
    url = ("https://api.stlouisfed.org/fred/series/observations"
           f"?series_id={urllib.parse.quote(series_id)}&api_key={key}&file_type=json"
           f"&observation_start={start}&observation_end={end}")
    data = json.loads(http_get(url))
    rows = [[o["date"], float(o["value"])] for o in data.get("observations", [])
            if o.get("value") not in (".", "", None)]
    if len(rows) < 2:
        raise ValueError("no usable observations")
    return rows, "FRED API"


def get_fred(series_id, start, end):
    key = os.environ.get("FRED_API_KEY", "").strip()
    errors = []
    for name, fn in (("fredgraph", lambda: fred_csv(series_id, start, end)),
                     ("fred-api", (lambda: fred_api(series_id, start, end, key)) if key else None)):
        if fn is None:
            continue
        try:
            rows, src = fn()
            return {"id": series_id, "obs": rows, "source": src,
                    "start": rows[0][0], "end": rows[-1][0], "count": len(rows)}
        except Exception as e:
            errors.append(f"{name}: {e}")
    raise RuntimeError("; ".join(errors) or "all FRED sources failed")


# ---------------------------------------------------------------- ZQ futures
def zq_from_cme():
    """CME's public quote feed for 30-Day Fed Funds (product 305)."""
    url = "https://www.cmegroup.com/CmeWS/mvc/Quotes/Future/305/G"
    raw = http_get(url, headers={
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.quotes.html",
        "X-Requested-With": "XMLHttpRequest",
    })
    data = json.loads(raw)
    out = []
    for q in data.get("quotes", []):
        price = None
        for f in ("priorSettle", "last", "close", "open"):
            v = q.get(f)
            if v and str(v).strip() not in ("-", "--", ""):
                try:
                    price = float(str(v).replace(",", "").lstrip("@"))
                    break
                except ValueError:
                    pass
        if price is None or not (80 < price < 100):
            continue
        ym = None
        code = (q.get("quoteCode") or "").strip()
        m = re.search(r"([FGHJKMNQUVXZ])(\d{1,2})$", code)
        exp = str(q.get("expirationDate") or "")
        if re.match(r"^\d{8}$", exp):
            ym = f"{exp[:4]}-{exp[4:6]}"
        elif m:
            mon, yd = MONTHCODE[m.group(1)], int(m.group(2))
            cur = date.today().year
            yr = (cur // 10) * 10 + yd if len(m.group(2)) == 1 else 2000 + yd
            if yr < cur:
                yr += 10
            ym = f"{yr:04d}-{mon:02d}"
        if ym:
            out.append({"ym": ym, "label": code or ym, "price": round(price, 4)})
    if not out:
        raise ValueError("no usable ZQ contracts in CME response")
    out.sort(key=lambda c: c["ym"])
    return out, "CME Group quote feed"


def zq_from_yahoo():
    """Yahoo Finance carries ZQ contracts as e.g. ZQU26.CBT."""
    out = []
    today = date.today()
    inv = {v: k for k, v in MONTHCODE.items()}
    for i in range(9):
        mo = today.month + i
        yr = today.year + (mo - 1) // 12
        mo = (mo - 1) % 12 + 1
        sym = f"ZQ{inv[mo]}{str(yr)[-2:]}.CBT"
        try:
            u = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=5d&interval=1d"
            j = json.loads(http_get(u, timeout=15))
            res = (j.get("chart") or {}).get("result") or []
            if not res:
                continue
            meta = res[0].get("meta") or {}
            px = meta.get("regularMarketPrice") or meta.get("previousClose")
            if px and 80 < float(px) < 100:
                out.append({"ym": f"{yr:04d}-{mo:02d}", "label": sym,
                            "price": round(float(px), 4)})
        except Exception:
            continue
    if not out:
        raise ValueError("Yahoo returned no ZQ contracts")
    out.sort(key=lambda c: c["ym"])
    return out, "Yahoo Finance (ZQ*.CBT)"


def effr_target_mid():
    """Snap the effective fed funds rate to its 25bp target-band midpoint."""
    rows, _ = fred_csv("DFF", (date.today().replace(year=date.today().year - 1)).isoformat(),
                       date.today().isoformat())
    effr = rows[-1][1]
    return round(round((effr - 0.125) / 0.25) * 0.25 + 0.125, 4), effr


def get_zq():
    errors = []
    for fn in (zq_from_cme, zq_from_yahoo):
        try:
            contracts, src = fn()
            mid = effr = None
            try:
                mid, effr = effr_target_mid()
            except Exception as e:
                errors.append(f"effr: {e}")
            return {"contracts": contracts, "mid": mid, "effr": effr,
                    "source": src, "asOf": datetime.now().strftime("%Y-%m-%d %H:%M"),
                    "notes": errors}
        except Exception as e:
            errors.append(f"{fn.__name__}: {e}")
    raise RuntimeError("; ".join(errors))


# ---------------------------------------------------------------- server
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *a):
        msg = fmt % a
        if "/api/" in msg:
            sys.stderr.write("  " + msg.split('"')[1] + "\n")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/health":
                return self._send(200, json.dumps({"ok": True, "server": "serve.py"}))

            if u.path == "/api/fred":
                sid = (q.get("id") or [""])[0].strip().upper()
                if not sid:
                    return self._send(400, json.dumps({"error": "missing id"}))
                start = (q.get("start") or ["1900-01-01"])[0]
                end = (q.get("end") or [date.today().isoformat()])[0]
                res = cached(f"fred:{sid}:{start}:{end}", lambda: get_fred(sid, start, end))
                return self._send(200, json.dumps(res))

            if u.path == "/api/zq":
                return self._send(200, json.dumps(cached("zq", get_zq)))

            path = u.path.lstrip("/") or "fred-tool.html"
            if path == "index.html":
                path = "fred-tool.html"
            fp = os.path.normpath(os.path.join(HERE, path))
            if not fp.startswith(HERE) or not os.path.isfile(fp):
                return self._send(404, "Not found: " + path, "text/plain")
            ctype = ("text/html" if fp.endswith(".html") else
                     "text/css" if fp.endswith(".css") else
                     "application/javascript" if fp.endswith(".js") else
                     "text/plain")
            with open(fp, "rb") as f:
                return self._send(200, f.read(), ctype + "; charset=utf-8")

        except Exception as e:
            return self._send(502, json.dumps({"error": str(e)}))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    base = f"http://localhost:{a.port}"
    print(f"""
  Serving the tools with a live data backend.

    FRED Tool     {base}/fred-tool.html
    Fed Tracker   {base}/fed-tracker.html

  The pages now fetch real data through this server, so CORS does not apply.
  Data comes from FRED's public CSV export and CME's public quote feed.
  Set FRED_API_KEY in your environment to add the official FRED API as a
  fallback (free key: fred.stlouisfed.org/docs/api/api_key.html).

  Ctrl-C to stop.
""")
    if not a.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(base + "/fred-tool.html")).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
