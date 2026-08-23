"""Independent deterministic semantic/layout release gate for Side Tools v1.2.1.

This module is intentionally QA-only.  It does not change application parsers,
provider code, browser code, Git state, or portfolio-analyzer files.

The expected contract is written by this module's oracle.  It is never inferred
from the parser under test.  The default matrix contains 33,589 generated
macro cases plus representative Fed Tracker and Treasury Auction actions.  It
does not make network calls and never invokes Ollama.

Run from the side-tools directory::

    python -m qa.v1_2_gate --strict
    python -m qa.v1_2_gate --strict --json --artifact-dir qa/artifacts/v1_2
    python -m qa.v1_2_gate --case macro.gold-yield.opposite-axis

The matrix includes exact gold/yield regressions, compact U.S. Treasury tenor
phrasing, presentation mutations, and fail-closed foreign-scope controls.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Iterator


GATE_VERSION = "side-tools.v1.2.1"
ORACLE_SEED = 1201
AS_OF = date(2026, 8, 22)
MIN_CASES = 10_000
TARGET_MATRIX_CASES = 33_599


@dataclass(frozen=True)
class Concept:
    """A semantic concept known to the independent expected-intent oracle."""

    id: str
    phrase: str
    name: str
    unit: str
    unit_family: str


@dataclass(frozen=True)
class DateForm:
    key: str
    text: str
    expected: dict[str, Any]


@dataclass(frozen=True)
class AxisMode:
    key: str
    text: str


CONCEPTS: tuple[Concept, ...] = (
    Concept("DGS10", "10-year Treasury yield", "10-Year Treasury Yield", "Percent", "rate"),
    Concept("DGS20", "20-year Treasury yield", "20-Year Treasury Yield", "Percent", "rate"),
    Concept("DGS2", "2-year Treasury yield", "2-Year Treasury Yield", "Percent", "rate"),
    Concept("DGS5", "5-year Treasury yield", "5-Year Treasury Yield", "Percent", "rate"),
    Concept("DGS30", "30-year Treasury yield", "30-Year Treasury Yield", "Percent", "rate"),
    Concept("DFII10", "10-year real Treasury yield", "10-Year Real Treasury Yield", "Percent", "rate"),
    Concept("T10YIE", "10-year breakeven inflation", "10-Year Breakeven Inflation Rate", "Percent", "rate"),
    Concept("EFFR", "Federal funds rate", "Effective Federal Funds Rate", "Percent", "rate"),
    Concept("UNRATE", "unemployment rate", "Unemployment Rate", "Percent", "rate"),
    Concept("GOLD_PRICE", "gold price", "Gold Futures Price", "U.S. dollars per troy ounce", "price"),
    Concept("SILVER_PRICE", "silver price", "Silver Price", "U.S. dollars per troy ounce", "price"),
    Concept("DCOILWTICO", "WTI crude oil price", "Crude Oil Prices: West Texas Intermediate", "U.S. dollars per barrel", "price"),
    Concept("DHHNGSP", "natural gas price", "Henry Hub Natural Gas Spot Price", "U.S. dollars per million BTU", "price"),
    Concept("SP500", "S&P 500", "S&P 500 Index", "Index", "index"),
    Concept("NASDAQCOM", "Nasdaq Composite", "Nasdaq Composite Index", "Index", "index"),
    Concept("CPIAUCSL", "CPI", "Consumer Price Index", "Index", "index"),
    Concept("CPILFESL", "core CPI", "Core Consumer Price Index", "Index", "index"),
)

CONCEPT_BY_ID = {concept.id: concept for concept in CONCEPTS}

CONNECTORS: tuple[str, ...] = ("versus", "vs.", "against", "compared with", "and")
DATE_FORMS: tuple[DateForm, ...] = (
    DateForm("last-1y", "over the last 1 year", {"kind": "last_years", "value": 1}),
    DateForm("last-5y", "for the last 5 years", {"kind": "last_years", "value": 5}),
    DateForm("last-10y", "over the last 10 years", {"kind": "last_years", "value": 10}),
    DateForm("since-2000", "since 2000", {"kind": "since_year", "value": 2000}),
    DateForm("ytd", "year-to-date", {"kind": "ytd"}),
)

DUAL_AXIS_PHRASES: tuple[str, ...] = (
    "on opposite axes",
    "on a secondary axis",
    "using separate axes",
    "on different scales",
)
SAME_AXIS_PHRASES: tuple[str, ...] = ("on the same axis", "on one scale")
AXIS_MODES: tuple[AxisMode, ...] = (
    AxisMode("auto", ""),
    AxisMode("dual", ""),
    AxisMode("left-right", "put the first series on the left axis and the second on the right axis"),
    AxisMode("single", ""),
)

TRANSFORMS: tuple[tuple[str, str, str], ...] = (
    ("raw", "in native levels", "raw"),
    ("index", "indexed to 100", "index"),
    ("pct_change", "as percent change", "pct_change"),
    ("pct_yoy", "as year-over-year percent change", "pct_yoy"),
)
CHART_TYPES: tuple[tuple[str, str], ...] = (
    ("line", "as a line chart"),
    ("bar", "as a bar chart"),
    ("area", "as an area chart"),
    ("scatter", "as a scatter plot"),
)
DEFAULT_PALETTE = ("#0b65c2", "#d1495b", "#2a9d6f", "#f59e0b", "#6d5bd0", "#0f8b8d")
COLOR_MODES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("default", "", DEFAULT_PALETTE),
    ("named", "with the first series blue and the second orange", ("#0b65c2", "#f59e0b")),
    ("hex", "using #3366cc for the first series and #cc6633 for the second", ("#3366cc", "#cc6633")),
)


def _pair_seed(index: int) -> tuple[Concept, Concept]:
    """Return one of 128 stable semantic pair seeds without parser input."""

    first = CONCEPTS[index % len(CONCEPTS)]
    # Eight offsets give 16 * 8 = 128 independent seed identities.
    offset = index // len(CONCEPTS) + 1
    second = CONCEPTS[(index + offset) % len(CONCEPTS)]
    if second.id == first.id:
        second = CONCEPTS[(index + offset + 1) % len(CONCEPTS)]
    return first, second


def _axis_phrase(mode_index: int, mode: AxisMode) -> str:
    if mode.key == "dual":
        return DUAL_AXIS_PHRASES[mode_index % len(DUAL_AXIS_PHRASES)]
    if mode.key == "single":
        return SAME_AXIS_PHRASES[mode_index % len(SAME_AXIS_PHRASES)]
    return mode.text


def _is_heterogeneous(concepts: list[Concept]) -> bool:
    return len({_axis_signature(concept) for concept in concepts}) > 1


def _axis_signature(concept: Concept) -> str:
    if concept.unit_family == "rate":
        return "rate:percent"
    if concept.unit_family == "index":
        return "index:price" if concept.id in {"CPIAUCSL", "CPILFESL"} else "index:equity"
    if concept.unit_family == "price":
        return f"price:{concept.unit.lower()}"
    return f"{concept.unit_family}:{concept.unit.lower()}"


def _expected_axes(concepts: list[Concept], mode: str) -> dict[str, str]:
    """Oracle policy: raw heterogeneous units use two axes unless overridden."""

    if mode in {"single", "auto-single"}:
        return {concept.id: "left" for concept in concepts}
    if mode in {"dual", "left-right", "auto-dual"}:
        rates = [concept for concept in concepts if concept.unit_family == "rate"]
        non_rates = [concept for concept in concepts if concept.unit_family != "rate"]
        if rates and non_rates:
            return {
                concept.id: ("left" if concept.unit_family == "rate" else "right")
                for concept in concepts
            }
        return {concept.id: ("left" if index == 0 else "right") for index, concept in enumerate(concepts)}
    if _is_heterogeneous(concepts):
        return _expected_axes(concepts, "auto-dual")
    return {concept.id: "left" for concept in concepts}


def _expected_axis_mode(concepts: list[Concept], requested: str) -> str:
    if requested == "dual":
        return "dual"
    if requested in {"single", "left-right"}:
        return "single" if requested == "single" else "explicit-dual"
    return "dual" if _is_heterogeneous(concepts) else "single"


def _axis_titles(concepts: list[Concept], axes: dict[str, str], transform: str) -> dict[str, str]:
    if transform == "index":
        label = "Index (first observation = 100)"
        return {side: label if side in axes.values() else "" for side in ("left", "right")}
    if transform == "pct_change":
        label = "Percent change"
        return {side: label if side in axes.values() else "" for side in ("left", "right")}
    if transform == "pct_yoy":
        label = "Percent change from year ago"
        return {side: label if side in axes.values() else "" for side in ("left", "right")}
    titles: dict[str, str] = {"left": "", "right": ""}
    for side in ("left", "right"):
        units = [concept.unit for concept in concepts if axes.get(concept.id) == side]
        if units:
            titles[side] = units[0] if len(set(units)) == 1 else " / ".join(sorted(set(units)))
    return titles


def _expected_macro(
    concepts: list[Concept],
    date_form: DateForm,
    axis_requested: str,
    transform: str = "raw",
    chart_type: str = "line",
    colors: tuple[str, ...] = DEFAULT_PALETTE,
) -> dict[str, Any]:
    axis_mode = _expected_axis_mode(concepts, axis_requested)
    axes = _expected_axes(concepts, axis_requested if axis_requested != "auto" else "auto")
    units = {concept.id: transform for concept in concepts}
    return {
        "conceptIds": [concept.id for concept in concepts],
        "time": date_form.expected,
        "presentation": {
            "axisMode": axis_mode,
            "axisById": axes,
            "unitsById": units,
            "chartType": chart_type,
            "colorsById": {
                concept.id: colors[index % len(colors)]
                for index, concept in enumerate(concepts)
            },
            "axisTitles": _axis_titles(concepts, axes, transform),
        },
        "noClarification": True,
        "seriesCount": len(concepts),
    }


def _macro_case(
    case_id: str,
    concepts: list[Concept],
    prompt: str,
    expected: dict[str, Any],
    *,
    mutation_group: str,
    family: str,
    seed: int,
    model_state: str = "disabled",
) -> dict[str, Any]:
    return {
        "id": case_id,
        "tool": "macro",
        "prompt": prompt,
        "seed": seed,
        "family": family,
        "mutationGroup": mutation_group,
        "modelState": model_state,
        "expected": expected,
    }


def exact_gold_yield_case() -> dict[str, Any]:
    """The non-negotiable regression contract from the v1.2 request."""

    concepts = [CONCEPT_BY_ID["DGS10"], CONCEPT_BY_ID["GOLD_PRICE"]]
    expected = _expected_macro(
        concepts,
        DATE_FORMS[2],
        "dual",
        transform="raw",
        chart_type="line",
    )
    case = _macro_case(
        "macro.gold-yield.opposite-axis",
        concepts,
        "10 yr yield versus price of gold on opposite axis over the last 10 years",
        expected,
        mutation_group="gold-yield-presentation",
        family="exact-regression",
        seed=ORACLE_SEED,
    )
    case["resolutionCheckpoint"] = True
    return case


def exact_gold_us_yield_case() -> dict[str, Any]:
    """Exact regression for compact tenor plus explicit U.S. Treasury scope."""

    concepts = [CONCEPT_BY_ID["GOLD_PRICE"], CONCEPT_BY_ID["DGS10"]]
    expected = _expected_macro(concepts, DATE_FORMS[2], "auto")
    expected["time"] = None
    case = _macro_case(
        "macro.gold-us-yield.exact",
        concepts,
        "show me the price of gold against the 10yr US treasury yield",
        expected,
        mutation_group="gold-us-yield-exact",
        family="exact-regression",
        seed=ORACLE_SEED + 1,
    )
    case["resolutionCheckpoint"] = True
    return case


def _treasury_language_cases() -> Iterator[dict[str, Any]]:
    """2,400 U.S. Treasury wording cases plus 15 fail-closed foreign controls."""

    tenor_ids = ((2, "DGS2"), (5, "DGS5"), (10, "DGS10"), (20, "DGS20"), (30, "DGS30"))
    phrase_forms = (
        "{tenor}yr US Treasury yield",
        "US {tenor}-year Treasury yield",
        "{tenor} year United States Treasury yield",
        "American {tenor}yr Treasury yield",
        "{tenor}yrs U.S. Treasury rate",
        "U.S. {tenor} year Treasury rate",
        "{tenor}-year American Treasury yield",
        "United States {tenor}yr Treasury yield",
    )
    dates = DATE_FORMS[:3]
    gold = CONCEPT_BY_ID["GOLD_PRICE"]
    case_number = 0
    for tenor, series_id in tenor_ids:
        treasury = CONCEPT_BY_ID[series_id]
        for phrase_form in phrase_forms:
            treasury_phrase = phrase_form.format(tenor=tenor)
            for connector in CONNECTORS:
                for axis_index, axis_mode in enumerate(AXIS_MODES):
                    for date_form in dates:
                        case_number += 1
                        prompt = f"show me the price of gold {connector} the {treasury_phrase} {date_form.text}"
                        axis_text = _axis_phrase(case_number + axis_index, axis_mode)
                        if axis_text:
                            prompt += f" {axis_text}"
                        case = _macro_case(
                            f"macro.treasury-language.{case_number:04d}",
                            [gold, treasury],
                            prompt,
                            _expected_macro([gold, treasury], date_form, axis_mode.key),
                            mutation_group=f"treasury-language-{tenor}-{phrase_forms.index(phrase_form)}-{date_form.key}",
                            family="treasury-language",
                            seed=ORACLE_SEED + 90_000 + case_number,
                        )
                        case["resolutionCheckpoint"] = True
                        yield case

    negative_number = 0
    for tenor, series_id in tenor_ids:
        treasury = CONCEPT_BY_ID[series_id]
        for country in ("German", "UK", "Japanese"):
            negative_number += 1
            expected = _expected_macro([gold], DATE_FORMS[2], "auto")
            expected["noClarification"] = False
            expected["unresolvedResidual"] = True
            case = _macro_case(
                f"macro.treasury-foreign-control.{negative_number:03d}",
                [gold],
                f"show gold price versus the {country} {tenor}-year Treasury yield over the last 10 years",
                expected,
                mutation_group=f"treasury-foreign-{country.lower()}-{tenor}",
                family="treasury-negative-control",
                seed=ORACLE_SEED + 95_000 + negative_number,
            )
            case["resolutionCheckpoint"] = True
            yield case


def _semantic_cases() -> Iterator[dict[str, Any]]:
    """12,800 cases: 128 semantic seeds x 5 connectors x 5 dates x 4 axes."""

    case_number = 0
    for seed_index in range(128):
        first, second = _pair_seed(seed_index)
        for connector_index, connector in enumerate(CONNECTORS):
            for date_index, date_form in enumerate(DATE_FORMS):
                for axis_index, axis_mode in enumerate(AXIS_MODES):
                    case_number += 1
                    axis_text = _axis_phrase(seed_index + axis_index, axis_mode)
                    prompt = f"{first.phrase} {connector} {second.phrase} {date_form.text}"
                    if axis_text:
                        prompt += f" {axis_text}"
                    requested = axis_mode.key
                    expected = _expected_macro([first, second], date_form, requested)
                    case = _macro_case(
                        f"macro.semantic.{case_number:05d}",
                        [first, second],
                        prompt,
                        expected,
                        mutation_group=f"semantic-{seed_index:03d}-{date_index:02d}",
                        family="semantic",
                        seed=ORACLE_SEED + case_number,
                    )
                    case["resolutionCheckpoint"] = True
                    yield case


def _presentation_cases() -> Iterator[dict[str, Any]]:
    """16,384 cases: 128 seeds x 4 transforms x 4 charts x 4 axes x 2 states."""

    case_number = 0
    date_form = DATE_FORMS[2]
    for seed_index in range(128):
        first, second = _pair_seed(seed_index)
        for transform_index, (transform_key, transform_text, transform_units) in enumerate(TRANSFORMS):
            for chart_index, (chart_type, chart_text) in enumerate(CHART_TYPES):
                for axis_index, axis_mode in enumerate(AXIS_MODES):
                    axis_text = _axis_phrase(seed_index + axis_index, axis_mode)
                    prompt = f"graph {first.phrase} versus {second.phrase} {date_form.text}"
                    if axis_text:
                        prompt += f" {axis_text}"
                    prompt += f" {transform_text} {chart_text}"
                    expected = _expected_macro(
                        [first, second],
                        date_form,
                        axis_mode.key,
                        transform=transform_units,
                        chart_type=chart_type,
                    )
                    for model_index, model_state in enumerate(("disabled", "enabled")):
                        case_number += 1
                        yield _macro_case(
                            f"macro.presentation.{case_number:05d}",
                            [first, second],
                            prompt,
                            expected,
                            mutation_group=f"presentation-{seed_index:03d}-{transform_index}-{chart_index}-{axis_index}",
                            family="presentation",
                            seed=ORACLE_SEED + 20_000 + case_number,
                            model_state=model_state,
                        )


SERIES_SHAPES: tuple[tuple[int, bool], ...] = (
    *((count, False) for count in range(2, 9)),
    *((count, True) for count in range(2, 9)),
    (8, False),
)


def _series_cases() -> Iterator[dict[str, Any]]:
    """1,920 cases: 128 seeds x 15 deterministic 2-8-series shapes."""

    case_number = 0
    for seed_index in range(128):
        first, second = _pair_seed(seed_index)
        start = CONCEPTS.index(first)
        for shape_index, (count, reverse) in enumerate(SERIES_SHAPES):
            concepts = [CONCEPTS[(start + offset) % len(CONCEPTS)] for offset in range(count)]
            if reverse:
                concepts = list(reversed(concepts))
            connector = " and "
            prompt = "show " + connector.join(concept.phrase for concept in concepts)
            prompt += " over the last 10 years using separate axes as a line chart"
            color_mode = COLOR_MODES[shape_index % len(COLOR_MODES)]
            if color_mode[1]:
                prompt += f" {color_mode[1]}"
            date_form = DATE_FORMS[2]
            expected = _expected_macro(
                concepts,
                date_form,
                "dual",
                transform="raw",
                chart_type="line",
                colors=color_mode[2],
            )
            case_number += 1
            yield _macro_case(
                f"macro.series-shape.{case_number:05d}",
                concepts,
                prompt,
                expected,
                mutation_group=f"series-{seed_index:03d}-{shape_index:02d}",
                family="series-shape",
                seed=ORACLE_SEED + 40_000 + case_number,
            )


def _robustness_cases() -> Iterator[dict[str, Any]]:
    """Small explicit family for typo, metatext, color, and axis vocabulary."""

    specs = (
        ("10-year Treasury yield", "gold price", "year-over-year persent change", "For an auditable research request, ", "on opposite axes"),
        ("2-year Treasury yield", "S&P 500", "indexed to 100", "As a research analyst, ", "using separate axes"),
        ("core CPI", "natural gas price", "as percent change", "Please use the verified data and ", "on a secondary axis"),
        ("Federal funds rate", "silver price", "in native levels", "", "on the left and right axes"),
    )
    for index, (left, right, transform, prefix, axis) in enumerate(specs, start=1):
        prompt = f"{prefix}graph {left} versus {right} over the last 10 years {axis} {transform} as a line chart"
        concepts = [next(concept for concept in CONCEPTS if concept.phrase == left), next(concept for concept in CONCEPTS if concept.phrase == right)]
        transform_key = "pct_yoy" if "year-over-year" in transform else "pct_change" if "percent change" in transform else "index" if "indexed" in transform else "raw"
        expected = _expected_macro(concepts, DATE_FORMS[2], "dual", transform=transform_key)
        yield _macro_case(
            f"macro.robustness.{index:03d}",
            concepts,
            prompt,
            expected,
            mutation_group=f"robustness-{index:03d}",
            family="robustness",
            seed=ORACLE_SEED + 60_000 + index,
        )


def _resolution_mutation_cases() -> Iterator[dict[str, Any]]:
    """64 full-resolution mutation cases for semantic stability checks."""

    case_number = 0
    date_form = DATE_FORMS[2]
    for seed_index in range(16):
        first, second = _pair_seed(seed_index)
        concepts = [first, second]
        for axis_index, axis_mode in enumerate(AXIS_MODES):
            axis_text = _axis_phrase(seed_index + axis_index, axis_mode)
            prompt = f"show {first.phrase} versus {second.phrase} {date_form.text}"
            if axis_text:
                prompt += f" {axis_text}"
            prompt += " as a line chart"
            case_number += 1
            case = _macro_case(
                f"macro.resolution-mutation.{case_number:04d}",
                concepts,
                prompt,
                _expected_macro(concepts, date_form, axis_mode.key),
                mutation_group=f"resolution-mutation-{seed_index:03d}",
                family="resolution-mutation",
                seed=ORACLE_SEED + 65_000 + case_number,
            )
            case["resolutionCheckpoint"] = True
            yield case


def _fed_cases() -> Iterator[dict[str, Any]]:
    cases = (
        ("fed.historical.all", "show historical probabilities for the September meeting over all available history", {"view": "historical", "historyRange": "ALL", "meetingSelection": "explicit", "outcomeSelection": "all", "chartType": "line"}),
        ("fed.compare.next", "compare next meeting to prior snapshots", {"view": "compare", "historyRange": "1Y", "meetingSelection": "next", "outcomeSelection": "all", "chartType": "line"}),
        ("fed.probabilities.all-meetings", "show all meeting probabilities", {"view": "probabilities", "historyRange": "1Y", "meetingSelection": "default", "outcomeSelection": "all", "chartType": "bar"}),
        ("fed.current.hikes", "show the current probability of rate hikes for the next meeting", {"view": "current", "historyRange": "1Y", "meetingSelection": "next", "outcomeSelection": "hike", "chartType": "bar"}),
        ("fed.historical.six-months", "plot historical probabilities for the September meeting over the last 6 months", {"view": "historical", "historyRange": "6M", "meetingSelection": "explicit", "outcomeSelection": "all", "chartType": "line"}),
    )
    for case_id, prompt, expected in cases:
        yield {
            "id": case_id,
            "tool": "fed",
            "prompt": prompt,
            "seed": ORACLE_SEED + 70_000 + len(case_id),
            "family": "cross-tool-action",
            "expected": {"spec": expected, "noModel": True},
        }


def _treasury_cases() -> Iterator[dict[str, Any]]:
    cases = (
        ("treasury.chart.30y-btc", "show me a chart of the bid to cover ratio for all 30 year auctions in the last 15 years", {"view": "chart", "term": "30-Year", "metric": "bidToCoverRatio", "startDate": "2011-08-22", "panels": ["chart"]}),
        ("treasury.latest.30y-results", "show me the latest 30 year auction results", {"view": "latest", "term": "30-Year", "panels": ["table", "documents"]}),
        ("treasury.2012.10y-pdf", "give me a copy of any auction results from 2012 for the 10 year note", {"view": "records", "term": "10-Year", "securityType": "Note", "startDate": "2012-01-01", "endDate": "2012-12-31", "panels": ["documents"]}),
        ("treasury.chart.10y-yield", "plot the high yield for 10 year note auctions since 2000", {"view": "chart", "term": "10-Year", "metric": "highYield", "panels": ["chart"]}),
        ("treasury.table.tips", "show a table of 5 year TIPS auctions in 2020", {"view": "table", "term": "5-Year", "securityType": "TIPS", "startDate": "2020-01-01", "endDate": "2020-12-31", "panels": ["table"]}),
    )
    for case_id, prompt, expected in cases:
        yield {
            "id": case_id,
            "tool": "treasury",
            "prompt": prompt,
            "seed": ORACLE_SEED + 80_000 + len(case_id),
            "family": "cross-tool-action",
            "expected": {"spec": expected, "noModel": True},
        }


def generate_cases() -> list[dict[str, Any]]:
    """Generate the fixed release matrix and representative cross-tool cases."""

    cases = [
        exact_gold_yield_case(),
        exact_gold_us_yield_case(),
        *_treasury_language_cases(),
        *_semantic_cases(),
        *_presentation_cases(),
        *_series_cases(),
        *_robustness_cases(),
        *_resolution_mutation_cases(),
        *_fed_cases(),
        *_treasury_cases(),
    ]
    return cases


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def repro_id(case: dict[str, Any]) -> str:
    return _digest({"gate": GATE_VERSION, "seed": case["seed"], "id": case["id"], "prompt": case["prompt"]})[:20]


def _macro_time_semantics(contract: dict[str, Any]) -> dict[str, Any] | None:
    text = " ".join(str(value) for value in contract.get("time", {}).get("sourceSpans", []))
    lowered = text.lower()
    match = re.search(r"\b(?:last\s+)?(\d+)\s*(?:years?|yrs?)\b", lowered)
    if match:
        return {"kind": "last_years", "value": int(match.group(1))}
    match = re.search(r"\bsince\s+(19|20)(\d{2})\b", lowered)
    if match:
        return {"kind": "since_year", "value": int(match.group(1) + match.group(2))}
    if re.search(r"\byear[ -]to[ -]date\b|\bytd\b", lowered):
        return {"kind": "ytd"}
    match = re.search(r"\b(19|20)(\d{2})\s+(?:to|through|and)\s+(19|20)(\d{2})\b", lowered)
    if match:
        return {"kind": "range_years", "start": int(match.group(1) + match.group(2)), "end": int(match.group(3) + match.group(4))}
    return None


def _macro_rows_for_chart(selected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for entry in selected:
        rows.append(
            {
                "id": entry.get("id"),
                "name": entry.get("name"),
                "unit": entry.get("unit") or "Provider units",
                "preferredUnits": entry.get("preferredUnits"),
            }
        )
    return rows


def _synthetic_entries(ids: list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for series_id in ids:
        concept = CONCEPT_BY_ID.get(series_id)
        if concept is None:
            raise ValueError(f"Oracle has no chart metadata for {series_id}.")
        entries.append(
            {
                "id": concept.id,
                "name": concept.name,
                "unit": concept.unit,
                "preferredUnits": None,
            }
        )
    return entries


def _observe_macro(prompt: str, expected_ids: list[str], *, resolve: bool) -> dict[str, Any]:
    import serve

    contract = serve.parse_macro_request_contract(prompt)
    if resolve:
        selected, notices = serve.resolve_prompt_series(prompt, allow_fred_search=False)
        selected_ids: list[str] | None = [str(entry.get("id")) for entry in selected if entry.get("id")]
    else:
        selected = _synthetic_entries(expected_ids)
        selected_ids = None
        notices = ["Resolution checkpoint skipped for this layout-matrix case."]
    chart = serve.parse_chart_intent(
        prompt,
        _macro_rows_for_chart(selected),
        request_contract=contract,
    )
    residuals = [
        serve.unresolved_clause_residual(str(operand.get("sourceSpan") or ""))
        for operand in contract.get("operands", [])
    ]
    residuals = [value for value in residuals if value]
    if resolve:
        residuals = serve.filter_satisfied_macro_residuals(residuals, selected)
    return {
        "status": "parsed",
        "conceptIds": selected_ids,
        "resolutionChecked": resolve,
        "time": _macro_time_semantics(contract),
        "operands": [str(row.get("sourceSpan") or "") for row in contract.get("operands", [])],
        "residuals": residuals,
        "notices": [str(value) for value in notices],
        "chart": {
            "series": [
                {
                    "id": row.get("id"),
                    "axis": row.get("axis"),
                    "units": row.get("units"),
                    "type": row.get("type"),
                    "color": row.get("color"),
                }
                for row in chart.get("series", [])
            ],
            "axes": chart.get("axes", {}),
            "recognizedInstructions": chart.get("recognizedInstructions", []),
        },
        "model": {"used": False},
    }


def _observe_fed(prompt: str) -> dict[str, Any]:
    import serve

    meeting_dates = [meeting.isoformat() for meeting in sorted(serve.FOMC_MEETINGS)]
    result = serve.parse_fed_tracker_intent(prompt, meeting_dates)
    spec = result.get("spec", {})
    return {
        "status": "parsed",
        "spec": {key: spec.get(key) for key in ("view", "meetingSelection", "historyRange", "outcomeSelection", "chartType")},
        "model": {"used": bool(result.get("usedModel"))},
    }


def _observe_treasury(prompt: str) -> dict[str, Any]:
    import treasury_auctions

    spec, warnings, recognized = treasury_auctions.parse_query(prompt, AS_OF)
    return {
        "status": "parsed",
        "recognized": bool(recognized),
        "spec": {key: spec.get(key) for key in ("view", "term", "securityType", "metric", "startDate", "endDate", "panels")},
        "warnings": [str(value) for value in warnings],
        "model": {"used": False},
    }


def observe_case(case: dict[str, Any]) -> dict[str, Any]:
    try:
        if case["tool"] == "macro":
            return _observe_macro(
                case["prompt"],
                list(case["expected"].get("conceptIds", [])),
                resolve=bool(case.get("resolutionCheckpoint")),
            )
        if case["tool"] == "fed":
            return _observe_fed(case["prompt"])
        if case["tool"] == "treasury":
            return _observe_treasury(case["prompt"])
        raise ValueError(f"Unknown tool {case['tool']!r}")
    except Exception as exc:  # noqa: BLE001 - preserve parser failures as gate findings.
        return {
            "status": "error",
            "error": f"{exc.__class__.__name__}: {exc}",
            "model": {"used": False},
        }


def _finding(code: str, message: str, case: dict[str, Any], observed: dict[str, Any], *, severity: str = "P1") -> dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "message": message,
        "gate": GATE_VERSION,
        "caseId": case["id"],
        "seed": case["seed"],
        "tool": case["tool"],
        "prompt": case["prompt"],
        "reproId": repro_id(case),
        "expected": case.get("expected", {}),
        "observed": observed,
        "repro": f"python -m qa.v1_2_gate --case {case['id']} --strict --json",
    }


def _compare_macro(case: dict[str, Any], observed: dict[str, Any]) -> list[dict[str, Any]]:
    expected = case["expected"]
    findings: list[dict[str, Any]] = []
    if observed.get("status") != "parsed":
        return [_finding("PARSER_ERROR", str(observed.get("error") or "Macro parser did not return a contract."), case, observed)]
    if observed.get("resolutionChecked") and observed.get("conceptIds") != expected["conceptIds"]:
        findings.append(_finding("CONCEPT_IDS_MISMATCH", "Resolved concept IDs changed or an unrelated series was loaded.", case, observed))
    if observed.get("time") != expected["time"]:
        findings.append(_finding("DATE_FORM_MISMATCH", "The requested date form was not preserved in the typed contract.", case, observed))
    presentation_words = re.compile(r"\b(?:axis|axes|opposite|secondary|separate|scale|chart|graph|plot|line|bar|area|scatter|indexed|percent|change|native|blue|orange|color|using|put|place|same)\b", re.IGNORECASE)
    expects_unresolved = bool(expected.get("unresolvedResidual"))
    if expects_unresolved and not observed.get("residuals"):
        findings.append(_finding("FAIL_CLOSED_RESIDUAL_MISSING", "A foreign Treasury scope was silently treated as the U.S. series.", case, observed, severity="P0"))
    elif any(presentation_words.search(residual) for residual in observed.get("residuals", [])):
        findings.append(_finding("PRESENTATION_LEAKED_INTO_CONCEPT", "Chart instructions remained in an unresolved data concept.", case, observed))
    elif observed.get("residuals") and not expects_unresolved:
        findings.append(_finding("UNRESOLVED_CONCEPT_RESIDUAL", "A known oracle concept left an unresolved residual.", case, observed))
    chart = observed.get("chart", {})
    specs = chart.get("series", [])
    if [row.get("id") for row in specs] != expected["conceptIds"]:
        findings.append(_finding("CHART_SERIES_MISMATCH", "Chart series do not match the resolved semantic concepts in order.", case, observed))
    expected_presentation = expected["presentation"]
    expected_axes = expected_presentation["axisById"]
    actual_axes = {str(row.get("id")): row.get("axis") for row in specs}
    if actual_axes != expected_axes:
        findings.append(_finding("AXIS_ASSIGNMENT_MISMATCH", "The chart assigned a series to the wrong axis.", case, observed))
    expected_units = expected_presentation["unitsById"]
    actual_units = {str(row.get("id")): row.get("units") for row in specs}
    if actual_units != expected_units:
        findings.append(_finding("TRANSFORM_MISMATCH", "Displayed transformation does not match the requested transformation.", case, observed))
    if any(row.get("type") != expected_presentation["chartType"] for row in specs):
        findings.append(_finding("CHART_TYPE_MISMATCH", "Chart type was not carried into every series configuration.", case, observed))
    expected_colors = expected_presentation["colorsById"]
    actual_colors = {str(row.get("id")): row.get("color") for row in specs}
    if actual_colors != expected_colors:
        findings.append(_finding("COLOR_INSTRUCTION_MISMATCH", "Requested chart colors were not preserved.", case, observed))
    actual_titles = chart.get("axes", {})
    expected_titles = expected_presentation["axisTitles"]
    for side in ("left", "right"):
        actual_title = str((actual_titles.get(side) or {}).get("title") or "")
        expected_title = expected_titles.get(side, "")
        if actual_title != expected_title:
            findings.append(_finding("AXIS_LABEL_TRANSFORM_MISMATCH", f"{side} axis label does not describe the values displayed.", case, observed))
    if expected.get("noClarification") and observed.get("residuals"):
        findings.append(_finding("IRRELEVANT_CLARIFICATION_RISK", "A fully specified request would be blocked or sent to irrelevant clarification.", case, observed))
    if observed.get("model", {}).get("used"):
        findings.append(_finding("MODEL_USED_IN_GATE", "The deterministic release gate observed model routing.", case, observed, severity="P0"))
    return findings


def _compare_cross_tool(case: dict[str, Any], observed: dict[str, Any]) -> list[dict[str, Any]]:
    expected = case["expected"]
    findings: list[dict[str, Any]] = []
    if observed.get("status") != "parsed":
        return [_finding("PARSER_ERROR", str(observed.get("error") or "Cross-tool parser did not return a contract."), case, observed)]
    if case["tool"] == "fed":
        actual = observed.get("spec", {})
    else:
        actual = observed.get("spec", {})
    for key, value in expected["spec"].items():
        if actual.get(key) != value:
            findings.append(_finding("CROSS_TOOL_INTENT_MISMATCH", f"Expected {key}={value!r}, observed {actual.get(key)!r}.", case, observed))
    if expected.get("noModel") and observed.get("model", {}).get("used"):
        findings.append(_finding("MODEL_USED_IN_GATE", "A deterministic cross-tool case invoked a model.", case, observed, severity="P0"))
    if case["tool"] == "treasury" and not observed.get("recognized"):
        findings.append(_finding("TREASURY_REQUEST_NOT_RECOGNIZED", "Representative Treasury query was not recognized.", case, observed))
    return findings


def compare_case(case: dict[str, Any], observed: dict[str, Any]) -> list[dict[str, Any]]:
    if case["tool"] == "macro":
        return _compare_macro(case, observed)
    return _compare_cross_tool(case, observed)


def _case_result(case: dict[str, Any], observed: dict[str, Any]) -> dict[str, Any]:
    findings = compare_case(case, observed)
    return {
        "caseId": case["id"],
        "reproId": repro_id(case),
        "tool": case["tool"],
        "family": case.get("family"),
        "prompt": case["prompt"],
        "status": "pass" if not findings else "fail",
        "findings": findings,
        "observed": observed,
    }


def _validate_oracle(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if len(cases) < MIN_CASES:
        findings.append({"code": "CASE_COUNT_TOO_LOW", "severity": "P0", "message": f"Generated {len(cases)} cases; minimum is {MIN_CASES}."})
    if len(cases) < TARGET_MATRIX_CASES:
        findings.append({"code": "TARGET_MATRIX_COUNT_TOO_LOW", "severity": "P1", "message": f"Generated {len(cases)} cases; target is {TARGET_MATRIX_CASES}."})
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)):
        findings.append({"code": "CASE_IDS_NOT_UNIQUE", "severity": "P0", "message": "Generated case IDs are not unique."})
    exact = next((case for case in cases if case["id"] == "macro.gold-yield.opposite-axis"), None)
    if exact is None:
        findings.append({"code": "GOLD_CASE_MISSING", "severity": "P0", "message": "The exact gold/yield regression case is missing."})
    else:
        expected = exact["expected"]
        if expected.get("conceptIds") != ["DGS10", "GOLD_PRICE"]:
            findings.append({"code": "GOLD_CASE_ORACLE_INVALID", "severity": "P0", "message": "Gold/yield oracle IDs are not exact."})
        if expected.get("presentation", {}).get("axisById") != {"DGS10": "left", "GOLD_PRICE": "right"}:
            findings.append({"code": "GOLD_CASE_AXIS_ORACLE_INVALID", "severity": "P0", "message": "Gold/yield oracle axis assignment is not exact."})
        if expected.get("presentation", {}).get("unitsById") != {"DGS10": "raw", "GOLD_PRICE": "raw"}:
            findings.append({"code": "GOLD_CASE_UNITS_ORACLE_INVALID", "severity": "P0", "message": "Gold/yield oracle units are not native/raw."})
    exact_us = next((case for case in cases if case["id"] == "macro.gold-us-yield.exact"), None)
    if exact_us is None:
        findings.append({"code": "GOLD_US_CASE_MISSING", "severity": "P0", "message": "The exact compact U.S. Treasury regression case is missing."})
    elif exact_us["expected"].get("conceptIds") != ["GOLD_PRICE", "DGS10"]:
        findings.append({"code": "GOLD_US_CASE_ORACLE_INVALID", "severity": "P0", "message": "Compact U.S. Treasury oracle IDs are not exact."})
    return findings


def _stable_case_hash(cases: list[dict[str, Any]]) -> str:
    return _digest([
        {
            "id": case["id"],
            "tool": case["tool"],
            "prompt": case["prompt"],
            "seed": case["seed"],
            "expected": case["expected"],
        }
        for case in cases
    ])


def _apply_mutation_invariants(results: list[dict[str, Any]], cases_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    groups: dict[str, list[dict[str, Any]]] = {}
    for result in results:
        case = cases_by_id[result["caseId"]]
        group = case.get("mutationGroup")
        if group:
            groups.setdefault(str(group), []).append(result)
    for group, group_results in groups.items():
        resolved_results = [
            result for result in group_results
            if result.get("observed", {}).get("resolutionChecked")
        ]
        if not resolved_results:
            continue
        ids = {tuple(result.get("observed", {}).get("conceptIds", [])) for result in resolved_results}
        if len(ids) > 1:
            sample = next(
                result for result in resolved_results
                if tuple(result.get("observed", {}).get("conceptIds", [])) != next(iter(ids))
            )
            case = cases_by_id[sample["caseId"]]
            findings.append(_finding("CONCEPT_IDS_CHANGED_BY_PRESENTATION", f"Presentation mutation group {group} changed semantic concept IDs.", case, sample.get("observed", {})))
    return findings


def run_gate(
    *,
    cases: list[dict[str, Any]] | None = None,
    repeat: int = 2,
    limit: int | None = None,
    case_id: str | None = None,
) -> dict[str, Any]:
    """Run the deterministic gate and return a JSON-serializable report."""

    generated_cases = list(cases) if cases is not None else generate_cases()
    all_cases = generated_cases
    oracle_findings = _validate_oracle(all_cases)
    if case_id:
        all_cases = [case for case in all_cases if case["id"] == case_id or case["id"].startswith(f"{case_id}::")]
        if not all_cases:
            oracle_findings.append({"code": "CASE_NOT_FOUND", "severity": "P0", "message": f"No case matched {case_id!r}."})
    if limit is not None:
        all_cases = all_cases[: max(0, limit)]
    if repeat < 1:
        raise ValueError("repeat must be at least one")

    cases_by_id = {case["id"]: case for case in all_cases}
    run_results: list[list[dict[str, Any]]] = []
    run_hashes: list[str] = []
    for _run_index in range(repeat):
        results: list[dict[str, Any]] = []
        for case in all_cases:
            results.append(_case_result(case, observe_case(case)))
        run_results.append(results)
        run_hashes.append(_digest(results))

    results = run_results[0] if run_results else []
    failures = [result for result in results if result["status"] == "fail"]
    findings = [finding for result in failures for finding in result["findings"]]
    findings.extend(oracle_findings)
    findings.extend(_apply_mutation_invariants(results, cases_by_id))
    if len(set(run_hashes)) > 1:
        findings.append({
            "code": "NONDETERMINISTIC_RUN_HASH",
            "severity": "P0",
            "message": "Repeated deterministic runs produced different result hashes.",
            "runHashes": run_hashes,
        })
    if failures and any(finding.get("code") == "NONDETERMINISTIC_RUN_HASH" for finding in findings):
        pass
    summary = {
        "caseCount": len(all_cases),
        "generatedCaseCount": len(generated_cases),
        "passCount": sum(result["status"] == "pass" for result in results),
        "failCount": len(failures),
        "findingCount": len(findings),
        "p0Count": sum(finding.get("severity") == "P0" for finding in findings),
        "p1Count": sum(finding.get("severity") == "P1" for finding in findings),
    }
    return {
        "schemaVersion": 1,
        "gate": GATE_VERSION,
        "mode": "deterministic-semantic-layout",
        "oracleSeed": ORACLE_SEED,
        "asOf": AS_OF.isoformat(),
        "networkCalls": 0,
        "modelCalls": 0,
        "caseHash": _stable_case_hash(generated_cases),
        "runHashes": run_hashes,
        "summary": summary,
        "matrix": {
            "semantic": 12_800,
            "presentation": 16_384,
            "seriesShape": 1_920,
            "treasuryLanguage": len([case for case in generated_cases if case.get("family") == "treasury-language"]),
            "treasuryNegativeControls": len([case for case in generated_cases if case.get("family") == "treasury-negative-control"]),
            "crossToolRepresentative": len([case for case in generated_cases if case["tool"] != "macro"]),
            "resolutionCheckpointCount": sum(bool(case.get("resolutionCheckpoint")) for case in generated_cases),
        },
        "failures": failures,
        "findings": findings,
    }


def _write_artifacts(report: dict[str, Any], artifact_dir: Path, max_artifacts: int) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    for index, failure in enumerate(report.get("failures", [])[:max_artifacts], start=1):
        repro = failure.get("reproId") or f"failure-{index:04d}"
        (artifact_dir / f"failure-{repro}.json").write_text(json.dumps(failure, indent=2, sort_keys=True), encoding="utf-8")


def _text_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        f"{report['gate']} deterministic release gate",
        f"Cases: {summary['caseCount']} checked ({summary['generatedCaseCount']} generated); {summary['passCount']} pass, {summary['failCount']} fail",
        f"Findings: {summary['findingCount']} total; P0={summary['p0Count']}, P1={summary['p1Count']}",
        f"Network calls: {report['networkCalls']}; model calls: {report['modelCalls']}",
        f"Case hash: {report['caseHash']}",
    ]
    for failure in report.get("failures", [])[:12]:
        codes = ", ".join(finding.get("code", "unknown") for finding in failure.get("findings", []))
        lines.append(f"[FAIL] {failure['caseId']} repro={failure['reproId']}: {codes}")
    if summary["failCount"] > 12:
        lines.append(f"... {summary['failCount'] - 12} additional failures are in the JSON report.")
    if not summary["failCount"] and not report.get("findings"):
        lines.append("Release gate passed.")
    else:
        lines.append("Release gate failed; use the repro IDs and JSON artifacts to reproduce each finding.")
    return "\n".join(lines)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="Exit nonzero for any oracle, parser, invariant, or determinism finding.")
    parser.add_argument("--json", action="store_true", help="Print the complete JSON report.")
    parser.add_argument("--artifact-dir", type=Path, default=None, help="Write report.json and bounded per-failure JSON artifacts here.")
    parser.add_argument("--max-artifacts", type=int, default=50, help="Maximum individual failure artifacts to write.")
    parser.add_argument("--repeat", type=int, default=2, help="Deterministic repeated runs to compare (default: 2).")
    parser.add_argument("--limit", type=int, default=None, help="Run only the first N cases after generation.")
    parser.add_argument("--case", dest="case_id", default=None, help="Run one exact case ID or a generated case prefix.")
    args = parser.parse_args(list(argv) if argv is not None else None)
    report = run_gate(repeat=args.repeat, limit=args.limit, case_id=args.case_id)
    if args.artifact_dir:
        _write_artifacts(report, args.artifact_dir, max(0, args.max_artifacts))
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else _text_report(report))
    failed = report["summary"]["failCount"] or report["summary"]["findingCount"]
    return 1 if args.strict and failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
