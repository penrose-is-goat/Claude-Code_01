"""Shared transport, settings, and cache services for the side tools."""

from __future__ import annotations

import hashlib
import gzip
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


APP_DIR = Path(__file__).resolve().parent
CACHE_DIR = APP_DIR / ".cache" / "http"
LEGACY_SETTINGS_PATH = APP_DIR / "side-tools-settings.json"
SETTINGS_PATH = (
    Path(os.environ.get("LOCALAPPDATA") or (APP_DIR / ".local"))
    / "PortfolioAnalyzerSideTools"
    / "settings.json"
)
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


class NetworkPolicyError(RuntimeError):
    """Raised when the process is denied outbound sockets by its execution context."""


class HttpFetchError(RuntimeError):
    """Raised after every permitted transport and cache fallback has failed."""


@dataclass(frozen=True)
class HttpResult:
    text: str
    url: str
    transport: str
    fetched_at: str
    from_cache: bool = False
    stale: bool = False
    warning: str | None = None


@dataclass(frozen=True)
class HttpBytesResult:
    content: bytes
    url: str
    transport: str
    fetched_at: str
    from_cache: bool = False
    stale: bool = False
    warning: str | None = None


_TRACE = threading.local()
_POLICY_LOCK = threading.Lock()
_POLICY_DENIED_UNTIL = 0.0
SENSITIVE_QUERY_KEYS = {"api_key", "apikey", "key", "token", "access_token"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def start_network_trace() -> None:
    _TRACE.events = []


def redact_url(url: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(url)
        pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        safe_query = urllib.parse.urlencode(
            [
                (key, "REDACTED" if key.lower() in SENSITIVE_QUERY_KEYS else value)
                for key, value in pairs
            ],
            doseq=True,
        )
        return urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, parsed.path, safe_query, parsed.fragment)
        )
    except ValueError:
        return url


def redact_text(value: Any) -> str:
    text = str(value)
    return re.sub(
        r"(?i)([?&](?:api_key|apikey|key|token|access_token)=)[^&\s]+",
        r"\1REDACTED",
        text,
    )


def add_network_event(result: HttpResult | HttpBytesResult) -> None:
    events = getattr(_TRACE, "events", None)
    if events is None:
        return
    events.append(
        {
            "url": redact_url(result.url),
            "transport": result.transport,
            "fetchedAt": result.fetched_at,
            "fromCache": result.from_cache,
            "stale": result.stale,
            "warning": redact_text(result.warning) if result.warning else None,
        }
    )


def finish_network_trace() -> dict[str, Any]:
    events = list(getattr(_TRACE, "events", []))
    _TRACE.events = []
    return {
        "requestCount": len(events),
        "usedCache": any(event["fromCache"] for event in events),
        "usedStaleCache": any(event["stale"] for event in events),
        "transports": sorted({event["transport"] for event in events}),
        "warnings": [event["warning"] for event in events if event.get("warning")],
    }


def load_settings() -> dict[str, Any]:
    source = SETTINGS_PATH if SETTINGS_PATH.exists() else LEGACY_SETTINGS_PATH
    if not source.exists():
        return {}
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(updates: dict[str, Any]) -> dict[str, Any]:
    allowed = {"fredApiKey", "alphaVantageApiKey", "ollamaModel"}
    current = load_settings()
    for key in allowed:
        if key in updates:
            value = str(updates[key]).strip()
            if value:
                current[key] = value
            else:
                current.pop(key, None)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current


def public_settings() -> dict[str, Any]:
    current = load_settings()
    return {
        "fredApiKeyConfigured": bool(current.get("fredApiKey")),
        "alphaVantageApiKeyConfigured": bool(current.get("alphaVantageApiKey")),
        "ollamaModel": current.get("ollamaModel", ""),
    }


def get_secret(name: str, env_name: str) -> str | None:
    return os.environ.get(env_name) or load_settings().get(name)


def _cache_path(url: str, headers: dict[str, str]) -> Path:
    material = json.dumps({"url": url, "headers": headers}, sort_keys=True).encode("utf-8")
    return CACHE_DIR / f"{hashlib.sha256(material).hexdigest()}.json"


def _read_cache(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("text"), str):
            return value
    except (OSError, ValueError):
        pass
    return None


