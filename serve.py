#!/usr/bin/env python3
"""Local market side-tools server.

This intentionally uses only the Python standard library so the user can run:

    python serve.py --check
    python serve.py

No package install, browser driver, spreadsheet export, or pasted CSV required.
"""

from __future__ import annotations

import argparse
import calendar
import copy
import concurrent.futures
import csv
import gzip
import hashlib
import hmac
import io
import json
import math
import mimetypes
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from data_core import (
    NetworkPolicyError,
    diagnose_network,
    finish_network_trace,
    get_secret,
    http_get,
    http_get_bytes,
    load_settings,
    public_settings,
    save_settings,
    start_network_trace,
)
import treasury_auctions
import macro_providers
import model_router
import intent_contract
import coverage_planner


APP_DIR = Path(__file__).resolve().parent
APP_VERSION = "side-tools.v1.3.0"
DEFAULT_PORT = 8017
HTTP_TIMEOUT = 18
STATIC_FILES = {
    "index.html",
    "fred-tool.html",
    "fred-tool.js",
    "chart-scale.js",
    "fed-tracker.html",
    "fed-tracker.js",
    "treasury-auctions.html",
    "treasury-auctions.js",
    "style.css",
}
_CACHE: dict[str, tuple[float, Any]] = {}
_MACRO_CLARIFICATION_SECRET = secrets.token_bytes(32)
FED_HISTORY_PATH = APP_DIR / ".cache" / "fed-probability-history.json"
_FED_HISTORY_LOCK = threading.Lock()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


BACKEND_SOURCE_FILES = [
    APP_DIR / name
    for name in (
        "serve.py",
        "macro_providers.py",
        "data_core.py",
        "model_router.py",
        "intent_contract.py",
        "coverage_planner.py",
        "treasury_auctions.py",
    )
]
BACKEND_STARTED_AT = utc_now_iso()
BACKEND_SOURCE_MTIMES = {
    str(path): path.stat().st_mtime_ns for path in BACKEND_SOURCE_FILES if path.exists()
}
BACKEND_BUILD = hashlib.sha256(
    b"\0".join(path.read_bytes() for path in BACKEND_SOURCE_FILES if path.exists())
).hexdigest()[:12]


def backend_status() -> dict[str, Any]:
    restart_required = any(
        not path.exists()
        or path.stat().st_mtime_ns != BACKEND_SOURCE_MTIMES.get(str(path))
        for path in BACKEND_SOURCE_FILES
    )
    return {
        "version": APP_VERSION,
        "build": BACKEND_BUILD,
        "startedAt": BACKEND_STARTED_AT,
        "restartRequired": restart_required,
    }


def today_local() -> date:
    return date.today()


def cache_get(key: str, ttl_seconds: int, loader):
    now = time.time()
    cached = _CACHE.get(key)
    if cached and now - cached[0] <= ttl_seconds:
        return cached[1]
    value = loader()
    _CACHE[key] = (now, value)
    return value


def http_get_text(
    url: str,
    params: dict[str, Any] | None = None,
    timeout: int = HTTP_TIMEOUT,
    headers: dict[str, str] | None = None,
    default_headers: bool = True,
    cache_ttl: int = 15 * 60,
    allow_stale: bool = True,
    cache_enabled: bool = True,
) -> str:
    return http_get(
        url,
        params=params,
        timeout=timeout,
        headers=headers,
        default_headers=default_headers,
        cache_ttl=cache_ttl,
        allow_stale=allow_stale,
        cache_enabled=cache_enabled,
    ).text


def http_get_json(
    url: str,
    params: dict[str, Any] | None = None,
    timeout: int = HTTP_TIMEOUT,
    headers: dict[str, str] | None = None,
    default_headers: bool = True,
    cache_ttl: int = 15 * 60,
    allow_stale: bool = True,
    cache_enabled: bool = True,
) -> Any:
    text = http_get_text(
        url,
        params=params,
        timeout=timeout,
        headers=headers,
        default_headers=default_headers,
        cache_ttl=cache_ttl,
        allow_stale=allow_stale,
        cache_enabled=cache_enabled,
    )
    return json.loads(text)


def add_years(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        return d.replace(month=2, day=28, year=d.year + years)


def add_months(d: date, months: int) -> date:
    total = d.year * 12 + d.month - 1 + months
    year = total // 12
    month = total % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def parse_requested_range(prompt: str) -> dict[str, Any]:
    text = macro_providers.normalize_quantitative_phrasing(prompt)
    end = today_local()
    start: date | None = None
    label = "max available"

    if re.search(r"\b(max|maximum|all history|full history)\b", text):
        return {"start": None, "end": end, "label": label}

    if re.search(r"\b(?:year[ -]to[ -]date|ytd)\b", text):
        start = date(end.year, 1, 1)
        return {"start": start, "end": end, "label": f"{end.year} year to date"}

    quarter_token = r"(?:q[1-4]\s*(?:19|20)\d{2}|(?:19|20)\d{2}\s*q[1-4])"
    quarter_match = re.search(
        rf"\b(?:from|between)\s+({quarter_token})\s+(?:to|and|through)\s+({quarter_token})\b",
        text,
    )
    if quarter_match:
        def parse_quarter_token(value: str) -> tuple[int, int]:
            year_match = re.search(r"(?:19|20)\d{2}", value)
            quarter_value = re.search(r"q([1-4])", value)
            if not year_match or not quarter_value:
                raise ValueError(f"Invalid quarter endpoint: {value}.")
            return int(year_match.group(0)), int(quarter_value.group(1))

        start_year, start_quarter = parse_quarter_token(quarter_match.group(1))
        end_year, end_quarter = parse_quarter_token(quarter_match.group(2))
        start_date = date(start_year, 1 + (start_quarter - 1) * 3, 1)
        end_month = end_quarter * 3
        end_date = date(end_year, end_month, calendar.monthrange(end_year, end_month)[1])
        if start_date > end_date:
            raise ValueError("The requested start quarter must not be after the end quarter.")
        return {
            "start": start_date,
            "end": end_date,
            "label": f"Q{start_quarter} {start_year} to Q{end_quarter} {end_year}",
        }

    match = re.search(r"\b(?:from|between)\s+(19\d{2}|20\d{2})\s+(?:to|and|through)\s+(19\d{2}|20\d{2})\b", text)
    if match:
        start_year, end_year = int(match.group(1)), int(match.group(2))
        if start_year > end_year:
            raise ValueError("The requested start year must not be after the end year.")
        return {
            "start": date(start_year, 1, 1),
            "end": date(end_year, 12, 31),
            "label": f"{start_year} to {end_year}",
        }

    match = re.search(r"\bsince\s+(19\d{2}|20\d{2})\b", text)
    if match:
        start_year = int(match.group(1))
        return {"start": date(start_year, 1, 1), "end": end, "label": f"since {start_year}"}

    duration_match = re.search(
        r"\b(?:last|past|previous|trailing|for|over|during)\s+(?:the\s+)?(?:last\s+)?"
        r"(\d{1,4})[\s-]*(years?|yrs?|y|months?|mos?|m|quarters?|qtrs?|decades?|weeks?|days?|d)\b",
        text,
    )
    if not duration_match:
        duration_match = re.search(
            r"\b(\d{1,4})[\s-]*(years?|months?|quarters?|decades?|weeks?|days?)\s+(?:of\s+)?(?:history|data)\b",
            text,
        )
    if duration_match:
        amount = int(duration_match.group(1))
        unit = duration_match.group(2)
        if unit.startswith(("year", "yr")) or unit == "y":
            start = add_years(end, -amount)
            label = f"last {amount} year{'s' if amount != 1 else ''}"
        elif unit.startswith("decade"):
            years = amount * 10
            start = add_years(end, -years)
            label = f"last {years} years"
        elif unit.startswith(("month", "mo")) or unit == "m":
            start = add_months(end, -amount)
            label = f"last {amount} month{'s' if amount != 1 else ''}"
        elif unit.startswith(("quarter", "qtr")):
            months = amount * 3
            start = add_months(end, -months)
            label = f"last {amount} quarter{'s' if amount != 1 else ''}"
        elif unit.startswith("week"):
            start = end - timedelta(days=amount * 7)
            label = f"last {amount} week{'s' if amount != 1 else ''}"
        else:
            start = end - timedelta(days=amount)
            label = f"last {amount} day{'s' if amount != 1 else ''}"
        return {"start": start, "end": end, "label": label}

    singular_window = re.search(
        r"\b(?:last|past|previous|trailing)\s+(decade|year|quarter|month|week|day)\b",
        text,
    )
    if singular_window:
        unit = singular_window.group(1)
        amount = 10 if unit == "decade" else 1
        normalized_unit = "years" if unit == "decade" else f"{unit}s"
        return parse_requested_range(f"last {amount} {normalized_unit}")

    horizon_text = re.sub(
        r"\b(?:year[ -]over[ -]year|month[ -]over[ -]month|quarter[ -]over[ -]quarter)\b",
        "",
        text,
    )
    if re.search(
        r"\b(?:last|past|previous|trailing|for|over|during)\b[^,.;]{0,30}"
        r"\b(?:years?|months?|quarters?|decades?|weeks?|days?)\b",
        horizon_text,
    ):
        raise ValueError(
            "I found a requested time window but could not parse it exactly. Use a number and unit, "
            "such as 'last 25 years', 'past 24 months', or 'Q1 2010 to Q4 2020'."
        )

    return {"start": add_years(end, -10), "end": end, "label": "last 10 years"}


SERIES_CATALOG: list[dict[str, Any]] = [
    {
        "id": "US_PUBLIC_EQUITY_MARKET_CAP",
        "name": "U.S. Public Equity Market Capitalization",
        "unit": "Millions of U.S. dollars",
        "aliases": [
            r"\b(?:total|broad|overall|entire|all)\s+(?:u\.?s\.?|united states)\s+"
            r"(?:public\s+)?(?:equity|equities|stock)\s+market(?:\s+capitali[sz]ation|\s+cap)?\b",
            r"\b(?:total|broad|overall|entire|all)\s+(?:u\.?s\.?|united states)\s+"
            r"(?:stock|equity|equities)\s+market\b",
            r"\b(?:u\.?s\.?|united states)\s+(?:public\s+)?(?:stock|equity)\s+"
            r"market\s+capitali[sz]ation\b",
            r"\b(?:total|broad|overall)?\s*(?:u\.?s\.?|united states)\s+public\s+"
            r"(?:stock|equity)\s+capitali[sz]ation\b",
            r"\bmarket value of (?:publicly traded\s+)?(?:u\.?s\.?|united states)\s+"
            r"(?:equities|stocks)\b",
            r"\b(?:total|broad|overall)\s+(?:u\.?s\.?|united states)\s+stock[- ]market value\b",
        ],
        "primary": "fed-z1",
        "z1File": "csv/F51_1_s.csv",
        "z1Series": "LM883164115.Q",
        "fred": "BOGZ1LM883164115Q",
        "origin": "Board of Governors of the Federal Reserve System, Financial Accounts of the United States",
        "sourceUrl": "https://www.federalreserve.gov/releases/z1/",
        "resolution": "Federal Reserve Z.1 public corporate equities issued by U.S. domestic sectors at market value",
        "measureType": "market_capitalization",
        "preferredUnits": "raw",
    },
    {
        "id": "US_DEBT_SECURITIES_OUTSTANDING",
        "name": "Total U.S. Debt Securities Outstanding",
        "unit": "Millions of U.S. dollars",
        "aliases": [
            r"\b(?:total|broad|overall|entire|all)\s+(?:u\.?s\.?|united states)\s+"
            r"(?:outstanding\s+)?(?:debt|fixed income|bond)\s+market"
            r"(?:\s+(?:size|capitali[sz]ation|outstanding))?\b",
            r"\b(?:u\.?s\.?|united states)\s+(?:total\s+)?debt securities\s+outstanding\b",
            r"\btotal\s+(?:u\.?s\.?|united states)\s+(?:bond|fixed income)\s+market\b",
            r"\b(?:total\s+)?outstanding\s+(?:u\.?s\.?|united states)\s+debt securities\b",
            r"\b(?:u\.?s\.?|united states)\s+debt securities market\b",
            r"\boutstanding\s+(?:u\.?s\.?|united states)\s+(?:bond|fixed income)[- ]market debt\b",
        ],
        "primary": "fed-z1",
        "z1File": "csv/F3_s.csv",
        "z1Series": "FL894122005.Q",
        "fred": "ASTDSL",
        "origin": "Board of Governors of the Federal Reserve System, Financial Accounts of the United States",
        "sourceUrl": "https://www.federalreserve.gov/releases/z1/",
        "resolution": "Federal Reserve Z.1 total debt securities liabilities outstanding",
        "measureType": "debt_securities_outstanding",
        "preferredUnits": "raw",
    },
    {
        "id": "TCMDO",
        "name": "Total U.S. Credit-Market Debt Outstanding",
        "unit": "Millions of U.S. dollars",
        "aliases": [
            r"\b(?:total|all)\s+(?:u\.?s\.?|united states)\s+credit(?:[- ]market)?\s+debt\b",
            r"\b(?:u\.?s\.?|united states)\s+debt\s+including\s+loans\b",
            r"\btcmdo\b",
        ],
        "origin": "Board of Governors of the Federal Reserve System, Financial Accounts of the United States",
        "resolution": "Federal Reserve total credit-market debt including debt securities and loans",
        "measureType": "credit_market_debt_outstanding",
        "preferredUnits": "raw",
    },
    {
        "id": "US_FEDERAL_DEBT_OUTSTANDING",
        "name": "Total U.S. Federal Public Debt Outstanding",
        "unit": "Millions of U.S. dollars",
        "aliases": [
            r"\b(?:total\s+)?(?:u\.?s\.?|united states)\s+(?:federal|national)\s+debt(?:\s+outstanding)?\b",
            r"\b(?:federal|national)\s+public debt(?:\s+outstanding)?\b",
            r"\bdebt to the penny\b",
        ],
        "primary": "fiscal-debt",
        "fred": "GFDEBTN",
        "origin": "U.S. Department of the Treasury, Fiscal Data",
        "sourceUrl": "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/",
        "resolution": "Treasury Debt to the Penny total public debt outstanding",
        "measureType": "federal_public_debt_outstanding",
        "preferredUnits": "raw",
    },
    {
        "id": "SP500",
        "name": "S&P 500 Index",
        "unit": "Index level",
        "aliases": [
            r"\bs\s*&\s*p\s*500\b",
            r"\bs\W*p\W*500\b",
            r"\bsp500\b",
            r"\bspx\b",
            r"\bsandp\b",
            r"\bs\s*&\s*p\s+(?:500\s+)?price index\b",
        ],
        "yahoo": "^GSPC",
        "yahooName": "S&P 500 Index",
    },
    {
        "id": "DGS10",
        "name": "10-Year Treasury Yield",
        "unit": "Percent",
        "aliases": [
            r"\b(?:10|ten)[\s-]*(?:year|yr|y)\s+(?:treasury|yield|rate)\b",
            r"\btreasury\s+(?:10|ten)[\s-]*(?:year|yr|y)\b",
            r"\bdgs10\b",
        ],
    },
    {
        "id": "DGS2",
        "name": "2-Year Treasury Yield",
        "unit": "Percent",
        "aliases": [
            r"\b(?:2|two)[\s-]*(?:year|yr|y)\s+(?:treasury|yield|rate)\b",
            r"\btreasury\s+(?:2|two)[\s-]*(?:year|yr|y)\b",
            r"\bdgs2\b",
        ],
    },
    {
        "id": "DGS30",
        "name": "30-Year Treasury Yield",
        "unit": "Percent",
        "aliases": [
            r"\b(?:30|thirty)[\s-]*(?:year|yr|y)\s+(?:treasury|yield|rate)\b",
            r"\btreasury\s+(?:30|thirty)[\s-]*(?:year|yr|y)\b",
            r"\bdgs30\b",
        ],
    },
    {
        "id": "DGS3MO",
        "name": "3-Month Treasury Bill",
        "unit": "Percent",
        "aliases": [
            r"\b(?:3|three)[\s-]*(?:month|mo)\s+(?:treasury|yield|rate|bill)\b",
            r"\btreasury\s+(?:3|three)[\s-]*(?:month|mo)\b",
            r"\bdgs3mo\b",
        ],
    },
    {
        "id": "EFFR",
        "name": "Effective Federal Funds Rate",
        "unit": "Percent",
        "aliases": [
            r"\beffr\b",
            r"\beffective fed",
            r"\bfed funds\b",
            r"\bfederal funds rate\b",
        ],
    },
    {
        "id": "DFF",
        "name": "Federal Funds Effective Rate",
        "unit": "Percent",
        "aliases": [r"\bdff\b", r"\bfederal funds effective\b"],
    },
    {
        "id": "FEDFUNDS",
        "name": "Monthly Federal Funds Rate",
        "unit": "Percent",
        "aliases": [r"\bfedfunds\b", r"\bmonthly fed funds\b"],
    },
    {
        "id": "DFEDTARL",
        "name": "Fed Target Range Lower Bound",
        "unit": "Percent",
        "aliases": [r"\bdfedtarl\b", r"\bfed target lower\b"],
    },
    {
        "id": "DFEDTARU",
        "name": "Fed Target Range Upper Bound",
        "unit": "Percent",
        "aliases": [r"\bdfedtaru\b", r"\bfed target upper\b"],
    },
    {
        "id": "VIXCLS",
        "name": "CBOE Volatility Index",
        "unit": "Index level",
        "aliases": [r"\bvix\b", r"\bvixcls\b"],
        "yahoo": "^VIX",
        "yahooName": "CBOE Volatility Index",
    },
    {
        "id": "NASDAQCOM",
        "name": "NASDAQ Composite Index",
        "unit": "Index level",
        "aliases": [r"\bnasdaq composite\b", r"\bnasdaqcom\b", r"\bixic\b", r"\bnasdaq\b"],
        "excludes": [r"\bnasdaq[- ]?100\b", r"\bndx\b"],
        "yahoo": "^IXIC",
        "yahooName": "NASDAQ Composite Index",
    },
    {
        "id": "DJIA",
        "name": "Dow Jones Industrial Average",
        "unit": "Index level",
        "aliases": [r"\bdow jones\b", r"\bdjia\b", r"\bdow\b"],
        "yahoo": "^DJI",
        "yahooName": "Dow Jones Industrial Average",
    },
    {
        "id": "CPIAUCSL",
        "name": "Consumer Price Index",
        "unit": "Index level",
        "aliases": [
            r"\bheadline cpi\b",
            r"\bcpi\b",
            r"\bconsumer price (?:index|inflation)\b",
            r"\binflation rate\b",
            r"\bcpiaucsl\b",
        ],
        "bls": "CUSR0000SA0",
    },
    {
        "id": "UNRATE",
        "name": "Unemployment Rate",
        "unit": "Percent",
        "aliases": [r"\bunemployment\b", r"\bunrate\b"],
        "bls": "LNS14000000",
    },
]

SERIES_CATALOG.extend(
    [
        {
            "id": "GDPC1",
            "name": "Real Gross Domestic Product",
            "unit": "Billions of chained dollars",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\breal\s+gdp\b", r"\bgdpc1\b"],
        },
        {
            "id": "GDP",
            "name": "Gross Domestic Product",
            "unit": "Billions of dollars",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\bnominal\s+gdp\b", r"\bgross domestic product\b", r"\bgdp\b"],
            "excludes": [r"\breal\s+gdp\b", r"\bgdp (?:price )?deflator\b"],
        },
        {
            "id": "GDPDEF",
            "name": "Gross Domestic Product: Implicit Price Deflator",
            "unit": "Index 2017=100",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\bgdp (?:price )?deflator\b", r"\bgdpdef\b"],
        },
        {
            "id": "PNFIC1",
            "name": "Real Private Nonresidential Fixed Investment",
            "unit": "Billions of chained dollars",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [
                r"\breal private nonresidential fixed investment\b",
                r"\breal business fixed investment\b",
                r"\bpnfic1\b",
            ],
        },
        {
            "id": "PNFI",
            "name": "Private Nonresidential Fixed Investment",
            "unit": "Billions of dollars",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [
                r"\bnominal private nonresidential fixed investment\b",
                r"\bnominal business fixed investment\b",
                r"\bpnfi\b",
            ],
        },
        {
            "id": "PCEPI",
            "name": "PCE Price Index",
            "unit": "Index level",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\bpce price index\b", r"\bpce inflation\b", r"\bpcepi\b"],
            "excludes": [r"\bcore\b"],
        },
        {
            "id": "PCEPILFE",
            "name": "Core PCE Price Index",
            "unit": "Index level",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\bcore pce\b", r"\bpcepilfe\b"],
        },
        {
            "id": "CPILFESL",
            "name": "Core Consumer Price Index",
            "unit": "Index level",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\bcore cpi\b",
                r"\bcore consumer price(?: index|s)?\b",
                r"\bcpilfesl\b",
            ],
            "excludes": [r"\bcore cpi (?:excluding|less|ex) shelter\b"],
            "bls": "CUSR0000SA0L1E",
        },
        {
            "id": "CPI_CORE_EX_SHELTER",
            "name": "Core Consumer Price Index Excluding Shelter",
            "unit": "Index level",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\bcore cpi (?:excluding|less|ex) shelter\b",
                r"\bcpi (?:excluding|less) food,? (?:and )?energy,? (?:and )?shelter\b",
                r"\bcusr0000sa0l12e\b",
            ],
            "bls": "CUSR0000SA0L12E",
        },
        {
            "id": "CPI_SHELTER",
            "name": "Consumer Price Index: Shelter",
            "unit": "Index 1982-1984=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bcpi (?:for )?shelter\b", r"\bshelter cpi\b"],
            "bls": "CUSR0000SAH1",
            "fred": "CUSR0000SAH1",
        },
        {
            "id": "CPI_OER",
            "name": "Consumer Price Index: Owners' Equivalent Rent",
            "unit": "Index Dec 1982=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bowners?'? equivalent rent\b", r"\boer cpi\b"],
            "bls": "CUSR0000SEHC",
            "fred": "CUSR0000SEHC",
        },
        {
            "id": "CPI_MEDICAL",
            "name": "Consumer Price Index: Medical Care",
            "unit": "Index 1982-1984=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bmedical care cpi\b", r"\bcpi (?:for )?medical care\b"],
            "bls": "CUSR0000SAM2",
            "fred": "CUSR0000SAM2",
        },
        {
            "id": "CPI_FOOD",
            "name": "Consumer Price Index: Food",
            "unit": "Index 1982-1984=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bfood cpi\b", r"\bcpi (?:for )?food\b"],
            "bls": "CUSR0000SAF1",
            "fred": "CUSR0000SAF1",
        },
        {
            "id": "CPI_ENERGY",
            "name": "Consumer Price Index: Energy",
            "unit": "Index 1982-1984=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\benergy cpi\b", r"\bcpi (?:for )?energy\b"],
            "bls": "CUSR0000SA0E",
            "fred": "CUSR0000SA0E",
        },
        {
            "id": "WPSFD49116",
            "name": "Core PPI: Final Demand Less Foods, Energy, and Trade Services",
            "unit": "Index Aug 2013=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\bcore\s+(?:ppi|producer price index)(?:\s+(?:for\s+)?final demand)?\b",
                r"\bcore\s+producer prices?\s+for\s+final demand(?:\s+goods?\s+and\s+services?)?\b",
                r"\bcore\s+final[- ]demand\s+(?:ppi|producer prices?|producer price index)\b",
                r"\bfinal demand less foods?,? energy,? and trade services\b",
                r"\bwpsfd49116\b",
            ],
            "bls": "WPSFD49116",
        },
        {
            "id": "WPSFD49104",
            "name": "PPI: Final Demand Less Foods and Energy",
            "unit": "Index Apr 2010=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\b(?:ppi|producer price index)?\s*final demand less foods? and energy\b",
                r"\bwpsfd49104\b",
                r"\bppifes\b",
            ],
            "bls": "WPSFD49104",
        },
        {
            "id": "WPSFD413",
            "name": "Core PPI Goods: Final Demand Goods Less Foods and Energy",
            "unit": "Index Nov 2009=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\bcore ppi goods\b",
                r"\bfinal demand goods less foods? and energy\b",
                r"\bwpsfd413\b",
            ],
            "bls": "WPSFD413",
        },
        {
            "id": "WPSFD49113",
            "name": "Core PPI Services: Final Demand Services Less Trade Services",
            "unit": "Index Apr 2010=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\bcore ppi services\b",
                r"\bfinal demand services less trade services\b",
                r"\bwpsfd49113\b",
            ],
            "bls": "WPSFD49113",
        },
        {
            "id": "WPSFD4131",
            "name": "Legacy Core PPI: Finished Goods Less Foods and Energy",
            "unit": "Index 1982=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\bfinished goods less foods? and energy\b",
                r"\blegacy core ppi\b",
                r"\bwpsfd4131\b",
            ],
            "bls": "WPSFD4131",
        },
        {
            "id": "WPSFD4",
            "name": "Producer Price Index: Final Demand",
            "unit": "Index Nov 2009=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\bheadline ppi\b",
                r"\bproducer price index(?: for)? final demand\b",
                r"\bppi(?: final demand)?\b",
            ],
            "excludes": [
                r"\bcore\b",
                r"\bless (?:foods?|energy|trade)\b",
                r"\ball commodities\b",
                r"\bfinished goods\b",
            ],
            "bls": "WPSFD4",
        },
        {
            "id": "PPIACO",
            "name": "Producer Price Index: All Commodities",
            "unit": "Index level",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bppi all commodities\b", r"\bproducer price index: all commodities\b", r"\bppiaco\b"],
            "bls": "WPU00000000",
        },
        {
            "id": "CES0500000003",
            "name": "Average Hourly Earnings of All Employees, Total Private",
            "unit": "Dollars per hour",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [
                r"\baverage hourly earnings\b",
                r"\bhourly earnings(?: of (?:all )?employees)?\b",
                r"\bces0500000003\b",
            ],
            "bls": "CES0500000003",
        },
        {
            "id": "AWHI",
            "name": "Average Weekly Hours of All Employees, Total Private",
            "unit": "Hours per week",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\baverage weekly hours\b", r"\bawhi\b"],
            "bls": "CES0500000002",
            "fred": "AWHAETP",
        },
        {
            "id": "CIVPART",
            "name": "Labor Force Participation Rate",
            "unit": "Percent",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\blabor force participation(?: rate)?\b", r"\bcivpart\b"],
            "bls": "LNS11300000",
        },
        {
            "id": "EMRATIO",
            "name": "Employment-Population Ratio",
            "unit": "Percent",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bemployment[- ](?:to[- ])?population ratio\b", r"\bemratio\b"],
            "bls": "LNS12300000",
        },
        {
            "id": "U6RATE",
            "name": "U-6 Labor Underutilization Rate",
            "unit": "Percent",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bu[- ]?6 (?:unemployment|underemployment|rate)?\b", r"\bu6rate\b"],
            "bls": "LNS13327709",
        },
        {
            "id": "PAYEMS",
            "name": "Total Nonfarm Payrolls",
            "unit": "Thousands of persons",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bnonfarm payrolls?\b", r"\bpayrolls?\b", r"\bpayems\b"],
            "bls": "CES0000000001",
        },
        {
            "id": "ICSA",
            "name": "Initial Unemployment Claims",
            "unit": "Number",
            "origin": "U.S. Employment and Training Administration",
            "aliases": [r"\binitial (?:(?:jobless|unemployment) )?claims\b", r"\bicsa\b"],
        },
        {
            "id": "CCSA",
            "name": "Continued Unemployment Claims",
            "unit": "Number",
            "origin": "U.S. Employment and Training Administration",
            "aliases": [r"\bcontinu(?:ed|ing) (?:jobless |unemployment )?claims\b", r"\bccsa\b"],
        },
        {
            "id": "JTSJOL",
            "name": "Job Openings",
            "unit": "Thousands",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bjob openings\b", r"\bjolts\b", r"\bjtsjol\b"],
            "bls": "JTS000000000000000JOL",
        },
        {
            "id": "JTSHIR",
            "name": "Hires Rate: Total Nonfarm",
            "unit": "Percent",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bhires rate\b", r"\bhires\b", r"\bjts?hir\b"],
        },
        {
            "id": "JTSQUR",
            "name": "Quits Rate: Total Nonfarm",
            "unit": "Percent",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bquits rate\b", r"\bquits\b", r"\bjts?qur\b"],
        },
        {
            "id": "INDPRO",
            "name": "Industrial Production Index",
            "unit": "Index level",
            "origin": "Board of Governors of the Federal Reserve System",
            "aliases": [r"\bindustrial production\b", r"\bindpro\b"],
        },
        {
            "id": "RSAFS",
            "name": "Advance Retail Sales",
            "unit": "Millions of dollars",
            "origin": "U.S. Census Bureau",
            "aliases": [r"\bretail sales\b", r"\brsafs\b"],
            "excludes": [r"\breal retail sales\b"],
        },
        {
            "id": "RRSFS",
            "name": "Real Retail and Food Services Sales",
            "unit": "Millions of chained 1982-1984 dollars",
            "origin": "Federal Reserve Bank of St. Louis",
            "aliases": [r"\breal retail(?: and food services)? sales\b", r"\brrsfs\b"],
        },
        {
            "id": "PI",
            "name": "Personal Income",
            "unit": "Billions of dollars",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\bpersonal income\b", r"\bseries pi\b"],
            "excludes": [r"\bdisposable personal income\b"],
        },
        {
            "id": "CFNAI",
            "name": "Chicago Fed National Activity Index",
            "unit": "Index",
            "origin": "Federal Reserve Bank of Chicago",
            "aliases": [r"\bchicago fed national activity index\b", r"\bcfnai\b"],
        },
        {
            "id": "USREC",
            "name": "NBER Recession Indicator",
            "unit": "1 or 0",
            "origin": "National Bureau of Economic Research",
            "aliases": [r"\bu\.?s\.? recession(?: indicator)?\b", r"\brecession indicator\b", r"\busrec\b"],
        },
        {
            "id": "HOUST",
            "name": "Housing Starts",
            "unit": "Thousands of units",
            "origin": "U.S. Census Bureau and HUD",
            "aliases": [r"\bhousing starts\b", r"\bhoust\b"],
        },
        {
            "id": "PERMIT",
            "name": "Building Permits",
            "unit": "Thousands of units",
            "origin": "U.S. Census Bureau and HUD",
            "aliases": [r"\bbuilding permits\b", r"\bpermit\b"],
        },
        {
            "id": "CSUSHPINSA",
            "name": "U.S. National Home Price Index",
            "unit": "Index level",
            "origin": "S&P Cotality Case-Shiller",
            "aliases": [
                r"\bnational home price index\b",
                r"\bu\.?s\.? home price index\b",
                r"\bcase[- ]shiller(?: national)?\b",
                r"\bcsushpinsa\b",
            ],
        },
        {
            "id": "USSTHPI",
            "name": "FHFA U.S. House Price Index",
            "unit": "Index level",
            "origin": "Federal Housing Finance Agency",
            "aliases": [
                r"\bfhfa (?:u\.?s\.? )?(?:house|home) price index\b",
                r"\bfhfa (?:house|home) prices?\b",
                r"\bussthpi\b",
            ],
        },
        {
            "id": "MORTGAGE30US",
            "name": "30-Year Fixed Mortgage Rate",
            "unit": "Percent",
            "origin": "Freddie Mac",
            "aliases": [r"\b30[- ]year (?:fixed )?mortgage(?: rate)?\b", r"\bmortgage30us\b"],
        },
        {
            "id": "HSN1F",
            "name": "New One-Family Houses Sold",
            "unit": "Thousands of units",
            "origin": "U.S. Census Bureau and HUD",
            "aliases": [r"\bnew home sales\b", r"\bnew houses sold\b", r"\bhsn1f\b"],
        },
        {
            "id": "PCEC96",
            "name": "Real Personal Consumption Expenditures",
            "unit": "Billions of chained 2017 dollars",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [
                r"\breal personal consumption(?: expenditures)?\b",
                r"\breal consumption\b",
                r"\breal pce spending\b",
                r"\bpcec96\b",
            ],
        },
        {
            "id": "PSAVERT",
            "name": "Personal Saving Rate",
            "unit": "Percent",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\bpersonal sav(?:ing|ings) rate\b", r"\bsav(?:ing|ings) rate\b", r"\bpsavert\b"],
        },
        {
            "id": "DSPI",
            "name": "Disposable Personal Income",
            "unit": "Billions of dollars",
            "origin": "U.S. Bureau of Economic Analysis",
            "aliases": [r"\bdisposable personal income\b", r"\bdisposable income\b", r"\bdspi\b"],
        },
        {
            "id": "OPHNFB",
            "name": "Nonfarm Business Labor Productivity",
            "unit": "Index 2017=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\b(?:nonfarm business )?(?:labor )?productivity\b", r"\boutput per hour\b", r"\bophnfb\b"],
        },
        {
            "id": "ULCNFB",
            "name": "Nonfarm Business Unit Labor Costs",
            "unit": "Index 2017=100",
            "origin": "U.S. Bureau of Labor Statistics",
            "aliases": [r"\bunit labor costs?\b", r"\bulcnfb\b"],
        },
        {
            "id": "M1SL",
            "name": "M1 Money Stock",
            "unit": "Billions of dollars",
            "origin": "Board of Governors of the Federal Reserve System",
            "aliases": [r"\bm1 money supply\b", r"\bm1 money stock\b", r"\bm1\b", r"\bm1sl\b"],
        },
        {
            "id": "M2SL",
            "name": "M2 Money Stock",
            "unit": "Billions of dollars",
            "origin": "Board of Governors of the Federal Reserve System",
            "aliases": [r"\bm2 money supply\b", r"\bm2 money stock\b", r"\bm2sl\b"],
        },
        {
            "id": "WALCL",
            "name": "Federal Reserve Total Assets",
            "unit": "Millions of dollars",
            "origin": "Board of Governors of the Federal Reserve System",
            "aliases": [r"\bfed(?:eral reserve)? balance sheet\b", r"\bfed total assets\b", r"\bwalcl\b"],
        },
        {
            "id": "RRPONTSYD",
            "name": "Overnight Reverse Repurchase Agreements",
            "unit": "Billions of dollars",
            "origin": "Federal Reserve Bank of New York",
            "aliases": [r"\breverse repo(?: facility| usage)?\b", r"\bovernight rrp\b", r"\brrpontsyd\b"],
        },
        {
            "id": "SOFR",
            "name": "Secured Overnight Financing Rate",
            "unit": "Percent",
            "origin": "Federal Reserve Bank of New York",
            "aliases": [r"\bsofr\b", r"\bsecured overnight financing rate\b"],
        },
        {
            "id": "T10YIE",
            "name": "10-Year Breakeven Inflation Rate",
            "unit": "Percent",
            "origin": "Federal Reserve Bank of St. Louis",
            "aliases": [r"\b10[- ]year breakeven(?: inflation)?\b", r"\bt10yie\b"],
        },
        {
            "id": "T5YIE",
            "name": "5-Year Breakeven Inflation Rate",
            "unit": "Percent",
            "origin": "Federal Reserve Bank of St. Louis",
            "aliases": [r"\b5[- ]year breakeven(?: inflation)?\b", r"\bt5yie\b"],
        },
        {
            "id": "T10Y2Y",
            "name": "10-Year Minus 2-Year Treasury Spread",
            "unit": "Percent",
            "origin": "Federal Reserve Bank of St. Louis using U.S. Treasury data",
            "aliases": [
                r"\b2s10s(?: treasury)? spreads?\b", r"\b2s10s\b", r"\b10[- ]year minus 2[- ]year(?: treasury)?(?: spread)?\b",
                r"\b10y[- ]?2y spread\b", r"\byield[- ]curve(?: spread)?\b", r"\bt10y2y\b",
            ],
        },
        {
            "id": "T10Y3M",
            "name": "10-Year Minus 3-Month Treasury Spread",
            "unit": "Percent",
            "origin": "Federal Reserve Bank of St. Louis using U.S. Treasury data",
            "aliases": [
                r"\b3m10y(?: treasury)? spreads?\b", r"\b3m10y\b", r"\b10[- ]year minus 3[- ]month(?: treasury)?(?: spread)?\b",
                r"\b10y[- ]?3m spread\b", r"\bt10y3m\b",
            ],
        },
        {
            "id": "DFII10",
            "name": "10-Year Inflation-Indexed Treasury Yield",
            "unit": "Percent",
            "origin": "Board of Governors of the Federal Reserve System",
            "aliases": [
                r"\b10[- ]year real (?:treasury )?yield\b",
                r"\b10[- ]year tips yield\b",
                r"\bdfii10\b",
            ],
        },
        {
            "id": "DTWEXBGS",
            "name": "Nominal Broad U.S. Dollar Index",
            "unit": "Index level",
            "origin": "Board of Governors of the Federal Reserve System",
            "aliases": [
                r"\btrade[- ]weighted (?:u\.?s\.? )?dollar(?: index)?\b",
                r"\bbroad (?:u\.?s\.? )?dollar index\b",
                r"\bdtwexbgs\b",
            ],
        },
        {
            "id": "BAMLH0A0HYM2",
            "name": "U.S. High Yield Credit Spread",
            "unit": "Percent",
            "origin": "ICE Data Indices",
            "aliases": [r"\bhigh yield (?:credit )?spread\b", r"\bjunk bond spread\b", r"\bbamlh0a0hym2\b"],
        },
        {
            "id": "DCOILWTICO",
            "name": "WTI Crude Oil Price",
            "unit": "U.S. dollars per barrel",
            "origin": "U.S. Energy Information Administration",
            "aliases": [r"\bwti(?: crude)?(?: oil)?\b", r"\bcrude oil price\b", r"\bdcoilwtico\b"],
            "yahoo": "CL=F",
        },
        {
            "id": "DCOILBRENTEU",
            "name": "Brent Crude Oil Price",
            "unit": "U.S. dollars per barrel",
            "origin": "U.S. Energy Information Administration",
            "aliases": [r"\bbrent(?: crude)?(?: oil)?\b", r"\bdcoilbrenteu\b"],
        },
        {
            "id": "DHHNGSP",
            "name": "Henry Hub Natural Gas Spot Price",
            "unit": "U.S. dollars per million BTU",
            "origin": "U.S. Energy Information Administration",
            "aliases": [r"\bnatural gas(?: spot)? price\b", r"\bnatural gas\b", r"\bhenry hub\b", r"\bdhhngsp\b"],
        },
        {
            "id": "GASREGW",
            "name": "U.S. Regular Gasoline Price",
            "unit": "Dollars per gallon",
            "origin": "U.S. Energy Information Administration",
            "aliases": [r"\b(?:regular )?gasoline prices?\b", r"\bgasoline\b", r"\bgasregw\b"],
        },
        {
            "id": "PCOPPUSDM",
            "name": "Global Copper Price",
            "unit": "U.S. dollars per metric ton",
            "origin": "International Monetary Fund via FRED",
            "aliases": [r"\bcopper prices?\b", r"\bcopper\b", r"\bpcoppusdm\b"],
        },
        {
            "id": "RUSSELL2000",
            "name": "Russell 2000 Index",
            "unit": "Index level",
            "origin": "FTSE Russell",
            "aliases": [r"\brussell 2000\b", r"\brut\b"],
            "primary": "yahoo",
            "yahoo": "^RUT",
        },
        {
            "id": "NASDAQ100",
            "name": "Nasdaq-100 Index",
            "unit": "Index level",
            "origin": "Nasdaq",
            "aliases": [r"\bnasdaq[- ]?100\b", r"\bndx\b"],
            "primary": "yahoo",
            "yahoo": "^NDX",
        },
        {
            "id": "GOLD_PRICE",
            "name": "Gold Price",
            "unit": "U.S. dollars per troy ounce",
            "origin": "World Bank Pink Sheet and CME COMEX via Yahoo Finance",
            "aliases": [r"\bgold price\b", r"\bprice of gold\b", r"\bgold futures\b", r"\bgold\b"],
            "primary": "yahoo",
            "yahoo": "GC=F",
            "coverageFallback": {
                "primary": "world-bank-commodity",
                "commodity": "Gold",
            },
            "requireRequestedCoverage": True,
        },
        {
            "id": "SILVER_PRICE",
            "name": "Silver Price",
            "unit": "U.S. dollars per troy ounce",
            "origin": "World Bank Pink Sheet and CME COMEX via Yahoo Finance",
            "aliases": [r"\bsilver price\b", r"\bprice of silver\b", r"\bsilver futures\b", r"\bsilver\b"],
            "primary": "yahoo",
            "yahoo": "SI=F",
            "coverageFallback": {
                "primary": "world-bank-commodity",
                "commodity": "Silver",
            },
            "requireRequestedCoverage": True,
        },
    ]
)

