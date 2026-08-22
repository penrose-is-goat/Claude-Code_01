import csv
import contextlib
import html
import io
import json
import math
import os
import re
import threading
import zipfile
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from io import BytesIO, StringIO
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree

import yfinance as yf


APP_VERSION = "Batch 1 v1.1.30.8"
DEFAULT_HOST = os.environ.get("PA_BACKEND_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PA_BACKEND_PORT", "8765"))
HOLDINGS_CACHE_SECONDS = 6 * 60 * 60
HOLDINGS_CACHE = {}
REFERENCE_HOLDINGS_CACHE = {}
ISHARES_PRODUCT_LIST_CACHE = {}
INDEX_CONSTITUENTS_CACHE = {}
NASDAQ_SCREENER_CACHE = {}
HISTORY_CACHE_SECONDS = 5 * 60
HISTORY_STALE_SECONDS = 30 * 60
HISTORY_CACHE = {}
HISTORY_CACHE_LOCK = threading.Lock()
SPDR_HOLDINGS_SYMBOLS = {
    "SPY", "DIA", "MDY",
    "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY",
}
VANGUARD_HOLDINGS_SYMBOLS = {
    "VOO", "VTI", "VUG", "VTV", "VB", "VBK", "VBR", "VEA", "VWO", "BND", "BNDX", "VGT",
}
ISHARES_HOLDINGS = {
    "EEM": {"product_id": "239637", "slug": "ishares-msci-emerging-markets-etf"},
    "EFA": {"product_id": "239623", "slug": "ishares-msci-eafe-etf"},
    "HYG": {"product_id": "239565", "slug": "ishares-iboxx-high-yield-corporate-bond-etf"},
    "IVV": {"product_id": "239726", "slug": "ishares-core-sp-500-etf"},
    "IWM": {"product_id": "239710", "slug": "ishares-russell-2000-etf"},
    "LQD": {"product_id": "239566", "slug": "ishares-iboxx-investment-grade-corporate-bond-etf"},
    "TLT": {"product_id": "239454", "slug": "ishares-20-year-treasury-bond-etf"},
}
CASH_LIKE_HOLDING_SYMBOLS = {
    "", "-", "--", "CASH", "USD", "US DOLLAR", "US DOLLARS", "CASH_USD",
    "MARGIN USD", "COLLATERAL", "OTHER",
}
INDEX_SOURCE_CONFIGS = {
    "sp500": {
        "label": "S&P 500",
        "stockanalysis_url": "https://stockanalysis.com/list/sp-500-stocks/",
        "fallback_etf": "VOO",
    },
    "nasdaq100": {
        "label": "Nasdaq 100",
        "nasdaq_url": "https://api.nasdaq.com/api/quote/list-type/nasdaq100?assetclass=stocks",
        "stockanalysis_url": "https://stockanalysis.com/list/nasdaq-100-stocks/",
    },
    "dow30": {
        "label": "Dow Jones Industrial Average",
        "stockanalysis_url": "https://stockanalysis.com/list/dow-jones-stocks/",
        "fallback_etf": "DIA",
    },
}


def utc_now():
    return datetime.now(timezone.utc)


def utc_now_iso():
    return utc_now().isoformat().replace("+00:00", "Z")


def utc_timestamp():
    return utc_now().timestamp()


def utc_from_timestamp(value):
    return datetime.fromtimestamp(value, timezone.utc)


def history_cache_key(symbol, range_key, interval):
    return (
        str(symbol or "").strip().upper(),
        str(range_key or "1Y").strip().upper(),
        normalize_interval(interval),
    )


def copy_history_payload(history, cache_status=None, cached_at=None):
    payload = dict(history or {})
    if cache_status:
        payload["cacheStatus"] = cache_status
    if cached_at:
        payload["cachedAt"] = cached_at
    return payload


def get_cached_history(symbol, range_key, interval, allow_stale=False):
    key = history_cache_key(symbol, range_key, interval)
    now = utc_timestamp()
    with HISTORY_CACHE_LOCK:
        cached = HISTORY_CACHE.get(key)
    if not cached:
        return None
    age = now - float(cached.get("loadedAt") or 0)
    max_age = HISTORY_STALE_SECONDS if allow_stale else HISTORY_CACHE_SECONDS
    if age > max_age:
        if not allow_stale:
            with HISTORY_CACHE_LOCK:
                if HISTORY_CACHE.get(key) is cached:
                    HISTORY_CACHE.pop(key, None)
        return None
    status = "stale" if age > HISTORY_CACHE_SECONDS else "fresh"
    return copy_history_payload(cached.get("history") or {}, status, cached.get("loadedAtIso"))


def set_cached_history(symbol, range_key, interval, history):
    if not history:
        return history
    key = history_cache_key(symbol, range_key, interval)
    loaded_at = utc_timestamp()
    with HISTORY_CACHE_LOCK:
        HISTORY_CACHE[key] = {
            "loadedAt": loaded_at,
            "loadedAtIso": utc_from_timestamp(loaded_at).isoformat().replace("+00:00", "Z"),
            "history": copy_history_payload(history),
        }
    return history


def yahoo_price_symbol(symbol):
    return str(symbol or "").strip().upper().replace(".", "-").replace("/", "-")


def market_symbol_keys(symbol):
    raw = clean_text(symbol).upper()
    if not raw:
        return []
    variants = {
        raw,
        raw.replace(".", "-").replace("/", "-"),
        raw.replace(".", "/").replace("-", "/"),
        raw.replace("/", ".").replace("-", "."),
    }
    return [variant for variant in variants if variant]


def parse_market_size(value):
    if is_finite_number(value):
        numeric = float(value)
        return numeric if math.isfinite(numeric) and numeric > 0 else None
    text = clean_text(value)
    if not text or text.upper() in {"N/A", "NA", "NONE", "-", "--"}:
        return None
    text = html.unescape(text).replace("$", "").replace(",", "").strip()
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*([TtBbMmKk]?)", text)
    if not match:
        return None
    numeric = to_number(match.group(1))
    if numeric is None or numeric <= 0:
        return None
    suffix = match.group(2).upper()
    multiplier = {
        "T": 1_000_000_000_000,
        "B": 1_000_000_000,
        "M": 1_000_000,
        "K": 1_000,
    }.get(suffix, 1)
    return numeric * multiplier


def parse_percent_value(value):
    numeric = to_number(str(value or "").replace("%", "").replace("+", ""))
    if numeric is None:
        return None
    return numeric / 100


def clean_company_name(name):
    text = strip_html_tags(name)
    if not text:
        return text
    replacements = [
        r"\s+Common Stock\b.*$",
        r"\s+Class [A-Z]\b.*$",
        r"\s+Ordinary Shares\b.*$",
        r"\s+American Depositary Shares\b.*$",
        r"\s+ADS\b.*$",
    ]
    for pattern in replacements:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE).strip()
    return text

RANGE_PERIODS = {
    "1D": "1d",
    "5D": "5d",
    "1M": "1mo",
    "3M": "3mo",
    "6M": "6mo",
    "YTD": "ytd",
    "1Y": "1y",
    "3Y": "3y",
    "5Y": "5y",
    "10Y": "10y",
    "MAX": "max",
}

INTERVAL_MAP = {
    "15m": "15m",
    "1h": "60m",
    "1d": "1d",
    "1wk": "1wk",
    "1mo": "1mo",
}

INTRADAY_INTERVALS = {"15m", "1h"}
FRED_GRAPH_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
FRED_SERIES = {
    "DGS10": {
        "title": "10-Year Treasury Yield",
        "units": "percent",
    },
    "DFEDTARU": {
        "title": "Federal Funds Target Range - Upper Limit",
        "units": "percent",
    },
    "FEDFUNDS": {
        "title": "Effective Federal Funds Rate",
        "units": "percent",
    },
    "DFF": {
        "title": "Effective Federal Funds Rate",
        "units": "percent",
    },
    "SP500": {
        "title": "S&P 500",
        "units": "index",
    },
}
CANONICAL_SERIES_FALLBACKS = {
    "SP500": [
        {"provider": "fred", "series_id": "SP500", "label": "FRED SP500"},
        {"provider": "yfinance", "symbol": "^GSPC", "label": "Yahoo ^GSPC"},
        {"provider": "yahoo_chart", "symbol": "^GSPC", "label": "Yahoo chart ^GSPC"},
        {"provider": "yfinance", "symbol": "SPY", "label": "Yahoo SPY proxy"},
        {"provider": "yahoo_chart", "symbol": "SPY", "label": "Yahoo chart SPY proxy"},
    ],
    "DGS10": [
        {"provider": "fred", "series_id": "DGS10", "label": "FRED DGS10"},
        {"provider": "yfinance", "symbol": "^TNX", "label": "Yahoo ^TNX", "transform": "treasury_yield"},
        {"provider": "yahoo_chart", "symbol": "^TNX", "label": "Yahoo chart ^TNX", "transform": "treasury_yield"},
        {"provider": "yfinance", "symbol": "IEF", "label": "Yahoo IEF inverse proxy", "transform": "inverse_price"},
        {"provider": "yahoo_chart", "symbol": "IEF", "label": "Yahoo chart IEF inverse proxy", "transform": "inverse_price"},
        {"provider": "yfinance", "symbol": "TLT", "label": "Yahoo TLT inverse proxy", "transform": "inverse_price"},
        {"provider": "yahoo_chart", "symbol": "TLT", "label": "Yahoo chart TLT inverse proxy", "transform": "inverse_price"},
    ],
    "DFEDTARU": [
        {"provider": "fred", "series_id": "DFEDTARU", "label": "FRED DFEDTARU"},
        {"provider": "fred", "series_id": "DFF", "label": "FRED DFF"},
        {"provider": "fred", "series_id": "FEDFUNDS", "label": "FRED FEDFUNDS"},
        {"provider": "fed_policy", "series_id": "DFEDTARU", "label": "Federal Reserve target-rate table"},
    ],
    "DFF": [
        {"provider": "fred", "series_id": "DFF", "label": "FRED DFF"},
        {"provider": "fred", "series_id": "FEDFUNDS", "label": "FRED FEDFUNDS"},
        {"provider": "fred", "series_id": "DFEDTARU", "label": "FRED DFEDTARU"},
        {"provider": "fed_policy", "series_id": "DFEDTARU", "label": "Federal Reserve target-rate table"},
    ],
    "FEDFUNDS": [
        {"provider": "fred", "series_id": "FEDFUNDS", "label": "FRED FEDFUNDS"},
        {"provider": "fred", "series_id": "DFF", "label": "FRED DFF"},
        {"provider": "fred", "series_id": "DFEDTARU", "label": "FRED DFEDTARU"},
        {"provider": "fed_policy", "series_id": "DFEDTARU", "label": "Federal Reserve target-rate table"},
    ],
}

FED_POLICY_TARGET_UPPER_EVENTS = [
    ("2003-06-25", 1.00),
    ("2004-06-30", 1.25),
    ("2004-08-10", 1.50),
    ("2004-09-21", 1.75),
    ("2004-11-10", 2.00),
    ("2004-12-14", 2.25),
    ("2005-02-02", 2.50),
    ("2005-03-22", 2.75),
    ("2005-05-03", 3.00),
    ("2005-06-30", 3.25),
    ("2005-08-09", 3.50),
    ("2005-09-20", 3.75),
    ("2005-11-01", 4.00),
    ("2005-12-13", 4.25),
    ("2006-01-31", 4.50),
    ("2006-03-28", 4.75),
    ("2006-05-10", 5.00),
    ("2006-06-29", 5.25),
    ("2007-09-18", 4.75),
    ("2007-10-31", 4.50),
    ("2007-12-11", 4.25),
    ("2008-01-22", 3.50),
    ("2008-01-30", 3.00),
    ("2008-03-18", 2.25),
    ("2008-04-30", 2.00),
    ("2008-10-08", 1.50),
    ("2008-10-29", 1.00),
    ("2008-12-16", 0.25),
    ("2015-12-17", 0.50),
    ("2016-12-15", 0.75),
    ("2017-03-16", 1.00),
    ("2017-06-15", 1.25),
    ("2017-12-14", 1.50),
    ("2018-03-22", 1.75),
    ("2018-06-14", 2.00),
    ("2018-09-27", 2.25),
    ("2018-12-20", 2.50),
    ("2019-08-01", 2.25),
    ("2019-09-19", 2.00),
    ("2019-10-31", 1.75),
    ("2020-03-04", 1.25),
    ("2020-03-16", 0.25),
    ("2022-03-17", 0.50),
    ("2022-05-05", 1.00),
    ("2022-06-16", 1.75),
    ("2022-07-28", 2.50),
    ("2022-09-22", 3.25),
    ("2022-11-03", 4.00),
    ("2022-12-15", 4.50),
    ("2023-02-02", 4.75),
    ("2023-03-23", 5.00),
    ("2023-05-04", 5.25),
    ("2023-07-27", 5.50),
    ("2024-09-19", 5.00),
    ("2024-11-08", 4.75),
    ("2024-12-19", 4.50),
    ("2025-09-18", 4.25),
    ("2025-10-30", 4.00),
    ("2025-12-11", 3.75),
]


def is_finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def to_number(value):
    if value is None:
        return None
    if is_finite_number(value):
        return value
    if hasattr(value, "item"):
        try:
            return to_number(value.item())
        except Exception:
            return None
    try:
        text = clean_text(value) if "clean_text" in globals() else str(value)
        parsed = float(text.replace(",", "").replace("$", "").replace("%", ""))
    except Exception:
        return None
    return parsed if math.isfinite(parsed) else None