def _write_cache(path: Path, url: str, text: str, transport: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "url": redact_url(url),
                    "text": text,
                    "transport": transport,
                    "fetchedAt": utc_now_iso(),
                    "savedAtEpoch": time.time(),
                }
            ),
            encoding="utf-8",
        )
    except OSError:
        return


def _binary_cache_paths(url: str, headers: dict[str, str]) -> tuple[Path, Path]:
    base = _cache_path(url, headers)
    return base.with_suffix(".bin"), base.with_suffix(".bin.json")


def _read_binary_cache(data_path: Path, metadata_path: Path) -> tuple[bytes, dict[str, Any]] | None:
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        content = data_path.read_bytes()
        if isinstance(metadata, dict) and content:
            return content, metadata
    except (OSError, ValueError):
        pass
    return None


def _write_binary_cache(
    data_path: Path,
    metadata_path: Path,
    url: str,
    content: bytes,
    transport: str,
) -> None:
    try:
        data_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = data_path.with_suffix(data_path.suffix + ".tmp")
        temporary_path.write_bytes(content)
        temporary_path.replace(data_path)
        metadata_path.write_text(
            json.dumps(
                {
                    "url": redact_url(url),
                    "transport": transport,
                    "fetchedAt": utc_now_iso(),
                    "savedAtEpoch": time.time(),
                    "length": len(content),
                }
            ),
            encoding="utf-8",
        )
    except OSError:
        return


def _permission_denied(exc: BaseException) -> bool:
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, PermissionError) and getattr(current, "winerror", None) == 10013:
            return True
        reason = getattr(current, "reason", None)
        if isinstance(reason, BaseException):
            current = reason
            continue
        current = current.__cause__ or current.__context__
    return "WinError 10013" in str(exc)


def _policy_circuit_open() -> bool:
    with _POLICY_LOCK:
        return time.monotonic() < _POLICY_DENIED_UNTIL


def _trip_policy_circuit(seconds: float = 30.0) -> None:
    global _POLICY_DENIED_UNTIL
    with _POLICY_LOCK:
        _POLICY_DENIED_UNTIL = max(_POLICY_DENIED_UNTIL, time.monotonic() + seconds)


def _policy_error() -> NetworkPolicyError:
    return NetworkPolicyError(
        "Outbound HTTPS is blocked for this process (Windows socket error 10013). "
        "The data providers were not reached. Run `python serve.py --doctor` in the same terminal; "
        "if that terminal is restricted, launch the VS Code task or a normal Windows Terminal session."
    )


def _urllib_get(url: str, headers: dict[str, str], timeout: int) -> str:
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def _curl_get(url: str, headers: dict[str, str], timeout: int) -> str:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl is not installed")
    command = [
        curl,
        "--fail-with-body",
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        str(timeout),
    ]
    for name, value in headers.items():
        command.extend(["--header", f"{name}: {value}"])
    command.append(url)
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout + 3, check=False)
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or "curl failed").strip()
        raise RuntimeError(detail[:400])
    return completed.stdout


def _decompress_if_needed(content: bytes) -> bytes:
    if content[:2] == b"\x1f\x8b":
        return gzip.decompress(content)
    return content


def _urllib_get_bytes(url: str, headers: dict[str, str], timeout: int) -> bytes:
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return _decompress_if_needed(response.read())


def _curl_get_bytes(url: str, headers: dict[str, str], timeout: int) -> bytes:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl is not installed")
    command = [
        curl,
        "--fail-with-body",
        "--location",
        "--compressed",
        "--silent",
        "--show-error",
        "--max-time",
        str(timeout),
    ]
    for name, value in headers.items():
        command.extend(["--header", f"{name}: {value}"])
    command.append(url)
    completed = subprocess.run(command, capture_output=True, timeout=timeout + 3, check=False)
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or b"curl failed").decode(
            "utf-8", errors="replace"
        ).strip()
        raise RuntimeError(detail[:400])
    return _decompress_if_needed(completed.stdout)