SERIES_CATALOG.extend(
    [
        {"id": "DGS1MO", "name": "1-Month Treasury Yield", "unit": "Percent", "aliases": [r"\b1[ -]month treasury\b", r"\b1m treasury\b", r"\bdgs1mo\b"]},
        {"id": "DGS6MO", "name": "6-Month Treasury Yield", "unit": "Percent", "aliases": [r"\b6[ -]month treasury\b", r"\b6m treasury\b", r"\bdgs6mo\b"]},
        {"id": "DGS1", "name": "1-Year Treasury Yield", "unit": "Percent", "aliases": [r"\b1[ -]year treasury\b", r"\b1y treasury\b", r"\b12[ -]month (?:treasury|yield|rate|bill)\b", r"\bdgs1\b"]},
        {"id": "DGS5", "name": "5-Year Treasury Yield", "unit": "Percent", "aliases": [r"\b5[ -]year treasury\b", r"\bdgs5\b"]},
        {"id": "DGS7", "name": "7-Year Treasury Yield", "unit": "Percent", "aliases": [r"\b7[ -]year treasury\b", r"\bdgs7\b"]},
        {"id": "DGS20", "name": "20-Year Treasury Yield", "unit": "Percent", "aliases": [r"\b20[ -]year treasury\b", r"\bdgs20\b"]},
    ]
)

for _market_entry in SERIES_CATALOG:
    if _market_entry["id"] in {"SP500", "VIXCLS", "NASDAQCOM", "DJIA"}:
        _market_entry["primary"] = "yahoo"
        _market_entry["validationFred"] = _market_entry["id"]
    _market_entry.setdefault("origin", "Source identified on the provider series page")

for _generic_entry in SERIES_CATALOG:
    if _generic_entry["id"] == "CPIAUCSL":
        _generic_entry["excludes"] = [
            r"\bcore\s+cpi\b",
            r"\bbreakeven\b",
            r"\bpce\b",
        ]
    if _generic_entry["id"] == "UNRATE":
        _generic_entry["excludes"] = [r"\bclaims?\b", r"\bu[- ]?6\b"]

TREASURY_FIELDS = {
    "DGS1MO": "BC_1MONTH",
    "DGS3MO": "BC_3MONTH",
    "DGS6MO": "BC_6MONTH",
    "DGS1": "BC_1YEAR",
    "DGS2": "BC_2YEAR",
    "DGS5": "BC_5YEAR",
    "DGS7": "BC_7YEAR",
    "DGS10": "BC_10YEAR",
    "DGS20": "BC_20YEAR",
    "DGS30": "BC_30YEAR",
}
for _treasury_entry in SERIES_CATALOG:
    if _treasury_entry["id"] in TREASURY_FIELDS:
        _treasury_entry["primary"] = "treasury"
        _treasury_entry["treasuryField"] = TREASURY_FIELDS[_treasury_entry["id"]]
        _treasury_entry["origin"] = "U.S. Department of the Treasury"
        _treasury_entry.setdefault("excludes", []).extend(
            [
                r"\bbreakeven\b",
                r"\breal\s+(?:treasury\s+)?yield\b",
                r"\bmortgage\b",
            ]
        )

CATALOG_BY_ID = {entry["id"]: entry for entry in SERIES_CATALOG}
STOP_TOKENS = {
    "AND",
    "FOR",
    "THE",
    "LAST",
    "YEARS",
    "YEAR",
    "MONTH",
    "MONTHS",
    "DAYS",
    "DAY",
    "CHART",
    "PLOT",
    "SHOW",
    "WITH",
    "RATE",
    "RATES",
    "YIELD",
    "YIELDS",
    "SP",
    "S",
}


def resolve_series(prompt: str) -> list[dict[str, Any]]:
    normalized = prompt.lower()
    clauses = [
        clause.strip()
        for clause in re.split(
            r",|;|\band\b|\bversus\b|\bvs\.?\b|\bagainst\b|\bcompared\s+(?:with|to)\b",
            normalized,
        )
        if clause.strip()
    ] or [normalized]
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(entry: dict[str, Any]):
        if entry["id"] not in seen:
            selected.append(entry)
            seen.add(entry["id"])

    # Resolve each operand to its most specific alias match. Broad aliases such as
    # "core PPI" must not add a second series when the same operand says
    # "core PPI services" or another more specific definition.
    for clause in clauses:
        candidates: list[tuple[int, int, int, dict[str, Any]]] = []
        for entry in SERIES_CATALOG:
            if any(re.search(pattern, clause) for pattern in entry.get("excludes", [])):
                continue
            matches = [
                match
                for pattern in entry["aliases"]
                if (match := re.search(pattern, clause)) is not None
            ]
            if matches:
                best_match = max(matches, key=lambda match: match.end() - match.start())
                candidates.append(
                    (
                        best_match.end() - best_match.start(),
                        best_match.start(),
                        best_match.end(),
                        entry,
                    )
                )
        selected_spans: list[tuple[int, int]] = []
        for _length, start, end, entry in sorted(candidates, key=lambda row: (-row[0], row[1])):
            if any(start < chosen_end and end > chosen_start for chosen_start, chosen_end in selected_spans):
                continue
            add(entry)
            selected_spans.append((start, end))

    # Coordinated lists often state the shared instrument only once, such as
    # "1-year, 5-year and 10-year Treasury yields".
    if re.search(r"\btreasury (?:yields?|rates?)\b", normalized) and not re.search(
        r"\b(?:real|inflation[- ]indexed|tips|breakeven)\b", normalized
    ):
        treasury_tenor_text = re.sub(
            r"\b(?:\d+|thirty)[ -](?:year|yr)\s+(?:fixed[- ]rate\s+)?mortgage(?: rate)?\b",
            "",
            normalized,
        )
        treasury_tenor_text = re.sub(r"(?<=\d)-(?=\s*,)", "", treasury_tenor_text)
        tenor_ids = {
            "1": "DGS1",
            "2": "DGS2",
            "5": "DGS5",
            "7": "DGS7",
            "10": "DGS10",
            "20": "DGS20",
            "30": "DGS30",
        }
        for tenor in re.findall(r"\b(1|2|5|7|10|20|30)(?:[ -]?(?:year|yr)|y)\b", treasury_tenor_text):
            add(CATALOG_BY_ID[tenor_ids[tenor]])
        month_tenor_ids = {"1": "DGS1MO", "3": "DGS3MO", "6": "DGS6MO", "12": "DGS1"}
        for tenor in re.findall(r"\b(1|3|6|12)(?:[ -]?(?:month|mo)|m)\b", treasury_tenor_text):
            add(CATALOG_BY_ID[month_tenor_ids[tenor]])
        shared_month_list = re.search(
            r"((?:(?:1|3|6|12)\s*[-,]\s*)+(?:and\s+)?(?:1|3|6|12))\s*[- ]month\s+treasury yields?",
            treasury_tenor_text,
        )
        if shared_month_list:
            for tenor in re.findall(r"\b(1|3|6|12)\b", shared_month_list.group(1)):
                add(CATALOG_BY_ID[month_tenor_ids[tenor]])
    treasury_spread_match = re.search(
        r"\b(1|2|5|7|10|20|30)[ -](?:year|yr)\s+minus\s+"
        r"(1|2|5|7|10|20|30)[ -](?:year|yr)(?:\s+treasury)?\s+spread\b",
        normalized,
    )
    if treasury_spread_match:
        spread_tenor_ids = {
            "1": "DGS1", "2": "DGS2", "5": "DGS5", "7": "DGS7",
            "10": "DGS10", "20": "DGS20", "30": "DGS30",
        }
        add(CATALOG_BY_ID[spread_tenor_ids[treasury_spread_match.group(1)]])
        add(CATALOG_BY_ID[spread_tenor_ids[treasury_spread_match.group(2)]])
    if re.search(r"\bbreakeven(?: inflation)?\b", normalized):
        # Match the tenor as part of the breakeven phrase. A separate
        # Treasury-yield tenor elsewhere in the request must not add the
        # corresponding breakeven series as a side effect.
        for tenor, series_id in (("5", "T5YIE"), ("10", "T10YIE")):
            if re.search(rf"\b{tenor}[ -]year\s+breakeven(?: inflation)?\b", normalized):
                add(CATALOG_BY_ID[series_id])
    if re.search(
        r"\b(?:core\s+(?:and|&)\s+headline|headline\s+(?:and|&)\s+core)\s+cpi\b",
        normalized,
    ):
        add(CATALOG_BY_ID["CPILFESL"])
        add(CATALOG_BY_ID["CPIAUCSL"])
    if re.search(
        r"\b(?:core\s+(?:and|&)\s+headline|headline\s+(?:and|&)\s+core)\s+pce\b",
        normalized,
    ):
        add(CATALOG_BY_ID["PCEPILFE"])
        add(CATALOG_BY_ID["PCEPI"])
    if re.search(
        r"\b(?:real\s+(?:and|&)\s+nominal|nominal\s+(?:and|&)\s+real)\s+retail sales\b",
        normalized,
    ):
        add(CATALOG_BY_ID["RRSFS"])
        add(CATALOG_BY_ID["RSAFS"])
    if re.search(
        r"\b10[- ]year real (?:treasury )?yield\s+(?:and|&)\s+(?:the )?nominal yield\b",
        normalized,
    ):
        add(CATALOG_BY_ID["DFII10"])
        add(CATALOG_BY_ID["DGS10"])
    if "DFII10" in seen and re.search(r"\b(?:the )?nominal (?:treasury )?yield\b", normalized):
        add(CATALOG_BY_ID["DGS10"])
    if re.search(r"\binitial\s+(?:and|&)\s+continu(?:ed|ing)(?: jobless| unemployment)? claims\b", normalized):
        add(CATALOG_BY_ID["ICSA"])
        add(CATALOG_BY_ID["CCSA"])
    if re.search(r"\b(?:effr|fed(?:eral)? funds|target)\b", normalized) and re.search(
        r"\b(?:upper\s*(?:and|/)\s*lower|lower\s*(?:and|/)\s*upper)(?:\s+(?:target )?bounds?)?\b",
        normalized,
    ):
        add(CATALOG_BY_ID["DFEDTARU"])
        add(CATALOG_BY_ID["DFEDTARL"])

    if {"WPSFD413", "WPSFD49113"}.issubset(seen):
        selected = [entry for entry in selected if entry["id"] != "WPSFD49116"]
        seen.discard("WPSFD49116")

    component_cpi_ids = {"CPI_SHELTER", "CPI_OER", "CPI_MEDICAL", "CPI_FOOD", "CPI_ENERGY"}
    explicit_headline_cpi = bool(re.search(r"\b(?:headline|all items|overall) cpi\b", normalized))
    if not explicit_headline_cpi and any(entry["id"] in component_cpi_ids for entry in selected):
        selected = [entry for entry in selected if entry["id"] != "CPIAUCSL"]
        seen.discard("CPIAUCSL")

    for token in re.findall(r"\b[A-Z][A-Z0-9]{1,14}\b", prompt):
        if token in STOP_TOKENS:
            continue
        if token in CATALOG_BY_ID:
            entry = CATALOG_BY_ID[token]
            if not any(re.search(pattern, normalized) for pattern in entry.get("excludes", [])):
                add(entry)

    explicit_symbols = re.findall(r"(?<!\w)(?:\$([A-Za-z][A-Za-z0-9.-]{0,9})|(\^[A-Za-z0-9.-]{1,9}))", prompt)
    for dollar_symbol, index_symbol in explicit_symbols:
        symbol = (dollar_symbol or index_symbol).upper()
        if any(str(entry.get("yahoo") or "").upper() == symbol for entry in selected):
            continue
        identity = f"YAHOO:{symbol}"
        if identity in seen:
            continue
        selected.append(
            {
                "id": identity,
                "name": symbol,
                "unit": "Market price",
                "origin": "Exchange/vendor market data",
                "primary": "yahoo",
                "yahoo": symbol,
                "aliases": [],
                "resolution": "explicit market symbol",
            }
        )
        seen.add(identity)

    treasury_mentions = {
        "DGS1MO": (r"\b1(?:[ -]?(?:month|mo)|m)\b",),
        "DGS3MO": (r"\b3(?:[ -]?(?:month|mo)|m)\b",),
        "DGS6MO": (r"\b6(?:[ -]?(?:month|mo)|m)\b",),
        "DGS1": (r"\b12[ -]?month\b", r"\b1(?:[ -]?(?:year|yr)|y)\b"),
        "DGS2": (r"\b2(?:[ -]?(?:year|yr)|y)\b",),
        "DGS5": (r"\b5(?:[ -]?(?:year|yr)|y)\b",),
        "DGS7": (r"\b7(?:[ -]?(?:year|yr)|y)\b",),
        "DGS10": (r"\b10(?:[ -]?(?:year|yr)|y)\b",),
        "DGS20": (r"\b20(?:[ -]?(?:year|yr)|y)\b",),
        "DGS30": (r"\b30(?:[ -]?(?:year|yr)|y)\b",),
    }

    def source_position(entry: dict[str, Any], fallback_index: int) -> tuple[int, int]:
        positions: list[int] = []
        for pattern in entry.get("aliases", []):
            if match := re.search(pattern, normalized):
                positions.append(match.start())
        for pattern in treasury_mentions.get(str(entry.get("id")), ()):
            if match := re.search(pattern, normalized):
                positions.append(match.start())
        yahoo_symbol = str(entry.get("yahoo") or "").lstrip("^").lower()
        if yahoo_symbol and (match := re.search(rf"(?<![a-z0-9])\^?{re.escape(yahoo_symbol)}\b", normalized)):
            positions.append(match.start())
        return (min(positions) if positions else len(normalized) + fallback_index, fallback_index)

    selected = [
        entry
        for _position, entry in sorted(
            (source_position(entry, index), entry)
            for index, entry in enumerate(selected)
        )
    ]
    return selected


def fred_api_search(search_text: str, limit: int = 5) -> list[dict[str, Any]]:
    api_key = get_secret("fredApiKey", "FRED_API_KEY")
    if not api_key:
        return []
    payload = http_get_json(
        "https://api.stlouisfed.org/fred/series/search",
        params={
            "api_key": api_key,
            "file_type": "json",
            "search_text": search_text,
            "search_type": "full_text",
            "order_by": "search_rank",
            "limit": max(1, min(limit, 25)),
        },
        cache_enabled=False,
        allow_stale=False,
    )
    rows = payload.get("seriess") or []
    return [row for row in rows if "discontinued" not in str(row.get("title", "")).lower()]


FRED_SEARCH_STOP_WORDS = {
    "a",
    "an",
    "and",
    "data",
    "for",
    "index",
    "of",
    "rate",
    "series",
    "the",
}


def _canonical_search_token(token: str) -> str:
    if token in {"rental", "rentals", "rents"}:
        return "rent"
    if token.endswith("ies") and len(token) > 4:
        return token[:-3] + "y"
    if token.endswith("s") and not token.endswith("ss") and len(token) > 3:
        return token[:-1]
    return token


def _fred_search_terms(text: str) -> set[str]:
    normalized = re.sub(r"\bu\.?s\.?\b|\bunited states\b", "national", text.lower())
    return {
        _canonical_search_token(token)
        for token in re.findall(r"[a-z0-9]+", normalized)
        if token not in FRED_SEARCH_STOP_WORDS and len(token) > 1
    }


def credible_fred_search_match(search_text: str, row: dict[str, Any]) -> bool:
    """Reject FRED candidates that do not satisfy title and metadata dimensions."""
    requested = _fred_search_terms(search_text)
    title_terms = _fred_search_terms(str(row.get("title") or ""))
    if not requested or not requested.issubset(title_terms):
        return False
    text = search_text.lower()
    units = str(row.get("units") or "").lower()
    frequency = str(row.get("frequency") or "").lower()
    seasonal = str(
        row.get("seasonal_adjustment")
        or row.get("seasonalAdjustment")
        or row.get("seasonal_adjustment_short")
        or ""
    ).lower()
    requested_frequencies = {
        "daily": r"\bdaily\b",
        "weekly": r"\bweekly\b",
        "monthly": r"\bmonthly\b",
        "quarterly": r"\bquarterly\b",
        "annual": r"\b(?:annual|yearly)\b",
    }
    for expected, pattern in requested_frequencies.items():
        if re.search(pattern, text) and expected not in frequency:
            return False
    if re.search(r"\b(?:not seasonally adjusted|unadjusted)\b", text):
        if seasonal and not re.search(r"not seasonally adjusted|unadjusted", seasonal):
            return False
    elif re.search(r"\bseasonally adjusted\b", text):
        if seasonal and "seasonally adjusted" not in seasonal:
            return False
    if re.search(r"\brate\b|\bpercent(?:age)?\b", text) and units:
        if not re.search(r"percent|percentage|rate", units):
            return False
    if re.search(r"\b(?:dollars?|usd|balance|amount)\b", text) and units:
        if not re.search(r"dollar|usd|currency", units):
            return False
    return True