def to_int(value):
    num = to_number(value)
    return None if num is None else int(num)


def to_timestamp(value):
    if value in (None, "", 0):
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float)) and math.isfinite(value):
        try:
            return utc_from_timestamp(value).isoformat().replace("+00:00", "Z")
        except Exception:
            return str(value)
    text = str(value).strip()
    return text or None


def to_plain(value):
    if value is None:
        return None
    if isinstance(value, (str, bool)):
        return value
    if is_finite_number(value):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return to_plain(value.item())
        except Exception:
            return str(value)
    if hasattr(value, "tolist") and not isinstance(value, dict):
        try:
            return to_plain(value.tolist())
        except Exception:
            pass
    if hasattr(value, "to_dict"):
        try:
            return to_plain(value.to_dict())
        except Exception:
            pass
    if isinstance(value, dict):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_plain(v) for v in value]
    return str(value)


def records_from_frame(frame):
    if frame is None:
        return []
    try:
        if hasattr(frame, "reset_index"):
            return to_plain(frame.reset_index().to_dict(orient="records")) or []
    except Exception:
        return []
    return []


def first_present(*candidates):
    for source, value in candidates:
        if value is not None and value != "":
            return value, source
    return None, None


def wrap_raw(value):
    num = to_number(value)
    return None if num is None else {"raw": num}


def safe_info(ticker):
    try:
        data = ticker.get_info()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def safe_fast_info(ticker):
    try:
        data = dict(ticker.fast_info)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def safe_funds_data(ticker):
    try:
        return ticker.funds_data
    except Exception:
        return None


def safe_history_metadata(ticker):
    try:
        data = ticker.get_history_metadata()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def serialize_funds_data(funds_data):
    if funds_data is None:
        return {}
    fields = [
        "description",
        "fund_overview",
        "fund_operations",
        "asset_classes",
        "top_holdings",
        "equity_holdings",
        "bond_holdings",
        "bond_ratings",
        "sector_weightings",
    ]
    result = {}
    for field in fields:
        try:
            result[field] = to_plain(getattr(funds_data, field))
        except Exception:
            result[field] = None
    return result


def build_provider_notes(field_sources, required_fields):
    missing = []
    for field in required_fields:
        if not field_sources.get(field):
            missing.append(field)
    return missing


def provider_field_unit(field, source, quote_type):
    if not source:
        return None
    if field == "regularMarketChangePercent":
        return "percent"
    if field == "oneYearReturn":
        return "ratio"
    if field in {"expenseRatio", "portfolioTurnover"}:
        return "percent"
    if field == "trailingAnnualDividendYield":
        if source in {"info.yield"}:
            return "percent"
        return "ratio"
    return None


def parse_history_date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except Exception:
        return None


def subtract_years(value, years):
    try:
        return value.replace(year=value.year - years)
    except ValueError:
        if value.month == 2 and value.day == 29:
            return value.replace(year=value.year - years, month=2, day=28)
        raise


def normalize_interval(interval):
    normalized = str(interval or "1d").strip().lower()
    return INTERVAL_MAP.get(normalized, "1d")


def period_for_request(range_key, interval):
    normalized_range = str(range_key or "1Y").upper()
    period = RANGE_PERIODS.get(normalized_range, "1y")
    normalized_interval = normalize_interval(interval)
    if normalized_interval == "15m" and normalized_range in {"6M", "YTD", "1Y", "3Y", "5Y", "10Y", "MAX"}:
        return "60d"
    if normalized_interval == "60m" and normalized_range in {"1Y", "3Y", "5Y", "10Y", "MAX"}:
        return "730d"
    return period


def history_date_window(range_key):
    today = utc_now().date()
    normalized_range = str(range_key or "1Y").upper()
    if normalized_range == "MAX":
        return None, today
    if normalized_range == "YTD":
        return date(today.year, 1, 1), today
    if normalized_range == "10Y":
        return subtract_years(today, 10), today
    if normalized_range == "5Y":
        return subtract_years(today, 5) - timedelta(days=10), today
    if normalized_range == "3Y":
        return subtract_years(today, 3) - timedelta(days=10), today
    if normalized_range == "1Y":
        return subtract_years(today, 1) - timedelta(days=7), today
    if normalized_range == "6M":
        return today - timedelta(days=240), today
    if normalized_range == "3M":
        return today - timedelta(days=120), today
    if normalized_range == "1M":
        return today - timedelta(days=45), today
    if normalized_range == "5D":
        return today - timedelta(days=14), today
    if normalized_range == "1D":
        return today - timedelta(days=7), today
    return subtract_years(today, 1) - timedelta(days=7), today


def resolve_fred_series_id(symbol):
    normalized = str(symbol or "").strip().upper()
    if not normalized:
        return None
    if normalized.startswith("FRED:"):
        candidate = normalized.split(":", 1)[1].strip().upper()
        return candidate if candidate in FRED_SERIES else None
    return normalized if normalized in FRED_SERIES else None


def resample_fred_points(points, interval):
    normalized_interval = normalize_interval(interval)
    if normalized_interval == "1d":
        return points
    if normalized_interval in INTRADAY_INTERVALS:
        raise ValueError(f"FRED history only supports end-of-day style requests, not {interval}.")
    if normalized_interval not in {"1wk", "1mo"}:
        return points

    buckets = {}
    order = []
    for point in points:
        point_date = parse_history_date(point.get("date"))
        if point_date is None:
            continue
        if normalized_interval == "1wk":
            iso = point_date.isocalendar()
            bucket = f"{iso.year:04d}-W{iso.week:02d}"
        else:
            bucket = f"{point_date.year:04d}-{point_date.month:02d}"
        if bucket not in buckets:
            order.append(bucket)
        buckets[bucket] = point
    return [buckets[key] for key in order]


def normalize_fred_history(symbol, series_id, range_key, interval="1d"):
    normalized_range = str(range_key or "1Y").upper()
    normalized_interval = normalize_interval(interval)
    start_date, end_date = history_date_window(normalized_range)
    params = {"id": series_id}
    if start_date:
        params["cosd"] = start_date.isoformat()
    if end_date:
        params["coed"] = end_date.isoformat()
    request = Request(
        f"{FRED_GRAPH_CSV_URL}?{urlencode(params)}",
        headers={
            "User-Agent": f"PortfolioAnalyzer/{APP_VERSION}",
            "Accept": "text/csv",
        },
    )
    with urlopen(request, timeout=20) as response:
        payload = response.read().decode("utf-8")

    reader = csv.DictReader(StringIO(payload))
    rows = list(reader)
    if not rows:
        raise ValueError(f"No history returned by FRED for {series_id} ({normalized_range}, {normalized_interval}).")

    value_key = series_id if series_id in rows[0] else next((key for key in rows[0].keys() if key != "DATE"), None)
    if not value_key:
        raise ValueError(f"Unexpected FRED CSV format for {series_id}.")

    points = []
    for row in rows:
        dt = str(row.get("DATE") or "").strip()
        value = to_number(row.get(value_key))
        if not dt or value is None:
            continue
        points.append({"date": dt, "price": value})

    points = resample_fred_points(points, normalized_interval)
    if not points:
        raise ValueError(f"No usable observations returned by FRED for {series_id} ({normalized_range}, {normalized_interval}).")

    dates = [point["date"] for point in points]
    prices = [point["price"] for point in points]
    return {
        "ticker": str(symbol or series_id).upper(),
        "rangeKey": normalized_range,
        "interval": normalized_interval,
        "dates": dates,
        "prices": prices,
        "adjustedPrices": prices[:],
        "volumes": [None for _ in prices],
        "opens": prices[:],
        "highs": prices[:],
        "lows": prices[:],
        "providerSource": "fred",
        "providerSeriesId": series_id,
        "providerSymbol": series_id,
    }


def normalize_fed_policy_history(symbol, series_id, range_key, interval="1d"):
    normalized_range = str(range_key or "1Y").upper()
    normalized_interval = normalize_interval(interval)
    if normalized_interval in INTRADAY_INTERVALS:
        raise ValueError(f"Federal Reserve policy target table only supports end-of-day style requests, not {interval}.")

    parsed_events = []
    for event_date, upper_bound in FED_POLICY_TARGET_UPPER_EVENTS:
        dt = parse_history_date(event_date)
        if dt is not None:
            parsed_events.append((dt, float(upper_bound)))
    parsed_events.sort(key=lambda item: item[0])
    if not parsed_events:
        raise ValueError("Federal Reserve policy target table is empty.")

    start_date, end_date = history_date_window(normalized_range)
    start_date = start_date or parsed_events[0][0]
    end_date = end_date or utc_now().date()
    if end_date < start_date:
        raise ValueError(f"No usable Federal Reserve policy target observations for {normalized_range}.")

    event_index = 0
    current_level = parsed_events[0][1]
    while event_index + 1 < len(parsed_events) and parsed_events[event_index + 1][0] <= start_date:
        event_index += 1
        current_level = parsed_events[event_index][1]

    points = []
    current_date = start_date
    while current_date <= end_date:
        while event_index + 1 < len(parsed_events) and parsed_events[event_index + 1][0] <= current_date:
            event_index += 1
            current_level = parsed_events[event_index][1]
        if current_date.weekday() < 5:
            points.append({"date": current_date.isoformat(), "price": current_level})
        current_date += timedelta(days=1)

    points = resample_fred_points(points, normalized_interval)
    if not points:
        raise ValueError(f"No usable Federal Reserve policy target observations for {normalized_range}.")

    dates = [point["date"] for point in points]
    prices = [point["price"] for point in points]
    return {
        "ticker": str(symbol or series_id or "DFEDTARU").upper(),
        "rangeKey": normalized_range,
        "interval": normalized_interval,
        "dates": dates,
        "prices": prices,
        "adjustedPrices": prices[:],
        "volumes": [None for _ in prices],
        "opens": prices[:],
        "highs": prices[:],
        "lows": prices[:],
        "providerSource": "fed-policy-table",
        "providerSeriesId": series_id or "DFEDTARU",
        "providerSymbol": "DFEDTARU",
        "providerFallbackLabel": "Federal Reserve target-rate table",
    }


def transform_history_arrays(opens, highs, lows, closes, adjusted_prices, transform=None):
    normalized = str(transform or "").strip().lower()
    if not normalized:
        return opens, highs, lows, closes, adjusted_prices, None

    if normalized == "treasury_yield":
        valid = [value for value in closes if value is not None]
        divisor = 10 if valid and statistics_median(valid) > 20 else 1
        def scale(values):
            return [None if value is None else value / divisor for value in values]
        return scale(opens), scale(highs), scale(lows), scale(closes), scale(adjusted_prices), ("divide_by_10" if divisor == 10 else "identity")

    if normalized == "inverse_price":
        inv_open = [None if value is None else -value for value in opens]
        inv_high = [None if value is None else -value for value in lows]
        inv_low = [None if value is None else -value for value in highs]
        inv_close = [None if value is None else -value for value in closes]
        inv_adj = [None if value is None else -value for value in adjusted_prices]
        return inv_open, inv_high, inv_low, inv_close, inv_adj, "negated_price"

    return opens, highs, lows, closes, adjusted_prices, None


def statistics_median(values):
    clean = sorted([value for value in values if value is not None])
    if not clean:
        return None
    middle = len(clean) // 2
    if len(clean) % 2:
        return clean[middle]
    return (clean[middle - 1] + clean[middle]) / 2


def normalize_yfinance_history(symbol, range_key, interval="1d", requested_symbol=None, provider_source="yfinance", transform=None, fallback_label=None):
    normalized_range = str(range_key or "1Y").upper()
    normalized_interval = normalize_interval(interval)
    period = period_for_request(normalized_range, normalized_interval)
    provider_symbol = yahoo_price_symbol(symbol)
    ticker = yf.Ticker(provider_symbol)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            frame = ticker.history(period=period, interval=normalized_interval, auto_adjust=False, actions=False, prepost=False)
    except Exception as exc:
        raise ValueError(f"yfinance history failed for {provider_symbol} ({normalized_range}, {normalized_interval}): {exc}") from exc
    if frame is None or getattr(frame, "empty", True):
        raise ValueError(f"No price history returned by yfinance for {provider_symbol} ({normalized_range}, {normalized_interval}).")
    frame = frame.reset_index()
    dates = []
    prices = []
    volumes = []
    opens = []
    highs = []
    lows = []
    adjusted_prices = []
    for _, row in frame.iterrows():
        dt = row.get("Datetime")
        if dt is None:
            dt = row.get("Date")
        if hasattr(dt, "isoformat"):
            dt = dt.isoformat()
        elif hasattr(dt, "date"):
            dt = dt.date().isoformat()
        else:
            dt = str(dt).replace(" ", "T")
        dates.append(dt)
        opens.append(to_number(row.get("Open")))
        highs.append(to_number(row.get("High")))
        lows.append(to_number(row.get("Low")))
        prices.append(to_number(row.get("Close")))
        adjusted_prices.append(to_number(row.get("Adj Close")) or to_number(row.get("Close")))
        volumes.append(to_int(row.get("Volume")))

    opens, highs, lows, prices, adjusted_prices, transform_applied = transform_history_arrays(
        opens, highs, lows, prices, adjusted_prices, transform
    )
    return {
        "ticker": str(requested_symbol or symbol).upper(),
        "rangeKey": normalized_range,
        "interval": normalized_interval,
        "dates": dates,
        "prices": prices,
        "adjustedPrices": adjusted_prices,
        "volumes": volumes,
        "opens": opens,
        "highs": highs,
        "lows": lows,
        "providerSource": provider_source,
        "providerSymbol": provider_symbol,
        "providerTransform": transform_applied,
        "providerFallbackLabel": fallback_label,
    }