def http_get(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: int = 20,
    headers: dict[str, str] | None = None,
    default_headers: bool = True,
    cache_ttl: int = 900,
    allow_stale: bool = True,
    cache_enabled: bool = True,
) -> HttpResult:
    if params:
        encoded = urllib.parse.urlencode(params, doseq=True)
        url = f"{url}{'&' if '?' in url else '?'}{encoded}"
    request_headers = (
        {"User-Agent": DEFAULT_USER_AGENT, "Accept": "application/json,text/csv,text/plain,*/*"}
        if default_headers
        else {}
    )
    request_headers.update(headers or {})
    path = _cache_path(url, request_headers)
    cached = _read_cache(path) if cache_enabled else None
    if cached and time.time() - float(cached.get("savedAtEpoch", 0)) <= cache_ttl:
        result = HttpResult(
            text=cached["text"],
            url=url,
            transport=f"cache/{cached.get('transport', 'unknown')}",
            fetched_at=str(cached.get("fetchedAt") or ""),
            from_cache=True,
        )
        add_network_event(result)
        return result

    if cache_enabled and _policy_circuit_open():
        if cached and allow_stale:
            result = HttpResult(
                text=cached["text"],
                url=url,
                transport=f"stale-cache/{cached.get('transport', 'unknown')}",
                fetched_at=str(cached.get("fetchedAt") or ""),
                from_cache=True,
                stale=True,
                warning="Live refresh skipped briefly after the operating system denied outbound sockets.",
            )
            add_network_event(result)
            return result
        raise _policy_error()

    errors: list[str] = []
    policy_denied = False
    for name, loader in (("python-urllib", _urllib_get), ("curl", _curl_get)):
        try:
            text = loader(url, request_headers, timeout)
            if cache_enabled:
                _write_cache(path, url, text, name)
            result = HttpResult(text=text, url=url, transport=name, fetched_at=utc_now_iso())
            add_network_event(result)
            return result
        except Exception as exc:  # noqa: BLE001 - aggregate transport diagnostics.
            policy_denied = policy_denied or _permission_denied(exc)
            errors.append(f"{name}: {redact_text(exc)}")

    if cached and allow_stale:
        warning = "Live refresh failed; displaying the last verified cached response. " + " | ".join(errors)
        result = HttpResult(
            text=cached["text"],
            url=url,
            transport=f"stale-cache/{cached.get('transport', 'unknown')}",
            fetched_at=str(cached.get("fetchedAt") or ""),
            from_cache=True,
            stale=True,
            warning=warning,
        )
        add_network_event(result)
        return result

    if policy_denied:
        _trip_policy_circuit()
        raise _policy_error()
    raise HttpFetchError(f"Could not download {redact_url(url)}. " + " | ".join(errors))


def http_get_bytes(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: int = 30,
    headers: dict[str, str] | None = None,
    default_headers: bool = True,
    cache_ttl: int = 24 * 60 * 60,
    allow_stale: bool = True,
    cache_enabled: bool = True,
) -> HttpBytesResult:
    if params:
        encoded = urllib.parse.urlencode(params, doseq=True)
        url = f"{url}{'&' if '?' in url else '?'}{encoded}"
    request_headers = (
        {"User-Agent": DEFAULT_USER_AGENT, "Accept": "application/octet-stream,*/*"}
        if default_headers
        else {}
    )
    request_headers.update(headers or {})
    data_path, metadata_path = _binary_cache_paths(url, request_headers)
    cached = _read_binary_cache(data_path, metadata_path) if cache_enabled else None
    if cached and time.time() - float(cached[1].get("savedAtEpoch", 0)) <= cache_ttl:
        content, metadata = cached
        result = HttpBytesResult(
            content=content,
            url=url,
            transport=f"cache/{metadata.get('transport', 'unknown')}",
            fetched_at=str(metadata.get("fetchedAt") or ""),
            from_cache=True,
        )
        add_network_event(result)
        return result

    if cache_enabled and _policy_circuit_open():
        if cached and allow_stale:
            content, metadata = cached
            result = HttpBytesResult(
                content=content,
                url=url,
                transport=f"stale-cache/{metadata.get('transport', 'unknown')}",
                fetched_at=str(metadata.get("fetchedAt") or ""),
                from_cache=True,
                stale=True,
                warning="Live refresh skipped briefly after the operating system denied outbound sockets.",
            )
            add_network_event(result)
            return result
        raise _policy_error()

    errors: list[str] = []
    policy_denied = False
    for name, loader in (("python-urllib", _urllib_get_bytes), ("curl", _curl_get_bytes)):
        try:
            content = loader(url, request_headers, timeout)
            if not content:
                raise RuntimeError("provider returned an empty response")
            if cache_enabled:
                _write_binary_cache(data_path, metadata_path, url, content, name)
            result = HttpBytesResult(
                content=content,
                url=url,
                transport=name,
                fetched_at=utc_now_iso(),
            )
            add_network_event(result)
            return result
        except Exception as exc:  # noqa: BLE001 - aggregate transport diagnostics.
            policy_denied = policy_denied or _permission_denied(exc)
            errors.append(f"{name}: {redact_text(exc)}")

    if cached and allow_stale:
        content, metadata = cached
        warning = "Live refresh failed; using the last cached binary response. " + " | ".join(errors)
        result = HttpBytesResult(
            content=content,
            url=url,
            transport=f"stale-cache/{metadata.get('transport', 'unknown')}",
            fetched_at=str(metadata.get("fetchedAt") or ""),
            from_cache=True,
            stale=True,
            warning=warning,
        )
        add_network_event(result)
        return result

    if policy_denied:
        _trip_policy_circuit()
        raise _policy_error()
    raise HttpFetchError(f"Could not download {redact_url(url)}. " + " | ".join(errors))


