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
    r"(?:"
    r"(?:show|display|graph|plot|chart|compare|give)\s+(?:me\s+)?|"
    r"(?:build|create|make)\s+(?:me\s+)?(?:a\s+)?(?:macro\s+)?"
    r"(?:chart|graph|plot)\s+(?:comparing\s+)?"
    r")",
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

_PRESENTATION_AXIS_MAPPING = re.compile(
    r"\b(?:put|place|keep|show|plot)\s+(?P<left>[^,.;]+?)\s+"
    r"(?:on|to)\s+(?:the\s+)?left\s+(?:y[- ]?)?axis\s+"
    r"(?:and|while)\s+(?P<right>[^,.;]+?)\s+"
    r"(?:on|to)\s+(?:the\s+)?right(?:\s+(?:y[- ]?)?axis)?\b",
    re.IGNORECASE,
)
_PRESENTATION_SIDE_MAPPING = re.compile(
    r"\b(?:put|place|keep|show|plot)\s+(?P<left>[^,.;]+?)\s+"
    r"(?:on|to)\s+(?:the\s+)?(?:one|left)\s+side(?:\s+of\s+the\s+axis)?\s+"
    r"(?:and|while)\s+(?P<right>[^,.;]+?)\s+(?:on|to)\s+"
    r"(?:the\s+)?(?:other|right)(?:\s+side)?\b",
    re.IGNORECASE,
)
_PRESENTATION_AXIS_COMMAND = re.compile(
    r"\b(?:put|place|keep|show|plot)\s+[^,.;]{1,180}?\b(?:axis|axes|side)\b",
    re.IGNORECASE,
)
_PRESENTATION_AXIS_PHRASE = re.compile(
    r"\b(?:with|using|use)\s+(?:separate\s+)?left\s+and\s+right\s+"
    r"(?:y[- ]?)?(?:axis|axes|scale|scales)\b|"
    r"\b(?:on|to)\s+(?:the\s+)?left\s+and\s+right\s+(?:y[- ]?)?(?:axis|axes)\b|"
    r"\b(?:on|to)\s+(?:(?:the|a|an)\s+)?(?:opposite|secondary|other|right|left|separate|different|distinct)\s+"
    r"(?:y[- ]?)?(?:axis|axes|scale|scales)\b|"
    r"\b(?:on|to)\s+(?:(?:the|a|an)\s+)?(?:same|single|one|common|shared)\s+"
    r"(?:y[- ]?)?(?:axis|axes|scale|scales)\b|"
    r"\b(?:use|with|using)\s+(?:an?\s+)?(?:opposite|secondary|dual|separate|different|distinct|"
    r"same|single|common|shared)\s+(?:y[- ]?)?(?:axis|axes)\b|"
    r"\b(?:opposite|secondary|dual|separate|different|distinct)\s+(?:y[- ]?)?(?:axis|axes)\b|"
    r"\b(?:same|single|one|common|shared)\s+(?:y[- ]?)?axis\b",
    re.IGNORECASE,
)
_PRESENTATION_AXIS_TARGET = re.compile(
    r"\b(?:with|using|use|on)\s+(?:an?\s+)?(?:secondary|opposite|separate|right|left)\s+"
    r"(?:y[- ]?)?(?:axis|scale)\s+for\s+(?:the\s+)?(?:first|second)\s+series\b",
    re.IGNORECASE,
)
_PRESENTATION_SIDE_PHRASE = re.compile(
    r"(?<!compared\s)\b(?:with|using)\s+[^,.;]{1,180}?\b(?:axis|axes|side)\b|"
    r"\b(?:one|each|different)\s+(?:on|to)\s+(?:the\s+)?"
    r"(?:left|right|other|opposite)\s+(?:axis|side)\b",
    re.IGNORECASE,
)
_PRESENTATION_TRANSFORMS = (
    ("pct_yoy", re.compile(
        r"\b(?:(?:in|as)\s+)?(?:year[ -]over[ -]year|yoy)(?:\s+(?:percent(?:age)?\s+)?change)?\b|"
        r"\b12[ -]month\s+(?:percent(?:age)?\s+)?change\b|"
        r"\bpercent(?:age)? change from (?:a )?year ago\b",
        re.IGNORECASE,
    )),
    ("pct_change", re.compile(
        r"\b(?:(?:in|as)\s+)?(?:month[ -]over[ -]month|mom|monthly percent change)\b|"
        r"\b(?:(?:in|as)\s+)?percent(?:age)? change\b",
        re.IGNORECASE,
    )),
    ("index", re.compile(
        r"\b(?:(?:in|as)\s+)?(?:index(?:ed)?\s+to\s+100|rebased?(?:\s+to\s+100)?|"
        r"normalized?(?:\s+to\s+100)?|relative performance)\b",
        re.IGNORECASE,
    )),
    ("raw", re.compile(
        r"\b(?:(?:in|as)\s+)?(?:native|raw|untransformed)\s+(?:values?|levels?|units?)\b|"
        r"\b(?:official|native|raw) index(?: level)?\b|\bindex level\b",
        re.IGNORECASE,
    )),
)
_PRESENTATION_CHART_TYPE = re.compile(
    r"\b(?:(?:as|using)\s+(?:a|an)\s+)?(?P<type>bar|column|line|area|scatter)\s+(?:chart|graph|plot)\b|"
    r"\b(?P<table>table)\b",
    re.IGNORECASE,
)
_PRESENTATION_LOG = re.compile(
    r"\b(?:log(?:arithmic)?)(?:\s+(?:scale|axis|axes))?\b",
    re.IGNORECASE,
)
_PRESENTATION_STYLE = re.compile(
    r"\b(?P<style>dashed|dotted|dash[ -]?dot|solid)\s+lines?\b|"
    r"\b(?P<marker>with\s+(?:circle|square|diamond|triangle)\s+markers?)\b",
    re.IGNORECASE,
)
_COLOR_TOKEN = r"#[0-9a-f]{6}|red|blue|green|orange|yellow|purple|teal|black|gray|grey|white"
_PRESENTATION_ORDINAL_COLORS = re.compile(
    rf"\bwith\s+(?:the\s+)?first\s+series\s+(?P<first_named>{_COLOR_TOKEN})\s+"
    rf"and\s+(?:the\s+)?second(?:\s+series)?\s+(?P<second_named>{_COLOR_TOKEN})\b|"
    rf"\busing\s+(?P<first_value>{_COLOR_TOKEN})\s+for\s+(?:the\s+)?first\s+series\s+"
    rf"and\s+(?P<second_value>{_COLOR_TOKEN})\s+for\s+(?:the\s+)?second(?:\s+series)?\b",
    re.IGNORECASE,
)
_PRESENTATION_COLOR = re.compile(
    r"\b(?:color|colour)(?:s)?\s+(?:the\s+)?(?:line|lines|series|chart)?\s*"
    r"(?:to|as|=)?\s*(?P<color>#[0-9a-f]{6}|red|blue|green|orange|yellow|purple|teal|black|gray|grey|white)\b",
    re.IGNORECASE,
)
_UNSUPPORTED_CHART_PRESENTATION = re.compile(
    r"\b(?:on|in|as|with)\s+(?:a|an|the)\s+(?P<descriptor>[a-z][a-z -]{1,40})\s+"
    r"(?:chart|graph|plot)\b",
    re.IGNORECASE,
)
_TIME_PATTERNS = (
    re.compile(
        r"\b(?:for|over|during|across|past|previous|trailing)\s+(?:the\s+)?(?:(?:last|preceding)\s+)?"
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
    pieces = re.split(
        r"\s+(?:versus|vs\.?|against|alongside|compared\s+with)\s+|\s*,\s*|\s*;\s*",
        protected,
        flags=re.IGNORECASE,
    )
    if len(pieces) == 1:
        pieces = re.split(r"\s+and\s+", protected, flags=re.IGNORECASE)
    output: list[str] = []
    for piece in pieces:
        value = piece.replace(token, "and")
        value = re.sub(r"\s+", " ", value).strip(" ,.;:-")
        if value:
            output.append(value)
    return output


def _presentation_axis_kind(value: str) -> str:
    lowered = value.lower()
    if re.search(r"\b(?:one|each)\s+side\b.*\b(?:other|opposite)\b", lowered):
        return "dual"
    if re.search(r"\b(?:left|right)\b.*\b(?:left|right)\b", lowered):
        return "dual"
    if re.search(r"\b(?:same|single|one|common|shared)\b", lowered):
        return "single"
    if re.search(r"\b(?:opposite|secondary|dual|separate|different|distinct|other|left|right)\b", lowered):
        return "dual"
    return "auto"


def extract_presentation(text: str) -> tuple[str, dict[str, Any]]:
    """Extract typed display instructions and return concept-only text.

    This function is intentionally conservative: it removes only language that
    is unambiguously about chart presentation. Economic words remain available
    to the domain resolver and to the constrained model fallback.
    """
    cleaned = text
    spans: list[dict[str, str]] = []
    axis: dict[str, Any] = {
        "mode": "auto",
        "explicit": False,
        "directive": None,
        "leftKeywords": [],
        "rightKeywords": [],
        "leftOrdinals": [],
        "rightOrdinals": [],
        "sourceSpans": [],
    }
    transform: dict[str, Any] = {
        "mode": "raw",
        "explicit": False,
        "sourceSpans": [],
    }
    style: dict[str, Any] = {
        "colors": [],
        "lineStyle": "solid",
        "marker": "none",
        "scale": "linear",
    }
    chart_type = "line"
    outputs: list[str] = []
    unsupported: list[str] = []

    def consume(pattern: re.Pattern[str], kind: str, handler=None) -> None:
        nonlocal cleaned

        def replace(match: re.Match[str]) -> str:
            span = match.group(0).strip()
            if span:
                spans.append({"kind": kind, "sourceSpan": span})
                if handler:
                    handler(match, span)
            return " "

        cleaned = pattern.sub(replace, cleaned)

    def record_axis(match: re.Match[str], span: str) -> None:
        kind = _presentation_axis_kind(span)
        axis["explicit"] = True
        if kind != "auto":
            axis["mode"] = kind
            axis["directive"] = (
                "same-axis" if kind == "single" else "dual-axis"
            )
        left = match.groupdict().get("left") if match.groupdict() else None
        right = match.groupdict().get("right") if match.groupdict() else None
        if left:
            axis["leftKeywords"].append(left.strip())
        if right:
            axis["rightKeywords"].append(right.strip())
        for side, value in (("leftOrdinals", left), ("rightOrdinals", right)):
            if not value:
                continue
            lowered = value.lower()
            if re.search(r"\b(?:first|1st|one)\b", lowered):
                axis[side].append(0)
            if re.search(r"\b(?:second|2nd|two)\b", lowered):
                axis[side].append(1)
        axis["sourceSpans"].append(span)

    # Capture explicit left/right mappings before the broader command pattern.
    consume(_PRESENTATION_AXIS_MAPPING, "axis", record_axis)
    consume(_PRESENTATION_SIDE_MAPPING, "axis", record_axis)
    consume(_PRESENTATION_AXIS_COMMAND, "axis", record_axis)
    consume(_PRESENTATION_AXIS_TARGET, "axis", record_axis)
    consume(_PRESENTATION_SIDE_PHRASE, "axis", record_axis)
    consume(_PRESENTATION_AXIS_PHRASE, "axis", record_axis)

    def record_transform(mode: str):
        def handler(_match: re.Match[str], span: str) -> None:
            transform["mode"] = mode
            transform["explicit"] = True
            transform["sourceSpans"].append(span)
        return handler

    for mode, pattern in _PRESENTATION_TRANSFORMS:
        consume(pattern, "transform", record_transform(mode))

    def record_chart_type(match: re.Match[str], span: str) -> None:
        nonlocal chart_type
        value = (match.group("type") or "").lower()
        if match.group("table"):
            value = "table"
        chart_type = "bar" if value == "column" else value
        if value == "table":
            outputs.append("table")

    consume(_PRESENTATION_CHART_TYPE, "chart-type", record_chart_type)

    def record_log(_match: re.Match[str], _span: str) -> None:
        style["scale"] = "log"

    consume(_PRESENTATION_LOG, "scale", record_log)

    def record_style(match: re.Match[str], _span: str) -> None:
        if match.group("style"):
            style["lineStyle"] = match.group("style").lower().replace(" ", "-")
        if match.group("marker"):
            marker = re.search(r"circle|square|diamond|triangle", match.group("marker"), re.IGNORECASE)
            if marker:
                style["marker"] = marker.group(0).lower()

    consume(_PRESENTATION_STYLE, "style", record_style)

    def record_color(match: re.Match[str], _span: str) -> None:
        style["colors"].append(match.group("color").lower())

    def record_ordinal_colors(match: re.Match[str], _span: str) -> None:
        groups = match.groupdict()
        first = groups.get("first_named") or groups.get("first_value")
        second = groups.get("second_named") or groups.get("second_value")
        if first and second:
            style["colors"].extend((first.lower(), second.lower()))

    consume(_PRESENTATION_ORDINAL_COLORS, "color", record_ordinal_colors)
    consume(_PRESENTATION_COLOR, "color", record_color)

    def record_unsupported(match: re.Match[str], span: str) -> None:
        descriptor = re.sub(r"\s+", " ", match.group("descriptor")).strip()
        if descriptor and descriptor not in {"a", "an", "the"}:
            unsupported.append(span)

    consume(_UNSUPPORTED_CHART_PRESENTATION, "unsupported-presentation", record_unsupported)

    if axis["explicit"] and axis["mode"] == "auto":
        axis["mode"] = "dual"
        axis["directive"] = "dual-axis"
    axis["sourceSpans"] = list(dict.fromkeys(axis["sourceSpans"]))
    axis["leftOrdinals"] = list(dict.fromkeys(axis["leftOrdinals"]))
    axis["rightOrdinals"] = list(dict.fromkeys(axis["rightOrdinals"]))
    transform["sourceSpans"] = list(dict.fromkeys(transform["sourceSpans"]))
    cleaned = _TRAILING_PRESENTATION.sub(" ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,.;:-")
    return cleaned, {
        "outputs": list(dict.fromkeys(outputs)),
        "chartType": chart_type,
        "axis": axis,
        "transform": transform,
        "style": style,
        "unsupported": list(dict.fromkeys(unsupported)),
        "sourceSpans": spans,
    }


def parse_macro_contract(prompt: str) -> dict[str, Any]:
    """Return a lossless macro request contract without resolving providers."""
    normalized, corrections = normalize_known_typos(prompt)
    request_text = strip_meta_prefix(normalized)
    operation = (
        "compare"
        if re.search(
            r"\b(?:versus|vs\.?|against|compare|alongside)\b|\bcompared\s+with\b",
            request_text,
            re.IGNORECASE,
        )
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
    operand_text, presentation = extract_presentation(operand_text)
    if not presentation["outputs"]:
        presentation["outputs"] = outputs
    else:
        presentation["outputs"] = list(dict.fromkeys([*outputs, *presentation["outputs"]]))
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
        "conceptText": operand_text,
        "resolutionText": operand_text,
        "operands": operands,
        "time": {"sourceSpans": list(dict.fromkeys(time_spans))},
        "presentation": presentation,
        "normalization": {"corrections": corrections},
    }