def yahoo_chart_timestamp(timestamp, interval):
    value = to_number(timestamp)
    if value is None:
        return None
    dt = utc_from_timestamp(value)
    normalized_interval = normalize_interval(interval)
    if normalized_interval in {"1d", "1wk", "1mo"}:
        return dt.date().isoformat()
    return dt.isoformat().replace("+00:00", "Z")


def normalize_yahoo_chart_history(symbol, range_key, interval="1d", requested_symbol=None, provider_source="yahoo-chart", transform=None, fallback_label=None):
    normalized_range = str(range_key or "1Y").upper()
    normalized_interval = normalize_interval(interval)
    params = {
        "range": period_for_request(normalized_range, normalized_interval),
        "interval": normalized_interval,
        "includePrePost": "false",
        "events": "div,splits",
    }
    provider_symbol = yahoo_price_symbol(symbol)
    request = Request(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(provider_symbol)}?{urlencode(params)}",
        headers={
            "User-Agent": f"PortfolioAnalyzer/{APP_VERSION}",
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))

    result = (((payload or {}).get("chart") or {}).get("result") or [None])[0] or {}
    error = ((payload or {}).get("chart") or {}).get("error")
    if error:
        description = error.get("description") or error.get("code") or "Unknown Yahoo chart error."
        raise ValueError(f"Yahoo chart returned an error for {symbol}: {description}")

    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    quotes = (indicators.get("quote") or [None])[0] or {}
    adjclose = ((indicators.get("adjclose") or [None])[0] or {}).get("adjclose") or []
    if not timestamps:
        raise ValueError(f"No chart timestamps returned by Yahoo for {symbol} ({normalized_range}, {normalized_interval}).")

    opens = quotes.get("open") or []
    highs = quotes.get("high") or []
    lows = quotes.get("low") or []
    closes = quotes.get("close") or []
    volumes = quotes.get("volume") or []

    dates = []
    open_values = []
    high_values = []
    low_values = []
    close_values = []
    adjusted_values = []
    volume_values = []

    for idx, timestamp in enumerate(timestamps):
        dt = yahoo_chart_timestamp(timestamp, normalized_interval)
        close_value = to_number(closes[idx]) if idx < len(closes) else None
        if not dt or close_value is None:
            continue
        dates.append(dt)
        open_values.append(to_number(opens[idx]) if idx < len(opens) else close_value)
        high_values.append(to_number(highs[idx]) if idx < len(highs) else close_value)
        low_values.append(to_number(lows[idx]) if idx < len(lows) else close_value)
        close_values.append(close_value)
        adjusted = to_number(adjclose[idx]) if idx < len(adjclose) else None
        adjusted_values.append(adjusted if adjusted is not None else close_value)
        volume_values.append(to_int(volumes[idx]) if idx < len(volumes) else None)

    if not dates:
        raise ValueError(f"No usable chart observations returned by Yahoo for {symbol} ({normalized_range}, {normalized_interval}).")

    open_values, high_values, low_values, close_values, adjusted_values, transform_applied = transform_history_arrays(
        open_values, high_values, low_values, close_values, adjusted_values, transform
    )
    return {
        "ticker": str(requested_symbol or symbol).upper(),
        "rangeKey": normalized_range,
        "interval": normalized_interval,
        "dates": dates,
        "prices": close_values,
        "adjustedPrices": adjusted_values,
        "volumes": volume_values,
        "opens": open_values,
        "highs": high_values,
        "lows": low_values,
        "providerSource": provider_source,
        "providerSymbol": provider_symbol,
        "providerTransform": transform_applied,
        "providerFallbackLabel": fallback_label,
    }


def dataframe_column_value(row, column):
    try:
        if column in row:
            return row.get(column)
    except Exception:
        pass
    return None


def frame_to_history(symbol, frame, range_key, interval="1d", provider_source="yfinance-bulk", provider_symbol=None):
    if frame is None or getattr(frame, "empty", True):
        raise ValueError(f"No bulk history returned for {symbol}.")

    frame = frame.dropna(how="all")
    if frame.empty:
        raise ValueError(f"No usable bulk history returned for {symbol}.")

    dates = []
    opens = []
    highs = []
    lows = []
    closes = []
    adjusted = []
    volumes = []

    for index, row in frame.iterrows():
        close_value = to_number(dataframe_column_value(row, "Close"))
        if close_value is None:
            continue
        open_value = to_number(dataframe_column_value(row, "Open"))
        high_value = to_number(dataframe_column_value(row, "High"))
        low_value = to_number(dataframe_column_value(row, "Low"))
        adjusted_value = to_number(dataframe_column_value(row, "Adj Close"))
        volume_value = to_number(dataframe_column_value(row, "Volume"))
        if hasattr(index, "date"):
            date_key = index.date().isoformat()
        else:
            parsed_date = parse_history_date(index)
            date_key = parsed_date.isoformat() if parsed_date else str(index)[:10]
        dates.append(date_key)
        opens.append(open_value if open_value is not None else close_value)
        highs.append(high_value if high_value is not None else close_value)
        lows.append(low_value if low_value is not None else close_value)
        closes.append(close_value)
        adjusted.append(adjusted_value if adjusted_value is not None else close_value)
        volumes.append(volume_value)

    if not dates:
        raise ValueError(f"No usable bulk observations returned for {symbol}.")

    return {
        "ticker": str(symbol).upper(),
        "rangeKey": str(range_key or "1Y").upper(),
        "interval": normalize_interval(interval),
        "dates": dates,
        "prices": closes,
        "adjustedPrices": adjusted,
        "volumes": volumes,
        "opens": opens,
        "highs": highs,
        "lows": lows,
        "providerSource": provider_source,
        "providerSymbol": str(provider_symbol or symbol).upper(),
        "providerFallbackLabel": "Yahoo bulk history",
    }


def select_download_frame(downloaded, requested_symbol, provider_symbol, multi_symbol=True):
    if downloaded is None or getattr(downloaded, "empty", True):
        return None
    columns = getattr(downloaded, "columns", None)
    if multi_symbol and getattr(columns, "nlevels", 1) > 1:
        for candidate in (provider_symbol, requested_symbol, str(provider_symbol).upper(), str(requested_symbol).upper()):
            try:
                if candidate in columns.get_level_values(0):
                    return downloaded[candidate]
            except Exception:
                continue
        return None
    return downloaded


def normalize_bulk_yfinance_histories(symbols, range_key, interval="1d"):
    normalized_range = str(range_key or "1Y").upper()
    normalized_interval = normalize_interval(interval)
    clean_symbols = [str(symbol or "").strip().upper() for symbol in symbols if str(symbol or "").strip()]
    clean_symbols = list(dict.fromkeys(clean_symbols))
    if not clean_symbols:
        return {}

    period = period_for_request(normalized_range, normalized_interval)
    provider_symbols = {symbol: yahoo_price_symbol(symbol) for symbol in clean_symbols}
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        downloaded = yf.download(
            tickers=" ".join(provider_symbols.values()),
            period=period,
            interval=normalized_interval,
            group_by="ticker",
            auto_adjust=False,
            actions=False,
            progress=False,
            threads=True,
        )

    histories = {}
    multi_symbol = len(clean_symbols) > 1
    for symbol in clean_symbols:
        frame = select_download_frame(downloaded, symbol, provider_symbols[symbol], multi_symbol=multi_symbol)
        if frame is None:
            continue
        try:
            histories[symbol] = frame_to_history(
                symbol,
                frame,
                normalized_range,
                normalized_interval,
                provider_symbol=provider_symbols[symbol],
            )
        except Exception:
            continue
    return histories


def normalize_history_candidate(requested_symbol, range_key, interval, candidate):
    provider = str(candidate.get("provider") or "").strip().lower()
    if provider == "fred":
        return normalize_fred_history(requested_symbol, candidate.get("series_id"), range_key, interval)
    if provider == "fed_policy":
        return normalize_fed_policy_history(requested_symbol, candidate.get("series_id"), range_key, interval)
    if provider == "yfinance":
        return normalize_yfinance_history(
            candidate.get("symbol"),
            range_key,
            interval,
            requested_symbol=requested_symbol,
            provider_source="yfinance-fallback" if candidate.get("transform") else "yfinance",
            transform=candidate.get("transform"),
            fallback_label=candidate.get("label"),
        )
    if provider == "yahoo_chart":
        return normalize_yahoo_chart_history(
            candidate.get("symbol"),
            range_key,
            interval,
            requested_symbol=requested_symbol,
            provider_source="yahoo-chart-fallback" if candidate.get("transform") else "yahoo-chart",
            transform=candidate.get("transform"),
            fallback_label=candidate.get("label"),
        )
    raise ValueError(f"Unsupported provider fallback: {provider or 'unknown'}")


def normalize_history_with_fallbacks(requested_symbol, range_key, interval, candidates):
    attempts = []
    for candidate in candidates:
        label = candidate.get("label") or candidate.get("symbol") or candidate.get("series_id") or candidate.get("provider")
        try:
            history = normalize_history_candidate(requested_symbol, range_key, interval, candidate)
            history["providerAttemptChain"] = attempts + [label]
            return history
        except Exception as exc:
            attempts.append(f"{label}: {exc}")
    raise ValueError(f"No usable history available for {requested_symbol}. Attempted fallbacks: {' | '.join(attempts)}")


def normalize_canonical_series_with_fallbacks(symbol, range_key, interval="1d"):
    normalized_symbol = str(symbol or "").strip().upper()
    candidates = CANONICAL_SERIES_FALLBACKS.get(normalized_symbol) or []
    if not candidates:
        return None
    return normalize_history_with_fallbacks(normalized_symbol, range_key, interval, candidates)


