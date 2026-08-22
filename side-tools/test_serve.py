from __future__ import annotations

import unittest
from datetime import date, timedelta
from unittest.mock import patch

import data_core
import serve


class ResolverTests(unittest.TestCase):
    def test_household_wealth_percentiles_resolve_without_model_or_clarification(self):
        prompt = "Graph top 10% household wealth versus bottom 50% household wealth over 30 years"

        def fake_series(entry, _start, _end):
            observations = [
                {"date": "1996-10-01", "value": 10.0},
                {"date": "2026-01-01", "value": 20.0},
            ]
            return {
                "id": entry["id"], "name": entry["name"], "unit": entry["unit"],
                "provider": "Federal Reserve Distributional Financial Accounts",
                "providerSeries": entry["id"], "sourceUrl": "https://www.federalreserve.gov/releases/z1/dataviz/dfa/",
                "observations": observations, "firstDate": observations[0]["date"],
                "lastDate": observations[-1]["date"], "latest": observations[-1]["value"],
                "resolution": entry["resolution"],
            }

        with patch.object(serve, "fetch_display_series", side_effect=fake_series), patch.object(
            serve.model_router, "macro_intent"
        ) as model:
            payload = serve.handle_fred_query(prompt)
        self.assertFalse(payload.get("requiresClarification", False))
        self.assertEqual(
            {series["id"] for series in payload["series"]},
            {
                "FED_DFA:NETWORTH:TOP_10:LEVELS",
                "FED_DFA:NETWORTH:BOTTOM_50:LEVELS",
            },
        )
        self.assertFalse(payload["intentResolution"]["usedModel"])
        contract = payload["intentResolution"]["requestContract"]
        self.assertEqual(contract["operation"], "compare")
        self.assertEqual(
            [operand["selectors"][0]["kind"] for operand in contract["operands"]],
            ["population_share", "population_share"],
        )
        self.assertEqual(
            [
                (operand["selectors"][0]["lower"], operand["selectors"][0]["upper"])
                for operand in contract["operands"]
            ],
            [(90.0, 100.0), (0.0, 50.0)],
        )
        model.assert_not_called()

    def test_model_is_not_invoked_for_unresolved_protected_percentile(self):
        prompt = "Graph top 10% household income over 30 years"
        with patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": True, "model": "test-model", "message": "ready"},
        ), patch.object(
            serve.model_router,
            "macro_intent",
            return_value=(["GDP deflator"], "test-model"),
        ) as model, patch.object(serve, "fetch_display_series") as fetch:
            payload = serve.handle_fred_query(prompt)
        self.assertTrue(payload["requiresClarification"])
        self.assertTrue(payload["clarification"]["editPromptRequired"])
        self.assertIn("top 10%", payload["clarification"]["questions"][0]["concept"])
        self.assertTrue(any("model was not used" in row for row in payload["resolutionNotices"]))
        model.assert_not_called()
        fetch.assert_not_called()

    def test_semantic_gate_rejects_dropped_percentile_and_wealth_to_gdp_change(self):
        safe, reason = serve.macro_model_mapping_is_safe(
            "top 10% household wealth",
            "GDP deflator",
        )
        self.assertFalse(safe)
        self.assertIn("concept family changed", reason)

    def test_semantic_gate_requires_exact_numeric_operator_and_measure_signature(self):
        unsafe_pairs = (
            ("unemployment above 10%", "unemployment below 10%"),
            ("unemployment above 10%", "unemployment above 5%"),
            ("rates increase by 25 basis points", "rates decrease by 25 basis points"),
            ("top 10 companies by earnings", "top 10% companies by earnings"),
            ("median household wealth", "aggregate household wealth"),
            ("women age 25-54 employment", "employment"),
            ("core CPI", "headline CPI"),
            ("real GDP", "nominal GDP"),
            ("seasonally adjusted unemployment", "unadjusted unemployment"),
            ("earnings excluding technology and energy", "earnings excluding financials and energy"),
            ("housing permits", "home price index"),
            ("initial jobless claims", "unemployment rate"),
            ("M1 money supply", "M2 money supply"),
            ("corporate profits", "disposable personal income"),
        )
        for source, canonical in unsafe_pairs:
            with self.subTest(source=source, canonical=canonical):
                safe, reason = serve.macro_model_mapping_is_safe(source, canonical)
                self.assertFalse(safe)
                self.assertTrue(reason)

    def test_one_model_rewrite_cannot_cover_multiple_requested_operands(self):
        accepted, unresolved, rejected = serve.validate_macro_model_mappings(
            ["headline CPI", "core CPI"],
            ["core CPI"],
        )
        self.assertEqual(accepted, ["core CPI"])
        self.assertEqual(unresolved, ["headline CPI"])
        self.assertEqual(rejected, [])

    def test_request_contract_distinguishes_top_n_count_from_top_n_percent(self):
        count_contract = serve.parse_macro_request_contract("top 10 households by wealth")
        percent_contract = serve.parse_macro_request_contract("top 10% households by wealth")
        self.assertEqual(count_contract["operands"][0]["selectors"][0]["kind"], "rank_count")
        self.assertEqual(
            percent_contract["operands"][0]["selectors"][0]["kind"],
            "population_share",
        )

    def test_unresolved_operand_blocks_irrelevant_price_transform_question(self):
        with patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": False, "message": "disabled"},
        ), patch.object(serve, "fetch_display_series") as fetch:
            payload = serve.handle_fred_query("core CPI and top 10% household income")
        self.assertTrue(payload["requiresClarification"])
        self.assertEqual(
            [question["kind"] for question in payload["clarification"]["questions"]],
            ["concept-edit"],
        )
        self.assertNotIn(
            "price_transform",
            [question["id"] for question in payload["clarification"]["questions"]],
        )
        fetch.assert_not_called()

    def test_rejected_company_fundamental_scope_does_not_preview_stock_price(self):
        for prompt in ("quarterly $MSFT revenue", "$AAPL revenue in China"):
            with self.subTest(prompt=prompt), patch.object(
                serve.model_router,
                "ollama_status",
                return_value={"ready": False, "message": "disabled"},
            ), patch.object(serve, "fetch_display_series") as fetch:
                payload = serve.handle_fred_query(prompt)
            self.assertTrue(payload["requiresClarification"])
            self.assertEqual(payload["clarification"]["seriesPreview"], [])
            fetch.assert_not_called()

    def test_same_family_model_cannot_drop_percentage_threshold(self):
        prompts = (
            "unemployment rate above 10%",
            "core CPI exceeds 3%",
            "effective federal funds rate below 1%",
        )
        for prompt in prompts:
            with self.subTest(prompt=prompt), patch.object(
                serve.model_router,
                "ollama_status",
                return_value={"ready": True, "model": "test-model", "message": "ready"},
            ), patch.object(serve.model_router, "macro_intent") as model, patch.object(
                serve, "fetch_display_series"
            ) as fetch:
                payload = serve.handle_fred_query(prompt)
            self.assertTrue(payload["requiresClarification"])
            self.assertTrue(payload["clarification"]["editPromptRequired"])
            model.assert_not_called()
            fetch.assert_not_called()

    def test_resolved_dfa_group_cannot_mask_unsupported_second_group(self):
        with patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": True, "model": "test-model", "message": "ready"},
        ), patch.object(serve.model_router, "macro_intent") as model, patch.object(
            serve, "fetch_display_series"
        ) as fetch:
            payload = serve.handle_fred_query(
                "household wealth for the bottom half versus the top 5%"
            )
        self.assertTrue(payload["requiresClarification"])
        self.assertEqual(
            payload["clarification"]["questions"][0]["concept"],
            "the top 5%",
        )
        self.assertEqual(
            [row["id"] for row in payload["clarification"]["seriesPreview"]],
            ["FED_DFA:NETWORTH:BOTTOM_50:LEVELS"],
        )
        model.assert_not_called()
        fetch.assert_not_called()

    def test_clause_parser_keeps_numeric_ranges_and_cohorts_intact(self):
        cases = {
            "household wealth between 40th and 60th percentiles over 20 years": [
                "household wealth between 40th and 60th percentiles"
            ],
            "income from $50,000-$100,000 and core CPI": [
                "income from $50000-$100000",
                "core cpi",
            ],
            "household wealth by age 55-64 and 65+": [
                "household wealth by age 55-64 and 65+"
            ],
            "wealth for D1 and D10": ["wealth for d1 and d10"],
            "wealth for Q1 and Q5": ["wealth for q1 and q5"],
            "exports of goods and services in India": ["exports of goods and services in india"],
            "CPI for urban wage earners and clerical workers": [
                "cpi for urban wage earners and clerical workers"
            ],
            "corporate profits with inventory valuation and capital consumption adjustments": [
                "corporate profits with inventory valuation and capital consumption adjustments"
            ],
            "top 10% household wealth excluding real estate and pensions over 10 years": [
                "top 10% household wealth excluding real estate and pensions"
            ],
            "top 10% household wealth excluding real estate and collectibles over 20 years": [
                "top 10% household wealth excluding real estate and collectibles"
            ],
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(serve._search_clauses(prompt), expected)

    def test_time_parser_handles_written_and_non_year_windows(self):
        today = serve.today_local()
        cases = {
            "past three decades": (serve.add_years(today, -30), "last 30 years"),
            "past 24 months": (serve.add_months(today, -24), "last 24 months"),
            "trailing five years": (serve.add_years(today, -5), "last 5 years"),
            "last 8 quarters": (serve.add_months(today, -24), "last 8 quarters"),
        }
        for prompt, (expected_start, expected_label) in cases.items():
            with self.subTest(prompt=prompt):
                result = serve.parse_requested_range(prompt)
                self.assertEqual(result["start"], expected_start)
                self.assertEqual(result["label"], expected_label)

    def test_time_parser_handles_quarter_endpoints_and_rejects_unparsed_horizon(self):
        result = serve.parse_requested_range("from Q1 2010 through Q4 2020")
        self.assertEqual(result["start"], date(2010, 1, 1))
        self.assertEqual(result["end"], date(2020, 12, 31))
        self.assertEqual(result["label"], "Q1 2010 to Q4 2020")
        with self.assertRaisesRegex(ValueError, "could not parse it exactly"):
            serve.parse_requested_range("over many years")

    def test_concept_duration_is_not_mistaken_for_treasury_or_chart_horizon(self):
        with patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": True, "model": "test-model", "message": "ready"},
        ), patch.object(serve.model_router, "macro_intent") as model, patch.object(
            serve, "fetch_display_series"
        ) as fetch:
            payload = serve.handle_fred_query("3-month annualized core CPI")
        self.assertTrue(payload["requiresClarification"])
        self.assertEqual(
            [row["id"] for row in payload["clarification"]["seriesPreview"]],
            ["CPILFESL"],
        )
        self.assertEqual(
            payload["clarification"]["questions"][0]["concept"],
            "3-month annualized core cpi",
        )
        model.assert_not_called()
        fetch.assert_not_called()

    def test_numeric_conditions_remain_attached_to_their_subjects(self):
        with patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": True, "model": "test-model", "message": "ready"},
        ), patch.object(serve.model_router, "macro_intent") as model, patch.object(
            serve, "fetch_display_series"
        ) as fetch:
            payload = serve.handle_fred_query(
                "inflation above 3% and unemployment below 5%"
            )
        self.assertTrue(payload["requiresClarification"])
        self.assertEqual(
            [question["concept"] for question in payload["clarification"]["questions"]],
            ["inflation above 3%", "unemployment below 5%"],
        )
        model.assert_not_called()
        fetch.assert_not_called()

    def test_treasury_month_tenors_and_ordered_inverse_spread_are_complete(self):
        selected, _ = serve.resolve_prompt_series(
            "1-, 3-, 6-, and 12-month Treasury yields",
            allow_fred_search=False,
        )
        self.assertEqual(
            {row["id"] for row in selected},
            {"DGS1MO", "DGS3MO", "DGS6MO", "DGS1"},
        )
        selected, _ = serve.resolve_prompt_series(
            "2-year minus 10-year Treasury spread",
            allow_fred_search=False,
        )
        config = serve.parse_chart_intent(
            "2-year minus 10-year Treasury spread",
            selected,
        )
        self.assertEqual(config["formulas"][0]["expression"], "A-B")
        self.assertEqual(
            config["formulas"][0]["name"],
            "2-Year Treasury Yield minus 10-Year Treasury Yield",
        )

    def test_unsupported_measure_and_constituent_scope_never_use_aggregate_substitute(self):
        prompts = (
            "minimum wealth cutoff for top 1%",
            "S&P 500 top 10 companies earnings share",
        )
        for prompt in prompts:
            with self.subTest(prompt=prompt), patch.object(
                serve.model_router,
                "ollama_status",
                return_value={"ready": True, "model": "test-model", "message": "ready"},
            ), patch.object(serve.model_router, "macro_intent") as model, patch.object(
                serve, "fetch_display_series"
            ) as fetch:
                payload = serve.handle_fred_query(prompt)
            self.assertTrue(payload["requiresClarification"])
            self.assertEqual(payload["clarification"]["seriesPreview"], [])
            model.assert_not_called()
            fetch.assert_not_called()

    def test_percent_of_gdp_unit_does_not_add_gdp_level_operand(self):
        selected, _ = serve.resolve_prompt_series(
            "exports above 10% of GDP",
            allow_fred_search=False,
        )
        self.assertEqual(
            [row["id"] for row in selected],
            ["WORLD_BANK:USA:NE.EXP.GNFS.ZS"],
        )

    def test_model_gate_defaults_to_deny_for_unknown_source_family(self):
        bad_pairs = (
            ("women age 25 to 54", "WTI crude oil price"),
            ("spread", "GDP deflator"),
            ("30 largest monthly gains", "gold price"),
        )
        for source, candidate in bad_pairs:
            with self.subTest(source=source, candidate=candidate):
                safe, _reason = serve.macro_model_mapping_is_safe(source, candidate)
                self.assertFalse(safe)

    def test_core_ppi_goods_and_services_stays_one_concept(self):
        prompt = "graph core PPI final goods and services and core CPI over the last 25 years"
        with patch.object(serve, "fred_api_search") as search:
            selected, notices = serve.resolve_prompt_series(prompt)
        self.assertEqual(
            {entry["id"] for entry in selected},
            {"WPSFD49116", "CPILFESL"},
        )
        self.assertNotIn("PPIACO", {entry["id"] for entry in selected})
        self.assertNotIn("TDSP", {entry["id"] for entry in selected})
        search.assert_not_called()
        self.assertTrue(any("goods and services" in notice for notice in notices))

    def test_ambiguous_price_indexes_require_clarification_before_fetch(self):
        prompt = "graph core PPI final goods and services and core CPI over the last 25 years"
        with patch.object(serve, "fetch_display_series") as fetch:
            payload = serve.handle_fred_query(prompt)
        self.assertTrue(payload["requiresClarification"])
        self.assertEqual(
            [question["id"] for question in payload["clarification"]["questions"]],
            ["ppi_definition", "price_transform"],
        )
        fetch.assert_not_called()

    def test_long_ppi_request_recommends_maximum_honest_official_coverage(self):
        payload = serve.handle_fred_query(
            "graph core PPI final goods and services and core CPI over the last 25 years"
        )
        ppi_question = next(
            question
            for question in payload["clarification"]["questions"]
            if question["id"] == "ppi_definition"
        )
        recommended = [
            option["value"] for option in ppi_question["options"] if option["recommended"]
        ]
        self.assertEqual(recommended, ["maximum_official_history"])
        self.assertIn("No conceptually consistent", ppi_question["question"])

    def test_clarified_core_ppi_query_uses_only_chosen_bls_series(self):
        prompt = "graph core PPI final goods and services and core CPI over the last 25 years"

        def fake_series(entry, _start, _end):
            observations = [
                {"date": (date(2024, 1, 1) + timedelta(days=index * 28)).isoformat(), "value": 100 + index}
                for index in range(15)
            ]
            return {
                "id": entry["id"],
                "name": entry["name"],
                "unit": entry["unit"],
                "provider": "U.S. Bureau of Labor Statistics API",
                "providerSeries": entry["bls"],
                "sourceUrl": f"https://data.bls.gov/timeseries/{entry['bls']}",
                "observations": observations,
                "firstDate": observations[0]["date"],
                "lastDate": observations[-1]["date"],
                "latest": observations[-1]["value"],
                "resolution": "curated direct BLS series mapping",
            }

        with patch.object(serve, "fetch_display_series", side_effect=fake_series):
            clarification = serve.handle_fred_query(prompt)
            payload = serve.handle_fred_query(
                prompt,
                clarifications={
                    "_token": clarification["clarification"]["token"],
                    "ppi_definition": "core_final_demand",
                    "price_transform": "pct_yoy",
                },
            )
        self.assertEqual(
            {series["id"] for series in payload["series"]},
            {"WPSFD49116", "CPILFESL"},
        )
        self.assertTrue(all(spec["units"] == "pct_yoy" for spec in payload["chartConfig"]["series"]))
        self.assertNotIn("TDSP", {series["id"] for series in payload["series"]})

    def test_separate_core_ppi_goods_and_services_choice_returns_both_lines(self):
        prompt = "graph core PPI final goods and services and core CPI over the last 25 years"

        def fake_series(entry, _start, _end):
            observations = [
                {"date": "2024-01-01", "value": 100.0},
                {"date": "2025-01-01", "value": 103.0},
            ]
            return {
                "id": entry["id"], "name": entry["name"], "unit": entry["unit"],
                "provider": "U.S. Bureau of Labor Statistics API",
                "providerSeries": entry["bls"],
                "sourceUrl": f"https://data.bls.gov/timeseries/{entry['bls']}",
                "observations": observations, "firstDate": "2024-01-01",
                "lastDate": "2025-01-01", "latest": 103.0,
                "resolution": "curated direct BLS series mapping",
            }

        clarification = serve.handle_fred_query(prompt)
        with patch.object(serve, "fetch_display_series", side_effect=fake_series):
            payload = serve.handle_fred_query(
                prompt,
                clarifications={
                    "_token": clarification["clarification"]["token"],
                    "ppi_definition": "separate_goods_services",
                    "price_transform": "raw",
                },
            )
        self.assertEqual(
            {series["id"] for series in payload["series"]},
            {"WPSFD413", "WPSFD49113", "CPILFESL"},
        )

    def test_maximum_history_ppi_choice_keeps_legacy_goods_and_modern_services_separate(self):
        prompt = "graph core PPI final goods and services and core CPI over the last 25 years"
        clarification = serve.handle_fred_query(prompt)

        def fake_series(entry, _start, _end):
            observations = [
                {"date": "2001-09-01", "value": 100.0},
                {"date": "2025-09-01", "value": 130.0},
            ]
            return {
                "id": entry["id"], "name": entry["name"], "unit": entry["unit"],
                "provider": "Test provider", "providerSeries": entry.get("bls", entry["id"]),
                "sourceUrl": "https://example.test", "observations": observations,
                "firstDate": observations[0]["date"], "lastDate": observations[-1]["date"],
                "latest": 130.0, "resolution": "test mapping",
            }

        with patch.object(serve, "fetch_display_series", side_effect=fake_series):
            payload = serve.handle_fred_query(
                prompt,
                clarifications={
                    "_token": clarification["clarification"]["token"],
                    "ppi_definition": "maximum_official_history",
                    "price_transform": "pct_yoy",
                },
            )
        self.assertEqual(
            {series["id"] for series in payload["series"]},
            {"WPSFD4131", "WPSFD49113", "CPILFESL"},
        )

    def test_clarification_answers_are_bound_to_originating_prompt(self):
        first = serve.handle_fred_query("graph core PPI and core CPI")
        with self.assertRaisesRegex(ValueError, "do not belong"):
            serve.handle_fred_query(
                "graph unemployment rate",
                clarifications={
                    "_token": first["clarification"]["token"],
                    "ppi_definition": "core_final_demand",
                },
            )

    def test_core_ppi_and_headline_cpi_never_resolve_to_all_commodities(self):
        selected, _ = serve.resolve_prompt_series("graph core PPI and headline CPI")
        ids = {entry["id"] for entry in selected}
        self.assertEqual(ids, {"WPSFD49116", "CPIAUCSL"})
        self.assertNotIn("PPIACO", ids)

    def test_high_value_macro_concepts_have_deterministic_mappings(self):
        cases = {
            "labor force participation and unemployment": {"CIVPART", "UNRATE"},
            "employment to population ratio and payrolls": {"EMRATIO", "PAYEMS"},
            "U-6 unemployment and job openings": {"U6RATE", "JTSJOL"},
            "GDP deflator and core PCE": {"GDPDEF", "PCEPILFE"},
            "personal saving rate and disposable personal income": {"PSAVERT", "DSPI"},
            "productivity and unit labor costs": {"OPHNFB", "ULCNFB"},
            "average weekly hours and average hourly earnings": {"AWHI", "CES0500000003"},
            "CPI shelter and owners equivalent rent": {"CPI_SHELTER", "CPI_OER"},
            "food CPI and energy CPI": {"CPI_FOOD", "CPI_ENERGY"},
            "core and headline PCE": {"PCEPILFE", "PCEPI"},
            "M1 and M2 money supply": {"M1SL", "M2SL"},
            "SOFR and effective fed funds rate": {"SOFR", "EFFR"},
            "Fed balance sheet and reverse repo": {"WALCL", "RRPONTSYD"},
            "initial claims continuing claims and unemployment": {"ICSA", "CCSA", "UNRATE"},
            "WTI and Brent crude oil": {"DCOILWTICO", "DCOILBRENTEU"},
            "natural gas and gasoline prices": {"DHHNGSP", "GASREGW"},
            "gold and silver prices": {"GOLD_PRICE", "SILVER_PRICE"},
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, _ = serve.resolve_prompt_series(prompt, allow_fred_search=False)
                self.assertEqual({entry["id"] for entry in selected}, expected)

    def test_specific_cpi_components_do_not_add_headline_cpi(self):
        selected, _ = serve.resolve_prompt_series(
            "medical care CPI and core CPI",
            allow_fred_search=False,
        )
        ids = {entry["id"] for entry in selected}
        self.assertEqual(ids, {"CPI_MEDICAL", "CPILFESL"})
        self.assertNotIn("CPIAUCSL", ids)

    def test_coordinated_macro_phrases_preserve_shared_context(self):
        cases = {
            "core PPI goods and core PPI services": {"WPSFD413", "WPSFD49113"},
            "job openings, hires rate, and quits rate": {"JTSJOL", "JTSHIR", "JTSQUR"},
            "initial and continuing jobless claims": {"ICSA", "CCSA"},
            "1m, 3m, 6m and 1y Treasury yields": {"DGS1MO", "DGS3MO", "DGS6MO", "DGS1"},
            "EFFR and target upper/lower bounds": {"EFFR", "DFEDTARU", "DFEDTARL"},
            "30-year mortgage and 10-year Treasury": {"MORTGAGE30US", "DGS10"},
            "30-year mortgage rate and 10-year Treasury yield": {"MORTGAGE30US", "DGS10"},
            "2s10s and 3m10y Treasury spreads": {"T10Y2Y", "T10Y3M"},
            "copper, gold, and S&P 500": {"PCOPPUSDM", "GOLD_PRICE", "SP500"},
            "real and nominal retail sales": {"RRSFS", "RSAFS"},
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, _ = serve.resolve_prompt_series(prompt, allow_fred_search=False)
                self.assertEqual({entry["id"] for entry in selected}, expected)

    def test_satisfied_modifiers_do_not_create_false_partial_warnings(self):
        prompts = (
            "headline and core CPI",
            "EFFR and target upper/lower bounds",
            "10-year real Treasury yield, the nominal yield, and 10-year breakeven inflation",
            "$SPY, $QQQ, and VIX prices",
            "series ECBDFR and effective fed funds rate",
            "real and nominal retail sales",
        )
        for prompt in prompts:
            with self.subTest(prompt=prompt):
                selected, notices = serve.resolve_prompt_series(
                    prompt,
                    allow_fred_search=False,
                )
                residuals = [
                    serve.unresolved_clause_residual(clause)
                    for clause in serve._search_clauses(
                        serve.normalize_macro_concept_phrasing(prompt)[0]
                    )
                ]
                self.assertEqual(
                    serve.filter_satisfied_macro_residuals(
                        [residual for residual in residuals if residual],
                        selected,
                    ),
                    [],
                )
                self.assertFalse(any("did not exactly match" in notice for notice in notices))

    def test_core_cpi_ex_shelter_is_not_silently_dropped(self):
        selected, _ = serve.resolve_prompt_series(
            "core CPI excluding shelter and core CPI",
            allow_fred_search=False,
        )
        self.assertEqual(
            {entry["id"] for entry in selected},
            {"CPI_CORE_EX_SHELTER", "CPILFESL"},
        )

    def test_generic_business_investment_requires_definition(self):
        prompt = "real GDP, real personal consumption, and business investment"
        payload = serve.handle_fred_query(prompt)
        self.assertTrue(payload["requiresClarification"])
        self.assertIn(
            "business_investment",
            [question["id"] for question in payload["clarification"]["questions"]],
        )
        self.assertNotIn(
            "W790RC1Q027SBEA",
            {entry["id"] for entry in payload["clarification"]["seriesPreview"]},
        )

    def test_business_investment_clarification_selects_bea_fixed_investment(self):
        prompt = "real GDP, real personal consumption, and business investment"
        clarification = serve.handle_fred_query(prompt)

        def fake_series(entry, _start, _end):
            observations = [
                {"date": "2024-01-01", "value": 100.0},
                {"date": "2025-01-01", "value": 102.0},
            ]
            return {
                "id": entry["id"], "name": entry["name"], "unit": entry["unit"],
                "provider": "Test provider", "providerSeries": entry["id"],
                "sourceUrl": f"https://example.test/{entry['id']}",
                "observations": observations, "firstDate": "2024-01-01",
                "lastDate": "2025-01-01", "latest": 102.0,
                "resolution": "test mapping",
            }

        with patch.object(serve, "fetch_display_series", side_effect=fake_series):
            payload = serve.handle_fred_query(
                prompt,
                clarifications={
                    "_token": clarification["clarification"]["token"],
                    "business_investment": "real_nonresidential_fixed",
                },
            )
        self.assertEqual(
            {series["id"] for series in payload["series"]},
            {"GDPC1", "PCEC96", "PNFIC1"},
        )

    def test_explicit_core_ppi_components_skip_definition_question(self):
        for prompt in (
            "core PPI goods and core PPI services year-over-year",
            "core PPI final demand year-over-year",
        ):
            with self.subTest(prompt=prompt), patch.object(serve, "fetch_display_series") as fetch:
                fetch.side_effect = RuntimeError("stop after clarification check")
                with self.assertRaisesRegex(RuntimeError, "No requested series"):
                    serve.handle_fred_query(prompt)

    def test_generic_yield_curve_requests_definition_question(self):
        payload = serve.handle_fred_query("recession indicator and yield curve spread")
        self.assertTrue(payload["requiresClarification"])
        self.assertEqual(
            [question["id"] for question in payload["clarification"]["questions"]],
            ["yield_spread"],
        )

    def test_foreign_scope_cannot_inherit_us_treasury_yield(self):
        selected, notices = serve.resolve_prompt_series(
            "Germany GDP and 10-year yield",
            allow_fred_search=False,
        )
        ids = {entry["id"] for entry in selected}
        self.assertEqual(ids, {"WORLD_BANK:DEU:NY.GDP.MKTP.CD"})
        self.assertNotIn("DGS10", ids)
        self.assertTrue(any("no similarly named U.S. series" in notice for notice in notices))

    def test_partial_resolution_requires_concept_correction_before_fetch(self):
        with patch.object(serve, "fetch_display_series") as fetch, patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": False, "message": "disabled for deterministic test"},
        ):
            payload = serve.handle_fred_query("S&P 500 and national median rent")
        self.assertTrue(payload["requiresClarification"])
        self.assertTrue(payload["clarification"]["editPromptRequired"])
        self.assertIn("national median rent", payload["clarification"]["questions"][0]["concept"])
        fetch.assert_not_called()

    def test_missing_configured_provider_requires_correction_not_partial_chart(self):
        with patch.object(serve, "get_secret", return_value="configured"), patch.object(
            serve, "fred_api_search", return_value=[]
        ), patch.object(serve, "fetch_display_series") as fetch, patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": False, "message": "disabled for deterministic test"},
        ):
            payload = serve.handle_fred_query(
                "Chicago Fed national activity index and ISM manufacturing PMI"
            )
        self.assertTrue(payload["requiresClarification"])
        self.assertTrue(payload["clarification"]["editPromptRequired"])
        fetch.assert_not_called()

    def test_plain_ppi_maps_to_headline_final_demand_not_all_commodities(self):
        selected, _ = serve.resolve_prompt_series("graph PPI for the last 5 years")
        self.assertEqual([entry["id"] for entry in selected], ["WPSFD4"])

    def test_specific_operand_does_not_also_load_its_broader_alias(self):
        cases = {
            "core PPI services": ["WPSFD49113"],
            "core PPI goods": ["WPSFD413"],
            "core CPI ex shelter": ["CPI_CORE_EX_SHELTER"],
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, _ = serve.resolve_prompt_series(prompt, allow_fred_search=False)
                self.assertEqual([entry["id"] for entry in selected], expected)

    def test_single_generic_residual_cannot_trigger_fred_search(self):
        with (
            patch.object(serve, "get_secret", return_value="configured"),
            patch.object(serve, "fred_api_search") as search,
        ):
            selected, notices = serve.resolve_prompt_series("graph services")
        self.assertEqual(selected, [])
        search.assert_not_called()
        self.assertTrue(any("too broad" in notice for notice in notices))

    def test_macro_dashboard_loads_verified_cards_without_a_prompt(self):
        def fake_series(entry, _start, _end):
            values = [100 + index for index in range(14)]
            if entry["id"] in {"DGS10", "EFFR", "UNRATE"}:
                values = [3 + index / 20 for index in range(14)]
            observations = [
                {
                    "date": (date(2025, 1, 1) + timedelta(days=index * 28)).isoformat(),
                    "value": value,
                }
                for index, value in enumerate(values)
            ]
            return {
                "id": entry["id"],
                "name": entry["name"],
                "unit": entry["unit"],
                "provider": "Test provider",
                "providerSeries": entry["id"],
                "sourceUrl": f"https://example.test/{entry['id']}",
                "observations": observations,
            }

        with patch.object(serve, "fetch_display_series", side_effect=fake_series):
            payload = serve.macro_dashboard_payload()

        self.assertEqual(payload["status"], "pass")
        self.assertEqual([card["id"] for card in payload["cards"]], list(serve.MACRO_DASHBOARD_SERIES))
        self.assertEqual(payload["errors"], [])
        self.assertEqual(payload["cards"][-1]["changeUnit"], "year-over-year")

    def test_range_parser_does_not_treat_index_level_as_year_count(self):
        ytd = serve.parse_requested_range("S&P 500 year to date")
        self.assertEqual(ytd["start"], date(serve.today_local().year, 1, 1))
        bounded = serve.parse_requested_range("GDP from 2000 to 2010")
        self.assertEqual((bounded["start"], bounded["end"]), (date(2000, 1, 1), date(2010, 12, 31)))
        since = serve.parse_requested_range("unemployment since 1990")
        self.assertEqual(since["start"], date(1990, 1, 1))

    def test_clause_local_exclusions_keep_requested_headline_and_core_series(self):
        cases = {
            "core PCE and PCE price index": {"PCEPILFE", "PCEPI"},
            "core CPI versus headline CPI": {"CPILFESL", "CPIAUCSL"},
            "core and headline CPI since 2010": {"CPILFESL", "CPIAUCSL"},
            "initial jobless claims and unemployment rate": {"ICSA", "UNRATE"},
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, _ = serve.resolve_prompt_series(prompt)
                self.assertEqual({entry["id"] for entry in selected}, expected)

    def test_plain_nasdaq_means_composite_but_not_nasdaq_100(self):
        selected, _ = serve.resolve_prompt_series("S&P 500 minus Nasdaq over the last 5 years")
        self.assertEqual([entry["id"] for entry in selected], ["SP500", "NASDAQCOM"])
        selected, _ = serve.resolve_prompt_series("Nasdaq 100 price")
        self.assertEqual([entry["id"] for entry in selected], ["NASDAQ100"])

    def test_country_scope_never_falls_back_to_similarly_named_us_series(self):
        cases = {
            "GDP of Turkey": ["WORLD_BANK:TUR:NY.GDP.MKTP.CD"],
            "CPI for Canada": ["WORLD_BANK:CAN:FP.CPI.TOTL.ZG"],
            "Internet users worldwide": ["WORLD_BANK:WLD:IT.NET.USER.ZS"],
            "10-year yield for Germany": [],
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, _ = serve.resolve_prompt_series(prompt)
                self.assertEqual([entry["id"] for entry in selected], expected)

    def test_unsupported_fundamental_never_becomes_price(self):
        for prompt in (
            "Show $AAPL EBITDA for last 10 years",
            "Nasdaq 100 earnings excluding technology",
            "S&P 500 reported earnings per share",
            "S&P 500 price to earnings ratio",
        ):
            with self.subTest(prompt=prompt):
                selected, notices = serve.resolve_prompt_series(prompt)
                self.assertEqual(selected, [])
                self.assertTrue(notices)

    def test_prompt_transformations_create_explicit_chart_controls(self):
        selected, _ = serve.resolve_prompt_series(
            "Chart the 10-year Treasury yield minus the 2-year Treasury yield"
        )
        config = serve.parse_chart_intent("10-year Treasury yield minus 2-year Treasury yield", selected)
        self.assertEqual(config["formulas"][0]["expression"], "A-B")
        selected, _ = serve.resolve_prompt_series("year-over-year percent change in CPI")
        config = serve.parse_chart_intent("year-over-year percent change in CPI", selected)
        self.assertEqual(config["series"][0]["units"], "pct_yoy")

    def test_backend_status_exposes_build_and_detects_source_changes(self):
        status = serve.backend_status()
        self.assertEqual(status["build"], serve.BACKEND_BUILD)
        self.assertTrue(status["startedAt"])
        self.assertFalse(status["restartRequired"])

    def test_fed_display_command_uses_deterministic_controls_only(self):
        payload = serve.parse_fed_tracker_intent(
            "show historical probabilities for the September meeting over all available history",
            ["2026-09-16", "2026-10-28"],
        )
        self.assertEqual(
            payload["spec"],
            {
                "view": "historical",
                "meetingDate": "2026-09-16",
                "historyRange": "ALL",
            },
        )
        self.assertFalse(payload["usedModel"])
        self.assertFalse(payload["dataValuesFromModel"])

    def test_fed_parser_resolves_year_specific_month_and_rejects_ambiguity(self):
        meetings = ["2026-09-16", "2026-12-09", "2027-09-15"]
        payload = serve.parse_fed_tracker_intent(
            "show current probabilities for September 2027",
            meetings,
        )
        self.assertEqual(payload["spec"]["view"], "current")
        self.assertEqual(payload["spec"]["meetingDate"], "2027-09-15")
        for prompt in (
            "compare September and December",
            "show historical versus current probabilities for September",
            "show September history for 1 month or 1 year",
            "backtest rate cuts after 2026-09-16",
        ):
            with self.subTest(prompt=prompt), self.assertRaises(ValueError):
                serve.parse_fed_tracker_intent(prompt, meetings)

    def test_macro_model_fallback_is_re_resolved_and_never_supplies_values(self):
        entry = next(row for row in serve.SERIES_CATALOG if row["id"] == "UNRATE")
        series = {
            "id": "UNRATE",
            "name": "Unemployment Rate",
            "unit": "Percent",
            "provider": "BLS Public Data API",
            "providerSeries": "LNS14000000",
            "sourceUrl": "https://data.bls.gov/timeseries/LNS14000000",
            "observations": [
                {"date": "2025-01-01", "value": 4.0},
                {"date": "2025-02-01", "value": 4.1},
            ],
            "firstDate": "2025-01-01",
            "lastDate": "2025-02-01",
            "latest": 4.1,
            "resolution": "allowlisted test mapping",
        }
        with patch.object(
            serve,
            "resolve_prompt_series",
            side_effect=[([], []), ([entry], [])],
        ), patch.object(
            serve.model_router,
            "ollama_status",
            return_value={"ready": True, "message": "ready"},
        ), patch.object(
            serve.model_router,
            "macro_intent",
            return_value=(["unemployment rate"], "qwen3.5:9b"),
        ), patch.object(
            serve,
            "fetch_display_series",
            return_value=series,
        ):
            payload = serve.handle_fred_query("labor slackness gauge")
        self.assertTrue(payload["intentResolution"]["usedModel"])
        self.assertEqual(payload["intentResolution"]["canonicalQueries"], ["unemployment rate"])
        self.assertFalse(payload["verification"]["dataValuesFromModel"])

    def test_model_rewrites_cannot_trigger_open_ended_fred_search(self):
        with patch.object(serve, "fred_api_search") as search:
            selected, notices = serve.resolve_prompt_series(
                "price_pressure_gauge",
                allow_fred_search=False,
            )
        self.assertEqual(selected, [])
        search.assert_not_called()
        self.assertTrue(any("No open-ended provider search" in notice for notice in notices))

    def test_excluded_food_and_energy_are_core_cpi_not_standalone_series(self):
        with patch.object(serve, "fred_api_search") as search:
            selected, notices = serve.resolve_prompt_series(
                "Graph the price-pressure gauge that omits groceries and gasoline for the last 5 years"
            )
        self.assertEqual([entry["id"] for entry in selected], ["CPILFESL"])
        search.assert_not_called()
        self.assertTrue(any("normalized to core CPI" in notice for notice in notices))

    def test_long_sp500_request_uses_market_history_provider(self):
        selected, notices = serve.resolve_prompt_series("sp500 for last 30 years")
        self.assertFalse(notices)
        self.assertEqual(selected[0]["id"], "SP500")
        self.assertEqual(selected[0]["primary"], "yahoo")
        self.assertEqual(selected[0]["yahoo"], "^GSPC")

    def test_national_home_price_request_is_not_ambiguous(self):
        selected, _ = serve.resolve_prompt_series("national home price index for last 30 years")
        self.assertEqual([entry["id"] for entry in selected], ["CSUSHPINSA"])

    def test_explicit_market_symbol(self):
        selected, _ = serve.resolve_prompt_series("chart $TLT and ^GSPC for last 5 years")
        ids = {entry["id"] for entry in selected}
        self.assertIn("YAHOO:TLT", ids)
        self.assertIn("YAHOO:^GSPC", ids)

    def test_breakeven_does_not_resolve_to_nominal_treasury_yield(self):
        selected, notices = serve.resolve_prompt_series("10-year breakeven inflation rate")
        self.assertEqual([entry["id"] for entry in selected], ["T10YIE"])
        self.assertEqual(notices, [])

    def test_specific_series_do_not_trigger_broad_aliases(self):
        cases = {
            "pce inflation": ["PCEPI"],
            "30-year fixed mortgage rate": ["MORTGAGE30US"],
            "initial unemployment claims": ["ICSA"],
            "10-year real treasury yield": ["DFII10"],
            "trade weighted dollar index": ["DTWEXBGS"],
            "average hourly earnings": ["CES0500000003"],
            "gold price": ["GOLD_PRICE"],
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, notices = serve.resolve_prompt_series(prompt)
                self.assertEqual([entry["id"] for entry in selected], expected)
                self.assertEqual(notices, [])

    def test_wage_inflation_does_not_silently_map_to_cpi(self):
        selected, notices = serve.resolve_prompt_series("wage inflation")
        self.assertEqual(selected, [])
        self.assertTrue(any("wage inflation" in notice for notice in notices))

    def test_partially_unsupported_prompt_is_not_silent(self):
        selected, notices = serve.resolve_prompt_series("S&P 500 and national median rent")
        self.assertEqual([entry["id"] for entry in selected], ["SP500"])
        self.assertTrue(any("national median rent" in notice for notice in notices))

    def test_unsupported_operand_in_same_clause_is_not_silent(self):
        selected, notices = serve.resolve_prompt_series("S&P 500 divided by national median rent")
        self.assertEqual([entry["id"] for entry in selected], ["SP500"])
        self.assertTrue(any("national median rent" in notice for notice in notices))

    def test_fred_search_match_requires_every_meaningful_title_term(self):
        bad_rent_match = {
            "id": "LEU0254550700A",
            "title": "Median usual weekly earnings: Counter and rental clerks occupations",
        }
        good_match = {
            "id": "OHUR",
            "title": "Unemployment Rate in Ohio",
        }
        self.assertFalse(serve.credible_fred_search_match("national median rent", bad_rent_match))
        self.assertTrue(serve.credible_fred_search_match("Ohio unemployment rate", good_match))
        self.assertFalse(
            serve.credible_fred_search_match(
                "mortgage delinquency rate",
                {
                    "id": "BAD",
                    "title": "Mortgage Delinquency Balance",
                    "units": "Millions of Dollars",
                    "frequency": "Quarterly",
                },
            )
        )
        self.assertFalse(
            serve.credible_fred_search_match(
                "monthly national financial conditions index",
                {
                    "id": "NFCI",
                    "title": "National Financial Conditions Index",
                    "units": "Index",
                    "frequency": "Weekly",
                },
            )
        )

    def test_accepted_dynamic_fred_result_satisfies_its_operand_without_edit_loop(self):
        match = {
            "id": "NFCI",
            "title": "Chicago Fed National Financial Conditions Index",
            "frequency": "Weekly",
            "units": "Index",
        }
        series = {
            "id": "NFCI",
            "name": match["title"],
            "unit": "Index",
            "provider": "FRED",
            "providerSeries": "NFCI",
            "observations": [
                {"date": "2025-01-03", "value": -0.4},
                {"date": "2025-01-10", "value": -0.3},
            ],
            "firstDate": "2025-01-03",
            "lastDate": "2025-01-10",
            "latest": -0.3,
            "sourceUrl": "https://fred.stlouisfed.org/series/NFCI",
        }
        with patch.object(serve, "get_secret", return_value="configured"), patch.object(
            serve, "fred_api_search", return_value=[match]
        ), patch.object(serve, "fetch_display_series", return_value=series):
            payload = serve.handle_fred_query("national financial conditions index")
        self.assertFalse(payload.get("requiresClarification", False))
        self.assertEqual([row["id"] for row in payload["series"]], ["NFCI"])

    def test_static_allowlist_excludes_secrets_and_cache(self):
        self.assertNotIn("side-tools-settings.json", serve.STATIC_FILES)
        self.assertNotIn(".cache/http/example.json", serve.STATIC_FILES)

    def test_yahoo_primary_index_falls_back_to_fred(self):
        fred_result = {
            "provider": "FRED",
            "providerSeries": "SP500",
            "observations": [{"date": "2026-08-10", "value": 6400.0}],
            "firstDate": "2026-08-10",
            "lastDate": "2026-08-10",
            "latest": 6400.0,
            "sourceUrl": "https://fred.test/SP500",
        }
        with (
            patch.object(serve, "fetch_yahoo_chart", side_effect=RuntimeError("Yahoo unavailable")),
            patch.object(serve, "fetch_fred_series", return_value=fred_result.copy()),
        ):
            result = serve.fetch_display_series(serve.CATALOG_BY_ID["SP500"], None, None)
        self.assertEqual(result["provider"], "FRED")
        self.assertIn("Yahoo Finance failed", result["fallbackReason"])

    def test_treasury_primary_falls_back_to_fred(self):
        fred_result = {
            "provider": "FRED",
            "providerSeries": "DGS10",
            "observations": [{"date": "2026-08-10", "value": 4.1}],
            "firstDate": "2026-08-10",
            "lastDate": "2026-08-10",
            "latest": 4.1,
            "sourceUrl": "https://fred.test/DGS10",
        }
        with (
            patch.object(
                serve,
                "fetch_treasury_yield_series",
                side_effect=RuntimeError("Treasury unavailable"),
            ),
            patch.object(serve, "fetch_fred_series", return_value=fred_result.copy()),
        ):
            result = serve.fetch_display_series(serve.CATALOG_BY_ID["DGS10"], None, None)
        self.assertEqual(result["provider"], "FRED")
        self.assertIn("Treasury feed failed", result["fallbackReason"])

    def test_multi_series_query_never_charts_only_the_successful_subset(self):
        entries = [serve.CATALOG_BY_ID["SP500"], serve.CATALOG_BY_ID["VIXCLS"]]
        good = {
            "id": "SP500",
            "name": "S&P 500 Index",
            "unit": "Index level",
            "provider": "test",
            "providerSeries": "SP500",
            "observations": [{"date": "2026-08-10", "value": 6400.0}],
            "firstDate": "2026-08-10",
            "lastDate": "2026-08-10",
            "latest": 6400.0,
        }

        def fake_fetch(entry, _start, _end):
            if entry["id"] == "SP500":
                return good.copy()
            raise RuntimeError("VIX source unavailable")

        with (
            patch.object(serve, "resolve_prompt_series", return_value=(entries, [])),
            patch.object(serve, "fetch_display_series", side_effect=fake_fetch),
        ):
            with self.assertRaisesRegex(RuntimeError, "no partial chart was shown"):
                serve.handle_fred_query("S&P 500 and VIX")

    def test_substitute_is_contingent_and_dual_axis_intent_is_explicit(self):
        prompt = (
            "s&p 500, 10-year and 2-year treasury yields and federal funds rate for last "
            "25 years, nasdaq composite may be used as substitute for S&P 500, please put "
            "the yields on one side of the axis and price on the other"
        )
        selected, notices = serve.resolve_prompt_series(prompt)
        self.assertEqual([row["id"] for row in selected], ["SP500", "DGS10", "DGS2", "EFFR"])
        self.assertEqual(selected[0]["promptFallback"]["id"], "NASDAQCOM")
        self.assertTrue(any("contingency substitute" in notice for notice in notices))
        config = serve.parse_chart_intent(prompt, selected)
        axes = {row["id"]: row["axis"] for row in config["series"]}
        self.assertEqual(axes["SP500"], "right")
        self.assertEqual(axes["DGS10"], "left")
        self.assertEqual(axes["DGS2"], "left")
        self.assertEqual(axes["EFFR"], "left")
        self.assertTrue(config["recognizedInstructions"])

    def test_prompt_substitute_is_used_only_after_primary_failure(self):
        primary = {**serve.CATALOG_BY_ID["SP500"], "promptFallback": serve.CATALOG_BY_ID["NASDAQCOM"]}
        fallback_result = {
            "id": "NASDAQCOM",
            "name": "Nasdaq Composite Index",
            "unit": "Index level",
            "provider": "test",
            "providerSeries": "^IXIC",
            "observations": [{"date": "2026-08-10", "value": 22000.0}],
            "firstDate": "2026-08-10",
            "lastDate": "2026-08-10",
            "latest": 22000.0,
        }

        def fake_fetch(entry, _start, _end):
            if entry["id"] == "SP500":
                raise RuntimeError("primary unavailable")
            return fallback_result.copy()

        with (
            patch.object(serve, "resolve_prompt_series", return_value=([primary], [])),
            patch.object(serve, "fetch_display_series", side_effect=fake_fetch),
        ):
            result = serve.handle_fred_query("S&P 500")
        self.assertEqual(result["series"][0]["id"], "NASDAQCOM")
        self.assertEqual(result["series"][0]["fallbackFor"], "SP500")
        self.assertIn("prompt-approved substitute", result["series"][0]["resolution"].lower())

    def test_query_date_overrides_are_forwarded(self):
        entry = serve.CATALOG_BY_ID["DGS10"]
        returned = {
            "id": "DGS10",
            "name": entry["name"],
            "unit": entry["unit"],
            "provider": "test",
            "providerSeries": "DGS10",
            "observations": [{"date": "2020-01-02", "value": 1.88}],
            "firstDate": "2020-01-02",
            "lastDate": "2020-01-02",
            "latest": 1.88,
        }
        with (
            patch.object(serve, "resolve_prompt_series", return_value=([entry], [])),
            patch.object(serve, "fetch_display_series", return_value=returned) as fetch,
        ):
            result = serve.handle_fred_query(
                "10 year yield",
                date(2020, 1, 1),
                date(2020, 12, 31),
            )
        fetch.assert_called_once_with(entry, date(2020, 1, 1), date(2020, 12, 31))
        self.assertEqual(result["range"]["start"], "2020-01-01")
        self.assertEqual(result["range"]["end"], "2020-12-31")

    def test_direct_bls_parser_ignores_annual_average_and_sorts(self):
        payload = {
            "status": "REQUEST_SUCCEEDED",
            "Results": {
                "series": [
                    {
                        "seriesID": "CUSR0000SA0",
                        "data": [
                            {"year": "2026", "period": "M02", "value": "320.2"},
                            {"year": "2026", "period": "M13", "value": "319.9"},
                            {"year": "2026", "period": "M01", "value": "319.5"},
                        ],
                    }
                ]
            },
        }
        self.assertEqual(
            serve.parse_bls_series(payload, "CUSR0000SA0"),
            [
                {"date": "2026-01-01", "value": 319.5},
                {"date": "2026-02-01", "value": 320.2},
            ],
        )

    def test_bls_mapped_series_uses_fred_if_direct_api_fails(self):
        fred_result = {
            "provider": "FRED",
            "providerSeries": "CPIAUCSL",
            "observations": [{"date": "2026-07-01", "value": 333.0}],
            "firstDate": "2026-07-01",
            "lastDate": "2026-07-01",
            "latest": 333.0,
            "sourceUrl": "https://fred.test/CPIAUCSL",
        }
        with (
            patch.object(serve, "fetch_bls_series", side_effect=RuntimeError("BLS unavailable")),
            patch.object(serve, "fetch_fred_series", return_value=fred_result.copy()),
        ):
            result = serve.fetch_display_series(serve.CATALOG_BY_ID["CPIAUCSL"], None, None)
        self.assertEqual(result["provider"], "FRED")
        self.assertIn("Direct BLS API failed", result["fallbackReason"])

    def test_custom_concept_id_uses_real_fred_provider_id_on_bls_fallback(self):
        fred_result = {
            "provider": "FRED", "providerSeries": "CUSR0000SAH1",
            "observations": [{"date": "2026-07-01", "value": 410.0}],
            "firstDate": "2026-07-01", "lastDate": "2026-07-01", "latest": 410.0,
            "sourceUrl": "https://fred.stlouisfed.org/series/CUSR0000SAH1",
        }
        with patch.object(
            serve, "fetch_bls_series", side_effect=RuntimeError("BLS quota reached")
        ), patch.object(serve, "fetch_fred_series", return_value=fred_result.copy()) as fred:
            result = serve.fetch_display_series(serve.CATALOG_BY_ID["CPI_SHELTER"], None, None)
        fred.assert_called_once_with("CUSR0000SAH1", None, None)
        self.assertEqual(result["id"], "CPI_SHELTER")
        self.assertEqual(result["providerSeries"], "CUSR0000SAH1")

    def test_ppi_has_direct_bls_mapping(self):
        self.assertEqual(serve.CATALOG_BY_ID["PPIACO"]["bls"], "WPU00000000")


class FedProbabilityTests(unittest.TestCase):
    def test_indicative_yahoo_quotes_are_never_archived_as_history(self):
        summary = {
            "asOf": "2026-08-12",
            "futures": {"provider": "Yahoo Finance chart API"},
            "meetings": [{"date": "2026-09-16", "distribution": []}],
        }
        with patch.object(serve, "load_fed_history") as history_loader:
            serve.record_fed_snapshot(summary)
        history_loader.assert_not_called()

    def test_historical_strip_never_falls_through_to_current_yahoo_quotes(self):
        with (
            patch.object(serve, "today_local", return_value=date(2026, 8, 11)),
            patch.object(serve, "cache_get", side_effect=RuntimeError("CME unavailable")),
            patch.object(serve, "fetch_yahoo_fed_funds_strip") as yahoo,
        ):
            with self.assertRaisesRegex(RuntimeError, "Reliable historical FedWatch"):
                serve.fetch_fed_funds_strip(date(2026, 8, 3))
        yahoo.assert_not_called()

    def test_comparison_dates_anchor_to_actual_settlement(self):
        requested: list[date] = []

        def fake_summary(as_of, record=False):
            requested.append(as_of)
            actual = date(2026, 8, 10) if as_of == date(2026, 8, 11) else as_of
            return {
                "asOf": actual.isoformat(),
                "futures": {"provider": "test"},
                "meetings": [
                    {
                        "date": "2026-10-28",
                        "contract": "ZQV6",
                        "settlement": 96.2,
                        "distribution": [{"targetRange": "3.50%-3.75%", "probability": 50.0}],
                    }
                ],
            }

        with (
            patch.object(serve, "fed_summary", side_effect=fake_summary),
            patch.object(serve, "record_fed_snapshot"),
            patch.object(serve, "load_fed_history", return_value=[]),
            patch.object(
                serve,
                "cache_get",
                return_value={"history": [], "meta": {}, "sources": []},
            ),
        ):
            result = serve.fed_probability_history("2026-10-28", date(2026, 8, 11))
        self.assertEqual(
            requested,
            [date(2026, 8, 11), date(2026, 8, 7), date(2026, 8, 3), date(2026, 7, 10)],
        )
        self.assertEqual(
            [row["date"] for row in result["comparisons"]],
            ["2026-08-10", "2026-08-07", "2026-08-03", "2026-07-10"],
        )

    def test_indicative_history_uses_dated_contract_and_rate_observations(self):
        snapshot_date = "2026-08-10"

        def fake_contract(year, month, _start, _end):
            settle = 96.40 if (year, month) == (2026, 9) else 96.50
            return {
                "year": year,
                "monthNumber": month,
                "month": serve.month_key(year, month),
                "contract": serve.contract_code(year, month),
                "providerSymbol": serve.yahoo_contract_symbols(year, month)[0],
                "provider": "Yahoo Finance chart",
                "observations": [{"date": snapshot_date, "value": settle}],
                "firstDate": snapshot_date,
                "lastDate": snapshot_date,
                "latest": settle,
                "sourceUrl": "https://finance.yahoo.test/contract",
            }

        def fake_rate(series_id, _start, _end):
            values = {"EFFR": 3.63, "DFEDTARL": 3.50, "DFEDTARU": 3.75}
            return {
                "provider": "FRED",
                "providerSeries": series_id,
                "observations": [{"date": snapshot_date, "value": values[series_id]}],
                "firstDate": snapshot_date,
                "lastDate": snapshot_date,
                "latest": values[series_id],
                "sourceUrl": f"https://fred.test/{series_id}",
            }

        with (
            patch.object(serve, "today_local", return_value=date(2026, 8, 13)),
            patch.object(
                serve,
                "get_fomc_calendar",
                return_value={
                    "meetings": [date(2026, 9, 16)],
                    "provider": "test",
                    "sourceUrl": "https://fed.test/calendar",
                    "coverageEnd": "2026-09-16",
                },
            ),
            patch.object(serve, "fetch_yahoo_contract_history", side_effect=fake_contract),
            patch.object(serve, "fetch_fred_series", side_effect=fake_rate),
        ):
            result = serve.indicative_fed_probability_history(
                "2026-09-16",
                date(2026, 8, 13),
            )
        self.assertEqual(result["history"][0]["date"], snapshot_date)
        self.assertEqual(result["history"][0]["quality"], "indicative")
        self.assertAlmostEqual(
            sum(row["probability"] for row in result["history"][0]["distribution"]),
            100.0,
        )
        self.assertEqual(result["meta"]["observationCount"], 1)

    def test_missing_official_comparison_uses_labeled_indicative_date(self):
        current_summary = {
            "asOf": "2026-08-10",
            "futures": {"provider": "CME settlement API"},
            "meetings": [
                {
                    "date": "2026-10-28",
                    "contract": "ZQV6",
                    "distribution": [{"targetRange": "3.50%-3.75%", "probability": 50.0}],
                }
            ],
        }
        indicative = {
            "history": [
                {
                    "date": "2026-08-07",
                    "provider": "Yahoo Finance daily ZQ close + official rate history",
                    "quality": "indicative",
                    "distribution": [{"targetRange": "3.50%-3.75%", "probability": 48.0}],
                }
            ],
            "meta": {},
            "sources": [],
        }

        def fake_summary(requested, record=False):
            if requested == date(2026, 8, 11):
                return current_summary
            raise RuntimeError("Official dated strip unavailable")

        with (
            patch.object(serve, "fed_summary", side_effect=fake_summary),
            patch.object(serve, "record_fed_snapshot"),
            patch.object(serve, "load_fed_history", return_value=[]),
            patch.object(serve, "cache_get", return_value=indicative),
        ):
            result = serve.fed_probability_history("2026-10-28", date(2026, 8, 11))
        prior_day = next(row for row in result["comparisons"] if row["label"] == "Prior day")
        self.assertEqual(prior_day["date"], "2026-08-07")
        self.assertEqual(prior_day["quality"], "indicative")
        self.assertIn("Official dated strip unavailable", prior_day["officialError"])

    def test_cme_september_2022_worked_example(self):
        distribution = serve.node_move_distribution(2.3350, 3.0600)
        self.assertEqual([row["moveBps"] for row in distribution], [50, 75])
        self.assertAlmostEqual(distribution[0]["probability"], 0.10, places=8)
        self.assertAlmostEqual(distribution[1]["probability"], 0.90, places=8)

    def test_decision_day_is_counted_at_old_rate(self):
        strip = {
            "tradeDate": "2022-08-10",
            "contracts": [
                {"month": "SEP 22", "settle": 97.4475},
                {"month": "OCT 22", "settle": 96.9400},
            ],
        }
        results = serve.calculate_meeting_probabilities(strip, 2.33, 2.25, date(2022, 8, 10))
        september = results[0]
        self.assertEqual(september["date"], "2022-09-21")
        self.assertEqual(september["preMeetingDays"], 21)
        self.assertEqual(september["postMeetingDays"], 9)
        self.assertAlmostEqual(september["preMeetingRate"], 2.3350, places=4)
        self.assertAlmostEqual(september["impliedPostMeetingRate"], 3.0600, places=4)
        self.assertEqual(
            [(row["moveBps"], row["probability"]) for row in september["nodeDistribution"]],
            [(50, 10.0), (75, 90.0)],
        )

    def test_probability_convolution(self):
        first = {0: 0.5, 1: 0.5}
        second = [
            {"moveCount": 0, "probability": 0.75},
            {"moveCount": 1, "probability": 0.25},
        ]
        result = serve.convolve_move_distributions(first, second)
        self.assertEqual(result, {0: 0.375, 1: 0.5, 2: 0.125})

    def test_consecutive_meeting_months_use_non_meeting_anchor(self):
        strip = {
            "tradeDate": "2026-08-10",
            "contracts": [
                {"month": "SEP 26", "settle": 96.305},
                {"month": "OCT 26", "settle": 96.230},
                {"month": "NOV 26", "settle": 96.170},
            ],
        }
        results = serve.calculate_meeting_probabilities(strip, 3.63, 3.50, date(2026, 8, 10))
        september, october = results[:2]
        self.assertIn("NOV 26", october["postRateMethod"])
        self.assertEqual(len(september["distribution"]), 2)
        self.assertEqual(len(october["distribution"]), 3)
        self.assertAlmostEqual(
            sum(row["probability"] for row in october["distribution"]),
            100.0,
            places=6,
        )

    def test_meeting_on_settlement_date_is_already_decided(self):
        strip = {
            "tradeDate": "2026-09-16",
            "contracts": [
                {"month": "SEP 26", "settle": 96.30},
                {"month": "OCT 26", "settle": 96.23},
                {"month": "NOV 26", "settle": 96.17},
            ],
        }
        results = serve.calculate_meeting_probabilities(strip, 3.63, 3.50, date(2026, 9, 16))
        self.assertTrue(results)
        self.assertTrue(all(row["date"] > "2026-09-16" for row in results))

    def test_cme_mismatched_payload_date_is_rejected(self):
        settlement_row = {
            "month": "AUG 26",
            "settle": "96.3675",
            "volume": "1",
            "openInterest": "2",
        }

        def fake_cme(url, **_kwargs):
            if "08/07/2026" in url:
                return {
                    "tradeDate": "08/10/2026",
                    "reportType": "Final",
                    "settlements": [settlement_row],
                }
            return {
                "tradeDate": "08/06/2026",
                "reportType": "Final",
                "settlements": [settlement_row],
            }

        with patch.object(serve, "http_get_json", side_effect=fake_cme):
            result = serve.fetch_cme_settlements(date(2026, 8, 7))
        self.assertEqual(result["tradeDate"], "2026-08-06")

    def test_fed_summary_aligns_rates_to_actual_settlement_date(self):
        strip = {
            "provider": "test",
            "tradeDate": "2026-08-07",
            "requestedAsOf": "2026-08-08",
            "contracts": [],
            "sourceUrl": "https://example.test",
        }
        rates = {
            "effr": {"value": 3.63},
            "targetRange": {"lower": 3.5, "upper": 3.75, "label": "3.50%-3.75%"},
            "errors": [],
        }
        with (
            patch.object(serve, "fetch_fed_funds_strip", return_value=strip),
            patch.object(serve, "current_target_and_effr", return_value=rates) as rate_lookup,
            patch.object(
                serve,
                "get_fomc_calendar",
                return_value={
                    "meetings": serve.FOMC_MEETINGS,
                    "provider": "test calendar",
                    "sourceUrl": "https://example.test/calendar",
                    "liveMeetingCount": 0,
                    "coverageEnd": "2028-01-26",
                    "warning": None,
                },
            ),
            patch.object(serve, "calculate_meeting_probabilities", return_value=[]),
        ):
            result = serve.fed_summary(date(2026, 8, 8))
        rate_lookup.assert_called_once_with(date(2026, 8, 7))
        self.assertEqual(result["asOf"], "2026-08-07")

    def test_nyfed_parser_requires_typed_effr_record(self):
        payload = {
            "refRates": [
                {"type": "SOFR", "percentRate": 9.99, "effectiveDate": "2026-08-10"},
                {"type": "EFFR", "percentRate": 3.63, "effectiveDate": "2026-08-10"},
            ]
        }
        row = serve.find_nyfed_effr_row(payload)
        self.assertEqual(row["type"], "EFFR")
        self.assertEqual(row["percentRate"], 3.63)

    def test_fomc_calendar_parser_uses_decision_day_and_excludes_notation_vote(self):
        html = """
        <h4><a>2026 FOMC Meetings</a></h4>
        <div class="row fomc-meeting">
          <div class="fomc-meeting__month"><strong>September</strong></div>
          <div class="fomc-meeting__date">15-16*</div>
        </div>
        <div class="row fomc-meeting">
          <div class="fomc-meeting__month"><strong>October</strong></div>
          <div class="fomc-meeting__date">27-28</div>
        </div>
        <div class="row fomc-meeting">
          <div class="fomc-meeting__month"><strong>November</strong></div>
          <div class="fomc-meeting__date">2 (notation vote)</div>
        </div>
        <h4><a>2024 FOMC Meetings</a></h4>
        <div class="row fomc-meeting">
          <div class="fomc-meeting__month"><strong>Apr/May</strong></div>
          <div class="fomc-meeting__date">30-1</div>
        </div>
        Note: A two-day meeting is scheduled for January 25-26, 2028.
        """
        self.assertEqual(
            serve.parse_fomc_calendar_html(html),
            [
                date(2024, 5, 1),
                date(2026, 9, 16),
                date(2026, 10, 28),
                date(2028, 1, 26),
            ],
        )

    def test_live_fomc_year_replaces_bundled_dates_for_that_year(self):
        replacement = date(2026, 9, 17)
        with patch.object(serve, "cache_get", return_value=[replacement]):
            result = serve.get_fomc_calendar()
        self.assertIn(replacement, result["meetings"])
        self.assertNotIn(date(2026, 9, 16), result["meetings"])


class TransportTests(unittest.TestCase):
    def test_windows_10013_is_classified_as_policy_denial(self):
        self.assertTrue(data_core._permission_denied(RuntimeError("[WinError 10013] socket denied")))

    def test_generic_connection_failure_is_not_policy_denial(self):
        with (
            patch.object(data_core, "_urllib_get", side_effect=RuntimeError("connection timed out")),
            patch.object(data_core, "_curl_get", side_effect=RuntimeError("connection timed out")),
        ):
            with self.assertRaises(data_core.HttpFetchError):
                data_core.http_get("https://example.invalid/test", cache_enabled=False, allow_stale=False)

    def test_api_key_is_redacted_from_transport_errors(self):
        leaked = "https://api.example.test/data?api_key=SUPERSECRET&x=1"
        with (
            patch.object(data_core, "_urllib_get", side_effect=RuntimeError(leaked)),
            patch.object(data_core, "_curl_get", side_effect=RuntimeError(leaked)),
        ):
            with self.assertRaises(data_core.HttpFetchError) as raised:
                data_core.http_get(
                    "https://api.example.test/data",
                    params={"api_key": "SUPERSECRET", "x": 1},
                    cache_enabled=False,
                    allow_stale=False,
                )
        self.assertNotIn("SUPERSECRET", str(raised.exception))
        self.assertIn("REDACTED", str(raised.exception))

    def test_settings_are_outside_static_app_directory(self):
        self.assertNotEqual(data_core.SETTINGS_PATH.parent, data_core.APP_DIR)


if __name__ == "__main__":
    unittest.main()
