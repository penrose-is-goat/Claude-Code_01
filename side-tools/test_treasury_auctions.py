from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import treasury_auctions as ta


FISCAL_30Y_REOPENING = {
    "cusip": "912810UK2",
    "auction_date": "2025-07-10",
    "announcemt_date": "2025-07-02",
    "issue_date": "2025-07-15",
    "maturity_date": "2055-05-15",
    "security_type": "Bond",
    "security_term": "29-Year 10-Month",
    "original_security_term": "30-Year",
    "reopening": "Yes",
    "bid_to_cover_ratio": "2.380000",
    "high_yield": "4.8890",
    "offering_amt": "22000000000",
    "comp_accepted": "21985000000",
    "direct_bidder_accepted": "3210000000",
    "indirect_bidder_accepted": "13500000000",
    "primary_dealer_accepted": "5275000000",
    "soma_accepted": "2603000000",
    "pdf_filenm_comp_results": "R_20250710_3.pdf",
    "pdf_filenm_announcemt": "A_20250702_1.pdf",
    "record_date": "2025-07-15",
}

TREASURY_BILL = {
    "cusip": "912797VC8",
    "auctionDate": "2026-08-13T00:00:00",
    "announcementDate": "2026-08-11T00:00:00",
    "issueDate": "2026-08-18T00:00:00",
    "maturityDate": "2026-09-15T00:00:00",
    "securityType": "Bill",
    "securityTerm": "4-Week",
    "originalSecurityTerm": "17-Week",
    "reopening": "Yes",
    "cashManagementBillCMB": "No",
    "bidToCoverRatio": "2.770000",
    "highDiscountRate": "3.625000",
    "highInvestmentRate": "3.686000",
    "offeringAmount": "110000000000",
    "competitiveTendered": "297190817000",
    "competitiveAccepted": "102197112000",
    "totalTendered": "313166074500",
    "totalAccepted": "118172369500",
    "directBidderAccepted": "8079230000",
    "indirectBidderAccepted": "58360242000",
    "primaryDealerAccepted": "35757640000",
    "somaAccepted": "8172144200",
    "pdfFilenameCompetitiveResults": "R_20260813_2.pdf",
    "updatedTimestamp": "2026-08-13T11:33:12",
}


class NormalizationTests(unittest.TestCase):
    def test_30_year_reopening_uses_original_term(self):
        row = ta.normalize_auction(FISCAL_30Y_REOPENING, "Fiscal Data")
        self.assertEqual(row["term"], "30-Year")
        self.assertEqual(row["securityTerm"], "29-Year 10-Month")
        self.assertTrue(row["reopening"])
        self.assertEqual(row["stopOutLabel"], "High yield")
        self.assertEqual(row["stopOutValue"], 4.889)
        self.assertEqual(row["bidToCoverRatio"], 2.38)
        self.assertEqual(row["somaAccepted"], 2_603_000_000)

    def test_bill_preserves_rate_conventions(self):
        row = ta.normalize_auction(TREASURY_BILL, "TreasuryDirect")
        self.assertEqual(row["type"], "Bill")
        self.assertEqual(row["stopOutLabel"], "High discount rate")
        self.assertEqual(row["stopOutValue"], 3.625)
        self.assertEqual(row["highInvestmentRate"], 3.686)
        self.assertNotEqual(row["stopOutValue"], row["highInvestmentRate"])
        self.assertAlmostEqual(row["indirectBidderShare"], 57.106, places=3)

    def test_missing_values_remain_null(self):
        row = ta.normalize_auction(
            {"cusip": "912345678", "auction_date": "1980-01-10", "security_type": "Note", "high_yield": "null"},
            "Fiscal Data",
        )
        self.assertIsNone(row["highYield"])
        self.assertIsNone(row["bidToCoverRatio"])
        self.assertIsNone(row["directBidderShare"])
        self.assertFalse(row["completed"])

    def test_instrument_flags_override_base_security_type(self):
        tips = dict(FISCAL_30Y_REOPENING, inflation_index_security="Yes")
        frn = dict(TREASURY_BILL, floatingRate="Yes", securityType="Note", highDiscountMargin="0.124")
        self.assertEqual(ta.normalize_auction(tips)["type"], "TIPS")
        normalized_frn = ta.normalize_auction(frn)
        self.assertEqual(normalized_frn["type"], "FRN")
        self.assertEqual(normalized_frn["stopOutValue"], 0.124)

    def test_document_urls_are_allowlisted_by_filename(self):
        self.assertEqual(
            ta.document_url("R_20250710_3.pdf"),
            "https://www.treasurydirect.gov/instit/annceresult/press/preanre/2025/R_20250710_3.pdf",
        )
        self.assertIsNone(ta.document_url("../../private.pdf"))
        self.assertIsNone(ta.document_url("https://evil.example/R_20250710_3.pdf"))


