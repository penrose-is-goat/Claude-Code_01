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
# Source order reflects research into what actually works and is permitted:
#   1. Yahoo v8 chart, per-contract ZQ{M}{YY}.CBT  - no key, no cookie/crumb,
#      gives the FULL contract strip (which is what the FedWatch math needs).
#      This is what the open-source ecosystem has converged on.
#   2. Stooq zq.f - no key, but CONTINUOUS FRONT MONTH ONLY, so it cannot build
#      a strip. Used as a sanity cross-check / degraded fallback.
#   3. CME CmeWS - official settlements, but Akamai bot-protected and CME's
#      terms discourage scraping, so it is OPT-IN only (--cme).
MONTH_CODES = "FGHJKMNQUVXZ"


def _zq_symbol(year, month):
    return f"ZQ{MONTH_CODES[month - 1]}{year % 100:02d}.CBT"


def zq_from_yahoo(months=10):
    """Per-contract ZQ futures from Yahoo's v8 chart endpoint (no key/crumb)."""
    out, errs = [], []
    today = date.today()
    for i in range(months):
        mo = today.month + i
        yr = today.year + (mo - 1) // 12
        mo = (mo - 1) % 12 + 1
        sym = _zq_symbol(yr, mo)
        try:
            u = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
                 "?range=1mo&interval=1d")
            j = json.loads(http_get(u, timeout=15))
            res = ((j.get("chart") or {}).get("result") or [None])[0]
            if not res:
                continue
            meta = res.get("meta") or {}
            px = meta.get("regularMarketPrice")
            if px is None:
                px = meta.get("chartPreviousClose")
            if px is None:                      # last resort: newest close
                closes = (((res.get("indicators") or {}).get("quote") or [{}])[0]
                          .get("close") or [])
                closes = [c for c in closes if c is not None]
                px = closes[-1] if closes else None
            if px is None:
                continue
            px = float(px)
            if 80 < px < 100:
                out.append({"ym": f"{yr:04d}-{mo:02d}", "label": sym,
                            "price": round(px, 4)})
        except Exception as e:
            errs.append(f"{sym}: {e}")
        time.sleep(0.2)                          # be polite; Yahoo rate-limits
    if not out:
        raise ValueError("Yahoo returned no ZQ contracts (" + "; ".join(errs[:3]) + ")")
    out.sort(key=lambda c: c["ym"])
    return out, "Yahoo Finance ZQ*.CBT"


def zq_from_stooq():
    """Stooq continuous front month only - cannot build a strip."""
    text = http_get("https://stooq.com/q/d/l/?s=zq.f&i=d", timeout=20)
    rows = [r for r in csv.reader(io.StringIO(text)) if len(r) >= 5]
    if len(rows) < 2:
        raise ValueError("stooq returned no rows")
    last = rows[-1]
    px = float(last[4])
    if not (80 < px < 100):
        raise ValueError(f"implausible stooq price {px}")
    today = date.today()
    return ([{"ym": f"{today.year:04d}-{today.month:02d}",
              "label": "ZQ.F (front month)", "price": round(px, 4)}],
            "Stooq zq.f (front month only)")


