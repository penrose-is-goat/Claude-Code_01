"""Official U.S. Treasury auction ingestion, persistence, and query service."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import zlib
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from data_core import http_get
import intent_contract
import model_router


APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / ".cache" / "treasury-auctions.sqlite3"
FISCAL_API = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query"
TREASURY_API = "https://www.treasurydirect.gov/TA_WS/securities"
TREASURY_QUERY = "https://www.treasurydirect.gov/auctions/auction-query/"
SCHEMA_VERSION = 1
_SYNC_LOCK = threading.RLock()

METRICS: dict[str, dict[str, str]] = {
    "bidToCoverRatio": {"label": "Bid-to-cover ratio", "formula": "Official public tendered / public accepted; SOMA excluded"},
    "stopOutValue": {"label": "Instrument-specific auction stop-out", "formula": "Bill high discount rate; Note/Bond/TIPS high yield; FRN high discount margin"},
    "highYield": {"label": "High yield", "formula": "Official high yield"},
    "highDiscountRate": {"label": "High discount rate", "formula": "Official bill high discount rate"},
    "highInvestmentRate": {"label": "Investment rate", "formula": "Official bill coupon-equivalent investment rate"},
    "highDiscountMargin": {"label": "High discount margin", "formula": "Official FRN high discount margin"},
    "offeringAmount": {"label": "Offering amount", "formula": "Official public offering par amount"},
    "somaAccepted": {"label": "SOMA accepted", "formula": "Official SOMA amount accepted at auction"},
    "directBidderShare": {"label": "Direct bidder share", "formula": "Direct bidder accepted / competitive accepted"},
    "indirectBidderShare": {"label": "Indirect bidder share", "formula": "Indirect bidder accepted / competitive accepted"},
    "primaryDealerShare": {"label": "Primary dealer share", "formula": "Primary dealer accepted / competitive accepted"},
    "allocationPercentage": {"label": "Allocation at high", "formula": "Official allocation percentage at the stop-out"},
    "pricePer100": {"label": "Price per $100", "formula": "Official price per $100 par"},
}

METRIC_ALIASES = [
    (r"\bbid[ -]?(?:to[ -]?)?cover\b|\bdemand coverage\b|\bbtc\b", "bidToCoverRatio"),
    (r"\bhigh(?:est)? yield\b|\bstop[ -]?out yield\b", "highYield"),
    (r"\bhigh(?:est)? (?:discount )?rate\b|\bstop[ -]?out rate\b", "highDiscountRate"),
    (r"\binvestment rate\b", "highInvestmentRate"),
    (r"\bdiscount margin\b|\bhigh margin\b", "highDiscountMargin"),
    (r"\boffering (?:amount|size)\b|\bauction sizes?\b", "offeringAmount"),
    (r"\bsoma (?:accepted|purchases?|awards?)\b|\bsoma\b", "somaAccepted"),
    (r"\bindirect(?: bidder)? (?:shares?|demand|percentage|%)\b", "indirectBidderShare"),
    (r"\bdirect(?: bidder)? (?:shares?|demand|percentage|%)\b", "directBidderShare"),
    (r"\b(?:primary )?dealer (?:shares?|demand|percentage|%)\b", "primaryDealerShare"),
    (r"\ballocation (?:at )?high\b|\ballotment\b", "allocationPercentage"),
    (r"\bprice per (?:\$?100|hundred)\b|\bauction price\b", "pricePer100"),
]

MODEL_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "view": {"enum": ["chart", "table", "records", "latest"]},
        "metric": {"type": ["string", "null"]},
        # Panels are independent output surfaces. `view` remains for callers that
        # predate multi-panel requests, while `panels` is the canonical UI contract.
        "panels": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"enum": ["chart", "table", "documents"]}},
        "metrics": {"type": "array", "minItems": 0, "maxItems": 4, "items": {"enum": list(METRICS)}},
        "filters": {"type": "object"},
        "term": {"type": ["string", "null"]},
        "securityType": {"enum": ["Bill", "Note", "Bond", "TIPS", "FRN", "CMB", None]},
        "cusip": {"type": ["string", "null"]},
        "startDate": {"type": ["string", "null"]},
        "endDate": {"type": ["string", "null"]},
        "reopening": {"enum": ["all", "only", "exclude"]},
        "chartType": {"enum": ["line", "bar", "scatter"]},
    },
    "required": ["view", "metrics", "term", "securityType", "cusip", "startDate", "endDate", "reopening", "chartType"],
}

OUTPUT_PANELS = {"chart", "table", "documents"}


def _legacy_panels(view: Any) -> list[str]:
    """Translate the original one-view contract without changing old callers."""
    if view == "chart":
        return ["chart"]
    if view == "records":
        return ["documents"]
    if view == "latest":
        return ["table", "documents"]
    return ["table"]


def _primary_view(panels: list[str], *, latest: bool = False) -> str:
    """Retain a deterministic legacy view for the HTTP/UI clients that read it."""
    if latest:
        return "latest"
    if panels == ["documents"]:
        return "records"
    if panels == ["chart"]:
        return "chart"
    return "table"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _pick(row: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in row:
            return row[name]
    return None


def _missing(value: Any) -> bool:
    return value is None or str(value).strip().lower() in {"", "null", "none", "n/a"}


def _number(value: Any) -> float | None:
    if _missing(value):
        return None
    try:
        parsed = float(str(value).replace(",", ""))
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str | None:
    return None if _missing(value) else str(value).strip()


def _date_text(value: Any) -> str | None:
    text = _text(value)
    if not text:
        return None
    candidate = text[:10]
    try:
        date.fromisoformat(candidate)
        return candidate
    except ValueError:
        return None


def _yes(value: Any) -> bool:
    return str(value or "").strip().lower() in {"yes", "true", "1", "y"}


def _ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in {None, 0}:
        return None
    return round(numerator / denominator * 100, 6)


def document_url(filename: Any) -> str | None:
    name = _text(filename)
    if not name or not re.fullmatch(r"(?:A|R|NCR|S)_\d{8}_\d+\.pdf", name, re.IGNORECASE):
        return None
    year = name.split("_", 2)[1][:4]
    return f"https://www.treasurydirect.gov/instit/annceresult/press/preanre/{year}/{name}"


def xml_url(filename: Any) -> str | None:
    name = _text(filename)
    if not name or not re.fullmatch(r"(?:A|R|S)_\d{8}_\d+\.xml", name, re.IGNORECASE):
        return None
    return f"https://www.treasurydirect.gov/xml/{name}"


def normalize_auction(row: dict[str, Any], source: str = "Treasury") -> dict[str, Any]:
    cusip = _text(_pick(row, "cusip"))
    auction_date = _date_text(_pick(row, "auction_date", "auctionDate"))
    if not cusip or not auction_date:
        raise ValueError("Auction record is missing CUSIP or auction date.")

    tips = _yes(_pick(row, "inflation_index_security", "tips"))
    floating = _yes(_pick(row, "floating_rate", "floatingRate"))
    cmb = _yes(_pick(row, "cash_management_bill_cmb", "cashManagementBillCMB"))
    base_type = _text(_pick(row, "security_type", "securityType", "type")) or "Treasury"
    security_type = "TIPS" if tips else "FRN" if floating else "CMB" if cmb else base_type
    term = _text(_pick(row, "original_security_term", "originalSecurityTerm", "term")) or _text(
        _pick(row, "security_term", "securityTerm")
    )
    current_term = _text(_pick(row, "security_term", "securityTerm")) or term

    high_yield = _number(_pick(row, "high_yield", "highYield"))
    high_discount_rate = _number(_pick(row, "high_discnt_rate", "highDiscountRate"))
    high_investment_rate = _number(_pick(row, "high_investment_rate", "highInvestmentRate"))
    high_discount_margin = _number(_pick(row, "high_discnt_margin", "highDiscountMargin"))
    if security_type in {"Note", "Bond", "TIPS"}:
        stop_out_value, stop_out_label = high_yield, "High yield"
    elif security_type == "FRN":
        stop_out_value, stop_out_label = high_discount_margin, "High discount margin"
    else:
        stop_out_value, stop_out_label = high_discount_rate, "High discount rate"

    competitive_accepted = _number(_pick(row, "comp_accepted", "competitiveAccepted"))
    direct_accepted = _number(_pick(row, "direct_bidder_accepted", "directBidderAccepted"))
    indirect_accepted = _number(_pick(row, "indirect_bidder_accepted", "indirectBidderAccepted"))
    dealer_accepted = _number(_pick(row, "primary_dealer_accepted", "primaryDealerAccepted"))
    result_filename = _pick(row, "pdf_filenm_comp_results", "pdfFilenameCompetitiveResults")
    announcement_filename = _pick(row, "pdf_filenm_announcemt", "pdfFilenameAnnouncement")
    result_xml = _pick(row, "xml_filenm_comp_results", "xmlFilenameCompetitiveResults")
    announcement_xml = _pick(row, "xml_filenm_announcemt", "xmlFilenameAnnouncement")

    payload = {
        "auctionKey": f"{cusip}|{auction_date}",
        "cusip": cusip,
        "auctionDate": auction_date,
        "announcementDate": _date_text(_pick(row, "announcemt_date", "announcementDate")),
        "issueDate": _date_text(_pick(row, "issue_date", "issueDate")),
        "maturityDate": _date_text(_pick(row, "maturity_date", "maturityDate")),
        "type": security_type,
        "securityType": base_type,
        "term": term,
        "securityTerm": current_term,
        "originalSecurityTerm": term,
        "series": _text(_pick(row, "series")),
        "reopening": _yes(_pick(row, "reopening")),
        "tips": tips,
        "floatingRate": floating,
        "cashManagementBill": cmb,
        "closingTimeCompetitive": _text(_pick(row, "closing_time_comp", "closingTimeCompetitive")),
        "closingTimeNoncompetitive": _text(_pick(row, "closing_time_noncomp", "closingTimeNoncompetitive")),
        "offeringAmount": _number(_pick(row, "offering_amt", "offeringAmount")),
        "bidToCoverRatio": _number(_pick(row, "bid_to_cover_ratio", "bidToCoverRatio")),
        "allocationPercentage": _number(_pick(row, "allocation_pctage", "allocationPercentage")),
        "highYield": high_yield,
        "highDiscountRate": high_discount_rate,
        "highInvestmentRate": high_investment_rate,
        "highDiscountMargin": high_discount_margin,
        "stopOutValue": stop_out_value,
        "stopOutLabel": stop_out_label,
        "interestRate": _number(_pick(row, "int_rate", "interestRate")),
        "pricePer100": _number(_pick(row, "price_per100", "pricePer100")),
        "competitiveTendered": _number(_pick(row, "comp_tendered", "competitiveTendered")),
        "competitiveAccepted": competitive_accepted,
        "totalTendered": _number(_pick(row, "total_tendered", "totalTendered")),
        "totalAccepted": _number(_pick(row, "total_accepted", "totalAccepted")),
        "directBidderTendered": _number(_pick(row, "direct_bidder_tendered", "directBidderTendered")),
        "directBidderAccepted": direct_accepted,
        "directBidderShare": _ratio(direct_accepted, competitive_accepted),
        "indirectBidderTendered": _number(_pick(row, "indirect_bidder_tendered", "indirectBidderTendered")),
        "indirectBidderAccepted": indirect_accepted,
        "indirectBidderShare": _ratio(indirect_accepted, competitive_accepted),
        "primaryDealerTendered": _number(_pick(row, "primary_dealer_tendered", "primaryDealerTendered")),
        "primaryDealerAccepted": dealer_accepted,
        "primaryDealerShare": _ratio(dealer_accepted, competitive_accepted),
        "somaTendered": _number(_pick(row, "soma_tendered", "somaTendered")),
        "somaAccepted": _number(_pick(row, "soma_accepted", "somaAccepted")),
        "somaHoldings": _number(_pick(row, "soma_holdings", "somaHoldings")),
        "fimaAccepted": _number(_pick(row, "fima_noncomp_accepted", "fimaNoncompetitiveAccepted")),
        "treasuryRetailAccepted": _number(_pick(row, "treas_retail_accepted", "treasuryRetailAccepted")),
        "announcementPdfUrl": document_url(announcement_filename),
        "resultPdfUrl": document_url(result_filename),
        "announcementXmlUrl": xml_url(announcement_xml),
        "resultXmlUrl": xml_url(result_xml),
        "apiRecordUrl": f"{TREASURY_QUERY}?cusip={cusip}",
        "updatedTimestamp": _text(_pick(row, "updated_timestamp", "updatedTimestamp", "record_date")),
        "source": source,
    }
    payload["completed"] = payload["bidToCoverRatio"] is not None or payload["stopOutValue"] is not None
    return payload


def _connect(db_path: Path | str = DB_PATH) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS auctions (
          auction_key TEXT PRIMARY KEY,
          cusip TEXT NOT NULL,
          auction_date TEXT NOT NULL,
          security_type TEXT NOT NULL,
          term TEXT,
          reopening INTEGER NOT NULL,
          completed INTEGER NOT NULL,
          bid_to_cover REAL,
          updated_timestamp TEXT,
          payload_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          raw_payload BLOB NOT NULL,
          source TEXT NOT NULL,
          ingested_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auctions_date ON auctions(auction_date DESC);
        CREATE INDEX IF NOT EXISTS idx_auctions_term ON auctions(term, auction_date DESC);
        CREATE INDEX IF NOT EXISTS idx_auctions_type ON auctions(security_type, auction_date DESC);
        CREATE INDEX IF NOT EXISTS idx_auctions_latest ON auctions(completed, auction_date DESC, updated_timestamp DESC, cusip);
        CREATE TABLE IF NOT EXISTS auction_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          auction_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          replaced_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auction_revisions_key ON auction_revisions(auction_key);
        CREATE TABLE IF NOT EXISTS raw_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_url TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          raw_payload BLOB NOT NULL,
          retrieved_at TEXT NOT NULL,
          UNIQUE(source_url, payload_hash)
        );
        CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )
    connection.execute(
        "INSERT INTO sync_state(key,value) VALUES('schemaVersion',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )
    connection.commit()
    return connection


@contextmanager
def _db(db_path: Path | str = DB_PATH):
    connection = _connect(db_path)
    try:
        yield connection
    finally:
        connection.close()


def _state_get(connection: sqlite3.Connection, key: str) -> str | None:
    row = connection.execute("SELECT value FROM sync_state WHERE key=?", (key,)).fetchone()
    return str(row["value"]) if row else None


def _state_set(connection: sqlite3.Connection, key: str, value: Any) -> None:
    connection.execute(
        "INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def _snapshot(connection: sqlite3.Connection, source_url: str, raw_text: str) -> None:
    digest = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
    connection.execute(
        "INSERT OR IGNORE INTO raw_snapshots(source_url,payload_hash,raw_payload,retrieved_at) VALUES(?,?,?,?)",
        (source_url, digest, zlib.compress(raw_text.encode("utf-8"), 9), _utc_now()),
    )


def _source_priority(source: str) -> int:
    lowered = source.lower()
    if "auctioned" in lowered:
        return 40
    if "upcoming" in lowered:
        return 30
    if "announced" in lowered:
        return 20
    if "treasurydirect" in lowered:
        return 15
    return 10


def _merge_normalized(existing: dict[str, Any], incoming: dict[str, Any], incoming_source: str) -> dict[str, Any]:
    existing_source = str(existing.get("source") or "")
    incoming_priority = _source_priority(incoming_source)
    existing_priority = _source_priority(existing_source)
    merged = dict(existing)
    for key, value in incoming.items():
        if key == "source" or value is None:
            continue
        if merged.get(key) is None or incoming_priority >= existing_priority:
            merged[key] = value

    # Result fields determine completion even when they arrived from a lower-priority
    # historical feed after an announcement had already been stored.
    merged["completed"] = merged.get("bidToCoverRatio") is not None or merged.get("stopOutValue") is not None
    merged["source"] = incoming_source if incoming_priority >= existing_priority else existing_source
    return merged


def upsert_records(
    records: Iterable[dict[str, Any]],
    *,
    source: str,
    connection: sqlite3.Connection,
    track_revisions: bool = True,
) -> dict[str, int]:
    inserted = updated = unchanged = rejected = 0
    now = _utc_now()
    for raw in records:
        try:
            normalized = normalize_auction(raw, source)
        except (TypeError, ValueError):
            rejected += 1
            continue
        raw_json = json.dumps(raw, separators=(",", ":"), sort_keys=True)
        existing = connection.execute(
            "SELECT payload_hash,payload_json,source FROM auctions WHERE auction_key=?", (normalized["auctionKey"],)
        ).fetchone()
        if existing:
            normalized = _merge_normalized(json.loads(existing["payload_json"]), normalized, source)
        normalized_json = json.dumps(normalized, separators=(",", ":"), sort_keys=True)
        comparable = dict(normalized)
        comparable.pop("source", None)
        digest = hashlib.sha256(
            json.dumps(comparable, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).hexdigest()
        if existing and existing["payload_hash"] == digest:
            unchanged += 1
            continue
        if existing and track_revisions:
            connection.execute(
                "INSERT INTO auction_revisions(auction_key,payload_hash,payload_json,replaced_at) VALUES(?,?,?,?)",
                (normalized["auctionKey"], existing["payload_hash"], existing["payload_json"], now),
            )
        if existing:
            updated += 1
        else:
            inserted += 1
        connection.execute(
            """
            INSERT INTO auctions(auction_key,cusip,auction_date,security_type,term,reopening,completed,bid_to_cover,
              updated_timestamp,payload_hash,payload_json,raw_payload,source,ingested_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(auction_key) DO UPDATE SET
              cusip=excluded.cusip,auction_date=excluded.auction_date,security_type=excluded.security_type,
              term=excluded.term,reopening=excluded.reopening,completed=excluded.completed,
              bid_to_cover=excluded.bid_to_cover,updated_timestamp=excluded.updated_timestamp,
              payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,raw_payload=excluded.raw_payload,
              source=excluded.source,ingested_at=excluded.ingested_at
            """,
            (
                normalized["auctionKey"], normalized["cusip"], normalized["auctionDate"], normalized["type"],
                normalized["term"], int(normalized["reopening"]), int(normalized["completed"]),
                normalized["bidToCoverRatio"], normalized["updatedTimestamp"], digest, normalized_json,
                zlib.compress(raw_json.encode("utf-8"), 9), normalized["source"], now,
            ),
        )
    return {"inserted": inserted, "updated": updated, "unchanged": unchanged, "rejected": rejected}


def _download_json(url: str, params: dict[str, Any], *, timeout: int = 90, cache_ttl: int = 900) -> tuple[Any, str, str]:
    response = http_get(url, params=params, timeout=timeout, cache_ttl=cache_ttl, allow_stale=True)
    return json.loads(response.text), response.text, response.url


def _fiscal_pages(start_date: str | None = None) -> Iterable[tuple[list[dict[str, Any]], str, str]]:
    page = 1
    while True:
        params: dict[str, Any] = {"sort": "-auction_date", "page[number]": page, "page[size]": 5000}
        if start_date:
            params["filter"] = f"auction_date:gte:{start_date}"
        payload, raw_text, url = _download_json(FISCAL_API, params, timeout=120, cache_ttl=60 * 60)
        rows = payload.get("data") or []
        if not isinstance(rows, list):
            raise RuntimeError("Fiscal Data returned an invalid auction payload.")
        yield rows, raw_text, url
        meta = payload.get("meta") or {}
        total_pages = int(meta.get("total-pages") or meta.get("total_pages") or 1)
        if page >= total_pages:
            break
        page += 1


def _current_feed(name: str, params: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], str, str]:
    payload, raw_text, url = _download_json(
        f"{TREASURY_API}/{name}", {"format": "json", **(params or {})}, timeout=45, cache_ttl=5 * 60
    )
    if not isinstance(payload, list):
        raise RuntimeError(f"TreasuryDirect {name} returned an invalid payload.")
    return payload, raw_text, url


def database_status(db_path: Path | str = DB_PATH) -> dict[str, Any]:
    with _db(db_path) as connection:
        row = connection.execute(
            "SELECT COUNT(*) count,MIN(auction_date) first_date,MAX(auction_date) last_date FROM auctions"
        ).fetchone()
        revisions = connection.execute("SELECT COUNT(*) count FROM auction_revisions").fetchone()["count"]
        last_success = _state_get(connection, "lastSuccessfulSync")
        return {
            "schemaVersion": SCHEMA_VERSION,
            "rowCount": int(row["count"]),
            "firstAuctionDate": row["first_date"],
            "lastAuctionDate": row["last_date"],
            "lastSuccessfulSync": last_success,
            "lastAttempt": _state_get(connection, "lastAttempt"),
            "lastError": _state_get(connection, "lastError"),
            "revisionCount": int(revisions),
            "stale": bool(last_success and datetime.fromisoformat(last_success.replace("Z", "+00:00")) < datetime.now(timezone.utc) - timedelta(days=2)),
        }


def sync_auctions(force: bool = False, db_path: Path | str = DB_PATH) -> dict[str, Any]:
    with _SYNC_LOCK, _db(db_path) as connection:
        current_count = int(connection.execute("SELECT COUNT(*) FROM auctions").fetchone()[0])
        last_success = _state_get(connection, "lastSuccessfulSync")
        last_attempt = _state_get(connection, "lastAttempt")
        if not force and current_count and last_attempt:
            attempt_age = datetime.now(timezone.utc) - datetime.fromisoformat(last_attempt.replace("Z", "+00:00"))
            if attempt_age < timedelta(minutes=5):
                return {**database_status(db_path), "skipped": True, "backoff": True}
        if not force and current_count and last_success:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(last_success.replace("Z", "+00:00"))
            if age < timedelta(minutes=30):
                return {**database_status(db_path), "skipped": True}
        _state_set(connection, "lastAttempt", _utc_now())
        connection.commit()
        totals = {"inserted": 0, "updated": 0, "unchanged": 0, "rejected": 0}
        try:
            start_date = None if current_count == 0 else (date.today() - timedelta(days=730)).isoformat()
            for rows, raw_text, url in _fiscal_pages(start_date):
                _snapshot(connection, url, raw_text)
                result = upsert_records(
                    rows,
                    source="Fiscal Data Treasury Securities Auctions",
                    connection=connection,
                    track_revisions=current_count > 0,
                )
                for key in totals:
                    totals[key] += result[key]
                connection.commit()
            for feed, params in (("announced", None), ("upcoming", None), ("auctioned", {"day": 30})):
                try:
                    rows, raw_text, url = _current_feed(feed, params)
                    _snapshot(connection, url, raw_text)
                    result = upsert_records(
                        rows,
                        source=f"TreasuryDirect {feed}",
                        connection=connection,
                        track_revisions=current_count > 0,
                    )
                    for key in totals:
                        totals[key] += result[key]
                    connection.commit()
                except Exception as exc:  # Current-feed failure must not destroy the verified deep database.
                    _state_set(connection, f"{feed}Error", str(exc)[:800])
            success = _utc_now()
            _state_set(connection, "lastSuccessfulSync", success)
            _state_set(connection, "lastError", "")
            connection.commit()
            return {**database_status(db_path), **totals, "skipped": False}
        except Exception as exc:
            connection.rollback()
            _state_set(connection, "lastError", str(exc)[:1200])
            connection.commit()
            if current_count == 0:
                raise RuntimeError(f"Treasury auction database could not be initialized: {exc}") from exc
            return {**database_status(db_path), **totals, "syncError": str(exc), "stale": True}


def _load_rows(connection: sqlite3.Connection, sql: str, params: list[Any]) -> list[dict[str, Any]]:
    return [json.loads(row["payload_json"]) for row in connection.execute(sql, params).fetchall()]


def _source_manifest() -> list[dict[str, str]]:
    return [
        {"name": "Fiscal Data Treasury Securities Auctions", "url": "https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/", "role": "Primary structured historical database"},
        {"name": "TreasuryDirect Securities API", "url": f"{TREASURY_API}/search?format=json", "role": "Current announcements and result verification"},
        {"name": "Treasury Auction Query", "url": TREASURY_QUERY, "role": "Official query interface and downloads"},
        {"name": "Treasury auction press releases", "url": "https://www.treasurydirect.gov/auctions/announcements-data-results/announcement-results-press-releases/treasury-marketable/", "role": "Official announcement and result documents"},
        {"name": "Uniform Offering Circular", "url": "https://www.treasurydirect.gov/files/laws-and-regulations/auction-regulations-uoc/31-cfr-part-356.pdf", "role": "Definitions and auction methodology"},
    ]


def dashboard_payload(force: bool = False, limit: int = 100, db_path: Path | str = DB_PATH) -> dict[str, Any]:
    sync = sync_auctions(force=force, db_path=db_path)
    limit = max(20, min(int(limit), 500))
    today = date.today().isoformat()
    with _db(db_path) as connection:
        latest = _load_rows(
            connection,
            "SELECT payload_json FROM auctions WHERE completed=1 ORDER BY auction_date DESC,COALESCE(updated_timestamp,'') DESC,cusip ASC LIMIT ?",
            [limit],
        )
        upcoming = _load_rows(
            connection,
            "SELECT payload_json FROM auctions WHERE auction_date>=? AND completed=0 ORDER BY auction_date ASC,cusip ASC LIMIT 40",
            [today],
        )
    return {
        "generatedAt": _utc_now(),
        "database": database_status(db_path),
        "sync": sync,
        "latest": latest,
        "latestResult": latest[0] if latest else None,
        "upcoming": upcoming,
        "sources": _source_manifest(),
        "coverageNotes": [
            "The structured auction database begins in late 1979.",
            "Bid-to-cover begins later than the base history; modern bidder and SOMA detail generally begins in April 2008.",
            "Missing source values remain null and are never converted to zero.",
        ],
    }


def _canonical_term(number: int, unit: str) -> str:
    unit = unit.lower()
    label = "Year" if unit.startswith("y") else "Week" if unit.startswith("w") else "Month" if unit.startswith("m") else "Day"
    return f"{number}-{label}"


def _normalize_model_term(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    match = re.fullmatch(
        r"(\d{1,3})\s*[- ]?\s*(d|day|days|w|wk|week|weeks|m|mo|month|months|y|yr|year|years)",
        text,
        re.IGNORECASE,
    )
    if not match:
        raise ValueError("Unsupported original security term.")
    return _canonical_term(int(match.group(1)), match.group(2))


def _subtract_years(value: date, years: int) -> date:
    try:
        return value.replace(year=value.year - years)
    except ValueError:
        return value.replace(year=value.year - years, month=2, day=28)


def _subtract_months(value: date, months: int) -> date:
    total = value.year * 12 + value.month - 1 - months
    year, month_index = divmod(total, 12)
    month = month_index + 1
    month_lengths = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return date(year, month, min(value.day, month_lengths[month - 1]))


def parse_query(prompt: str, as_of: date | None = None) -> tuple[dict[str, Any], list[str], bool]:
    if not prompt.strip():
        raise ValueError("Enter an auction query.")
    as_of = as_of or date.today()
    text, _typo_corrections = intent_contract.normalize_known_typos(prompt)
    text = text.lower()
    number_words = {
        "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
        "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
        "thirteen": "13", "fifteen": "15", "seventeen": "17", "eighteen": "18",
        "twenty": "20", "thirty": "30", "fifty-two": "52", "ninety": "90",
    }
    for word, value in number_words.items():
        text = re.sub(rf"\b{re.escape(word)}(?=\s*[- ]?\s*(?:day|week|month|year))", value, text)

    if re.search(
        r"\b(?:forecast|predict|calculate|compute|average|median|mean|sum|download|export|"
        r"email|delete|remove|update|overwrite|insert)\b|\bsql\b|<\s*/?\s*script\b",
        text,
    ):
        raise ValueError(
            "That request asks for an unsupported forecast, aggregation, export, or data mutation. The auction query box only filters verified records and visualizations."
        )
    if re.search(r"\b(?:coupon rate|total accepted|accepted amount|tender size)\b", text):
        raise ValueError("That auction metric is not yet an allowlisted database field; no bid-to-cover substitute was used.")
    if re.search(r"\boriginal issues?\b", text) and re.search(r"\breopenings?\b", text) and re.search(r"\b(?:compare|versus|vs\.?)\b", text):
        raise ValueError("A side-by-side original-issue versus reopening comparison is not supported by this single-filter query.")
    recognized = False
    latest_intent = bool(re.search(r"\blatest\b|\bmost recent\b", text))
    chart_intent = bool(re.search(r"\bchart\b|\bgraph\b|\bplot\b|\btrend\b|\bhistory\b|\bhow has\b.*\bchanged\b", text))
    table_intent = bool(re.search(r"\btable\b|\btabular\b|\brows?\b|\blist\b", text))
    document_intent = bool(
        re.search(
            r"\bauction results?\b|\bresults?\b|\bresults? (?:copy|copies|release|releases|pdfs?|documents?)\b|"
            r"\b(?:copy|copies|pdfs?|documents?) (?:of|for)\b|\bofficial results?\b",
            text,
        )
    )
    panels: list[str] = []
    if chart_intent:
        panels.append("chart")
    if table_intent:
        panels.append("table")
    if document_intent:
        panels.append("documents")
    # A latest result is inherently inspectable as a record and may have official
    # files. Preserve that useful legacy behavior without assigning a metric.
    if latest_intent:
        if not panels:
            panels.extend(["table", "documents"])
        elif "documents" in panels and "table" not in panels:
            panels.insert(panels.index("documents"), "table")
    if not panels:
        panels.append("table")
    panels = list(dict.fromkeys(panels))
    view = _primary_view(panels, latest=latest_intent)
    recognized = recognized or bool(
        re.search(
            r"\blatest\b|\bmost recent\b|\bchart\b|\bplot\b|\btable\b|\bshow\b|\bcompare\b|"
            r"\bgive\b|\bfind\b|\bget\b|\bauction results?\b|\bpdfs?\b|\bdocuments?\b|\bcopies?\b",
            text,
        )
    )

    metrics: list[str] = []
    if re.search(r"\bdirect\s+and\s+indirect(?:\s+bidder)?\s+(?:shares?|demand|percentage|%)\b", text):
        metrics.extend(["directBidderShare", "indirectBidderShare"])
        recognized = True
    for pattern, metric in METRIC_ALIASES:
        if re.search(pattern, text) and metric not in metrics:
            metrics.append(metric)
            recognized = True
    if not metrics and "chart" in panels:
        # A numeric field is required to draw a chart. Keep the historic default
        # only for chart requests, never for a table or official-document request.
        if re.search(r"\bauction yields?\b|\byield history\b|\b(?:year|note|bond|tips) yields?\b", text):
            metrics = ["highYield"]
        else:
            metrics = ["bidToCoverRatio"]

    term = None
    term_text = re.sub(
        r"\b(?:last|past|previous)\s+\d{1,4}\s+(?:days?|weeks?|months?|years?)\b|"
        r"\b(?:for|over|across)\s+(?:the\s+)?\d{1,4}\s+(?:days|weeks|months|years)\b",
        " ",
        text,
    )
    supported_term_pattern = re.compile(
        r"\b(4|6|8|13|17|26|52)[ -]?(week|wk)s?\b|"
        r"\b(1|2|3|4|6|12)[ -]?months?\b|"
        r"\b(2|3|5|7|10|20|30)[ -]?(year|yr)s?\b"
    )
    term_matches = list(supported_term_pattern.finditer(term_text))
    canonical_terms: list[str] = []
    for term_match in term_matches:
        if term_match.group(1):
            canonical_terms.append(_canonical_term(int(term_match.group(1)), term_match.group(2)))
        elif term_match.group(3):
            canonical_terms.append(_canonical_term(int(term_match.group(3)), "month"))
        else:
            canonical_terms.append(_canonical_term(int(term_match.group(4)), term_match.group(5)))
    canonical_terms = list(dict.fromkeys(canonical_terms))
    if re.search(r"\blong[- ]bond\b", term_text):
        canonical_terms.append("30-Year")
        canonical_terms = list(dict.fromkeys(canonical_terms))
    unsupported_terms = [
        match.group(0)
        for match in re.finditer(r"\b\d{1,3}[ -]?(?:day|week|wk|month|year|yr)s?\b", term_text)
        if not supported_term_pattern.fullmatch(match.group(0))
    ]
    if unsupported_terms:
        raise ValueError(f"Unsupported Treasury original tenor: {unsupported_terms[0]}.")
    if len(canonical_terms) > 1:
        raise ValueError("This query names multiple original tenors. Run one tenor at a time so the result is unambiguous.")
    if canonical_terms:
        term = canonical_terms[0]
        recognized = True

    security_type = None
    if re.search(r"\btips\b|inflation[ -]protected", text):
        security_type = "TIPS"
    elif re.search(r"\bfrns?\b|floating[ -]rate", text):
        security_type = "FRN"
    elif re.search(r"\bcmbs?\b|cash management", text):
        security_type = "CMB"
    elif re.search(r"\bbills?\b", text):
        security_type = "Bill"
    elif re.search(r"\bnotes?\b", text):
        security_type = "Note"
    elif re.search(r"\bbonds?\b|\blong[- ]bond\b", text):
        security_type = "Bond"
    mentioned_types = [
        label
        for pattern, label in (
            (r"\btips\b|inflation[ -]protected", "TIPS"),
            (r"\bfrns?\b|floating[ -]rate", "FRN"),
            (r"\bcmbs?\b|cash management", "CMB"),
            (r"\bbills?\b", "Bill"),
            (r"\bnotes?\b", "Note"),
            (r"\bbonds?\b|\blong[- ]bond\b", "Bond"),
        )
        if re.search(pattern, text)
    ]
    mentioned_types = list(dict.fromkeys(mentioned_types))
    if len(mentioned_types) > 1:
        raise ValueError("This query names multiple security types. Choose one type per request.")
    if security_type:
        recognized = True

    compatible_terms = {
        "Bill": {"1-Month", "2-Month", "3-Month", "4-Month", "6-Month", "12-Month", "4-Week", "6-Week", "8-Week", "13-Week", "17-Week", "26-Week", "52-Week"},
        "Note": {"2-Year", "3-Year", "5-Year", "7-Year", "10-Year"},
        "Bond": {"20-Year", "30-Year"},
        "TIPS": {"5-Year", "10-Year", "30-Year"},
        "FRN": {"2-Year"},
    }
    if term and security_type in compatible_terms and term not in compatible_terms[security_type]:
        raise ValueError(f"{term} is not a supported original tenor for {security_type} auctions.")

    cusip = None
    cusip_match = re.search(r"\bcusip(?:\s+is|\s*=|:)?\s+([0-9a-z]{9})\b", text, re.IGNORECASE)
    if cusip_match:
        cusip = cusip_match.group(1).upper()
        recognized = True

    start_date = None
    end_date = as_of.isoformat()
    years = re.search(r"\b(?:last|past|previous)\s+(\d{1,3})\s+years?\b|\b(?:for|over|across)\s+(?:the\s+)?(\d{1,3})\s+years\b", text)
    previous_decade = bool(re.search(r"\b(?:last|past|previous|prior)\s+(?:one\s+)?decade\b", text))
    months = re.search(r"\b(?:last|past|previous)\s+(\d{1,3})\s+months?\b|\b(?:for|over)\s+(?:the\s+)?(\d{1,3})\s+months\b", text)
    days = re.search(r"\b(?:last|past|previous)\s+(\d{1,4})\s+days?\b|\b(?:for|over)\s+(?:the\s+)?(\d{1,4})\s+days\b", text)
    since = re.search(r"\bsince\s+(\d{4}-\d{2}-\d{2}|\d{4})\b", text)
    between = re.search(r"\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b", text)
    exact_date = re.search(r"\b(?:on\s+|auction date(?:\s+is|:)?\s*)(\d{4}-\d{2}-\d{2})\b", text)
    month_names = {name: index for index, name in enumerate(("january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"), start=1)}
    calendar_month = re.search(r"\b(?:in|from|during|for)?\s*(" + "|".join(month_names) + r")\s+((?:19|20)\d{2})\b", text)
    year_mentions = re.findall(r"\b(?:19|20)\d{2}\b", text)
    if len(set(year_mentions)) > 1 and not between:
        raise ValueError("This query names multiple calendar years. Use one year or an explicit date range.")
    calendar_year = re.search(r"\b(?:in|from|during|for)(?:\s+calendar\s+year)?\s+((?:19|20)\d{2})\b", text)
    if not calendar_year and len(set(year_mentions)) == 1 and re.search(r"\bauctions?\b", text):
        calendar_year = re.search(r"\b((?:19|20)\d{2})\b", text)
    if between:
        start_date, end_date = between.group(1), between.group(2)
    elif exact_date:
        start_date = end_date = exact_date.group(1)
    elif calendar_month:
        requested_year = int(calendar_month.group(2)); requested_month = month_names[calendar_month.group(1)]
        month_start = date(requested_year, requested_month, 1)
        next_month = date(requested_year + (1 if requested_month == 12 else 0), 1 if requested_month == 12 else requested_month + 1, 1)
        start_date, end_date = month_start.isoformat(), (next_month - timedelta(days=1)).isoformat()
    elif calendar_year:
        requested_year = int(calendar_year.group(1))
        if requested_year < 1979:
            raise ValueError("The structured Treasury auction database begins in 1979.")
        start_date, end_date = f"{requested_year}-01-01", f"{requested_year}-12-31"
    elif years:
        start_date = _subtract_years(as_of, int(years.group(1) or years.group(2))).isoformat()
    elif previous_decade:
        start_date = _subtract_years(as_of, 10).isoformat()
    elif months:
        start_date = _subtract_months(as_of, int(months.group(1) or months.group(2))).isoformat()
    elif days:
        start_date = (as_of - timedelta(days=int(days.group(1) or days.group(2)))).isoformat()
    elif since:
        start_date = since.group(1) if len(since.group(1)) == 10 else f"{since.group(1)}-01-01"
    elif "chart" in panels:
        start_date = _subtract_years(as_of, 10).isoformat()

    exclude_reopenings = bool(re.search(r"\bexclude reopenings?\b|\bnew\b[^.]{0,40}\bissues? only\b", text))
    only_reopenings = bool(
        re.search(r"\breopenings? only\b|\bonly\b[^.]{0,30}\breopenings?\b", text)
        or (
            re.search(r"\breopenings?\b|\breopened\b", text)
            and not re.search(r"\b(?:include|including|with)\s+reopenings?\b", text)
        )
    )
    if exclude_reopenings and only_reopenings:
        raise ValueError("The reopening filters conflict. Choose reopenings only or exclude reopenings.")
    reopening = "exclude" if exclude_reopenings else "only" if only_reopenings else "all"
    chart_types = [value for pattern, value in ((r"\bbar\b", "bar"), (r"\bscatter\b", "scatter"), (r"\bline chart\b", "line")) if re.search(pattern, text)]
    if len(set(chart_types)) > 1:
        raise ValueError("The request names more than one chart type.")
    chart_type = chart_types[0] if chart_types else "line"
    if start_date and end_date and start_date > end_date:
        raise ValueError("The requested start date must not be after the end date.")
    warnings: list[str] = []
    if "soma purchase" in text:
        warnings.append("'SOMA purchases' was normalized to the official SOMA accepted-at-auction field.")
    if not recognized:
        warnings.append("The deterministic parser could not identify an auction view, metric, tenor, or security type.")
    return (
        {
            "view": view,
            "panels": panels,
            "metrics": metrics,
            "metric": metrics[0] if metrics else None,
            "term": term,
            "securityType": security_type,
            "cusip": cusip,
            "startDate": start_date,
            "endDate": end_date,
            "reopening": reopening,
            "chartType": chart_type,
            "filters": {
                "term": term,
                "securityType": security_type,
                "cusip": cusip,
                "startDate": start_date,
                "endDate": end_date,
                "reopening": reopening,
            },
        },
        warnings,
        recognized,
    )


def validate_query_spec(spec: dict[str, Any]) -> dict[str, Any]:
    allowed = set(MODEL_SCHEMA["properties"])
    if set(spec) - allowed:
        raise ValueError("The query specification contains unsupported fields.")
    view = spec.get("view")
    panels = spec.get("panels")
    if panels is None:
        panels = _legacy_panels(view)
    if not isinstance(panels, list) or not panels or len(panels) > len(OUTPUT_PANELS) or any(panel not in OUTPUT_PANELS for panel in panels):
        raise ValueError("Unsupported auction output panel.")
    if len(set(panels)) != len(panels):
        raise ValueError("Auction output panels must not be repeated.")
    metrics = spec.get("metrics")
    security_type = spec.get("securityType")
    reopening = spec.get("reopening")
    chart_type = spec.get("chartType")
    if view not in {"chart", "table", "records", "latest"}:
        raise ValueError("Unsupported auction view.")
    if not isinstance(metrics, list) or len(metrics) > 4 or any(metric not in METRICS for metric in metrics):
        raise ValueError("Unsupported auction metric.")
    if "chart" in panels and not metrics:
        raise ValueError("A chart request requires an allowlisted auction metric.")
    if len(set(metrics)) != len(metrics):
        raise ValueError("Auction metrics must not be repeated.")
    legacy_metric = spec.get("metric")
    if legacy_metric is not None and legacy_metric not in metrics:
        raise ValueError("The legacy auction metric must be one of the requested metrics.")
    if security_type not in {None, "Bill", "Note", "Bond", "TIPS", "FRN", "CMB"}:
        raise ValueError("Unsupported security type.")
    cusip = spec.get("cusip")
    if cusip is not None and not re.fullmatch(r"[0-9A-Z]{9}", str(cusip)):
        raise ValueError("Unsupported CUSIP.")
    if reopening not in {"all", "only", "exclude"}:
        raise ValueError("Unsupported reopening filter.")
    if chart_type not in {"line", "bar", "scatter"}:
        raise ValueError("Unsupported chart type.")
    term = spec.get("term")
    if term is not None and not re.fullmatch(r"\d{1,3}-(?:Day|Week|Month|Year)", str(term)):
        raise ValueError("Unsupported original security term.")
    normalized = dict(spec)
    normalized["panels"] = panels
    normalized["metric"] = metrics[0] if metrics else None
    for key in ("startDate", "endDate"):
        if normalized.get(key):
            normalized[key] = date.fromisoformat(str(normalized[key])).isoformat()
    # Keep the UI contract explicit: predicates are separate from the output
    # panels and are copied only from validated top-level compatibility fields.
    supplied_filters = normalized.get("filters")
    if supplied_filters is not None and not isinstance(supplied_filters, dict):
        raise ValueError("Unsupported auction filters.")
    normalized["filters"] = {
        "term": normalized.get("term"),
        "securityType": normalized.get("securityType"),
        "cusip": normalized.get("cusip"),
        "startDate": normalized.get("startDate"),
        "endDate": normalized.get("endDate"),
        "reopening": normalized.get("reopening"),
    }
    return normalized


def _ollama_spec(prompt: str, deterministic: dict[str, Any]) -> tuple[dict[str, Any], str]:
    try:
        parsed, model = model_router.generate_json(
            system=(
                "Translate the request into the supplied Treasury auction query schema. Never "
                "output SQL, code, URLs, formulas, or auction values. Use original tenor. "
                "Write tenors exactly like 30-Year or 13-Week. Use null for a security type "
                "unless the user explicitly names Bill, Note, Bond, TIPS, FRN, or CMB. Use null "
                "for dates unless the user provides an exact date. The database and deterministic "
                "date parser, not you, supply every result and relative date."
            ),
            user=prompt,
            schema=MODEL_SCHEMA,
        )
        # The model may translate unfamiliar wording, but it cannot override fields that carry
        # identifiers, relative-date arithmetic, or filters already resolved deterministically.
        parsed["term"] = deterministic.get("term") or _normalize_model_term(parsed.get("term"))
        parsed["securityType"] = deterministic.get("securityType")
        parsed["cusip"] = deterministic.get("cusip")
        parsed["startDate"] = deterministic.get("startDate")
        parsed["endDate"] = deterministic.get("endDate")
        parsed["reopening"] = deterministic.get("reopening", "all")
        parsed["chartType"] = deterministic.get("chartType", "line")
        parsed["panels"] = parsed.get("panels") or deterministic.get("panels") or _legacy_panels(parsed.get("view"))
        return validate_query_spec(parsed), model
    except Exception as exc:
        raise RuntimeError(
            f"The optional Ollama parser was requested but did not return a valid constrained query ({exc}). Standard filters remain available."
        ) from exc


def _execute_spec(spec: dict[str, Any], db_path: Path | str) -> dict[str, Any]:
    where = ["completed=1"]
    params: list[Any] = []
    if spec.get("term"):
        where.append("term=?")
        params.append(spec["term"])
    if spec.get("securityType"):
        where.append("security_type=?")
        params.append(spec["securityType"])
    if spec.get("cusip"):
        where.append("cusip=?")
        params.append(spec["cusip"])
    if spec.get("startDate"):
        where.append("auction_date>=?")
        params.append(spec["startDate"])
    if spec.get("endDate"):
        where.append("auction_date<=?")
        params.append(spec["endDate"])
    if spec.get("reopening") == "only":
        where.append("reopening=1")
    elif spec.get("reopening") == "exclude":
        where.append("reopening=0")
    panels = set(spec.get("panels") or _legacy_panels(spec.get("view")))
    chart_requested = "chart" in panels
    table_requested = bool(panels & {"table", "documents"})
    order = "DESC" if spec.get("view") in {"latest", "table", "records"} else "ASC"
    timestamp_order = ",COALESCE(updated_timestamp,'') DESC" if order == "DESC" else ""
    view = spec.get("view")
    with _db(db_path) as connection:
        where_sql = " AND ".join(where)
        coverage = connection.execute(
            f"SELECT COUNT(*) count,MIN(auction_date) first_date,MAX(auction_date) last_date FROM auctions WHERE {where_sql}",
            params,
        ).fetchone()
        total = int(coverage["count"])
        table_rows: list[dict[str, Any]] | None = None
        table_truncated = False
        if view == "latest":
            rows = _load_rows(
                connection,
                f"SELECT payload_json FROM auctions WHERE {where_sql} ORDER BY auction_date DESC,COALESCE(updated_timestamp,'') DESC,cusip ASC LIMIT 1",
                params,
            )
        elif chart_requested and total > 600:
            stride = max(1, math.ceil(total / 600))
            rows = _load_rows(
                connection,
                f"""
                SELECT payload_json FROM (
                  SELECT payload_json,ROW_NUMBER() OVER (ORDER BY auction_date ASC,cusip ASC) row_number
                  FROM auctions WHERE {where_sql}
                ) sampled
                WHERE row_number=1 OR row_number=? OR ((row_number-1) % ?)=0
                ORDER BY row_number ASC
                """,
                [*params, total, stride],
            )
        else:
            rows = _load_rows(
                connection,
                f"SELECT payload_json FROM auctions WHERE {where_sql} ORDER BY auction_date {order}{timestamp_order},cusip ASC LIMIT 5000",
                params,
            )
        if table_requested and view != "latest":
            table_rows = _load_rows(
                connection,
                f"SELECT payload_json FROM auctions WHERE {where_sql} ORDER BY auction_date DESC,COALESCE(updated_timestamp,'') DESC,cusip ASC LIMIT 5000",
                params,
            )
            table_truncated = total > len(table_rows)
        return {
            "rows": rows,
            "tableRows": table_rows,
            "totalMatched": total,
            "firstDate": coverage["first_date"],
            "lastDate": coverage["last_date"],
            "sampled": chart_requested and total > len(rows),
            "truncated": not chart_requested and total > len(rows),
            "tableTruncated": table_truncated,
        }


def query_payload(
    prompt: str,
    *,
    use_model: bool = False,
    as_of: date | None = None,
    db_path: Path | str = DB_PATH,
) -> dict[str, Any]:
    sync_auctions(db_path=db_path)
    spec, warnings, recognized = parse_query(prompt, as_of)
    parser = "deterministic"
    model = None
    model_ready = model_router.ollama_status()["ready"] if not recognized else False
    if not recognized and (use_model or model_ready):
        spec, model = _ollama_spec(prompt, spec)
        parser = "ollama"
    elif not recognized:
        raise ValueError(
            "I could not map that request to approved auction fields. Try naming a tenor, security type, metric, and chart or table."
        )
    spec = validate_query_spec({key: spec.get(key) for key in MODEL_SCHEMA["properties"]})
    execution = _execute_spec(spec, db_path)
    rows = execution["rows"]
    record_rows = execution["tableRows"] if execution["tableRows"] is not None else rows
    metrics = spec["metrics"]
    missing_count = sum(1 for row in rows for metric in metrics if row.get(metric) is None)
    dated = [row["auctionDate"] for row in rows]
    result_pdf_count = sum(1 for row in record_rows if row.get("resultPdfUrl"))
    return {
        "prompt": prompt,
        "parser": parser,
        "usedModel": parser == "ollama",
        "model": model,
        "spec": {**spec, "metric": metrics[0] if metrics else None},
        "interpretation": "Original-tenor filters include reopenings unless explicitly excluded. All values are read from normalized official records.",
        "warnings": warnings,
        "rows": rows,
        "tableRows": execution["tableRows"],
        "summary": {
            "observationCount": execution["totalMatched"],
            "returnedCount": len(rows),
            "tableReturnedCount": len(record_rows),
            "firstDate": execution["firstDate"],
            "lastDate": execution["lastDate"],
            "sampled": execution["sampled"],
            "truncated": execution["truncated"],
            "tableTruncated": execution["tableTruncated"],
            "missingCount": missing_count,
            "resultPdfCount": result_pdf_count,
            "missingResultPdfCount": len(record_rows) - result_pdf_count,
            "metricDefinitions": {metric: METRICS[metric] for metric in metrics},
        },
        "detail": rows[0] if spec["view"] == "latest" and rows else None,
        "sources": _source_manifest(),
        "database": database_status(db_path),
        "verification": {
            "status": "pass",
            "schemaValidated": True,
            "recordsReadFromDatabase": len(rows),
            "dataValuesFromModel": False,
        },
    }


def auction_detail(auction_key: str, db_path: Path | str = DB_PATH) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Z0-9]{8,12}\|\d{4}-\d{2}-\d{2}", auction_key):
        raise ValueError("Invalid auction key.")
    try:
        date.fromisoformat(auction_key.rsplit("|", 1)[1])
    except ValueError as exc:
        raise ValueError("Invalid auction date in auction key.") from exc
    with _db(db_path) as connection:
        row = connection.execute(
            "SELECT payload_json FROM auctions WHERE auction_key=?", (auction_key,)
        ).fetchone()
        if not row:
            raise ValueError("Auction not found.")
        revisions = connection.execute(
            "SELECT COUNT(*) count FROM auction_revisions WHERE auction_key=?", (auction_key,)
        ).fetchone()["count"]
    return {"auction": json.loads(row["payload_json"]), "revisionCount": int(revisions), "sources": _source_manifest()}


def auctions_payload(filters: dict[str, Any], db_path: Path | str = DB_PATH) -> dict[str, Any]:
    prompt_parts = [str(filters.get("view") or "table")]
    for key in ("metric", "term", "securityType"):
        if filters.get(key):
            prompt_parts.append(str(filters[key]))
    if filters.get("startDate"):
        prompt_parts.append(f"since {filters['startDate']}")
    return query_payload(" ".join(prompt_parts), db_path=db_path)