def is_backend_canonical_history_symbol(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    return normalized_symbol in CANONICAL_SERIES_FALLBACKS or resolve_fred_series_id(normalized_symbol) is not None


def adjusted_points_from_history(history):
    dates = history.get("dates") or []
    adjusted = history.get("adjustedPrices") or history.get("prices") or []
    points = []
    for idx, dt in enumerate(dates):
        point_date = parse_history_date(dt)
        price = to_number(adjusted[idx]) if idx < len(adjusted) else None
        if point_date and price not in (None, 0):
            points.append({"date": point_date, "price": price})
    return points


def find_anchor_point(points, target_date):
    if not points:
        return None
    previous_point = None
    next_point = None
    for point in points:
        point_date = point.get("date")
        if point_date is None:
            continue
        if point_date <= target_date:
            previous_point = point
        if point_date >= target_date and next_point is None:
            next_point = point
    return previous_point or next_point


def annualize_return(total_return, day_span):
    if total_return is None or day_span <= 0:
        return None
    years = day_span / 365.25
    if years <= 0:
        return None
    base = 1 + total_return
    if base <= 0:
        return None
    return base ** (1 / years) - 1


def compute_trailing_total_return(history, window):
    points = adjusted_points_from_history(history)
    if len(points) < 2:
        return None
    latest = points[-1]
    latest_date = latest["date"]
    if window == "YTD":
        target_date = date(latest_date.year, 1, 1)
        min_days = 1
    elif window == "1Y":
        target_date = subtract_years(latest_date, 1)
        min_days = 330
    elif window == "3Y":
        target_date = subtract_years(latest_date, 3)
        min_days = 365 * 3 - 35
    elif window == "5Y":
        target_date = subtract_years(latest_date, 5)
        min_days = 365 * 5 - 45
    else:
        return None
    anchor = find_anchor_point(points[:-1], target_date)
    if not anchor:
        return None
    day_span = (latest_date - anchor["date"]).days
    if day_span < min_days:
        return None
    start_price = anchor.get("price")
    end_price = latest.get("price")
    if start_price in (None, 0) or end_price is None:
        return None
    total_return = end_price / start_price - 1
    annualized = window in {"3Y", "5Y"}
    return {
        "value": annualize_return(total_return, day_span) if annualized else total_return,
        "rawTotalReturn": total_return,
        "daySpan": day_span,
        "annualized": annualized,
    }


def build_trailing_performance(symbol):
    try:
        history = normalize_history(symbol, "10Y")
    except Exception:
        return {
            "ytdReturn": None,
            "oneYearReturn": None,
            "threeYearReturn": None,
            "fiveYearReturn": None,
            "returnMethod": "Adjusted close return (3Y/5Y annualized)",
            "returnSource": "yfinance history",
            "historyRange": "10Y",
            "asOfDate": None,
            "windowMeta": {},
        }
    ytd = compute_trailing_total_return(history, "YTD") or {}
    one_year = compute_trailing_total_return(history, "1Y") or {}
    three_year = compute_trailing_total_return(history, "3Y") or {}
    five_year = compute_trailing_total_return(history, "5Y") or {}
    return {
        "ytdReturn": ytd.get("value"),
        "oneYearReturn": one_year.get("value"),
        "threeYearReturn": three_year.get("value"),
        "fiveYearReturn": five_year.get("value"),
        "returnMethod": "Adjusted close return (3Y/5Y annualized)",
        "returnSource": "yfinance history",
        "historyRange": history.get("rangeKey"),
        "asOfDate": (history.get("dates") or [None])[-1],
        "windowMeta": {
            "ytdReturn": {
                "annualized": bool(ytd.get("annualized")),
                "daySpan": ytd.get("daySpan"),
            },
            "oneYearReturn": {
                "annualized": bool(one_year.get("annualized")),
                "daySpan": one_year.get("daySpan"),
            },
            "threeYearReturn": {
                "annualized": bool(three_year.get("annualized")),
                "daySpan": three_year.get("daySpan"),
                "rawTotalReturn": three_year.get("rawTotalReturn"),
            },
            "fiveYearReturn": {
                "annualized": bool(five_year.get("annualized")),
                "daySpan": five_year.get("daySpan"),
                "rawTotalReturn": five_year.get("rawTotalReturn"),
            },
        },
    }


def normalize_table_records(value):
    if value is None:
        return []
    try:
        if hasattr(value, "reset_index") and hasattr(value, "to_dict"):
            records = value.reset_index().to_dict(orient="records")
            return to_plain(records) or []
    except Exception:
        pass
    plain = to_plain(value)
    if isinstance(plain, list):
        return plain
    if isinstance(plain, dict) and plain and all(isinstance(v, dict) for v in plain.values()):
        row_keys = []
        for inner in plain.values():
            for key in inner.keys():
                if key not in row_keys:
                    row_keys.append(key)
        records = []
        for row_key in row_keys:
            record = {}
            for column, inner in plain.items():
                record[column] = inner.get(row_key)
            records.append(record)
        return to_plain(records) or []
    return []


def normalize_sector_weightings(value):
    records = normalize_table_records(value)
    if records:
        normalized = []
        for record in records:
            if not isinstance(record, dict):
                continue
            sector = record.get("sector") or record.get("Sector") or record.get("index") or record.get("level_0")
            weight = None
            for key in ("weight", "Weight", "holdingPercent", "value", "Value", 0):
                if isinstance(key, int):
                    continue
                if key in record:
                    weight = to_number(record.get(key))
                    break
            if weight is None:
                numeric_values = [to_number(v) for v in record.values()]
                numeric_values = [v for v in numeric_values if v is not None]
                if numeric_values:
                    weight = numeric_values[0]
            if sector:
                normalized.append({"sector": str(sector), "weight": weight})
        if normalized:
            return normalized
    plain = to_plain(value)
    if isinstance(plain, dict):
        return [{"sector": str(k), "weight": to_number(v)} for k, v in plain.items()]
    return []


def normalize_top_holdings(value):
    records = normalize_table_records(value)
    normalized = []
    for record in records:
        if not isinstance(record, dict):
            continue
        symbol = record.get("symbol") or record.get("Symbol") or record.get("holdingSymbol")
        description = (
            record.get("holdingName")
            or record.get("name")
            or record.get("Name")
            or record.get("description")
            or symbol
        )
        weight = None
        for key in ("holdingPercent", "weight", "Weight", "percent", "Percent"):
            if key in record:
                weight = to_number(record.get(key))
                break
        normalized.append({
            "symbol": str(symbol).upper() if symbol else None,
            "description": str(description) if description else None,
            "weight": weight,
        })
    return normalized


def normalize_quote(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    provider_symbol = yahoo_price_symbol(normalized_symbol)
    ticker = yf.Ticker(provider_symbol)
    info = safe_info(ticker)
    fast = safe_fast_info(ticker)
    metadata = safe_history_metadata(ticker)
    funds_data = safe_funds_data(ticker)
    funds_raw = serialize_funds_data(funds_data)

    field_sources = {}

    def pick(field, *candidates, cast=None):
        value, source = first_present(*candidates)
        if cast:
            value = cast(value)
        field_sources[field] = source
        return value

    quote_type = pick(
        "quoteType",
        ("info.quoteType", info.get("quoteType")),
        ("info.instrumentType", info.get("instrumentType")),
        ("metadata.instrumentType", metadata.get("instrumentType")),
        ("funds_data.fund_overview.categoryName", ((funds_raw.get("fund_overview") or {}).get("categoryName"))),
    )
    if isinstance(quote_type, str) and quote_type.lower() in {"etf", "mutualfund", "mutual fund"}:
        normalized_quote_type = "ETF"
    elif isinstance(quote_type, str) and quote_type:
        normalized_quote_type = quote_type.upper()
    elif funds_data is not None:
        normalized_quote_type = "ETF"
    else:
        normalized_quote_type = "EQUITY"

    price = pick(
        "regularMarketPrice",
        ("info.currentPrice", info.get("currentPrice")),
        ("info.regularMarketPrice", info.get("regularMarketPrice")),
        ("fast_info.lastPrice", fast.get("lastPrice")),
        cast=to_number,
    )
    previous_close = pick(
        "regularMarketPreviousClose",
        ("info.previousClose", info.get("previousClose")),
        ("info.regularMarketPreviousClose", info.get("regularMarketPreviousClose")),
        ("fast_info.previousClose", fast.get("previousClose")),
        cast=to_number,
    )
    market_change = pick(
        "regularMarketChange",
        ("info.regularMarketChange", info.get("regularMarketChange")),
        cast=to_number,
    )
    market_change_pct = pick(
        "regularMarketChangePercent",
        ("info.regularMarketChangePercent", info.get("regularMarketChangePercent")),
        cast=to_number,
    )

    quote = {
        "symbol": normalized_symbol,
        "providerSymbol": provider_symbol,
        "shortName": pick("shortName", ("info.shortName", info.get("shortName")), ("info.longName", info.get("longName"))),
        "longName": pick("longName", ("info.longName", info.get("longName")), ("info.shortName", info.get("shortName"))),
        "regularMarketPrice": price,
        "regularMarketChange": market_change,
        "regularMarketChangePercent": market_change_pct,
        "regularMarketPreviousClose": previous_close,
        "regularMarketOpen": pick(
            "regularMarketOpen",
            ("info.open", info.get("open")),
            ("info.regularMarketOpen", info.get("regularMarketOpen")),
            ("fast_info.open", fast.get("open")),
            cast=to_number,
        ),
        "regularMarketDayHigh": pick(
            "regularMarketDayHigh",
            ("info.dayHigh", info.get("dayHigh")),
            ("info.regularMarketDayHigh", info.get("regularMarketDayHigh")),
            ("fast_info.dayHigh", fast.get("dayHigh")),
            cast=to_number,
        ),
        "regularMarketDayLow": pick(
            "regularMarketDayLow",
            ("info.dayLow", info.get("dayLow")),
            ("info.regularMarketDayLow", info.get("regularMarketDayLow")),
            ("fast_info.dayLow", fast.get("dayLow")),
            cast=to_number,
        ),
        "bid": pick(
            "bid",
            ("info.bid", info.get("bid")),
            cast=to_number,
        ),
        "ask": pick(
            "ask",
            ("info.ask", info.get("ask")),
            cast=to_number,
        ),
        "bidSize": pick(
            "bidSize",
            ("info.bidSize", info.get("bidSize")),
            cast=to_int,
        ),
        "askSize": pick(
            "askSize",
            ("info.askSize", info.get("askSize")),
            cast=to_int,
        ),
        "regularMarketVolume": pick(
            "regularMarketVolume",
            ("info.volume", info.get("volume")),
            ("info.regularMarketVolume", info.get("regularMarketVolume")),
            ("fast_info.lastVolume", fast.get("lastVolume")),
            cast=to_int,
        ),
        "averageDailyVolume3Month": pick(
            "averageDailyVolume3Month",
            ("info.averageVolume", info.get("averageVolume")),
            ("info.averageDailyVolume3Month", info.get("averageDailyVolume3Month")),
            ("fast_info.threeMonthAverageVolume", fast.get("threeMonthAverageVolume")),
            cast=to_int,
        ),
        "averageDailyVolume10Day": pick(
            "averageDailyVolume10Day",
            ("info.averageVolume10days", info.get("averageVolume10days")),
            ("info.averageDailyVolume10Day", info.get("averageDailyVolume10Day")),
            ("fast_info.tenDayAverageVolume", fast.get("tenDayAverageVolume")),
            cast=to_int,
        ),
        "marketCap": pick(
            "marketCap",
            ("info.marketCap", info.get("marketCap")),
            ("fast_info.marketCap", fast.get("marketCap")),
            cast=to_number,
        ),
        "beta": pick(
            "beta",
            ("info.beta", info.get("beta")),
            ("info.beta3Year", info.get("beta3Year")),
            cast=to_number,
        ),
        "trailingPE": pick(
            "trailingPE",
            ("info.trailingPE", info.get("trailingPE")),
            cast=to_number,
        ),
        "forwardPE": pick(
            "forwardPE",
            ("info.forwardPE", info.get("forwardPE")),
            cast=to_number,
        ),
        "trailingAnnualDividendYield": pick(
            "trailingAnnualDividendYield",
            ("info.yield", info.get("yield")),
            ("info.dividendYield", info.get("dividendYield")),
            ("info.trailingAnnualDividendYield", info.get("trailingAnnualDividendYield")),
            cast=to_number,
        ),
        "dividendRate": pick(
            "dividendRate",
            ("info.dividendRate", info.get("dividendRate")),
            ("info.trailingAnnualDividendRate", info.get("trailingAnnualDividendRate")),
            cast=to_number,
        ),
        "epsTrailingTwelveMonths": pick(
            "epsTrailingTwelveMonths",
            ("info.epsTrailingTwelveMonths", info.get("epsTrailingTwelveMonths")),
            ("info.trailingEps", info.get("trailingEps")),
            cast=to_number,
        ),
        "epsForward": pick(
            "epsForward",
            ("info.epsForward", info.get("epsForward")),
            ("info.forwardEps", info.get("forwardEps")),
            cast=to_number,
        ),
        "priceToBook": pick(
            "priceToBook",
            ("info.priceToBook", info.get("priceToBook")),
            cast=to_number,
        ),
        "bookValue": pick(
            "bookValue",
            ("info.bookValue", info.get("bookValue")),
            cast=to_number,
        ),
        "sharesOutstanding": pick(
            "sharesOutstanding",
            ("info.sharesOutstanding", info.get("sharesOutstanding")),
            cast=to_number,
        ),
        "fiftyTwoWeekHigh": pick(
            "fiftyTwoWeekHigh",
            ("info.fiftyTwoWeekHigh", info.get("fiftyTwoWeekHigh")),
            ("fast_info.yearHigh", fast.get("yearHigh")),
            cast=to_number,
        ),
        "fiftyTwoWeekLow": pick(
            "fiftyTwoWeekLow",
            ("info.fiftyTwoWeekLow", info.get("fiftyTwoWeekLow")),
            ("fast_info.yearLow", fast.get("yearLow")),
            cast=to_number,
        ),
        "fiftyDayAverage": pick(
            "fiftyDayAverage",
            ("info.fiftyDayAverage", info.get("fiftyDayAverage")),
            cast=to_number,
        ),
        "twoHundredDayAverage": pick(
            "twoHundredDayAverage",
            ("info.twoHundredDayAverage", info.get("twoHundredDayAverage")),
            cast=to_number,
        ),
        "marketState": pick(
            "marketState",
            ("info.marketState", info.get("marketState")),
            ("metadata.marketState", metadata.get("marketState")),
        ),
        "exDividendDate": to_timestamp(pick(
            "exDividendDate",
            ("info.exDividendDate", info.get("exDividendDate")),
        )),
        "currency": pick("currency", ("info.currency", info.get("currency")), ("fast_info.currency", fast.get("currency"))),
        "exchange": pick("exchange", ("info.exchange", info.get("exchange")), ("metadata.exchangeName", metadata.get("exchangeName"))),
        "fullExchangeName": pick(
            "fullExchangeName",
            ("info.fullExchangeName", info.get("fullExchangeName")),
            ("metadata.exchangeName", metadata.get("exchangeName")),
            ("info.exchange", info.get("exchange")),
        ),
        "quoteType": normalized_quote_type,
        "netAssets": pick(
            "netAssets",
            ("info.totalAssets", info.get("totalAssets")),
            ("info.netAssets", info.get("netAssets")),
            cast=to_number,
        ),
        "navPrice": pick(
            "navPrice",
            ("info.navPrice", info.get("navPrice")),
            cast=to_number,
        ),
        "expenseRatio": pick(
            "expenseRatio",
            ("info.annualReportExpenseRatio", info.get("annualReportExpenseRatio")),
            ("info.netExpenseRatio", info.get("netExpenseRatio")),
            cast=to_number,
        ),
        "portfolioTurnover": pick(
            "portfolioTurnover",
            ("info.annualHoldingsTurnover", info.get("annualHoldingsTurnover")),
            cast=to_number,
        ),
        "inceptionDate": to_timestamp(pick(
            "inceptionDate",
            ("info.fundInceptionDate", info.get("fundInceptionDate")),
        )),
        "issuer": pick(
            "issuer",
            ("info.fundFamily", info.get("fundFamily")),
            ("info.family", info.get("family")),
            ("funds_data.fund_overview.family", ((funds_raw.get("fund_overview") or {}).get("family"))),
        ),
        "trackedIndex": pick(
            "trackedIndex",
            ("info.benchmark", info.get("benchmark")),
            ("info.benchmarkIndex", info.get("benchmarkIndex")),
            ("info.category", info.get("category")),
            ("funds_data.fund_overview.index", ((funds_raw.get("fund_overview") or {}).get("index"))),
            ("funds_data.fund_overview.categoryName", ((funds_raw.get("fund_overview") or {}).get("categoryName"))),
        ),
        "trackingError": pick(
            "trackingError",
            ("info.trackingError", info.get("trackingError")),
            ("info.trackingError3Year", info.get("trackingError3Year")),
            cast=to_number,
        ),
        "leveraged": pick(
            "leveraged",
            ("info.leverageRatio", info.get("leverageRatio")),
            ("info.leveraged", info.get("leveraged")),
        ),
        "oneYearReturn": pick(
            "oneYearReturn",
            ("info.52WeekChange", info.get("52WeekChange")),
            cast=to_number,
        ),
        "ytdReturn": pick(
            "ytdReturn",
            ("info.ytdReturn", info.get("ytdReturn")),
            cast=to_number,
        ),
        "threeYearAverageReturn": pick(
            "threeYearAverageReturn",
            ("info.threeYearAverageReturn", info.get("threeYearAverageReturn")),
            cast=to_number,
        ),
        "fiveYearAverageReturn": pick(
            "fiveYearAverageReturn",
            ("info.fiveYearAverageReturn", info.get("fiveYearAverageReturn")),
            cast=to_number,
        ),
        "providerSource": "yfinance",
        "providerFieldSources": field_sources,
    }
    quote["providerFieldUnits"] = {
        field: unit
        for field, source in field_sources.items()
        for unit in [provider_field_unit(field, source, normalized_quote_type)]
        if unit
    }

    required = [
        "regularMarketPrice",
        "marketCap",
        "trailingPE",
        "forwardPE",
        "beta",
        "trailingAnnualDividendYield",
    ]
    quote["providerMissingFields"] = build_provider_notes(field_sources, required)
    quote["providerRaw"] = {
        "info": to_plain(info),
        "fast_info": to_plain(fast),
        "history_metadata": to_plain(metadata),
        "funds_data": funds_raw,
    }
    return quote


def build_summary_from_quote(quote):
    def wrapped(value):
        return wrap_raw(value)

    performance = build_trailing_performance(quote.get("symbol"))
    fund_profile = None
    if quote.get("quoteType") == "ETF":
        raw = quote.get("providerRaw", {})
        funds_data = raw.get("funds_data") or {}
        sector_weightings = normalize_sector_weightings(funds_data.get("sector_weightings"))
        top_holdings = normalize_top_holdings(funds_data.get("top_holdings"))
        if not top_holdings:
            fund_overview = funds_data.get("fund_overview") or {}
            category = fund_overview.get("categoryName") or fund_overview.get("family")
            if category:
                top_holdings = [{"symbol": None, "description": str(category), "weight": None}]
        fund_profile = {
            "netAssets": quote.get("netAssets"),
            "navPrice": quote.get("navPrice"),
            "expenseRatio": quote.get("expenseRatio"),
            "portfolioTurnover": quote.get("portfolioTurnover"),
            "dividendYield": quote.get("trailingAnnualDividendYield"),
            "inceptionDate": quote.get("inceptionDate"),
            "issuer": quote.get("issuer"),
            "trackedIndex": quote.get("trackedIndex"),
            "trackingError": quote.get("trackingError"),
            "leveraged": quote.get("leveraged"),
            "sectors": sector_weightings if isinstance(sector_weightings, list) else [],
            "holdings": top_holdings if isinstance(top_holdings, list) else [],
        }

    return {
        "company": {
            "name": quote.get("longName") or quote.get("shortName") or quote.get("symbol"),
            "sector": ((quote.get("providerRaw", {}).get("info") or {}).get("sector")) or "",
            "industry": ((quote.get("providerRaw", {}).get("info") or {}).get("industry")) or ("ETF" if quote.get("quoteType") == "ETF" else ""),
            "exchange": quote.get("fullExchangeName") or quote.get("exchange") or "",
        },
        "defaultKeyStatistics": {
            "beta": wrapped(quote.get("beta")),
            "forwardPE": wrapped(quote.get("forwardPE")),
            "sharesOutstanding": wrapped(quote.get("sharesOutstanding")),
        },
        "summaryDetail": {
            "trailingPE": wrapped(quote.get("trailingPE")),
            "forwardPE": wrapped(quote.get("forwardPE")),
            "marketCap": wrapped(quote.get("marketCap")),
            "dividendYield": wrapped(quote.get("trailingAnnualDividendYield")),
            "fiftyTwoWeekLow": wrapped(quote.get("fiftyTwoWeekLow")),
            "fiftyTwoWeekHigh": wrapped(quote.get("fiftyTwoWeekHigh")),
            "fiftyDayAverage": wrapped(quote.get("fiftyDayAverage")),
            "twoHundredDayAverage": wrapped(quote.get("twoHundredDayAverage")),
            "priceToBook": wrapped(quote.get("priceToBook")),
        },
        "earnings": {
            "eps": quote.get("epsTrailingTwelveMonths"),
            "forwardEps": quote.get("epsForward"),
        },
        "valuation": {
            "bookValue": quote.get("bookValue"),
            "marketCap": quote.get("marketCap"),
            "priceToBook": quote.get("priceToBook"),
        },
        "dividends": {
            "dividendYield": quote.get("trailingAnnualDividendYield"),
            "dividendPerShare": quote.get("dividendRate"),
            "exDividendDate": quote.get("exDividendDate"),
        },
        "performance": {
            "ytdReturn": performance.get("ytdReturn"),
            "oneYearReturn": performance.get("oneYearReturn"),
            "threeYearReturn": performance.get("threeYearReturn"),
            "fiveYearReturn": performance.get("fiveYearReturn"),
            "returnMethod": performance.get("returnMethod"),
            "returnSource": performance.get("returnSource"),
            "historyRange": performance.get("historyRange"),
            "asOfDate": performance.get("asOfDate"),
            "windowMeta": performance.get("windowMeta") or {},
            "providerReported": {
                "oneYearReturn": quote.get("oneYearReturn"),
                "ytdReturn": quote.get("ytdReturn"),
                "threeYearAverageReturn": quote.get("threeYearAverageReturn"),
                "fiveYearAverageReturn": quote.get("fiveYearAverageReturn"),
            },
        },
        "fundProfile": fund_profile,
        "providerSource": "yfinance",
        "providerFieldSources": quote.get("providerFieldSources") or {},
        "providerFieldUnits": quote.get("providerFieldUnits") or {},
        "providerMissingFields": quote.get("providerMissingFields") or [],
        "providerRaw": quote.get("providerRaw") or {},
    }


def clean_text(value):
    if value is None:
        return ""
    text = html.unescape(str(value))
    text = text.replace("\xa0", " ").replace("\ufeff", "")
    return re.sub(r"\s+", " ", text).strip()


def normalize_header_token(value):
    return re.sub(r"[^a-z0-9]+", "", clean_text(value).lower())


def xml_local_name(tag):
    return str(tag).split("}", 1)[-1]


def fetch_url_bytes(url, accept="*/*"):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortfolioAnalyzer/1.0 Safari/537.36",
            "Accept": accept,
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
        },
    )
    with urlopen(request, timeout=25) as response:
        return response.read()