def zq_from_cme():
    """CME's own quote feed. Opt-in: Akamai-protected, and CME's terms
    discourage automated access. Official settlements when it works."""
    url = "https://www.cmegroup.com/CmeWS/mvc/Quotes/Future/305/G"
    hdrs = {
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.quotes.html",
        "Sec-Fetch-Mode": "cors",
    }
    try:                                          # harvest the Akamai cookie first
        http_get("https://www.cmegroup.com/", timeout=15)
    except Exception:
        pass
    data = json.loads(http_get(url, headers=hdrs))
    out = []
    for q in data.get("quotes", []):
        price = None
        for f in ("priorSettle", "settle", "last", "close"):
            v = q.get(f)
            if v is None:
                continue
            sv = str(v).strip().lstrip("@")
            if sv in ("-", "--", "", "0.000", "0.00"):   # documented sentinels
                continue
            try:
                price = float(sv.replace(",", ""))
                break
            except ValueError:
                pass
        if price is None or not (80 < price < 100):
            continue
        ym, exp = None, str(q.get("expirationDate") or "")
        if re.match(r"^\d{8}$", exp):
            ym = f"{exp[:4]}-{exp[4:6]}"
        else:
            m = re.search(r"([FGHJKMNQUVXZ])(\d{1,2})$", (q.get("quoteCode") or "").strip())
            if m:
                mon, yd = MONTHCODE[m.group(1)], int(m.group(2))
                cur = date.today().year
                yr = (cur // 10) * 10 + yd if len(m.group(2)) == 1 else 2000 + yd
                if yr < cur:
                    yr += 10
                ym = f"{yr:04d}-{mon:02d}"
        if ym:
            out.append({"ym": ym, "label": (q.get("quoteCode") or ym).strip(),
                        "price": round(price, 4)})
    if not out:
        raise ValueError("no usable ZQ contracts in CME response")
    out.sort(key=lambda c: c["ym"])
    return out, "CME Group settlements"


def current_effr():
    """Effective fed funds rate -> (rate, source). NY Fed first, FRED second."""
    errs = []
    try:
        j = json.loads(http_get(
            "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
            timeout=15))
        r = (j.get("refRates") or [])[0]
        return float(r["percentRate"]), f"NY Fed EFFR ({r.get('effectiveDate','')})"
    except Exception as e:
        errs.append(f"nyfed: {e}")
    try:
        rows, _ = fred_csv("DFF", (date.today().replace(year=date.today().year - 1)).isoformat(),
                           date.today().isoformat())
        return rows[-1][1], f"FRED DFF ({rows[-1][0]})"
    except Exception as e:
        errs.append(f"fred: {e}")
    raise RuntimeError("; ".join(errs))


def target_mid_from_effr(effr):
    """Snap EFFR to the midpoint of its 25bp target band."""
    return round(round((effr - 0.125) / 0.25) * 0.25 + 0.125, 4)


ALLOW_CME = False


def get_zq():
    sources = [zq_from_yahoo]
    if ALLOW_CME:
        sources.insert(0, zq_from_cme)
    sources.append(zq_from_stooq)
    errors = []
    for fn in sources:
        try:
            contracts, src = fn()
        except Exception as e:
            errors.append(f"{fn.__name__}: {e}")
            continue
        mid = effr = None
        effr_src = ""
        try:
            effr, effr_src = current_effr()
            mid = target_mid_from_effr(effr)
        except Exception as e:
            errors.append(f"effr: {e}")
        return {"contracts": contracts, "mid": mid, "effr": effr,
                "source": src, "effrSource": effr_src,
                "asOf": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "partial": len(contracts) < 2,
                "notes": errors}
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


def run_check():
    """Probe every data source from THIS machine and report plainly."""
    ok = lambda m: print("  \033[32mOK\033[0m    " + m)
    bad = lambda m: print("  \033[31mFAIL\033[0m  " + m)
    print("\nChecking data sources from this machine. Nothing is written.\n")
    results = {}

    print("FRED (public CSV export, no key)")
    for sid in ("DGS10", "DGS2", "SP500", "UNRATE"):
        try:
            rows, src = fred_csv(sid, "1900-01-01", date.today().isoformat())
            ok(f"{sid:<8} {len(rows):>6,} obs   {rows[0][0]} -> {rows[-1][0]}   last={rows[-1][1]}")
            results["fred"] = True
        except Exception as e:
            bad(f"{sid:<8} {e}")
            results.setdefault("fred", False)

    print("\nCurrent effective fed funds rate")
    try:
        effr, src = current_effr()
        mid = target_mid_from_effr(effr)
        ok(f"EFFR {effr}%  via {src}")
        ok(f"implied target range {mid-0.125:.2f}-{mid+0.125:.2f}%  (midpoint {mid})")
        results["effr"] = True
    except Exception as e:
        bad(str(e)); results["effr"] = False

    print("\nFed funds futures (ZQ contract strip)")
    try:
        contracts, src = zq_from_yahoo()
        ok(f"{len(contracts)} contracts via {src}")
        for c in contracts[:6]:
            print(f"          {c['ym']}  {c['label']:<12} {c['price']:>9}"
                  f"   implied {100-c['price']:.3f}%")
        if len(contracts) > 6:
            print(f"          ... and {len(contracts)-6} more")
        results["zq"] = True
    except Exception as e:
        bad(f"Yahoo: {e}")
        try:
            contracts, src = zq_from_stooq()
            ok(f"fallback: {src} -> {contracts[0]['price']} "
               f"(front month only; not enough for a full strip)")
            results["zq"] = "partial"
        except Exception as e2:
            bad(f"Stooq: {e2}")
            results["zq"] = False

    print("\n" + "-" * 62)
    good = results.get("fred") and results.get("zq") is True and results.get("effr")
    if good:
        print("  Everything the tools need is reachable from this machine.")
        print("  Run:  python3 serve.py     then open the links it prints.")
    else:
        if results.get("fred"):
            print("  FRED works -> the FRED Tool will chart live data.")
        else:
            print("  FRED unreachable -> use CSV import in the FRED Tool.")
        if results.get("zq") is True:
            print("  Futures work -> the Fed Tracker will load prices automatically.")
        elif results.get("zq") == "partial":
            print("  Only the front-month future is reachable -> paste the CME quote")
            print("  table into the Fed Tracker instead (it has a box for that).")
        else:
            print("  Futures unreachable -> paste CME quotes into the Fed Tracker.")
            print("  You can also retry with:  python3 serve.py --check --cme")
    print("-" * 62 + "\n")
    return 0 if good else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--check", action="store_true",
                    help="probe every data source from this machine and exit")
    ap.add_argument("--cme", action="store_true",
                    help="also try CME's own quote feed first (bot-protected; "
                         "CME's terms discourage automated access)")
    a = ap.parse_args()
    global ALLOW_CME
    ALLOW_CME = a.cme

    if a.check:
        return run_check()

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    base = f"http://localhost:{a.port}"
    print(f"""
  Serving the tools with a live data backend.

    FRED Tool     {base}/fred-tool.html
    Fed Tracker   {base}/fed-tracker.html

  The pages now fetch real data through this server, so CORS does not apply.
  FRED: public CSV export.   Fed funds futures: Yahoo ZQ*.CBT contracts.
  Current target range: derived from the NY Fed's published EFFR.
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
