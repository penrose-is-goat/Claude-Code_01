"""Contract and data-invariant checks used by the Side Tools QA harness.

The application modules are intentionally not modified by this package. The
adapters project their current parser outputs into a small common observation
shape and these checks compare that shape with fixture expectations.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from math import isfinite
from typing import Any, Iterable
from urllib.parse import urlparse


MISSING = object()


@dataclass(frozen=True)
class Finding:
    """One deterministic, machine-readable QA finding."""

    code: str
    message: str
    severity: str = "error"
    path: str = ""

    def as_dict(self) -> dict[str, str]:
        result = {
            "code": self.code,
            "message": self.message,
            "severity": self.severity,
        }
        if self.path:
            result["path"] = self.path
        return result


def _finding(code: str, message: str, path: str = "", severity: str = "error") -> Finding:
    return Finding(code=code, message=message, path=path, severity=severity)


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if isfinite(parsed) else None


def _valid_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _date_value(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _get_path(value: Any, path: str) -> Any:
    current = value
    for part in path.split(".") if path else ():
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return MISSING
    return current


def validate_source_record(source: dict[str, Any], path: str = "source") -> list[Finding]:
    """Validate the minimum provenance required for a loaded data object."""

    findings: list[Finding] = []
    provider = source.get("provider") or source.get("origin")
    native_id = (
        source.get("seriesId")
        or source.get("nativeId")
        or source.get("providerSeries")
        or source.get("id")
    )
    source_url = source.get("url") or source.get("sourceUrl")
    if not provider:
        findings.append(_finding("SOURCE_PROVIDER_MISSING", "Provider is required.", f"{path}.provider"))
    if not native_id:
        findings.append(_finding("SOURCE_NATIVE_ID_MISSING", "Native provider identifier is required.", f"{path}.seriesId"))
    if not _valid_url(source_url):
        findings.append(_finding("SOURCE_URL_INVALID", "A direct HTTP(S) source URL is required.", f"{path}.url"))
    start = source.get("coverageStart")
    end = source.get("coverageEnd")
    if start is not None and _date_value(start) is None:
        findings.append(_finding("SOURCE_START_DATE_INVALID", "coverageStart must be ISO formatted.", f"{path}.coverageStart"))
    if end is not None and _date_value(end) is None:
        findings.append(_finding("SOURCE_END_DATE_INVALID", "coverageEnd must be ISO formatted.", f"{path}.coverageEnd"))
    if start is not None and end is not None and _date_value(start) and _date_value(end):
        if _date_value(start) > _date_value(end):
            findings.append(_finding("SOURCE_COVERAGE_REVERSED", "Source coverage starts after it ends.", path))
    return findings


def validate_observations(
    observations: Iterable[dict[str, Any]],
    path: str = "observations",
) -> list[Finding]:
    """Check ordered dates, duplicate dates, and finite numeric values."""

    findings: list[Finding] = []
    previous: date | None = None
    for index, row in enumerate(observations):
        row_path = f"{path}[{index}]"
        if not isinstance(row, dict):
            findings.append(_finding("OBSERVATION_NOT_OBJECT", "Observation must be an object.", row_path))
            continue
        observed_date = _date_value(row.get("date") or row.get("observationDate"))
        if observed_date is None:
            findings.append(_finding("OBSERVATION_DATE_INVALID", "Observation date must be ISO formatted.", f"{row_path}.date"))
        elif previous is not None and observed_date <= previous:
            findings.append(_finding("OBSERVATION_DATES_NOT_STRICT", "Observation dates must be strictly increasing.", f"{row_path}.date"))
        else:
            previous = observed_date
        if "value" in row and row["value"] is not None and _number(row["value"]) is None:
            findings.append(_finding("OBSERVATION_VALUE_NOT_NUMERIC", "Non-null observation values must be finite numbers.", f"{row_path}.value"))
    return findings


def validate_probabilities(
    rows: Iterable[dict[str, Any]],
    path: str = "probabilities",
) -> list[Finding]:
    """Check probability ranges and mutually exclusive outcome totals."""

    findings: list[Finding] = []
    for index, row in enumerate(rows):
        row_path = f"{path}[{index}]"
        outcomes = row.get("outcomes", []) if isinstance(row, dict) else []
        if not isinstance(outcomes, list):
            findings.append(_finding("PROBABILITY_OUTCOMES_INVALID", "outcomes must be a list.", f"{row_path}.outcomes"))
            continue
        total = 0.0
        for outcome_index, outcome in enumerate(outcomes):
            outcome_path = f"{row_path}.outcomes[{outcome_index}]"
            probability = _number(outcome.get("probability")) if isinstance(outcome, dict) else None
            if probability is None or not 0 <= probability <= 100:
                findings.append(_finding("PROBABILITY_OUT_OF_RANGE", "Probability must be between 0 and 100.", f"{outcome_path}.probability"))
            else:
                total += probability
        if outcomes and abs(total - 100.0) > 0.05:
            findings.append(_finding("PROBABILITY_TOTAL_INVALID", f"Mutually exclusive outcomes total {total:.4f}, not 100.", f"{row_path}.outcomes"))
    return findings


def validate_auction_rows(
    rows: Iterable[dict[str, Any]],
    path: str = "auctions",
) -> list[Finding]:
    """Check Treasury auction numeric conventions and document provenance."""

    findings: list[Finding] = []
    numeric_fields = {
        "bidToCoverRatio": "AUCTION_BID_TO_COVER_INVALID",
        "directBidderShare": "AUCTION_DIRECT_SHARE_INVALID",
        "indirectBidderShare": "AUCTION_INDIRECT_SHARE_INVALID",
        "primaryDealerShare": "AUCTION_PRIMARY_SHARE_INVALID",
        "highYield": "AUCTION_YIELD_INVALID",
    }
    for index, row in enumerate(rows):
        row_path = f"{path}[{index}]"
        if not isinstance(row, dict):
            findings.append(_finding("AUCTION_ROW_NOT_OBJECT", "Auction row must be an object.", row_path))
            continue
        if _date_value(row.get("auctionDate")) is None:
            findings.append(_finding("AUCTION_DATE_INVALID", "auctionDate must be ISO formatted.", f"{row_path}.auctionDate"))
        for field, code in numeric_fields.items():
            if row.get(field) is None:
                continue
            value = _number(row[field])
            if value is None:
                findings.append(_finding(code, f"{field} must be numeric when present.", f"{row_path}.{field}"))
                continue
            if field == "bidToCoverRatio" and value < 0:
                findings.append(_finding(code, "Bid-to-cover cannot be negative.", f"{row_path}.{field}"))
            if field.endswith("Share") and not 0 <= value <= 100:
                findings.append(_finding(code, "Bidder share must be between 0 and 100.", f"{row_path}.{field}"))
        missing_fields = row.get("missingFields", [])
        if isinstance(missing_fields, list):
            for field in missing_fields:
                if row.get(field) is not None:
                    findings.append(_finding("MISSING_VALUE_NOT_NULL", f"Declared missing field {field} must remain null.", f"{row_path}.{field}"))
        if row.get("reopening") and not row.get("securityTerm"):
            findings.append(_finding("REOPENING_TERM_MISSING", "Reopenings must preserve their published security term.", row_path))
        pdf_url = row.get("resultPdfUrl")
        if pdf_url is not None and not _valid_url(pdf_url):
            findings.append(_finding("AUCTION_PDF_URL_INVALID", "Result PDF URL must be an HTTP(S) URL.", f"{row_path}.resultPdfUrl"))
    return findings


def validate_contract(case: dict[str, Any], observed: dict[str, Any]) -> list[Finding]:
    """Compare a projected current-module contract with its fixture expectation."""

    expected = case.get("expected", {})
    forbidden = case.get("forbidden", {})
    findings: list[Finding] = []
    if expected.get("parse") == "success" and observed.get("status") != "parsed":
        findings.append(_finding("PARSE_FAILED", str(observed.get("error") or "Parser did not return a contract.")))
    if expected.get("parse") == "failure" and observed.get("status") == "parsed":
        findings.append(_finding("EXPECTED_PARSE_FAILURE_MISSED", "Parser accepted a fixture that should be rejected."))

    for field in expected.get("requiredFields", []):
        if _get_path(observed.get("fields", {}), field) is MISSING:
            findings.append(_finding("CONTRACT_FIELD_MISSING", f"Required contract field {field} is missing.", f"fields.{field}"))

    for field, expected_value in (expected.get("fieldEquals") or {}).items():
        actual = _get_path(observed.get("fields", {}), field)
        if actual is MISSING:
            findings.append(_finding("CONTRACT_FIELD_MISSING", f"Expected field {field} is missing.", f"fields.{field}"))
        elif actual != expected_value:
            findings.append(_finding("CONTRACT_FIELD_MISMATCH", f"Expected {field}={expected_value!r}, observed {actual!r}.", f"fields.{field}"))

    for field, expected_value in (expected.get("fieldEqualsAdditional") or {}).items():
        actual = _get_path(observed.get("fields", {}), field)
        if actual is MISSING:
            findings.append(_finding("CONTRACT_FIELD_MISSING", f"Expected field {field} is missing.", f"fields.{field}"))
        elif actual != expected_value:
            findings.append(_finding("CONTRACT_FIELD_MISMATCH", f"Expected {field}={expected_value!r}, observed {actual!r}.", f"fields.{field}"))

    if expected.get("metricsMustBeEmpty"):
        metrics = _get_path(observed.get("fields", {}), "metrics")
        if metrics is MISSING:
            findings.append(_finding("CONTRACT_FIELD_MISSING", "Expected metrics field is missing.", "fields.metrics"))
        elif metrics:
            findings.append(_finding("UNREQUESTED_METRIC_ASSIGNED", f"Expected no metric, observed {metrics!r}.", "fields.metrics"))

    for field, expected_values in (expected.get("fieldContains") or {}).items():
        actual = _get_path(observed.get("fields", {}), field)
        if actual is MISSING:
            findings.append(_finding("CONTRACT_FIELD_MISSING", f"Expected collection field {field} is missing.", f"fields.{field}"))
            continue
        if not isinstance(actual, (list, tuple, set)):
            findings.append(_finding("CONTRACT_FIELD_NOT_COLLECTION", f"Expected {field} to be a collection.", f"fields.{field}"))
            continue
        missing = [value for value in expected_values if value not in actual]
        if missing:
            findings.append(_finding("CONTRACT_COLLECTION_MISSING", f"{field} is missing {missing!r}.", f"fields.{field}"))

    for field, allowed_values in (expected.get("fieldIn") or {}).items():
        actual = _get_path(observed.get("fields", {}), field)
        if actual is MISSING:
            findings.append(_finding("CONTRACT_FIELD_MISSING", f"Expected field {field} is missing.", f"fields.{field}"))
        elif actual not in allowed_values:
            findings.append(
                _finding(
                    "CONTRACT_FIELD_NOT_ALLOWED",
                    f"Expected {field} to be one of {allowed_values!r}, observed {actual!r}.",
                    f"fields.{field}",
                )
            )

    for group_index, choices in enumerate(expected.get("fieldAnyOf") or []):
        matched = False
        for field, expected_value in choices.items():
            actual = _get_path(observed.get("fields", {}), field)
            if actual == expected_value:
                matched = True
                break
        if not matched:
            findings.append(_finding("CONTRACT_ANY_OF_MISSED", f"No accepted alternative matched: {choices!r}.", f"fields.anyOf[{group_index}]"))

    for selector_index, expected_selector in enumerate(expected.get("selectorMatches") or []):
        selectors = _get_path(observed.get("fields", {}), "selectors")
        matched = False
        if isinstance(selectors, list):
            matched = any(
                isinstance(selector, dict)
                and all(selector.get(key) == value for key, value in expected_selector.items())
                for selector in selectors
            )
        if not matched:
            findings.append(_finding("EXPECTED_SELECTOR_MISSING", f"No selector matched {expected_selector!r}.", f"fields.selectors[{selector_index}]"))

    observed_ids = set(observed.get("conceptIds") or [])
    for concept_id in expected.get("conceptIds", []):
        if concept_id not in observed_ids:
            findings.append(_finding("EXPECTED_CONCEPT_MISSING", f"Expected concept {concept_id} was not resolved.", "conceptIds"))
    for group_index, choices in enumerate(expected.get("conceptIdAnyOf") or []):
        if not observed_ids.intersection(choices):
            findings.append(_finding("EXPECTED_CONCEPT_CHOICE_MISSING", f"None of the accepted concepts {choices!r} was resolved.", f"conceptIds.anyOf[{group_index}]"))

    observed_families = set(observed.get("conceptFamilies") or [])
    for family in expected.get("conceptFamilies", []):
        if family not in observed_families:
            findings.append(_finding("EXPECTED_FAMILY_MISSING", f"Expected semantic family {family} was not present.", "conceptFamilies"))

    for concept_id in forbidden.get("conceptIds", []):
        if concept_id in observed_ids:
            findings.append(_finding("FORBIDDEN_CONCEPT_RESOLVED", f"Forbidden concept {concept_id} was resolved.", "conceptIds"))

    observed_source_ids = {
        str(source.get("seriesId") or source.get("nativeId") or source.get("providerSeries"))
        for source in observed.get("sourceRecords", [])
        if isinstance(source, dict)
        and (source.get("seriesId") or source.get("nativeId") or source.get("providerSeries"))
    }
    for source_id in expected.get("sourceSeriesIds", []):
        if source_id not in observed_source_ids:
            findings.append(_finding("EXPECTED_SOURCE_SERIES_MISSING", f"Expected native source series {source_id} was not exposed.", "sourceRecords"))
    observed_residuals = " ".join(str(value).lower() for value in observed.get("residuals", []))
    for fragment in forbidden.get("fragments", []):
        if str(fragment).lower() in observed_residuals:
            findings.append(_finding("PARSER_FRAGMENT_LEAKED", f"Parser residual contains command fragment {fragment!r}.", "residuals"))
    for field, forbidden_value in (forbidden.get("fieldEquals") or {}).items():
        actual = _get_path(observed.get("fields", {}), field)
        if actual == forbidden_value:
            findings.append(_finding("FORBIDDEN_FIELD_VALUE", f"Forbidden field value {field}={forbidden_value!r} was observed.", f"fields.{field}"))
    return findings


def validate_fixture_invariants(corpus: dict[str, Any]) -> list[Finding]:
    """Run valid and intentionally-invalid numerical/source fixture checks."""

    findings: list[Finding] = []
    tool = corpus.get("tool", "unknown")
    samples = corpus.get("invariantSamples", {})
    valid = samples.get("valid", {})
    invalid = samples.get("invalid", {})

    def run(kind: str, rows: Any, path: str) -> list[Finding]:
        if kind == "sources":
            return [finding for row_index, row in enumerate(rows or []) for finding in validate_source_record(row, f"{path}[{row_index}]")]
        if kind == "observations":
            return validate_observations(rows or [], path)
        if kind == "probabilities":
            return validate_probabilities(rows or [], path)
        if kind == "auctions":
            return validate_auction_rows(rows or [], path)
        return [_finding("UNKNOWN_INVARIANT_KIND", f"Unknown invariant fixture kind {kind!r}.", path)]

    for kind, rows in valid.items():
        for finding in run(kind, rows, f"{tool}.valid.{kind}"):
            findings.append(_finding("VALID_FIXTURE_REJECTED", finding.message, finding.path))
    for kind, payload in invalid.items():
        if isinstance(payload, dict):
            rows = payload.get("rows", [])
            expected_codes = set(payload.get("expectedCodes", []))
        else:
            rows = payload
            expected_codes = set()
        actual = run(kind, rows, f"{tool}.invalid.{kind}")
        actual_codes = {finding.code for finding in actual}
        for code in sorted(expected_codes - actual_codes):
            findings.append(_finding("INVALID_FIXTURE_NOT_DETECTED", f"Expected invariant finding {code} was not detected.", f"{tool}.invalid.{kind}"))
    return findings


def finding_dicts(findings: Iterable[Finding]) -> list[dict[str, str]]:
    return [finding.as_dict() for finding in findings]