def xlsx_shared_strings(zf):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ElementTree.fromstring(zf.read("xl/sharedStrings.xml"))
    strings = []
    for item in root.iter():
        if xml_local_name(item.tag) != "si":
            continue
        parts = []
        for child in item.iter():
            if xml_local_name(child.tag) == "t" and child.text:
                parts.append(child.text)
        strings.append("".join(parts))
    return strings


def xlsx_column_index(cell_ref):
    match = re.match(r"([A-Z]+)", str(cell_ref or "").upper())
    if not match:
        return None
    index = 0
    for char in match.group(1):
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def xlsx_cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    value_text = None
    inline_parts = []
    for child in cell.iter():
        local = xml_local_name(child.tag)
        if local == "v" and child.text is not None:
            value_text = child.text
        elif local == "t" and child.text is not None:
            inline_parts.append(child.text)
    if cell_type == "s" and value_text is not None:
        try:
            return shared_strings[int(value_text)]
        except Exception:
            return value_text
    if cell_type == "inlineStr" and inline_parts:
        return "".join(inline_parts)
    return value_text if value_text is not None else "".join(inline_parts)


def rows_from_xlsx_bytes(payload):
    rows = []
    with zipfile.ZipFile(BytesIO(payload)) as zf:
        shared_strings = xlsx_shared_strings(zf)
        sheet_paths = sorted(
            name for name in zf.namelist()
            if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")
        )
        for sheet_path in sheet_paths:
            root = ElementTree.fromstring(zf.read(sheet_path))
            for row in root.iter():
                if xml_local_name(row.tag) != "row":
                    continue
                values = []
                cursor = 0
                for cell in list(row):
                    if xml_local_name(cell.tag) != "c":
                        continue
                    column_index = xlsx_column_index(cell.attrib.get("r"))
                    if column_index is None:
                        column_index = cursor
                    while len(values) < column_index:
                        values.append("")
                    values.append(clean_text(xlsx_cell_value(cell, shared_strings)))
                    cursor = column_index + 1
                if any(clean_text(value) for value in values):
                    rows.append(values)
    return rows


def decode_text_payload(payload):
    for encoding in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            return payload.decode(encoding)
        except Exception:
            continue
    return payload.decode("utf-8", errors="ignore")


def rows_from_csv_bytes(payload):
    return [row for row in csv.reader(StringIO(decode_text_payload(payload))) if any(clean_text(cell) for cell in row)]


class HoldingsTableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.in_table = False
        self.current_table = None
        self.current_row = None
        self.current_cell = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "table":
            self.in_table = True
            self.current_table = []
        elif self.in_table and tag == "tr":
            self.current_row = []
        elif self.in_table and tag in {"td", "th"}:
            self.current_cell = []

    def handle_data(self, data):
        if self.current_cell is not None:
            self.current_cell.append(data)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.in_table and tag in {"td", "th"} and self.current_cell is not None:
            if self.current_row is not None:
                self.current_row.append(clean_text(" ".join(self.current_cell)))
            self.current_cell = None
        elif self.in_table and tag == "tr":
            if self.current_table is not None and self.current_row and any(clean_text(cell) for cell in self.current_row):
                self.current_table.append(self.current_row)
            self.current_row = None
        elif tag == "table" and self.in_table:
            if self.current_table:
                self.tables.append(self.current_table)
            self.in_table = False
            self.current_table = None
            self.current_row = None
            self.current_cell = None


def rows_from_html_table(payload):
    parser = HoldingsTableParser()
    parser.feed(decode_text_payload(payload))
    best_rows = []
    best_score = -1
    for rows in parser.tables:
        header_index = find_holdings_header_index(rows)
        if header_index is None:
            continue
        score = len(rows) - header_index
        if score > best_score:
            best_rows = rows
            best_score = score
    return best_rows


def header_column(headers, candidates):
    tokens = [normalize_header_token(header) for header in headers]
    normalized_candidates = [normalize_header_token(candidate) for candidate in candidates]
    for index, token in enumerate(tokens):
        if token in normalized_candidates:
            return index
    for index, token in enumerate(tokens):
        if not token:
            continue
        if any(candidate and candidate in token for candidate in normalized_candidates):
            return index
    return None


def find_holdings_header_index(rows):
    best_index = None
    best_score = 0
    for index, row in enumerate(rows[:5000]):
        symbol_index = header_column(row, ("ticker", "ticker symbol", "symbol", "holding symbol"))
        name_index = header_column(row, ("name", "company name", "company", "security", "security name", "holding name"))
        weight_index = header_column(row, ("weight", "weight %", "weight (%)", "% assets", "assets", "percent", "portfolio weight"))
        score = 0
        if symbol_index is not None:
            score += 2
        if name_index is not None:
            score += 1
        if weight_index is not None:
            score += 2
        if score > best_score:
            best_index = index
            best_score = score
    return best_index if best_score >= 3 else None


def holding_row_cell(row, index):
    if index is None or index < 0 or index >= len(row):
        return ""
    return clean_text(row[index])


def normalize_holding_weight(value, percent_unit=False):
    if is_finite_number(value):
        numeric = float(value)
    else:
        text = clean_text(value)
        if not text or text in {"-", "--", "N/A"}:
            return None
        text = text.replace("%", "").replace(",", "").replace("$", "")
        match = re.search(r"-?\d+(?:\.\d+)?", text)
        if not match:
            return None
        try:
            numeric = float(match.group(0))
        except Exception:
            return None
    if not math.isfinite(numeric) or numeric < 0:
        return None
    if percent_unit:
        return numeric / 100
    return numeric / 100 if numeric > 1 else numeric


def normalize_holding_symbol(symbol):
    text = clean_text(symbol)
    if not text:
        return None
    upper = text.upper().strip()
    if upper in CASH_LIKE_HOLDING_SYMBOLS:
        return None
    return upper


def holding_price_symbol(symbol):
    normalized = normalize_holding_symbol(symbol)
    if not normalized:
        return None
    candidate = normalized.replace(".", "-").replace("/", "-")
    candidate = re.sub(r"\s+", "", candidate)
    if candidate in CASH_LIKE_HOLDING_SYMBOLS:
        return None
    if re.fullmatch(r"[A-Z]{1,8}(?:-[A-Z]{1,4})?", candidate):
        return candidate
    return None


