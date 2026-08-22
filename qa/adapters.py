"""Read-only adapters from current Side Tools parsers to QA contracts."""

from __future__ import annotations

from datetime import date
from typing import Any


AS_OF = date(2026, 8, 22)


def _source_for_macro_entry(entry: dict[str, Any]) -> dict[str, Any]:
    series_id = entry.get("fred") or entry.get("bls") or entry.get("id")
    yahoo = entry.get("yahoo")
    if yahoo:
        series_id = yahoo
    source_url = entry.get("sourceUrl")
    if not source_url and entry.get("fred"):
        source_url = f"https://fred.stlouisfed.org/series/{entry['fred']}"
    if not source_url and entry.get("bls"):
        source_url = f"https://data.bls.gov/timeseries/{entry['bls']}"
    if not source_url and yahoo:
        source_url = f"https://finance.yahoo.com/quote/{yahoo}"
    return {
        "provider": entry.get("origin") or entry.get("primary") or "unknown",
        "seriesId": series_id,
        "url": source_url,
        "unit": entry.get("unit"),
    }


def run_macro(prompt: str) -> dict[str, Any]:
    import serve

    try:
        contract = serve.parse_macro_request_contract(prompt)
        selected, notices = serve.resolve_prompt_series(prompt, allow_fred_search=False)
        residuals = []
        for operand in contract.get("operands", []):
            source_span = operand.get("sourceSpan")
            if source_span:
                residual = serve.unresolved_clause_residual(str(source_span))
                if residual:
                    residuals.append(residual)
        selected_ids = [str(entry.get("id")) for entry in selected if entry.get("id")]
        families = set()
        for operand in contract.get("operands", []):
            families.update(str(value) for value in operand.get("semanticFamilies", []))
        measure_family = {
            "market_capitalization": "equity_market_capitalization",
            "debt_securities_outstanding": "debt_market_securities",
            "credit_market_debt_outstanding": "credit_market_debt",
            "federal_public_debt_outstanding": "federal_public_debt",
        }
        for entry in selected:
            if entry.get("conceptFamily"):
                families.add(str(entry["conceptFamily"]))
            if entry.get("measureType") in measure_family:
                families.add(measure_family[entry["measureType"]])
            if entry.get("dfaGroupKey") or str(entry.get("id", "")).startswith("FED_DFA:"):
                families.add("wealth_distribution")
        qualifiers = []
        selectors = []
        for operand in contract.get("operands", []):
            qualifiers.extend(operand.get("conditions", []))
            selectors.extend(operand.get("selectors", []))
        return {
            "status": "parsed",
            "parser": "serve.parse_macro_request_contract+resolve_prompt_series",
            "conceptIds": selected_ids,
            "conceptFamilies": sorted(families),
            "residuals": residuals,
            "sourceRecords": [_source_for_macro_entry(entry) for entry in selected],
            "fields": {
                "operation": contract.get("operation"),
                "operands": contract.get("operands", []),
                "timeRange": contract.get("time"),
                "qualifiers": qualifiers,
                "selectors": selectors,
                "selectedSeries": selected,
                "notices": notices,
            },
            "raw": {"contract": contract, "notices": notices},
        }
    except Exception as exc:  # noqa: BLE001 - an audit result must preserve parser failures.
        return {
            "status": "error",
            "parser": "serve.parse_macro_request_contract+resolve_prompt_series",
            "conceptIds": [],
            "conceptFamilies": [],
            "residuals": [],
            "sourceRecords": [],
            "fields": {},
            "error": f"{exc.__class__.__name__}: {exc}",
        }


def run_fed(prompt: str) -> dict[str, Any]:
    import serve

    meeting_dates = [meeting.isoformat() for meeting in sorted(serve.FOMC_MEETINGS)]
    try:
        result = serve.parse_fed_tracker_intent(prompt, meeting_dates)
        spec = result.get("spec", {})
        return {
            "status": "parsed",
            "parser": str(result.get("parser") or "unknown"),
            "conceptIds": [],
            "conceptFamilies": ["fed_funds_futures_probability"],
            "residuals": [],
            "sourceRecords": [],
            "fields": {
                "view": spec.get("view"),
                "meetingDate": spec.get("meetingDate"),
                "historyRange": spec.get("historyRange"),
                "meetingSelection": spec.get("meetingSelection"),
                "comparisonDates": spec.get("comparisonDates"),
                "outcomeSelection": spec.get("outcomeSelection"),
                "chartType": spec.get("chartType"),
                "usedModel": result.get("usedModel"),
                "dataValuesFromModel": result.get("dataValuesFromModel"),
                "meetingDates": meeting_dates,
            },
            "raw": result,
        }
    except Exception as exc:  # noqa: BLE001 - an audit result must preserve parser failures.
        return {
            "status": "error",
            "parser": "serve.parse_fed_tracker_intent",
            "conceptIds": [],
            "conceptFamilies": [],
            "residuals": [],
            "sourceRecords": [],
            "fields": {"meetingDates": meeting_dates},
            "error": f"{exc.__class__.__name__}: {exc}",
        }


def run_treasury(prompt: str) -> dict[str, Any]:
    import treasury_auctions

    try:
        spec, warnings, recognized = treasury_auctions.parse_query(prompt, AS_OF)
        fields = dict(spec)
        fields["recognized"] = recognized
        fields["warnings"] = warnings
        try:
            treasury_auctions.validate_query_spec(spec)
            fields["querySpecValid"] = True
        except Exception as exc:  # noqa: BLE001 - preserve execution incompatibility for QA.
            fields["querySpecValid"] = False
            fields["querySpecError"] = f"{exc.__class__.__name__}: {exc}"
        # These fields are intentionally absent unless the application parser
        # exposes them. The harness must catch document-intent loss rather than
        # infer it from the original prompt.
        return {
            "status": "parsed",
            "parser": "treasury_auctions.parse_query",
            "conceptIds": [],
            "conceptFamilies": ["treasury_auction_records"],
            "residuals": [],
            "sourceRecords": [],
            "fields": fields,
            "raw": {"spec": spec, "warnings": warnings, "recognized": recognized},
        }
    except Exception as exc:  # noqa: BLE001 - an audit result must preserve parser failures.
        return {
            "status": "error",
            "parser": "treasury_auctions.parse_query",
            "conceptIds": [],
            "conceptFamilies": [],
            "residuals": [],
            "sourceRecords": [],
            "fields": {},
            "error": f"{exc.__class__.__name__}: {exc}",
        }


ADAPTERS = {"macro": run_macro, "fed": run_fed, "treasury": run_treasury}


def run_current(tool: str, prompt: str) -> dict[str, Any]:
    try:
        adapter = ADAPTERS[tool]
    except KeyError as exc:
        raise ValueError(f"Unknown Side Tools adapter: {tool}") from exc
    return adapter(prompt)
