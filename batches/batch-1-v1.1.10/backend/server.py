import json
import math
import os
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import yfinance as yf


APP_VERSION = "Batch 1 v1.1.8"
DEFAULT_HOST = os.environ.get("PA_BACKEND_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PA_BACKEND_PORT", "8765"))

RANGE_PERIODS = {
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
    if field in {"expenseRatio", "portfolioTurnover"}:
        return "percent"
    if field == "trailingAnnualDividendYield":
        if quote_type == "ETF":
            return "percent"
        if source in {"info.yield"}:
            return "percent"
        return "ratio"
    return None


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
            ("info.dividendYield", info.get("dividendYield")),
            ("info.trailingAnnualDividendYield", info.get("trailingAnnualDividendYield")),
            ("info.yield", info.get("yield")),
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
        "leveraged": pick(
            "leveraged",
            ("info.leverageRatio", info.get("leverageRatio")),
            ("info.leveraged", info.get("leveraged")),
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

    fund_profile = None
    if quote.get("quoteType") == "ETF":
        raw = quote.get("providerRaw", {})
        funds_data = raw.get("funds_data") or {}
        sector_weightings = funds_data.get("sector_weightings") or []
        top_holdings = funds_data.get("top_holdings") or []
        fund_profile = {
            "netAssets": quote.get("netAssets"),
            "expenseRatio": quote.get("expenseRatio"),
            "portfolioTurnover": quote.get("portfolioTurnover"),
            "dividendYield": quote.get("trailingAnnualDividendYield"),
            "inceptionDate": quote.get("inceptionDate"),
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
        "fundProfile": fund_profile,
        "providerSource": "yfinance",
        "providerFieldSources": quote.get("providerFieldSources") or {},
        "providerFieldUnits": quote.get("providerFieldUnits") or {},
        "providerMissingFields": quote.get("providerMissingFields") or [],
        "providerRaw": quote.get("providerRaw") or {},
    }


def normalize_history(symbol, range_key):
    period = RANGE_PERIODS.get(range_key.upper(), "1y")
    ticker = yf.Ticker(symbol)
    frame = ticker.history(period=period, interval="1d", auto_adjust=False, actions=False)
    if frame is None or getattr(frame, "empty", True):
        raise ValueError(f"No price history returned by yfinance for {symbol}.")
    frame = frame.reset_index()
    dates = []
    prices = []
    volumes = []
    opens = []
    highs = []
    lows = []
    for _, row in frame.iterrows():
        dt = row.get("Date")
        if hasattr(dt, "date"):
            dt = dt.date().isoformat()
        else:
            dt = str(dt).split(" ")[0]
        dates.append(dt)
        opens.append(to_number(row.get("Open")))
        highs.append(to_number(row.get("High")))
        lows.append(to_number(row.get("Low")))
        prices.append(to_number(row.get("Close")))
        volumes.append(to_int(row.get("Volume")))
    return {
        "ticker": symbol,
        "rangeKey": range_key,
        "dates": dates,
        "prices": prices,
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
                    "provider": "yfinance",
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
                if not symbols:
                    self._send_json(400, {"error": "Missing symbols query parameter."})
                    return
                histories = {symbol: normalize_history(symbol, range_key) for symbol in symbols}
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
