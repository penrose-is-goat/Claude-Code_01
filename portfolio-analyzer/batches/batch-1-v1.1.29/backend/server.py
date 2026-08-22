import csv
import json
import math
import os
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

import yfinance as yf


APP_VERSION = "Batch 1 v1.1.29"
DEFAULT_HOST = os.environ.get("PA_BACKEND_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PA_BACKEND_PORT", "8765"))

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
        parsed = float(value)
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
            return datetime.utcfromtimestamp(value).isoformat()
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
    today = datetime.utcnow().date()
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
    end_date = end_date or datetime.utcnow().date()
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
    ticker = yf.Ticker(symbol)
    frame = ticker.history(period=period, interval=normalized_interval, auto_adjust=False, actions=False, prepost=False)
    if frame is None or getattr(frame, "empty", True):
        raise ValueError(f"No price history returned by yfinance for {symbol} ({normalized_range}, {normalized_interval}).")
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
        "providerSymbol": str(symbol).upper(),
        "providerTransform": transform_applied,
        "providerFallbackLabel": fallback_label,
    }


def yahoo_chart_timestamp(timestamp, interval):
    value = to_number(timestamp)
    if value is None:
        return None
    dt = datetime.utcfromtimestamp(value)
    normalized_interval = normalize_interval(interval)
    if normalized_interval in {"1d", "1wk", "1mo"}:
        return dt.date().isoformat()
    return dt.isoformat()


def normalize_yahoo_chart_history(symbol, range_key, interval="1d", requested_symbol=None, provider_source="yahoo-chart", transform=None, fallback_label=None):
    normalized_range = str(range_key or "1Y").upper()
    normalized_interval = normalize_interval(interval)
    params = {
        "range": period_for_request(normalized_range, normalized_interval),
        "interval": normalized_interval,
        "includePrePost": "false",
        "events": "div,splits",
    }
    request = Request(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(str(symbol))}?{urlencode(params)}",
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
        "providerSymbol": str(symbol).upper(),
        "providerTransform": transform_applied,
        "providerFallbackLabel": fallback_label,
    }


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
    ticker = yf.Ticker(symbol)
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
        "symbol": symbol,
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
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

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
                    "backendTime": datetime.utcnow().isoformat() + "Z",
                })
                return

            if path == "/api/search":
                query = (params.get("q") or [""])[0].strip()
                if not query:
                    self._send_json(400, {"error": "Missing query parameter q."})
                    return
                self._send_json(200, {"results": search_results(query)})
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
                if not symbols:
                    self._send_json(400, {"error": "Missing symbols query parameter."})
                    return
                histories = {}
                errors = {}
                for symbol in symbols:
                    try:
                        histories[symbol] = normalize_history(symbol, range_key, interval)
                    except Exception as exc:
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