def _search_clauses(prompt: str) -> list[str]:
    parsed_contract = intent_contract.parse_macro_contract(prompt)
    cleaned = macro_providers.normalize_quantitative_phrasing(
        str(parsed_contract.get("resolutionText") or prompt)
    )
    cleaned, _corrections = intent_contract.normalize_known_typos(cleaned)
    cleaned = intent_contract.strip_meta_prefix(cleaned)
    cleaned = re.sub(
        r"^\s*(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?"
        r"(?:show|display|graph|plot|chart|compare|give)\s+(?:me\s+)?",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"\s+(?:on|in|as)\s+(?:a\s+)?(?:chart|graph|plot|table)\s*$",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"(?<=\d),(?=\d{3}\b)", "", cleaned)
    cleaned = re.sub(
        r"[^,]*(?:may|can|could)\s+be\s+used\s+as\s+(?:a\s+)?(?:substitute|proxy)\s+for\s+[^,]*",
        "",
        cleaned,
    )
    cleaned = re.sub(
        r"(?:please\s+)?(?:put|place|show|plot)\s+[^,.]*(?:axis|axes|side)[^,.]*",
        "",
        cleaned,
    )
    cleaned = re.sub(r"\busing\s+(?:a\s+)?separate\s+axes?\b", "", cleaned)
    cleaned = re.sub(
        r"\b(?:for|over|during|across|past|previous|trailing)\s+(?:the\s+)?"
        r"(?:(?:last|preceding)\s+)?"
        r"\d+[\s-]*(?:years?|yrs?|months?|mos?|quarters?|decades?|weeks?|days?)\b",
        "",
        cleaned,
    )
    cleaned = re.sub(r"\b(?:from|between)\s+(?:19|20)\d{2}\s+(?:to|and|through)\s+(?:19|20)\d{2}\b", "", cleaned)
    cleaned = re.sub(r"\bsince\s+(?:19|20)\d{2}\b|\b(?:year[ -]to[ -]date|ytd)\b", "", cleaned)
    cleaned = re.sub(
        r"\s+(?:on|in|as)\s+(?:a\s+)?(?:chart|graph|plot|table)\s*$",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    protected_and = "__macro_protected_and__"
    protected_with = "__macro_protected_with__"
    cleaned = re.sub(
        r"\bcorporate profits\s+with\s+inventory valuation\s+and\s+capital consumption adjustments\b",
        lambda match: re.sub(
            r"\bwith\b",
            protected_with,
            re.sub(r"\band\b", protected_and, match.group(0)),
        ),
        cleaned,
    )
    cleaned = re.sub(
        r"\b(?:excluding|without|less)\s+[^,.;]{1,120}?"
        r"(?=\s+(?:over|for)\s+(?:the\s+)?(?:last\s+)?\d+(?:\.\d+)?\s+years?\b|"
        r"\s+(?:versus|vs|against)\b|[,.;]|$)",
        lambda match: re.sub(r"\band\b", protected_and, match.group(0)),
        cleaned,
    )
    provider_aliases = [
        *[pattern for entry in SERIES_CATALOG for pattern in entry.get("aliases", [])],
        *[pattern for row in macro_providers.WORLD_BANK_SERIES for pattern in row.get("aliases", [])],
        *[pattern for metric in macro_providers.SEC_METRICS for pattern in metric.get("aliases", [])],
    ]
    for pattern in provider_aliases:
        cleaned = re.sub(
            pattern,
            lambda match: re.sub(r"\band\b", protected_and, match.group(0)),
            cleaned,
        )
    protected_patterns = (
        r"\bbetween\s+[^,.;]{1,45}\s+and\s+[^,.;]{1,45}",
        r"\b\d+(?:st|nd|rd|th)?\s+and\s+\d+(?:st|nd|rd|th)?\s+percentiles?\b",
        r"\bage\s+(?:under\s+|over\s+)?\d+(?:\s*[-+]\s*\d+)?\s+and\s+(?:under\s+|over\s+)?\d+(?:\s*[-+]\s*\d+|\+)?",
        r"\b[qd]\d+\s+and\s+[qd]\d+\b",
        r"\burban wage earners\s+and\s+clerical workers\b",
        r"\binventory valuation\s+and\s+capital consumption adjustments\b",
    )
    for pattern in protected_patterns:
        cleaned = re.sub(
            pattern,
            lambda match: re.sub(r"\band\b", protected_and, match.group(0)),
            cleaned,
        )
    cleaned = re.sub(
        r"\b(?:compared\s+(?:with|to)|chart|plot|graph|show|compare|versus|vs\.?|against|with)\b",
        ",",
        cleaned,
    )
    clauses = re.split(r",|\band\b", cleaned)
    output: list[str] = []
    for clause in clauses:
        clause = clause.replace(protected_and, "and").replace(protected_with, "with")
        clause = re.sub(r"\s+", " ", clause).strip(" .:-")
        if len(clause) >= 3:
            output.append(clause)
    return output


def unresolved_clause_residual(clause: str) -> str:
    presentation_cleaned, _presentation = intent_contract.extract_presentation(clause)
    residual = macro_providers.normalize_quantitative_phrasing(presentation_cleaned)
    patterns = [pattern for entry in SERIES_CATALOG for pattern in entry.get("aliases", [])]
    # Regex source length does not reliably indicate phrase specificity. Repeatedly remove
    # the longest text span that actually matched so overlapping aliases leave no fragments.
    while True:
        matches = [
            match
            for pattern in patterns
            if (match := re.search(pattern, residual)) is not None
        ]
        if not matches:
            break
        match = max(matches, key=lambda item: (item.end() - item.start(), -item.start()))
        residual = f"{residual[:match.start()]} {residual[match.end():]}"
    residual = re.sub(
        r"\b(?:year[ -]over[ -]year|yoy|month[ -]over[ -]month|mom)\b|"
        r"\bpercent(?:age)? change(?: from (?:a )?year ago)?\b",
        " ",
        residual,
    )
    residual = re.sub(r"(?<!\w)(?:\$[a-z][a-z0-9.-]{0,9}|\^[a-z0-9.-]{1,9})", " ", residual)
    residual = re.sub(r"\b(?:fred\s+(?:series|id)|series)\s+[a-z][a-z0-9]{1,24}\b", " ", residual)
    residual = re.sub(
        r"\b(?:chart|plot|graph|show|build|create|make|display|give|please|macro|comparing|"
        r"compare|versus|vs|with|using|and|divided\s+by|over|ratio|"
        r"multiplied\s+by|times|plus|minus|against|for|the|a|an|of|data|series|index|level|"
        r"rate|rates|yield|yields|treasury|market|spread|first|second|left|right|axis|axes|"
        r"scale|scales|same|separate|secondary|opposite|native|values)\b",
        " ",
        residual,
    )
    # Keep decimals and percent signs: they can define a population group, threshold,
    # or unit. Turning "top 10%" into "top 10" changes the requested concept.
    return re.sub(r"[^a-z0-9.%+$-]+", " ", residual).strip()


def filter_satisfied_macro_residuals(
    residuals: list[str],
    selected: list[dict[str, Any]],
) -> list[str]:
    """Drop only modifiers whose requested series are already explicitly present."""
    ids = {entry.get("id") for entry in selected}
    output: list[str] = []
    for residual in residuals:
        normalized = re.sub(r"[^a-z0-9]+", " ", residual.lower()).strip()
        normalized = re.sub(r"\b(\d+)\s*(?:yrs?|years?)\b", r"\1 year", normalized)
        normalized = re.sub(r"\b(\d+)\s*(?:mos?|months?)\b", r"\1 month", normalized)
        tenor_residual_ids = {
            "1 month": "DGS1MO",
            "3 month": "DGS3MO",
            "6 month": "DGS6MO",
            "12 month": "DGS1",
            "1 year": "DGS1",
            "2 year": "DGS2",
            "5 year": "DGS5",
            "7 year": "DGS7",
            "10 year": "DGS10",
            "20 year": "DGS20",
            "30 year": "DGS30",
        }
        # U.S. is a scope qualifier, not a third data concept. Reconcile it only
        # when the already-selected series is an official U.S. Treasury tenor.
        us_treasury_residual = normalized
        if ids & set(TREASURY_FIELDS):
            us_treasury_residual = re.sub(
                r"\b(?:u\s+s|us|united states|american)\b",
                " ",
                us_treasury_residual,
            )
            us_treasury_residual = re.sub(r"\s+", " ", us_treasury_residual).strip()
        satisfied = (
            (normalized == "headline" and bool(ids & {"CPIAUCSL", "PCEPI", "WPSFD4"}))
            or (normalized == "funds" and bool(ids & {"EFFR", "DFF", "FEDFUNDS"}))
            or (normalized in {"lower bound", "lower bounds"} and "DFEDTARL" in ids)
            or (
                normalized == "nominal"
                and (
                    {"RRSFS", "RSAFS"}.issubset(ids)
                    or {"DFII10", "DGS10"}.issubset(ids)
                    or {"GDPC1", "GDP"}.issubset(ids)
                )
            )
            or (normalized == "real" and any(str(series_id).startswith("DFII") for series_id in ids))
            or (
                normalized == "breakeven"
                and bool(ids & {"T5YIE", "T10YIE"})
            )
            or (
                normalized in {"price", "prices"}
                and any(entry.get("primary") == "yahoo" for entry in selected)
            )
            or (
                (
                    not us_treasury_residual
                    or us_treasury_residual in tenor_residual_ids
                )
                and (
                    not us_treasury_residual
                    or tenor_residual_ids[us_treasury_residual] in ids
                )
                and bool(ids & set(TREASURY_FIELDS))
            )
        )
        if not satisfied:
            output.append(residual)
    return output


MACRO_SEMANTIC_FAMILY_PATTERNS = {
    "wealth": r"\b(?:wealth|net worth|assets?|liabilities?)\b",
    "prices": r"\b(?:cpi|ppi|inflation|deflator|price(?:s| index)?|cost of living)\b",
    "labor": r"\b(?:labor|employment|unemployment|jobless(?:ness)?|payrolls?|jobs?|hires?|quits?)\b",
    "wages": r"\b(?:wages?|salary|salaries|hourly earnings|pay growth)\b",
    "output": r"\b(?:gdp|gross domestic product|economic output|business investment|consumption)\b",
    "rates": r"\b(?:interest|yield|treasury|fed(?:eral)? funds|sofr|basis points?|bps|mortgage rate)\b",
    "markets": r"\b(?:s&p|sp500|nasdaq|dow jones|vix|stock market|equity market|equity index)\b",
    "market_size": r"\b(?:market cap|market capitalization|market capitalisation)\b",
    "debt": r"\b(?:debt|debt securities|credit[- ]market debt|bond market|fixed income market)\b",
    "housing": r"\b(?:housing|home prices?|rent|rental|mortgage|real estate)\b",
    "commodities": r"\b(?:oil|gas|gasoline|gold|silver|copper|commodity|commodities)\b",
    "money": r"\b(?:money supply|\bm1\b|\bm2\b|fed balance sheet|reverse repo)\b",
    "income": r"\b(?:income|earnings|profits?|saving rate)\b",
    "population": r"\b(?:population|households?|people|demographic)\b",
    "trade": r"\b(?:exports?|imports?|current account|trade balance)\b",
}


def macro_semantic_families(text: str) -> set[str]:
    normalized = macro_providers.normalize_quantitative_phrasing(text)
    return {
        family
        for family, pattern in MACRO_SEMANTIC_FAMILY_PATTERNS.items()
        if re.search(pattern, normalized)
    }


MACRO_CONCEPT_STOP_WORDS = {
    "a", "an", "and", "annual", "chart", "compare", "data", "for", "gauge", "household",
    "households", "index", "level", "market", "of", "over", "rate", "series", "show",
    "the", "total", "versus", "with", "year", "years", "yr", "yrs", "mo", "mos",
}
MACRO_GENERIC_FAMILY_WORDS = {
    "housing", "home", "income", "labor", "population", "price", "prices", "wealth",
}
MACRO_CONCEPT_SYNONYMS = {
    "jobless": "unemployment",
    "slackness": "unemployment",
    "equities": "equity",
    "stocks": "equity",
    "treasuries": "treasury",
    "salaries": "wage",
    "salary": "wage",
    "wages": "wage",
}


def macro_concept_terms(text: str) -> set[str]:
    concept_text, _notices = normalize_macro_concept_phrasing(text)
    normalized = macro_providers.normalize_quantitative_phrasing(concept_text)
    normalized = re.sub(r"\bgross domestic product\b", " gdp ", normalized)
    normalized = re.sub(r"\bconsumer price index\b", " cpi ", normalized)
    terms = {
        MACRO_CONCEPT_SYNONYMS.get(token, token.rstrip("s"))
        for token in re.findall(r"[a-z][a-z0-9]+", normalized)
        if token not in MACRO_CONCEPT_STOP_WORDS
        and token not in MACRO_GENERIC_FAMILY_WORDS
        and not token.isdigit()
    }
    return {term for term in terms if len(term) > 1}


def protected_macro_quantitative_qualifiers(source: str) -> list[dict[str, Any]]:
    source_normalized = macro_providers.normalize_quantitative_phrasing(source)
    protected = [
        row
        for row in macro_providers.extract_quantitative_qualifiers(source_normalized)
        if row["kind"] in {"population_percentile", "rank_count", "basis_points", "percent", "duration"}
    ]
    if re.search(
        r"\b(?:percentile|decile|quartile|quintile|bottom half|upper fifth|lower fifth|upper tenth|lower tenth)\b",
        source_normalized,
    ):
        protected.append({"kind": "distribution_group", "raw": "distribution group"})
    if re.search(r"\b(?:top|bottom|upper|lower)\s+\d+(?:\.\d+)?\b(?!\s*(?:year|month|day))", source_normalized):
        protected.append({"kind": "rank_or_percentile", "raw": "ranked group"})
    for match in re.finditer(
        r"\b(?:above|below|over|under|exceeds?|greater than|less than|at least|at most|"
        r"rises? by|increases? by|falls? by|decreases? by|changes? by)\s+"
        r"\d+(?:\.\d+)?(?:\s*%|\s+basis points?|\s+bps?)?\b",
        source_normalized,
    ):
        protected.append({"kind": "numeric_condition", "raw": match.group(0)})
    for match in re.finditer(
        r"\b(?:excluding|without|all but|cutoff|threshold|minimum|required|delinquen(?:t|cy)|"
        r"small businesses?|large businesses?|women|men|female|male|largest|smallest|fastest|slowest)\b|"
        r"\bage\s+(?:under\s+|over\s+)?\d+",
        source_normalized,
    ):
        protected.append({"kind": "semantic_modifier", "raw": match.group(0)})
    for match in re.finditer(
        r"\b(?:\d+\s+(?:largest|smallest|fastest|slowest)|(?:largest|smallest|fastest|slowest)\s+\d+)\b",
        source_normalized,
    ):
        protected.append({"kind": "ranked_modifier", "raw": match.group(0)})
    return protected


def macro_protected_signature(source: str) -> set[tuple[Any, ...]]:
    """Return normalized semantic constraints that a model rewrite must preserve exactly."""
    normalized = macro_providers.normalize_quantitative_phrasing(source)
    signature: set[tuple[Any, ...]] = set()

    for selector in macro_providers.extract_population_selectors(normalized):
        signature.add(
            (
                "population_interval",
                float(selector.get("lower", 0.0)),
                float(selector.get("upper", 0.0)),
            )
        )

    for qualifier in macro_providers.extract_quantitative_qualifiers(normalized):
        kind = str(qualifier.get("kind") or "")
        if kind == "population_percentile":
            continue
        if kind == "duration":
            unit = str(qualifier.get("duration") or "").rstrip("s")
            signature.add(("duration", float(qualifier["value"]), unit))
        elif kind == "rank_count":
            unit = str(qualifier.get("count_unit") or "").rstrip("s")
            signature.add(
                (
                    "rank_count",
                    str(qualifier.get("direction") or ""),
                    float(qualifier["value"]),
                    unit,
                )
            )
        elif kind in {"percent", "basis_points"}:
            unit = "percent" if kind == "percent" else "basis_points"
            signature.add(("quantity", float(qualifier["value"]), unit))

    comparison_terms = {
        "above": "gt",
        "over": "gt",
        "exceed": "gt",
        "exceeds": "gt",
        "greater than": "gt",
        "below": "lt",
        "under": "lt",
        "less than": "lt",
        "at least": "gte",
        "at most": "lte",
        "rise by": "increase_by",
        "rises by": "increase_by",
        "increase by": "increase_by",
        "increases by": "increase_by",
        "fall by": "decrease_by",
        "falls by": "decrease_by",
        "decrease by": "decrease_by",
        "decreases by": "decrease_by",
        "change by": "change_by",
        "changes by": "change_by",
    }
    condition_pattern = (
        r"\b(above|below|over|under|exceed|exceeds|greater than|less than|at least|at most|"
        r"rise by|rises by|increase by|increases by|fall by|falls by|decrease by|decreases by|"
        r"change by|changes by)\s+(\d+(?:\.\d+)?)\s*(%|basis points?|bps?)?\b"
    )
    for match in re.finditer(condition_pattern, normalized):
        raw_unit = str(match.group(3) or "value")
        unit = "basis_points" if raw_unit.startswith(("basis", "bp")) else (
            "percent" if raw_unit == "%" else "value"
        )
        signature.add(
            (
                "condition",
                comparison_terms[match.group(1)],
                float(match.group(2)),
                unit,
            )
        )

    measure_patterns = {
        "cutoff": r"\b(?:cutoff|threshold|minimum|required)\b",
        "mean": r"\b(?:mean|average)\b",
        "median": r"\bmedian\b",
        "aggregate": r"\baggregate\b",
        "share": r"\b(?:share|percentage)\s+(?:of|held|owned|controlled)\b|\bshares\b",
        "per_household": r"\bper household\b",
        "count": r"\b(?:household|company|stock|item|result) count\b",
    }
    for measure, pattern in measure_patterns.items():
        if re.search(pattern, normalized):
            signature.add(("measure", measure))

    modifier_patterns = {
        "exclude": r"\b(?:excluding|without|all but)\b",
        "core": r"\bcore\b",
        "headline": r"\bheadline\b",
        "real": r"\breal\b",
        "nominal": r"\bnominal\b",
        "annualized": r"\bannualized\b",
        "seasonally_adjusted": r"\bseasonally adjusted\b",
        "not_seasonally_adjusted": r"\b(?:not seasonally adjusted|unadjusted)\b",
        "final_demand": r"\bfinal demand\b",
        "goods": r"\bgoods\b",
        "services": r"\bservices\b",
        "operating_earnings": r"\boperating (?:earnings|eps)\b",
        "reported_earnings": r"\breported (?:earnings|eps)\b",
        "upper_bound": r"\bupper (?:target )?bound\b",
        "lower_bound": r"\blower (?:target )?bound\b",
        "women": r"\b(?:women|woman|female)\b",
        "men": r"\b(?:men|man|male)\b",
        "small_business": r"\bsmall businesses?\b",
        "large_business": r"\blarge businesses?\b",
        "delinquency": r"\bdelinquen(?:t|cy)\b",
        "largest": r"\blargest\b",
        "smallest": r"\bsmallest\b",
        "fastest": r"\bfastest\b",
        "slowest": r"\bslowest\b",
    }
    for modifier, pattern in modifier_patterns.items():
        if re.search(pattern, normalized):
            signature.add(("modifier", modifier))
    for match in re.finditer(
        r"\b(?:excluding|without|all but)\s+([^,.;]+?)(?=\s+(?:versus|vs|against|over the last|for the last)\b|$)",
        normalized,
    ):
        excluded = re.sub(r"\b(?:and|or|the|a|an|sector|sectors|category|categories)\b", " ", match.group(1))
        for term in re.findall(r"[a-z][a-z0-9-]+", excluded):
            signature.add(("excluded_term", term))
    for match in re.finditer(
        r"\bage\s+(under|over)?\s*(\d+)(?:\s*[-+]\s*(\d+))?",
        normalized,
    ):
        signature.add(
            (
                "age_band",
                str(match.group(1) or "between"),
                float(match.group(2)),
                float(match.group(3)) if match.group(3) else None,
            )
        )
    return signature


def parse_macro_request_contract(prompt: str) -> dict[str, Any]:
    """Build one typed trace for operands, selectors, conditions, and time language."""
    text = macro_providers.normalize_quantitative_phrasing(prompt)
    contract = intent_contract.parse_macro_contract(prompt)
    operation = contract["operation"]
    if re.search(r"\b(?:divide|divided by|ratio)\b", text):
        operation = "derive"
    operands: list[dict[str, Any]] = []
    for operand in contract["operands"]:
        clause = macro_providers.normalize_quantitative_phrasing(operand["sourceSpan"])
        qualifiers = macro_providers.extract_quantitative_qualifiers(clause)
        rank_counts = [row for row in qualifiers if row["kind"] == "rank_count"]
        conditions = [
            row
            for row in protected_macro_quantitative_qualifiers(clause)
            if row["kind"] in {"percent", "basis_points", "numeric_condition"}
        ]
        operands.append(
            {
                "sourceSpan": clause,
                "normalizedSpan": clause,
                "semanticFamilies": sorted(macro_semantic_families(clause)),
                "selectors": [
                    *macro_providers.extract_population_selectors(clause),
                    *[
                        {
                            "kind": "rank_count",
                            "direction": row.get("direction"),
                            "value": row.get("value"),
                            "unit": row.get("count_unit"),
                            "sourceSpan": row.get("raw"),
                        }
                        for row in rank_counts
                    ],
                ],
                "conditions": conditions,
            }
        )
    duration_rows = [
        row
        for row in macro_providers.extract_quantitative_qualifiers(text)
        if row["kind"] == "duration"
    ]
    return {
        "rawPrompt": prompt,
        "normalizedPrompt": contract["normalizedPrompt"],
        "operation": operation,
        "conceptText": contract.get("conceptText", ""),
        "resolutionText": contract.get("resolutionText", contract.get("conceptText", "")),
        "operands": operands,
        "time": {
            "qualifiers": duration_rows,
            "sourceSpan": duration_rows[0]["raw"] if duration_rows else None,
            "sourceSpans": contract["time"]["sourceSpans"],
        },
        "presentation": contract["presentation"],
        "normalization": contract["normalization"],
    }


def macro_model_mapping_is_safe(source: str, canonical: str) -> tuple[bool, str]:
    """Require a model rewrite to preserve both concept family and protected qualifiers."""
    source_concept, _source_notices = normalize_macro_concept_phrasing(source)
    canonical_concept, _canonical_notices = normalize_macro_concept_phrasing(canonical)
    source_normalized = macro_providers.normalize_quantitative_phrasing(source_concept)
    canonical_normalized = macro_providers.normalize_quantitative_phrasing(canonical_concept)
    source_families = macro_semantic_families(source_normalized)
    canonical_families = macro_semantic_families(canonical_normalized)
    if not source_families:
        return False, "source concept family was not recognized deterministically"
    if source_families != canonical_families:
        return False, (
            "concept family changed, was added, or was dropped from "
            f"{', '.join(sorted(source_families))} to {', '.join(sorted(canonical_families)) or 'unknown'}"
        )

    source_terms = macro_concept_terms(source_normalized)
    canonical_terms = macro_concept_terms(canonical_normalized)
    if source_terms and not source_terms.issubset(canonical_terms):
        return False, (
            "specific concept terms changed or were dropped from "
            f"{', '.join(sorted(source_terms))} to {', '.join(sorted(canonical_terms))}"
        )

    source_signature = macro_protected_signature(source_normalized)
    canonical_signature = macro_protected_signature(canonical_normalized)
    missing_signature = source_signature - canonical_signature
    if missing_signature:
        ordered_missing = sorted(missing_signature, key=repr)
        return False, f"protected semantic constraints changed or were dropped ({ordered_missing!r})"
    added_signature = canonical_signature - source_signature
    if added_signature:
        ordered_added = sorted(added_signature, key=repr)
        return False, f"protected semantic constraints were invented ({ordered_added!r})"
    return True, ""


def validate_macro_model_mappings(
    source_concepts: list[str],
    canonical_queries: list[str],
) -> tuple[list[str], list[str], list[str]]:
    accepted: list[str] = []
    covered: set[int] = set()
    rejected: list[str] = []
    for query in canonical_queries:
        matched_indexes: list[int] = []
        reasons: list[str] = []
        for index, concept in enumerate(source_concepts):
            safe, reason = macro_model_mapping_is_safe(concept, query)
            if safe:
                matched_indexes.append(index)
            elif reason:
                reasons.append(reason)
        unmatched_indexes = [index for index in matched_indexes if index not in covered]
        if len(unmatched_indexes) == 1:
            accepted.append(query)
            covered.add(unmatched_indexes[0])
        elif len(unmatched_indexes) > 1:
            normalized_query = macro_providers.normalize_quantitative_phrasing(query)
            exact_indexes = [
                index
                for index in unmatched_indexes
                if macro_providers.normalize_quantitative_phrasing(source_concepts[index])
                == normalized_query
            ]
            if len(exact_indexes) == 1:
                accepted.append(query)
                covered.add(exact_indexes[0])
            else:
                rejected.append(
                    f"Rejected model rewrite '{query}': it ambiguously matched multiple requested operands."
                )
        else:
            reason = reasons[0] if reasons else "no requested operand was preserved"
            rejected.append(f"Rejected model rewrite '{query}': {reason}.")
    unresolved = [
        concept for index, concept in enumerate(source_concepts) if index not in covered
    ]
    return list(dict.fromkeys(accepted)), unresolved, rejected


def normalize_macro_concept_phrasing(prompt: str) -> tuple[str, list[str]]:
    normalized, typo_corrections = intent_contract.normalize_known_typos(prompt)
    notices = [
        f"Normalized '{row['source']}' to '{row['target']}' before concept resolution."
        for row in typo_corrections
    ]
    before_treasury_normalization = normalized
    normalized = re.sub(
        r"\b(\d+)\s*(?:yr|yrs|year|years)\b(?=\s+(?:(?:u\.?s\.?|united states|american)\s+)?treasury\b)",
        r"\1-year",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\b(?:u\.?s\.?|united states|american)\s+(\d+)\s*(?:yr|yrs|year|years)\b(?=\s+treasury\b)",
        r"\1-year",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\b(\d+-year)\s+(?:u\.?s\.?|united states|american)\s+(?=treasury\b)",
        r"\1 ",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\b(?:u\.?s\.?|united states|american)\s+(?=(?:\d+-year\s+)?treasury\b)",
        "",
        normalized,
        flags=re.IGNORECASE,
    )
    if normalized != before_treasury_normalization:
        notices.append(
            "Normalized an explicit U.S. Treasury tenor phrase without changing its scope."
        )
    concept = (
        r"\b(?:consumer price(?: index)?|cpi|inflation|"
        r"price(?:[- ]pressure)?(?:\s+(?:gauge|measure|index))?)\b"
    )
    verb = r"\b(?:exclude|excludes|excluding|without|omit|omits|omitting)\b"
    food = r"\b(?:food|grocer(?:y|ies))\b"
    energy = r"\b(?:energy|gasoline|gas)\b"
    patterns = (
        rf"{concept}[^,.;]{{0,80}}?{verb}[^,.;]{{0,50}}?{food}\s*(?:and|&)\s*{energy}",
        rf"{concept}[^,.;]{{0,80}}?{verb}[^,.;]{{0,50}}?{energy}\s*(?:and|&)\s*{food}",
    )
    before_core_normalization = normalized
    for pattern in patterns:
        normalized = re.sub(pattern, "core CPI", normalized, flags=re.IGNORECASE)
    if normalized != before_core_normalization:
        notices.append(
            "Inflation excluding food/groceries and energy/gasoline was normalized to core CPI; "
            "the excluded operands were not requested as separate series."
        )
    ppi_pattern = (
        r"\bcore\s+(?:ppi|producer price index)\s+"
        r"(?:final\s+)?(?:goods?\s+(?:and|&)\s+services?|goods?\s+services?)\b"
    )
    ppi_normalized = re.sub(
        ppi_pattern,
        "core PPI final demand",
        normalized,
        flags=re.IGNORECASE,
    )
    if ppi_normalized != normalized:
        notices.append(
            "Core PPI covering final goods and services was normalized to BLS core final demand; "
            "the word 'services' was kept inside the producer-price concept."
        )
        normalized = ppi_normalized
    normalized = re.sub(
        r"\binitial\s+(?:and|&)\s+continu(?:ed|ing)(?: jobless| unemployment)? claims\b",
        "initial claims and continuing claims",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\b(?:target )?upper\s*/\s*lower(?:\s+(?:target )?bounds?)?\b",
        "fed target upper and fed target lower",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\b(?:target )?lower\s*/\s*upper(?:\s+(?:target )?bounds?)?\b",
        "fed target lower and fed target upper",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\breal\s+(?:and|&)\s+nominal\s+retail sales\b",
        "real retail sales and retail sales",
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r"\bnominal\s+(?:and|&)\s+real\s+retail sales\b",
        "retail sales and real retail sales",
        normalized,
        flags=re.IGNORECASE,
    )
    return normalized, notices


def resolve_prompt_series(
    prompt: str,
    *,
    allow_fred_search: bool = True,
) -> tuple[list[dict[str, Any]], list[str]]:
    request_contract = intent_contract.parse_macro_contract(prompt)
    resolution_prompt = str(request_contract.get("resolutionText") or prompt)
    prompt, normalization_notices = normalize_macro_concept_phrasing(resolution_prompt)
    special_entries, notices = macro_providers.resolve_special_series(prompt)
    notices = [*normalization_notices, *notices]
    selected = list(special_entries)
    selected.extend(
        entry
        for entry in resolve_series(prompt)
        if not macro_providers.suppress_standard_entry(entry, prompt, special_entries)
    )
    if re.search(r"\b(?:s\s*&\s*p\s*500|s\W*p\W*500|sp500|spx)\b", prompt, re.IGNORECASE) and re.search(
        r"\b(?:market\s+cap|market\s+capitali[sz]ation|aggregate\s+capitali[sz]ation)\b",
        prompt,
        re.IGNORECASE,
    ):
        selected = [entry for entry in selected if entry.get("id") != "SP500"]
        notices.append(
            "S&P 500 market capitalization is not the S&P 500 index level; no price-index substitute was loaded."
        )

    substitution_match = re.search(
        r"(?:^|,)\s*([^,]+?)\s+(?:may|can|could)\s+be\s+used\s+as\s+(?:a\s+)?"
        r"(?:substitute|proxy)\s+for\s+([^,]+)",
        prompt,
        re.IGNORECASE,
    )
    if substitution_match:
        fallback_candidates = resolve_series(substitution_match.group(1))
        primary_candidates = resolve_series(substitution_match.group(2))
        if fallback_candidates and primary_candidates:
            fallback = fallback_candidates[0]
            primary_id = primary_candidates[0]["id"]
            updated: list[dict[str, Any]] = []
            for entry in selected:
                if entry["id"] == fallback["id"] and entry["id"] != primary_id:
                    continue
                cloned = dict(entry)
                if entry["id"] == primary_id:
                    cloned["promptFallback"] = dict(fallback)
                updated.append(cloned)
            selected = updated
            notices.append(
                f"{fallback['name']} is a contingency substitute for {primary_candidates[0]['name']}; "
                "it is used only if the primary series and its exact-source backups fail."
            )

    seen = {entry["id"] for entry in selected}

    text = prompt.lower()
    blocked_resolution = False
    foreign_countries = [
        name
        for code, name in macro_providers._countries_in_prompt(prompt)
        if code not in {"USA", "WLD"}
    ]
    explicit_us_scope = bool(
        re.search(r"\b(?:u\.?s\.?|united states|american)\b", text)
    )
    unmatched_geography = macro_providers._unmatched_geography_scope(
        prompt,
        macro_providers._countries_in_prompt(prompt),
    )
    world_bank_concept = any(
        any(re.search(pattern, text) for pattern in row["aliases"])
        for row in macro_providers.WORLD_BANK_SERIES
    )
    if unmatched_geography and world_bank_concept and not explicit_us_scope:
        us_ids = {"GDP", "GDPC1", "CPIAUCSL", "UNRATE"}
        selected = [entry for entry in selected if entry.get("id") not in us_ids]
        seen = {entry["id"] for entry in selected}
        blocked_resolution = True
        notices.append(
            f"The requested geography '{unmatched_geography}' was not resolved; no United States series was substituted."
        )
    if foreign_countries and not explicit_us_scope:
        us_only = {
            "GDP", "GDPC1", "GDPDEF", "PNFI", "PNFIC1", "PCEPI", "PCEPILFE", "PCEC96", "PSAVERT", "DSPI",
            "CPIAUCSL", "CPILFESL", "CPI_CORE_EX_SHELTER", "CPI_SHELTER", "CPI_OER", "CPI_MEDICAL", "CPI_FOOD",
            "CPI_ENERGY", "UNRATE", "U6RATE", "CIVPART", "EMRATIO", "PAYEMS", "AWHI",
            "ICSA", "CCSA", "JTSJOL", "OPHNFB", "ULCNFB",
            "EFFR", "DFF", "FEDFUNDS", "DFEDTARL", "DFEDTARU", "DGS1MO", "DGS3MO",
            "DGS6MO", "DGS1", "DGS2", "DGS5", "DGS7", "DGS10", "DGS20", "DGS30",
            "DFII10", "T5YIE", "T10YIE", "M1SL", "M2SL", "WALCL", "RRPONTSYD", "SOFR",
        }
        removed = [entry for entry in selected if entry.get("id") in us_only]
        if removed:
            selected = [entry for entry in selected if entry.get("id") not in us_only]
            seen = {entry["id"] for entry in selected}
            blocked_resolution = True
            notices.append(
                f"The requested country scope ({', '.join(foreign_countries)}) is not available for "
                "that allowlisted concept; no similarly named U.S. series was substituted."
            )

    unsupported_company_metric = bool(
        re.search(r"\b(?:ebitda|free cash flow|fcf)\b", text)
        and macro_providers._explicit_tickers(prompt)
        and not any(entry.get("primary") == "sec-companyfacts" for entry in selected)
    )
    if unsupported_company_metric:
        tickers = set(macro_providers._explicit_tickers(prompt))
        selected = [
            entry
            for entry in selected
            if not (
                entry.get("primary") == "yahoo"
                and str(entry.get("yahoo") or "").lstrip("^").upper() in tickers
            )
        ]
        seen = {entry["id"] for entry in selected}
        blocked_resolution = True
        notices.append(
            "The requested company fundamental is not an allowlisted SEC Company Facts metric; "
            "no stock-price substitute was used."
        )

    requested_tickers = set(macro_providers._explicit_tickers(prompt))
    company_fundamental_requested = bool(
        requested_tickers
        and any(
            any(re.search(pattern, text) for pattern in metric["aliases"])
            for metric in macro_providers.SEC_METRICS
        )
    )
    explicit_company_price = bool(re.search(r"\b(?:price|share price|stock price)\b", text))
    if company_fundamental_requested and not explicit_company_price:
        selected = [
            entry
            for entry in selected
            if not (
                entry.get("primary") == "yahoo"
                and str(entry.get("yahoo") or "").lstrip("^").upper() in requested_tickers
            )
        ]
        seen = {entry["id"] for entry in selected}

    unsupported_index_fundamental = bool(
        re.search(r"\b(?:earnings|eps|profits?|price\s*(?:to|-)?\s*earnings|p\s*/\s*e)\b", text)
        and re.search(r"\b(?:nasdaq[- ]?100|dow jones|djia|russell 2000)\b", text)
    )
    if unsupported_index_fundamental:
        selected = [
            entry
            for entry in selected
            if entry.get("id") not in {"NASDAQ100", "DJIA", "RUSSELL2000"}
        ]
        seen = {entry["id"] for entry in selected}
        blocked_resolution = True
        notices.append(
            "That index fundamental is not available from a verified fundamentals provider; "
            "no index-price substitute was used."
        )

    if macro_providers.SP500_REFERENCE_PATTERN.search(prompt) and macro_providers.SP_VALUATION_PATTERN.search(prompt):
        blocked_resolution = True
        notices.append(
            "S&P 500 valuation ratios are not mapped to the operating-EPS dataset; no price-index substitute was used."
        )
    if re.search(r"\breported\s+(?:earnings|eps)\b", text) and macro_providers.SP500_REFERENCE_PATTERN.search(prompt):
        blocked_resolution = True

    explicit_ids = re.findall(
        r"\b(?:fred\s+(?:series|id)|series)\s+([a-z][a-z0-9]{1,24})\b",
        prompt,
        re.IGNORECASE,
    )
    for raw_series_id in explicit_ids:
        series_id = raw_series_id.upper()
        if series_id in seen:
            continue
        selected.append(
            {
                "id": series_id,
                "name": series_id,
                "unit": "See provider metadata",
                "origin": "Source identified on the FRED series page",
                "aliases": [],
                "resolution": "explicit FRED series ID",
            }
        )
        seen.add(series_id)

    clauses = _search_clauses(prompt)
    unresolved: list[str] = []
    for clause in clauses:
        if macro_providers.clause_is_handled(clause, special_entries):
            continue
        residual = unresolved_clause_residual(clause)
        if residual:
            unresolved.append(residual)
    if blocked_resolution:
        unresolved = []
    unresolved = filter_satisfied_macro_residuals(unresolved, selected)

    generic_business_investment = bool(
        re.search(r"\bbusiness investment\b", text)
        and not re.search(r"\b(?:private nonresidential fixed investment|pnfi(?:c1)?)\b", text)
    )
    if generic_business_investment:
        unresolved = [
            residual
            for residual in unresolved
            if not re.search(r"\bbusiness investment\b", residual, re.IGNORECASE)
        ]
        notices.append(
            "Business investment has multiple official BEA definitions; choose one before data is loaded."
        )

    api_key = get_secret("fredApiKey", "FRED_API_KEY")
    if unresolved and api_key and allow_fred_search:
        for clause in unresolved[:4]:
            if len(_fred_search_terms(clause)) < 2:
                notices.append(
                    f"The unresolved term '{clause}' was too broad for a safe provider search; "
                    "no unrelated series was substituted."
                )
                continue
            try:
                matches = fred_api_search(clause)
            except Exception as exc:  # noqa: BLE001
                notices.append(f"Official FRED search failed for '{clause}': {exc}")
                continue
            if not matches:
                notices.append(
                    f"No configured provider matched '{clause}'; the final metadata search in FRED "
                    "also returned no result."
                )
                continue
            credible_matches = [row for row in matches if credible_fred_search_match(clause, row)]
            if not credible_matches:
                notices.append(
                    f"No configured provider exactly matched '{clause}'. FRED returned candidates, "
                    "but none matched every meaningful term in the requested concept."
                )
                continue
            best = credible_matches[0]
            series_id = str(best["id"])
            if series_id in seen:
                continue
            selected.append(
                {
                    "id": series_id,
                    "name": str(best.get("title") or series_id),
                    "unit": str(best.get("units") or "Provider units"),
                    "origin": "Source identified on the FRED series page",
                    "aliases": [],
                    "resolution": f"official FRED search for '{clause}'",
                    "resolvedClause": clause,
                    "resolutionCandidates": [
                        {
                            "id": row.get("id"),
                            "title": row.get("title"),
                            "frequency": row.get("frequency"),
                            "units": row.get("units"),
                        }
                        for row in credible_matches[:5]
                    ],
                }
            )
            seen.add(series_id)
    elif unresolved:
        unresolved_text = ", ".join(f"'{clause}'" for clause in unresolved[:4])
        if allow_fred_search:
            notices.append(
                f"Unresolved request portion(s): {unresolved_text}. The direct-provider catalog did not "
                "identify an exact series. A FRED API key enables one additional metadata search, but FRED "
                "is not treated as the only data source."
            )
        else:
            notices.append(
                f"The model rewrite did not exactly match an approved deterministic concept: {unresolved_text}. "
                "No open-ended provider search was attempted."
            )

    return selected, notices


PPI_DEFINITION_CHOICES = {
    "core_final_demand": {
        "seriesIds": ["WPSFD49116"],
        "label": "One combined core final-demand line",
        "description": "Goods and services excluding foods, energy, and trade services; official BLS history begins August 2013.",
    },
    "separate_goods_services": {
        "seriesIds": ["WPSFD413", "WPSFD49113"],
        "label": "Separate core goods and services lines",
        "description": "Goods exclude foods and energy; services exclude trade services. Official BLS histories begin November 2009 and April 2010.",
    },
    "maximum_official_history": {
        "seriesIds": ["WPSFD4131", "WPSFD49113"],
        "label": "Maximum official history without fabrication",
        "description": "Shows legacy core finished goods for the full requested window and official core final-demand services from April 2010. The definitions and unequal start dates remain visibly separate.",
    },
    "legacy_finished_goods": {
        "seriesIds": ["WPSFD4131"],
        "label": "Long-history finished goods",
        "description": "Finished goods excluding foods and energy; official BLS history begins January 1974, but services are not included.",
    },
}
YIELD_SPREAD_CHOICES = {
    "ten_year_two_year": {
        "seriesId": "T10Y2Y",
        "label": "10-year minus 2-year",
        "description": "The widely followed 2s10s Treasury curve spread.",
    },
    "ten_year_three_month": {
        "seriesId": "T10Y3M",
        "label": "10-year minus 3-month",
        "description": "The Treasury spread used in many recession-probability studies.",
    },
}
BUSINESS_INVESTMENT_CHOICES = {
    "real_nonresidential_fixed": {
        "seriesId": "PNFIC1",
        "label": "Real private nonresidential fixed investment",
        "description": "Inflation-adjusted business spending on structures, equipment, and intellectual property products.",
    },
    "nominal_nonresidential_fixed": {
        "seriesId": "PNFI",
        "label": "Nominal private nonresidential fixed investment",
        "description": "Current-dollar business spending on structures, equipment, and intellectual property products.",
    },
}
DEBT_SCOPE_CHOICES = {
    "debt_securities": {
        "seriesId": "US_DEBT_SECURITIES_OUTSTANDING",
        "label": "All U.S. debt securities outstanding",
        "description": "Tradable debt instruments, including Treasury, agency/GSE, municipal, corporate and foreign bonds, and open-market paper; excludes loans.",
        "sourceUrl": "https://www.federalreserve.gov/apps/fof/guide/l208.pdf",
    },
    "credit_market_debt": {
        "seriesId": "TCMDO",
        "label": "All U.S. credit-market debt",
        "description": "The broad Financial Accounts measure that includes debt securities and loans across sectors.",
        "sourceUrl": "https://fred.stlouisfed.org/series/TCMDO",
    },
    "federal_public_debt": {
        "seriesId": "US_FEDERAL_DEBT_OUTSTANDING",
        "label": "Federal public debt outstanding",
        "description": "Debt held by the public plus intragovernmental holdings from Treasury Debt to the Penny.",
        "sourceUrl": "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/",
    },
}
PRICE_INDEX_SERIES_IDS = {
    "GDPDEF",
    "CPIAUCSL",
    "CPILFESL",
    "CPI_CORE_EX_SHELTER",
    "CPI_SHELTER",
    "CPI_OER",
    "CPI_MEDICAL",
    "CPI_FOOD",
    "CPI_ENERGY",
    "PCEPI",
    "PCEPILFE",
    "PPIACO",
    "WPSFD4",
    "WPSFD413",
    "WPSFD49104",
    "WPSFD49113",
    "WPSFD49116",
    "WPSFD4131",
}
TRANSFORM_CHOICES = {
    "pct_yoy": {
        "label": "12-month percent change",
        "description": "Shows the inflation rate versus the same month one year earlier; the first plotted point is one year after each native series begins.",
    },
    "raw": {
        "label": "Official index level",
        "description": "Shows each provider's published index level in its native base period.",
    },
    "pct_change": {
        "label": "1-month percent change",
        "description": "Shows the change from the prior monthly observation.",
    },
}


def validate_macro_clarifications(raw: dict[str, Any] | None) -> tuple[dict[str, str], str]:
    if raw is None:
        return {}, ""
    if not isinstance(raw, dict):
        raise ValueError("Macro clarifications must be an object.")
    allowed = {
        "ppi_definition": set(PPI_DEFINITION_CHOICES),
        "yield_spread": set(YIELD_SPREAD_CHOICES),
        "business_investment": set(BUSINESS_INVESTMENT_CHOICES),
        "debt_scope": set(DEBT_SCOPE_CHOICES),
        "price_transform": set(TRANSFORM_CHOICES),
    }
    answers: dict[str, str] = {}
    token = raw.get("_token", "")
    if token and not isinstance(token, str):
        raise ValueError("Macro clarification token must be text.")
    for key, value in raw.items():
        if key == "_token":
            continue
        if key not in allowed or not isinstance(value, str) or value not in allowed[key]:
            raise ValueError(f"Unsupported clarification answer for {key}.")
        answers[key] = value
    return answers, token


def macro_clarification_token(prompt: str, question_ids: list[str]) -> str:
    message = json.dumps(
        {"prompt": prompt.strip(), "questions": sorted(question_ids), "revision": 1},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hmac.new(_MACRO_CLARIFICATION_SECRET, message, hashlib.sha256).hexdigest()


def apply_macro_series_clarifications(
    selected: list[dict[str, Any]],
    answers: dict[str, str],
) -> tuple[list[dict[str, Any]], list[str]]:
    refined = list(selected)
    notices: list[str] = []
    definition = answers.get("ppi_definition")
    ppi_ids = {
        "PPIACO", "WPSFD4", "WPSFD413", "WPSFD49104", "WPSFD49113",
        "WPSFD49116", "WPSFD4131",
    }
    if definition:
        choice = PPI_DEFINITION_CHOICES[definition]
        first_ppi_index = next(
            (index for index, entry in enumerate(refined) if entry.get("id") in ppi_ids),
            len(refined),
        )
        refined = [entry for entry in refined if entry.get("id") not in ppi_ids]
        insert_at = min(first_ppi_index, len(refined))
        for offset, series_id in enumerate(choice["seriesIds"]):
            refined.insert(insert_at + offset, CATALOG_BY_ID[series_id])
        series_label = ", ".join(choice["seriesIds"])
        notices.append(
            f"Clarification selected {choice['label']} ({series_label}): {choice['description']}"
        )

    spread_answer = answers.get("yield_spread")
    if spread_answer:
        spread_choice = YIELD_SPREAD_CHOICES[spread_answer]
        spread_ids = {choice["seriesId"] for choice in YIELD_SPREAD_CHOICES.values()}
        first_spread_index = next(
            (index for index, entry in enumerate(refined) if entry.get("id") in spread_ids),
            len(refined),
        )
        refined = [entry for entry in refined if entry.get("id") not in spread_ids]
        refined.insert(
            min(first_spread_index, len(refined)),
            CATALOG_BY_ID[spread_choice["seriesId"]],
        )
        notices.append(
            f"Clarification selected {spread_choice['label']} ({spread_choice['seriesId']})."
        )

    investment_answer = answers.get("business_investment")
    if investment_answer:
        investment_choice = BUSINESS_INVESTMENT_CHOICES[investment_answer]
        investment_ids = {
            choice["seriesId"] for choice in BUSINESS_INVESTMENT_CHOICES.values()
        }
        first_investment_index = next(
            (index for index, entry in enumerate(refined) if entry.get("id") in investment_ids),
            len(refined),
        )
        refined = [entry for entry in refined if entry.get("id") not in investment_ids]
        refined.insert(
            min(first_investment_index, len(refined)),
            CATALOG_BY_ID[investment_choice["seriesId"]],
        )
        notices.append(
            f"Clarification selected {investment_choice['label']} "
            f"({investment_choice['seriesId']})."
        )

    debt_answer = answers.get("debt_scope")
    if debt_answer:
        debt_choice = DEBT_SCOPE_CHOICES[debt_answer]
        debt_ids = {choice["seriesId"] for choice in DEBT_SCOPE_CHOICES.values()}
        refined = [entry for entry in refined if entry.get("id") not in debt_ids]
        refined.append(CATALOG_BY_ID[debt_choice["seriesId"]])
        notices.append(
            f"Clarification selected {debt_choice['label']} "
            f"({debt_choice['seriesId']})."
        )
    return refined, notices


def ambiguous_us_debt_scope(prompt: str) -> bool:
    text, _corrections = intent_contract.normalize_known_typos(prompt.lower())
    has_broad_debt = bool(
        re.search(
            r"\b(?:total|all)\b[^,.;]{0,45}\bdebt\b|"
            r"\bdebt\b[^,.;]{0,25}\b(?:in|of)\s+(?:the\s+)?(?:u\.?s\.?|united states)\b",
            text,
        )
    )
    has_specific_scope = bool(
        re.search(
            r"\b(?:debt market|debt securities|bond market|fixed income market|credit[- ]market|"
            r"including loans|federal debt|national debt|public debt|treasury debt|"
            r"debt held by the public|intragovernmental)\b",
            text,
        )
    )
    return has_broad_debt and not has_specific_scope


def macro_clarification_questions(
    prompt: str,
    selected: list[dict[str, Any]],
    answers: dict[str, str],
) -> list[dict[str, Any]]:
    text = prompt.lower()
    questions: list[dict[str, Any]] = []
    core_ppi_requested = bool(re.search(r"\bcore\s+(?:ppi|producer price index)\b", text))
    explicit_ppi_definition = bool(
        re.search(
            r"\b(?:wpsfd49116|wpsfd49104|wpsfd413|wpsfd49113|wpsfd4131|ppifes)\b|"
            r"\bcore (?:ppi|producer price index) final demand\b|"
            r"\bcore (?:ppi|producer price index) goods\b|"
            r"\bcore (?:ppi|producer price index) services\b|"
            r"\bfinal demand less foods?,? energy,? and trade services\b|"
            r"\bfinal demand less foods? and energy\b|"
            r"\bfinal demand goods less foods? and energy\b|"
            r"\bfinal demand services less trade services\b|"
            r"\bfinished goods less foods? and energy\b",
            text,
        )
    )
    if core_ppi_requested and not explicit_ppi_definition and "ppi_definition" not in answers:
        requested = parse_requested_range(prompt)
        requested_start = requested.get("start")
        needs_long_history = bool(requested_start and requested_start < date(2009, 11, 1))
        coverage_note = (
            " No conceptually consistent core final-demand goods-and-services series exists for the full requested window; BLS introduced the modern services aggregates in 2009-2010."
            if needs_long_history
            else ""
        )
        questions.append(
            {
                "id": "ppi_definition",
                "title": "Choose the core PPI definition",
                "question": (
                    "BLS publishes several producer-price measures commonly called core PPI. "
                    "Which one should this chart use?" + coverage_note
                ),
                "options": [
                    {
                        "value": value,
                        "label": choice["label"],
                        "description": choice["description"],
                        "recommended": value == (
                            "maximum_official_history" if needs_long_history else "separate_goods_services"
                        ),
                        "sourceUrls": [
                            {
                                "label": f"Official {series_id}",
                                "url": f"https://data.bls.gov/timeseries/{series_id}",
                            }
                            for series_id in choice["seriesIds"]
                        ],
                    }
                    for value, choice in PPI_DEFINITION_CHOICES.items()
                ],
            }
        )

    generic_yield_spread = bool(re.search(r"\byield[- ]curve(?: spread)?\b", text))
    explicit_yield_spread = bool(
        re.search(r"\b(?:2s10s|3m10y|t10y2y|t10y3m|10y[- ]?2y|10y[- ]?3m)\b", text)
    )
    if generic_yield_spread and not explicit_yield_spread and "yield_spread" not in answers:
        questions.append(
            {
                "id": "yield_spread",
                "title": "Choose the yield-curve spread",
                "question": "Which Treasury curve definition should the chart use?",
                "options": [
                    {
                        "value": value,
                        "label": choice["label"],
                        "description": choice["description"],
                        "recommended": value == "ten_year_three_month",
                        "sourceUrls": [
                            {
                                "label": f"Official {choice['seriesId']}",
                                "url": f"https://fred.stlouisfed.org/series/{choice['seriesId']}",
                            }
                        ],
                    }
                    for value, choice in YIELD_SPREAD_CHOICES.items()
                ],
            }
        )
    generic_business_investment = bool(
        re.search(r"\bbusiness investment\b", text)
        and not re.search(r"\b(?:private nonresidential fixed investment|pnfi(?:c1)?)\b", text)
    )
    if generic_business_investment and "business_investment" not in answers:
        questions.append(
            {
                "id": "business_investment",
                "title": "Choose the business-investment definition",
                "question": (
                    "BEA publishes several investment measures. Which private business fixed-investment "
                    "series should this chart use?"
                ),
                "options": [
                    {
                        "value": value,
                        "label": choice["label"],
                        "description": choice["description"],
                        "recommended": value == (
                            "real_nonresidential_fixed" if re.search(r"\breal\b", text)
                            else "nominal_nonresidential_fixed"
                        ),
                        "sourceUrls": [
                            {
                                "label": f"Official {choice['seriesId']}",
                                "url": f"https://fred.stlouisfed.org/series/{choice['seriesId']}",
                            }
                        ],
                    }
                    for value, choice in BUSINESS_INVESTMENT_CHOICES.items()
                ],
            }
        )
    if ambiguous_us_debt_scope(prompt) and "debt_scope" not in answers:
        questions.append(
            {
                "id": "debt_scope",
                "title": "Choose the U.S. debt measure",
                "question": (
                    "Which outstanding U.S. debt definition should the chart use? These measures "
                    "have different economic meanings and cannot be substituted for one another."
                ),
                "options": [
                    {
                        "value": value,
                        "label": choice["label"],
                        "description": choice["description"],
                        "recommended": value == "debt_securities",
                        "sourceUrls": [
                            {"label": "Official source", "url": choice["sourceUrl"]}
                        ],
                    }
                    for value, choice in DEBT_SCOPE_CHOICES.items()
                ],
            }
        )
    has_price_index = any(entry.get("id") in PRICE_INDEX_SERIES_IDS for entry in selected)
    explicit_transform = bool(
        re.search(
            r"\b(?:year[ -]over[ -]year|yoy|12[ -]month)\b|"
            r"\b(?:month[ -]over[ -]month|mom|monthly percent change)\b|"
            r"\b(?:official|native|raw) index(?: level)?\b|\bindex level\b",
            text,
        )
    )
    if has_price_index and not explicit_transform and "price_transform" not in answers:
        questions.append(
            {
                "id": "price_transform",
                "title": "Choose how to display inflation",
                "question": (
                    "CPI and PPI are stored as index levels, while releases usually discuss their "
                    "percent changes. Which view do you want?"
                ),
                "options": [
                    {
                        "value": value,
                        "label": choice["label"],
                        "description": choice["description"],
                        "recommended": value == "pct_yoy",
                    }
                    for value, choice in TRANSFORM_CHOICES.items()
                ],
            }
        )
    return questions


def apply_macro_chart_clarifications(
    chart_config: dict[str, Any],
    answers: dict[str, str],
) -> list[str]:
    transform = answers.get("price_transform")
    if not transform:
        return []
    affected_axes: set[str] = set()
    for spec in chart_config.get("series") or []:
        if spec.get("id") in PRICE_INDEX_SERIES_IDS:
            spec["units"] = transform
            affected_axes.add(str(spec.get("axis") or "left"))
    title = {
        "pct_yoy": "Percent change from year ago",
        "pct_change": "Percent change from prior observation",
        "raw": "Official index level",
    }[transform]
    for axis in affected_axes:
        chart_config["axes"][axis]["title"] = title
    chart_config["recognizedInstructions"].append(f"Clarification selected: {title}.")
    return [f"Clarification selected {TRANSFORM_CHOICES[transform]['label']} for price indexes."]


def _chart_unit_family(row: dict[str, Any]) -> str:
    """Classify native units conservatively for automatic axis selection."""
    name = str(row.get("name") or "").lower()
    unit = str(row.get("unit") or "").lower()
    if re.search(r"percent|percentage|yield|rate|basis point", unit) or re.search(
        r"\b(?:yield|rate|fed funds|unemployment|participation|spread)\b", name
    ):
        return "rate"
    if "index" in unit or re.search(r"\b(?:index|cpi|ppi|vix)\b", name):
        return "index"
    if re.search(r"\b(?:million|billion|trillion)s?\b.*\bdollars?\b|\bchained dollars?\b", unit):
        return "amount"
    if re.search(r"dollar|usd|price|currency|troy ounce|barrel|btu", unit) or re.search(
        r"\b(?:price|futures|gold|silver|crude|natural gas)\b", name
    ):
        return "price"
    if re.search(r"number|count|persons|population|thousands of", unit):
        return "count"
    return re.sub(r"[^a-z]+", " ", unit).strip() or "value"


def _chart_axis_signature(row: dict[str, Any]) -> str:
    """Return a native-measurement signature suitable for sharing one scale."""
    family = _chart_unit_family(row)
    series_id = str(row.get("id") or "").upper()
    name = str(row.get("name") or "").lower()
    unit = re.sub(r"[^a-z0-9]+", " ", str(row.get("unit") or "").lower()).strip()
    unit = re.sub(r"\bu s\b", "us", unit)
    if family == "rate":
        return "rate:percent"
    if family == "index":
        if series_id == "VIXCLS" or "volatility" in name or re.search(r"\bvix\b", name):
            return "index:volatility"
        if series_id in PRICE_INDEX_SERIES_IDS or re.search(r"\b(?:consumer|producer|personal consumption|home) price index\b|\b(?:cpi|ppi)\b", name):
            return "index:price"
        if re.search(r"\b(?:s&p|nasdaq|dow jones|russell|equity|stock)\b", name):
            return "index:equity"
        return f"index:{series_id.lower() or re.sub(r'[^a-z0-9]+', '-', name).strip('-')}"
    if family == "price":
        return f"price:{unit or 'unknown'}"
    if family == "amount":
        magnitude = next((value for value in ("trillion", "billion", "million", "thousand") if value in unit), "units")
        return f"amount:{magnitude}:dollars"
    return f"{family}:{unit or 'value'}"


def parse_chart_intent(
    prompt: str,
    series: list[dict[str, Any]],
    request_contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build an executable chart contract from typed data and display intent."""
    contract = request_contract or parse_macro_request_contract(prompt)
    text = prompt.lower()
    presentation = contract.get("presentation") or {}
    axis_request = presentation.get("axis") or {}
    transform_request = presentation.get("transform") or {}
    style_request = presentation.get("style") or {}
    palette = ["#0b65c2", "#d1495b", "#2a9d6f", "#f59e0b", "#6d5bd0", "#0f8b8d"]
    named_colors = {
        "red": "#d1495b", "blue": "#0b65c2", "green": "#2a9d6f",
        "orange": "#f59e0b", "yellow": "#f4c542", "purple": "#6d5bd0",
        "teal": "#0f8b8d", "black": "#111827", "gray": "#6b7280",
        "grey": "#6b7280", "white": "#ffffff",
    }
    families = [_chart_unit_family(row) for row in series]
    axis_signatures = [_chart_axis_signature(row) for row in series]
    heterogeneous_units = len(set(axis_signatures)) > 1
    heterogeneous_has_rates = "rate" in families and any(family != "rate" for family in families)
    axis_mode = str(axis_request.get("mode") or "auto")
    explicit_axis = bool(axis_request.get("explicit"))
    dual_axis_requested = axis_mode == "dual" or (not explicit_axis and heterogeneous_units and len(series) > 1)
    same_axis_requested = axis_mode == "single" or (not dual_axis_requested)
    if same_axis_requested and axis_mode == "auto":
        axis_mode = "single"

    transform = str(transform_request.get("mode") or "raw")
    transform_explicit = bool(transform_request.get("explicit"))
    if not transform_explicit:
        if re.search(
            r"\b(?:year[ -]over[ -]year|yoy|12[ -]month)(?:\s+(?:percent(?:age)?\s+)?change)?\b|"
            r"\bpercent(?:age)? change from (?:a )?year ago\b",
            text,
        ):
            transform = "pct_yoy"
            transform_explicit = True
        elif re.search(r"\b(?:month[ -]over[ -]month|mom|monthly percent change)\b|\bpercent(?:age)? change\b", text):
            transform = "pct_change"
            transform_explicit = True
        elif re.search(r"\b(?:official|native|raw) index(?: level)?\b|\bindex level\b", text):
            transform = "raw"
            transform_explicit = True
    # Native units are the safe default. Indexing is an explicit transformation,
    # not a silent rescue for incompatible rate and price values.
    default_units = transform if transform_explicit else "raw"

    left_keywords = [str(value).lower() for value in axis_request.get("leftKeywords", [])]
    right_keywords = [str(value).lower() for value in axis_request.get("rightKeywords", [])]
    left_ordinals = {
        int(value)
        for value in axis_request.get("leftOrdinals", [])
        if str(value).isdigit()
    }
    right_ordinals = {
        int(value)
        for value in axis_request.get("rightOrdinals", [])
        if str(value).isdigit()
    }
    yields_right = bool(re.search(r"(?:yield|rate)s?\s+(?:on|to)\s+(?:the\s+)?right", text))
    prices_left = bool(re.search(r"(?:price|index|indexes|indices)\s+(?:on|to)\s+(?:the\s+)?left", text))

    def keyword_matches(row: dict[str, Any], keywords: list[str]) -> bool:
        name = str(row.get("name") or "").lower()
        family = _chart_unit_family(row)
        for keyword in keywords:
            if not keyword:
                continue
            if keyword in name or keyword in family:
                return True
            if re.search(r"\b(?:price|prices|index|indexes|indices|stock|equity)\b", keyword) and family in {"price", "index"}:
                return True
            if re.search(r"\b(?:yield|yields|rate|rates|funds)\b", keyword) and family == "rate":
                return True
        return False

    recognized: list[str] = []
    if dual_axis_requested:
        if explicit_axis:
            recognized.append("Dual-axis instruction recognized; each axis is scaled independently.")
        else:
            recognized.append("Automatic unit-aware dual axes applied to heterogeneous native units.")
    elif explicit_axis and axis_mode == "single":
        recognized.append("Explicit same-axis instruction retained.")

    specs: list[dict[str, Any]] = []
    for index, row in enumerate(series):
        family = families[index]
        is_rate = family == "rate"
        if dual_axis_requested:
            if heterogeneous_has_rates and (left_ordinals or right_ordinals):
                # Keep mixed native units safe even when an ordinal sentence
                # names the sides: rates remain left and non-rates right.
                axis = "left" if is_rate else "right"
            elif index in right_ordinals:
                axis = "right"
            elif index in left_ordinals:
                axis = "left"
            elif keyword_matches(row, right_keywords):
                axis = "right"
            elif keyword_matches(row, left_keywords):
                axis = "left"
            elif yields_right:
                axis = "right" if is_rate else "left"
            elif prices_left:
                axis = "left" if not is_rate else "right"
            elif explicit_axis and not heterogeneous_units:
                # A generic explicit dual-axis request still needs a stable
                # ordinal mapping when every series has the same native unit.
                axis = "left" if index == 0 else "right"
            elif heterogeneous_has_rates:
                axis = "left" if is_rate else "right"
            else:
                # When heterogeneous families contain no rates, retain the
                # request order: first family left, additional families right.
                axis = "left" if index == 0 else "right"
        else:
            axis = "left"
        requested_colors = style_request.get("colors", [])
        color_value = requested_colors[index % len(requested_colors)] if requested_colors else None
        color = named_colors.get(str(color_value).lower(), color_value) if color_value else palette[index % len(palette)]
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            color = palette[index % len(palette)]
        specs.append(
            {
                "id": row.get("id"),
                "axis": axis,
                "type": "line" if presentation.get("chartType") in {None, "table"} else presentation.get("chartType"),
                "color": color,
                "lineStyle": str(style_request.get("lineStyle") or "solid"),
                "lineWidth": 2,
                "marker": str(style_request.get("marker") or "none"),
                "units": default_units,
                "frequency": "original",
                "aggregation": "average",
                "visible": True,
            }
        )

    chart_type = presentation.get("chartType")
    if chart_type in {"bar", "area", "scatter"}:
        recognized.append(f"{str(chart_type).capitalize()} chart requested.")
    if transform == "pct_yoy":
        recognized.append("Year-over-year percent change requested.")
    elif transform == "pct_change":
        recognized.append("Period-over-period percent change requested.")
    elif transform == "index":
        recognized.append("Index-to-100 normalization requested.")
    elif transform == "raw" and transform_explicit:
        recognized.append("Native provider values requested.")
    if style_request.get("scale") == "log":
        recognized.append("Logarithmic axis scale requested.")
    for unsupported in presentation.get("unsupported", []):
        recognized.append(
            f"Unsupported presentation wording ignored after building with resolved data: {unsupported}. "
            "Use Edit graph to choose a supported chart style."
        )

    formulas: list[dict[str, str]] = []
    if len(series) >= 2:
        if re.search(r"\b(?:minus|less|spread between)\b", text):
            expression = "A-B"
            formula_name = f"{series[0]['name']} minus {series[1]['name']}"
            ordered_spread = re.search(
                r"\b(1|2|5|7|10|20|30)[ -](?:year|yr)\s+minus\s+"
                r"(1|2|5|7|10|20|30)[ -](?:year|yr)(?:\s+treasury)?\s+spread\b",
                text,
            )
            if ordered_spread:
                spread_ids = {
                    "1": "DGS1", "2": "DGS2", "5": "DGS5", "7": "DGS7",
                    "10": "DGS10", "20": "DGS20", "30": "DGS30",
                }
                first_id = spread_ids[ordered_spread.group(1)]
                second_id = spread_ids[ordered_spread.group(2)]
                indexes = {str(row.get("id")): index for index, row in enumerate(series[:26])}
                if first_id in indexes and second_id in indexes:
                    first_letter = chr(65 + indexes[first_id])
                    second_letter = chr(65 + indexes[second_id])
                    expression = f"{first_letter}-{second_letter}"
                    formula_name = (
                        f"{series[indexes[first_id]]['name']} minus "
                        f"{series[indexes[second_id]]['name']}"
                    )
            formulas.append({"name": formula_name, "expression": expression})
        elif re.search(r"\bdivided by\b|\bratio of\b", text):
            formulas.append({"name": f"{series[0]['name']} divided by {series[1]['name']}", "expression": "A/B"})
        if formulas:
            for spec in specs:
                spec["visible"] = False
            recognized.append(f"Calculated formula requested: {formulas[0]['expression']}.")

    unit_labels = {
        "raw": lambda row: (
            "Index"
            if str(row.get("unit") or "").strip().lower() == "index level"
            else str(row.get("unit") or "Value")
        ),
        "index": lambda _row: "Index (first observation = 100)",
        "change": lambda _row: "Change",
        "change_yoy": lambda _row: "Change from year ago",
        "pct_change": lambda _row: "Percent change",
        "pct_yoy": lambda _row: "Percent change from year ago",
    }

    def axis_title(axis_name: str) -> str:
        labels = {
            unit_labels.get(spec["units"], unit_labels["raw"])(row)
            for row, spec in zip(series, specs)
            if spec["axis"] == axis_name
        }
        return " / ".join(sorted(labels)) if labels else ""

    log_scale = style_request.get("scale") == "log"
    return {
        "series": specs,
        "formulas": formulas,
        "graph": {
            "showTitle": True,
            "showAxisTitles": True,
            "showTooltip": True,
            "recessionShading": False,
            "legendPosition": "top",
            "plotColor": "#ffffff",
            "frameColor": "#eef3f8",
            "textColor": "#17324d",
        },
        "axes": {
            "left": {"title": axis_title("left"), "log": log_scale, "min": None, "max": None},
            "right": {"title": axis_title("right"), "log": log_scale, "min": None, "max": None},
        },
        "recognizedInstructions": list(dict.fromkeys(recognized)),
    }


def parse_fred_csv(text: str, series_id: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(text))
    observations: list[dict[str, Any]] = []
    for row in reader:
        row_date = row.get("observation_date") or row.get("DATE") or row.get("date")
        raw_value = row.get(series_id) or row.get("value")
        if not row_date or raw_value in (None, "", "."):
            continue
        try:
            value = float(str(raw_value).strip())
        except ValueError:
            continue
        observations.append({"date": row_date, "value": value})
    return observations


FED_Z1_ARCHIVE_URL = "https://www.federalreserve.gov/releases/z1/current/z1_csv_files.zip"


def parse_fed_z1_archive(
    content: bytes,
    archive_path: str,
    series_id: str,
    start: date | None,
    end: date | None,
) -> list[dict[str, Any]]:
    """Read one audited Z.1 level series from the official release archive."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            with archive.open(archive_path) as source:
                text = io.TextIOWrapper(source, encoding="utf-8-sig", newline="")
                reader = csv.DictReader(text)
                if not reader.fieldnames or series_id not in reader.fieldnames:
                    raise RuntimeError(
                        f"Federal Reserve Z.1 file {archive_path} does not contain {series_id}."
                    )
                observations: list[dict[str, Any]] = []
                for row in reader:
                    quarter = str(row.get("date") or "").strip()
                    match = re.fullmatch(r"((?:19|20)\d{2}):Q([1-4])", quarter)
                    raw_value = row.get(series_id)
                    if not match or raw_value in (None, "", "ND", "NA"):
                        continue
                    year, quarter_number = int(match.group(1)), int(match.group(2))
                    month = quarter_number * 3
                    row_date = date(year, month, calendar.monthrange(year, month)[1])
                    if start and row_date < start:
                        continue
                    if end and row_date > end:
                        continue
                    try:
                        value = float(str(raw_value).replace(",", "").strip())
                    except ValueError:
                        continue
                    # A zero market value represents unavailable historical detail,
                    # not a real zero-sized U.S. market.
                    if value <= 0:
                        continue
                    observations.append({"date": row_date.isoformat(), "value": value})
    except (zipfile.BadZipFile, KeyError) as exc:
        raise RuntimeError(f"Invalid Federal Reserve Z.1 archive: {exc}") from exc
    if not observations:
        raise RuntimeError(
            f"No usable Federal Reserve Z.1 observations for {series_id} in the requested range."
        )
    return observations


def fetch_fed_z1_series(
    entry: dict[str, Any], start: date | None, end: date | None
) -> dict[str, Any]:
    response = http_get_bytes(
        FED_Z1_ARCHIVE_URL,
        headers={"Accept": "*/*"},
        timeout=30,
        cache_ttl=24 * 60 * 60,
        allow_stale=True,
    )
    observations = parse_fed_z1_archive(
        response.content,
        str(entry["z1File"]),
        str(entry["z1Series"]),
        start,
        end,
    )
    result = {
        "id": entry["id"],
        "name": entry["name"],
        "unit": entry["unit"],
        "provider": "Federal Reserve Financial Accounts (direct Z.1 archive)",
        "providerSeries": entry["z1Series"],
        "sourceUrl": entry["sourceUrl"],
        "origin": entry["origin"],
        "resolution": entry["resolution"],
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "fetchedAt": response.fetched_at,
        "transport": response.transport,
        "fromCache": response.from_cache,
        "stale": response.stale,
        "measureType": entry.get("measureType"),
        "preferredUnits": entry.get("preferredUnits"),
    }
    if response.warning:
        result["providerWarning"] = response.warning
    return result


def fetch_fiscal_debt_series(
    entry: dict[str, Any], start: date | None, end: date | None
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "fields": "record_date,tot_pub_debt_out_amt",
        "sort": "record_date",
        "page[size]": "10000",
    }
    filters = []
    if start:
        filters.append(f"record_date:gte:{start.isoformat()}")
    if end:
        filters.append(f"record_date:lte:{end.isoformat()}")
    if filters:
        params["filter"] = ",".join(filters)
    payload = http_get_json(
        "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/"
        "v2/accounting/od/debt_to_penny",
        params=params,
        headers={"Accept": "application/json"},
        cache_ttl=6 * 60 * 60,
        allow_stale=True,
    )
    rows = payload.get("data") if isinstance(payload, dict) else None
    observations = []
    for row in rows or []:
        row_date = str(row.get("record_date") or "")[:10]
        try:
            # Treasury publishes dollars; Macro Data Lab standardizes market
            # aggregates to millions so equity and debt can share one axis.
            value = float(str(row.get("tot_pub_debt_out_amt") or "")) / 1_000_000.0
            date.fromisoformat(row_date)
        except (TypeError, ValueError):
            continue
        observations.append({"date": row_date, "value": value})
    if not observations:
        raise RuntimeError("Treasury Debt to the Penny returned no usable observations.")
    return {
        "id": entry["id"],
        "name": entry["name"],
        "unit": entry["unit"],
        "provider": "U.S. Treasury Fiscal Data",
        "providerSeries": "tot_pub_debt_out_amt",
        "sourceUrl": entry["sourceUrl"],
        "origin": entry["origin"],
        "resolution": entry["resolution"],
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "measureType": entry.get("measureType"),
        "preferredUnits": entry.get("preferredUnits"),
    }


def fetch_fred_series(series_id: str, start: date | None, end: date | None) -> dict[str, Any]:
    params: dict[str, Any] = {"id": series_id}
    if start:
        params["cosd"] = start.isoformat()
    if end:
        params["coed"] = end.isoformat()

    def load_csv(request_params: dict[str, Any]) -> list[dict[str, Any]]:
        text = http_get_text(
            "https://fred.stlouisfed.org/graph/fredgraph.csv",
            params=request_params,
            headers={"Accept": "text/csv,*/*"},
            default_headers=False,
            cache_enabled=False,
            allow_stale=False,
        )
        observations = parse_fred_csv(text, series_id)
        if not observations:
            raise RuntimeError(f"No usable observations returned by FRED for {series_id}.")
        return observations

    def filter_observations(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not start and not end:
            return observations
        filtered = []
        for row in observations:
            row_date = date.fromisoformat(row["date"])
            if start and row_date < start:
                continue
            if end and row_date > end:
                continue
            filtered.append(row)
        if not filtered:
            raise RuntimeError(f"No usable observations returned by FRED for {series_id} in requested range.")
        return filtered

    def load():
        errors: list[str] = []
        for _attempt in range(2):
            try:
                return load_csv(params)
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
                time.sleep(0.35)
        if start or end:
            try:
                return filter_observations(load_csv({"id": series_id}))
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001
                errors.append(f"full-history fallback: {exc}")
        raise RuntimeError(" | ".join(errors))

    observations = load()
    return {
        "id": series_id,
        "provider": "FRED",
        "providerSeries": series_id,
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": f"https://fred.stlouisfed.org/series/{series_id}",
    }


def parse_bls_series(payload: dict[str, Any], series_id: str) -> list[dict[str, Any]]:
    if payload.get("status") != "REQUEST_SUCCEEDED":
        detail = "; ".join(str(value) for value in payload.get("message") or [])
        raise RuntimeError(f"BLS request failed for {series_id}: {detail or 'unknown error'}")
    series_rows = payload.get("Results", {}).get("series") or []
    match = next(
        (row for row in series_rows if str(row.get("seriesID")) == series_id),
        series_rows[0] if series_rows else None,
    )
    if not match:
        raise RuntimeError(f"BLS returned no series for {series_id}.")
    observations: list[dict[str, Any]] = []
    for row in match.get("data") or []:
        period = str(row.get("period") or "")
        if not period.startswith("M") or period == "M13":
            continue
        try:
            month = int(period[1:])
            row_date = date(int(row["year"]), month, 1).isoformat()
            value = float(str(row["value"]).replace(",", ""))
        except (KeyError, TypeError, ValueError):
            continue
        observations.append({"date": row_date, "value": value})
    observations.sort(key=lambda row: row["date"])
    if not observations:
        raise RuntimeError(f"BLS returned no usable observations for {series_id}.")
    return observations


def fetch_bls_series(series_id: str, start: date | None, end: date | None) -> dict[str, Any]:
    end_date = min(end or today_local(), today_local())
    start_date = start or add_years(end_date, -20)
    observations_by_date: dict[str, dict[str, Any]] = {}
    # The public no-key endpoint limits requested spans; chunking keeps requests deterministic.
    cursor_year = start_date.year
    while cursor_year <= end_date.year:
        chunk_end = min(cursor_year + 9, end_date.year)
        payload = http_get_json(
            f"https://api.bls.gov/publicAPI/v2/timeseries/data/{series_id}",
            params={"startyear": cursor_year, "endyear": chunk_end},
            cache_ttl=12 * 60 * 60,
        )
        for row in parse_bls_series(payload, series_id):
            row_date = date.fromisoformat(row["date"])
            if start_date <= row_date <= end_date:
                observations_by_date[row["date"]] = row
        cursor_year = chunk_end + 1
    observations = sorted(observations_by_date.values(), key=lambda row: row["date"])
    if not observations:
        raise RuntimeError(f"No usable BLS observations returned for {series_id} in requested range.")
    return {
        "provider": "U.S. Bureau of Labor Statistics API",
        "providerSeries": series_id,
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": f"https://data.bls.gov/timeseries/{series_id}",
    }


def fetch_yahoo_chart(symbol: str, start: date | None, end: date | None) -> dict[str, Any]:
    start_date = start or date(1900, 1, 1)
    end_date = end or today_local()
    period1 = int(datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    period2 = int(
        datetime.combine(end_date + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp()
    )
    encoded_symbol = urllib.parse.quote(symbol, safe="")
    urls = [
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded_symbol}",
        f"https://query2.finance.yahoo.com/v8/finance/chart/{encoded_symbol}",
    ]
    params = {
        "period1": period1,
        "period2": period2,
        "interval": "1d",
        "events": "history",
        "includeAdjustedClose": "true",
    }

    def load():
        errors: list[str] = []
        result = None
        for url in urls:
            try:
                payload = http_get_json(url, params=params, cache_ttl=15 * 60)
                result = (payload.get("chart", {}).get("result") or [None])[0]
                if result:
                    break
                errors.append(f"{url}: {payload.get('chart', {}).get('error')}")
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{url}: {exc}")
        if not result:
            raise RuntimeError(f"Yahoo chart returned no result for {symbol}. " + " | ".join(errors))
        timestamps = result.get("timestamp") or []
        adj = ((result.get("indicators", {}).get("adjclose") or [{}])[0]).get("adjclose")
        close = ((result.get("indicators", {}).get("quote") or [{}])[0]).get("close")
        values = adj or close or []
        observations: list[dict[str, Any]] = []
        for ts, value in zip(timestamps, values):
            if value is None:
                continue
            row_date = datetime.fromtimestamp(int(ts), timezone.utc).date().isoformat()
            observations.append({"date": row_date, "value": float(value)})
        if not observations:
            raise RuntimeError(f"No usable observations returned by Yahoo Finance for {symbol}.")
        return observations

    observations = cache_get(f"yahoo:{symbol}:{start}:{end}", 60 * 15, load)
    return {
        "provider": "Yahoo Finance chart",
        "providerSeries": symbol,
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": f"https://finance.yahoo.com/quote/{urllib.parse.quote(symbol)}",
    }


def parse_treasury_xml(text: str) -> list[dict[str, Any]]:
    root = ET.fromstring(text)
    rows: list[dict[str, Any]] = []
    for entry in root.iter():
        if entry.tag.rsplit("}", 1)[-1] != "entry":
            continue
        values: dict[str, str] = {}
        for node in entry.iter():
            key = node.tag.rsplit("}", 1)[-1]
            if node.text and node.text.strip():
                values[key] = node.text.strip()
        raw_date = values.get("NEW_DATE") or values.get("updated")
        if not raw_date:
            continue
        rows.append({"date": raw_date[:10], "values": values})
    return rows


def fetch_treasury_year(year: int) -> list[dict[str, Any]]:
    def load() -> list[dict[str, Any]]:
        text = http_get_text(
            "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml",
            params={"data": "daily_treasury_yield_curve", "field_tdr_date_value": year},
            headers={"Accept": "application/atom+xml,application/xml,text/xml,*/*"},
            cache_ttl=24 * 60 * 60,
        )
        rows = parse_treasury_xml(text)
        if not rows:
            raise RuntimeError(f"U.S. Treasury XML feed returned no yield-curve rows for {year}.")
        return rows

    return cache_get(f"treasury-yield-year:{year}", 24 * 60 * 60, load)


def fetch_treasury_yield_series(
    series_id: str, field: str, start: date | None, end: date | None
) -> dict[str, Any]:
    start_date = max(start or date(1990, 1, 1), date(1990, 1, 1))
    end_date = min(end or today_local(), today_local())
    years = list(range(start_date.year, end_date.year + 1))
    year_rows: list[list[dict[str, Any]]] = []
    failed_years: dict[int, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, max(1, len(years)))) as executor:
        futures = {executor.submit(fetch_treasury_year, year): year for year in years}
        for future in concurrent.futures.as_completed(futures):
            year = futures[future]
            try:
                year_rows.append(future.result())
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001 - preserve usable years and report the gap.
                failed_years[year] = str(exc)[:300]

    observations: list[dict[str, Any]] = []
    for row in (row for group in year_rows for row in group):
        row_date = date.fromisoformat(row["date"])
        if row_date < start_date or row_date > end_date:
            continue
        raw_value = row["values"].get(field)
        if raw_value in (None, "", "N/A"):
            continue
        try:
            observations.append({"date": row["date"], "value": float(raw_value)})
        except ValueError:
            continue
    observations.sort(key=lambda row: row["date"])
    if not observations:
        detail = "; ".join(f"{year}: {error}" for year, error in sorted(failed_years.items()))
        raise RuntimeError(
            f"No usable {field} observations returned by the U.S. Treasury XML feed. {detail}"
        )
    return {
        "id": series_id,
        "provider": "U.S. Treasury XML feed",
        "providerSeries": field,
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": "https://home.treasury.gov/treasury-daily-interest-rate-xml-feed",
        "failedYears": sorted(failed_years),
        "providerWarnings": [
            f"Treasury year {year} failed and requires fallback: {error}"
            for year, error in sorted(failed_years.items())
        ],
    }


def compare_observations(
    primary: list[dict[str, Any]], reference: list[dict[str, Any]], label: str
) -> dict[str, Any]:
    reference_map = {row["date"]: float(row["value"]) for row in reference}
    pairs = [
        (float(row["value"]), reference_map[row["date"]])
        for row in primary
        if row["date"] in reference_map
    ]
    if len(pairs) < 20:
        return {"status": "insufficient-overlap", "reference": label, "overlap": len(pairs)}
    left = [pair[0] for pair in pairs]
    right = [pair[1] for pair in pairs]
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in pairs)
    denominator = math.sqrt(
        sum((a - left_mean) ** 2 for a in left) * sum((b - right_mean) ** 2 for b in right)
    )
    correlation = numerator / denominator if denominator else 0.0
    median_scaled_error = sorted(
        abs((a / left[0]) - (b / right[0])) for a, b in pairs if left[0] and right[0]
    )[len(pairs) // 2]
    status = "pass" if correlation >= 0.999 and median_scaled_error <= 0.01 else "review"
    return {
        "status": status,
        "reference": label,
        "overlap": len(pairs),
        "correlation": round(correlation, 6),
        "medianNormalizedDifference": round(median_scaled_error, 6),
    }


def validate_series_result(series: dict[str, Any], requested_start: date | None) -> dict[str, Any]:
    observations = series.get("observations") or []
    dates = [row["date"] for row in observations]
    checks = {
        "hasObservations": bool(observations),
        "chronological": dates == sorted(dates),
        "noDuplicateDates": len(dates) == len(set(dates)),
        "finiteValues": all(math.isfinite(float(row["value"])) for row in observations),
    }
    warnings: list[str] = []
    warnings.extend(str(warning) for warning in series.get("providerWarnings") or [])
    if requested_start and observations:
        gap = (date.fromisoformat(observations[0]["date"]) - requested_start).days
        if gap > 180:
            warnings.append(f"Series begins {gap} days after the requested start date.")
    comparison = series.get("sourceComparison")
    if comparison and comparison.get("status") != "pass":
        warnings.append(f"Cross-source comparison status: {comparison.get('status')}.")
    calculation_validation = series.get("calculationValidation")
    if calculation_validation and calculation_validation.get("status") != "pass":
        warnings.append(
            f"Calculation validation status: {calculation_validation.get('status')}."
        )
    status = "pass" if all(checks.values()) and not warnings else "review"
    return {
        "status": status,
        "checks": checks,
        "warnings": warnings,
        "sourceComparison": comparison,
        "calculationValidation": calculation_validation,
    }


def _coverage_fallback_entry(entry: dict[str, Any]) -> dict[str, Any]:
    fallback = copy.deepcopy(entry.get("coverageFallback") or {})
    fallback.update(
        {
            "id": entry["id"],
            "name": entry["name"],
            "unit": entry["unit"],
            "origin": fallback.get("origin") or entry.get("origin"),
        }
    )
    return fallback


def _series_coverage(
    series: dict[str, Any],
    entry: dict[str, Any],
    start: date | None,
    end: date | None,
    *,
    base_only: bool = False,
) -> dict[str, Any]:
    return coverage_planner.coverage_status(
        series.get("observations") or [],
        start,
        end,
        start_tolerance_days=int(entry.get("coverageStartToleranceDays", 45)),
        end_tolerance_days=int(
            entry.get("coverageBaseEndToleranceDays", 62)
            if base_only
            else entry.get("coverageEndToleranceDays", 10)
        ),
    )


def _fetch_declared_coverage_base(
    entry: dict[str, Any],
    start: date | None,
    end: date | None,
) -> dict[str, Any]:
    fallback = _coverage_fallback_entry(entry)
    if not fallback.get("primary"):
        raise RuntimeError(f"{entry['name']} has no configured long-history coverage source.")
    return macro_providers.fetch_special_series(fallback, start, end)


def fetch_display_series(entry: dict[str, Any], start: date | None, end: date | None) -> dict[str, Any]:
    if entry.get("primary") in {"sp-earnings", "world-bank", "sec-companyfacts", "fed-dfa"}:
        return macro_providers.fetch_special_series(entry, start, end)

    if entry.get("primary") == "fed-z1":
        try:
            return fetch_fed_z1_series(entry, start, end)
        except NetworkPolicyError:
            raise
        except Exception as z1_exc:  # noqa: BLE001 - exact FRED mirror is the declared fallback.
            fred_result = fetch_fred_series(str(entry["fred"]), start, end)
            fred_result.update(
                {
                    "id": entry["id"],
                    "name": entry["name"],
                    "unit": entry["unit"],
                    "origin": entry["origin"],
                    "sourceUrl": entry["sourceUrl"],
                    "resolution": "FRED mirror fallback for the same Federal Reserve Z.1 series",
                    "fallbackReason": f"Direct Federal Reserve Z.1 archive failed: {z1_exc}",
                    "measureType": entry.get("measureType"),
                    "preferredUnits": entry.get("preferredUnits"),
                }
            )
            return fred_result

    if entry.get("primary") == "fiscal-debt":
        try:
            return fetch_fiscal_debt_series(entry, start, end)
        except NetworkPolicyError:
            raise
        except Exception as fiscal_exc:  # noqa: BLE001 - GFDEBTN is the exact quarterly fallback.
            fred_result = fetch_fred_series(str(entry["fred"]), start, end)
            fred_result.update(
                {
                    "id": entry["id"],
                    "name": entry["name"],
                    "unit": entry["unit"],
                    "origin": entry["origin"],
                    "sourceUrl": entry["sourceUrl"],
                    "resolution": "FRED quarterly mirror fallback for Treasury total public debt",
                    "fallbackReason": f"Treasury Debt to the Penny failed: {fiscal_exc}",
                    "measureType": entry.get("measureType"),
                    "preferredUnits": entry.get("preferredUnits"),
                }
            )
            return fred_result

    if entry.get("primary") == "treasury":
        try:
            treasury_result = fetch_treasury_yield_series(
                entry["id"], entry["treasuryField"], start, end
            )
        except NetworkPolicyError:
            raise
        except Exception as treasury_exc:  # noqa: BLE001 - FRED is the declared backup.
            fred_result = fetch_fred_series(entry["id"], start, end)
            fred_result.update(
                {
                    "name": entry["name"],
                    "unit": entry["unit"],
                    "origin": entry["origin"],
                    "resolution": "FRED fallback for direct U.S. Treasury maturity mapping",
                    "fallbackReason": f"U.S. Treasury feed failed: {treasury_exc}",
                }
            )
            return fred_result

        failed_years = set(treasury_result.get("failedYears") or [])
        if failed_years:
            try:
                fred_result = fetch_fred_series(entry["id"], start, end)
                merged = {row["date"]: row for row in treasury_result["observations"]}
                fallback_count = 0
                for row in fred_result["observations"]:
                    if date.fromisoformat(row["date"]).year in failed_years and row["date"] not in merged:
                        merged[row["date"]] = row
                        fallback_count += 1
                treasury_result["observations"] = sorted(merged.values(), key=lambda row: row["date"])
                treasury_result["firstDate"] = treasury_result["observations"][0]["date"]
                treasury_result["lastDate"] = treasury_result["observations"][-1]["date"]
                treasury_result["latest"] = treasury_result["observations"][-1]["value"]
                treasury_result["provider"] = "U.S. Treasury XML feed + FRED gap fallback"
                treasury_result["fallbackReason"] = (
                    f"Filled {fallback_count} observations for failed Treasury years via FRED."
                )
            except NetworkPolicyError as fred_exc:
                treasury_result["fallbackError"] = f"FRED gap fallback unavailable: {fred_exc}"
            except Exception as fred_exc:  # noqa: BLE001
                treasury_result["fallbackError"] = f"FRED gap fallback failed: {fred_exc}"
        treasury_result.update(
            {
                "name": entry["name"],
                "unit": entry["unit"],
                "origin": entry["origin"],
                "resolution": "curated U.S. Treasury maturity mapping",
            }
        )
        return treasury_result

    if entry.get("primary") == "yahoo":
        try:
            yahoo_result = fetch_yahoo_chart(entry["yahoo"], start, end)
        except NetworkPolicyError:
            raise
        except Exception as yahoo_exc:  # noqa: BLE001 - use the index series as a backup when defined.
            if entry.get("coverageFallback"):
                try:
                    coverage_base = _fetch_declared_coverage_base(entry, start, end)
                    coverage = _series_coverage(
                        coverage_base,
                        entry,
                        start,
                        end,
                        base_only=True,
                    )
                    if not coverage["complete"] and entry.get("requireRequestedCoverage"):
                        raise RuntimeError(
                            "The long-history source did not cover the requested window: "
                            f"start gap={coverage.get('startGapDays')} days, "
                            f"end gap={coverage.get('endGapDays')} days."
                        )
                    coverage_base.update(
                        {
                            "id": entry["id"],
                            "name": entry["name"],
                            "unit": entry["unit"],
                            "origin": entry.get("origin"),
                            "coverage": coverage,
                            "fallbackReason": f"Yahoo Finance failed: {yahoo_exc}",
                            "sourceComparison": {
                                "status": "unavailable",
                                "reference": f"Yahoo Finance {entry['yahoo']}",
                                "detail": "Primary continuation was unavailable; official coverage source used alone.",
                            },
                        }
                    )
                    return coverage_base
                except NetworkPolicyError:
                    raise
                except Exception as coverage_exc:  # noqa: BLE001 - continue to an exact FRED fallback if declared.
                    yahoo_exc = RuntimeError(
                        f"Yahoo Finance failed ({yahoo_exc}); configured coverage source also failed "
                        f"({coverage_exc})."
                    )
            fallback_id = entry.get("validationFred")
            if not fallback_id:
                raise RuntimeError(
                    f"{entry['name']} failed from Yahoo and has no exact free fallback: {yahoo_exc}"
                ) from yahoo_exc
            fred_result = fetch_fred_series(fallback_id, start, end)
            fred_result.update(
                {
                    "id": entry["id"],
                    "name": entry.get("yahooName") or entry["name"],
                    "unit": entry["unit"],
                    "origin": entry.get("origin"),
                    "resolution": "FRED fallback for market-index history",
                    "fallbackReason": f"Yahoo Finance failed: {yahoo_exc}",
                }
            )
            return fred_result
        yahoo_result.update(
            {
                "id": entry["id"],
                "name": entry.get("yahooName") or entry["name"],
                "unit": entry["unit"],
                "origin": entry.get("origin"),
                "resolution": entry.get("resolution", "curated market-data mapping"),
            }
        )
        coverage = _series_coverage(yahoo_result, entry, start, end)
        if not coverage["complete"] and entry.get("coverageFallback"):
            try:
                coverage_base = _fetch_declared_coverage_base(entry, start, end)
            except NetworkPolicyError:
                raise
            except Exception as coverage_exc:  # noqa: BLE001 - partial primary data must not be mislabeled complete.
                if entry.get("requireRequestedCoverage"):
                    raise RuntimeError(
                        f"{entry['name']} returned partial history from Yahoo "
                        f"({yahoo_result['firstDate']} to {yahoo_result['lastDate']}); the configured "
                        f"coverage source failed: {coverage_exc}"
                    ) from coverage_exc
                yahoo_result["fallbackError"] = str(coverage_exc)
            else:
                comparison = coverage_planner.compare_monthly_levels(
                    yahoo_result["observations"],
                    coverage_base["observations"],
                    primary_label=f"Yahoo Finance {entry['yahoo']}",
                    reference_label=str(coverage_base.get("providerSeries") or coverage_base["provider"]),
                    minimum_months=int(entry.get("coverageMinimumOverlapMonths", 24)),
                    minimum_correlation=float(entry.get("coverageMinimumCorrelation", 0.98)),
                    maximum_median_percent_difference=float(
                        entry.get("coverageMaximumMedianPercentDifference", 0.08)
                    ),
                )
                yahoo_result = coverage_planner.compose_coverage_base(
                    yahoo_result,
                    coverage_base,
                    start=start,
                    end=end,
                    comparison=comparison,
                    start_tolerance_days=int(entry.get("coverageStartToleranceDays", 45)),
                    end_tolerance_days=int(entry.get("coverageEndToleranceDays", 10)),
                )
                yahoo_result["resolution"] = (
                    "verified long-history coverage base with current market-price continuation"
                )
                yahoo_result["fallbackReason"] = (
                    f"Yahoo history began {coverage.get('startGapDays')} days after the requested "
                    "start, so the configured long-history source supplied the missing period."
                )
                yahoo_result["providerWarnings"] = [
                    *(coverage_base.get("providerWarnings") or []),
                    *(yahoo_result.get("providerWarnings") or []),
                ]
                yahoo_result["providerNotes"] = [
                    *(coverage_base.get("providerNotes") or []),
                    "The two sources were compared on overlapping monthly averages before composition.",
                ]
                coverage = yahoo_result["coverage"]
        yahoo_result["coverage"] = coverage
        if entry.get("requireRequestedCoverage") and not coverage["complete"]:
            raise RuntimeError(
                f"{entry['name']} did not cover the requested range after every configured source "
                f"was checked: start gap={coverage.get('startGapDays')} days, "
                f"end gap={coverage.get('endGapDays')} days."
            )
        if entry.get("validationFred"):
            validation_start = max(start or date(2016, 1, 1), date(2016, 1, 1))
            try:
                reference = fetch_fred_series(entry["validationFred"], validation_start, end)
                yahoo_result["sourceComparison"] = compare_observations(
                    yahoo_result["observations"], reference["observations"], "FRED overlap"
                )
            except NetworkPolicyError as exc:
                yahoo_result["sourceComparison"] = {
                    "status": "unavailable",
                    "reference": "FRED overlap",
                    "detail": str(exc)[:500],
                }
            except Exception as exc:  # noqa: BLE001
                yahoo_result["sourceComparison"] = {
                    "status": "unavailable",
                    "reference": "FRED overlap",
                    "detail": str(exc)[:500],
                }
        return yahoo_result

    fred_result: dict[str, Any] | None = None
    fred_error: str | None = None
    if entry.get("bls"):
        try:
            bls_result = fetch_bls_series(entry["bls"], start, end)
            bls_result.update(
                {
                    "id": entry["id"],
                    "name": entry["name"],
                    "unit": entry["unit"],
                    "origin": "U.S. Bureau of Labor Statistics",
                    "resolution": "curated direct BLS series mapping",
                }
            )
            return bls_result
        except NetworkPolicyError:
            raise
        except Exception as bls_exc:  # noqa: BLE001 - FRED remains a transparent backup.
            try:
                fred_result = fetch_fred_series(entry.get("fred", entry["id"]), start, end)
                fred_result.update(
                    {
                        "id": entry["id"],
                        "name": entry["name"],
                        "unit": entry["unit"],
                        "origin": entry.get("origin"),
                        "resolution": "FRED fallback for direct BLS series mapping",
                        "fallbackReason": f"Direct BLS API failed: {bls_exc}",
                    }
                )
                return fred_result
            except NetworkPolicyError:
                raise
            except Exception as fred_exc:  # noqa: BLE001
                raise RuntimeError(
                    f"{entry['name']} failed from direct BLS ({bls_exc}) and FRED ({fred_exc})."
                ) from fred_exc
    try:
        fred_result = fetch_fred_series(entry["id"], start, end)
    except NetworkPolicyError:
        raise
    except Exception as exc:  # noqa: BLE001 - surface provider failure to the UI.
        fred_error = str(exc)

    needs_longer_market_history = False
    if fred_result and start and entry.get("yahoo"):
        first = date.fromisoformat(fred_result["firstDate"])
        missing_days = (first - start).days
        needs_longer_market_history = missing_days > 180

    if entry.get("yahoo") and (fred_result is None or needs_longer_market_history):
        try:
            yahoo_result = fetch_yahoo_chart(entry["yahoo"], start, end)
            yahoo_result.update(
                {
                    "id": entry["id"],
                    "name": entry.get("yahooName") or entry["name"],
                    "unit": entry["unit"],
                    "origin": entry.get("origin"),
                    "resolution": entry.get("resolution", "curated fallback mapping"),
                    "fallbackReason": (
                        "FRED history was materially shorter than the requested range."
                        if needs_longer_market_history
                        else f"FRED failed: {fred_error}"
                    ),
                }
            )
            return yahoo_result
        except Exception as yahoo_exc:
            if fred_result:
                fred_result["fallbackError"] = str(yahoo_exc)
            else:
                raise RuntimeError(
                    f"{entry['name']} failed from FRED ({fred_error}) and Yahoo ({yahoo_exc})."
                ) from yahoo_exc

    if not fred_result:
        raise RuntimeError(f"{entry['name']} failed from FRED: {fred_error}")

    fred_result.update(
        {
            "name": entry["name"],
            "unit": entry["unit"],
            "origin": entry.get("origin"),
            "resolution": entry.get("resolution", "curated series mapping"),
            "measureType": entry.get("measureType"),
            "preferredUnits": entry.get("preferredUnits"),
        }
    )
    return fred_result


MACRO_DASHBOARD_SERIES = ("SP500", "VIXCLS", "DGS10", "EFFR", "UNRATE", "CPILFESL")


def macro_dashboard_payload() -> dict[str, Any]:
    """Build a fast, partial-failure-safe landing snapshot from verified series."""
    end = today_local()
    start = end - timedelta(days=430)

    def fetch_card(series_id: str) -> dict[str, Any]:
        series = fetch_display_series(CATALOG_BY_ID[series_id], start, end)
        observations = series.get("observations") or []
        if not observations:
            raise RuntimeError(f"No observations returned for {series_id}.")

        values = [float(row["value"]) for row in observations]
        latest = values[-1]
        comparison_value = values[-2] if len(values) > 1 else latest
        change_label = "Previous observation"
        change_unit = "percent"
        display_value = latest
        display_unit = series.get("unit") or CATALOG_BY_ID[series_id].get("unit")

        if series_id in {"DGS10", "EFFR"}:
            comparison_value = values[max(0, len(values) - 22)]
            change = (latest - comparison_value) * 100
            change_label = "1-month change"
            change_unit = "basis-points"
        elif series_id == "UNRATE":
            comparison_value = values[max(0, len(values) - 13)]
            change = latest - comparison_value
            change_label = "12-month change"
            change_unit = "percentage-points"
        elif series_id == "CPILFESL":
            comparison_value = values[max(0, len(values) - 13)]
            change = ((latest / comparison_value) - 1) * 100 if comparison_value else 0.0
            display_value = change
            display_unit = "Percent change from year ago"
            change_label = "Core CPI inflation"
            change_unit = "year-over-year"
        else:
            change = ((latest / comparison_value) - 1) * 100 if comparison_value else 0.0

        return {
            "id": series_id,
            "name": series.get("name") or CATALOG_BY_ID[series_id]["name"],
            "value": display_value,
            "rawLatest": latest,
            "unit": display_unit,
            "change": change,
            "changeLabel": change_label,
            "changeUnit": change_unit,
            "asOf": observations[-1]["date"],
            "provider": series.get("provider") or series.get("origin") or "Verified provider",
            "providerSeries": series.get("providerSeries") or series.get("symbol") or series_id,
            "sourceUrl": series.get("sourceUrl"),
            "sparkline": observations[-64:],
        }

    cards_by_id: dict[str, dict[str, Any]] = {}
    errors_by_id: dict[str, str] = {}
    errors: list[dict[str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(MACRO_DASHBOARD_SERIES)) as executor:
        futures = {
            executor.submit(fetch_card, series_id): series_id
            for series_id in MACRO_DASHBOARD_SERIES
        }
        for future in concurrent.futures.as_completed(futures):
            series_id = futures[future]
            try:
                cards_by_id[series_id] = future.result()
            except Exception as exc:  # noqa: BLE001 - one unavailable source must not blank the dashboard.
                error = str(exc)[:500]
                errors_by_id[series_id] = error
                errors.append({"id": series_id, "error": error})

    loaded_count = len(cards_by_id)
    cards = [
        cards_by_id.get(series_id)
        or {
            "id": series_id,
            "name": CATALOG_BY_ID[series_id]["name"],
            "unit": CATALOG_BY_ID[series_id]["unit"],
            "unavailable": True,
            "error": errors_by_id.get(series_id, "Provider data is temporarily unavailable."),
            "sparkline": [],
        }
        for series_id in MACRO_DASHBOARD_SERIES
    ]
    return {
        "generatedAt": utc_now_iso(),
        "cards": cards,
        "loadedCount": loaded_count,
        "errors": errors,
        "status": "pass" if not errors else ("partial" if loaded_count else "failed"),
        "backend": backend_status(),
    }


def handle_fred_query(
    prompt: str,
    start_override: date | None = None,
    end_override: date | None = None,
    clarifications: dict[str, Any] | None = None,
) -> dict[str, Any]:
    clarification_answers, submitted_clarification_token = validate_macro_clarifications(
        clarifications
    )
    selected, resolution_notices = resolve_prompt_series(prompt)
    request_contract = parse_macro_request_contract(prompt)
    unsupported_presentation = list(
        (request_contract.get("presentation") or {}).get("unsupported") or []
    )
    intent_resolution: dict[str, Any] = {
        "parser": "deterministic",
        "usedModel": False,
        "model": None,
        "dataValuesFromModel": False,
        "requestContract": request_contract,
        "modelRouting": {
            "status": "not-needed",
            "attempted": False,
            "model": None,
            "inputConcepts": [],
            "accepted": [],
            "rejected": [],
        },
    }
    if unsupported_presentation:
        resolution_notices.extend(
            f"Presentation wording '{span}' was not supported as a chart style; the resolved data "
            "was built with safe assumptions and can be adjusted in Edit graph."
            for span in unsupported_presentation
        )
    unresolved_pairs: list[tuple[str, str]] = []
    for operand in request_contract["operands"]:
        clause, _notices = normalize_macro_concept_phrasing(operand["sourceSpan"])
        residual = unresolved_clause_residual(clause)
        dynamic_match = any(
            macro_providers.normalize_quantitative_phrasing(str(entry.get("resolvedClause") or ""))
            == macro_providers.normalize_quantitative_phrasing(residual)
            for entry in selected
            if entry.get("resolvedClause")
        )
        if macro_providers.clause_is_handled(clause, selected) or dynamic_match:
            continue
        if not residual or not filter_satisfied_macro_residuals([residual], selected):
            continue
        unresolved_pairs.append((clause.strip(), residual))

    # Clarification and model routing receive complete operand spans. Residuals are
    # used only to detect whether an operand still has unresolved meaning.
    missing_concepts = list(dict.fromkeys(clause for clause, _residual in unresolved_pairs))
    if re.search(r"\bbusiness investment\b", prompt, re.IGNORECASE) and not re.search(
        r"\b(?:private nonresidential fixed investment|pnfi(?:c1)?)\b",
        prompt,
        re.IGNORECASE,
    ):
        missing_concepts = [
            concept
            for concept in missing_concepts
            if not re.search(r"\bbusiness investment\b", concept, re.IGNORECASE)
        ]
    domain_clarification_pending = ambiguous_us_debt_scope(prompt)
    remaining_missing = [
        concept
        for concept in missing_concepts
        if not (domain_clarification_pending and re.search(r"\bdebt\b", concept, re.IGNORECASE))
    ]
    if (not selected and not domain_clarification_pending) or remaining_missing:
        model_status = model_router.ollama_status()
        source_concepts = remaining_missing or [
            str(operand.get("sourceSpan") or "").strip()
            for operand in request_contract.get("operands") or []
            if str(operand.get("sourceSpan") or "").strip()
        ]
        source_concepts = source_concepts or [
            str(request_contract.get("conceptText") or "").strip()
        ]
        intent_resolution["modelRouting"].update(
            {
                "model": model_status.get("model"),
                "inputConcepts": source_concepts,
                "status": "available" if model_status.get("ready") else "unavailable",
            }
        )
        protected_sources = [
            concept
            for concept in source_concepts
            if protected_macro_quantitative_qualifiers(concept)
        ]
        if model_status["ready"] and not protected_sources:
            intent_resolution["modelRouting"].update(
                {"status": "attempted", "attempted": True}
            )
            canonical_queries: list[str] = []
            model = str(model_status.get("model") or "")
            model_prompt = "; ".join(source_concepts)
            selected_before_model = len(selected)
            successful_queries: list[str] = []
            try:
                canonical_queries, model = model_router.macro_intent(model_prompt)
                intent_resolution["modelRouting"]["model"] = model
                safe_queries, _unresolved, rejected_rewrites = validate_macro_model_mappings(
                    source_concepts,
                    canonical_queries,
                )
                intent_resolution["modelRouting"]["rejected"].extend(rejected_rewrites)
                resolution_notices.extend(rejected_rewrites)
                for query in safe_queries:
                    resolved, notices = resolve_prompt_series(query, allow_fred_search=False)
                    if resolved:
                        successful_queries.append(query)
                    for entry in resolved:
                        if all(existing["id"] != entry["id"] for existing in selected):
                            selected.append(entry)
                    resolution_notices.extend(notices)
                _accepted, remaining_missing, _rejected = validate_macro_model_mappings(
                    source_concepts,
                    successful_queries,
                )
                intent_resolution["modelRouting"]["accepted"].extend(successful_queries)
                intent_resolution["modelRouting"]["rejected"].extend(_rejected)
            except Exception as exc:  # noqa: BLE001 - a failed optional router must remain advisory.
                intent_resolution["modelRouting"].update(
                    {"status": "rejected", "rejected": [str(exc)]}
                )
                resolution_notices.append(f"The local model could not map the remaining wording safely: {exc}")
            if len(selected) > selected_before_model and successful_queries:
                intent_resolution["modelRouting"]["status"] = "accepted"
                intent_resolution.update(
                    {
                        "parser": "deterministic+local-open-model" if selected_before_model else "local-open-model",
                        "usedModel": True,
                        "model": model,
                        "canonicalQueries": successful_queries,
                        "missingConceptsSubmitted": source_concepts,
                    }
                )
                resolution_notices.append(
                    "A constrained local model translated wording only; allowlisted providers "
                    "and deterministic calculations supplied every data value."
                )
        elif model_status["ready"] and protected_sources:
            intent_resolution["modelRouting"]["status"] = "skipped-protected-qualifier"
            resolution_notices.append(
                "The local wording model was not used because the unresolved concept contains a "
                "percentile, ranked count, or numeric threshold that requires an exact structured "
                "provider mapping."
            )
    if remaining_missing:
        question_ids = [f"unresolved_concept_{index + 1}" for index in range(len(remaining_missing))]
        return {
            "prompt": prompt,
            "requiresClarification": True,
            "clarification": {
                "token": macro_clarification_token(prompt, question_ids),
                "questions": [
                    {
                        "id": question_id,
                        "kind": "concept-edit",
                        "title": "Correct the unresolved data concept",
                        "concept": concept,
                        "question": (
                            f"I could not map '{concept}' to an exact, auditable provider series without "
                            "changing its meaning. Edit that concept in the request above; no substitute "
                            "series or unrelated chart has been loaded."
                        ),
                        "options": [],
                    }
                    for question_id, concept in zip(question_ids, remaining_missing)
                ],
                "answers": {},
                "seriesPreview": [
                    {
                        "id": entry.get("id"),
                        "name": entry.get("name"),
                        "provider": entry.get("origin"),
                    }
                    for entry in selected
                ],
                "editPromptRequired": True,
            },
            "resolutionNotices": resolution_notices,
            "intentResolution": intent_resolution,
            "generatedAt": utc_now_iso(),
            "backend": backend_status(),
        }
    initial_clarification_questions = macro_clarification_questions(prompt, selected, {})
    initial_question_ids = [question["id"] for question in initial_clarification_questions]
    if not selected and not initial_clarification_questions:
        model_status = model_router.ollama_status()
        raise ValueError(
            (
                resolution_notices[0]
                if resolution_notices
                else "I could not identify a supported series. Include a series name, FRED series ID, or market symbol."
            )
            + f" Local fallback status: {model_status['message']}"
        )

    expected_clarification_token = macro_clarification_token(prompt, initial_question_ids)
    if clarification_answers:
        if not initial_question_ids or not hmac.compare_digest(
            submitted_clarification_token,
            expected_clarification_token,
        ):
            raise ValueError(
                "These clarification answers do not belong to this request. Please submit the prompt again."
            )
        unexpected_answers = set(clarification_answers) - set(initial_question_ids)
        if unexpected_answers:
            raise ValueError(
                "A clarification answer was supplied for a concept this request did not ask about."
            )

    selected, clarification_notices = apply_macro_series_clarifications(
        selected,
        clarification_answers,
    )
    resolution_notices.extend(clarification_notices)
    clarification_questions = macro_clarification_questions(
        prompt,
        selected,
        clarification_answers,
    )
    if clarification_questions:
        return {
            "prompt": prompt,
            "requiresClarification": True,
            "clarification": {
                "token": expected_clarification_token,
                "questions": clarification_questions,
                "answers": clarification_answers,
                "seriesPreview": [
                    {
                        "id": entry.get("id"),
                        "name": entry.get("name"),
                        "provider": entry.get("origin"),
                    }
                    for entry in selected
                ],
            },
            "intentResolution": intent_resolution,
            "generatedAt": utc_now_iso(),
            "backend": backend_status(),
        }

    requested_range = parse_requested_range(prompt)
    if start_override is not None:
        requested_range["start"] = start_override
    if end_override is not None:
        requested_range["end"] = end_override
    if start_override is not None or end_override is not None:
        start_label = requested_range["start"].isoformat() if requested_range["start"] else "earliest"
        end_label = requested_range["end"].isoformat() if requested_range["end"] else "latest"
        requested_range["label"] = f"{start_label} to {end_label}"
    if (
        requested_range["start"] is not None
        and requested_range["end"] is not None
        and requested_range["start"] > requested_range["end"]
    ):
        raise ValueError("The requested start date must not be after the end date.")
    series_results: list[dict[str, Any]] = []
    series_errors: list[dict[str, str]] = []
    for entry in selected:
        try:
            series_results.append(
                fetch_display_series(entry, requested_range["start"], requested_range["end"])
            )
        except NetworkPolicyError:
            raise
        except Exception as exc:  # noqa: BLE001 - keep other requested series usable and visible.
            fallback = entry.get("promptFallback")
            if fallback:
                try:
                    result = fetch_display_series(
                        fallback,
                        requested_range["start"],
                        requested_range["end"],
                    )
                    result["resolution"] = (
                        f"Prompt-approved substitute for {entry['name']} after the primary failed: {exc}"
                    )
                    result["fallbackFor"] = entry["id"]
                    series_results.append(result)
                    resolution_notices.append(
                        f"{fallback['name']} replaced {entry['name']} because every configured "
                        f"primary source failed: {exc}"
                    )
                    continue
                except NetworkPolicyError:
                    raise
                except Exception as fallback_exc:  # noqa: BLE001
                    exc = RuntimeError(
                        f"{exc}; prompt-approved substitute {fallback['name']} also failed: {fallback_exc}"
                    )
            series_errors.append({"id": entry["id"], "name": entry["name"], "error": str(exc)[:800]})
    if not series_results:
        detail = " | ".join(f"{row['name']}: {row['error']}" for row in series_errors)
        raise RuntimeError(f"No requested series could be loaded. {detail}")
    if series_errors:
        detail = " | ".join(f"{row['name']}: {row['error']}" for row in series_errors)
        raise RuntimeError(
            "The complete requested comparison could not be loaded, so no partial chart was shown. "
            + detail
        )
    for series in series_results:
        series["quality"] = validate_series_result(series, requested_range["start"])
    chart_config = parse_chart_intent(prompt, series_results, request_contract)
    resolution_notices.extend(
        apply_macro_chart_clarifications(chart_config, clarification_answers)
    )
    sources: list[dict[str, Any]] = []
    seen_source_urls: set[str] = set()
    for series in series_results:
        candidates = [
            {
                "name": str(series.get("provider") or series.get("name") or "Data source"),
                "url": str(series.get("sourceUrl") or "").strip(),
                "role": f"{series.get('name')} ({series.get('providerSeries') or series.get('id')})",
            },
            *(series.get("supportingSources") or []),
        ]
        for candidate in candidates:
            source_url = str(candidate.get("url") or "").strip()
            if not source_url or source_url in seen_source_urls:
                continue
            seen_source_urls.add(source_url)
            sources.append(
                {
                    "name": str(candidate.get("name") or "Data source"),
                    "url": source_url,
                    "role": str(candidate.get("role") or "Supporting source"),
                }
            )
    resolution_gap_markers = (
        "unresolved request",
        "unresolved term",
        "could not identify",
        "did not exactly match",
        "not mapped",
        "not available for",
        "no official fred search result matched",
        "no configured provider matched",
        "no configured provider exactly matched",
        "official fred search failed",
        "too broad for a safe provider search",
    )
    resolution_gaps = [
        notice
        for notice in resolution_notices
        if any(marker in notice.lower() for marker in resolution_gap_markers)
    ]
    quality_reviews = [
        series["id"]
        for series in series_results
        if series.get("quality", {}).get("status") == "review"
    ]
    verification_status = (
        "partial" if series_errors or resolution_gaps or quality_reviews else "pass"
    )
    return {
        "prompt": prompt,
        "range": {
            "label": requested_range["label"],
            "start": requested_range["start"].isoformat() if requested_range["start"] else None,
            "end": requested_range["end"].isoformat() if requested_range["end"] else None,
        },
        "series": series_results,
        "chartDefault": (
            "raw"
            if chart_config["series"]
            and all(spec["units"] == "raw" for spec in chart_config["series"])
            else "normalized_to_100"
        ),
        "chartConfig": chart_config,
        "presentationReview": {
            "unsupported": unsupported_presentation,
            "builtWithAssumptions": bool(unsupported_presentation),
            "editAction": "Edit graph",
        },
        "resolutionNotices": resolution_notices,
        "seriesErrors": series_errors,
        "sources": sources,
        "intentResolution": intent_resolution,
        "clarifications": clarification_answers,
        "verification": {
            "status": verification_status,
            "seriesValidated": len(series_results),
            "seriesFailed": len(series_errors),
            "unresolvedConcepts": len(resolution_gaps),
            "seriesNeedingReview": len(quality_reviews),
            "dataValuesFromModel": False,
            "method": "Provider coverage, observation, source, and calculation checks",
        },
        "notes": [
            "Each series keeps its own explicit transformation. Heterogeneous native units use independent raw-value axes unless the request explicitly asks for one axis or normalization.",
            "The table keeps the raw latest values and provider/source for auditability.",
            "Requests are routed across direct government, market, index-fundamentals, SEC, World Bank, and FRED providers; FRED is not the default for every unresolved concept.",
            "Market indexes and explicit price requests use a market-price provider; company fundamentals use SEC Company Facts when an explicit ticker and supported metric are provided.",
            "FRED results are fetched without local caching. A FRED API key enables only the final FRED metadata-search fallback.",
        ],
        "generatedAt": utc_now_iso(),
        "backend": backend_status(),
    }


FED_MONTH_NAMES = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


def parse_fed_tracker_intent(prompt: str, meeting_dates: list[str]) -> dict[str, Any]:
    text, typo_corrections = intent_contract.normalize_known_typos(prompt)
    text = text.lower().strip()
    meeting_dates = sorted(dict.fromkeys(meeting_dates))
    today = date.today()
    future_meeting_dates = [
        value for value in meeting_dates if date.fromisoformat(value) >= today
    ]
    if re.search(
        r"\b(?:backtest|calculate|compute|sum|average|mean|median|forecast|predict|"
        r"download|export|email|odds ratio)\b|\bwhat is the probability\b|[{}]",
        text,
    ):
        raise ValueError(
            "That request asks for a calculation, forecast, export, or direct answer. The Fed command box only changes verified tracker views and filters."
        )

    view = "current"
    recognized = False
    view_matches: list[str] = []
    if re.search(
        r"\bhistorical probabilities\b|\bprobability history\b|\bprobability path\b|"
        r"\bover time\b|\bfull[- ]history\b|\bevery available dated (?:odds|probability) snapshot\b",
        text,
    ):
        view_matches.append("historical")
    if re.search(
        r"\bcompare\b|\bcontrast\b|\bversus\b|\bvs\.?\b|\bweek[ -]over[ -]week\b|"
        r"\bchanged?\b[^.]{0,30}\b(?:last|prior|previous) week\b",
        text,
    ):
        view_matches.append("compare")
    if re.search(
        r"\ball (?:meetings?|meeting probabilities|probabilities)\b|\bmatrix\b|"
        r"\bfull upcoming fomc outcomes table\b|\bmeeting-by-meeting\b",
        text,
    ):
        view_matches.append("probabilities")
    # Meeting selection and display mode are independent slots. In particular,
    # "compare next meeting to prior snapshots" selects the next meeting while
    # retaining the comparison view; "next meeting" must not imply current view.
    if re.search(
        r"\bcurrent\s+(?:meeting\s+)?probabilit(?:y|ies)\b|"
        r"\bcurrent\b[^.]{0,35}\b(?:odds|probabilit(?:y|ies))\b|"
        r"\blatest\s+(?:odds|probabilit(?:y|ies))\b|\bcurrent\s+view\b",
        text,
    ):
        view_matches.append("current")
    view_matches = list(dict.fromkeys(view_matches))
    if (
        "compare" in view_matches
        and "current" in view_matches
        and re.search(
            r"\bcurrent\s+(?:odds|probabilit(?:y|ies))\b[^.]{0,45}"
            r"\b(?:prior|earlier|previous|dated)\b[^.]{0,25}\bsnapshots?\b",
            text,
        )
    ):
        view_matches.remove("current")
    if len(view_matches) > 1:
        raise ValueError("The request contains conflicting Fed Tracker views. Choose current, compare, historical, or all meetings.")
    if view_matches:
        view = view_matches[0]
        recognized = True

    history_range = "1Y"
    range_patterns = [
        (r"\ball (?:available|history)\b|\bevery available\b|\bfull[- ]history\b|\bmax\b", "ALL"),
        (r"\b(?:last\s+)?1\s*(?:month|mo)\b", "1M"),
        (r"\b(?:last\s+)?3\s*(?:months?|mos?)\b", "3M"),
        (r"\b(?:last\s+)?6\s*(?:months?|mos?)\b", "6M"),
        (r"\b(?:last\s+)?1\s*(?:year|yr)\b", "1Y"),
    ]
    matched_ranges = [value for pattern, value in range_patterns if re.search(pattern, text)]
    matched_ranges = list(dict.fromkeys(matched_ranges))
    if len(matched_ranges) > 1:
        raise ValueError("The request contains more than one history window. Choose one range.")
    if matched_ranges:
        history_range = matched_ranges[0]
        recognized = True

    meeting_candidates: list[str] = []
    iso_tokens = re.findall(r"\b\d{4}-\d{2}-\d{2}\b", text)
    for token in iso_tokens:
        try:
            date.fromisoformat(token)
        except ValueError as exc:
            raise ValueError(f"Invalid meeting date: {token}.") from exc
        if token not in meeting_dates:
            raise ValueError(f"{token} is not one of the published meeting dates in this tracker.")
        meeting_candidates.append(token)

    slash_tokens = re.findall(r"\b\d{1,2}/\d{1,2}/\d{4}\b", text)
    for token in slash_tokens:
        try:
            parsed = datetime.strptime(token, "%m/%d/%Y").date().isoformat()
        except ValueError as exc:
            raise ValueError(f"Invalid meeting date: {token}.") from exc
        if parsed not in meeting_dates:
            raise ValueError(f"{token} is not one of the published meeting dates in this tracker.")
        meeting_candidates.append(parsed)

    month_aliases = {
        **FED_MONTH_NAMES,
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7,
        "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
    }
    month_mentions: list[tuple[int, int | None]] = []
    for name, month in month_aliases.items():
        for match in re.finditer(rf"\b{re.escape(name)}(?:uary|ruary|ch|il|e|y|ust|ember|ober)?\b(?:\s+(20\d{{2}}))?", text):
            month_mentions.append((month, int(match.group(1)) if match.group(1) else None))
    month_mentions = list(dict.fromkeys(month_mentions))
    if len(month_mentions) > 1:
        raise ValueError("The request names more than one meeting month, but this view supports one selected meeting.")
    if month_mentions:
        month, year = month_mentions[0]
        candidates = [
            value
            for value in meeting_dates
            if date.fromisoformat(value).month == month
            and (year is None or date.fromisoformat(value).year == year)
        ]
        if year is None:
            future_candidates = [
                value for value in candidates if date.fromisoformat(value) >= today
            ]
            candidates = future_candidates or candidates[-1:]
        if not candidates:
            label = f"{month:02d}/{year}" if year else f"month {month}"
            raise ValueError(f"No published meeting matches {label} in the current tracker calendar.")
        if year is None and len(candidates) > 1:
            candidates = candidates[:1]
        meeting_candidates.append(candidates[0])

    meeting_candidates = list(dict.fromkeys(meeting_candidates))
    if len(meeting_candidates) > 1:
        raise ValueError("The request names more than one meeting, but this view supports one selected meeting.")
    meeting_date = meeting_candidates[0] if meeting_candidates else None
    meeting_selection = "explicit" if meeting_date else "default"
    if not meeting_date and re.search(r"\b(?:next|latest|upcoming|nearest)[ -](?:fomc[ -])?meeting\b", text):
        meeting_date = (
            future_meeting_dates[0]
            if future_meeting_dates
            else (meeting_dates[-1] if meeting_dates else None)
        )
        meeting_selection = "next"
    if meeting_date:
        recognized = True

    comparison_dates: list[str] = []
    if view == "compare":
        comparison_dates = (
            ["current", "one-week-prior"]
            if re.search(r"\b(?:week[ -]over[ -]week|last week|prior week|previous week)\b", text)
            else ["current", "prior-available"]
        )
    outcome_selection = "all"
    if re.search(r"\b(?:rate\s+)?hikes?|\braises? rates?\b", text):
        outcome_selection = "hike"
    elif re.search(r"\b(?:rate\s+)?cuts?|\blowers? rates?\b", text):
        outcome_selection = "cut"
    elif re.search(r"\bhold\b|\bno change\b", text):
        outcome_selection = "hold"
    if outcome_selection != "all":
        recognized = True
    chart_type = "line" if view in {"historical", "compare"} else "bar"

    parser = "deterministic"
    model = None
    if not recognized and model_router.ollama_status()["ready"]:
        spec, model = model_router.fed_intent(prompt, meeting_dates)
        view = spec["view"]
        meeting_date = spec["meetingDate"]
        history_range = spec["historyRange"]
        parser = "local-open-model"
        recognized = True
    if not recognized:
        status = model_router.ollama_status()
        raise ValueError(
            "I could not map that request to Fed Tracker controls. Try 'historical probabilities "
            "for the September meeting over all available history'. "
            f"Local fallback status: {status['message']}"
        )
    # Recompute derived display slots after the optional wording model so the
    # contract always describes the final accepted controls.
    if parser == "local-open-model":
        meeting_selection = "explicit" if meeting_date else "default"
        comparison_dates = ["current", "prior-available"] if view == "compare" else []
        chart_type = "line" if view in {"historical", "compare"} else "bar"
    return {
        "prompt": prompt,
        "parser": parser,
        "usedModel": parser == "local-open-model",
        "model": model,
        "dataValuesFromModel": False,
        "spec": {
            "view": view,
            "meetingDate": meeting_date,
            "historyRange": history_range,
            "meetingSelection": meeting_selection,
            "comparisonDates": comparison_dates,
            "outcomeSelection": outcome_selection,
            "chartType": chart_type,
        },
        "requestContract": {
            "operation": "display-fed-probabilities",
            "view": view,
            "meetingSelection": meeting_selection,
            "meetingDate": meeting_date,
            "historyRange": history_range,
            "comparisonDates": comparison_dates,
            "outcomeSelection": outcome_selection,
            "chartType": chart_type,
            "presentation": "chart-and-table",
            "typoCorrections": typo_corrections,
        },
        "verification": {
            "status": "pass",
            "meetingRestrictedToPublishedCalendar": True,
            "dataValuesFromModel": False,
        },
    }


MONTH_CODES = {
    1: "F",
    2: "G",
    3: "H",
    4: "J",
    5: "K",
    6: "M",
    7: "N",
    8: "Q",
    9: "U",
    10: "V",
    11: "X",
    12: "Z",
}
MONTH_NAMES = {
    1: "JAN",
    2: "FEB",
    3: "MAR",
    4: "APR",
    5: "MAY",
    6: "JUN",
    7: "JUL",
    8: "AUG",
    9: "SEP",
    10: "OCT",
    11: "NOV",
    12: "DEC",
}
MONTH_NAME_TO_NUMBER = {name: number for number, name in MONTH_NAMES.items()}

# FOMC decision dates. Source: Federal Reserve FOMC calendars page.
FOMC_MEETINGS: list[date] = [
    date(2022, 1, 26),
    date(2022, 3, 16),
    date(2022, 5, 4),
    date(2022, 6, 15),
    date(2022, 7, 27),
    date(2022, 9, 21),
    date(2022, 11, 2),
    date(2022, 12, 14),
    date(2023, 2, 1),
    date(2023, 3, 22),
    date(2023, 5, 3),
    date(2023, 6, 14),
    date(2023, 7, 26),
    date(2023, 9, 20),
    date(2023, 11, 1),
    date(2023, 12, 13),
    date(2024, 1, 31),
    date(2024, 3, 20),
    date(2024, 5, 1),
    date(2024, 6, 12),
    date(2024, 7, 31),
    date(2024, 9, 18),
    date(2024, 11, 7),
    date(2024, 12, 18),
    date(2025, 1, 29),
    date(2025, 3, 19),
    date(2025, 5, 7),
    date(2025, 6, 18),
    date(2025, 7, 30),
    date(2025, 9, 17),
    date(2025, 10, 29),
    date(2025, 12, 10),
    date(2026, 1, 28),
    date(2026, 3, 18),
    date(2026, 4, 29),
    date(2026, 6, 17),
    date(2026, 7, 29),
    date(2026, 9, 16),
    date(2026, 10, 28),
    date(2026, 12, 9),
    date(2027, 1, 27),
    date(2027, 3, 17),
    date(2027, 4, 28),
    date(2027, 6, 9),
    date(2027, 7, 28),
    date(2027, 9, 15),
    date(2027, 10, 27),
    date(2027, 12, 8),
    date(2028, 1, 26),
]


def parse_fomc_calendar_html(text: str) -> list[date]:
    year_markers = list(
        re.finditer(r"<h4><a[^>]*>(\d{4})\s+FOMC Meetings</a></h4>", text, re.IGNORECASE)
    )
    parsed: set[date] = set()
    meeting_pattern = re.compile(
        r"fomc-meeting__month[^>]*>\s*<strong>([^<]+)</strong>\s*</div>\s*"
        r"<div[^>]*fomc-meeting__date[^>]*>([^<]+)</div>",
        re.IGNORECASE,
    )
    for index, marker in enumerate(year_markers):
        year = int(marker.group(1))
        end = year_markers[index + 1].start() if index + 1 < len(year_markers) else len(text)
        block = text[marker.end() : end]
        for match in meeting_pattern.finditer(block):
            month_text, day_text = match.groups()
            if "notation vote" in day_text.lower():
                continue
            month_parts = re.findall(r"[A-Za-z]+", month_text)
            day_parts = [int(value) for value in re.findall(r"\d+", day_text)]
            if not month_parts or not day_parts:
                continue
            month_number = MONTH_NAME_TO_NUMBER.get(month_parts[-1][:3].upper())
            if not month_number:
                continue
            try:
                parsed.add(date(year, month_number, day_parts[-1]))
            except ValueError:
                continue

    for match in re.finditer(
        r"two-day meeting is scheduled for\s+([A-Za-z]+)\s+(\d+)-(\d+),\s+(\d{4})",
        text,
        re.IGNORECASE,
    ):
        month_number = MONTH_NAME_TO_NUMBER.get(match.group(1)[:3].upper())
        if month_number:
            parsed.add(date(int(match.group(4)), month_number, int(match.group(3))))
    return sorted(parsed)


def get_fomc_calendar() -> dict[str, Any]:
    source_url = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"

    def load_live() -> list[date]:
        html = http_get_text(source_url, cache_ttl=24 * 60 * 60)
        meetings = parse_fomc_calendar_html(html)
        if len(meetings) < 8:
            raise RuntimeError("Federal Reserve calendar page returned too few parsed meetings.")
        return meetings

    try:
        live = cache_get("fomc-calendar-live", 24 * 60 * 60, load_live)
        live_years = {meeting.year for meeting in live}
        meetings = sorted(
            {meeting for meeting in FOMC_MEETINGS if meeting.year not in live_years} | set(live)
        )
        return {
            "meetings": meetings,
            "provider": "Federal Reserve live calendar + bundled historical fallback",
            "sourceUrl": source_url,
            "liveMeetingCount": len(live),
            "coverageEnd": meetings[-1].isoformat(),
            "warning": None,
        }
    except Exception as exc:  # noqa: BLE001 - calendar fallback must not disable the tracker.
        return {
            "meetings": FOMC_MEETINGS,
            "provider": "Bundled Federal Reserve calendar snapshot",
            "sourceUrl": source_url,
            "liveMeetingCount": 0,
            "coverageEnd": FOMC_MEETINGS[-1].isoformat(),
            "warning": f"Live calendar refresh failed; bundled dates were used: {exc}",
        }


def previous_business_day(d: date) -> date:
    d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def business_day_on_or_before(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def month_key(year: int, month: int) -> str:
    return f"{MONTH_NAMES[month]} {year % 100:02d}"


def parse_month_key(key: str) -> tuple[int, int] | None:
    parts = key.strip().upper().split()
    if len(parts) != 2 or parts[0] not in MONTH_NAME_TO_NUMBER:
        return None
    try:
        yy = int(parts[1])
    except ValueError:
        return None
    return 2000 + yy, MONTH_NAME_TO_NUMBER[parts[0]]


def next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def contract_code(year: int, month: int) -> str:
    return f"ZQ{MONTH_CODES[month]}{year % 10}"


def yahoo_contract_symbols(year: int, month: int) -> list[str]:
    code = MONTH_CODES[month]
    return [f"ZQ{code}{year % 100:02d}.CBT", f"ZQ{code}{year % 10}.CBT"]


def iter_contract_months(start: date, end: date) -> list[tuple[int, int]]:
    months: list[tuple[int, int]] = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        months.append((year, month))
        year, month = next_month(year, month)
    return months


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    cleaned = str(value).strip().replace(",", "")
    if cleaned in {"", "-", "UNCH", "CAB"}:
        return None
    cleaned = cleaned.split()[0]
    try:
        return float(cleaned)
    except ValueError:
        return None


def fetch_fred_latest(series_id: str, lookback_days: int = 90, as_of: date | None = None) -> dict[str, Any]:
    end = as_of or today_local()
    start = end - timedelta(days=lookback_days)
    result = fetch_fred_series(series_id, start, end)
    return {
        "series": series_id,
        "value": result["latest"],
        "date": result["lastDate"],
        "source": "FRED",
        "sourceUrl": result["sourceUrl"],
    }


def find_nyfed_effr_row(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, dict):
        rates = payload.get("refRates")
        if isinstance(rates, list):
            for row in rates:
                if (
                    isinstance(row, dict)
                    and str(row.get("type", "")).upper() == "EFFR"
                    and parse_float(row.get("percentRate")) is not None
                ):
                    return row
        for value in payload.values():
            found = find_nyfed_effr_row(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = find_nyfed_effr_row(value)
            if found:
                return found
    return None


def fetch_nyfed_effr() -> dict[str, Any]:
    candidates = [
        "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
        "https://markets.newyorkfed.org/api/rates/all/latest.json",
    ]
    errors: list[str] = []
    for url in candidates:
        try:
            payload = http_get_json(url)
            row = find_nyfed_effr_row(payload)
            if row:
                return {
                    "series": "EFFR",
                    "value": float(row["percentRate"]),
                    "date": row.get("effectiveDate"),
                    "targetLower": parse_float(row.get("targetRateFrom")),
                    "targetUpper": parse_float(row.get("targetRateTo")),
                    "source": "New York Fed Markets API",
                    "sourceUrl": url,
                }
            errors.append(f"{url}: response did not contain a typed EFFR record")
        except NetworkPolicyError:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{url}: {exc}")
    raise RuntimeError("NY Fed EFFR lookup failed. " + " | ".join(errors))


def current_target_and_effr(as_of: date | None = None) -> dict[str, Any]:
    errors: list[str] = []
    effr: dict[str, Any] | None = None
    lower: dict[str, Any] | None = None
    upper: dict[str, Any] | None = None

    if as_of is None or as_of >= today_local() - timedelta(days=7):
        try:
            nyfed_effr = fetch_nyfed_effr()
            nyfed_date = date.fromisoformat(str(nyfed_effr["date"])) if nyfed_effr.get("date") else None
            if as_of is None or (nyfed_date and nyfed_date <= as_of):
                effr = nyfed_effr
            else:
                errors.append(
                    f"New York Fed EFFR date {nyfed_effr.get('date')} is after requested snapshot {as_of}."
                )
        except NetworkPolicyError:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc))

    for series_id, slot in [("DFEDTARL", "lower"), ("DFEDTARU", "upper")]:
        try:
            value = fetch_fred_latest(series_id, as_of=as_of)
            if slot == "lower":
                lower = value
            else:
                upper = value
        except NetworkPolicyError:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(f"FRED {series_id}: {exc}")

    if effr is None:
        for series_id in ["EFFR", "DFF", "FEDFUNDS"]:
            try:
                effr = fetch_fred_latest(series_id, as_of=as_of)
                break
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001
                errors.append(f"FRED {series_id}: {exc}")

    if effr is None:
        raise RuntimeError("Could not fetch current effective fed funds rate. " + " | ".join(errors))

    if lower and upper:
        lower_value = float(lower["value"])
        upper_value = float(upper["value"])
        target_source = {
            "source": "FRED",
            "lowerSeries": "DFEDTARL",
            "upperSeries": "DFEDTARU",
            "date": max(str(lower.get("date")), str(upper.get("date"))),
            "sourceUrl": "https://fred.stlouisfed.org/series/DFEDTARL",
            "secondarySourceUrl": "https://fred.stlouisfed.org/series/DFEDTARU",
        }
    elif effr.get("targetLower") is not None and effr.get("targetUpper") is not None:
        lower_value = float(effr["targetLower"])
        upper_value = float(effr["targetUpper"])
        target_source = {
            "source": "New York Fed Markets API",
            "date": effr.get("date"),
            "method": "Published EFFR targetRateFrom/targetRateTo fields",
            "sourceUrl": effr.get("sourceUrl"),
        }
    else:
        lower_value = math.floor(float(effr["value"]) * 4.0) / 4.0
        upper_value = lower_value + 0.25
        target_source = {
            "source": "Derived from effective fed funds rate",
            "method": "floor(EFFR to nearest 25 bps) to infer current target band",
            "sourceUrl": effr.get("sourceUrl"),
        }

    return {
        "effr": effr,
        "targetRange": {
            "lower": lower_value,
            "upper": upper_value,
            "midpoint": (lower_value + upper_value) / 2.0,
            "label": f"{lower_value:.2f}%-{upper_value:.2f}%",
            "source": target_source,
        },
        "errors": errors,
    }


def fetch_cme_settlements(as_of: date | None = None) -> dict[str, Any]:
    endpoint = "https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements/305/FUT"
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.quotes.html",
    }
    errors: list[str] = []
    latest_allowed = previous_business_day(today_local())
    trade_date = min(as_of or latest_allowed, latest_allowed)
    while trade_date.weekday() >= 5:
        trade_date = previous_business_day(trade_date + timedelta(days=1))
    for offset in range(10):
        query_date = trade_date - timedelta(days=offset)
        if query_date.weekday() >= 5:
            continue
        # CME accepts tradeDate with literal slashes. URL-encoding them as
        # 08%2F10%2F2026 can trigger CME's bot-block response.
        url = f"{endpoint}?tradeDate={query_date.strftime('%m/%d/%Y')}"
        try:
            payload = http_get_json(url, headers=headers)
            payload_date_text = str(payload.get("tradeDate") or "").strip()
            try:
                payload_date = datetime.strptime(payload_date_text, "%m/%d/%Y").date()
            except ValueError:
                try:
                    payload_date = date.fromisoformat(payload_date_text)
                except ValueError:
                    errors.append(
                        f"{query_date.isoformat()}: CME response omitted a valid tradeDate"
                    )
                    continue
            if payload_date != query_date:
                errors.append(
                    f"{query_date.isoformat()}: CME returned mismatched tradeDate {payload_date.isoformat()}"
                )
                continue
            if str(payload.get("reportType") or "").strip().lower() != "final":
                errors.append(
                    f"{query_date.isoformat()}: CME response was not a final settlement report"
                )
                continue
            rows = payload.get("settlements") or []
            parsed: list[dict[str, Any]] = []
            for row in rows:
                raw_month = str(row.get("month", "")).strip().upper()
                if raw_month == "TOTAL" or not raw_month:
                    continue
                settle = parse_float(row.get("settle"))
                if settle is None:
                    continue
                parsed_month = parse_month_key(raw_month)
                if not parsed_month:
                    continue
                year, month = parsed_month
                parsed.append(
                    {
                        "month": raw_month,
                        "year": year,
                        "monthNumber": month,
                        "contract": contract_code(year, month),
                        "settle": settle,
                        "impliedRate": round(100.0 - settle, 4),
                        "volume": parse_float(row.get("volume")),
                        "openInterest": parse_float(row.get("openInterest")),
                    }
                )
            if parsed:
                parsed.sort(key=lambda row: (row["year"], row["monthNumber"]))
                return {
                    "provider": "CME settlement API",
                    "tradeDate": payload_date.isoformat(),
                    "requestedAsOf": as_of.isoformat() if as_of else None,
                    "contracts": parsed,
                    "sourceUrl": endpoint,
                }
            errors.append(f"{query_date.isoformat()}: no parsed settlement rows")
        except NetworkPolicyError:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{query_date.isoformat()}: {exc}")
    raise RuntimeError("CME settlement lookup failed. " + " | ".join(errors[-4:]))


def fetch_yahoo_last_close(symbol: str) -> dict[str, Any]:
    encoded_symbol = urllib.parse.quote(symbol, safe="")
    payload = http_get_json(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded_symbol}",
        params={"range": "10d", "interval": "1d"},
    )
    result = (payload.get("chart", {}).get("result") or [None])[0]
    if not result:
        raise RuntimeError(f"Yahoo returned no result for {symbol}")
    timestamps = result.get("timestamp") or []
    close = ((result.get("indicators", {}).get("quote") or [{}])[0]).get("close") or []
    rows = [(ts, value) for ts, value in zip(timestamps, close) if value is not None]
    if not rows:
        raise RuntimeError(f"Yahoo returned no close data for {symbol}")
    ts, value = rows[-1]
    return {
        "symbol": symbol,
        "settle": float(value),
        "date": datetime.fromtimestamp(int(ts), timezone.utc).date().isoformat(),
    }


def fetch_yahoo_fed_funds_strip(month_count: int = 18) -> dict[str, Any]:
    start = today_local().replace(day=1)
    contracts: list[dict[str, Any]] = []
    errors: list[str] = []
    for offset in range(month_count):
        month_date = add_months(start, offset)
        year = month_date.year
        month = month_date.month
        for symbol in yahoo_contract_symbols(year, month):
            try:
                quote = fetch_yahoo_last_close(symbol)
                contracts.append(
                    {
                        "month": month_key(year, month),
                        "year": year,
                        "monthNumber": month,
                        "contract": contract_code(year, month),
                        "providerSymbol": symbol,
                        "settle": quote["settle"],
                        "impliedRate": round(100.0 - quote["settle"], 4),
                        "date": quote["date"],
                    }
                )
                break
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{symbol}: {exc}")
    if not contracts:
        raise RuntimeError("Yahoo fed funds futures lookup failed. " + " | ".join(errors[-8:]))
    return {
        "provider": "Yahoo Finance chart API",
        "tradeDate": max(row.get("date", "") for row in contracts),
        "contracts": contracts,
        "errors": errors[-6:],
        "sourceUrl": "https://finance.yahoo.com/",
    }


def fetch_yahoo_contract_history(
    year: int,
    month: int,
    start: date,
    end: date,
) -> dict[str, Any]:
    errors: list[str] = []
    for symbol in yahoo_contract_symbols(year, month):
        try:
            result = fetch_yahoo_chart(symbol, start, end)
            result.update(
                {
                    "year": year,
                    "monthNumber": month,
                    "month": month_key(year, month),
                    "contract": contract_code(year, month),
                    "providerSymbol": symbol,
                }
            )
            return result
        except NetworkPolicyError:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{symbol}: {exc}")
    raise RuntimeError(" | ".join(errors))


def latest_observation_on_or_before(
    observations: list[dict[str, Any]],
    requested: date,
    max_age_days: int,
) -> float | None:
    requested_text = requested.isoformat()
    for row in reversed(observations):
        row_text = str(row.get("date") or "")
        if row_text > requested_text:
            continue
        try:
            age = (requested - date.fromisoformat(row_text)).days
            value = float(row["value"])
        except (KeyError, TypeError, ValueError):
            continue
        return value if age <= max_age_days else None
    return None


def indicative_fed_probability_history(
    meeting_date: str,
    as_of: date,
    history_days: int = 366,
) -> dict[str, Any]:
    selected_meeting = date.fromisoformat(meeting_date)
    history_end = min(as_of, today_local())
    history_start = history_end - timedelta(days=history_days)
    calendar_info = get_fomc_calendar()
    calendar_dates = calendar_info["meetings"]
    if selected_meeting not in calendar_dates:
        raise ValueError(f"{meeting_date} is not in the verified FOMC calendar.")

    meeting_months = {(meeting.year, meeting.month) for meeting in calendar_dates}
    chain_end_year, chain_end_month = selected_meeting.year, selected_meeting.month
    while True:
        next_year, next_month_number = next_month(chain_end_year, chain_end_month)
        if (next_year, next_month_number) not in meeting_months:
            anchor_year, anchor_month = next_year, next_month_number
            break
        chain_end_year, chain_end_month = next_year, next_month_number
    months = iter_contract_months(
        date(selected_meeting.year, selected_meeting.month, 1),
        date(anchor_year, anchor_month, 1),
    )
    contract_histories: dict[str, dict[str, Any]] = {}
    contract_errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(months))) as executor:
        futures = {
            executor.submit(
                fetch_yahoo_contract_history,
                year,
                month,
                history_start - timedelta(days=10),
                history_end,
            ): (year, month)
            for year, month in months
        }
        for future in concurrent.futures.as_completed(futures):
            year, month = futures[future]
            key = month_key(year, month)
            try:
                contract_histories[key] = future.result()
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001
                contract_errors.append(f"{key}: {str(exc)[:280]}")

    selected_key = month_key(selected_meeting.year, selected_meeting.month)
    selected_history = contract_histories.get(selected_key)
    if not selected_history:
        raise RuntimeError(
            f"No public daily history was available for selected meeting contract {selected_key}. "
            + " | ".join(contract_errors[-4:])
        )

    rate_start = history_start - timedelta(days=14)
    rate_errors: list[str] = []

    def load_rate(series_ids: list[str]) -> dict[str, Any] | None:
        for series_id in series_ids:
            try:
                return fetch_fred_series(series_id, rate_start, history_end)
            except NetworkPolicyError:
                raise
            except Exception as exc:  # noqa: BLE001
                rate_errors.append(f"{series_id}: {exc}")
        return None

    effr_history = load_rate(["EFFR", "DFF", "FEDFUNDS"])
    lower_history = load_rate(["DFEDTARL"])
    upper_history = load_rate(["DFEDTARU"])
    if not effr_history:
        raise RuntimeError("Effective fed funds history was unavailable. " + " | ".join(rate_errors))

    candidate_dates = [
        date.fromisoformat(str(row["date"]))
        for row in selected_history["observations"]
        if history_start.isoformat() <= str(row.get("date")) <= history_end.isoformat()
    ]
    history: list[dict[str, Any]] = []
    skipped_dates = 0
    for snapshot_date in candidate_dates:
        current_rate = latest_observation_on_or_before(
            effr_history["observations"], snapshot_date, 10
        )
        lower_rate = (
            latest_observation_on_or_before(lower_history["observations"], snapshot_date, 10)
            if lower_history
            else None
        )
        upper_rate = (
            latest_observation_on_or_before(upper_history["observations"], snapshot_date, 10)
            if upper_history
            else None
        )
        if current_rate is None:
            skipped_dates += 1
            continue
        if lower_rate is None or upper_rate is None:
            lower_rate = math.floor(current_rate * 4.0) / 4.0

        contracts: list[dict[str, Any]] = []
        for key, contract_history in contract_histories.items():
            settle = latest_observation_on_or_before(
                contract_history["observations"], snapshot_date, 5
            )
            if settle is None:
                continue
            contracts.append(
                {
                    "month": key,
                    "year": contract_history["year"],
                    "monthNumber": contract_history["monthNumber"],
                    "contract": contract_history["contract"],
                    "providerSymbol": contract_history["providerSymbol"],
                    "settle": settle,
                    "impliedRate": round(100.0 - settle, 4),
                }
            )
        contracts.sort(key=lambda row: (row["year"], row["monthNumber"]))
        strip = {
            "provider": "Yahoo Finance daily ZQ close",
            "tradeDate": snapshot_date.isoformat(),
            "contracts": contracts,
        }
        results = calculate_meeting_probabilities(
            strip,
            current_rate,
            lower_rate,
            snapshot_date,
            calendar_dates,
        )
        selected_result = next(
            (row for row in results if row.get("date") == meeting_date),
            None,
        )
        if not selected_result:
            skipped_dates += 1
            continue
        history.append(
            {
                "date": snapshot_date.isoformat(),
                "provider": "Yahoo Finance daily ZQ close + official rate history",
                "quality": "indicative",
                "distribution": implied_target_level_distribution(
                    float(selected_result["impliedPostMeetingRate"]),
                    current_rate,
                    lower_rate,
                ),
                "contractSettlement": selected_result["settlement"],
                "impliedPostMeetingRate": selected_result["impliedPostMeetingRate"],
            }
        )

    if not history:
        raise RuntimeError(
            "Public futures histories did not provide enough overlapping contracts to reconstruct "
            f"{meeting_date}. " + " | ".join(contract_errors[-4:])
        )
    symbols = sorted(
        {
            history_row["providerSymbol"]
            for history_row in contract_histories.values()
            if history_row.get("providerSymbol")
        }
    )
    return {
        "history": history,
        "meta": {
            "requestedStart": history_start.isoformat(),
            "firstDate": history[0]["date"],
            "lastDate": history[-1]["date"],
            "observationCount": len(history),
            "skippedDates": skipped_dates,
            "contractCount": len(contract_histories),
            "missingContracts": contract_errors,
            "rateWarnings": rate_errors,
            "quality": "indicative",
        },
        "sources": [
            {
                "name": "Yahoo Finance 30-Day Fed Funds futures histories",
                "url": f"https://finance.yahoo.com/quote/{urllib.parse.quote(symbols[0])}"
                if symbols
                else "https://finance.yahoo.com/",
                "role": "Indicative daily futures closes",
            },
            {
                "name": "FRED effective fed funds and target range histories",
                "url": "https://fred.stlouisfed.org/series/EFFR",
                "role": "Historical policy-rate anchors",
            },
        ],
    }


def fetch_fed_funds_strip(as_of: date | None = None) -> dict[str, Any]:
    cache_key = f"fed-strip:cme:{as_of.isoformat() if as_of else 'latest'}"
    try:
        return cache_get(cache_key, 60 * 15, lambda: fetch_cme_settlements(as_of))
    except NetworkPolicyError:
        raise
    except Exception as cme_exc:
        if as_of and as_of < today_local():
            raise RuntimeError(
                f"CME did not return a settlement strip near {as_of.isoformat()}. Reliable historical FedWatch "
                "reconstruction requires licensed historical ZQ settlements or an imported official strip. "
                f"Provider detail: {cme_exc}"
            ) from cme_exc
        yahoo = cache_get("fed-strip:yahoo", 60 * 10, fetch_yahoo_fed_funds_strip)
        yahoo["fallbackReason"] = f"CME failed: {cme_exc}"
        return yahoo


def target_range_label(lower_bps: int) -> str:
    return f"{lower_bps / 100:.2f}%-{(lower_bps + 25) / 100:.2f}%"


def node_move_distribution(pre_rate: float, post_rate: float) -> list[dict[str, Any]]:
    expected_moves = (post_rate - pre_rate) / 0.25
    floor_move = math.floor(expected_moves)
    ceil_move = math.ceil(expected_moves)

    if floor_move == ceil_move:
        outcomes = [(floor_move, 1.0)]
    else:
        p_ceil = expected_moves - floor_move
        outcomes = [(floor_move, 1.0 - p_ceil), (ceil_move, p_ceil)]

    distribution: list[dict[str, Any]] = []
    for move_count, probability in outcomes:
        if probability <= 0.000001:
            continue
        action = "No change"
        if move_count > 0:
            action = f"{move_count * 25} bps hike"
        elif move_count < 0:
            action = f"{abs(move_count) * 25} bps cut"
        distribution.append(
            {
                "moveCount": int(move_count),
                "moveBps": int(move_count) * 25,
                "action": action,
                "probability": probability,
            }
        )
    distribution.sort(key=lambda row: row["moveBps"])
    return distribution


def convolve_move_distributions(
    left: dict[int, float], right: list[dict[str, Any]]
) -> dict[int, float]:
    output: dict[int, float] = {}
    for existing_moves, existing_probability in left.items():
        for outcome in right:
            total_moves = existing_moves + int(outcome["moveCount"])
            output[total_moves] = output.get(total_moves, 0.0) + existing_probability * float(
                outcome["probability"]
            )
    return output


def rounded_percentages(probabilities: list[float], digits: int = 1) -> list[float]:
    """Round a probability vector while preserving an exact displayed total of 100%."""
    if not probabilities:
        return []
    scale = 10**digits
    exact_units = [max(0.0, value) * 100.0 * scale for value in probabilities]
    units = [math.floor(value + 1e-12) for value in exact_units]
    remainder = 100 * scale - sum(units)
    order = sorted(
        range(len(exact_units)),
        key=lambda index: exact_units[index] - units[index],
        reverse=True,
    )
    for offset in range(max(0, remainder)):
        units[order[offset % len(order)]] += 1
    return [value / scale for value in units]


def implied_target_level_distribution(
    implied_post_rate: float,
    current_effr: float,
    current_target_lower: float,
) -> list[dict[str, Any]]:
    """Map an expected post-meeting EFFR to adjacent 25 bp target-range nodes."""
    effr_spread = current_effr - current_target_lower
    expected_lower_bps = (implied_post_rate - effr_spread) * 100.0
    floor_bps = int(math.floor(expected_lower_bps / 25.0) * 25)
    ceil_bps = int(math.ceil(expected_lower_bps / 25.0) * 25)
    if floor_bps == ceil_bps:
        nodes = [(floor_bps, 1.0)]
    else:
        ceil_probability = (expected_lower_bps - floor_bps) / 25.0
        nodes = [(floor_bps, 1.0 - ceil_probability), (ceil_bps, ceil_probability)]
    displayed = rounded_percentages([probability for _, probability in nodes])
    current_lower_bps = int(round(current_target_lower * 100.0))
    output: list[dict[str, Any]] = []
    for (lower_bps, _probability), display_probability in zip(nodes, displayed):
        move_bps = lower_bps - current_lower_bps
        action = "Unchanged from snapshot target"
        if move_bps > 0:
            action = f"{move_bps} bps above snapshot target"
        elif move_bps < 0:
            action = f"{abs(move_bps)} bps below snapshot target"
        output.append(
            {
                "targetRange": target_range_label(lower_bps),
                "moveBps": move_bps,
                "action": action,
                "probability": display_probability,
            }
        )
    return output


def calculate_meeting_probabilities(
    strip: dict[str, Any],
    current_rate: float,
    current_target_lower: float,
    as_of: date | None = None,
    meeting_dates: list[date] | None = None,
) -> list[dict[str, Any]]:
    settle_map = {row["month"]: row for row in strip["contracts"]}
    reference_date = as_of or date.fromisoformat(strip.get("tradeDate") or today_local().isoformat())
    # Settlements are end-of-day snapshots, so a decision on the trade date is already known.
    calendar_dates = meeting_dates or FOMC_MEETINGS
    meetings = [meeting for meeting in calendar_dates if meeting > reference_date]
    meeting_map = {(meeting.year, meeting.month): meeting for meeting in meetings}
    rate_nodes: dict[date, dict[str, Any]] = {}

    for meeting in meetings:
        py, pm = previous_month(meeting.year, meeting.month)
        if (py, pm) in meeting_map:
            continue
        chain: list[date] = []
        cursor = meeting
        while cursor:
            key = month_key(cursor.year, cursor.month)
            if key not in settle_map:
                break
            chain.append(cursor)
            ny, nm = next_month(cursor.year, cursor.month)
            cursor = meeting_map.get((ny, nm))

        if not chain:
            continue
        ay, am = next_month(chain[-1].year, chain[-1].month)
        anchor_key = month_key(ay, am)
        anchor = settle_map.get(anchor_key)
        if anchor:
            post_rate = 100.0 - float(anchor["settle"])
            method = f"backward recursion from non-meeting contract {anchor_key}"
            for chain_meeting in reversed(chain):
                key = month_key(chain_meeting.year, chain_meeting.month)
                contract = settle_map[key]
                average_rate = 100.0 - float(contract["settle"])
                days_in_month = calendar.monthrange(chain_meeting.year, chain_meeting.month)[1]
                pre_days = chain_meeting.day
                post_days = days_in_month - chain_meeting.day
                pre_rate = (
                    (days_in_month * average_rate - post_days * post_rate) / pre_days
                    if pre_days > 0
                    else average_rate
                )
                rate_nodes[chain_meeting] = {
                    "preRate": pre_rate,
                    "postRate": post_rate,
                    "averageRate": average_rate,
                    "preDays": pre_days,
                    "postDays": post_days,
                    "method": method,
                }
                post_rate = pre_rate
        else:
            pre_rate = current_rate
            for chain_meeting in chain:
                key = month_key(chain_meeting.year, chain_meeting.month)
                contract = settle_map[key]
                average_rate = 100.0 - float(contract["settle"])
                days_in_month = calendar.monthrange(chain_meeting.year, chain_meeting.month)[1]
                pre_days = chain_meeting.day
                post_days = days_in_month - chain_meeting.day
                post_rate = (
                    (days_in_month * average_rate - pre_days * pre_rate) / post_days
                    if post_days > 0
                    else pre_rate
                )
                rate_nodes[chain_meeting] = {
                    "preRate": pre_rate,
                    "postRate": post_rate,
                    "averageRate": average_rate,
                    "preDays": pre_days,
                    "postDays": post_days,
                    "method": "forward decomposition; no later non-meeting anchor was available",
                }
                pre_rate = post_rate

    cumulative: dict[int, float] = {0: 1.0}
    current_lower_bps = int(round(current_target_lower * 100.0))
    results: list[dict[str, Any]] = []
    for meeting in meetings:
        node = rate_nodes.get(meeting)
        key = month_key(meeting.year, meeting.month)
        contract = settle_map.get(key)
        if not node or not contract:
            continue
        node_distribution = node_move_distribution(node["preRate"], node["postRate"])
        cumulative = convolve_move_distributions(cumulative, node_distribution)
        cumulative_rows = sorted(cumulative.items())
        cumulative_percentages = rounded_percentages(
            [probability for _, probability in cumulative_rows]
        )
        distribution: list[dict[str, Any]] = []
        for (move_count, _probability), display_probability in zip(
            cumulative_rows, cumulative_percentages
        ):
            move_bps = move_count * 25
            action = "Unchanged from current target"
            if move_bps > 0:
                action = f"{move_bps} bps above current target"
            elif move_bps < 0:
                action = f"{abs(move_bps)} bps below current target"
            distribution.append(
                {
                    "targetRange": target_range_label(current_lower_bps + move_bps),
                    "moveBps": move_bps,
                    "action": action,
                    "probability": display_probability,
                }
            )
        results.append(
            {
                "date": meeting.isoformat(),
                "contractMonth": key,
                "contract": contract_code(meeting.year, meeting.month),
                "settlement": contract["settle"],
                "impliedAverageRate": round(node["averageRate"], 4),
                "preMeetingRate": round(node["preRate"], 4),
                "impliedPostMeetingRate": round(node["postRate"], 4),
                "postRateMethod": node["method"],
                "daysInMonth": calendar.monthrange(meeting.year, meeting.month)[1],
                "preMeetingDays": node["preDays"],
                "postMeetingDays": node["postDays"],
                "nodeDistribution": [
                    {**row, "probability": display_probability}
                    for row, display_probability in zip(
                        node_distribution,
                        rounded_percentages(
                            [float(row["probability"]) for row in node_distribution]
                        ),
                    )
                ],
                "distribution": distribution,
            }
        )
    return results


def compact_fed_snapshot(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "asOf": summary.get("asOf"),
        "provider": summary.get("futures", {}).get("provider"),
        "meetings": [
            {
                "date": meeting.get("date"),
                "contract": meeting.get("contract"),
                "settlement": meeting.get("settlement"),
                "distribution": meeting.get("distribution", []),
            }
            for meeting in summary.get("meetings", [])
        ],
    }


def load_fed_history() -> list[dict[str, Any]]:
    try:
        payload = json.loads(FED_HISTORY_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    if not isinstance(payload, list):
        return []
    return [
        row
        for row in payload
        if isinstance(row, dict)
        and row.get("asOf")
        and "CME settlement" in str(row.get("provider") or "")
    ]


def record_fed_snapshot(summary: dict[str, Any]) -> None:
    snapshot = compact_fed_snapshot(summary)
    if (
        not snapshot["asOf"]
        or not snapshot["meetings"]
        or "CME settlement" not in str(snapshot.get("provider") or "")
    ):
        return
    with _FED_HISTORY_LOCK:
        rows = load_fed_history()
        by_date = {str(row["asOf"]): row for row in rows}
        by_date[str(snapshot["asOf"])] = snapshot
        output = [by_date[key] for key in sorted(by_date)[-370:]]
        FED_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = FED_HISTORY_PATH.with_suffix(".tmp")
        temporary.write_text(json.dumps(output, indent=2), encoding="utf-8")
        temporary.replace(FED_HISTORY_PATH)


def meeting_from_snapshot(snapshot: dict[str, Any], meeting_date: str) -> dict[str, Any] | None:
    return next(
        (row for row in snapshot.get("meetings", []) if row.get("date") == meeting_date),
        None,
    )


def fed_probability_history(meeting_date: str, as_of: date | None = None) -> dict[str, Any]:
    base_date = as_of or today_local()
    comparisons: list[dict[str, Any]] = []
    seen_dates: set[str] = set()
    requested_dates: list[tuple[str, date]] = [("Current", base_date)]
    index = 0
    while index < len(requested_dates):
        label, requested_date = requested_dates[index]
        index += 1
        try:
            summary = fed_summary(requested_date, record=False)
            record_fed_snapshot(summary)
            snapshot = compact_fed_snapshot(summary)
            meeting = meeting_from_snapshot(snapshot, meeting_date)
            if meeting is None:
                raise RuntimeError("Selected meeting is outside the returned futures strip.")
            actual_date = str(snapshot["asOf"])
            if label == "Current":
                anchor = date.fromisoformat(actual_date)
                requested_dates.extend(
                    [
                        ("Prior day", previous_business_day(anchor)),
                        ("Prior week", business_day_on_or_before(anchor - timedelta(days=7))),
                        ("Prior month", business_day_on_or_before(anchor - timedelta(days=30))),
                    ]
                )
            if actual_date in seen_dates:
                continue
            seen_dates.add(actual_date)
            comparisons.append(
                {
                    "label": label,
                    "requestedDate": requested_date.isoformat(),
                    "date": actual_date,
                    "provider": snapshot.get("provider"),
                    "quality": (
                        "official"
                        if "CME settlement" in str(snapshot.get("provider") or "")
                        else "indicative"
                    ),
                    "distribution": meeting.get("distribution", []),
                }
            )
        except NetworkPolicyError:
            raise
        except Exception as exc:  # noqa: BLE001 - partial comparisons remain useful.
            comparisons.append(
                {
                    "label": label,
                    "requestedDate": requested_date.isoformat(),
                    "date": None,
                    "distribution": [],
                    "error": str(exc)[:800],
                }
            )

    indicative: dict[str, Any] = {"history": [], "meta": {}, "sources": []}
    indicative_error: str | None = None
    try:
        indicative = cache_get(
            f"fed-indicative-history:{meeting_date}:{base_date.isoformat()}",
            6 * 60 * 60,
            lambda: indicative_fed_probability_history(meeting_date, base_date),
        )
    except NetworkPolicyError:
        raise
    except Exception as exc:  # noqa: BLE001
        indicative_error = str(exc)[:1200]

    indicative_rows = indicative.get("history") or []
    for comparison in comparisons:
        if comparison.get("date") or not indicative_rows:
            continue
        requested_text = str(comparison.get("requestedDate") or "")
        candidates = [row for row in indicative_rows if str(row.get("date") or "") <= requested_text]
        if not candidates:
            continue
        replacement = candidates[-1]
        age = (
            date.fromisoformat(requested_text) - date.fromisoformat(str(replacement["date"]))
        ).days
        if age > 7:
            continue
        comparison["officialError"] = comparison.pop("error", None)
        comparison.update(
            {
                "date": replacement["date"],
                "provider": replacement["provider"],
                "quality": "indicative",
                "distribution": replacement["distribution"],
            }
        )

    history_by_date: dict[str, dict[str, Any]] = {
        str(row["date"]): row for row in indicative_rows
    }
    official_count = 0
    for snapshot in load_fed_history():
        meeting = meeting_from_snapshot(snapshot, meeting_date)
        if meeting:
            official_count += 1
            history_by_date[str(snapshot["asOf"])] = {
                "date": snapshot["asOf"],
                "provider": snapshot.get("provider"),
                "quality": "official",
                "distribution": meeting.get("distribution", []),
            }
    history = sorted(history_by_date.values(), key=lambda row: row["date"])
    first_history_date = history[0]["date"] if history else None
    last_history_date = history[-1]["date"] if history else None
    sources = [
        {
            "name": "CME FedWatch Tool",
            "url": "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html",
            "role": "Official reference interface and methodology",
        },
        {
            "name": "CME 30-Day Fed Funds settlements",
            "url": "https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.settlements.html",
            "role": "Official settlement snapshots when available",
        },
        *indicative.get("sources", []),
    ]
    return {
        "meeting": meeting_date,
        "comparisons": comparisons,
        "history": history,
        "historyMeta": {
            **(indicative.get("meta") or {}),
            "officialObservationCount": official_count,
            "totalObservationCount": len(history),
            "firstDate": first_history_date,
            "lastDate": last_history_date,
            "indicativeError": indicative_error,
        },
        "limitations": [
            "Current, prior-day, prior-week, and prior-month values are independently reconstructed from the dated settlement strips available from CME.",
            "Official CME settlement snapshots override public daily-close reconstructions whenever both exist for the same date.",
            "The extended one-year chart is indicative: it combines Yahoo Finance daily ZQ closes with official EFFR and target-rate history. It is not CME's licensed historical probability file.",
            "Missing contract observations are skipped; probabilities are never interpolated between dates.",
        ],
        "sources": sources,
        "generatedAt": utc_now_iso(),
    }


def fed_summary(as_of: date | None = None, record: bool = True) -> dict[str, Any]:
    strip = fetch_fed_funds_strip(as_of)
    calculation_date = date.fromisoformat(strip.get("tradeDate") or (as_of or today_local()).isoformat())
    rate_info = current_target_and_effr(calculation_date)
    calendar_info = get_fomc_calendar()
    meetings = calculate_meeting_probabilities(
        strip,
        float(rate_info["effr"]["value"]),
        float(rate_info["targetRange"]["lower"]),
        calculation_date,
        calendar_info["meetings"],
    )
    target_source = rate_info.get("targetRange", {}).get("source") or {}
    payload = {
        "generatedAt": utc_now_iso(),
        "asOf": calculation_date.isoformat(),
        "effr": rate_info["effr"],
        "targetRange": rate_info["targetRange"],
        "rateLookupErrors": rate_info.get("errors", []),
        "futures": strip,
        "meetings": meetings,
        "calendar": {key: value for key, value in calendar_info.items() if key != "meetings"},
        "notes": [
            "This is a settlement-based reconstruction, not the official live CME FedWatch API.",
            "The decision-day rate applies through the FOMC decision date; a new target normally becomes effective the following day.",
            "Consecutive meeting months are solved backward from the next non-meeting contract, then meeting-node probabilities are convolved into cumulative target-range outcomes.",
            "CME settlements are primary. Yahoo contract closes are an indicative current-only fallback and are never labeled as settlements.",
            "Historical mode works only when CME returns the requested dated strip. Reliable deep history requires licensed ZQ settlements or an imported official file.",
            f"FOMC dates were loaded from {calendar_info['provider']}; current coverage ends {calendar_info['coverageEnd']}.",
            *([calendar_info["warning"]] if calendar_info.get("warning") else []),
        ],
        "sources": [
            {
                "name": "Federal Reserve FOMC calendars",
                "url": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
                "role": "Official meeting dates",
            },
            {
                "name": str(rate_info["effr"].get("source") or "Effective fed funds source"),
                "url": rate_info["effr"].get("sourceUrl"),
                "role": "Effective fed funds rate",
            },
            {
                "name": str(target_source.get("source") or "Target range source"),
                "url": target_source.get("sourceUrl"),
                "role": "Current target range",
            },
            {
                "name": str(strip.get("provider") or "Fed Funds futures provider"),
                "url": strip.get("sourceUrl"),
                "role": "Futures settlements or closes used in this calculation",
            },
            {
                "name": "CME FedWatch Tool",
                "url": "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html",
                "role": "Official reference interface and methodology",
            },
            {
                "name": "Investing.com Fed Rate Monitor",
                "url": "https://www.investing.com/central-banks/fed-rate-monitor",
                "role": "Independent public comparison interface; not used in calculation",
            },
        ],
    }
    if record:
        record_fed_snapshot(payload)
    return payload


class LocalToolHandler(BaseHTTPRequestHandler):
    server_version = "PortfolioAnalyzerSideTools/3.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_safe(
        self,
        status: int,
        content: bytes,
        content_type: str,
        content_encoding: str | None = None,
    ) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            if content_encoding:
                self.send_header("Content-Encoding", content_encoding)
                self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return

    def send_json(self, status: int, payload: Any) -> None:
        content = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if accepts_gzip and len(content) >= 8_192:
            self.send_safe(
                status,
                gzip.compress(content, compresslevel=5),
                "application/json; charset=utf-8",
                "gzip",
            )
            return
        self.send_safe(status, content, "application/json; charset=utf-8")

    def send_error_json(self, status: int, exc: Exception) -> None:
        is_policy = isinstance(exc, NetworkPolicyError)
        self.send_json(
            503 if is_policy else status,
            {
                "error": str(exc)[:1600],
                "type": exc.__class__.__name__,
                "code": "NETWORK_POLICY_DENIED" if is_policy else "REQUEST_FAILED",
                "action": (
                    "Run python serve.py --doctor from the same terminal. The app cannot bypass an execution-context network policy."
                    if is_policy
                    else "Open the data audit panel for provider details, then retry."
                ),
                "network": finish_network_trace(),
                "backend": backend_status(),
            },
        )

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self.send_json(
                    200,
                    {
                        "ok": True,
                        "generatedAt": utc_now_iso(),
                        "settings": public_settings(),
                        "model": model_router.ollama_status(),
                        "backend": backend_status(),
                    },
                )
                return
            if path == "/api/doctor":
                self.send_json(200, diagnose_network())
                return
            if path == "/api/settings":
                self.send_json(200, public_settings())
                return
            if path == "/api/model/status":
                refresh = (query.get("refresh") or [""])[0].strip().lower() in {
                    "1",
                    "true",
                    "yes",
                }
                self.send_json(200, model_router.ollama_status(force=refresh))
                return
            if path == "/api/fred/query":
                prompt = (query.get("q") or [""])[0].strip()
                start_text = (query.get("start") or [""])[0].strip()
                end_text = (query.get("end") or [""])[0].strip()
                clarification_text = (query.get("clarifications") or [""])[0].strip()
                if len(clarification_text) > 8_000:
                    raise ValueError("Macro clarification payload is too large.")
                clarification_values = json.loads(clarification_text) if clarification_text else None
                start_override = date.fromisoformat(start_text) if start_text else None
                end_override = date.fromisoformat(end_text) if end_text else None
                start_network_trace()
                payload = handle_fred_query(
                    prompt,
                    start_override,
                    end_override,
                    clarification_values,
                )
                payload["network"] = finish_network_trace()
                self.send_json(200, payload)
                return
            if path == "/api/macro/dashboard":
                force = (query.get("refresh") or [""])[0].strip().lower() in {
                    "1",
                    "true",
                    "yes",
                }
                start_network_trace()
                payload = (
                    macro_dashboard_payload()
                    if force
                    else copy.deepcopy(cache_get("macro-dashboard", 60, macro_dashboard_payload))
                )
                payload["network"] = finish_network_trace()
                self.send_json(200, payload)
                return
            if path == "/api/fed/summary":
                as_of_text = (query.get("asOf") or [""])[0].strip()
                as_of = date.fromisoformat(as_of_text) if as_of_text else None
                force = (query.get("refresh") or [""])[0].strip().lower() in {
                    "1",
                    "true",
                    "yes",
                }
                start_network_trace()
                cache_key = f"fed-summary:{as_of.isoformat() if as_of else 'latest'}"
                payload = (
                    fed_summary(as_of)
                    if force
                    else copy.deepcopy(cache_get(cache_key, 60, lambda: fed_summary(as_of)))
                )
                payload["network"] = finish_network_trace()
                self.send_json(200, payload)
                return
            if path == "/api/fed/history":
                meeting = (query.get("meeting") or [""])[0].strip()
                if not meeting:
                    raise ValueError("A meeting date is required.")
                date.fromisoformat(meeting)
                as_of_text = (query.get("asOf") or [""])[0].strip()
                as_of = date.fromisoformat(as_of_text) if as_of_text else None
                start_network_trace()
                cache_key = (
                    f"fed-history:{meeting}:{as_of.isoformat() if as_of else 'latest'}"
                )
                payload = copy.deepcopy(
                    cache_get(
                        cache_key,
                        5 * 60,
                        lambda: fed_probability_history(meeting, as_of),
                    )
                )
                payload["network"] = finish_network_trace()
                self.send_json(200, payload)
                return
            if path == "/api/fed/intent":
                prompt = (query.get("q") or [""])[0].strip()
                meeting_dates = [
                    value
                    for raw in (query.get("meetings") or [])
                    for value in raw.split(",")
                    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
                ]
                if not prompt:
                    raise ValueError("A Fed Tracker request is required.")
                if not meeting_dates:
                    raise ValueError("Available FOMC meeting dates are required.")
                payload = parse_fed_tracker_intent(prompt, meeting_dates)
                self.send_json(200, payload)
                return
            if path == "/api/treasury/dashboard":
                refresh = (query.get("refresh") or [""])[0].strip().lower() in {"1", "true", "yes"}
                limit_text = (query.get("limit") or ["100"])[0].strip()
                start_network_trace()
                payload = treasury_auctions.dashboard_payload(force=refresh, limit=int(limit_text))
                payload["network"] = finish_network_trace()
                self.send_json(200, payload)
                return
            if path == "/api/treasury/query":
                prompt = (query.get("q") or [""])[0].strip()
                use_model = (query.get("useModel") or [""])[0].strip().lower() in {"1", "true", "yes"}
                start_network_trace()
                payload = treasury_auctions.query_payload(prompt, use_model=use_model)
                payload["network"] = finish_network_trace()
                self.send_json(200, payload)
                return
            if path == "/api/treasury/auction":
                auction_key = (query.get("key") or [""])[0].strip()
                payload = treasury_auctions.auction_detail(auction_key)
                self.send_json(200, payload)
                return
            self.serve_static(path)
        except Exception as exc:  # noqa: BLE001
            self.send_error_json(400 if isinstance(exc, ValueError) else 500, exc)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/settings":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            origin = self.headers.get("Origin", "")
            if origin and not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):\d+", origin):
                self.send_json(403, {"error": "Settings may only be changed from this local app."})
                return
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                self.send_json(415, {"error": "Settings requests must use application/json."})
                return
            length = min(int(self.headers.get("Content-Length", "0")), 32_768)
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise ValueError("Settings payload must be an object.")
            save_settings(payload)
            self.send_json(200, public_settings())
        except Exception as exc:  # noqa: BLE001
            self.send_error_json(400, exc)

    def serve_static(self, path: str) -> None:
        if path in {"", "/"}:
            path = "/index.html"
        clean = urllib.parse.unquote(path).lstrip("/")
        if clean not in STATIC_FILES:
            self.send_json(404, {"error": "Not found"})
            return
        requested = (APP_DIR / clean).resolve()
        if APP_DIR not in requested.parents and requested != APP_DIR:
            self.send_json(403, {"error": "Forbidden"})
            return
        if not requested.exists() or requested.is_dir():
            self.send_json(404, {"error": "Not found"})
            return
        content_type = mimetypes.guess_type(str(requested))[0] or "application/octet-stream"
        self.send_safe(200, requested.read_bytes(), content_type)