def short_holding_label(name, fallback):
    text = normalize_holding_symbol(name) or normalize_holding_symbol(fallback)
    if not text:
        return None
    return re.sub(r"[^A-Z0-9]+", "-", text).strip("-")[:24] or None


def extract_holdings_as_of(rows):
    for row in rows[:40]:
        text = " ".join(clean_text(cell) for cell in row if clean_text(cell))
        if not text:
            continue
        match = re.search(
            r"(?:as of|asof)\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[-/][A-Za-z]{3,9}[-/]\d{2,4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})",
            text,
            re.IGNORECASE,
        )
        if match:
            return clean_text(match.group(1))
    return None


def holding_from_row(row, headers, source_symbol, row_number):
    symbol_index = header_column(headers, ("ticker", "ticker symbol", "symbol", "holding symbol", "local ticker"))
    name_index = header_column(headers, ("name", "company name", "company", "security", "security name", "holding name", "issuer", "description"))
    weight_index = header_column(headers, ("weight", "weight %", "weight (%)", "% assets", "assets", "percent", "portfolio weight", "net assets"))
    sector_index = header_column(headers, ("sector", "gics sector", "industry", "super sector"))
    asset_index = header_column(headers, ("asset class", "assetclass", "class", "holding type", "type"))

    raw_symbol = normalize_holding_symbol(holding_row_cell(row, symbol_index))
    name = clean_text(holding_row_cell(row, name_index)) or raw_symbol
    if not name:
        return None
    if name.upper() in {"TOTAL", "TOTALS", "CASH COLLATERAL"}:
        return None
    if name.lower().startswith(("the securities", "holdings are", "these amounts", "all holdings")):
        return None

    weight = normalize_holding_weight(holding_row_cell(row, weight_index), percent_unit=True)
    price_symbol = holding_price_symbol(raw_symbol)
    display_symbol = raw_symbol or short_holding_label(name, f"{source_symbol}-{row_number}") or f"{source_symbol}-{row_number}"
    sector = clean_text(holding_row_cell(row, sector_index))
    asset_class = clean_text(holding_row_cell(row, asset_index))
    shares_index = header_column(headers, ("shares", "shares held", "quantity"))
    market_value_index = header_column(headers, ("market value", "marketvalue", "value"))
    return {
        "symbol": display_symbol,
        "name": name,
        "weight": weight,
        "sector": sector or None,
        "assetClass": asset_class or None,
        "priceSymbol": price_symbol,
        "shares": to_number(holding_row_cell(row, shares_index)),
        "marketValue": to_number(holding_row_cell(row, market_value_index)),
    }


def holdings_from_rows(rows, source_symbol, provider):
    header_index = find_holdings_header_index(rows)
    if header_index is None:
        raise ValueError("Could not identify a holdings table header.")
    headers = rows[header_index]
    as_of = extract_holdings_as_of(rows)
    holdings = []
    seen = set()
    for row_number, row in enumerate(rows[header_index + 1:], start=1):
        holding = holding_from_row(row, headers, source_symbol, row_number)
        if not holding:
            continue
        key = (holding.get("symbol"), holding.get("name"))
        if key in seen:
            continue
        seen.add(key)
        holdings.append(holding)
    if not holdings:
        raise ValueError("Holdings table was found but did not contain usable holdings.")
    return build_holdings_payload(source_symbol, provider, holdings, as_of)


def build_holdings_payload(symbol, provider, holdings, as_of=None, source_url=None):
    normalized_symbol = str(symbol or "").strip().upper()
    clean_holdings = []
    for index, holding in enumerate(holdings, start=1):
        symbol_value = normalize_holding_symbol(holding.get("symbol"))
        name = clean_text(holding.get("name")) or symbol_value
        if not symbol_value and not name:
            continue
        weight = normalize_holding_weight(holding.get("weight"))
        price_symbol = holding_price_symbol(holding.get("priceSymbol") or symbol_value)
        market_value = to_number(holding.get("marketValue"))
        market_cap = parse_market_size(holding.get("marketCap"))
        shares = to_number(holding.get("shares"))
        clean_holdings.append({
            "rank": index,
            "symbol": symbol_value or f"{normalized_symbol}-{index}",
            "name": name or symbol_value or f"{normalized_symbol} Holding {index}",
            "weight": weight,
            "sector": clean_text(holding.get("sector")) or None,
            "industry": clean_text(holding.get("industry")) or None,
            "assetClass": clean_text(holding.get("assetClass")) or None,
            "priceSymbol": price_symbol,
            "marketValue": market_value,
            "marketCap": market_cap,
            "marketCapSource": clean_text(holding.get("marketCapSource")) or None,
            "lastPrice": to_number(holding.get("lastPrice")),
            "dailyReturn": parse_percent_value(holding.get("dailyReturn")) if isinstance(holding.get("dailyReturn"), str) else to_number(holding.get("dailyReturn")),
            "shares": shares,
        })
    clean_holdings.sort(key=lambda item: (
        1 if item.get("weight") is None else 0,
        -(item.get("weight") or 0),
        item.get("symbol") or "",
    ))
    for index, holding in enumerate(clean_holdings, start=1):
        holding["rank"] = index
    weight_coverage = sum(item.get("weight") or 0 for item in clean_holdings)
    return {
        "symbol": normalized_symbol,
        "provider": provider,
        "sourceUrl": source_url,
        "asOf": as_of,
        "count": len(clean_holdings),
        "weightCoverage": weight_coverage,
        "fetchedAt": utc_now_iso(),
        "holdings": clean_holdings,
    }


