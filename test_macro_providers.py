from __future__ import annotations

import io
import unittest
import zipfile
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import macro_providers
import serve


def sample_dfa_zip() -> bytes:
    rows = [
        "Date,Category,Net worth,Assets,Real estate,Consumer durables,Corporate equities and mutual fund shares,DB pension entitlements,DC pension entitlements,Unincorporated businesses,Other assets,Liabilities,Home mortgages,Consumer credit,Other liabilities",
        "2025:Q4,TopPt1,10,10,0,0,0,0,0,0,0,0,0,0,0",
        "2025:Q4,RemainingTop1,20,20,0,0,0,0,0,0,0,0,0,0,0",
        "2025:Q4,Next9,30,30,0,0,0,0,0,0,0,0,0,0,0",
        "2025:Q4,Next40,25,25,0,0,0,0,0,0,0,0,0,0,0",
        "2025:Q4,Bottom50,15,15,0,0,0,0,0,0,0,0,0,0,0",
    ]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("dfa-networth-levels.csv", "\n".join(rows))
    return output.getvalue()


def sample_dfa_component_zip() -> bytes:
    rows = [
        "Date,Category,Net worth,Assets,Real estate,Consumer durables,Corporate equities and mutual fund shares,DB pension entitlements,DC pension entitlements,Unincorporated businesses,Other assets,Liabilities,Home mortgages,Consumer credit,Other liabilities",
        "2025:Q4,TopPt1,10,12,2,0,0,0,0,0,0,2,1,1,0",
        "2025:Q4,RemainingTop1,20,24,4,0,0,0,0,0,0,4,2,2,0",
        "2025:Q4,Next9,30,36,6,0,0,0,0,0,0,6,3,3,0",
        "2025:Q4,Next40,25,30,5,0,0,0,0,0,0,5,2,3,0",
        "2025:Q4,Bottom50,15,18,3,0,0,0,0,0,0,3,1,2,0",
    ]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("dfa-networth-levels.csv", "\n".join(rows))
    return output.getvalue()


def _excel_serial(value: date) -> int:
    return (value - date(1899, 12, 30)).days


def _inline_cell(reference: str, value: str) -> str:
    return f'<c r="{reference}" t="inlineStr"><is><t>{value}</t></is></c>'


def _number_cell(reference: str, value: float) -> str:
    return f'<c r="{reference}"><v>{value}</v></c>'


