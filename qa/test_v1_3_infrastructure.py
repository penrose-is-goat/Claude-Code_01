"""Regression tests for v1.3 coverage, parsing, and browser scale infrastructure."""

from __future__ import annotations

import json
import subprocess
import unittest
from datetime import date
from pathlib import Path

import coverage_planner
import serve


APP_DIR = Path(__file__).resolve().parent.parent


class V13InfrastructureTests(unittest.TestCase):
    def test_gold_yield_presentation_does_not_become_an_operand(self):
        prompt = "10yr Treasury yield and price of gold over 30 years using separate left and right scales"
        contract = serve.parse_macro_request_contract(prompt)
        self.assertEqual(
            [row["sourceSpan"] for row in contract["operands"]],
            ["10yr treasury yield", "price of gold"],
        )
        self.assertEqual(contract["presentation"]["axis"]["mode"], "dual")

    def test_coverage_base_uses_one_monthly_cadence(self):
        base_rows = [
            {"date": "2024-01-31", "value": 100.0},
            {"date": "2024-02-29", "value": 110.0},
        ]
        primary_rows = [
            {"date": "2024-01-05", "value": 100.1},
            {"date": "2024-01-31", "value": 100.2},
            {"date": "2024-02-05", "value": 110.1},
            {"date": "2024-02-29", "value": 110.2},
            {"date": "2024-03-01", "value": 120.0},
            {"date": "2024-03-20", "value": 122.0},
        ]
        result = coverage_planner.compose_coverage_base(
            {"provider": "Primary", "providerSeries": "P", "observations": primary_rows},
            {
                "provider": "Base",
                "providerSeries": "B",
                "observations": base_rows,
                "lastDate": "2024-02-29",
                "frequency": "Monthly",
            },
            start=date(2024, 1, 1),
            end=date(2024, 3, 20),
            comparison={"status": "pass"},
            start_tolerance_days=45,
            end_tolerance_days=10,
        )
        self.assertEqual([row["date"] for row in result["observations"]], ["2024-01-31", "2024-02-29", "2024-03-20"])
        self.assertEqual(result["observations"][-1]["value"], 121.0)
        self.assertEqual(result["coveragePlan"]["continuationAggregation"], "monthly mean of primary observations")

    def test_exported_axis_gate(self):
        completed = subprocess.run(
            ["node", str(APP_DIR / "qa" / "v1_3_axis_gate.js")],
            cwd=APP_DIR,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        report = json.loads(completed.stdout)
        self.assertEqual(report["caseCount"], 10_000)
        self.assertEqual(report["failCount"], 0)

    def test_gold_and_yield_nice_ticks(self):
        script = (
            "const s=require('./chart-scale.js');"
            "const y=s.buildAxisScale([0.13,7.39],{}, {unit:'Percent'},500);"
            "const g=s.buildAxisScale([274,5640],{}, {unit:'U.S. dollars per troy ounce'},500);"
            "process.stdout.write(JSON.stringify({y,g}));"
        )
        completed = subprocess.run(
            ["node", "-e", script],
            cwd=APP_DIR,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        scales = json.loads(completed.stdout)
        self.assertEqual([tick["label"] for tick in scales["y"]["ticks"]], ["0%", "2%", "4%", "6%", "8%"])
        self.assertEqual([tick["label"] for tick in scales["g"]["ticks"]], ["$0", "$2,000", "$4,000", "$6,000"])


if __name__ == "__main__":
    unittest.main()
