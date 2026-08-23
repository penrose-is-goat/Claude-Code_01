"""Unit tests for the independent Side Tools v1.2 release gate."""

from __future__ import annotations

import unittest

from qa.v1_2_gate import (
    MIN_CASES,
    TARGET_MATRIX_CASES,
    exact_gold_us_yield_case,
    exact_gold_yield_case,
    generate_cases,
    observe_case,
    repro_id,
    run_gate,
)


class V12OracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = generate_cases()

    def test_matrix_has_at_least_ten_thousand_cases_and_target_shape(self):
        self.assertGreaterEqual(len(self.cases), MIN_CASES)
        self.assertGreaterEqual(len(self.cases), TARGET_MATRIX_CASES)
        self.assertEqual(len({case["id"] for case in self.cases}), len(self.cases))
        self.assertGreaterEqual(
            sum(bool(case.get("resolutionCheckpoint")) for case in self.cases),
            15_000,
        )

    def test_exact_gold_yield_prompt_contract_is_independent_and_exact(self):
        case = exact_gold_yield_case()
        self.assertEqual(case["prompt"], "10 yr yield versus price of gold on opposite axis over the last 10 years")
        self.assertEqual(case["expected"]["conceptIds"], ["DGS10", "GOLD_PRICE"])
        self.assertEqual(case["expected"]["time"], {"kind": "last_years", "value": 10})
        presentation = case["expected"]["presentation"]
        self.assertEqual(presentation["axisMode"], "dual")
        self.assertEqual(presentation["axisById"], {"DGS10": "left", "GOLD_PRICE": "right"})
        self.assertEqual(presentation["unitsById"], {"DGS10": "raw", "GOLD_PRICE": "raw"})
        self.assertEqual(presentation["chartType"], "line")

    def test_expected_contract_is_not_derived_from_observed_parser_output(self):
        case = exact_gold_yield_case()
        observed = observe_case(case)
        self.assertEqual(case["expected"]["conceptIds"], ["DGS10", "GOLD_PRICE"])
        self.assertIn("conceptIds", observed)
        self.assertEqual(observed["conceptIds"], case["expected"]["conceptIds"])
        self.assertEqual(
            {row["id"]: row["axis"] for row in observed["chart"]["series"]},
            case["expected"]["presentation"]["axisById"],
        )

    def test_exact_compact_us_treasury_prompt_is_a_resolution_checkpoint(self):
        case = exact_gold_us_yield_case()
        self.assertEqual(
            case["prompt"],
            "show me the price of gold against the 10yr US treasury yield",
        )
        self.assertEqual(case["expected"]["conceptIds"], ["GOLD_PRICE", "DGS10"])
        self.assertIsNone(case["expected"]["time"])
        self.assertTrue(case["resolutionCheckpoint"])
        observed = observe_case(case)
        self.assertEqual(observed["residuals"], [])
        self.assertEqual(observed["conceptIds"], ["GOLD_PRICE", "DGS10"])

    def test_repro_ids_are_stable(self):
        first = [repro_id(case) for case in self.cases[:200]]
        second = [repro_id(case) for case in generate_cases()[:200]]
        self.assertEqual(first, second)


class V12GateTests(unittest.TestCase):
    def test_small_gate_report_has_release_schema_and_no_network_model_budget(self):
        report = run_gate(cases=self.cases_for_smoke(), repeat=2)
        self.assertEqual(report["gate"], "side-tools.v1.2.1")
        self.assertEqual(report["networkCalls"], 0)
        self.assertEqual(report["modelCalls"], 0)
        self.assertEqual(len(report["runHashes"]), 2)
        self.assertEqual(report["runHashes"][0], report["runHashes"][1])
        self.assertIn("summary", report)
        self.assertIn("findings", report)

    def test_cross_tool_cases_are_included(self):
        cases = self.cases_for_smoke()
        tools = {case["tool"] for case in cases}
        self.assertEqual(tools, {"macro", "fed", "treasury"})

    @staticmethod
    def cases_for_smoke():
        all_cases = generate_cases()
        selected = [case for case in all_cases if case["id"] == "macro.gold-yield.opposite-axis"]
        selected.extend(case for case in all_cases if case["tool"] == "fed")
        selected.extend(case for case in all_cases if case["tool"] == "treasury")
        return selected


if __name__ == "__main__":
    unittest.main()
