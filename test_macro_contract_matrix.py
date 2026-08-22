from __future__ import annotations

import hashlib
import itertools
import json
import unittest

import serve


_BASE_PAIRS = (
    ("10-year Treasury yield", "gold price"),
    ("2-year Treasury yield", "S&P 500 index"),
    ("unemployment rate", "CPI"),
    ("federal funds rate", "national home price index"),
    ("PCE price index", "average hourly earnings"),
    ("silver price", "10-year Treasury yield"),
    ("real GDP", "M2 money supply"),
    ("VIX", "S&P 500 index"),
)
_CHART_TYPES = ("line chart", "bar chart", "area chart", "scatter plot")
_SEEDS = tuple((pair, chart) for pair in _BASE_PAIRS for chart in _CHART_TYPES)
_CONNECTORS = ("versus", "vs", "against", "compared with", "alongside")
_DURATIONS = (
    "over the last 5 years",
    "for the last 10 years",
    "since 2000",
    "from 2000 to 2020",
    "YTD",
)
_AXES = (
    "on opposite axis",
    "on secondary y-axis",
    "use dual axes",
    "on the same axis",
)
_TRANSFORMS = (
    "",
    "year-over-year percent change",
    "month-over-month percent change",
    "index to 100",
)


def _prompt(seed, connector: str, duration: str, axis: str, transform: str) -> str:
    (left, right), chart = seed
    parts = ["graph", left, connector, right, axis]
    if transform:
        parts.append(transform)
    parts.extend((duration, chart))
    return " ".join(parts)


def _run_gate() -> tuple[int, str]:
    rows = [
        {"id": "DGS10", "name": "10-Year Treasury Yield", "unit": "Percent"},
        {"id": "GOLD_PRICE", "name": "Gold Futures Price", "unit": "U.S. dollars per troy ounce"},
    ]
    results: list[dict[str, object]] = []
    cases = itertools.product(_SEEDS, _CONNECTORS, _DURATIONS, _AXES, _TRANSFORMS)
    for index, (seed, connector, duration, axis, transform) in enumerate(cases):
        prompt = _prompt(seed, connector, duration, axis, transform)
        contract = serve.parse_macro_request_contract(prompt)
        presentation = contract["presentation"]
        operands = contract["operands"]
        expected_axis = "single" if axis == "on the same axis" else "dual"
        expected_transform = (
            "raw" if not transform else "pct_yoy" if "year-over-year" in transform else "pct_change" if "month-over-month" in transform else "index"
        )
        expected_chart = {"line": "line", "bar": "bar", "area": "area", "scatter": "scatter"}[seed[1].split()[0]]
        if len(operands) != 2:
            raise AssertionError(f"case {index}: expected two operands: {prompt!r} -> {operands!r}")
        operand_text = " ".join(str(row["sourceSpan"]).lower() for row in operands)
        for forbidden in ("opposite axis", "secondary y-axis", "dual axes", "same axis", "chart", "plot"):
            if forbidden in operand_text:
                raise AssertionError(f"case {index}: presentation leaked into operands: {prompt!r}")
        if presentation["axis"]["mode"] != expected_axis:
            raise AssertionError(f"case {index}: axis mode mismatch for {prompt!r}")
        if presentation["transform"]["mode"] != expected_transform:
            raise AssertionError(f"case {index}: transform mismatch for {prompt!r}")
        if presentation["chartType"] != expected_chart:
            raise AssertionError(f"case {index}: chart type mismatch for {prompt!r}")
        if not contract["time"]["sourceSpans"]:
            raise AssertionError(f"case {index}: time phrase was not captured for {prompt!r}")
        config = serve.parse_chart_intent(prompt, rows, contract)
        axes = {row["id"]: row["axis"] for row in config["series"]}
        units = {row["units"] for row in config["series"]}
        if expected_axis == "dual" and set(axes.values()) != {"left", "right"}:
            raise AssertionError(f"case {index}: dual axis did not separate rows for {prompt!r}")
        if expected_axis == "single" and set(axes.values()) != {"left"}:
            raise AssertionError(f"case {index}: same axis did not keep rows together for {prompt!r}")
        if units != {expected_transform}:
            raise AssertionError(f"case {index}: plotted units mismatch for {prompt!r}: {units!r}")
        results.append(
            {
                "case": index,
                "ids": [row["sourceSpan"] for row in operands],
                "axis": presentation["axis"]["mode"],
                "transform": presentation["transform"]["mode"],
                "chart": presentation["chartType"],
                "seriesAxes": axes,
            }
        )
    encoded = json.dumps(results, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return len(results), hashlib.sha256(encoded).hexdigest()


class MacroContractMatrixTests(unittest.TestCase):
    def test_deterministic_semantic_layout_gate_exceeds_ten_thousand_cases(self):
        runs = [_run_gate() for _ in range(3)]
        self.assertEqual(runs[0][0], 12_800)
        self.assertEqual([run[0] for run in runs], [12_800, 12_800, 12_800])
        self.assertEqual(len({run[1] for run in runs}), 1)


if __name__ == "__main__":
    unittest.main()
