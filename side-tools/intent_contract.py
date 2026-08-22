"""Shared, lossless request-contract parsing for the Side Tools.

The parsers in each tool remain domain-specific. This module only separates
presentation language, time language, and operand spans before a domain
resolver maps those operands to audited concepts.
"""

from __future__ import annotations

import re
from typing import Any


KNOWN_TYPOS = {
    "capitilization": "capitalization",
    "capitilzation": "capitalization",
    "capitlization": "capitalization",
    "capitilzation": "capitalization",
    "capitalizaton": "capitalization",
    "oustanding": "outstanding",
    "outstandng": "outstanding",
    "equites": "equities",
    "probabilites": "probabilities",
    "probablities": "probabilities",
    "probablity": "probability",
    "snapshotes": "snapshots",
    "markett": "market",
    "servcies": "services",
    "persent": "percent",
    "aucton": "auction",
    "auctionn": "auction",
    "auctiones": "auctions",
}

_LEADING_COMMAND = re.compile(
    r"^\s*(?:(?:please|kindly)\s+)?"
    r"(?:(?:can|could|would|will)\s+you\s+)?"
    r"(?:show|display|graph|plot|chart|compare|give)\s+(?:me\s+)?",
    re.IGNORECASE,
)
_META_PREFIX = re.compile(
    r"^\s*(?:"
    r"for an?\s+(?:audited|auditable|verified)\s+(?:chart|research request)|"
    r"as a research analyst|"
    r"please use (?:the )?verified data and|"
    r"please display the following research request"
    r")\s*[:,]?\s*",
    re.IGNORECASE,
)
_TRAILING_PRESENTATION = re.compile(
    r"\s+(?:on|in|as)\s+(?:a\s+)?(?:chart|graph|plot|table)\s*$",
    re.IGNORECASE,
)
_TIME_PATTERNS = (
    re.compile(
        r"\b(?:for|over|during|past|previous|trailing)\s+(?:the\s+)?(?:last\s+)?"
        r"\d+[\s-]*(?:years?|yrs?|months?|mos?|quarters?|decades?|weeks?|days?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:from|between)\s+(?:19|20)\d{2}\s+(?:to|and|through)\s+(?:19|20)\d{2}\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bsince\s+(?:19|20)\d{2}\b|\b(?:year[ -]to[ -]date|ytd)\b", re.IGNORECASE),
)

_PROTECTED_AND_PATTERNS = (
    r"\bgoods?\s+and\s+services?\b",
    r"\bfood\s+and\s+energy\b",
    r"\binventory valuation\s+and\s+capital consumption adjustments\b",
    r"\burban wage earners\s+and\s+clerical workers\b",
    r"\bhouseholds?\s+and\s+nonprofit organizations?\b",
    r"\bbetween\s+[^,.;]{1,45}\s+and\s+[^,.;]{1,45}",
    r"\b\d+(?:st|nd|rd|th)?\s+and\s+\d+(?:st|nd|rd|th)?\s+percentiles?\b",
    r"\bage\s+(?:under\s+|over\s+)?\d+(?:\s*[-+]\s*\d+)?\s+and\s+"
    r"(?:under\s+|over\s+)?\d+(?:\s*[-+]\s*\d+|\+)?",
    r"\b[qd]\d+\s+and\s+[qd]\d+\b",
)


def normalize_known_typos(text: str) -> tuple[str, list[dict[str, str]]]:
    """Correct only audited vocabulary typos and retain an explicit trace."""
    normalized = text
    corrections: list[dict[str, str]] = []
    for source, target in KNOWN_TYPOS.items():
        pattern = re.compile(rf"\b{re.escape(source)}\b", re.IGNORECASE)
        if pattern.search(normalized):
            normalized = pattern.sub(target, normalized)
            corrections.append({"source": source, "target": target})
    return normalized, corrections


def strip_meta_prefix(text: str) -> str:
    """Remove common request framing without touching requested concepts."""
    return _META_PREFIX.sub("", text, count=1)


def _protect_and(text: str) -> tuple[str, str]:
    token = "__side_tools_protected_and__"
    protected = text
    for pattern in _PROTECTED_AND_PATTERNS:
        protected = re.sub(
            pattern,
            lambda match: re.sub(r"\band\b", token, match.group(0), flags=re.IGNORECASE),
            protected,
            flags=re.IGNORECASE,
        )
    return protected, token


def _operand_spans(text: str) -> list[str]:
    protected, token = _protect_and(text)
    # Comparison connectors are always operand boundaries. Coordinating "and"
    # is a boundary only after known compound concepts have been protected.
    pieces = re.split(r"\s+(?:versus|vs\.?|against)\s+|\s*,\s*|\s*;\s*", protected, flags=re.IGNORECASE)
    if len(pieces) == 1:
        pieces = re.split(r"\s+and\s+", protected, flags=re.IGNORECASE)
    output: list[str] = []
    for piece in pieces:
        value = piece.replace(token, "and")
        value = re.sub(r"\s+", " ", value).strip(" ,.;:-")
        if value:
            output.append(value)
    return output


def parse_macro_contract(prompt: str) -> dict[str, Any]:
    """Return a lossless macro request contract without resolving providers."""
    normalized, corrections = normalize_known_typos(prompt)
    request_text = strip_meta_prefix(normalized)
    operation = (
        "compare"
        if re.search(r"\b(?:versus|vs\.?|against|compare)\b", request_text, re.IGNORECASE)
        else "chart"
    )
    outputs = []
    for output, pattern in (
        ("chart", r"\b(?:chart|graph|plot)\b"),
        ("table", r"\btable\b"),
    ):
        if re.search(pattern, request_text, re.IGNORECASE):
            outputs.append(output)
    if not outputs:
        outputs = ["chart"]

    time_spans: list[str] = []
    operand_text = request_text
    for pattern in _TIME_PATTERNS:
        for match in list(pattern.finditer(operand_text)):
            time_spans.append(match.group(0))
        operand_text = pattern.sub(" ", operand_text)
    operand_text = _LEADING_COMMAND.sub("", operand_text)
    operand_text = _TRAILING_PRESENTATION.sub("", operand_text)
    operand_text = re.sub(r"\s+", " ", operand_text).strip(" ,.;:-")

    operands = [
        {
            "sourceSpan": span,
            "normalizedSpan": span.lower(),
            "status": "unresolved",
        }
        for span in _operand_spans(operand_text)
    ]
    return {
        "rawPrompt": prompt,
        "normalizedPrompt": normalized,
        "operation": operation,
        "operands": operands,
        "time": {"sourceSpans": list(dict.fromkeys(time_spans))},
        "presentation": {"outputs": outputs},
        "normalization": {"corrections": corrections},
    }