def sample_sp_workbook() -> bytes:
    rows = {
        1: [_inline_cell("A1", "S&amp;P Dow Jones Indices")],
        2: [
            _inline_cell("A2", "Data as of the close of:"),
            _number_cell("B2", _excel_serial(date(2025, 10, 15))),
        ],
        3: [
            _inline_cell("A3", "Historical actuals:"),
            _number_cell("B3", _excel_serial(date(2025, 6, 30))),
        ],
        6: [
            _inline_cell("A6", "INDEX NAME"),
            _inline_cell("C6", "2024 Q4"),
            _inline_cell("D6", "2025 Q1"),
            _inline_cell("E6", "2025 Q2"),
            _inline_cell("F6", "2025E Q3"),
        ],
        8: [
            _inline_cell("A8", "S&amp;P 500"),
            _number_cell("C8", 50),
            _number_cell("D8", 55),
            _number_cell("E8", 60),
            _number_cell("F8", 65),
        ],
        10: [
            _inline_cell("A10", "S&amp;P 500 Consumer Staples"),
            _number_cell("C10", 5),
            _number_cell("D10", 6),
            _number_cell("E10", 7),
            _number_cell("F10", 8),
        ],
        15: [
            _inline_cell("A15", "S&amp;P 500 Information Technology"),
            _number_cell("C15", 20),
            _number_cell("D15", 22),
            _number_cell("E15", 25),
            _number_cell("F15", 27),
        ],
    }
    sector_sheet_rows = "".join(
        f'<row r="{row_number}">{"".join(cells)}</row>'
        for row_number, cells in sorted(rows.items())
    )
    sector_sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{sector_sheet_rows}</sheetData></worksheet>"
    )
    contribution_rows = {
        20: [_inline_cell("A20", "OPERATING EARNINGS CONTRIBUTION")],
        22: [
            _number_cell("C22", _excel_serial(date(2024, 12, 31))),
            _number_cell("D22", _excel_serial(date(2025, 3, 31))),
            _number_cell("E22", _excel_serial(date(2025, 6, 30))),
            _number_cell("F22", _excel_serial(date(2025, 9, 30))),
        ],
        23: [
            _inline_cell("A23", "Consumer Staples"),
            _number_cell("C23", 0.1),
            _number_cell("D23", 0.1),
            _number_cell("E23", 0.1),
            _number_cell("F23", 0.1),
        ],
        24: [
            _inline_cell("A24", "Information Technology"),
            _number_cell("C24", 0.3),
            _number_cell("D24", 0.3),
            _number_cell("E24", 0.3),
            _number_cell("F24", 0.3),
        ],
        25: [
            _inline_cell("A25", "S&amp;P 500"),
            _number_cell("C25", 1),
            _number_cell("D25", 1),
            _number_cell("E25", 1),
            _number_cell("F25", 1),
        ],
    }
    contribution_sheet_rows = "".join(
        f'<row r="{row_number}">{"".join(cells)}</row>'
        for row_number, cells in sorted(contribution_rows.items())
    )
    contribution_sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{contribution_sheet_rows}</sheetData></worksheet>"
    )
    quarterly_rows = {
        4: [_inline_cell("B4", "OPERATING"), _inline_cell("C4", "AS REPORTED")],
        6: [
            _number_cell("A6", _excel_serial(date(2023, 12, 31))),
            _number_cell("B6", 90),
            _number_cell("C6", 45),
        ],
        7: [
            _number_cell("A7", _excel_serial(date(2024, 12, 31))),
            _number_cell("B7", 100),
            _number_cell("C7", 50),
        ],
        8: [
            _number_cell("A8", _excel_serial(date(2025, 3, 31))),
            _number_cell("B8", 110),
            _number_cell("C8", 55),
        ],
        9: [
            _number_cell("A9", _excel_serial(date(2025, 6, 30))),
            _number_cell("B9", 120),
            _number_cell("C9", 60),
        ],
        10: [
            _number_cell("A10", _excel_serial(date(2025, 9, 30))),
            _number_cell("B10", 130),
            _number_cell("C10", 65),
        ],
    }
    quarterly_sheet_rows = "".join(
        f'<row r="{row_number}">{"".join(cells)}</row>'
        for row_number, cells in sorted(quarterly_rows.items())
    )
    quarterly_sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{quarterly_sheet_rows}</sheetData></worksheet>"
    )
    sales_quarters = [
        date(2023, 12, 31),
        date(2024, 12, 31),
        date(2025, 3, 31),
        date(2025, 6, 30),
        date(2025, 9, 30),
    ]
    sector_shares = {
        "ENERGY": 0.6 / 9,
        "MATERIALS": 0.6 / 9,
        "INDUSTRIALS": 0.6 / 9,
        "CONSUMER DISCRETIONARY": 0.6 / 9,
        "CONSUMER STAPLES": 0.1,
        "HEALTH CARE": 0.6 / 9,
        "FINANCIALS": 0.6 / 9,
        "INFORMATION TECHNOLOGY": 0.3,
        "COMMUNICATION SERVICES": 0.6 / 9,
        "UTILITIES": 0.6 / 9,
        "REAL ESTATE*": 0.6 / 9,
    }
    columns = ["C", "D", "E", "F", "G"]
    sales_rows = {
        20: [
            _inline_cell("A20", "QUARTERLY OPERATING MARGINS"),
            *[
                _number_cell(f"{column}20", _excel_serial(quarter))
                for column, quarter in zip(columns, sales_quarters)
            ],
        ],
        35: [
            _inline_cell("A35", "OPERATING SALES CONTRIBUTION"),
            *[
                _number_cell(f"{column}35", _excel_serial(quarter))
                for column, quarter in zip(columns, sales_quarters)
            ],
        ],
    }
    for offset, (label, share) in enumerate(sector_shares.items()):
        margin_row = 21 + offset
        sales_row = 36 + offset
        sales_rows[margin_row] = [
            _inline_cell(f"A{margin_row}", label),
            *[_number_cell(f"{column}{margin_row}", 0.1) for column in columns],
        ]
        sales_rows[sales_row] = [
            _inline_cell(f"A{sales_row}", label),
            *[_number_cell(f"{column}{sales_row}", share) for column in columns],
        ]
    sales_rows[32] = [
        _inline_cell("A32", "S&amp;P 500"),
        *[_number_cell(f"{column}32", 0.1) for column in columns],
    ]
    sales_rows[47] = [
        _inline_cell("A47", "S&amp;P 500"),
        *[_number_cell(f"{column}47", 1.0) for column in columns],
    ]
    sales_sheet_rows = "".join(
        f'<row r="{row_number}">{"".join(cells)}</row>'
        for row_number, cells in sorted(sales_rows.items())
    )
    sales_sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{sales_sheet_rows}</sheetData></worksheet>"
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="SECTOR EPS" sheetId="1" r:id="rId1"/>'
        '<sheet name="ESTIMATES&amp;PEs" sheetId="2" r:id="rId2"/>'
        '<sheet name="QUARTERLY DATA" sheetId="3" r:id="rId3"/>'
        '<sheet name="SALES" sheetId="4" r:id="rId4"/></sheets></workbook>'
    )
    relationships_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet3.xml"/>'
        '<Relationship Id="rId4" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet4.xml"/></Relationships>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet3.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet4.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>'
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", relationships_xml)
        archive.writestr("xl/worksheets/sheet1.xml", sector_sheet_xml)
        archive.writestr("xl/worksheets/sheet2.xml", contribution_sheet_xml)
        archive.writestr("xl/worksheets/sheet3.xml", quarterly_sheet_xml)
        archive.writestr("xl/worksheets/sheet4.xml", sales_sheet_xml)
    return output.getvalue()


