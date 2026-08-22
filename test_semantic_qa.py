"""Unit tests for the isolated deterministic semantic QA harness."""

from __future__ import annotations

import unittest

from qa.contracts import validate_fixture_invariants
from qa.corpora import SEEDS, case_counts, iter_cases, load_corpus
from qa.runner import run_audit


class CorpusShapeTests(unittest.TestCase):
    def test_fixed_seeds_and_required_corpora(self):
        self.assertEqual(SEEDS, {"macro": 3001, "fed": 3002, "treasury": 3003})
        for tool in SEEDS:
            corpus = load_corpus(tool)
            self.assertEqual(corpus["tool"], tool)
            self.assertGreaterEqual(len(corpus["cases"]), 5)
            self.assertTrue(corpus["invariantSamples"]["valid"])
            self.assertTrue(corpus["invariantSamples"]["invalid"])

    def test_exact_regression_prompts_are_present(self):
        required = {
            "show me the total us equity market versus the total US debt market",
            "compare next meeting to prior snapshots",
            "give me a copy of any auction results from 2012 for the 10 year note",
        }
        actual = {
            case["prompt"]
            for tool in SEEDS
            for case in iter_cases(tool, include_variants=False)
        }
        self.assertTrue(required.issubset(actual))

    def test_provider_ids_and_document_intent_have_distinct_contract_assertions(self):
        macro = load_corpus("macro")
        equity = next(case for case in macro["cases"] if case["id"] == "macro.equity_debt_market")
        self.assertEqual(
            equity["expected"]["conceptIds"],
            ["US_PUBLIC_EQUITY_MARKET_CAP", "US_DEBT_SECURITIES_OUTSTANDING"],
        )
        self.assertEqual(equity["expected"]["sourceSeriesIds"], ["BOGZ1LM883164115Q", "ASTDSL"])

        treasury = load_corpus("treasury")
        pdf_case = next(case for case in treasury["cases"] if case["id"] == "treasury.2012_10y_pdf")
        self.assertEqual(pdf_case["expected"]["fieldContains"]["panels"], ["documents"])
        self.assertTrue(pdf_case["expected"]["metricsMustBeEmpty"])
        self.assertNotIn("pdfRequested", pdf_case["expected"].get("fieldEqualsAdditional", {}))

    def test_variants_are_deterministic_and_preserve_expectations(self):
        for tool in SEEDS:
            first = [(case["id"], case["prompt"], case.get("variantSeed")) for case in iter_cases(tool)]
            second = [(case["id"], case["prompt"], case.get("variantSeed")) for case in iter_cases(tool)]
            self.assertEqual(first, second)
            self.assertGreater(case_counts(tool)["expanded"], case_counts(tool)["base"])


class InvariantFixtureTests(unittest.TestCase):
    def test_all_fixture_invariants_are_self_testing(self):
        for tool in SEEDS:
            with self.subTest(tool=tool):
                self.assertEqual(validate_fixture_invariants(load_corpus(tool)), [])


class CurrentModuleSmokeTests(unittest.TestCase):
    def test_runner_executes_current_modules_without_network_or_model(self):
        report = run_audit(tool="all", include_variants=False)
        self.assertEqual(report["mode"], "deterministic-current-modules")
        self.assertEqual(report["summary"]["caseCount"], 15)
        self.assertEqual(report["seeds"], {"macro": 3001, "fed": 3002, "treasury": 3003})
        self.assertEqual(report["summary"]["invariantFailCount"], 0)
        self.assertEqual(len(report["cases"]), 15)
        for result in report["cases"]:
            self.assertIn(result["status"], {"pass", "fail"})
            self.assertIn("observed", result)
            self.assertIn("findings", result)


if __name__ == "__main__":
    unittest.main()
