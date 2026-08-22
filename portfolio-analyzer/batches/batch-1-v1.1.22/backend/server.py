import csv
import json
import math
import os
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

import yfinance as yf


APP_VERSION = "Batch 1 v1.1.22"
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
    "SP500": {
        "title": "S&P 500",
        "units": "index",
    },
}


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
    }


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
    fred_series_id = resolve_fred_series_id(symbol)
    if fred_series_id:
        return normalize_fred_history(symbol, fred_series_id, normalized_range, normalized_interval)
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
    return {
        "ticker": symbol,
        "rangeKey": normalized_range,
        "interval": normalized_interval,
        "dates": dates,
        "prices": prices,
        "adjustedPrices": adjusted_prices,
        "volumes": volumes,
        "opens": opens,
        "highs": highs,
        "lows": lows,
        "providerSource": "yfinance",
    }


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
                    "provider": "yfinance + fred",
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
                quotes = [normalize_quote(symbol) for symbol in symbols]
                self._send_json(200, {"quotes": quotes})
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
                histories = {symbol: normalize_history(symbol, range_key, interval) for symbol in symbols}
                self._send_json(200, {"histories": histories})
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