def diagnose_network() -> dict[str, Any]:
    host = "fred.stlouisfed.org"
    result: dict[str, Any] = {
        "python": sys.executable,
        "host": host,
        "dns": {"ok": False},
        "tcp443": {"ok": False},
        "https": {"ok": False},
        "providers": {},
        "curl": {"available": bool(shutil.which("curl.exe") or shutil.which("curl"))},
    }
    try:
        addresses = sorted({row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        result["dns"] = {"ok": True, "addresses": addresses[:4]}
    except OSError as exc:
        result["dns"]["error"] = str(exc)
    try:
        with socket.create_connection((host, 443), timeout=5) as connection:
            result["tcp443"] = {"ok": True, "peer": connection.getpeername()[0]}
    except OSError as exc:
        result["tcp443"]["error"] = str(exc)
        if _permission_denied(exc):
            result["classification"] = "NETWORK_POLICY_DENIED"
    probes = [
        (
            "FRED",
            "https://fred.stlouisfed.org/graph/fredgraph.csv",
            {"id": "DGS10"},
        ),
        (
            "Yahoo Finance",
            "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC",
            {"range": "5d", "interval": "1d"},
        ),
        (
            "U.S. Treasury",
            "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml",
            {
                "data": "daily_treasury_yield_curve",
                "field_tdr_date_value": datetime.now(timezone.utc).year,
            },
        ),
        (
            "Treasury Auction API",
            "https://www.treasurydirect.gov/TA_WS/securities/auctioned",
            {"format": "json", "day": "1"},
        ),
        (
            "Fiscal Data Auctions",
            "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query",
            {"fields": "cusip,auction_date", "page[size]": "1"},
        ),
        (
            "New York Fed",
            "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
            None,
        ),
        (
            "U.S. Bureau of Labor Statistics",
            "https://api.bls.gov/publicAPI/v2/timeseries/data/CUSR0000SA0",
            {"latest": "true"},
        ),
    ]
    passed: list[str] = []
    failed: list[str] = []
    transports: set[str] = set()
    policy_denied = False
    for name, url, params in probes:
        try:
            response = http_get(
                url,
                params=params,
                timeout=10,
                cache_ttl=0,
                allow_stale=False,
                cache_enabled=False,
            )
            result["providers"][name] = {
                "ok": True,
                "transport": response.transport,
                "bytes": len(response.text),
            }
            passed.append(name)
            transports.add(response.transport)
        except Exception as exc:  # noqa: BLE001
            policy_denied = policy_denied or isinstance(exc, NetworkPolicyError)
            result["providers"][name] = {"ok": False, "error": redact_text(exc)}
            failed.append(name)
    result["https"] = {
        "ok": bool(passed),
        "passed": passed,
        "failed": failed,
        "transport": ", ".join(sorted(transports)),
    }
    if passed:
        result["classification"] = "OK" if not failed else "PARTIAL_PROVIDER_OUTAGE"
    elif policy_denied:
        result["classification"] = "NETWORK_POLICY_DENIED"
    else:
        result["classification"] = "NETWORK_UNAVAILABLE"
    return result