def pick_port(host: str, preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, preferred))
            return preferred
        except OSError:
            sock.bind((host, 0))
            return int(sock.getsockname()[1])


def run_server(host: str, port: int, open_browser: bool) -> None:
    actual_port = pick_port(host, port)
    server = ThreadingHTTPServer((host, actual_port), LocalToolHandler)
    local_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{local_host}:{actual_port}/"
    print(f"Side tools listening on {host}:{actual_port}")
    print(f"Open locally at {url}")
    print("Press Ctrl+C to stop.")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping side tools.")
    finally:
        server.server_close()


def check_line(ok: bool, label: str, detail: str) -> bool:
    status = "OK" if ok else "FAIL"
    print(f"[{status}] {label}: {detail}", flush=True)
    return ok


def run_check() -> int:
    print("Portfolio Analyzer Side Tools self-check")
    print(f"Generated: {utc_now_iso()}", flush=True)
    checks: list[bool] = []

    try:
        result = handle_fred_query("sp500, 10-year and 2-year treasury yields for last 30 years")
        details = []
        for series in result["series"]:
            details.append(
                f"{series['name']} via {series['provider']} ({series['firstDate']} to {series['lastDate']}, "
                f"{len(series['observations'])} obs)"
            )
        checks.append(check_line(True, "Macro Data Lab prompt", "; ".join(details)))
    except Exception as exc:  # noqa: BLE001
        checks.append(check_line(False, "Macro Data Lab prompt", str(exc)))

    try:
        summary = fed_summary()
        target = summary["targetRange"]["label"]
        effr = summary["effr"]["value"]
        effr_date = summary["effr"].get("date")
        futures = summary["futures"]
        meetings = summary["meetings"]
        next_meeting = meetings[0]["date"] if meetings else "none"
        detail = (
            f"EFFR {effr:.2f}% ({effr_date}), target {target}, "
            f"{len(futures['contracts'])} futures from {futures['provider']} "
            f"tradeDate={futures.get('tradeDate')}, next meeting={next_meeting}"
        )
        checks.append(check_line(bool(meetings), "Fed Tracker", detail))
    except Exception as exc:  # noqa: BLE001
        checks.append(check_line(False, "Fed Tracker", str(exc)))

    try:
        dashboard = treasury_auctions.dashboard_payload(limit=20)
        database = dashboard["database"]
        latest = dashboard.get("latestResult") or {}
        detail = (
            f"{database['rowCount']} auctions ({database['firstAuctionDate']} to "
            f"{database['lastAuctionDate']}), latest {latest.get('term', 'unknown')} "
            f"on {latest.get('auctionDate', 'unknown')}"
        )
        checks.append(check_line(database["rowCount"] > 0, "Treasury Auction Tracker", detail))
    except Exception as exc:  # noqa: BLE001
        checks.append(check_line(False, "Treasury Auction Tracker", str(exc)))

    print("")
    if all(checks):
        print("Self-check passed. Run: python serve.py")
        return 0
    print("Self-check failed. The app still starts, but one or more live data sources are unavailable.")
    return 1


