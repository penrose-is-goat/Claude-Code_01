"""Non-FRED macro and fundamentals providers for Macro Data Lab.

The resolver only emits allowlisted provider specifications. Provider IDs, formulas,
and source URLs are supplied by code rather than generated from user text.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

from data_core import http_get, http_get_bytes


APP_DIR = Path(__file__).resolve().parent
PROVIDER_CACHE_DIR = APP_DIR / ".cache" / "providers"

FED_DFA_PAGE_URL = "https://www.federalreserve.gov/releases/z1/dataviz/dfa/"
FED_DFA_TABLE_URL = "https://www.federalreserve.gov/releases/z1/dataviz/dfa/distribute/table/"
FED_DFA_ZIP_URL = "https://www.federalreserve.gov/releases/z1/dataviz/download/zips/dfa.zip"

QUANTIFIER_NUMBER_WORDS = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "twelve": "12",
    "fifteen": "15",
    "twenty": "20",
    "twenty-four": "24",
    "twenty-five": "25",
    "thirty": "30",
    "forty": "40",
    "fifty": "50",
    "seventy-five": "75",
    "ninety": "90",
    "ninety-nine": "99",
}

DFA_GROUPS = {
    "top_10": {
        "label": "Top 10%",
        "categories": ["TopPt1", "RemainingTop1", "Next9"],
        "fredLevels": ["WFRBLT01026", "WFRBLN09053"],
        "fredShares": ["WFRBST01134", "WFRBSN09161"],
    },
    "bottom_50": {
        "label": "Bottom 50%",
        "categories": ["Bottom50"],
        "fredLevels": ["WFRBLB50107"],
        "fredShares": ["WFRBSB50215"],
    },
    "top_1": {
        "label": "Top 1%",
        "categories": ["TopPt1", "RemainingTop1"],
        "fredLevels": ["WFRBLT01026"],
        "fredShares": ["WFRBST01134"],
    },
    "top_0_1": {
        "label": "Top 0.1%",
        "categories": ["TopPt1"],
        "fredLevels": [],
        "fredShares": [],
    },
    "next_9": {
        "label": "Next 9%",
        "categories": ["Next9"],
        "fredLevels": ["WFRBLN09053"],
        "fredShares": ["WFRBSN09161"],
    },
    "next_40": {
        "label": "Next 40%",
        "categories": ["Next40"],
        "fredLevels": ["WFRBLN40080"],
        "fredShares": ["WFRBSN40188"],
    },
}

DFA_COMPONENT_ALIASES = {
    "Real estate": (r"\breal estate\b", r"\bhousing assets?\b", r"\bproperty assets?\b"),
    "Consumer durables": (r"\bconsumer durables?\b",),
    "Corporate equities and mutual fund shares": (
        r"\bcorporate equit(?:y|ies)\b",
        r"\b(?:stocks?|equities) and mutual funds?\b",
    ),
    "DB pension entitlements": (
        r"\bdefined benefit pensions?\b",
        r"\bdb pensions?\b",
        r"\bpensions?\b",
    ),
    "DC pension entitlements": (
        r"\bdefined contribution pensions?\b",
        r"\bdc pensions?\b",
        r"\bpensions?\b",
    ),
    "Unincorporated businesses": (r"\bunincorporated businesses?\b", r"\bprivate businesses?\b"),
    "Home mortgages": (r"\bhome mortgages?\b", r"\bmortgage debt\b"),
    "Consumer credit": (r"\bconsumer credit\b",),
}

SP_EARNINGS_CANONICAL_URL = (
    "https://www.spglobal.com/spdji/en/documents/additional-material/sp-500-eps-est.xlsx"
)
SP_EARNINGS_CDX_URL = "https://web.archive.org/cdx/search/cdx"
SP_EARNINGS_CACHE_PATH = PROVIDER_CACHE_DIR / "sp-500-eps-est.xlsx"
SP_EARNINGS_METADATA_PATH = PROVIDER_CACHE_DIR / "sp-500-eps-est.json"
SP_EARNINGS_CONTRIBUTION_ARCHIVES = ["20210228100131", "20200725041834"]
SP_EARNINGS_OLDEST_CACHE_PATH = PROVIDER_CACHE_DIR / "sp-500-eps-contribution-history.xlsx"
SP_EARNINGS_OLDEST_METADATA_PATH = PROVIDER_CACHE_DIR / "sp-500-eps-contribution-history.json"
SEC_REQUEST_HEADERS = {
    "User-Agent": "Portfolio Analyzer Side Tools/1.0 research application contact local-user",
    "Accept": "application/json",
    "Accept-Encoding": "identity",
}

SECTOR_LABELS = {
    "communication services": "S&P 500 Communication Services",
    "consumer discretionary": "S&P 500 Consumer Discretionary",
    "consumer staples": "S&P 500 Consumer Staples",
    "energy": "S&P 500 Energy",
    "financials": "S&P 500 Financials",
    "health care": "S&P 500 Health Care",
    "industrials": "S&P 500 Industrials",
    "information technology": "S&P 500 Information Technology",
    "materials": "S&P 500 Materials",
    "real estate": "S&P 500 Real Estate (proforma pre-9/19/16)",
    "utilities": "S&P 500 Utilities",
}

SECTOR_ALIASES = {
    "communication services": [r"\bcommunication services?\b", r"\bcommunications?\b"],
    "consumer discretionary": [r"\bconsumer discretionary\b", r"\bdiscretionary\b"],
    "consumer staples": [r"\bconsumer staples?\b", r"\bstaples?\b"],
    "energy": [r"\benergy\b"],
    "financials": [r"\bfinancials?\b", r"\bbanks?\b"],
    "health care": [r"\bhealth\s*care\b", r"\bhealthcare\b"],
    "industrials": [r"\bindustrials?\b"],
    "information technology": [r"\binformation technology\b", r"\btechnology\b", r"\btech\b"],
    "materials": [r"\bmaterials?\b"],
    "real estate": [r"\breal estate\b", r"\breits?\b"],
    "utilities": [r"\butilities\b", r"\butility\b"],
}

COUNTRIES = {
    "united states": ("USA", "United States"),
    "u.s.": ("USA", "United States"),
    "us": ("USA", "United States"),
    "china": ("CHN", "China"),
    "japan": ("JPN", "Japan"),
    "japanese": ("JPN", "Japan"),
    "germany": ("DEU", "Germany"),
    "german": ("DEU", "Germany"),
    "france": ("FRA", "France"),
    "italy": ("ITA", "Italy"),
    "spain": ("ESP", "Spain"),
    "netherlands": ("NLD", "Netherlands"),
    "switzerland": ("CHE", "Switzerland"),
    "united kingdom": ("GBR", "United Kingdom"),
    "uk": ("GBR", "United Kingdom"),
    "british": ("GBR", "United Kingdom"),
    "canada": ("CAN", "Canada"),
    "india": ("IND", "India"),
    "brazil": ("BRA", "Brazil"),
    "mexico": ("MEX", "Mexico"),
    "australia": ("AUS", "Australia"),
    "south korea": ("KOR", "South Korea"),
    "korea": ("KOR", "South Korea"),
    "euro area": ("EMU", "Euro area"),
    "turkey": ("TUR", "Turkey"),
    "türkiye": ("TUR", "Türkiye"),
    "worldwide": ("WLD", "World"),
    "world": ("WLD", "World"),
}

WORLD_BANK_SERIES = [
    {
        "indicator": "NY.GDP.MKTP.KD.ZG",
        "name": "Real GDP Growth",
        "unit": "Percent",
        "aliases": [r"\breal gdp growth\b", r"\bgdp growth\b", r"\beconomic growth\b"],
    },
    {
        "indicator": "NY.GDP.PCAP.KD",
        "name": "Real GDP per Capita",
        "unit": "Constant 2015 U.S. dollars",
        "aliases": [r"\breal gdp per capita\b"],
    },
    {
        "indicator": "NY.GDP.PCAP.CD",
        "name": "GDP per Capita",
        "unit": "Current U.S. dollars",
        "aliases": [r"\bgdp per capita\b"],
    },
    {
        "indicator": "NY.GDP.PCAP.PP.CD",
        "name": "GDP per Capita, Purchasing Power Parity",
        "unit": "Current international dollars",
        "aliases": [
            r"\bgdp per capita(?:,?\s+at)?\s+(?:purchasing power parity|ppp)\b",
            r"\bppp gdp per capita\b",
        ],
    },
    {
        "indicator": "NY.GDP.PCAP.PP.KD",
        "name": "Real GDP per Capita, Purchasing Power Parity",
        "unit": "Constant international dollars",
        "aliases": [
            r"\breal gdp per capita(?:,?\s+at)?\s+(?:purchasing power parity|ppp)\b",
            r"\breal ppp gdp per capita\b",
        ],
    },
    {
        "indicator": "NY.GDP.MKTP.CD",
        "name": "Gross Domestic Product",
        "unit": "Current U.S. dollars",
        "aliases": [r"\bworld bank gdp\b", r"\bnominal gdp\b", r"\bgdp\b"],
    },
    {
        "indicator": "FP.CPI.TOTL.ZG",
        "name": "Consumer Price Inflation",
        "unit": "Annual percent",
        "aliases": [r"\bconsumer price inflation\b", r"\binflation rate\b", r"\binflation\b", r"\bcpi\b"],
    },
    {
        "indicator": "SL.UEM.TOTL.ZS",
        "name": "Unemployment Rate",
        "unit": "Percent of labor force",
        "aliases": [r"\bunemployment rate\b", r"\bunemployment\b"],
    },
    {
        "indicator": "SL.UEM.1524.ZS",
        "name": "Youth Unemployment Rate",
        "unit": "Percent of labor force ages 15-24",
        "aliases": [r"\byouth unemployment(?: rate)?\b", r"\bunemployment ages? 15(?:-| to )24\b"],
    },
    {
        "indicator": "SP.POP.TOTL",
        "name": "Population",
        "unit": "People",
        "aliases": [r"\bpopulation\b"],
    },
    {
        "indicator": "BN.CAB.XOKA.GD.ZS",
        "name": "Current Account Balance",
        "unit": "Percent of GDP",
        "aliases": [r"\bcurrent account(?: balance)?\b"],
    },
    {
        "indicator": "GC.DOD.TOTL.GD.ZS",
        "name": "Central Government Debt",
        "unit": "Percent of GDP",
        "aliases": [r"\bgovernment debt\b", r"\bpublic debt\b"],
    },
    {
        "indicator": "NE.TRD.GNFS.ZS",
        "name": "Trade",
        "unit": "Percent of GDP",
        "aliases": [r"\btrade as (?:a )?percent(?:age)? of gdp\b", r"\btrade share of gdp\b"],
    },
    {
        "indicator": "NE.EXP.GNFS.ZS",
        "name": "Exports of Goods and Services",
        "unit": "Percent of GDP",
        "aliases": [r"\bexports?(?: of goods and services)?\b"],
    },
    {
        "indicator": "NE.IMP.GNFS.ZS",
        "name": "Imports of Goods and Services",
        "unit": "Percent of GDP",
        "aliases": [r"\bimports?(?: of goods and services)?\b"],
    },
    {
        "indicator": "SP.DYN.LE00.IN",
        "name": "Life Expectancy at Birth",
        "unit": "Years",
        "aliases": [r"\blife expectancy\b"],
    },
    {
        "indicator": "IT.NET.USER.ZS",
        "name": "Internet Users",
        "unit": "Percent of population",
        "aliases": [r"\binternet users?\b", r"\binternet adoption\b"],
    },
    {
        "indicator": "EN.ATM.CO2E.PC",
        "name": "Carbon Dioxide Emissions per Capita",
        "unit": "Metric tons per capita",
        "aliases": [r"\bco2 emissions? per capita\b", r"\bcarbon emissions? per capita\b"],
    },
]

SEC_METRICS = [
    {
        "key": "revenue",
        "name": "Revenue",
        "unit": "U.S. dollars",
        "unitKeys": ["USD"],
        "aliases": [r"\brevenue\b", r"\bsales\b"],
        "concepts": [
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Revenues",
            "SalesRevenueNet",
        ],
    },
    {
        "key": "net-income",
        "name": "Net Income",
        "unit": "U.S. dollars",
        "unitKeys": ["USD"],
        "aliases": [r"\bnet income\b", r"\bnet earnings\b"],
        "concepts": ["NetIncomeLoss", "ProfitLoss"],
    },
    {
        "key": "operating-income",
        "name": "Operating Income",
        "unit": "U.S. dollars",
        "unitKeys": ["USD"],
        "aliases": [r"\boperating income\b", r"\boperating profit\b"],
        "concepts": ["OperatingIncomeLoss"],
    },
    {
        "key": "diluted-eps",
        "name": "Diluted Earnings per Share",
        "unit": "U.S. dollars per share",
        "unitKeys": ["USD/shares", "USD / shares"],
        "aliases": [r"\bdiluted eps\b", r"\bdiluted earnings per share\b"],
        "concepts": ["EarningsPerShareDiluted"],
    },
    {
        "key": "assets",
        "name": "Total Assets",
        "unit": "U.S. dollars",
        "unitKeys": ["USD"],
        "factType": "instant",
        "aliases": [r"\btotal assets\b"],
        "concepts": ["Assets"],
    },
    {
        "key": "operating-cash-flow",
        "name": "Operating Cash Flow",
        "unit": "U.S. dollars",
        "unitKeys": ["USD"],
        "aliases": [r"\boperating cash flow\b", r"\bcash from operations\b"],
        "concepts": ["NetCashProvidedByUsedInOperatingActivities"],
    },
    {
        "key": "research-development",
        "name": "Research and Development Expense",
        "unit": "U.S. dollars",
        "unitKeys": ["USD"],
        "aliases": [r"\bresearch and development\b", r"\br&d\b"],
        "concepts": ["ResearchAndDevelopmentExpense"],
    },
]


def _unique_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        if entry["id"] not in seen:
            output.append(entry)
            seen.add(entry["id"])
    return output


SP500_REFERENCE_PATTERN = re.compile(
    r"(?<![a-z0-9])(?:s\s*&\s*p(?:\s*500)?|s\s+and\s+p(?:\s*500)?|"
    r"standard\s+(?:&|and)\s+poor(?:'s)?(?:\s*500)?|sp\s*500|sp500|spx)(?![a-z0-9])",
    re.I,
)
SP_EARNINGS_PATTERN = re.compile(
    r"\b(?:operating\s+earnings|reported\s+earnings|earnings(?:\s+per\s+share)?|eps|profits?)\b",
    re.I,
)
SP_VALUATION_PATTERN = re.compile(
    r"\b(?:price\s*(?:to|-)\s*earnings(?:\s+ratio)?|pe\s+ratio|earnings\s+yield)\b|p\s*/\s*e",
    re.I,
)


def is_sp_earnings_prompt(prompt: str) -> bool:
    if not SP500_REFERENCE_PATTERN.search(prompt):
        return False
    # Prevent a price-to-earnings request from being mistaken for an EPS-level request.
    text_without_valuation = SP_VALUATION_PATTERN.sub(" ", prompt)
    return bool(SP_EARNINGS_PATTERN.search(text_without_valuation))


def _mentioned_sectors(text: str) -> list[str]:
    positions: list[tuple[int, str]] = []
    for sector, patterns in SECTOR_ALIASES.items():
        matches = [match for pattern in patterns if (match := re.search(pattern, text))]
        if matches:
            positions.append((min(match.start() for match in matches), sector))
    return [sector for _position, sector in sorted(positions)]


def _sp_exclusion_request(text: str) -> tuple[list[str], bool, str]:
    patterns = [
        r"\bwith\s+and\s+without\s+(.+)",
        r"\b(?:earnings(?:\s+per\s+share)?|eps|profits?)\s+all\s+but\s+(.+)",
        r"\b(?:earnings(?:\s+per\s+share)?|eps|profits?)\s*"
        r"(?:ex(?:cluding)?|excluding|without|less)\s*[-:]?\s*(.+)",
        r"\b(?:ex(?:cluding)?|excluding|without|less)\s*[-:]?\s*(.+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if not match:
            continue
        raw = match.group(1).strip()
        raw = re.split(
            r"\b(?:for|over|during)\s+(?:the\s+)?(?:last|past)\s+\d+\b",
            raw,
            maxsplit=1,
            flags=re.I,
        )[0].strip(" ,.;")
        return _mentioned_sectors(raw.lower()), True, raw
    return [], False, ""


def _sp_earnings_entries(prompt: str) -> tuple[list[dict[str, Any]], list[str]]:
    if not is_sp_earnings_prompt(prompt):
        return [], []
    text = prompt.lower()
    if re.search(
        r"\b(?:top|bottom)\s+\d+\s+(?:s&p\s+500\s+)?(?:companies|constituents|stocks)\b|"
        r"\b(?:companies|constituents|stocks)\s+(?:earnings|profit)\s+shares?\b",
        text,
    ):
        return [], [
            "The requested constituent ranking or earnings share is not the S&P 500 aggregate-EPS measure; no aggregate substitute was used."
        ]
    if re.search(r"\breported\s+(?:earnings|eps)\b", text):
        return [], [
            "Reported S&P 500 earnings are not mapped to the operating-EPS dataset; no price or operating-EPS substitute was used."
        ]
    exclusions, exclusion_requested, exclusion_text = _sp_exclusion_request(text)
    include_estimates = bool(re.search(r"\b(?:estimate|estimated|forecast|forward)\b", text))
    base = {
        "unit": "Operating earnings per index share",
        "origin": "S&P Dow Jones Indices",
        "primary": "sp-earnings",
        "preferredUnits": "raw",
        "includeEstimates": include_estimates,
        "aliases": [],
    }
    entries: list[dict[str, Any]] = []
    mentioned_sectors = _mentioned_sectors(text)
    earnings_mentions = len(SP_EARNINGS_PATTERN.findall(SP_VALUATION_PATTERN.sub(" ", text)))
    standalone_sector_request = bool(mentioned_sectors) and not exclusion_requested
    comparison_requested = bool(
        re.search(r"\b(?:versus|vs\.?|compare|against|with\s+and\s+without)\b", text)
    ) or earnings_mentions > 1
    explicit_total = bool(
        re.search(
            r"(?:s\s*&\s*p|sp)\s*500\s+(?:operating\s+)?(?:earnings|eps)",
            text,
        )
    )
    include_total = (
        comparison_requested
        if exclusion_requested
        else (not standalone_sector_request or explicit_total)
    )
    if include_total:
        entries.append(
            {
                **base,
                "id": "SP500:OPERATING_EPS",
                "name": "S&P 500 Operating Earnings per Share",
                "spWorkbookRows": ["S&P 500"],
                "formula": "S&P 500 operating EPS",
                "resolution": "S&P index-fundamentals provider mapping",
            }
        )
    if exclusions:
        label = " and ".join(sector.title() for sector in exclusions)
        identifier = "_".join(re.sub(r"[^A-Z0-9]+", "_", row.upper()).strip("_") for row in exclusions)
        entries.append(
            {
                **base,
                "id": f"SP500:OPERATING_EPS_EX_{identifier}",
                "name": f"S&P 500 Operating EPS Ex {label}",
                "spWorkbookRows": ["S&P 500"],
                "excludedSectors": exclusions,
                "formula": "S&P 500 operating EPS * (1 - "
                + " - ".join(
                    f"{sector.title()} operating earnings contribution share"
                    for sector in exclusions
                )
                + ")",
                "resolution": "derived from S&P operating earnings contribution shares",
            }
        )
    elif standalone_sector_request:
        for sector in mentioned_sectors:
            entries.append(
                {
                    **base,
                    "id": f"SP500:OPERATING_EPS:{sector.upper().replace(' ', '_')}",
                    "name": f"S&P 500 {sector.title()} Sector Operating Earnings per Share",
                    "spWorkbookRows": [SECTOR_LABELS[sector]],
                    "sectorIndex": sector,
                    "formula": f"Standalone S&P 500 {sector.title()} sector-index operating EPS",
                    "resolution": "S&P standalone sector-index operating-EPS provider mapping",
                }
            )
    notices = [
        "S&P earnings was routed to the S&P index-fundamentals provider; FRED search was not used."
    ]
    if not include_estimates:
        notices.append("Only quarters marked historical actuals by S&P are included; estimates are excluded.")
    if exclusion_requested and not exclusions:
        notices.append(
            f"The requested S&P earnings exclusion ({exclusion_text or 'unrecognized wording'}) "
            "did not map unambiguously to the 11 supported GICS sectors. No unrelated market "
            "index or FRED series was substituted."
        )
    return _unique_entries(entries), notices


def _explicit_tickers(prompt: str) -> list[str]:
    symbols = [match.upper() for match in re.findall(r"(?<!\w)\$([A-Za-z][A-Za-z0-9.-]{0,9})", prompt)]
    symbols.extend(
        match.upper()
        for match in re.findall(r"\b(?:ticker|symbol)\s+([A-Za-z][A-Za-z0-9.-]{0,9})\b", prompt, re.I)
    )
    return list(dict.fromkeys(symbols))


def _sec_entries(prompt: str) -> tuple[list[dict[str, Any]], list[str]]:
    tickers = _explicit_tickers(prompt)
    if not tickers:
        return [], []
    text = prompt.lower()
    metrics = [metric for metric in SEC_METRICS if any(re.search(pattern, text) for pattern in metric["aliases"])]
    if not metrics:
        return [], []
    if re.search(r"\b(?:quarterly|quarter|10-q)\b", text):
        return [], [
            "SEC Company Facts quarterly duration facts require quarter-aware reconstruction; annual consolidated facts were not substituted."
        ]
    if _countries_in_prompt(prompt) and not re.search(r"\b(?:united states|u\.?s\.?)\b", text):
        return [], [
            "SEC Company Facts does not identify the requested geographic segment consistently; consolidated company facts were not substituted."
        ]
    entries = []
    for ticker in tickers:
        for metric in metrics:
            entries.append(
                {
                    "id": f"SEC:{ticker}:{metric['key']}",
                    "name": f"{ticker} {metric['name']}",
                    "unit": metric["unit"],
                    "origin": "U.S. Securities and Exchange Commission",
                    "primary": "sec-companyfacts",
                    "ticker": ticker,
                    "secMetric": metric["key"],
                    "aliases": [],
                    "resolution": "explicit ticker and SEC Company Facts metric",
                }
            )
    return entries, [
        "Company fundamentals were routed to SEC Company Facts; market-price and FRED search were not used."
    ]


def _countries_in_prompt(prompt: str) -> list[tuple[str, str]]:
    text = re.sub(r"\bworld bank\b", " ", prompt.lower())
    output: list[tuple[str, str]] = []
    catalog = dict(COUNTRIES)
    static_match = any(
        re.search(r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])", text)
        for phrase in catalog
    )
    world_bank_metric_match = any(
        any(re.search(pattern, text) for pattern in row["aliases"])
        for row in WORLD_BANK_SERIES
    )
    geography_probe = text
    for row in WORLD_BANK_SERIES:
        for pattern in row["aliases"]:
            geography_probe = re.sub(pattern, " ", geography_probe)
    geography_probe = re.sub(
        r"\b(?:chart|plot|graph|show|compare|versus|vs|world bank|in|for|across|among|"
        r"over|from|since|during|last|past|years?|annual|data|series|at birth|real|nominal|"
        r"current|constant|core|headline|ppp|purchasing power parity|youth|female|male)\b|\d+",
        " ",
        geography_probe,
    )
    geography_probe = re.sub(r"[^a-z]+", " ", geography_probe).strip()
    if not static_match and world_bank_metric_match and geography_probe:
        catalog.update(_world_bank_country_catalog())
    for phrase in sorted(catalog, key=len, reverse=True):
        pattern = r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])"
        if re.search(pattern, text):
            value = catalog[phrase]
            if value not in output:
                output.append(value)
    return output


@lru_cache(maxsize=1)
def _world_bank_country_catalog() -> dict[str, tuple[str, str]]:
    """Load the complete free World Bank geography catalog, retaining static fallbacks."""
    catalog = dict(COUNTRIES)
    try:
        payload = _load_json_url(
            "https://api.worldbank.org/v2/country",
            params={"format": "json", "per_page": 400},
            cache_ttl=30 * 24 * 60 * 60,
        )
        rows = payload[1] if isinstance(payload, list) and len(payload) > 1 else []
        for row in rows or []:
            code = str(row.get("id") or "").upper()
            name = str(row.get("name") or "").strip()
            region = str((row.get("region") or {}).get("value") or "")
            if len(code) != 3 or not name or region == "Aggregates":
                continue
            aliases = {
                name.lower(),
                str(row.get("iso2Code") or "").lower(),
            }
            for alias in aliases:
                if alias:
                    catalog[alias] = (code, name)
    except Exception:  # noqa: BLE001 - offline use retains the curated fallback catalog.
        pass
    return catalog


def _unmatched_geography_scope(prompt: str, countries: list[tuple[str, str]]) -> str:
    if countries:
        return ""
    matches = list(re.finditer(
        r"\b(?:in|across|among)\s+([a-z][a-z .'-]{1,45}?)(?=\s+(?:over|from|since|during|for the last)\b|[,.;]|$)",
        prompt.lower(),
    ))
    for match in matches:
        prefix = prompt[:match.start()].lower()
        metric_precedes = any(
            any(re.search(pattern, prefix) for pattern in row["aliases"])
            for row in WORLD_BANK_SERIES
        )
        if metric_precedes:
            return match.group(1).strip()
    leading_name = re.match(r"^\s*([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\s+", prompt)
    if not leading_name:
        return ""
    candidate = leading_name.group(1).lower()
    if candidate.split()[0] in {
        "chart", "compare", "core", "graph", "headline", "nominal", "plot", "real", "show", "youth"
    }:
        return ""
    remainder = prompt[leading_name.end():].lower()
    metric_follows = any(
        any(re.match(pattern, remainder) for pattern in row["aliases"])
        for row in WORLD_BANK_SERIES
    )
    return candidate if metric_follows else ""


def _world_bank_entries(prompt: str) -> tuple[list[dict[str, Any]], list[str]]:
    text = prompt.lower()
    matches = [
        row for row in WORLD_BANK_SERIES if any(re.search(pattern, text) for pattern in row["aliases"])
    ]
    if not matches:
        return [], []
    unsupported_dimensions = [
        label
        for label, pattern in (
            ("female", r"\b(?:female|women|girls?)\b"),
            ("male", r"\b(?:male|men|boys?)\b"),
            ("urban", r"\burban\b"),
            ("rural", r"\brural\b"),
            ("monthly or quarterly frequency", r"\b(?:monthly|quarterly|month-over-month|quarter-over-quarter)\b"),
            ("seasonal adjustment", r"\b(?:seasonally adjusted|unadjusted)\b"),
        )
        if re.search(pattern, text)
    ]
    if unsupported_dimensions:
        return [], [
            "The current World Bank mapping does not cover the requested dimension(s): "
            + ", ".join(unsupported_dimensions)
            + ". A broader aggregate was not substituted."
        ]
    if re.search(r"(?:\d+(?:\.\d+)?\s*%|percent(?:age)?)\s+of\s+gdp\b", text) and any(
        str(row["indicator"]).endswith(".ZS") for row in matches
    ):
        matches = [row for row in matches if row["indicator"] != "NY.GDP.MKTP.CD"]
    if not matches:
        return [], []
    if re.search(r"\breal gdp per capita\b", text):
        target = "NY.GDP.PCAP.PP.KD" if re.search(r"\b(?:ppp|purchasing power parity)\b", text) else "NY.GDP.PCAP.KD"
        matches = [row for row in matches if row["indicator"] == target]
    elif re.search(r"\b(?:ppp|purchasing power parity)\b", text) and re.search(r"\bgdp per capita\b", text):
        matches = [row for row in matches if row["indicator"] == "NY.GDP.PCAP.PP.CD"]
    elif re.search(r"\bgdp per capita\b", text):
        matches = [row for row in matches if row["indicator"] == "NY.GDP.PCAP.CD"]
    elif re.search(r"\b(?:real gdp growth|gdp growth|economic growth)\b", text):
        matches = [row for row in matches if row["indicator"] == "NY.GDP.MKTP.KD.ZG"]
    elif re.search(r"\b(?:world bank|nominal)\s+gdp\b", text):
        matches = [row for row in matches if row["indicator"] == "NY.GDP.MKTP.CD"]
    if re.search(r"\byouth unemployment\b|\bunemployment ages? 15(?:-| to )24\b", text):
        matches = [row for row in matches if row["indicator"] == "SL.UEM.1524.ZS"]
    countries = _countries_in_prompt(prompt)
    unmatched_geography = _unmatched_geography_scope(prompt, countries)
    if unmatched_geography:
        return [], [
            f"The requested geography '{unmatched_geography}' was not found in the World Bank geography catalog; United States data was not substituted."
        ]
    cross_country = any(code != "USA" for code, _name in countries)
    explicit_provider = "world bank" in text
    specialized_metric = any(
        row["indicator"]
        in {
            "NY.GDP.PCAP.CD",
            "NY.GDP.PCAP.KD",
            "NY.GDP.PCAP.PP.CD",
            "NY.GDP.PCAP.PP.KD",
            "SL.UEM.1524.ZS",
            "BN.CAB.XOKA.GD.ZS",
            "GC.DOD.TOTL.GD.ZS",
            "NE.TRD.GNFS.ZS",
            "NE.EXP.GNFS.ZS",
            "NE.IMP.GNFS.ZS",
            "SP.DYN.LE00.IN",
            "IT.NET.USER.ZS",
            "EN.ATM.CO2E.PC",
        }
        for row in matches
    )
    if not (cross_country or explicit_provider or specialized_metric):
        return [], []
    countries = countries or [("USA", "United States")]
    entries = []
    for country_code, country_name in countries:
        for row in matches:
            entries.append(
                {
                    "id": f"WORLD_BANK:{country_code}:{row['indicator']}",
                    "name": f"{country_name} {row['name']}",
                    "unit": row["unit"],
                    "origin": "World Bank",
                    "primary": "world-bank",
                    "worldBankCountry": country_code,
                    "worldBankCountryName": country_name,
                    "worldBankIndicator": row["indicator"],
                    "aliases": [],
                    "resolution": "curated World Bank indicator mapping",
                }
            )
    return _unique_entries(entries), [
        "Cross-country macro data was routed to the World Bank API; FRED search was not used."
    ]


def normalize_quantitative_phrasing(text: str) -> str:
    """Normalize written quantitative units without erasing their meaning."""
    normalized = text.lower().replace("per cent", "percent")
    normalized = re.sub(r"(?<=\d)\s*(?:pct\.?|percent(?:age)?)\b", "%", normalized)
    normalized = re.sub(r"\b(top|bottom|upper|lower|richest|poorest)-(?=\w)", r"\1 ", normalized)
    normalized = re.sub(r"\b([a-z]+)-percent\b", r"\1 percent", normalized)
    for phrase, value in sorted(QUANTIFIER_NUMBER_WORDS.items(), key=lambda item: -len(item[0])):
        normalized = re.sub(
            rf"\b{re.escape(phrase)}\b(?=\s*(?:percent(?:age)?|pct\.?|%|households?|years?|months?|quarters?|decades?|days?|basis points?))",
            value,
            normalized,
        )
    normalized = re.sub(r"(?<=\d)\s*(?:pct\.?|percent(?:age)?)\b", "%", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def extract_percentile_bands(text: str) -> list[dict[str, Any]]:
    """Parse explicit percentile intervals while preserving their numeric bounds."""
    normalized = normalize_quantitative_phrasing(text)
    number = r"\d+(?:\.\d+)?"
    ordinal = r"(?:st|nd|rd|th)?"
    patterns = (
        rf"\b(?:between|from)\s+({number}){ordinal}\s+(?:and|to|through|-)\s+"
        rf"({number}){ordinal}\s+percentiles?\b",
        rf"\b({number}){ordinal}\s*(?:-|to|through)\s*({number}){ordinal}\s+percentiles?\b",
        rf"\bpercentiles?\s+({number}){ordinal}\s*(?:-|to|through)\s*({number}){ordinal}\b",
    )
    output: list[dict[str, Any]] = []
    seen: set[tuple[float, float]] = set()
    for pattern in patterns:
        for match in re.finditer(pattern, normalized):
            lower, upper = float(match.group(1)), float(match.group(2))
            if not (0.0 <= lower < upper <= 100.0) or (lower, upper) in seen:
                continue
            seen.add((lower, upper))
            output.append(
                {
                    "kind": "percentile_band",
                    "direction": "between",
                    "lower": lower,
                    "upper": upper,
                    "unit": "population percentile",
                    "sourceSpan": match.group(0),
                }
            )
    return output


def extract_quantitative_qualifiers(text: str) -> list[dict[str, Any]]:
    """Return typed numeric qualifiers so 10% cannot silently become a count of 10."""
    normalized = normalize_quantitative_phrasing(text)
    qualifiers: list[dict[str, Any]] = []
    occupied: list[tuple[int, int]] = []
    patterns = (
        (
            "population_percentile",
            r"\b(?P<direction>top|bottom|upper|lower)\s+(?P<value>\d+(?:\.\d+)?)\s*%",
        ),
        (
            "percent",
            r"(?<![a-z0-9])(?P<value>\d+(?:\.\d+)?)\s*%",
        ),
        (
            "basis_points",
            r"\b(?P<value>\d+(?:\.\d+)?)[\s-]*(?:basis points?|bps?)\b",
        ),
        (
            "duration",
            r"\b(?P<value>\d+(?:\.\d+)?)[\s-]*(?P<duration>years?|months?|weeks?|days?)\b",
        ),
        (
            "rank_count",
            r"\b(?P<direction>top|bottom)\s+(?P<value>\d+)\s+(?P<count_unit>households?|companies|stocks?|items?|results?)\b",
        ),
    )
    for kind, pattern in patterns:
        for match in re.finditer(pattern, normalized):
            span = match.span()
            if any(span[0] < end and span[1] > start for start, end in occupied):
                continue
            occupied.append(span)
            row: dict[str, Any] = {
                "kind": kind,
                "raw": match.group(0),
                "value": float(match.group("value")),
            }
            row.update({key: value for key, value in match.groupdict().items() if key != "value" and value})
            qualifiers.append(row)
    return qualifiers


def extract_population_selectors(text: str) -> list[dict[str, Any]]:
    """Parse population ranks separately from counts, thresholds, and time horizons."""
    normalized = normalize_quantitative_phrasing(text)
    selectors: list[dict[str, Any]] = []
    for row in extract_quantitative_qualifiers(normalized):
        if row["kind"] != "population_percentile":
            continue
        value = float(row["value"])
        direction = str(row.get("direction") or "")
        selectors.append(
            {
                "kind": "population_share",
                "direction": "top" if direction in {"top", "upper"} else "bottom",
                "lower": 100.0 - value if direction in {"top", "upper"} else 0.0,
                "upper": 100.0 if direction in {"top", "upper"} else value,
                "unit": "population percentile",
                "sourceSpan": row["raw"],
            }
        )
    selectors.extend(extract_percentile_bands(normalized))
    named_groups = (
        (r"\b(?:top|upper|richest|wealthiest)\s+(?:decile|tenth)\b", "top", 90.0, 100.0),
        (r"\b(?:bottom|lower|poorest)\s+half\b", "bottom", 0.0, 50.0),
        (r"\b(?:upper|top)\s+(?:quintile|fifth)\b", "top", 80.0, 100.0),
        (r"\b(?:lower|bottom)\s+(?:quintile|fifth)\b", "bottom", 0.0, 20.0),
    )
    for pattern, direction, lower, upper in named_groups:
        if match := re.search(pattern, normalized):
            selectors.append(
                {
                    "kind": "population_share",
                    "direction": direction,
                    "lower": lower,
                    "upper": upper,
                    "unit": "population percentile",
                    "sourceSpan": match.group(0),
                }
            )
    unique: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for selector in selectors:
        key = (
            selector["kind"],
            selector.get("direction"),
            selector.get("lower"),
            selector.get("upper"),
        )
        if key not in seen:
            seen.add(key)
            unique.append(selector)
    return unique


def _dfa_groups_in_prompt(prompt: str) -> list[str]:
    text = normalize_quantitative_phrasing(prompt)
    patterns = {
        "top_10": (
            r"\b(?:top|upper|richest|wealthiest)\s+10\s*%",
            r"\b(?:top|upper|wealthiest|richest)\s+(?:decile|tenth)\b",
            r"\b(?:90th|90)\s+percentile\s+(?:and\s+)?(?:above|higher|up)\b",
        ),
        "bottom_50": (
            r"\b(?:bottom|lower|poorest)\s+50\s*%",
            r"\b(?:bottom|lower|poorest)\s+half\b",
            r"\b(?:50th|50)\s+percentile\s+(?:and\s+)?(?:below|lower|down)\b",
        ),
        "top_1": (r"\b(?:top|upper)\s+1\s*%",),
        "top_0_1": (r"\b(?:top|upper)\s+0\.1\s*%",),
        "next_9": (r"\bnext\s+9\s*%",),
        "next_40": (r"\bnext\s+40\s*%",),
    }
    output: list[str] = []
    for key, group_patterns in patterns.items():
        if any(re.search(pattern, text) for pattern in group_patterns):
            output.append(key)
    interval_groups = {
        (90.0, 100.0): "top_10",
        (0.0, 50.0): "bottom_50",
        (99.0, 100.0): "top_1",
        (99.9, 100.0): "top_0_1",
        (90.0, 99.0): "next_9",
        (50.0, 90.0): "next_40",
    }
    for band in extract_percentile_bands(text):
        key = interval_groups.get((float(band["lower"]), float(band["upper"])))
        if key and key not in output:
            output.append(key)
    # The more specific top 0.1% phrase also contains the text "top 1%" only after
    # destructive punctuation removal. Keeping the decimal intact avoids that ambiguity.
    return output


def _dfa_entries(prompt: str) -> tuple[list[dict[str, Any]], list[str]]:
    text = normalize_quantitative_phrasing(prompt)
    if not re.search(
        r"\b(?:household\s+wealth|net\s+worth|wealth|household assets?|household liabilities?)\b",
        text,
    ):
        return [], []
    if re.search(
        r"\b(?:cutoff|threshold|minimum|required|mean|median|average|per household|household count)\b",
        text,
    ):
        return [], [
            "The request asks for a wealth cutoff, household statistic, or count rather than aggregate wealth held. The DFA aggregate was not substituted."
        ]
    group_keys = _dfa_groups_in_prompt(prompt)
    if not group_keys:
        return [], []
    if re.search(r"\bhousehold liabilities?\b", text) and not re.search(r"\b(?:wealth|net worth)\b", text):
        base_column = "Liabilities"
        measure_label = "Household Liabilities"
    elif re.search(r"\bhousehold assets?\b", text) and not re.search(r"\b(?:wealth|net worth)\b", text):
        base_column = "Assets"
        measure_label = "Household Assets"
    else:
        base_column = "Net worth"
        measure_label = "Household Net Worth"

    exclusion_match = re.search(
        r"\b(?:excluding|without|less)\s+(.+?)(?=\s+(?:versus|vs|against|over the last|for the last|over \d+(?:\.\d+)?|for \d+(?:\.\d+)?)\b|$)",
        text,
    )
    excluded_columns: list[str] = []
    if exclusion_match:
        exclusion_text = exclusion_match.group(1)
        residual_exclusion = exclusion_text
        excluded_columns = []
        for column, aliases in DFA_COMPONENT_ALIASES.items():
            if not any(re.search(pattern, exclusion_text) for pattern in aliases):
                continue
            excluded_columns.append(column)
            for pattern in aliases:
                residual_exclusion = re.sub(pattern, " ", residual_exclusion)
        if not excluded_columns:
            return [], [
                f"The requested DFA exclusion '{exclusion_text}' did not match an official balance-sheet component; total wealth was not substituted."
            ]
        residual_exclusion = re.sub(
            r"\b(?:and|or|plus|the|all|assets?|holdings?|components?|categories?)\b",
            " ",
            residual_exclusion,
        )
        residual_exclusion = re.sub(r"[^a-z0-9]+", " ", residual_exclusion).strip()
        if residual_exclusion:
            return [], [
                "The requested DFA exclusion includes unsupported component text "
                f"'{residual_exclusion}'; no partially matched formula was loaded."
            ]
    dfa_terms = [{"column": base_column, "coefficient": 1.0}]
    dfa_terms.extend(
        {"column": column, "coefficient": -1.0}
        for column in excluded_columns
    )
    exclusion_label = ""
    if excluded_columns:
        exclusion_label = " Ex " + " and ".join(excluded_columns)
    identity_suffix = ""
    if base_column != "Net worth" or excluded_columns:
        identity_text = "_".join([base_column, *[f"EX_{column}" for column in excluded_columns]])
        identity_suffix = ":" + re.sub(r"[^A-Z0-9]+", "_", identity_text.upper()).strip("_")
    share_requested = bool(
        re.search(r"\b(?:wealth|net worth)\s+shares?\b", text)
        or re.search(
            r"\bshares?\s+(?:of\s+)?(?:total\s+|aggregate\s+)?(?:household\s+)?(?:wealth|net worth)\b",
            text,
        )
        or re.search(
            r"\bpercent(?:age)?\s+of\s+(?:total\s+|aggregate\s+)?(?:household\s+)?(?:wealth|net worth)\b",
            text,
        )
        or re.search(
            r"\b(?:wealth|net worth)\s+(?:share|percentage)\s+(?:held|owned|controlled)\s+by\b",
            text,
        )
    )
    mode = "shares" if share_requested else "levels"
    unit = "Percent of aggregate" if share_requested else "Millions of U.S. dollars"
    entries: list[dict[str, Any]] = []
    for group_key in group_keys:
        group = DFA_GROUPS[group_key]
        entries.append(
            {
                "id": f"FED_DFA:NETWORTH:{group_key.upper()}:{mode.upper()}{identity_suffix}",
                "name": f"{group['label']} {measure_label}{exclusion_label}"
                + (" Share" if share_requested else ""),
                "unit": unit,
                "origin": "Federal Reserve Distributional Financial Accounts",
                "primary": "fed-dfa",
                # Shares are derived from unrounded levels; the published shares file is rounded
                # to one decimal place and can introduce visible aggregation error.
                "dfaFile": "dfa-networth-levels.csv",
                "dfaColumn": base_column,
                "dfaTerms": dfa_terms,
                "dfaGroupKey": group_key,
                "dfaCategories": list(group["categories"]),
                "dfaMode": mode,
                "fredFallbackComponents": (
                    list(group["fredLevels"])
                    if base_column == "Net worth" and not excluded_columns
                    else []
                ),
                "fredShareDenominator": (
                    ["WFRBLT01026", "WFRBLN09053", "WFRBLN40080", "WFRBLB50107"]
                    if share_requested and base_column == "Net worth" and not excluded_columns
                    else []
                ),
                "dfaMeasureFormula": " - ".join([base_column, *excluded_columns]),
                "aliases": [],
                "resolution": (
                    "exact wealth-percentile mapping to the Federal Reserve Distributional "
                    "Financial Accounts"
                ),
            }
        )
    return entries, [
        "Household wealth percentiles were routed to the Federal Reserve Distributional Financial "
        "Accounts. Percent signs identify population groups; they were not interpreted as a top-N count."
    ]


def resolve_special_series(prompt: str) -> tuple[list[dict[str, Any]], list[str]]:
    entries: list[dict[str, Any]] = []
    notices: list[str] = []
    for resolver in (_sp_earnings_entries, _sec_entries, _world_bank_entries, _dfa_entries):
        resolved, resolver_notices = resolver(prompt)
        entries.extend(resolved)
        notices.extend(resolver_notices)
    return _unique_entries(entries), list(dict.fromkeys(notices))


def clause_is_handled(clause: str, entries: list[dict[str, Any]]) -> bool:
    text = normalize_quantitative_phrasing(clause)
    if any(
        normalize_quantitative_phrasing(str(entry.get("resolvedClause") or "")) == text
        for entry in entries
        if entry.get("resolvedClause")
    ):
        return True
    providers = {entry.get("primary") for entry in entries}
    if "sp-earnings" in providers and (
        re.search(r"\b(?:earnings|eps|tech|technology|staples|sector)\b", text)
        or any(any(re.search(pattern, text) for pattern in patterns) for patterns in SECTOR_ALIASES.values())
    ):
        return True
    if "sec-companyfacts" in providers and (
        _explicit_tickers(clause)
        or any(any(re.search(pattern, text) for pattern in metric["aliases"]) for metric in SEC_METRICS)
    ):
        return True
    if "world-bank" in providers:
        if _countries_in_prompt(clause) or any(
            any(re.search(pattern, text) for pattern in row["aliases"]) for row in WORLD_BANK_SERIES
        ):
            return True
    if "fed-dfa" in providers:
        requested_groups = set(_dfa_groups_in_prompt(clause))
        resolved_groups = {
            str(entry.get("dfaGroupKey"))
            for entry in entries
            if entry.get("primary") == "fed-dfa"
        }
        if requested_groups and requested_groups.issubset(resolved_groups):
            return True
    return False


def suppress_standard_entry(entry: dict[str, Any], prompt: str, special_entries: list[dict[str, Any]]) -> bool:
    providers = {row.get("primary") for row in special_entries}
    text = prompt.lower()
    if is_sp_earnings_prompt(prompt) and entry.get("id") == "SP500":
        return not bool(re.search(r"\b(?:price|index level|market level)\b", text))
    if SP500_REFERENCE_PATTERN.search(prompt) and SP_VALUATION_PATTERN.search(prompt) and entry.get("id") == "SP500":
        return not bool(re.search(r"\b(?:index price|market level)\b", text))
    if "sec-companyfacts" in providers and entry.get("primary") == "yahoo":
        ticker = str(entry.get("yahoo") or "").lstrip("^").upper()
        if ticker in _explicit_tickers(prompt):
            return not bool(re.search(r"\b(?:price|share price|stock price)\b", text))
    if "world-bank" in providers and entry.get("id") in {"GDP", "GDPC1", "UNRATE", "CPIAUCSL"}:
        return True
    if "fed-dfa" in providers and entry.get("id") in {"TDSP", "HCCSDODNS", "TNWBSHNO"}:
        return True
    return False


def _load_json_url(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    cache_ttl: int = 86400,
) -> Any:
    result = http_get(
        url,
        params=params,
        headers=headers,
        cache_ttl=cache_ttl,
        allow_stale=True,
    )
    return json.loads(result.text)


def _valid_xlsx(content: bytes) -> bool:
    if len(content) < 50_000 or content[:2] != b"PK":
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            names = set(archive.namelist())
            return "xl/workbook.xml" in names and "[Content_Types].xml" in names
    except zipfile.BadZipFile:
        return False


def _read_provider_metadata() -> dict[str, Any]:
    try:
        value = json.loads(SP_EARNINGS_METADATA_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_provider_workbook(content: bytes, metadata: dict[str, Any]) -> None:
    PROVIDER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = SP_EARNINGS_CACHE_PATH.with_suffix(".tmp")
    temporary.write_bytes(content)
    temporary.replace(SP_EARNINGS_CACHE_PATH)
    SP_EARNINGS_METADATA_PATH.write_text(json.dumps(metadata, indent=2), encoding="utf-8")


def _latest_sp_archive() -> tuple[str, str]:
    payload = _load_json_url(
        SP_EARNINGS_CDX_URL,
        params={
            "url": SP_EARNINGS_CANONICAL_URL,
            "output": "json",
            "filter": "statuscode:200",
            "fl": "timestamp,original,statuscode,digest,length",
            "collapse": "digest",
        },
        cache_ttl=24 * 60 * 60,
    )
    rows = payload[1:] if isinstance(payload, list) and payload else []
    candidates = [row for row in rows if isinstance(row, list) and len(row) >= 5 and str(row[2]) == "200"]
    if not candidates:
        raise RuntimeError("Internet Archive returned no successful captures of S&P's earnings workbook.")
    timestamp = str(max(candidates, key=lambda row: str(row[0]))[0])
    replay_url = f"https://web.archive.org/web/{timestamp}id_/{SP_EARNINGS_CANONICAL_URL}"
    return timestamp, replay_url


def fetch_sp_workbook() -> tuple[bytes, dict[str, Any]]:
    metadata = _read_provider_metadata()
    try:
        cached_content = SP_EARNINGS_CACHE_PATH.read_bytes()
    except OSError:
        cached_content = b""
    if _valid_xlsx(cached_content):
        checked = float(metadata.get("checkedAtEpoch") or 0)
        if time.time() - checked <= 7 * 24 * 60 * 60:
            return cached_content, metadata

    errors: list[str] = []
    try:
        timestamp, replay_url = _latest_sp_archive()
        if timestamp == str(metadata.get("archiveTimestamp")) and _valid_xlsx(cached_content):
            metadata["checkedAtEpoch"] = time.time()
            metadata["checkedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            _write_provider_workbook(cached_content, metadata)
            return cached_content, metadata
        result = http_get_bytes(
            replay_url,
            timeout=45,
            cache_ttl=7 * 24 * 60 * 60,
            allow_stale=True,
        )
        if not _valid_xlsx(result.content):
            raise RuntimeError("archived response was not a valid Excel workbook")
        metadata = {
            "canonicalUrl": SP_EARNINGS_CANONICAL_URL,
            "archiveUrl": replay_url,
            "archiveTimestamp": timestamp,
            "checkedAtEpoch": time.time(),
            "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "transport": result.transport,
            "transportWarning": result.warning,
        }
        _write_provider_workbook(result.content, metadata)
        return result.content, metadata
    except Exception as exc:  # noqa: BLE001 - stale verified workbook remains a declared fallback.
        errors.append(str(exc))

    if _valid_xlsx(cached_content):
        metadata["stale"] = True
        metadata["refreshError"] = " | ".join(errors)
        return cached_content, metadata
    raise RuntimeError("S&P earnings workbook could not be loaded. " + " | ".join(errors))


def _column_number(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        return 0
    result = 0
    for character in letters.group(0):
        result = result * 26 + ord(character) - ord("A") + 1
    return result


@lru_cache(maxsize=16)
def _xlsx_sheet_cells(content: bytes, sheet_name: str) -> dict[tuple[int, int], Any]:
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    office_rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in shared_root.findall(f"{{{main_ns}}}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{{{main_ns}}}t")))
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {
            row.attrib.get("Id"): row.attrib.get("Target")
            for row in relationships.findall(f"{{{package_rel_ns}}}Relationship")
        }
        target = None
        sheets = workbook.find(f"{{{main_ns}}}sheets")
        for sheet in sheets if sheets is not None else []:
            if sheet.attrib.get("name") == sheet_name:
                target = targets.get(sheet.attrib.get(f"{{{office_rel_ns}}}id"))
                break
        if not target:
            raise RuntimeError(f"Workbook does not contain the {sheet_name!r} worksheet.")
        sheet_path = str(PurePosixPath("xl") / target).replace("xl/xl/", "xl/")
        sheet_root = ET.fromstring(archive.read(sheet_path))
        cells: dict[tuple[int, int], Any] = {}
        for cell in sheet_root.iter(f"{{{main_ns}}}c"):
            reference = cell.attrib.get("r") or ""
            row_match = re.search(r"(\d+)$", reference)
            if not row_match:
                continue
            row_number = int(row_match.group(1))
            column_number = _column_number(reference)
            cell_type = cell.attrib.get("t")
            value_node = cell.find(f"{{{main_ns}}}v")
            if cell_type == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(f"{{{main_ns}}}t"))
            elif value_node is None:
                value = None
            elif cell_type == "s":
                value = shared[int(value_node.text or "0")]
            elif cell_type in {"str", "e"}:
                value = value_node.text or ""
            else:
                raw = value_node.text or ""
                try:
                    value = float(raw)
                except ValueError:
                    value = raw
            cells[(row_number, column_number)] = value
        return cells


def _excel_date(value: Any) -> date | None:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return date(1899, 12, 30) + timedelta(days=int(float(value)))
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _quarter_end(header: Any) -> date | None:
    match = re.fullmatch(r"\s*(\d{4})(?:E)?\s*Q([1-4])\s*", str(header or ""), re.I)
    if not match:
        return None
    month = int(match.group(2)) * 3
    day = {3: 31, 6: 30, 9: 30, 12: 31}[month]
    return date(int(match.group(1)), month, day)


def _calendar_quarter_end(value: date) -> date:
    month = ((value.month - 1) // 3 + 1) * 3
    day = {3: 31, 6: 30, 9: 30, 12: 31}[month]
    return date(value.year, month, day)


def _normalized_label(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


@lru_cache(maxsize=4)
def parse_sp_earnings_contributions(content: bytes) -> dict[str, Any]:
    cells = _xlsx_sheet_cells(content, "ESTIMATES&PEs")
    marker_row = next(
        (
            row
            for (row, column), value in cells.items()
            if column == 1 and "operating earnings contribution" in str(value or "").lower()
        ),
        None,
    )
    if marker_row is None:
        raise RuntimeError("S&P workbook operating-earnings contribution table was not found.")

    date_row = marker_row + 2
    quarter_columns = {
        column: _calendar_quarter_end(parsed)
        for (row, column), value in cells.items()
        if row == date_row and (parsed := _excel_date(value)) is not None
    }
    if not quarter_columns:
        raise RuntimeError("S&P workbook contained no dated earnings-contribution columns.")

    canonical_labels = {
        _normalized_label(sector): sector for sector in SECTOR_LABELS
    }
    canonical_labels["s&p 500"] = "S&P 500"
    rows: dict[str, dict[date, float]] = {}
    for row_number in range(marker_row + 3, marker_row + 24):
        canonical = canonical_labels.get(_normalized_label(cells.get((row_number, 1))))
        if not canonical:
            continue
        values: dict[date, float] = {}
        for column, quarter in quarter_columns.items():
            raw = cells.get((row_number, column))
            if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
                values[quarter] = float(raw)
        if values:
            rows[canonical] = values
            if canonical == "S&P 500":
                break

    if "S&P 500" not in rows:
        raise RuntimeError("S&P contribution table omitted its 100% total validation row.")
    total_errors = [abs(value - 1.0) for value in rows["S&P 500"].values()]
    if max(total_errors, default=1.0) > 0.000001:
        raise RuntimeError("S&P contribution table failed its published 100% total check.")

    sector_rows = [rows.get(sector) for sector in SECTOR_LABELS]
    common_quarters = set(rows["S&P 500"])
    if all(sector_rows):
        for sector_row in sector_rows:
            common_quarters &= set(sector_row or {})
    sector_sum_errors = [
        abs(sum(float((sector_row or {})[quarter]) for sector_row in sector_rows) - 1.0)
        for quarter in sorted(common_quarters)
    ] if all(sector_rows) else []
    max_sector_sum_error = max(sector_sum_errors, default=0.0)
    if sector_sum_errors and max_sector_sum_error > 0.000001:
        raise RuntimeError("S&P sector contribution shares did not reconcile to 100%.")

    return {
        "rows": rows,
        "firstQuarter": min(quarter_columns.values()),
        "lastQuarter": max(quarter_columns.values()),
        "validation": {
            "status": "pass",
            "totalRowMaxError": max(total_errors, default=0.0),
            "sectorSumMaxError": max_sector_sum_error,
            "quartersChecked": len(sector_sum_errors),
        },
    }


@lru_cache(maxsize=4)
def parse_sp_sales_earnings_contributions(content: bytes) -> dict[str, Any]:
    """Rebuild sector earnings shares from two independently published S&P tables."""
    cells = _xlsx_sheet_cells(content, "SALES")

    def marker_row(label: str) -> int:
        row = next(
            (
                row_number
                for (row_number, column), value in cells.items()
                if column == 1 and label in _normalized_label(value)
            ),
            None,
        )
        if row is None:
            raise RuntimeError(f"S&P workbook {label} table was not found.")
        return row

    margins_row = marker_row("quarterly operating margins")
    sales_row = marker_row("operating sales contribution")
    # Both tables share columns. The sales-contribution header is authoritative
    # because one archived workbook duplicates the Q3 2016 label over Q2 margins.
    quarter_columns = {
        column: _calendar_quarter_end(parsed)
        for (row, column), value in cells.items()
        if row == sales_row and (parsed := _excel_date(value)) is not None
    }
    if not quarter_columns:
        raise RuntimeError("S&P SALES table contained no dated columns.")
    header_mismatches = sum(
        1
        for column, quarter in quarter_columns.items()
        if (parsed := _excel_date(cells.get((margins_row, column)))) is not None
        and _calendar_quarter_end(parsed) != quarter
    )

    def parse_table(row_number: int) -> dict[str, dict[date, float]]:
        canonical_labels = {_normalized_label(sector): sector for sector in SECTOR_LABELS}
        canonical_labels["real estate*"] = "real estate"
        canonical_labels["s&p 500"] = "S&P 500"
        output: dict[str, dict[date, float]] = {}
        for data_row in range(row_number + 1, row_number + 15):
            canonical = canonical_labels.get(_normalized_label(cells.get((data_row, 1))))
            if not canonical:
                continue
            values = {
                quarter: float(raw)
                for column, quarter in quarter_columns.items()
                if isinstance((raw := cells.get((data_row, column))), (int, float))
                and math.isfinite(float(raw))
            }
            if values:
                output[canonical] = values
            if canonical == "S&P 500":
                break
        return output

    margins = parse_table(margins_row)
    sales_shares = parse_table(sales_row)
    required_rows = [*SECTOR_LABELS, "S&P 500"]
    missing = [
        label for label in required_rows if label not in margins or label not in sales_shares
    ]
    if missing:
        raise RuntimeError("S&P SALES tables omitted required row(s): " + ", ".join(missing))

    rows: dict[str, dict[date, float]] = {sector: {} for sector in SECTOR_LABELS}
    total_quarters = set(margins["S&P 500"]) & set(sales_shares["S&P 500"])
    for sector in SECTOR_LABELS:
        sector_quarters = (
            set(margins[sector]) & set(sales_shares[sector]) & total_quarters
        )
        for quarter in sorted(sector_quarters):
            total_margin = margins["S&P 500"][quarter]
            if abs(total_margin) < 1e-12:
                continue
            rows[sector][quarter] = (
                sales_shares[sector][quarter] * margins[sector][quarter] / total_margin
            )

    common_quarters = set.intersection(*(set(values) for values in rows.values()))
    sector_sum_errors: list[float] = []
    for quarter in sorted(common_quarters):
        sector_sum_errors.append(
            abs(sum(rows[sector][quarter] for sector in SECTOR_LABELS) - 1.0)
        )

    available = sorted(set().union(*(set(values) for values in rows.values())))
    if not available:
        raise RuntimeError("S&P SALES tables had no reconstructable earnings-contribution quarters.")
    max_sector_sum_error = max(sector_sum_errors, default=1.0)
    # S&P flags the legacy Real Estate history as pro forma; a small all-sector
    # residual is therefore expected around the 2016 classification change.
    if max_sector_sum_error > 0.02:
        raise RuntimeError(
            "S&P reconstructed earnings shares failed the 100% reconciliation check."
        )
    return {
        "rows": rows,
        "firstQuarter": available[0],
        "lastQuarter": available[-1],
        "validation": {
            "status": "pass",
            "sectorSumMaxError": max_sector_sum_error,
            "quartersChecked": len(available),
            "alignedHeaderCorrections": header_mismatches,
        },
        "method": (
            "Each sector's operating-sales contribution multiplied by its operating margin, "
            "divided by the S&P 500 operating margin"
        ),
    }


@lru_cache(maxsize=4)
def parse_sp_sector_workbook(content: bytes) -> dict[str, Any]:
    cells = _xlsx_sheet_cells(content, "SECTOR EPS")
    header_row = next(
        (
            row
            for (row, column), value in cells.items()
            if column == 1 and str(value or "").strip().upper() == "INDEX NAME"
        ),
        None,
    )
    if header_row is None:
        raise RuntimeError("S&P workbook SECTOR EPS header was not found.")
    historical_row = next(
        (
            row
            for (row, column), value in cells.items()
            if column == 1 and "historical actuals" in str(value or "").lower()
        ),
        None,
    )
    data_as_of_row = next(
        (
            row
            for (row, column), value in cells.items()
            if column == 1 and "data as of" in str(value or "").lower()
        ),
        None,
    )
    actual_through = _excel_date(cells.get((historical_row, 2))) if historical_row else None
    data_as_of = _excel_date(cells.get((data_as_of_row, 2))) if data_as_of_row else None
    row_numbers = {
        str(value or "").strip(): row
        for (row, column), value in cells.items()
        if column == 1 and row > header_row
    }
    quarter_columns = {
        column: quarter
        for (row, column), value in cells.items()
        if row == header_row and (quarter := _quarter_end(value)) is not None
    }
    if not quarter_columns:
        raise RuntimeError("S&P workbook contained no quarterly sector-EPS columns.")
    rows: dict[str, dict[date, float]] = {}
    for label, row_number in row_numbers.items():
        values: dict[date, float] = {}
        for column, quarter in quarter_columns.items():
            raw = cells.get((row_number, column))
            if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
                values[quarter] = float(raw)
        if values:
            rows[label] = values
    return {
        "rows": rows,
        "actualThrough": actual_through,
        "dataAsOf": data_as_of,
        "firstQuarter": min(quarter_columns.values()),
        "lastQuarter": max(quarter_columns.values()),
    }


@lru_cache(maxsize=4)
def parse_sp_quarterly_operating_eps(content: bytes) -> dict[str, Any]:
    cells = _xlsx_sheet_cells(content, "QUARTERLY DATA")
    operating_column = next(
        (
            column
            for (row, column), value in cells.items()
            if row <= 8 and str(value or "").strip().upper() == "OPERATING"
        ),
        None,
    )
    if operating_column is None:
        raise RuntimeError("S&P workbook quarterly operating-EPS column was not found.")
    observations: dict[date, float] = {}
    for (row, column), raw_date in cells.items():
        if column != 1:
            continue
        parsed_date = _excel_date(raw_date)
        raw_value = cells.get((row, operating_column))
        if (
            parsed_date is None
            or not isinstance(raw_value, (int, float))
            or not math.isfinite(float(raw_value))
        ):
            continue
        observations[_calendar_quarter_end(parsed_date)] = float(raw_value)
    if not observations:
        raise RuntimeError("S&P workbook contained no quarterly operating-EPS observations.")
    return {
        "rows": observations,
        "firstQuarter": min(observations),
        "lastQuarter": max(observations),
    }


def fetch_sp_historical_contribution_workbook() -> tuple[bytes, dict[str, Any]]:
    try:
        cached = SP_EARNINGS_OLDEST_CACHE_PATH.read_bytes()
    except OSError:
        cached = b""
    if _valid_xlsx(cached):
        try:
            cache_metadata = json.loads(
                SP_EARNINGS_OLDEST_METADATA_PATH.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            cache_metadata = {}
        timestamp = str(
            cache_metadata.get("archiveTimestamp") or SP_EARNINGS_CONTRIBUTION_ARCHIVES[0]
        )
        return cached, {
            "archiveUrl": str(
                cache_metadata.get("archiveUrl")
                or f"https://web.archive.org/web/{timestamp}id_/{SP_EARNINGS_CANONICAL_URL}"
            ),
            "archiveTimestamp": timestamp,
            "transport": "verified provider cache",
            "transportWarning": None,
        }

    errors: list[str] = []
    for timestamp in SP_EARNINGS_CONTRIBUTION_ARCHIVES:
        replay_urls = [
            f"https://web.archive.org/web/{timestamp}id_/{SP_EARNINGS_CANONICAL_URL}",
            f"https://web.archive.org/web/{timestamp}if_/{SP_EARNINGS_CANONICAL_URL}",
            f"https://web.archive.org/web/{timestamp}im_/{SP_EARNINGS_CANONICAL_URL}",
            f"https://web.archive.org/web/{timestamp}id_/http://www.spglobal.com/spdji/en/documents/additional-material/sp-500-eps-est.xlsx",
        ]
        for replay_url in replay_urls:
            try:
                result = http_get_bytes(
                    replay_url,
                    timeout=45,
                    cache_ttl=365 * 24 * 60 * 60,
                    allow_stale=True,
                )
                if not _valid_xlsx(result.content):
                    raise RuntimeError("response was not a valid Excel workbook")
                PROVIDER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                temporary = SP_EARNINGS_OLDEST_CACHE_PATH.with_suffix(".tmp")
                temporary.write_bytes(result.content)
                temporary.replace(SP_EARNINGS_OLDEST_CACHE_PATH)
                metadata = {
                    "archiveUrl": replay_url,
                    "archiveTimestamp": timestamp,
                    "cachedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                }
                SP_EARNINGS_OLDEST_METADATA_PATH.write_text(
                    json.dumps(metadata, indent=2), encoding="utf-8"
                )
                return result.content, {
                    **metadata,
                    "transport": result.transport,
                    "transportWarning": result.warning,
                }
            except Exception as exc:  # noqa: BLE001 - try the next capture/replay mode.
                errors.append(f"{replay_url}: {exc}")
    raise RuntimeError("oldest archived S&P workbook failed from every replay mode. " + " | ".join(errors))


def load_sp_contribution_history(
    latest_content: bytes,
    latest_metadata: dict[str, Any],
) -> dict[str, Any]:
    latest_sector = parse_sp_sector_workbook(latest_content)
    latest = parse_sp_earnings_contributions(latest_content)
    reconstructed = parse_sp_sales_earnings_contributions(latest_content)
    snapshots = [
        {
            "parsed": latest,
            "actualThrough": latest_sector.get("actualThrough"),
            "sourceUrl": latest_metadata.get("archiveUrl") or SP_EARNINGS_CANONICAL_URL,
            "timestamp": latest_metadata.get("archiveTimestamp"),
        }
    ]
    warnings: list[str] = []
    try:
        historical_cached = SP_EARNINGS_OLDEST_CACHE_PATH.read_bytes()
    except OSError:
        historical_cached = b""
    if _valid_xlsx(historical_cached):
        historical_content, historical_metadata = fetch_sp_historical_contribution_workbook()
        historical_sector = parse_sp_sector_workbook(historical_content)
        snapshots.append(
            {
                "parsed": parse_sp_earnings_contributions(historical_content),
                "actualThrough": historical_sector.get("actualThrough"),
                "sourceUrl": historical_metadata.get("archiveUrl"),
                "timestamp": historical_metadata.get("archiveTimestamp"),
            }
        )
        if historical_metadata.get("transportWarning"):
            warnings.append(str(historical_metadata["transportWarning"]))
    else:
        warnings.append(
            "An older official S&P contribution snapshot is not cached; the current verified "
            "snapshot is used immediately without waiting on the Internet Archive."
        )

    merged: dict[str, dict[date, float]] = {sector: {} for sector in SECTOR_LABELS}
    published_rows: dict[str, dict[date, float]] = {
        sector: {} for sector in SECTOR_LABELS
    }
    supporting_sources: list[dict[str, str]] = []
    validations: list[dict[str, Any]] = []
    # Newer snapshots win on overlap because S&P may revise historical values.
    for snapshot in snapshots:
        source_url = str(snapshot.get("sourceUrl") or "")
        if source_url and all(row["url"] != source_url for row in supporting_sources):
            supporting_sources.append(
                {
                    "name": "Archived official S&P earnings workbook",
                    "url": source_url,
                    "role": f"Operating earnings contribution snapshot {snapshot.get('timestamp') or ''}".strip(),
                }
            )
        validations.append(snapshot["parsed"]["validation"])
        actual_through = snapshot.get("actualThrough")
        for sector in SECTOR_LABELS:
            for quarter, value in snapshot["parsed"]["rows"].get(sector, {}).items():
                if actual_through and quarter > actual_through:
                    continue
                merged[sector].setdefault(quarter, value)
                published_rows[sector].setdefault(quarter, value)

    actual_through = latest_sector.get("actualThrough")
    reconstructed_quarters: set[date] = set()
    for sector in SECTOR_LABELS:
        for quarter, value in reconstructed["rows"][sector].items():
            if actual_through and quarter > actual_through:
                continue
            if quarter not in merged[sector]:
                merged[sector][quarter] = value
                reconstructed_quarters.add(quarter)

    overlap_errors: list[float] = []
    overlap_quarters: set[date] = set()
    for sector in SECTOR_LABELS:
        for quarter in set(published_rows[sector]) & set(reconstructed["rows"][sector]):
            if actual_through and quarter > actual_through:
                continue
            overlap_quarters.add(quarter)
            overlap_errors.append(
                abs(published_rows[sector][quarter] - reconstructed["rows"][sector][quarter])
            )
    max_overlap_error = max(overlap_errors, default=0.0)
    if overlap_errors and max_overlap_error > 0.005:
        raise RuntimeError(
            "S&P reconstructed earnings shares did not validate against published contribution history."
        )

    reconstruction_source = str(latest_metadata.get("archiveUrl") or SP_EARNINGS_CANONICAL_URL)
    for source in supporting_sources:
        if source["url"] == reconstruction_source:
            source["role"] += "; SALES-table inputs for validated historical reconstruction"
            break
    else:
        supporting_sources.append(
            {
                "name": "Archived official S&P earnings workbook",
                "url": reconstruction_source,
                "role": "SALES-table inputs for validated historical reconstruction",
            }
        )
    if reconstructed_quarters:
        warnings.append(
            "Before the published contribution snapshots begin, sector earnings shares are "
            "derived from S&P's operating-sales contribution and operating-margin tables."
        )
        if any(quarter < date(2016, 9, 30) for quarter in reconstructed_quarters):
            warnings.append(
                "S&P labels Real Estate before its 2016 sector launch as pro forma and includes "
                "the historical Real Estate component in Financials."
            )

    available = sorted(set().union(*(set(values) for values in merged.values())))
    if not available:
        raise RuntimeError("No historical actual S&P earnings-contribution observations were found.")
    return {
        "rows": merged,
        "firstQuarter": available[0],
        "lastQuarter": available[-1],
        "validation": {
            "status": "pass",
            "snapshotsChecked": len(validations),
            "maxSectorSumError": max(
                (float(row.get("sectorSumMaxError") or 0.0) for row in validations),
                default=0.0,
            ),
            "reconstructionMethod": reconstructed["method"],
            "reconstructedQuarters": len(reconstructed_quarters),
            "publishedOverlapQuarters": len(overlap_quarters),
            "publishedOverlapMeanAbsoluteError": (
                sum(overlap_errors) / len(overlap_errors) if overlap_errors else 0.0
            ),
            "publishedOverlapMaxAbsoluteError": max_overlap_error,
            "reconstructionSectorSumMaxError": reconstructed["validation"][
                "sectorSumMaxError"
            ],
        },
        "supportingSources": supporting_sources,
        "warnings": warnings,
    }


def fetch_sp_earnings_series(entry: dict[str, Any], start: date | None, end: date | None) -> dict[str, Any]:
    content, metadata = fetch_sp_workbook()
    workbook = parse_sp_sector_workbook(content)
    quarterly_operating = parse_sp_quarterly_operating_eps(content)
    requested_rows = list(entry.get("spWorkbookRows") or [])
    missing = [row for row in requested_rows if row not in workbook["rows"]]
    if missing:
        raise RuntimeError("S&P workbook omitted required row(s): " + ", ".join(missing))
    excluded_sectors = list(entry.get("excludedSectors") or [])
    sector_index = entry.get("sectorIndex")
    source_values = (
        workbook["rows"][requested_rows[0]]
        if sector_index
        else quarterly_operating["rows"]
    )
    contribution_history = (
        load_sp_contribution_history(content, metadata) if excluded_sectors else None
    )
    actual_through = workbook.get("actualThrough")
    include_estimates = bool(entry.get("includeEstimates"))
    end_date = end or date.today()
    observations: list[dict[str, Any]] = []
    for quarter, source_value in sorted(source_values.items()):
        if start and quarter < start:
            continue
        if quarter > end_date:
            continue
        if not include_estimates and actual_through and quarter > actual_through:
            continue
        component_values = [
            contribution_history["rows"][sector].get(quarter)
            for sector in excluded_sectors
        ] if contribution_history else []
        if any(value is None for value in component_values):
            continue
        value = source_value * (1.0 - sum(float(component) for component in component_values))
        observations.append({"date": quarter.isoformat(), "value": round(value, 6)})
    if not observations:
        raise RuntimeError("No S&P earnings observations overlapped the requested range.")
    archive_url = str(metadata.get("archiveUrl") or SP_EARNINGS_CANONICAL_URL)
    warnings = [
        (
            "Published S&P contribution figures are used where available; earlier quarters use "
            "the validated reconstruction from S&P's sales-contribution and operating-margin tables."
            if excluded_sectors
            else (
                "The archived official workbook's standalone sector-index operating-EPS history "
                "begins in Q1 2008."
                if sector_index
                else "The archived official workbook's quarterly S&P 500 operating-EPS history begins in Q1 1988."
            )
        ),
        "The live public workbook was retired; this is the latest located archived capture of S&P's official workbook.",
        "Verify S&P redistribution rights before using this dataset in a public production service.",
    ]
    if contribution_history:
        warnings.extend(contribution_history.get("warnings") or [])
    if metadata.get("stale"):
        warnings.append(f"Workbook refresh failed; cached copy used: {metadata.get('refreshError')}")
    if metadata.get("transportWarning"):
        warnings.append(str(metadata["transportWarning"]))
    formula = str(entry.get("formula") or "S&P 500 operating EPS")
    return {
        "id": entry["id"],
        "name": entry["name"],
        "unit": entry["unit"],
        "origin": entry["origin"],
        "provider": "S&P Dow Jones Indices workbook (archived official copy)",
        "providerSeries": (
            "QUARTERLY DATA operating EPS * published/validated derived earnings contribution"
            if excluded_sectors
            else (
                f"SECTOR EPS / {requested_rows[0]}"
                if sector_index
                else "QUARTERLY DATA / OPERATING EARNINGS PER SHARE"
            )
        ),
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": archive_url,
        "canonicalSourceUrl": SP_EARNINGS_CANONICAL_URL,
        "resolution": entry.get("resolution"),
        "formula": formula,
        "components": requested_rows + [
            f"{sector.title()} operating earnings contribution share"
            for sector in excluded_sectors
        ],
        "dataAsOf": workbook["dataAsOf"].isoformat() if workbook.get("dataAsOf") else None,
        "actualThrough": actual_through.isoformat() if actual_through else None,
        "archiveTimestamp": metadata.get("archiveTimestamp"),
        "providerWarnings": warnings,
        "calculationValidation": contribution_history.get("validation") if contribution_history else None,
        "supportingSources": contribution_history.get("supportingSources") if contribution_history else [],
        "preferredUnits": "raw",
    }


def fetch_world_bank_series(entry: dict[str, Any], start: date | None, end: date | None) -> dict[str, Any]:
    start_year = (start or date(1960, 1, 1)).year
    end_year = (end or date.today()).year
    country = entry["worldBankCountry"]
    indicator = entry["worldBankIndicator"]
    payload = _load_json_url(
        f"https://api.worldbank.org/v2/country/{country}/indicator/{indicator}",
        params={"format": "json", "per_page": 20000, "date": f"{start_year}:{end_year}"},
        cache_ttl=24 * 60 * 60,
    )
    rows = payload[1] if isinstance(payload, list) and len(payload) > 1 else []
    observations = []
    for row in rows or []:
        raw = row.get("value")
        year = str(row.get("date") or "")
        try:
            value = float(raw)
            row_date = date(int(year), 12, 31)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(value) or (start and row_date < start) or (end and row_date > end):
            continue
        observations.append({"date": row_date.isoformat(), "value": value})
    observations.sort(key=lambda row: row["date"])
    if not observations:
        raise RuntimeError(f"World Bank returned no usable observations for {country}/{indicator}.")
    source_url = (
        f"https://data.worldbank.org/indicator/{urllib.parse.quote(indicator)}"
        f"?locations={urllib.parse.quote(country)}"
    )
    return {
        "id": entry["id"],
        "name": entry["name"],
        "unit": entry["unit"],
        "origin": entry["origin"],
        "provider": "World Bank API",
        "providerSeries": f"{country}/{indicator}",
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": source_url,
        "resolution": entry.get("resolution"),
        "preferredUnits": "raw",
    }


def _sec_ticker_map() -> dict[str, dict[str, Any]]:
    payload = _load_json_url(
        "https://www.sec.gov/files/company_tickers.json",
        headers=SEC_REQUEST_HEADERS,
        cache_ttl=7 * 24 * 60 * 60,
    )
    output: dict[str, dict[str, Any]] = {}
    for row in payload.values() if isinstance(payload, dict) else []:
        ticker = str(row.get("ticker") or "").upper()
        if ticker:
            output[ticker] = row
    return output


def _sec_metric(key: str) -> dict[str, Any]:
    return next(metric for metric in SEC_METRICS if metric["key"] == key)


def fetch_sec_companyfacts_series(
    entry: dict[str, Any], start: date | None, end: date | None
) -> dict[str, Any]:
    ticker = entry["ticker"]
    company = _sec_ticker_map().get(ticker)
    if not company:
        raise RuntimeError(f"SEC ticker map did not contain {ticker}.")
    cik = str(company["cik_str"]).zfill(10)
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    payload = _load_json_url(
        url,
        headers=SEC_REQUEST_HEADERS,
        cache_ttl=24 * 60 * 60,
    )
    facts = payload.get("facts", {}).get("us-gaap", {})
    metric = _sec_metric(entry["secMetric"])
    concept_rows: list[tuple[int, str, list[dict[str, Any]]]] = []
    for priority, concept in enumerate(metric["concepts"]):
        concept_payload = facts.get(concept) or {}
        units = concept_payload.get("units") or {}
        rows = []
        for unit_key in metric["unitKeys"]:
            rows = units.get(unit_key) or []
            if rows:
                break
        if rows:
            concept_rows.append((priority, concept, rows))
    if not concept_rows:
        raise RuntimeError(f"SEC Company Facts did not provide {metric['name']} for {ticker}.")
    latest_by_period: dict[str, dict[str, Any]] = {}
    for priority, concept, fact_rows in concept_rows:
        for row in fact_rows:
            if row.get("form") not in {"10-K", "10-K/A", "20-F", "20-F/A", "40-F"}:
                continue
            if row.get("fp") not in {None, "FY"} and not str(row.get("frame") or "").startswith("CY"):
                continue
            period_end = str(row.get("end") or "")[:10]
            try:
                row_date = date.fromisoformat(period_end)
                value = float(row.get("val"))
            except (TypeError, ValueError):
                continue
            if metric.get("factType", "duration") == "duration":
                try:
                    period_start = date.fromisoformat(str(row.get("start") or "")[:10])
                except ValueError:
                    continue
                duration_days = (row_date - period_start).days
                if duration_days < 300 or duration_days > 430:
                    continue
            if not math.isfinite(value) or (start and row_date < start) or (end and row_date > end):
                continue
            candidate = {**row, "_concept": concept, "_conceptPriority": priority}
            existing = latest_by_period.get(period_end)
            if (
                not existing
                or priority < int(existing.get("_conceptPriority", 999))
                or (
                    priority == int(existing.get("_conceptPriority", 999))
                    and str(row.get("filed") or "") > str(existing.get("filed") or "")
                )
            ):
                latest_by_period[period_end] = candidate
    observations = [
        {
            "date": period,
            "value": float(row["val"]),
            "filed": row.get("filed"),
            "concept": row.get("_concept"),
        }
        for period, row in sorted(latest_by_period.items())
    ]
    if not observations:
        raise RuntimeError(f"SEC Company Facts returned no annual {metric['name']} observations for {ticker}.")
    company_name = str(payload.get("entityName") or company.get("title") or ticker)
    used_concepts = list(dict.fromkeys(str(row["concept"]) for row in observations))
    return {
        "id": entry["id"],
        "name": f"{company_name} {metric['name']}",
        "unit": entry["unit"],
        "origin": entry["origin"],
        "provider": "SEC Company Facts API",
        "providerSeries": f"CIK{cik}/us-gaap/" + "+".join(used_concepts),
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": url,
        "resolution": entry.get("resolution"),
        "providerWarnings": [
            "SEC facts are latest-filed/restated values, not a point-in-time vintage series.",
            "Structured XBRL coverage is generally shorter than older paper-filing history.",
        ],
        "preferredUnits": "raw",
    }


def _dfa_quarter_start(value: str) -> str:
    match = re.fullmatch(r"(\d{4}):Q([1-4])", value.strip())
    if not match:
        raise ValueError(f"Unexpected Federal Reserve DFA quarter: {value}")
    year = int(match.group(1))
    month = 1 + (int(match.group(2)) - 1) * 3
    return date(year, month, 1).isoformat()


def _filter_observations(
    observations: list[dict[str, Any]],
    start: date | None,
    end: date | None,
) -> list[dict[str, Any]]:
    start_text = start.isoformat() if start else None
    end_text = end.isoformat() if end else None
    return [
        row
        for row in observations
        if (not start_text or row["date"] >= start_text)
        and (not end_text or row["date"] <= end_text)
    ]


def _read_dfa_zip_series(
    entry: dict[str, Any],
    start: date | None,
    end: date | None,
) -> tuple[list[dict[str, Any]], Any]:
    download = http_get_bytes(
        FED_DFA_ZIP_URL,
        timeout=45,
        cache_ttl=12 * 60 * 60,
        allow_stale=True,
    )
    try:
        with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
            content = archive.read(str(entry["dfaFile"])).decode("utf-8-sig")
    except (KeyError, zipfile.BadZipFile, UnicodeDecodeError) as exc:
        raise RuntimeError(f"The official Federal Reserve DFA archive was not readable: {exc}") from exc
    categories = set(entry["dfaCategories"])
    terms = list(entry.get("dfaTerms") or [{"column": entry["dfaColumn"], "coefficient": 1.0}])
    values_by_date: dict[str, float] = {}
    totals_by_date: dict[str, float] = {}
    categories_by_date: dict[str, set[str]] = {}
    for row in csv.DictReader(io.StringIO(content)):
        category = str(row.get("Category") or "").strip()
        term_values: list[tuple[float, float]] = []
        for term in terms:
            raw_value = str(row.get(str(term["column"])) or "").strip()
            if not raw_value or raw_value == ".":
                term_values = []
                break
            term_values.append((float(term.get("coefficient", 1.0)), float(raw_value)))
        if not term_values:
            continue
        observation_date = _dfa_quarter_start(str(row.get("Date") or ""))
        value = sum(coefficient * raw_value for coefficient, raw_value in term_values)
        totals_by_date[observation_date] = totals_by_date.get(observation_date, 0.0) + value
        if category in categories:
            values_by_date[observation_date] = values_by_date.get(observation_date, 0.0) + value
            categories_by_date.setdefault(observation_date, set()).add(category)
    observations = [
        {
            "date": observation_date,
            "value": (
                100.0 * value / totals_by_date[observation_date]
                if entry.get("dfaMode") == "shares"
                else value
            ),
        }
        for observation_date, value in sorted(values_by_date.items())
        if categories_by_date.get(observation_date) == categories
        and totals_by_date.get(observation_date)
    ]
    return _filter_observations(observations, start, end), download


def _read_fred_dfa_fallback(
    entry: dict[str, Any],
    start: date | None,
    end: date | None,
) -> tuple[list[dict[str, Any]], list[str]]:
    numerator_ids = list(entry.get("fredFallbackComponents") or [])
    denominator_ids = list(entry.get("fredShareDenominator") or [])
    component_ids = list(dict.fromkeys([*numerator_ids, *denominator_ids]))
    if not numerator_ids:
        raise RuntimeError("No exact FRED DFA mirror is configured for this percentile group.")
    values_by_component: dict[str, dict[str, float]] = {}
    for series_id in component_ids:
        params: dict[str, Any] = {"id": series_id}
        if start:
            params["cosd"] = start.isoformat()
        if end:
            params["coed"] = end.isoformat()
        result = http_get(
            "https://fred.stlouisfed.org/graph/fredgraph.csv",
            params=params,
            cache_ttl=12 * 60 * 60,
            allow_stale=True,
        )
        values: dict[str, float] = {}
        for row in csv.DictReader(io.StringIO(result.text)):
            date_value = str(row.get("observation_date") or row.get("DATE") or "").strip()
            raw_value = str(row.get(series_id) or "").strip()
            if date_value and raw_value and raw_value != ".":
                values[date_value] = float(raw_value)
        if not values:
            raise RuntimeError(f"FRED returned no usable observations for {series_id}.")
        values_by_component[series_id] = values
    common_dates = set.intersection(*(set(values) for values in values_by_component.values()))
    observations = [
        {
            "date": observation_date,
            "value": (
                100.0
                * sum(values_by_component[series_id][observation_date] for series_id in numerator_ids)
                / sum(values_by_component[series_id][observation_date] for series_id in denominator_ids)
                if denominator_ids
                else sum(
                    values_by_component[series_id][observation_date]
                    for series_id in numerator_ids
                )
            ),
        }
        for observation_date in sorted(common_dates)
    ]
    return _filter_observations(observations, start, end), component_ids


def fetch_fed_dfa_series(
    entry: dict[str, Any],
    start: date | None,
    end: date | None,
) -> dict[str, Any]:
    direct_error = ""
    source_url = FED_DFA_ZIP_URL
    provider = "Federal Reserve Distributional Financial Accounts"
    provider_series = (
        f"{entry['dfaFile']} / {' + '.join(entry['dfaCategories'])} / "
        f"{entry.get('dfaMeasureFormula') or entry['dfaColumn']}"
    )
    try:
        observations, download = _read_dfa_zip_series(entry, start, end)
        if not observations:
            raise RuntimeError("The requested range contains no official DFA observations.")
        transport_warning = str(getattr(download, "warning", "") or "")
    except Exception as exc:  # noqa: BLE001 - exact FRED DFA mirrors are the declared backup.
        direct_error = str(exc)
        observations, component_ids = _read_fred_dfa_fallback(entry, start, end)
        if not observations:
            raise RuntimeError(
                f"Federal Reserve DFA and exact FRED mirrors returned no observations. DFA: {direct_error}"
            ) from exc
        provider = "FRED mirror of Federal Reserve Distributional Financial Accounts"
        provider_series = " + ".join(component_ids)
        source_url = f"https://fred.stlouisfed.org/series/{component_ids[0]}"
        transport_warning = ""
    categories = list(entry["dfaCategories"])
    numerator = " + ".join(categories)
    measure_formula = str(entry.get("dfaMeasureFormula") or entry["dfaColumn"])
    group_formula = numerator if len(categories) > 1 else f"Direct Federal Reserve group: {categories[0]}"
    if entry.get("dfaMode") == "shares":
        formula = (
            f"100 * ({numerator}) / all five DFA wealth groups"
            if measure_formula == "Net worth"
            else f"100 * ({numerator}; {measure_formula}) / all five DFA groups for the same measure"
        )
    else:
        formula = group_formula if measure_formula == "Net worth" else f"{group_formula}; measure = {measure_formula}"
    provider_notes = [
        "This is the aggregate requested balance-sheet measure held by the percentile group, not an average per household.",
        "Top 10% is calculated from the Fed's mutually exclusive Top 0.1%, Remaining Top 1%, and Next 9% groups."
        if entry.get("dfaGroupKey") == "top_10"
        else "The population group follows the Federal Reserve DFA definition.",
    ]
    warnings: list[str] = []
    if direct_error:
        warnings.append(
            "The official Federal Reserve ZIP was unavailable, so exact FRED mirrors of the same DFA release were used: "
            + direct_error
        )
    if transport_warning:
        warnings.append(transport_warning)
    fallback_sources = [
        {
            "name": "FRED DFA mirror",
            "url": f"https://fred.stlouisfed.org/series/{series_id}",
            "role": f"Exact fallback component {series_id}",
        }
        for series_id in entry.get("fredFallbackComponents") or []
    ]
    return {
        "id": entry["id"],
        "name": entry["name"],
        "unit": entry["unit"],
        "origin": entry["origin"],
        "provider": provider,
        "providerSeries": provider_series,
        "observations": observations,
        "firstDate": observations[0]["date"],
        "lastDate": observations[-1]["date"],
        "latest": observations[-1]["value"],
        "sourceUrl": source_url,
        "resolution": entry.get("resolution"),
        "formula": formula,
        "supportingSources": [
            {
                "name": "Federal Reserve DFA interactive tables",
                "url": FED_DFA_TABLE_URL,
                "role": "Definitions and interactive verification",
            },
            *fallback_sources,
        ],
        "providerWarnings": warnings,
        "providerNotes": provider_notes,
        "preferredUnits": "raw",
    }


def fetch_special_series(entry: dict[str, Any], start: date | None, end: date | None) -> dict[str, Any]:
    provider = entry.get("primary")
    if provider == "sp-earnings":
        return fetch_sp_earnings_series(entry, start, end)
    if provider == "world-bank":
        return fetch_world_bank_series(entry, start, end)
    if provider == "sec-companyfacts":
        return fetch_sec_companyfacts_series(entry, start, end)
    if provider == "fed-dfa":
        return fetch_fed_dfa_series(entry, start, end)
    raise RuntimeError(f"Unsupported special macro provider: {provider}")
