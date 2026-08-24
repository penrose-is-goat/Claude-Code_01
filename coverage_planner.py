"""Coverage checks and auditable multi-source series composition.

The provider layer fetches observations. This module decides whether those
observations satisfy the requested window and only combines related sources
after their overlapping history passes explicit numerical checks.
"""

from __future__ import annotations

import calendar
import math
import statistics
from datetime import date
from typing import Any


def _as_date(value: str | date) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def coverage_status(
    observations: list[dict[str, Any]],
    start: date | None,
    end: date | None,
    *,
    start_tolerance_days: int = 45,
    end_tolerance_days: int = 10,
) -> dict[str, Any]:
    """Describe whether observations materially cover the requested window."""

    if not observations:
        return {
            "complete": False,
            "hasObservations": False,
            "missingStart": start is not None,
            "missingEnd": end is not None,
            "startGapDays": None,
            "endGapDays": None,
        }
    ordered = sorted(observations, key=lambda row: row["date"])
    first = _as_date(ordered[0]["date"])
    last = _as_date(ordered[-1]["date"])
    start_gap = max(0, (first - start).days) if start else 0
    end_gap = max(0, (end - last).days) if end else 0
    missing_start = bool(start and start_gap > start_tolerance_days)
    missing_end = bool(end and end_gap > end_tolerance_days)
    return {
        "complete": not missing_start and not missing_end,
        "hasObservations": True,
        "firstDate": first.isoformat(),
        "lastDate": last.isoformat(),
        "missingStart": missing_start,
        "missingEnd": missing_end,
        "startGapDays": start_gap,
        "endGapDays": end_gap,
        "startToleranceDays": start_tolerance_days,
        "endToleranceDays": end_tolerance_days,
    }


def _monthly_means(observations: list[dict[str, Any]]) -> dict[str, float]:
    buckets: dict[str, list[float]] = {}
    for row in observations:
        value = float(row["value"])
        if not math.isfinite(value):
            continue
        month = str(row["date"])[:7]
        buckets.setdefault(month, []).append(value)
    return {month: statistics.fmean(values) for month, values in buckets.items() if values}


