#!/usr/bin/env python3
"""
fetch_data.py - pull REAL market data and bake it into the two tools.

Why this exists: browsers cannot fetch FRED or CME directly (CORS), so the
HTML tools alone can never show live data. Python has no CORS restriction,
so this script fetches the real numbers and writes them into copies of the
tools that then work offline, with no API key.

Usage
-----
    python3 fetch_data.py                 # fetch everything, write *-live.html
    python3 fetch_data.py --fred-only
    python3 fetch_data.py --fed-only
    python3 fetch_data.py --series DGS10 UNRATE SP500
    python3 fetch_data.py --start 1950-01-01

Output
------
    fred-tool-live.html     FRED tool with real observations baked in
    fed-tracker-live.html   Fed tracker with real ZQ settlements baked in
    market_data.json        the raw fetched data, for your own use

Nothing is invented. If a fetch fails the script says so and that series is
simply absent - it never substitutes made-up numbers.
"""

import argparse, json, os, re, ssl, sys, urllib.error, urllib.request
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# FRED series pulled by default. Add any FRED id you like with --series.
DEFAULT_SERIES = [
    "DGS10", "DGS2", "DGS30", "DGS3MO", "DFF", "T10Y2Y", "MORTGAGE30US",
    "UNRATE", "CPIAUCSL", "CPILFESL", "PCEPILFE", "M2SL", "WALCL",
    "PAYEMS", "ICSA", "GDP", "GDPC1", "INDPRO", "UMCSENT", "HOUST",
    "CSUSHPINSA", "VIXCLS", "SP500", "NASDAQCOM", "DJIA", "WILL5000IND",
    "DCOILWTICO", "DTWEXBGS", "GFDEBTN", "USREC",
]

# CME 30-Day Fed Funds futures. 305 is the product id for ZQ.
CME_QUOTES = "https://www.cmegroup.com/CmeWS/mvc/Quotes/Future/305/G"
MONTH_CODE = {"F":1,"G":2,"H":3,"J":4,"K":5,"M":6,"N":7,"Q":8,"U":9,"V":10,"X":11,"Z":12}


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/csv,application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    })
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read().decode("utf-8", "replace")


# --------------------------------------------------------------------------
# FRED
# --------------------------------------------------------------------------
def fetch_fred(series_id, start="1900-01-01", end=None):
    """Public CSV export - no API key required."""
    end = end or date.today().isoformat()
    url = ("https://fred.stlouisfed.org/graph/fredgraph.csv"
           f"?id={series_id}&cosd={start}&coed={end}")
    text = get(url)
    lines = text.strip().splitlines()
    if len(lines) < 2:
        raise ValueError("empty response")
    out = []
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        d, v = parts[0].strip().strip('"'), parts[1].strip().strip('"')
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d) or v in (".", ""):
            continue
        try:
            out.append([d, float(v)])
        except ValueError:
            continue
    if len(out) < 2:
        raise ValueError("no usable observations")
    return out


def downsample_monthly(rows):
    """Keep the last observation of each month - keeps the file small."""
    by_month = {}
    for d, v in rows:
        by_month[d[:7]] = [d, v]
    return [by_month[k] for k in sorted(by_month)]