class ParserTests(unittest.TestCase):
    def test_model_spec_normalizes_tenor_and_cannot_invent_filters_or_dates(self):
        deterministic = {
            "view": "table",
            "metrics": ["bidToCoverRatio"],
            "term": None,
            "securityType": None,
            "cusip": None,
            "startDate": "2016-08-15",
            "endDate": "2026-08-15",
            "reopening": "all",
            "chartType": "line",
        }
        model_result = {
            "view": "chart",
            "metrics": ["bidToCoverRatio"],
            "term": "30Y",
            "securityType": "TIPS",
            "cusip": "912345678",
            "startDate": "2014-01-01",
            "endDate": "2024-01-01",
            "reopening": "only",
            "chartType": "bar",
        }
        with patch.object(ta.model_router, "generate_json", return_value=(model_result, "test-model")):
            spec, model = ta._ollama_spec("Visualize three-decade debt sales over the previous decade", deterministic)
        self.assertEqual(model, "test-model")
        self.assertEqual(spec["term"], "30-Year")
        self.assertIsNone(spec["securityType"])
        self.assertIsNone(spec["cusip"])
        self.assertEqual((spec["startDate"], spec["endDate"]), ("2016-08-15", "2026-08-15"))
        self.assertEqual(spec["reopening"], "all")
        self.assertEqual(spec["chartType"], "line")

    def test_previous_decade_uses_current_as_of_date(self):
        spec, _, _ = ta.parse_query(
            "Visualize demand coverage over the previous decade",
            as_of=date(2026, 8, 15),
        )
        self.assertEqual((spec["startDate"], spec["endDate"]), ("2016-08-15", "2026-08-15"))

    def test_range_numbers_are_not_treated_as_security_tenors(self):
        spec, _, _ = ta.parse_query(
            "Chart SOMA purchases for TIPS in the last 10 years",
            date(2026, 8, 14),
        )
        self.assertIsNone(spec["term"])
        self.assertEqual(spec["securityType"], "TIPS")
        self.assertEqual(spec["startDate"], "2016-08-14")

    def test_written_tenor_and_calendar_ranges(self):
        spec, _, _ = ta.parse_query(
            "Please display bid cover on ten year Treasury notes for fifteen years",
            date(2026, 8, 14),
        )
        self.assertEqual(spec["term"], "10-Year")
        self.assertEqual(spec["startDate"], "2011-08-14")
        month, _, _ = ta.parse_query("Give me PDFs for March 2012 10 year auctions")
        self.assertEqual((month["startDate"], month["endDate"]), ("2012-03-01", "2012-03-31"))

    def test_conflicting_or_unsupported_query_controls_are_rejected(self):
        cases = (
            "Show 30 year Treasury bills",
            "Compare 10 year and 30 year auction yields",
            "Show reopenings only but exclude reopenings",
            "Show a bar and scatter chart of 10 year auctions",
            "Forecast the next 10 year auction yield",
            "Show auctions between 2025-12-31 and 2025-01-01",
        )
        for prompt in cases:
            with self.subTest(prompt=prompt), self.assertRaises(ValueError):
                ta.parse_query(prompt, date(2026, 8, 14))

    def test_supplied_30_year_chart_prompt(self):
        spec, warnings, recognized = ta.parse_query(
            "Show me a chart of the bid to cover ratio for all 30 year auctions in the last 15 years",
            date(2026, 8, 13),
        )
        self.assertTrue(recognized)
        self.assertEqual(warnings, [])
        self.assertEqual(spec["view"], "chart")
        self.assertEqual(spec["metrics"], ["bidToCoverRatio"])
        self.assertEqual(spec["term"], "30-Year")
        self.assertIsNone(spec["securityType"])
        self.assertEqual(spec["startDate"], "2011-08-13")
        self.assertEqual(spec["endDate"], "2026-08-13")

    def test_latest_result_prompt(self):
        spec, _, _ = ta.parse_query("Show me the latest 30 year auction results", date(2026, 8, 13))
        self.assertEqual(spec["view"], "latest")
        self.assertEqual(spec["term"], "30-Year")

    def test_calendar_year_result_copy_prompt(self):
        spec, warnings, recognized = ta.parse_query(
            "Give me a copy of any auction results from 2012 for the 10 year note",
            date(2026, 8, 13),
        )
        self.assertTrue(recognized)
        self.assertEqual(warnings, [])
        self.assertEqual(spec["view"], "records")
        self.assertEqual(spec["term"], "10-Year")
        self.assertEqual(spec["securityType"], "Note")
        self.assertEqual(spec["startDate"], "2012-01-01")
        self.assertEqual(spec["endDate"], "2012-12-31")

    def test_exact_date_and_cusip_filters(self):
        spec, _, recognized = ta.parse_query(
            "Find the auction result on 2025-07-10 for CUSIP 912810UK2",
            date(2026, 8, 13),
        )
        self.assertTrue(recognized)
        self.assertEqual(spec["view"], "records")
        self.assertEqual(spec["cusip"], "912810UK2")
        self.assertEqual(spec["startDate"], "2025-07-10")
        self.assertEqual(spec["endDate"], "2025-07-10")

    def test_compare_bidder_shares_is_multi_metric(self):
        spec, _, _ = ta.parse_query(
            "Compare direct and indirect bidder shares for 20 year auctions in the last 3 years",
            date(2026, 8, 13),
        )
        self.assertEqual(spec["metrics"], ["directBidderShare", "indirectBidderShare"])
        self.assertEqual(spec["term"], "20-Year")

    def test_soma_wording_is_normalized(self):
        spec, warnings, _ = ta.parse_query("Chart SOMA purchases for TIPS in the last 10 years", date(2026, 8, 13))
        self.assertEqual(spec["metrics"], ["somaAccepted"])
        self.assertEqual(spec["securityType"], "TIPS")
        self.assertTrue(any("accepted-at-auction" in warning for warning in warnings))

    def test_query_spec_rejects_extra_fields(self):
        spec, _, _ = ta.parse_query("Chart 10 year bid to cover")
        spec["sql"] = "DROP TABLE auctions"
        with self.assertRaises(ValueError):
            ta.validate_query_spec(spec)


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "auctions.sqlite3"

    def tearDown(self):
        self.temp.cleanup()

    def test_upsert_tracks_real_revisions_but_not_source_schema_changes(self):
        with ta._db(self.db) as connection:
            first = ta.upsert_records([FISCAL_30Y_REOPENING], source="Fiscal Data", connection=connection)
            connection.commit()
            second = ta.upsert_records([FISCAL_30Y_REOPENING], source="Fiscal Data", connection=connection)
            changed = dict(FISCAL_30Y_REOPENING, high_yield="4.9000")
            third = ta.upsert_records([changed], source="Fiscal Data", connection=connection)
            connection.commit()
        self.assertEqual(first["inserted"], 1)
        self.assertEqual(second["unchanged"], 1)
        self.assertEqual(third["updated"], 1)
        self.assertEqual(ta.database_status(self.db)["revisionCount"], 1)

    def test_lower_priority_feed_cannot_overwrite_current_result(self):
        with ta._db(self.db) as connection:
            ta.upsert_records([TREASURY_BILL], source="TreasuryDirect auctioned", connection=connection)
            lower_priority = {
                "cusip": TREASURY_BILL["cusip"],
                "auction_date": "2026-08-13",
                "security_type": "Bill",
                "security_term": "4-Week",
                "original_security_term": "17-Week",
                "reopening": "Yes",
                "bid_to_cover_ratio": "9.99",
                "high_discnt_rate": "9.99",
                "offering_amt": "1",
                "comp_accepted": "1",
            }
            result = ta.upsert_records(
                [lower_priority], source="Fiscal Data Treasury Securities Auctions", connection=connection
            )
            connection.commit()
            stored = connection.execute(
                "SELECT payload_json FROM auctions WHERE auction_key=?", ("912797VC8|2026-08-13",)
            ).fetchone()
        payload = json.loads(stored["payload_json"])
        self.assertEqual(result["unchanged"], 1)
        self.assertEqual(payload["bidToCoverRatio"], 2.77)
        self.assertEqual(payload["highDiscountRate"], 3.625)

    def test_query_returns_reopening_by_original_term(self):
        with ta._db(self.db) as connection:
            ta.upsert_records([FISCAL_30Y_REOPENING], source="Fiscal Data", connection=connection)
            connection.commit()
        with patch.object(ta, "sync_auctions", return_value={"skipped": True}):
            payload = ta.query_payload(
                "Chart bid to cover for 30 year auctions in the last 20 years",
                as_of=date(2026, 8, 13),
                db_path=self.db,
            )
        self.assertEqual(payload["summary"]["observationCount"], 1)
        self.assertTrue(payload["rows"][0]["reopening"])
        self.assertEqual(payload["rows"][0]["term"], "30-Year")

    def test_record_query_filters_calendar_year_and_exposes_pdf(self):
        with ta._db(self.db) as connection:
            in_year = dict(FISCAL_30Y_REOPENING, auction_date="2012-07-12", security_type="Note",
                           security_term="9-Year 10-Month", original_security_term="10-Year",
                           pdf_filenm_comp_results="R_20120712_3.pdf")
            out_of_year = dict(in_year, auction_date="2013-07-11", pdf_filenm_comp_results="R_20130711_3.pdf")
            ta.upsert_records([in_year, out_of_year], source="Fiscal Data", connection=connection)
            connection.commit()
        with patch.object(ta, "sync_auctions", return_value={"skipped": True}):
            payload = ta.query_payload(
                "Give me auction results from 2012 for the 10 year note",
                as_of=date(2026, 8, 13),
                db_path=self.db,
            )
        self.assertEqual(payload["spec"]["view"], "records")
        self.assertEqual(payload["summary"]["observationCount"], 1)
        self.assertEqual(payload["summary"]["resultPdfCount"], 1)
        self.assertEqual(payload["rows"][0]["auctionDate"], "2012-07-12")
        self.assertTrue(payload["rows"][0]["resultPdfUrl"].endswith("/R_20120712_3.pdf"))

    def test_dashboard_latest_result_uses_same_day_update_time(self):
        later = dict(
            TREASURY_BILL,
            cusip="912810UW6",
            securityType="Bond",
            securityTerm="30-Year",
            originalSecurityTerm="30-Year",
            reopening="No",
            highDiscountRate="",
            highInvestmentRate="",
            highYield="5.216",
            updatedTimestamp="2026-08-13T13:03:22",
        )
        with ta._db(self.db) as connection:
            ta.upsert_records([TREASURY_BILL, later], source="TreasuryDirect auctioned", connection=connection)
            connection.commit()
        with patch.object(ta, "sync_auctions", return_value={"skipped": True}):
            payload = ta.dashboard_payload(limit=20, db_path=self.db)
        self.assertEqual(payload["latestResult"]["cusip"], "912810UW6")

    def test_detail_rejects_unsafe_key(self):
        with self.assertRaises(ValueError):
            ta.auction_detail("../../settings.json", self.db)


if __name__ == "__main__":
    unittest.main()