def _monthly_observations(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in observations:
        value = float(row["value"])
        if math.isfinite(value):
            buckets.setdefault(str(row["date"])[:7], []).append(row)
    output = []
    for month in sorted(buckets):
        rows = buckets[month]
        output.append(
            {
                "date": max(str(row["date"]) for row in rows),
                "value": statistics.fmean(float(row["value"]) for row in rows),
            }
        )
    return output


def _correlation(left: list[float], right: list[float]) -> float:
    left_mean = statistics.fmean(left)
    right_mean = statistics.fmean(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    denominator = math.sqrt(
        sum((a - left_mean) ** 2 for a in left)
        * sum((b - right_mean) ** 2 for b in right)
    )
    return numerator / denominator if denominator else 0.0


def compare_monthly_levels(
    primary: list[dict[str, Any]],
    reference: list[dict[str, Any]],
    *,
    primary_label: str,
    reference_label: str,
    minimum_months: int = 24,
    minimum_correlation: float = 0.98,
    maximum_median_percent_difference: float = 0.08,
) -> dict[str, Any]:
    """Validate related daily/monthly level series on monthly averages."""

    primary_monthly = _monthly_means(primary)
    reference_monthly = _monthly_means(reference)
    months = sorted(set(primary_monthly) & set(reference_monthly))
    if len(months) < minimum_months:
        return {
            "status": "insufficient-overlap",
            "method": "monthly mean level comparison",
            "primary": primary_label,
            "reference": reference_label,
            "overlapMonths": len(months),
            "minimumMonths": minimum_months,
        }
    left = [primary_monthly[month] for month in months]
    right = [reference_monthly[month] for month in months]
    correlation = _correlation(left, right)
    differences = [abs(a - b) / max(abs(b), 1e-12) for a, b in zip(left, right)]
    median_difference = statistics.median(differences)
    status = (
        "pass"
        if correlation >= minimum_correlation
        and median_difference <= maximum_median_percent_difference
        else "fail"
    )
    return {
        "status": status,
        "method": "monthly mean level comparison",
        "primary": primary_label,
        "reference": reference_label,
        "overlapMonths": len(months),
        "firstOverlapMonth": months[0],
        "lastOverlapMonth": months[-1],
        "correlation": round(correlation, 6),
        "medianPercentDifference": round(median_difference, 6),
        "minimumCorrelation": minimum_correlation,
        "maximumMedianPercentDifference": maximum_median_percent_difference,
    }


def month_end(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def compose_coverage_base(
    primary: dict[str, Any],
    coverage_base: dict[str, Any],
    *,
    start: date | None,
    end: date | None,
    comparison: dict[str, Any],
    start_tolerance_days: int = 45,
    end_tolerance_days: int = 10,
) -> dict[str, Any]:
    """Use a verified long-history base and append newer primary observations."""

    if comparison.get("status") != "pass":
        raise RuntimeError(
            "Configured coverage sources could not be combined because their overlap "
            f"validation was {comparison.get('status', 'missing')}."
        )
    base_rows = sorted(coverage_base.get("observations") or [], key=lambda row: row["date"])
    native_primary_rows = sorted(primary.get("observations") or [], key=lambda row: row["date"])
    base_frequency = str(coverage_base.get("frequency") or "").lower()
    primary_rows = (
        _monthly_observations(native_primary_rows)
        if base_frequency == "monthly"
        else native_primary_rows
    )
    if not base_rows or not primary_rows:
        raise RuntimeError("Both the coverage base and primary continuation need observations.")
    base_last = _as_date(base_rows[-1]["date"])
    merged: dict[str, dict[str, Any]] = {
        row["date"]: dict(row)
        for row in base_rows
        if (not start or _as_date(row["date"]) >= start)
        and (not end or _as_date(row["date"]) <= end)
    }
    continuation_count = 0
    for row in primary_rows:
        row_date = _as_date(row["date"])
        if row_date <= base_last:
            continue
        if start and row_date < start:
            continue
        if end and row_date > end:
            continue
        merged[row["date"]] = dict(row)
        continuation_count += 1
    observations = sorted(merged.values(), key=lambda row: row["date"])
    coverage = coverage_status(
        observations,
        start,
        end,
        start_tolerance_days=start_tolerance_days,
        end_tolerance_days=end_tolerance_days,
    )
    if not coverage["complete"]:
        raise RuntimeError(
            "Configured primary and backup sources still do not cover the requested range: "
            f"start gap={coverage.get('startGapDays')} days, "
            f"end gap={coverage.get('endGapDays')} days."
        )
    result = dict(primary)
    result.update(
        {
            "provider": f"{coverage_base['provider']} + {primary['provider']}",
            "providerSeries": (
                f"{coverage_base.get('providerSeries', 'coverage base')} + "
                f"{primary.get('providerSeries', 'continuation')}"
            ),
            "observations": observations,
            "firstDate": observations[0]["date"],
            "lastDate": observations[-1]["date"],
            "latest": observations[-1]["value"],
            "frequency": coverage_base.get("frequency") or primary.get("frequency"),
            "sourceUrl": coverage_base.get("sourceUrl") or primary.get("sourceUrl"),
            "supportingSources": [
                {
                    "name": coverage_base["provider"],
                    "url": coverage_base.get("sourceUrl"),
                    "role": (
                        f"Historical coverage through {coverage_base.get('lastDate')} "
                        f"({coverage_base.get('providerSeries')})"
                    ),
                },
                {
                    "name": primary["provider"],
                    "url": primary.get("sourceUrl"),
                    "role": (
                        f"Current continuation after {coverage_base.get('lastDate')} "
                        f"({primary.get('providerSeries')})"
                    ),
                },
                *(coverage_base.get("supportingSources") or []),
                *(primary.get("supportingSources") or []),
            ],
            "sourceComparison": comparison,
            "coverage": coverage,
            "coveragePlan": {
                "status": "pass",
                "policy": "verified coverage base with current-market continuation",
                "baseLastDate": coverage_base.get("lastDate"),
                "baseObservations": len(base_rows),
                "continuationObservations": continuation_count,
                "outputFrequency": coverage_base.get("frequency") or primary.get("frequency"),
                "continuationAggregation": (
                    "monthly mean of primary observations"
                    if base_frequency == "monthly"
                    else "native primary observations"
                ),
                "requestedStart": start.isoformat() if start else None,
                "requestedEnd": end.isoformat() if end else None,
            },
        }
    )
    return result
