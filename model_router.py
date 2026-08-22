"""Constrained local-model intent routing for Side Tools.

The model may translate wording into an allowlisted request shape. It never
provides observations, source URLs, provider IDs, formulas, or calculations.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from data_core import load_settings


DEFAULT_MODEL = "qwen3.5:9b"
OLLAMA_URL = "http://127.0.0.1:11434"
_STATUS_LOCK = threading.Lock()
_STATUS_CACHE: tuple[float, dict[str, Any]] | None = None


def configured_model() -> str:
    return str(
        os.environ.get("OLLAMA_MODEL")
        or load_settings().get("ollamaModel")
        or DEFAULT_MODEL
    ).strip()


def ollama_status(*, force: bool = False) -> dict[str, Any]:
    global _STATUS_CACHE
    with _STATUS_LOCK:
        if not force and _STATUS_CACHE and time.time() - _STATUS_CACHE[0] < 10:
            return dict(_STATUS_CACHE[1])
        model = configured_model()
        try:
            request = urllib.request.Request(
                f"{OLLAMA_URL}/api/tags",
                headers={"Accept": "application/json"},
            )
            # A missing optional local model should never stall the deterministic tools.
            with urllib.request.urlopen(request, timeout=0.5) as response:
                payload = json.loads(response.read().decode("utf-8"))
            installed = sorted(
                {
                    str(row.get("name") or row.get("model") or "").strip()
                    for row in payload.get("models", [])
                    if row.get("name") or row.get("model")
                }
            )
            model_base = model.split(":", 1)[0]
            matching = next(
                (
                    name
                    for name in installed
                    if name == model or name.split(":", 1)[0] == model_base
                ),
                None,
            )
            ready = matching is not None
            status = {
                "reachable": True,
                "ready": ready,
                "model": matching or model,
                "configuredModel": model,
                "installedModels": installed,
                "message": (
                    f"Local fallback ready: {matching}."
                    if ready
                    else f"Ollama is running, but {model} is not installed."
                ),
            }
        except Exception as exc:  # noqa: BLE001 - status must never break deterministic tools.
            status = {
                "reachable": False,
                "ready": False,
                "model": model,
                "configuredModel": model,
                "installedModels": [],
                "message": (
                    "Local model fallback is inactive. Deterministic tools still work; install "
                    f"Ollama and pull {model} to enable unfamiliar-language routing."
                ),
                "detail": str(exc)[:240],
            }
        _STATUS_CACHE = (time.time(), status)
        return dict(status)


def generate_json(
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    timeout: int = 30,
) -> tuple[dict[str, Any], str]:
    status = ollama_status()
    if not status["ready"]:
        raise RuntimeError(status["message"])
    payload = {
        "model": status["model"],
        "stream": False,
        "think": False,
        "format": schema,
        "options": {"temperature": 0},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            answer = json.loads(response.read().decode("utf-8"))
        parsed = json.loads(answer.get("message", {}).get("content", ""))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:  # noqa: BLE001
            detail = ""
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(
            f"The local model rejected the constrained request (HTTP {exc.code}){suffix}"
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"The local model did not return valid constrained JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("The local model response was not a JSON object.")
    return parsed, str(status["model"])


MACRO_CANONICAL_QUERIES = [
    "headline CPI",
    "core CPI",
    "core CPI excluding shelter",
    "PCE price index",
    "core PCE price index",
    "producer price index",
    "core PPI final demand",
    "core PPI goods",
    "core PPI services",
    "unemployment rate",
    "U-6 unemployment rate",
    "labor force participation rate",
    "employment-population ratio",
    "nonfarm payrolls",
    "initial jobless claims",
    "continued jobless claims",
    "job openings",
    "hires rate",
    "quits rate",
    "real GDP",
    "nominal GDP",
    "GDP deflator",
    "real private nonresidential fixed investment",
    "nominal private nonresidential fixed investment",
    "real personal consumption expenditures",
    "personal saving rate",
    "disposable personal income",
    "labor productivity",
    "unit labor costs",
    "average hourly earnings",
    "average weekly hours",
    "S&P 500 index",
    "Nasdaq Composite index",
    "Dow Jones Industrial Average",
    "VIX",
    "effective federal funds rate",
    "SOFR",
    "overnight reverse repo",
    "2-year Treasury yield",
    "5-year Treasury yield",
    "10-year Treasury yield",
    "30-year Treasury yield",
    "10-year real Treasury yield",
    "10-year minus 2-year Treasury spread",
    "10-year minus 3-month Treasury spread",
    "5-year breakeven inflation",
    "10-year breakeven inflation",
    "broad U.S. dollar index",
    "gold price",
    "silver price",
    "WTI crude oil price",
    "Brent crude oil price",
    "natural gas price",
    "M1 money supply",
    "M2 money supply",
    "national home price index",
    "S&P 500 operating earnings per share",
    "unsupported",
]


MACRO_INTENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["canonicalQueries"],
    "properties": {
        "canonicalQueries": {
            "type": "array",
            "minItems": 1,
            "maxItems": 6,
            "items": {"type": "string", "enum": MACRO_CANONICAL_QUERIES},
        }
    },
}

_MACRO_PRESENTATION_LEAK = re.compile(
    r"\b(?:opposite|secondary|dual|separate|different|distinct|same|single|common|shared)\s+"
    r"(?:y[- ]?)?(?:axis|axes)\b|"
    r"\b(?:on|to)\s+(?:the\s+)?(?:left|right|other|opposite|secondary)\s+"
    r"(?:y[- ]?)?axis\b|"
    r"\b(?:bar|line|area|scatter|candlestick)\s+(?:chart|graph|plot)\b|"
    r"\b(?:color|colour|dashed|dotted|logarithmic?)\b|"
    r"\b(?:over|for|during|past)\s+(?:the\s+)?last\s+\d+\s+"
    r"(?:years?|months?|quarters?|weeks?|days?)\b",
    re.IGNORECASE,
)


def _require_clean_macro_concepts(prompt: str) -> None:
    """Keep layout and date language out of the semantic model boundary."""
    leaked = _MACRO_PRESENTATION_LEAK.search(prompt)
    if leaked:
        raise RuntimeError(
            "The local model received chart or time language instead of a clean data concept: "
            f"'{leaked.group(0).strip()}'."
        )


def macro_intent(prompt: str) -> tuple[list[str], str]:
    _require_clean_macro_concepts(prompt)
    parsed, model = generate_json(
        system=(
            "Map one or more clean macro-data concept phrases to exact concepts allowed by the "
            "JSON schema. For example, inflation excluding food and energy means core CPI. "
            "Choose unsupported when there is no exact semantic equivalent; never choose a merely "
            "similar concept. Do not output provider IDs, tickers, URLs, formulas, values, dates, "
            "chart instructions, code, or commentary. The deterministic resolver, not you, selects "
            "every data series. The input has already had chart layout and time language removed."
        ),
        user=prompt,
        schema=MACRO_INTENT_SCHEMA,
    )
    queries = parsed.get("canonicalQueries")
    if not isinstance(queries, list):
        raise RuntimeError("The local model omitted canonicalQueries.")
    cleaned = []
    for value in queries:
        query = str(value).strip()
        if query == "unsupported":
            continue
        if query not in MACRO_CANONICAL_QUERIES or re_disallowed_macro_text(query):
            raise RuntimeError("The local model emitted a disallowed macro intent.")
        if query.lower() not in {row.lower() for row in cleaned}:
            cleaned.append(query)
    if not cleaned:
        raise RuntimeError("The local model found no exact allowlisted macro concept.")
    return cleaned, model


def re_disallowed_macro_text(value: str) -> bool:
    lowered = value.lower()
    return any(token in lowered for token in ("http://", "https://", "select ", " from ", "{", "}"))


FED_INTENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["view", "meetingDate", "historyRange"],
    "properties": {
        "view": {"type": "string", "enum": ["current", "compare", "probabilities", "historical"]},
        "meetingDate": {"type": ["string", "null"]},
        "historyRange": {"type": "string", "enum": ["1M", "3M", "6M", "1Y", "ALL"]},
    },
}


def fed_intent(prompt: str, meeting_dates: list[str]) -> tuple[dict[str, Any], str]:
    parsed, model = generate_json(
        system=(
            "Translate the request into Fed Probability Tracker display controls only. Never "
            "calculate probabilities or output values, sources, code, or commentary. meetingDate "
            "must be null or exactly one of these available dates: " + ", ".join(meeting_dates) +
            ". Treat time-machine, past path, and over-time wording as the historical view. "
            "Treat first listed or next meeting as the first available date. Use ALL only for "
            "full/everything/all-history wording; otherwise default an unspecified history range to 1Y."
        ),
        user=prompt,
        schema=FED_INTENT_SCHEMA,
    )
    view = parsed.get("view")
    meeting = parsed.get("meetingDate")
    history_range = parsed.get("historyRange")
    text = prompt.lower()
    if re.search(r"\b(?:all|full|entire)\s+(?:available\s+)?history\b|\beverything\b|\bmax\b", text):
        history_range = "ALL"
    elif not re.search(r"\b(?:1|3|6)\s*(?:months?|mos?)\b|\b1\s*(?:year|yr)\b", text):
        history_range = "1Y"
    if view not in {"current", "compare", "probabilities", "historical"}:
        raise RuntimeError("The local model selected an unsupported Fed Tracker view.")
    if meeting is not None and meeting not in meeting_dates:
        raise RuntimeError("The local model selected a meeting outside the available calendar.")
    if history_range not in {"1M", "3M", "6M", "1Y", "ALL"}:
        raise RuntimeError("The local model selected an unsupported history range.")
    return {
        "view": view,
        "meetingDate": meeting,
        "historyRange": history_range,
    }, model