class ProviderResolverTests(unittest.TestCase):
    def test_exact_sp_earnings_ex_sector_prompt_never_routes_to_fred(self):
        prompt = "chart s&p earnings versus s&p earnings ex tech and consumer staples for 25 years"
        selected, notices = serve.resolve_prompt_series(prompt)
        self.assertEqual(
            [entry["id"] for entry in selected],
            [
                "SP500:OPERATING_EPS",
                "SP500:OPERATING_EPS_EX_INFORMATION_TECHNOLOGY_CONSUMER_STAPLES",
            ],
        )
        self.assertTrue(all(entry["primary"] == "sp-earnings" for entry in selected))
        self.assertNotIn("SP500", [entry["id"] for entry in selected])
        self.assertTrue(any("FRED search was not used" in notice for notice in notices))
        chart_config = serve.parse_chart_intent(prompt, selected)
        self.assertTrue(all(row["units"] == "raw" for row in chart_config["series"]))

    def test_sp_earnings_language_variants_use_index_fundamentals(self):
        cases = {
            "s&p 500 earnings versus s&p 500 earnings ex technology and consumer staples over last 15 years": [
                "SP500:OPERATING_EPS",
                "SP500:OPERATING_EPS_EX_INFORMATION_TECHNOLOGY_CONSUMER_STAPLES",
            ],
            "S and P 500 profits versus S&P profits without tech and staples over the past 10 years": [
                "SP500:OPERATING_EPS",
                "SP500:OPERATING_EPS_EX_INFORMATION_TECHNOLOGY_CONSUMER_STAPLES",
            ],
            "SPX EPS less energy and financials": [
                "SP500:OPERATING_EPS_EX_ENERGY_FINANCIALS",
            ],
            "compare Standard & Poor's 500 earnings with and without health care": [
                "SP500:OPERATING_EPS",
                "SP500:OPERATING_EPS_EX_HEALTH_CARE",
            ],
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, _ = serve.resolve_prompt_series(prompt)
                self.assertEqual([entry["id"] for entry in selected], expected)
                self.assertTrue(all(entry["primary"] == "sp-earnings" for entry in selected))

    def test_sector_only_sp_earnings_does_not_add_total_index_earnings(self):
        selected, _ = serve.resolve_prompt_series("chart S&P 500 technology earnings for 10 years")
        self.assertEqual(
            [entry["id"] for entry in selected],
            ["SP500:OPERATING_EPS:INFORMATION_TECHNOLOGY"],
        )
        self.assertEqual(selected[0]["sectorIndex"], "information technology")

    def test_sp_valuation_ratio_is_not_mislabeled_as_earnings_per_share(self):
        selected, _ = serve.resolve_prompt_series("S&P 500 price to earnings ratio")
        self.assertNotIn("SP500:OPERATING_EPS", [entry["id"] for entry in selected])

    def test_unsupported_sp_exclusion_never_uses_an_unrelated_substitute(self):
        selected, notices = serve.resolve_prompt_series(
            "S&P 500 earnings versus earnings ex semiconductors over last 10 years"
        )
        self.assertEqual([entry["id"] for entry in selected], ["SP500:OPERATING_EPS"])
        self.assertTrue(all(entry["primary"] == "sp-earnings" for entry in selected))
        self.assertTrue(any("No unrelated market index or FRED series" in notice for notice in notices))

    def test_sp_ex_sector_parser_supports_other_sector_combinations(self):
        selected, _ = serve.resolve_prompt_series(
            "S&P 500 EPS versus S&P 500 EPS ex energy and financials for 15 years"
        )
        derived = selected[1]
        self.assertEqual(derived["excludedSectors"], ["energy", "financials"])
        self.assertEqual(
            derived["spWorkbookRows"],
            ["S&P 500"],
        )
        self.assertIn("contribution share", derived["formula"])

    def test_explicit_ticker_fundamental_routes_to_sec(self):
        selected, notices = serve.resolve_prompt_series("chart $AAPL revenue and net income for 15 years")
        self.assertEqual(
            [entry["id"] for entry in selected],
            ["SEC:AAPL:revenue", "SEC:AAPL:net-income"],
        )
        self.assertTrue(any("SEC Company Facts" in notice for notice in notices))

    def test_cross_country_metric_routes_to_world_bank(self):
        selected, notices = serve.resolve_prompt_series("compare China and Japan GDP per capita")
        self.assertEqual(
            [entry["id"] for entry in selected],
            [
                "WORLD_BANK:CHN:NY.GDP.PCAP.CD",
                "WORLD_BANK:JPN:NY.GDP.PCAP.CD",
            ],
        )
        self.assertTrue(any("World Bank API" in notice for notice in notices))

    def test_real_gdp_per_capita_uses_constant_dollar_world_bank_indicator(self):
        selected, _ = serve.resolve_prompt_series("China and Japan real GDP per capita")
        self.assertEqual(
            [entry["id"] for entry in selected],
            [
                "WORLD_BANK:CHN:NY.GDP.PCAP.KD",
                "WORLD_BANK:JPN:NY.GDP.PCAP.KD",
            ],
        )

    def test_world_bank_uses_dynamic_geographies_and_never_defaults_unknown_scope_to_us(self):
        dynamic = {
            "kenya": ("KEN", "Kenya"),
            "nigeria": ("NGA", "Nigeria"),
            "indonesia": ("IDN", "Indonesia"),
        }
        with patch.object(macro_providers, "_world_bank_country_catalog", return_value=dynamic):
            cases = {
                "Kenya GDP per capita": "WORLD_BANK:KEN:NY.GDP.PCAP.CD",
                "Nigeria life expectancy": "WORLD_BANK:NGA:SP.DYN.LE00.IN",
                "Indonesia internet users": "WORLD_BANK:IDN:IT.NET.USER.ZS",
            }
            for prompt, expected in cases.items():
                with self.subTest(prompt=prompt):
                    selected, _ = serve.resolve_prompt_series(prompt, allow_fred_search=False)
                    self.assertEqual([entry["id"] for entry in selected], [expected])
            selected, notices = serve.resolve_prompt_series(
                "GDP per capita in Wakanda",
                allow_fred_search=False,
            )
            self.assertEqual(selected, [])
            self.assertTrue(any("United States data was not substituted" in row for row in notices))

    def test_world_bank_specific_modifiers_select_compatible_indicators(self):
        cases = {
            "India youth unemployment": "WORLD_BANK:IND:SL.UEM.1524.ZS",
            "India GDP per capita PPP": "WORLD_BANK:IND:NY.GDP.PCAP.PP.CD",
            "India real GDP per capita PPP": "WORLD_BANK:IND:NY.GDP.PCAP.PP.KD",
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                selected, _ = serve.resolve_prompt_series(prompt, allow_fred_search=False)
                self.assertEqual([entry["id"] for entry in selected], [expected])

    def test_sec_rejects_unsupported_frequency_and_geographic_segments(self):
        for prompt in ("quarterly $MSFT revenue", "$AAPL revenue in China"):
            with self.subTest(prompt=prompt):
                entries, notices = macro_providers.resolve_special_series(prompt)
                self.assertEqual(entries, [])
                self.assertTrue(any("not substituted" in row for row in notices))


class SpWorkbookTests(unittest.TestCase):
    def test_parser_reads_actual_cutoff_and_sector_rows(self):
        parsed = macro_providers.parse_sp_sector_workbook(sample_sp_workbook())
        self.assertEqual(parsed["actualThrough"], date(2025, 6, 30))
        self.assertEqual(parsed["dataAsOf"], date(2025, 10, 15))
        self.assertEqual(parsed["rows"]["S&P 500"][date(2025, 6, 30)], 60)

    def test_contribution_parser_uses_additive_shares(self):
        parsed = macro_providers.parse_sp_earnings_contributions(sample_sp_workbook())
        self.assertEqual(
            parsed["rows"]["information technology"][date(2025, 6, 30)],
            0.3,
        )
        self.assertEqual(parsed["validation"]["status"], "pass")

    def test_sales_tables_reconstruct_and_validate_older_contribution_history(self):
        parsed = macro_providers.parse_sp_sales_earnings_contributions(sample_sp_workbook())
        self.assertEqual(parsed["firstQuarter"], date(2023, 12, 31))
        self.assertAlmostEqual(
            parsed["rows"]["information technology"][date(2023, 12, 31)],
            0.3,
        )
        self.assertEqual(parsed["validation"]["status"], "pass")

    def test_quarterly_parser_uses_operating_not_as_reported_eps(self):
        parsed = macro_providers.parse_sp_quarterly_operating_eps(sample_sp_workbook())
        self.assertEqual(parsed["rows"][date(2025, 6, 30)], 120)

    def test_derived_series_uses_contribution_weights_and_excludes_estimates(self):
        entry = {
            "id": "SP500:OPERATING_EPS_EX_INFORMATION_TECHNOLOGY_CONSUMER_STAPLES",
            "name": "S&P 500 Operating EPS Ex Information Technology and Consumer Staples",
            "unit": "Operating earnings per index share",
            "origin": "S&P Dow Jones Indices",
            "spWorkbookRows": ["S&P 500"],
            "excludedSectors": ["information technology", "consumer staples"],
            "formula": "total * (1 - tech share - staples share)",
            "resolution": "test",
        }
        metadata = {
            "archiveUrl": "https://web.archive.org/example.xlsx",
            "archiveTimestamp": "20260101000000",
        }
        with patch.object(
            macro_providers,
            "fetch_sp_workbook",
            return_value=(sample_sp_workbook(), metadata),
        ), patch.object(
            macro_providers,
            "fetch_sp_historical_contribution_workbook",
            return_value=(sample_sp_workbook(), metadata),
        ):
            result = macro_providers.fetch_sp_earnings_series(
                entry,
                date(2023, 1, 1),
                date(2026, 1, 1),
            )
        self.assertEqual(
            result["observations"],
            [
                {"date": "2023-12-31", "value": 54.0},
                {"date": "2024-12-31", "value": 60.0},
                {"date": "2025-03-31", "value": 66.0},
                {"date": "2025-06-30", "value": 72.0},
            ],
        )
        self.assertEqual(result["actualThrough"], "2025-06-30")
        self.assertEqual(result["calculationValidation"]["status"], "pass")

    def test_standalone_sector_series_uses_sector_eps_not_total_index_eps(self):
        entry = {
            "id": "SP500:OPERATING_EPS:INFORMATION_TECHNOLOGY",
            "name": "S&P 500 Information Technology Sector Operating Earnings per Share",
            "unit": "Operating earnings per index share",
            "origin": "S&P Dow Jones Indices",
            "spWorkbookRows": ["S&P 500 Information Technology"],
            "sectorIndex": "information technology",
            "formula": "Standalone sector-index operating EPS",
            "resolution": "test",
        }
        metadata = {
            "archiveUrl": "https://web.archive.org/example.xlsx",
            "archiveTimestamp": "20260101000000",
        }
        with patch.object(
            macro_providers,
            "fetch_sp_workbook",
            return_value=(sample_sp_workbook(), metadata),
        ):
            result = macro_providers.fetch_sp_earnings_series(
                entry,
                date(2024, 1, 1),
                date(2026, 1, 1),
            )
        self.assertEqual(
            result["observations"],
            [
                {"date": "2024-12-31", "value": 20.0},
                {"date": "2025-03-31", "value": 22.0},
                {"date": "2025-06-30", "value": 25.0},
            ],
        )


class SecCompanyFactsTests(unittest.TestCase):
    def test_sec_series_keeps_annual_facts_and_backfills_older_concepts(self):
        entry = {
            "id": "SEC:AAPL:revenue",
            "name": "AAPL Revenue",
            "unit": "U.S. dollars",
            "origin": "U.S. Securities and Exchange Commission",
            "ticker": "AAPL",
            "secMetric": "revenue",
            "resolution": "test",
        }
        payload = {
            "entityName": "Apple Inc.",
            "facts": {
                "us-gaap": {
                    "RevenueFromContractWithCustomerExcludingAssessedTax": {
                        "units": {
                            "USD": [
                                {
                                    "start": "2024-01-01",
                                    "end": "2024-12-31",
                                    "val": 120,
                                    "form": "10-K",
                                    "fp": "FY",
                                    "filed": "2025-02-01",
                                },
                                {
                                    "start": "2024-10-01",
                                    "end": "2024-12-31",
                                    "val": 40,
                                    "form": "10-K",
                                    "fp": "FY",
                                    "filed": "2025-02-01",
                                },
                            ]
                        }
                    },
                    "SalesRevenueNet": {
                        "units": {
                            "USD": [
                                {
                                    "start": "2012-01-01",
                                    "end": "2012-12-31",
                                    "val": 60,
                                    "form": "10-K",
                                    "fp": "FY",
                                    "filed": "2013-02-01",
                                }
                            ]
                        }
                    },
                }
            },
        }
        with patch.object(
            macro_providers,
            "_sec_ticker_map",
            return_value={"AAPL": {"cik_str": 320193, "title": "Apple Inc."}},
        ), patch.object(macro_providers, "_load_json_url", return_value=payload):
            result = macro_providers.fetch_sec_companyfacts_series(
                entry,
                date(2010, 1, 1),
                date(2025, 12, 31),
            )
        self.assertEqual(
            [(row["date"], row["value"]) for row in result["observations"]],
            [("2012-12-31", 60.0), ("2024-12-31", 120.0)],
        )
        self.assertIn("SalesRevenueNet", result["providerSeries"])
        self.assertIn(
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            result["providerSeries"],
        )


class DistributionalFinancialAccountsTests(unittest.TestCase):
    def test_quantitative_qualifiers_preserve_percent_count_and_duration(self):
        qualifiers = macro_providers.extract_quantitative_qualifiers(
            "top ten percent households, top 10 households, 25 basis points, over thirty years"
        )
        self.assertEqual(
            [(row["kind"], row["value"]) for row in qualifiers],
            [
                ("population_percentile", 10.0),
                ("basis_points", 25.0),
                ("duration", 30.0),
                ("rank_count", 10.0),
            ],
        )

    def test_wealth_groups_accept_equivalent_percentile_wording(self):
        cases = {
            "top 10% household wealth": "top_10",
            "top ten percent household wealth": "top_10",
            "top ten pct household wealth": "top_10",
            "top 10 pct. household wealth": "top_10",
            "wealthiest decile household net worth": "top_10",
            "90th percentile and above net worth": "top_10",
            "bottom 50% household wealth": "bottom_50",
            "bottom fifty percent household wealth": "bottom_50",
            "bottom fifty percentage household wealth": "bottom_50",
            "lower half household net worth": "bottom_50",
            "50th percentile and below household wealth": "bottom_50",
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                entries, _ = macro_providers.resolve_special_series(prompt)
                self.assertEqual([entry["dfaGroupKey"] for entry in entries], [expected])

    def test_one_hundred_twenty_eight_wealth_query_variants_preserve_groups(self):
        top_forms = (
            "top 10%",
            "top ten percent",
            "top-ten-percent",
            "upper tenth",
            "top decile",
            "richest 10%",
            "wealthiest decile",
            "90th percentile and above",
        )
        bottom_forms = (
            "bottom 50%",
            "bottom fifty percent",
            "bottom-fifty-percent",
            "lower half",
            "bottom half",
            "poorest 50%",
            "50th percentile and below",
            "poorest half",
        )
        wealth_forms = ("household wealth", "household net worth", "net worth", "wealth")
        request_forms = (
            "graph {group} {wealth}",
            "compare {wealth} held by the {group}",
        )
        cases = [
            (template.format(group=group, wealth=wealth), expected)
            for expected, groups in (("top_10", top_forms), ("bottom_50", bottom_forms))
            for group in groups
            for wealth in wealth_forms
            for template in request_forms
        ]
        self.assertEqual(len(cases), 128)
        for prompt, expected in cases:
            with self.subTest(prompt=prompt):
                entries, _ = macro_providers.resolve_special_series(prompt)
                self.assertEqual([entry["dfaGroupKey"] for entry in entries], [expected])

    def test_native_percentile_intervals_resolve_by_bounds_not_phrase_shape(self):
        cases = {
            "wealth between 90th and 100th percentiles": "top_10",
            "wealth from 0 to 50 percentiles": "bottom_50",
            "wealth 99th-100th percentiles": "top_1",
            "wealth percentiles 99.9 through 100": "top_0_1",
            "wealth from 90th through 99th percentiles": "next_9",
            "wealth 50-90 percentiles": "next_40",
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                entries, _ = macro_providers.resolve_special_series(prompt)
                self.assertEqual([entry["dfaGroupKey"] for entry in entries], [expected])
                selectors = macro_providers.extract_population_selectors(prompt)
                self.assertEqual(len(selectors), 1)
                self.assertEqual(selectors[0]["kind"], "percentile_band")

    def test_top_ten_households_is_not_treated_as_top_ten_percent(self):
        entries, _ = macro_providers.resolve_special_series(
            "show the top 10 households by wealth"
        )
        self.assertEqual(entries, [])

    def test_dfa_level_aggregation_uses_exact_native_groups(self):
        entries, _ = macro_providers.resolve_special_series(
            "top 10% household wealth versus bottom 50% household wealth"
        )
        with patch.object(
            macro_providers,
            "http_get_bytes",
            return_value=SimpleNamespace(content=sample_dfa_zip(), warning=""),
        ):
            results = [macro_providers.fetch_fed_dfa_series(entry, None, None) for entry in entries]
        self.assertEqual([row["latest"] for row in results], [60.0, 15.0])
        self.assertEqual(
            results[0]["formula"],
            "TopPt1 + RemainingTop1 + Next9",
        )

    def test_dfa_share_is_derived_from_levels_without_rounded_share_error(self):
        prompts = (
            "share of total wealth held by the top 10%",
            "share of household wealth held by the top 10%",
            "percentage of household wealth owned by the top 10%",
            "household wealth share held by the top 10%",
        )
        for prompt in prompts:
            with self.subTest(prompt=prompt):
                entries, _ = macro_providers.resolve_special_series(prompt)
                self.assertEqual(entries[0]["dfaMode"], "shares")
                self.assertEqual(entries[0]["unit"], "Percent of aggregate")
        entries, _ = macro_providers.resolve_special_series(prompts[0])
        with patch.object(
            macro_providers,
            "http_get_bytes",
            return_value=SimpleNamespace(content=sample_dfa_zip(), warning=""),
        ):
            result = macro_providers.fetch_fed_dfa_series(entries[0], None, None)
        self.assertEqual(result["unit"], "Percent of aggregate")
        self.assertAlmostEqual(result["latest"], 60.0)
        self.assertIn("all five DFA wealth groups", result["formula"])

    def test_dfa_component_exclusion_is_calculated_instead_of_ignored(self):
        entries, _ = macro_providers.resolve_special_series(
            "top 10% household wealth excluding real estate"
        )
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["dfaMeasureFormula"], "Net worth - Real estate")
        self.assertEqual(entries[0]["fredFallbackComponents"], [])
        with patch.object(
            macro_providers,
            "http_get_bytes",
            return_value=SimpleNamespace(content=sample_dfa_component_zip(), warning=""),
        ):
            result = macro_providers.fetch_fed_dfa_series(entries[0], None, None)
        self.assertEqual(result["latest"], 48.0)
        self.assertIn("Net worth - Real estate", result["formula"])

    def test_dfa_mixed_supported_and_unsupported_exclusions_fail_closed(self):
        entries, notices = macro_providers.resolve_special_series(
            "top 10% household wealth excluding real estate and collectibles"
        )
        self.assertEqual(entries, [])
        self.assertTrue(any("no partially matched formula" in notice for notice in notices))

    def test_dfa_generic_pensions_excludes_both_official_pension_components(self):
        entries, _ = macro_providers.resolve_special_series(
            "top 10% household wealth excluding real estate and pensions over 10 years"
        )
        self.assertEqual(len(entries), 1)
        self.assertEqual(
            [term["column"] for term in entries[0]["dfaTerms"]],
            ["Net worth", "Real estate", "DB pension entitlements", "DC pension entitlements"],
        )


if __name__ == "__main__":
    unittest.main()