# --------------------------------------------------------------------------
# CME
# --------------------------------------------------------------------------
def fetch_cme_zq():
    """30-Day Fed Funds futures settlements from CME's public quotes feed."""
    data = json.loads(get(CME_QUOTES))
    quotes = data.get("quotes", [])
    if not quotes:
        raise ValueError("no quotes in CME response")
    out = []
    for q in quotes:
        code = (q.get("quoteCode") or q.get("productCode") or "").strip()
        # settlement first, then last, then prior settle
        raw = q.get("priorSettle") or q.get("last") or q.get("open")
        if not raw or raw in ("-", "--"):
            continue
        try:
            price = float(str(raw).replace(",", ""))
        except ValueError:
            continue
        m = re.search(r"([FGHJKMNQUVXZ])(\d)$", code)
        expiry = q.get("expirationDate") or ""
        if m:
            mon = MONTH_CODE[m.group(1)]
            yr_digit = int(m.group(2))
            cur = date.today().year
            yr = (cur // 10) * 10 + yr_digit
            if yr < cur:
                yr += 10
            ym = f"{yr:04d}-{mon:02d}"
        elif re.match(r"^\d{8}$", expiry):
            ym = f"{expiry[:4]}-{expiry[4:6]}"
        else:
            continue
        out.append({"ym": ym, "label": code or ym, "price": round(price, 4)})
    out.sort(key=lambda c: c["ym"])
    if not out:
        raise ValueError("no usable ZQ contracts parsed")
    return out


def effr_to_target_mid(effr):
    """EFFR sits inside a 25bp target band; snap to the nearest band midpoint."""
    return round(round((effr - 0.125) / 0.25) * 0.25 + 0.125, 4)


# --------------------------------------------------------------------------
# Injection
# --------------------------------------------------------------------------
def inject(src_name, out_name, js_assignment):
    src = os.path.join(HERE, src_name)
    if not os.path.exists(src):
        print(f"  ! {src_name} not found next to this script - skipped")
        return False
    html = open(src, encoding="utf-8").read()
    pat = re.compile(r"/\* LIVE_DATA_START.*?LIVE_DATA_END \*/", re.S)
    if not pat.search(html):
        print(f"  ! no LIVE_DATA marker in {src_name} - skipped")
        return False
    html = pat.sub(lambda _: "/* LIVE_DATA_START */\n" + js_assignment +
                   "\n/* LIVE_DATA_END */", html, count=1)
    out = os.path.join(HERE, out_name)
    open(out, "w", encoding="utf-8").write(html)
    print(f"  -> wrote {out_name}  ({len(html)//1024} KB)")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--series", nargs="*", default=None, help="FRED series ids")
    ap.add_argument("--start", default="1900-01-01", help="earliest observation date")
    ap.add_argument("--daily", action="store_true", help="keep daily data (bigger files)")
    ap.add_argument("--fred-only", action="store_true")
    ap.add_argument("--fed-only", action="store_true")
    args = ap.parse_args()

    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    bundle = {"asOf": stamp}
    ok_fred = ok_fed = False

    # ---------------- FRED ----------------
    if not args.fed_only:
        ids = args.series if args.series else DEFAULT_SERIES
        print(f"Fetching {len(ids)} FRED series from fred.stlouisfed.org ...")
        series, failed = {}, []
        for sid in ids:
            try:
                rows = fetch_fred(sid, args.start)
                if not args.daily:
                    rows = downsample_monthly(rows)
                series[sid] = rows
                print(f"  ok  {sid:<14} {len(rows):>5} obs  {rows[0][0]} -> {rows[-1][0]}")
            except Exception as e:
                failed.append(sid)
                print(f"  --  {sid:<14} FAILED: {e}")
        if series:
            bundle["fred"] = {"asOf": stamp, "series": series}
            ok_fred = inject("fred-tool.html", "fred-tool-live.html",
                             "FT.LIVE = " + json.dumps(bundle["fred"],
                                                       separators=(",", ":")) + ";")
        else:
            print("  ! no FRED series fetched - fred-tool-live.html not written")
        if failed:
            print(f"  note: {len(failed)} series unavailable: {', '.join(failed)}")

    # ---------------- CME ----------------
    if not args.fred_only:
        print("\nFetching 30-Day Fed Funds (ZQ) futures from cmegroup.com ...")
        try:
            contracts = fetch_cme_zq()
            print(f"  ok  {len(contracts)} contracts  "
                  f"{contracts[0]['ym']} -> {contracts[-1]['ym']}")
            mid = None
            try:
                effr = fetch_fred("DFF", "2020-01-01")[-1][1]
                mid = effr_to_target_mid(effr)
                print(f"  ok  EFFR {effr}%  ->  target midpoint {mid}%  "
                      f"({mid-0.125:.2f}-{mid+0.125:.2f}%)")
            except Exception as e:
                print(f"  --  could not read EFFR for the target range: {e}")
            live = {"asOf": stamp, "source": "CME Group ZQ settlements",
                    "mid": mid, "contracts": contracts}
            bundle["fed"] = live
            if mid is None:
                print("  ! no target range - open the page and pick it manually")
            ok_fed = inject("fed-tracker.html", "fed-tracker-live.html",
                            "APP.LIVE = " + json.dumps(live, separators=(",", ":")) + ";")
        except Exception as e:
            print(f"  -- CME fetch FAILED: {e}")
            print("     (CME sometimes blocks scripted access. Fall back to entering")
            print("      the 7 ZQ prices by hand in fed-tracker.html - it is built for that.)")

    with open(os.path.join(HERE, "market_data.json"), "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=1)
    print("\n  -> wrote market_data.json")

    print("\nDone.")
    if ok_fred:
        print("  Open fred-tool-live.html    - real FRED data, works offline")
    if ok_fed:
        print("  Open fed-tracker-live.html  - real CME ZQ settlements")
    if not (ok_fred or ok_fed):
        print("  Nothing was written. Check the errors above; the original")
        print("  HTML files still work with manual CSV / price entry.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