def run_doctor() -> int:
    result = diagnose_network()
    print(json.dumps(result, indent=2), flush=True)
    if result.get("https", {}).get("ok"):
        if result.get("classification") == "PARTIAL_PROVIDER_OUTAGE":
            failed = ", ".join(result.get("https", {}).get("failed") or [])
            print(f"Network preflight passed with partial provider availability. Unavailable: {failed}")
        else:
            print("Network preflight passed.")
        return 0
    if result.get("classification") == "NETWORK_POLICY_DENIED":
        print(
            "This terminal's process context is denied outbound HTTPS. The provider sites were not reached.\n"
            "Use the included VS Code task or run from a normal Windows Terminal. If both fail, ask your security software\n"
            f"to allow outbound TCP 443 for: {sys.executable}",
            file=sys.stderr,
        )
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the local market-data side tools.")
    parser.add_argument("--check", action="store_true", help="Run live source self-checks and exit.")
    parser.add_argument("--doctor", action="store_true", help="Diagnose DNS, TCP, and HTTPS access and exit.")
    parser.add_argument(
        "--host",
        default=os.environ.get("SIDE_TOOLS_HOST", "127.0.0.1"),
        help="Bind host. Use 0.0.0.0 only behind a firewall, reverse proxy, or private network.",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("SIDE_TOOLS_PORT", DEFAULT_PORT)))
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically.")
    args = parser.parse_args(argv)

    if args.check:
        return run_check()
    if args.doctor:
        return run_doctor()

    run_server(args.host, args.port, open_browser=not args.no_open)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