def parse_spdr_holdings(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    lower = normalized_symbol.lower()
    urls = [
        f"https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{lower}.xlsx",
        f"https://www.ssga.com/us/en/institutional/etfs/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{lower}.xlsx",
        f"https://www.ssga.com/us/en/intermediary/etfs/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{lower}.xlsx",
        f"https://www.ssga.com/us/en/institutional/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{lower}.xlsx",
        f"https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{lower}.xlsx",
    ]
    if normalized_symbol not in SPDR_HOLDINGS_SYMBOLS:
        # Unknown tickers only get the most common SPDR URL probe to avoid slow multi-URL misses.
        urls = urls[:1]
    attempts = []
    for url in urls:
        try:
            payload = fetch_url_bytes(url, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*")
            result = holdings_from_rows(rows_from_xlsx_bytes(payload), normalized_symbol, "State Street daily SPDR holdings file")
            result["sourceUrl"] = url
            return result
        except Exception as exc:
            attempts.append(f"{url}: {exc}")
    raise ValueError("State Street SPDR holdings download failed. " + " | ".join(attempts))


def strip_html_tags(value):
    return clean_text(re.sub(r"<[^>]+>", " ", str(value or "")))


def fetch_nasdaq_screener_map():
    cached = NASDAQ_SCREENER_CACHE.get("all")
    now = utc_timestamp()
    if cached and now - cached.get("loadedAt", 0) < HOLDINGS_CACHE_SECONDS:
        return cached.get("map") or {}

    url = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true"
    payload = json.loads(fetch_url_bytes(url, "application/json,*/*").decode("utf-8", errors="ignore"))
    rows = (((payload or {}).get("data") or {}).get("rows") or [])
    result = {}
    for row in rows:
        raw_symbol = clean_text(row.get("symbol"))
        if not raw_symbol:
            continue
        price_symbol = holding_price_symbol(raw_symbol) or yahoo_price_symbol(raw_symbol)
        item = {
            "symbol": price_symbol,
            "rawSymbol": raw_symbol,
            "name": clean_company_name(row.get("name")) or raw_symbol,
            "sector": clean_text(row.get("sector")) or None,
            "industry": clean_text(row.get("industry")) or None,
            "marketCap": parse_market_size(row.get("marketCap")),
            "lastPrice": parse_market_size(row.get("lastsale")),
            "dailyReturn": parse_percent_value(row.get("pctchange")),
            "source": "Nasdaq stock screener",
        }
        for key in market_symbol_keys(raw_symbol) + market_symbol_keys(price_symbol):
            result[key] = item
    NASDAQ_SCREENER_CACHE["all"] = {"loadedAt": now, "map": result}
    return result


def screener_lookup(symbol, screener_map=None):
    lookup = screener_map if screener_map is not None else fetch_nasdaq_screener_map()
    for key in market_symbol_keys(symbol):
        if key in lookup:
            return lookup[key]
    return None


def enrich_holdings_with_market_data(payload):
    holdings = list((payload or {}).get("holdings") or [])
    if not holdings:
        return payload
    try:
        screener = fetch_nasdaq_screener_map()
    except Exception:
        return payload

    changed = False
    enriched_holdings = []
    for holding in holdings:
        item = dict(holding)
        meta = screener_lookup(item.get("priceSymbol") or item.get("symbol"), screener)
        if meta:
            if not item.get("marketCap") and meta.get("marketCap"):
                item["marketCap"] = meta.get("marketCap")
                item["marketCapSource"] = meta.get("source")
                changed = True
            if not item.get("sector") and meta.get("sector"):
                item["sector"] = meta.get("sector")
                changed = True
            if not item.get("industry") and meta.get("industry"):
                item["industry"] = meta.get("industry")
                changed = True
            if not item.get("lastPrice") and meta.get("lastPrice"):
                item["lastPrice"] = meta.get("lastPrice")
                changed = True
            if item.get("dailyReturn") is None and meta.get("dailyReturn") is not None:
                item["dailyReturn"] = meta.get("dailyReturn")
                changed = True
        enriched_holdings.append(item)

    if not changed:
        return payload
    enriched = dict(payload)
    enriched["holdings"] = enriched_holdings
    enriched["marketDataProvider"] = "Nasdaq stock screener"
    return enriched


def index_alias(index_key):
    normalized = clean_text(index_key).lower().replace(" ", "").replace("-", "").replace("_", "")
    aliases = {
        "sp500": "sp500",
        "spx": "sp500",
        "spy": "sp500",
        "voo": "sp500",
        "ivv": "sp500",
        "rsp": "sp500",
        "nasdaq100": "nasdaq100",
        "nasdaq": "nasdaq100",
        "ndx": "nasdaq100",
        "qqq": "nasdaq100",
        "dow": "dow30",
        "dow30": "dow30",
        "djia": "dow30",
        "dia": "dow30",
    }
    return aliases.get(normalized)


def stockanalysis_table_rows(url):
    payload = fetch_url_bytes(url, "text/html,*/*")
    parser = HoldingsTableParser()
    parser.feed(decode_text_payload(payload))
    if not parser.tables:
        raise ValueError("No HTML tables found.")
    return max(parser.tables, key=len)


def build_index_constituents_payload(index_key, provider, rows, as_of=None, source_url=None):
    normalized_key = index_alias(index_key) or index_key
    label = (INDEX_SOURCE_CONFIGS.get(normalized_key) or {}).get("label") or normalized_key
    clean_rows = []
    seen = set()
    for index, row in enumerate(rows, start=1):
        raw_symbol = row.get("symbol")
        price_symbol = holding_price_symbol(raw_symbol) or yahoo_price_symbol(raw_symbol)
        if not price_symbol or price_symbol in seen:
            continue
        seen.add(price_symbol)
        market_cap = parse_market_size(row.get("marketCap"))
        clean_rows.append({
            "rank": index,
            "symbol": price_symbol,
            "name": clean_company_name(row.get("name")) or price_symbol,
            "sector": clean_text(row.get("sector")) or None,
            "industry": clean_text(row.get("industry")) or None,
            "marketCap": market_cap,
            "lastPrice": parse_market_size(row.get("lastPrice")),
            "dailyReturn": parse_percent_value(row.get("dailyReturn")) if isinstance(row.get("dailyReturn"), str) else to_number(row.get("dailyReturn")),
            "priceSymbol": price_symbol,
        })
    if not clean_rows:
        raise ValueError(f"No usable {label} constituents found.")
    clean_rows.sort(key=lambda item: (-(item.get("marketCap") or 0), item.get("symbol") or ""))
    total_market_cap = sum(item.get("marketCap") or 0 for item in clean_rows)
    for index, row in enumerate(clean_rows, start=1):
        row["rank"] = index
        row["weight"] = (row.get("marketCap") or 0) / total_market_cap if total_market_cap > 0 else None
    return {
        "index": normalized_key,
        "label": label,
        "provider": provider,
        "sourceUrl": source_url,
        "asOf": as_of,
        "count": len(clean_rows),
        "totalMarketCap": total_market_cap or None,
        "fetchedAt": utc_now_iso(),
        "constituents": clean_rows,
    }


def parse_stockanalysis_index_constituents(index_key, url, label):
    rows = stockanalysis_table_rows(url)
    if not rows:
        raise ValueError("StockAnalysis returned no table rows.")
    headers = rows[0]
    symbol_index = header_column(headers, ("symbol", "ticker"))
    name_index = header_column(headers, ("company name", "name", "company"))
    market_cap_index = header_column(headers, ("market cap", "marketcap"))
    price_index = header_column(headers, ("stock price", "price", "last sale"))
    change_index = header_column(headers, ("% change", "change", "pctchange", "percentage change"))
    if symbol_index is None or name_index is None or market_cap_index is None:
        raise ValueError("StockAnalysis table is missing symbol, company, or market-cap columns.")

    try:
        screener = fetch_nasdaq_screener_map()
    except Exception:
        screener = {}

    constituents = []
    for row in rows[1:]:
        raw_symbol = holding_row_cell(row, symbol_index)
        meta = screener_lookup(raw_symbol, screener) if screener else None
        constituents.append({
            "symbol": raw_symbol,
            "name": holding_row_cell(row, name_index),
            "marketCap": holding_row_cell(row, market_cap_index),
            "lastPrice": holding_row_cell(row, price_index),
            "dailyReturn": holding_row_cell(row, change_index),
            "sector": (meta or {}).get("sector"),
            "industry": (meta or {}).get("industry"),
        })
    return build_index_constituents_payload(
        index_key,
        f"StockAnalysis {label} market-cap table + Nasdaq screener sectors",
        constituents,
        source_url=url,
    )


def parse_nasdaq100_constituents():
    config = INDEX_SOURCE_CONFIGS["nasdaq100"]
    url = config["nasdaq_url"]
    payload = json.loads(fetch_url_bytes(url, "application/json,*/*").decode("utf-8", errors="ignore"))
    data = (payload or {}).get("data") or {}
    rows = (((data.get("data") or {}).get("rows")) or [])
    if not rows:
        raise ValueError("Nasdaq API returned no Nasdaq-100 rows.")
    try:
        screener = fetch_nasdaq_screener_map()
    except Exception:
        screener = {}
    constituents = []
    for row in rows:
        raw_symbol = row.get("symbol")
        meta = screener_lookup(raw_symbol, screener) if screener else None
        constituents.append({
            "symbol": raw_symbol,
            "name": row.get("companyName"),
            "marketCap": row.get("marketCap"),
            "lastPrice": row.get("lastSalePrice"),
            "dailyReturn": row.get("percentageChange"),
            "sector": (meta or {}).get("sector") or row.get("sector"),
            "industry": (meta or {}).get("industry"),
        })
    return build_index_constituents_payload(
        "nasdaq100",
        "Nasdaq official Nasdaq-100 list + Nasdaq stock screener sectors",
        constituents,
        as_of=data.get("date"),
        source_url=url,
    )


def parse_index_from_etf_holdings(index_key, etf_symbol):
    payload = enrich_holdings_with_market_data(get_etf_holdings(etf_symbol))
    constituents = []
    for holding in payload.get("holdings") or []:
        constituents.append({
            "symbol": holding.get("priceSymbol") or holding.get("symbol"),
            "name": holding.get("name"),
            "marketCap": holding.get("marketCap"),
            "lastPrice": holding.get("lastPrice"),
            "dailyReturn": holding.get("dailyReturn"),
            "sector": holding.get("sector"),
            "industry": holding.get("industry"),
        })
    result = build_index_constituents_payload(
        index_key,
        f"{payload.get('provider') or etf_symbol} holdings enriched with Nasdaq screener market caps",
        constituents,
        as_of=payload.get("asOf"),
        source_url=payload.get("sourceUrl"),
    )
    result["providerAttemptChain"] = payload.get("providerAttemptChain")
    return result


def get_index_constituents(index_key):
    normalized_key = index_alias(index_key)
    if not normalized_key or normalized_key not in INDEX_SOURCE_CONFIGS:
        raise ValueError(f"Unsupported index universe: {index_key}.")
    cached = INDEX_CONSTITUENTS_CACHE.get(normalized_key)
    now = utc_timestamp()
    if cached and now - cached.get("loadedAt", 0) < HOLDINGS_CACHE_SECONDS:
        payload = dict(cached.get("payload") or {})
        payload["cacheHit"] = True
        return payload

    config = INDEX_SOURCE_CONFIGS[normalized_key]
    attempts = []
    providers = []
    if normalized_key == "nasdaq100":
        providers.append(("Nasdaq", parse_nasdaq100_constituents))
    if config.get("stockanalysis_url"):
        providers.append((
            "StockAnalysis",
            lambda key=normalized_key, url=config["stockanalysis_url"], label=config["label"]: parse_stockanalysis_index_constituents(key, url, label),
        ))
    if config.get("fallback_etf"):
        providers.append((
            f"{config['fallback_etf']} holdings fallback",
            lambda key=normalized_key, etf=config["fallback_etf"]: parse_index_from_etf_holdings(key, etf),
        ))

    for label, provider in providers:
        try:
            payload = provider()
            if payload.get("constituents"):
                payload["providerAttemptChain"] = attempts + [label]
                payload["cacheHit"] = False
                INDEX_CONSTITUENTS_CACHE[normalized_key] = {"loadedAt": now, "payload": payload}
                return payload
            attempts.append(f"{label}: returned no constituents")
        except Exception as exc:
            attempts.append(f"{label}: {exc}")
    raise ValueError(f"No usable {config['label']} constituents found. Attempted providers: {' | '.join(attempts)}")


def limit_index_constituents_payload(payload, limit):
    limited = dict(payload or {})
    constituents = list(limited.get("constituents") or [])
    if limit and limit > 0:
        limited["constituents"] = constituents[:limit]
        limited["displayCount"] = len(limited["constituents"])
    else:
        limited["constituents"] = constituents
        limited["displayCount"] = len(constituents)
    return limited


def format_ishares_date(value):
    numeric = to_int(value)
    if numeric and 19000101 <= numeric <= 22000101:
        text = str(numeric)
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    return clean_text(value) or None


def datapoint_values(data_points, key):
    point = (data_points or {}).get(key) or {}
    value = point.get("value")
    if isinstance(value, list):
        return value
    formatted = point.get("formattedValue")
    if isinstance(formatted, list):
        return formatted
    if value is not None:
        return [value]
    if formatted is not None:
        return [formatted]
    return []


def datapoint_value(data_points, key, index):
    values = datapoint_values(data_points, key)
    if index < 0 or index >= len(values):
        return None
    return values[index]


def fetch_ishares_product_list():
    cached = ISHARES_PRODUCT_LIST_CACHE.get("us")
    now = utc_timestamp()
    if cached and now - cached.get("loadedAt", 0) < HOLDINGS_CACHE_SECONDS:
        return cached.get("products") or {}

    url = "https://www.ishares.com/us/products/etf-investments"
    payload = fetch_url_bytes(url, "text/html,*/*").decode("utf-8", errors="ignore")
    products = {}
    row_pattern = re.compile(
        r"<tr>\s*<td[^>]*class=\"links\"[^>]*>\s*<a\s+href=\"(?P<path>/us/products/(?P<product_id>\d+)/(?P<slug>[^\"]+))\"[^>]*>(?P<ticker>[^<]+)</a>\s*</td>\s*"
        r"<td[^>]*class=\"links\"[^>]*>\s*<a[^>]*>(?P<name>.*?)</a>\s*</td>",
        re.IGNORECASE | re.DOTALL,
    )
    for match in row_pattern.finditer(payload):
        ticker = clean_text(match.group("ticker")).upper()
        if not ticker:
            continue
        products[ticker] = {
            "product_id": match.group("product_id"),
            "slug": clean_text(match.group("slug")),
            "name": strip_html_tags(match.group("name")),
            "productUrl": f"https://www.ishares.com{match.group('path')}",
        }
    if not products:
        raise ValueError("Could not discover iShares product list.")
    ISHARES_PRODUCT_LIST_CACHE["us"] = {"loadedAt": now, "products": products}
    return products


def discover_ishares_product_config(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    config = ISHARES_HOLDINGS.get(normalized_symbol)
    if config:
        return dict(config)
    product = fetch_ishares_product_list().get(normalized_symbol)
    if not product:
        raise ValueError(f"{normalized_symbol} was not found in the iShares US ETF product list.")
    return product


def parse_ishares_product_data_holdings(symbol, config):
    normalized_symbol = str(symbol or "").strip().upper()
    params = {
        "appSubType": "ISHARES",
        "appType": "PRODUCT_PAGE",
        "component": "holdings.all",
        "locale": "en_US",
        "portfolioId": str(config.get("product_id") or ""),
        "targetSite": "us-ishares",
        "userType": "individual",
        "excludeContent": "true",
        "asOfDate": "",
        "includeConfig": "true",
    }
    if not params["portfolioId"]:
        raise ValueError(f"Missing iShares product id for {normalized_symbol}.")
    url = "https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?" + urlencode(params)
    payload = json.loads(fetch_url_bytes(url, "application/json,*/*").decode("utf-8"))
    holdings_component = ((payload.get("componentsByNameMap") or {}).get("holdings") or {})
    container = ((holdings_component.get("containersByNameMap") or {}).get("all") or {})
    data_points = container.get("dataPointsByNameMap") or {}
    as_of = (
        ((data_points.get("asOfDate") or {}).get("formattedValue"))
        or format_ishares_date((data_points.get("asOfDate") or {}).get("value"))
    )
    row_count = max(
        len(datapoint_values(data_points, key))
        for key in ("ticker", "issueName", "holdingPercent", "marketValue", "assetClass", "sectorName")
    )
    holdings = []
    for index in range(row_count):
        ticker = clean_text(datapoint_value(data_points, "ticker", index))
        name = (
            clean_text(datapoint_value(data_points, "issueName", index))
            or clean_text(datapoint_value(data_points, "issueDescription", index))
            or ticker
        )
        if not name and not ticker:
            continue
        symbol_value = ticker or clean_text(datapoint_value(data_points, "cusip", index)) or short_holding_label(name, f"{normalized_symbol}-{index + 1}")
        holdings.append({
            "symbol": symbol_value,
            "name": name or symbol_value,
            "weight": normalize_holding_weight(datapoint_value(data_points, "holdingPercent", index), percent_unit=True),
            "sector": clean_text(datapoint_value(data_points, "sectorName", index)) or clean_text(datapoint_value(data_points, "industryName", index)),
            "assetClass": clean_text(datapoint_value(data_points, "assetClass", index)) or "ETF holding",
            "priceSymbol": holding_price_symbol(ticker),
            "shares": datapoint_value(data_points, "unitsHeld", index) or datapoint_value(data_points, "parValue", index),
            "marketValue": datapoint_value(data_points, "marketValue", index),
        })
    if not holdings:
        raise ValueError("iShares product-data API returned no usable holdings.")
    result = build_holdings_payload(
        normalized_symbol,
        "iShares/BlackRock product-data API",
        holdings,
        as_of,
        url,
    )
    result["productUrl"] = config.get("productUrl")
    return result


def parse_ishares_legacy_csv_holdings(symbol, config):
    normalized_symbol = str(symbol or "").strip().upper()
    if not config.get("slug") or not config.get("product_id"):
        raise ValueError(f"Missing legacy iShares CSV config for {normalized_symbol}.")
    url = (
        f"https://www.ishares.com/us/products/{config['product_id']}/{config['slug']}/1467271812596.ajax"
        f"?fileType=csv&fileName={normalized_symbol}_holdings&dataType=fund"
    )
    payload = fetch_url_bytes(url, "text/csv,*/*")
    result = holdings_from_rows(rows_from_csv_bytes(payload), normalized_symbol, "iShares daily holdings CSV")
    result["sourceUrl"] = url
    return result


def parse_ishares_holdings(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    config = discover_ishares_product_config(normalized_symbol)
    attempts = []
    for parser in (parse_ishares_product_data_holdings, parse_ishares_legacy_csv_holdings):
        try:
            return parser(normalized_symbol, config)
        except Exception as exc:
            attempts.append(f"{parser.__name__}: {exc}")
    raise ValueError("iShares holdings fetch failed. " + " | ".join(attempts))


def parse_vanguard_holdings(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    initial_url = f"https://advisors.vanguard.com/investments/products/initial-fund-info/{normalized_symbol.lower()}"
    initial_payload = json.loads(fetch_url_bytes(initial_url, "application/json,*/*").decode("utf-8"))
    port_id = (((initial_payload or {}).get("fundProfile") or {}).get("portId") or "").strip()
    if not port_id:
        raise ValueError(f"Vanguard did not return a portId for {normalized_symbol}.")

    holdings_url = f"https://advisors.vanguard.com/investments/products/holdings/latest/{port_id}"
    holdings_payload = json.loads(fetch_url_bytes(holdings_url, "application/json,*/*").decode("utf-8"))
    latest_date = holdings_payload.get("latestEffectiveDate")
    holding_bucket = holdings_payload.get(latest_date) if latest_date else None
    if not isinstance(holding_bucket, dict):
        raise ValueError(f"Vanguard did not return a latest holdings bucket for {normalized_symbol}.")

    holdings = []
    for row in holding_bucket.get("equity") or []:
        ticker = row.get("ticker")
        holdings.append({
            "symbol": ticker,
            "name": row.get("holdingName") or ticker,
            "weight": normalize_holding_weight(row.get("percentOfFunds"), percent_unit=True),
            "sector": row.get("sector"),
            "assetClass": "Equity",
            "priceSymbol": holding_price_symbol(ticker),
            "shares": row.get("quantity"),
            "marketValue": row.get("marketValue"),
        })
    for row in holding_bucket.get("fixedIncome") or []:
        title = row.get("issuerTitle") or row.get("issuerName")
        holdings.append({
            "symbol": row.get("issuerTitle") or row.get("cusip") or title,
            "name": row.get("issuerName") or title,
            "weight": None,
            "sector": row.get("investmentCategory"),
            "assetClass": "Fixed Income",
            "priceSymbol": None,
            "shares": row.get("principalAmount"),
            "marketValue": row.get("amortizedCost"),
        })
    if not holdings:
        raise ValueError(f"Vanguard returned no usable holdings for {normalized_symbol}.")

    result = build_holdings_payload(normalized_symbol, "Vanguard official latest holdings JSON", holdings, latest_date, holdings_url)
    result["providerAttemptChain"] = ["Vanguard"]
    return result


def reference_holdings_by_symbol(reference_symbol="VOO"):
    normalized_symbol = str(reference_symbol or "VOO").strip().upper()
    cached = REFERENCE_HOLDINGS_CACHE.get(normalized_symbol)
    now = utc_timestamp()
    if cached and now - cached.get("loadedAt", 0) < HOLDINGS_CACHE_SECONDS:
        return cached.get("map") or {}
    payload = parse_vanguard_holdings(normalized_symbol)
    reference_map = {}
    for holding in payload.get("holdings") or []:
        key = holding_price_symbol(holding.get("priceSymbol") or holding.get("symbol"))
        if key:
            reference_map[key] = holding
    REFERENCE_HOLDINGS_CACHE[normalized_symbol] = {"loadedAt": now, "map": reference_map}
    return reference_map


def enrich_holdings_with_reference(payload, reference_symbol="VOO"):
    try:
        reference_map = reference_holdings_by_symbol(reference_symbol)
    except Exception:
        return payload
    enriched = dict(payload or {})
    holdings = []
    changed = False
    for holding in enriched.get("holdings") or []:
        item = dict(holding)
        key = holding_price_symbol(item.get("priceSymbol") or item.get("symbol"))
        reference = reference_map.get(key) if key else None
        if reference:
            if not clean_text(item.get("sector")) or clean_text(item.get("sector")) == "-":
                item["sector"] = reference.get("sector")
                changed = True
            if item.get("marketValue") is None and reference.get("marketValue") is not None:
                item["marketValue"] = reference.get("marketValue")
                changed = True
        holdings.append(item)
    if changed:
        enriched["holdings"] = holdings
        enriched["provider"] = f"{enriched.get('provider') or 'holdings'} + Vanguard {reference_symbol} sector/market-value reference"
        enriched["referenceProvider"] = f"Vanguard {reference_symbol} official latest holdings JSON"
    return enriched


def parse_stockanalysis_holdings(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    url = f"https://stockanalysis.com/etf/{normalized_symbol.lower()}/holdings/"
    payload = fetch_url_bytes(url, "text/html,*/*")
    result = holdings_from_rows(rows_from_html_table(payload), normalized_symbol, "StockAnalysis ETF holdings table")
    result["sourceUrl"] = url
    return result


def holdings_from_yfinance_summary(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    quote = normalize_quote(normalized_symbol)
    summary = build_summary_from_quote(quote)
    top_holdings = ((summary.get("fundProfile") or {}).get("holdings") or [])
    holdings = []
    for holding in top_holdings:
        raw_symbol = holding.get("symbol")
        price_symbol = holding_price_symbol(raw_symbol)
        if not raw_symbol and not price_symbol:
            continue
        holdings.append({
            "symbol": raw_symbol,
            "name": holding.get("description") or raw_symbol,
            "weight": holding.get("weight"),
            "sector": None,
            "assetClass": "ETF holding",
            "priceSymbol": price_symbol,
        })
    if not holdings:
        raise ValueError("yfinance did not return usable fund holdings.")
    return build_holdings_payload(normalized_symbol, "yfinance fund profile fallback", holdings)


def get_etf_holdings(symbol):
    normalized_symbol = str(symbol or "").strip().upper()
    if not normalized_symbol:
        raise ValueError("Missing ETF symbol.")
    cached = HOLDINGS_CACHE.get(normalized_symbol)
    now = utc_timestamp()
    if cached and now - cached.get("loadedAt", 0) < HOLDINGS_CACHE_SECONDS:
        payload = dict(cached.get("payload") or {})
        payload["cacheHit"] = True
        return payload

    providers = []
    seen_provider_labels = set()
    def add_provider(label, provider):
        if label in seen_provider_labels:
            return
        providers.append((label, provider))
        seen_provider_labels.add(label)

    if normalized_symbol in SPDR_HOLDINGS_SYMBOLS:
        add_provider("State Street", parse_spdr_holdings)
    if normalized_symbol in ISHARES_HOLDINGS:
        add_provider("iShares", parse_ishares_holdings)
    if normalized_symbol in VANGUARD_HOLDINGS_SYMBOLS:
        add_provider("Vanguard", parse_vanguard_holdings)

    # Generic official issuer probes make the holdings system extensible beyond seed tickers.
    # They fail over cleanly, while the seed lists above keep common dashboard ETFs fast.
    add_provider("iShares", parse_ishares_holdings)
    add_provider("Vanguard", parse_vanguard_holdings)
    add_provider("State Street", parse_spdr_holdings)
    add_provider("StockAnalysis", parse_stockanalysis_holdings)
    add_provider("yfinance", holdings_from_yfinance_summary)

    attempts = []
    for label, provider in providers:
        try:
            payload = provider(normalized_symbol)
            if payload.get("holdings"):
                if label == "State Street":
                    payload = enrich_holdings_with_reference(payload, "VOO")
                payload = enrich_holdings_with_market_data(payload)
                payload["providerAttemptChain"] = attempts + [label]
                payload["cacheHit"] = False
                HOLDINGS_CACHE[normalized_symbol] = {"loadedAt": now, "payload": payload}
                return payload
            attempts.append(f"{label}: returned no holdings")
        except Exception as exc:
            attempts.append(f"{label}: {exc}")
    raise ValueError(f"No usable ETF holdings found for {normalized_symbol}. Attempted providers: {' | '.join(attempts)}")


def limit_holdings_payload(payload, limit):
    limited = dict(payload or {})
    holdings = list(limited.get("holdings") or [])
    if limit and limit > 0:
        limited["holdings"] = holdings[:limit]
        limited["displayCount"] = len(limited["holdings"])
    else:
        limited["holdings"] = holdings
        limited["displayCount"] = len(holdings)
    return limited


def normalize_history(symbol, range_key, interval="1d"):
    normalized_range = str(range_key or "1Y").upper()
    normalized_interval = normalize_interval(interval)
    canonical = normalize_canonical_series_with_fallbacks(symbol, normalized_range, normalized_interval)
    if canonical:
        return canonical
    fred_series_id = resolve_fred_series_id(symbol)
    if fred_series_id:
        candidates = [
            {"provider": "fred", "series_id": fred_series_id, "label": f"FRED {fred_series_id}"},
        ]
        if fred_series_id in {"DFEDTARU", "DFF", "FEDFUNDS"}:
            candidates.append({"provider": "fed_policy", "series_id": "DFEDTARU", "label": "Federal Reserve target-rate table"})
        candidates.extend([
            {"provider": "yfinance", "symbol": symbol, "label": f"Yahoo {str(symbol).upper()}"},
            {"provider": "yahoo_chart", "symbol": symbol, "label": f"Yahoo chart {str(symbol).upper()}"},
        ])
        return normalize_history_with_fallbacks(
            str(symbol or "").upper(),
            normalized_range,
            normalized_interval,
            candidates,
        )
    return normalize_history_with_fallbacks(
        str(symbol or "").upper(),
        normalized_range,
        normalized_interval,
        [
            {"provider": "yfinance", "symbol": symbol, "label": f"Yahoo {str(symbol).upper()}"},
            {"provider": "yahoo_chart", "symbol": symbol, "label": f"Yahoo chart {str(symbol).upper()}"},
        ],
    )


def normalize_lookup_item(item):
    return {
        "symbol": item.get("symbol"),
        "shortname": item.get("shortname") or item.get("name") or item.get("symbol"),
        "longname": item.get("longname") or item.get("name") or item.get("symbol"),
        "exchange": item.get("exchDisp") or item.get("exchange") or "",
        "country": item.get("exchange") or "",
        "quoteType": item.get("quoteType") or item.get("typeDisp") or "",
    }


def search_results(query):
    try:
        if hasattr(yf, "Lookup"):
            lookup = yf.Lookup(query)
            all_items = getattr(lookup, "all", []) or []
        else:
            search = yf.Search(query)
            all_items = getattr(search, "quotes", []) or []
        return [normalize_lookup_item(item) for item in all_items if item.get("symbol")]
    except Exception:
        return []


class Handler(BaseHTTPRequestHandler):
    server_version = "PortfolioAnalyzerBackend/1.0"

    def log_message(self, fmt, *args):
        return

    def _send_json(self, status, payload):
        try:
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            return False

    def do_OPTIONS(self):
        self._send_json(200, {"ok": True})

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            path = parsed.path.rstrip("/")

            if path == "/api/health":
                self._send_json(200, {
                    "ok": True,
                    "provider": "yfinance + yahoo chart + fred fallbacks",
                    "version": APP_VERSION,
                    "backendTime": utc_now_iso(),
                })
                return

            if path == "/api/search":
                query = (params.get("q") or [""])[0].strip()
                if not query:
                    self._send_json(400, {"error": "Missing query parameter q."})
                    return
                self._send_json(200, {"results": search_results(query)})
                return

            if path == "/api/holdings":
                symbol = (params.get("symbol") or [""])[0].strip().upper()
                limit = to_int((params.get("limit") or [None])[0])
                if not symbol:
                    self._send_json(400, {"error": "Missing symbol query parameter."})
                    return
                self._send_json(200, {"holdings": limit_holdings_payload(get_etf_holdings(symbol), limit)})
                return

            if path == "/api/index-constituents":
                index_key = (params.get("index") or [""])[0].strip()
                limit = to_int((params.get("limit") or [None])[0])
                if not index_key:
                    self._send_json(400, {"error": "Missing index query parameter."})
                    return
                self._send_json(200, {"index": limit_index_constituents_payload(get_index_constituents(index_key), limit)})
                return

            if path == "/api/quote":
                symbols = [s.strip().upper() for s in ",".join(params.get("symbols", [])).split(",") if s.strip()]
                if not symbols:
                    self._send_json(400, {"error": "Missing symbols query parameter."})
                    return
                quotes = []
                errors = {}
                for symbol in symbols:
                    try:
                        quotes.append(normalize_quote(symbol))
                    except Exception as exc:
                        errors[symbol] = str(exc)
                self._send_json(200, {"quotes": quotes, "errors": errors})
                return

            if path == "/api/summary":
                symbol = (params.get("symbol") or [""])[0].strip().upper()
                if not symbol:
                    self._send_json(400, {"error": "Missing symbol query parameter."})
                    return
                quote = normalize_quote(symbol)
                self._send_json(200, {"summary": build_summary_from_quote(quote)})
                return

            if path == "/api/history":
                symbols = [s.strip().upper() for s in ",".join(params.get("symbols", [])).split(",") if s.strip()]
                range_key = ((params.get("range") or ["1Y"])[0] or "1Y").upper()
                interval = ((params.get("interval") or ["1d"])[0] or "1d").strip()
                max_fallbacks_raw = ((params.get("maxFallbacks") or [""])[0] or "").strip()
                max_fallbacks = None
                if max_fallbacks_raw:
                    try:
                        max_fallbacks = max(0, int(float(max_fallbacks_raw)))
                    except Exception:
                        max_fallbacks = None
                if not symbols:
                    self._send_json(400, {"error": "Missing symbols query parameter."})
                    return
                histories = {}
                errors = {}
                for symbol in symbols:
                    cached = get_cached_history(symbol, range_key, interval)
                    if cached:
                        histories[symbol] = cached
                missing_symbols = [symbol for symbol in symbols if symbol not in histories]
                bulk_symbols = [symbol for symbol in missing_symbols if not is_backend_canonical_history_symbol(symbol)]
                if len(bulk_symbols) >= 2:
                    try:
                        bulk_histories = normalize_bulk_yfinance_histories(bulk_symbols, range_key, interval)
                        for symbol, history in bulk_histories.items():
                            histories[symbol] = set_cached_history(symbol, range_key, interval, history)
                    except Exception as exc:
                        for symbol in bulk_symbols:
                            errors[symbol] = str(exc)
                fallback_budget = max_fallbacks if max_fallbacks is not None else len(symbols)
                for symbol in symbols:
                    if symbol in histories:
                        continue
                    if fallback_budget <= 0:
                        stale = get_cached_history(symbol, range_key, interval, allow_stale=True)
                        if stale:
                            histories[symbol] = stale
                            errors[symbol] = "Using stale cached history because per-symbol fallback was skipped for speed."
                        else:
                            errors[symbol] = "Skipped per-symbol fallback for speed; bulk history did not return this symbol."
                        continue
                    fallback_budget -= 1
                    try:
                        histories[symbol] = set_cached_history(symbol, range_key, interval, normalize_history(symbol, range_key, interval))
                        errors.pop(symbol, None)
                    except Exception as exc:
                        stale = get_cached_history(symbol, range_key, interval, allow_stale=True)
                        if stale:
                            histories[symbol] = stale
                            errors[symbol] = f"Using stale cached history after refresh failed: {exc}"
                        else:
                            errors[symbol] = str(exc)
                if not histories and errors:
                    self._send_json(200, {"histories": histories, "errors": errors})
                    return
                self._send_json(200, {"histories": histories, "errors": errors})
                return

            self._send_json(404, {"error": f"Unknown endpoint: {path}"})
        except Exception as exc:
            self._send_json(500, {
                "error": str(exc),
                "type": exc.__class__.__name__,
            })


def main():
    server = ThreadingHTTPServer((DEFAULT_HOST, DEFAULT_PORT), Handler)
    print(f"Portfolio Analyzer backend listening on http://{DEFAULT_HOST}:{DEFAULT_PORT}/api/health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
