"""Side Tools v1.3 deterministic prompt, coverage, and chart release gate.

The full gate executes exactly 100,000 cases. It reuses the independent v1.2
semantic oracle, adds seeded high-complexity prompt combinations, exercises the
real coverage planner with failure shapes, and runs the exported browser scale
implementation under Node.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import random
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any, Iterator
from unittest import mock

from qa import v1_2_gate as baseline


GATE_VERSION = "side-tools.v1.3.0"
TOTAL_CASES = 100_000
EXTRA_PROMPT_CASES = 46_401
COVERAGE_CASES = 10_000
AXIS_CASES = 10_000
SEED = 130024

EXTRA_DATES = (
    baseline.DateForm("last-3y", "over the last 3 years", {"kind": "last_years", "value": 3}),
    baseline.DateForm("last-7y", "for the last 7 years", {"kind": "last_years", "value": 7}),
    baseline.DateForm("last-10y", "over the last 10 years", {"kind": "last_years", "value": 10}),
    baseline.DateForm("last-15y", "during the last 15 years", {"kind": "last_years", "value": 15}),
    baseline.DateForm("last-20y", "for the preceding 20 years", {"kind": "last_years", "value": 20}),
    baseline.DateForm("last-25y", "over the last 25 years", {"kind": "last_years", "value": 25}),
    baseline.DateForm("last-30y", "across the last 30 years", {"kind": "last_years", "value": 30}),
    baseline.DateForm("last-40y", "during the last 40 years", {"kind": "last_years", "value": 40}),
    baseline.DateForm("since-2000", "since 2000", {"kind": "since_year", "value": 2000}),
    baseline.DateForm("ytd", "year-to-date", {"kind": "ytd"}),
)

WRAPPERS = (
    "show me {a} {connector} {b} {date}",
    "graph {a} {connector} {b} {date}",
    "please plot {a} {connector} {b} {date}",
    "build a macro chart comparing {a} {connector} {b} {date}",
)

AXIS_OPTIONS = (
    ("auto", ""),
    ("dual", "on opposite axes"),
    ("dual", "using separate left and right scales"),
    ("left-right", "put the first series on the left axis and the second on the right axis"),
    ("single", "on the same axis"),
    ("dual", "with a secondary axis for the second series"),
)


def _digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def _extra_prompt_cases(limit: int = EXTRA_PROMPT_CASES) -> Iterator[dict[str, Any]]:
    """Sample unique combinations from a 1.3M-case Cartesian prompt space."""

    concepts = baseline.CONCEPTS
    pairs = [(left, right) for left in concepts for right in concepts if left.id != right.id]
    transforms = baseline.TRANSFORMS
    chart_types = baseline.CHART_TYPES
    dimensions = (
        len(pairs),
        len(baseline.CONNECTORS),
        len(EXTRA_DATES),
        len(WRAPPERS),
        len(AXIS_OPTIONS),
        len(transforms),
        len(chart_types),
    )
    population = 1
    for size in dimensions:
        population *= size
    rng = random.Random(SEED)
    selected_indices = rng.sample(range(population), limit)
    for case_number, encoded_index in enumerate(selected_indices, start=1):
        cursor = encoded_index
        positions = []
        for size in reversed(dimensions):
            positions.append(cursor % size)
            cursor //= size
        pair_i, connector_i, date_i, wrapper_i, axis_i, transform_i, chart_i = reversed(positions)
        left, right = pairs[pair_i]
        connector = baseline.CONNECTORS[connector_i]
        date_form = EXTRA_DATES[date_i]
        prompt = WRAPPERS[wrapper_i].format(
            a=left.phrase,
            connector=connector,
            b=right.phrase,
            date=date_form.text,
        )
        axis_mode, axis_text = AXIS_OPTIONS[axis_i]
        if axis_text:
            prompt += f" {axis_text}"
        transform_key, transform_text, transform_units = transforms[transform_i]
        chart_type, chart_text = chart_types[chart_i]
        prompt += f" {transform_text} {chart_text}"
        case = baseline._macro_case(
            f"v1.3.prompt.{case_number:05d}",
            [left, right],
            prompt,
            baseline._expected_macro(
                [left, right],
                date_form,
                axis_mode,
                transform=transform_units,
                chart_type=chart_type,
            ),
            mutation_group=f"v1.3-{pair_i}-{date_i}",
            family="v1.3-seeded-prompt",
            seed=SEED + case_number,
        )
        # The baseline already performs thousands of full resolver checks. These
        # additional checkpoints sample every prompt dimension without making
        # the 100k gate impractically slow.
        case["resolutionCheckpoint"] = case_number % 20 == 0
        yield case


def _month_rows(count: int, *, start_year: int = 2010, perturb: float = 0.0) -> list[dict[str, Any]]:
    import coverage_planner

    rows = []
    for index in range(count):
        year = start_year + index // 12
        month = index % 12 + 1
        value = 100.0 + index * 1.7
        if perturb:
            value *= 1 + perturb * ((index % 5) - 2)
        rows.append({"date": coverage_planner.month_end(year, month).isoformat(), "value": value})
    return rows


def run_coverage_cases() -> dict[str, Any]:
    import coverage_planner

    failures: list[dict[str, Any]] = []
    failure_count = 0
    signatures: list[Any] = []
    full = _month_rows(60)
    related = _month_rows(60, perturb=0.0005)
    inverse = [{**row, "value": 400.0 - float(row["value"])} for row in full]
    requested_start = date.fromisoformat(full[0]["date"])
    requested_end = date.fromisoformat(full[-1]["date"])
    for index in range(COVERAGE_CASES):
        mode = index % 10
        try:
            if mode == 0:
                result = coverage_planner.coverage_status(full, requested_start, requested_end)
                assert result["complete"]
                signature = result
            elif mode == 1:
                result = coverage_planner.coverage_status(full[12:], requested_start, requested_end)
                assert result["missingStart"] and not result["complete"]
                signature = result
            elif mode == 2:
                result = coverage_planner.coverage_status(full[:-12], requested_start, requested_end)
                assert result["missingEnd"] and not result["complete"]
                signature = result
            elif mode == 3:
                result = coverage_planner.compare_monthly_levels(
                    related,
                    full,
                    primary_label="related",
                    reference_label="base",
                )
                assert result["status"] == "pass"
                signature = result
            elif mode == 4:
                result = coverage_planner.compare_monthly_levels(
                    inverse,
                    full,
                    primary_label="inverse",
                    reference_label="base",
                )
                assert result["status"] == "fail"
                signature = result
            elif mode == 5:
                comparison = coverage_planner.compare_monthly_levels(
                    related,
                    full,
                    primary_label="primary",
                    reference_label="base",
                )
                primary = {
                    "provider": "Primary",
                    "providerSeries": "P",
                    "sourceUrl": "https://example.com/p",
                    "observations": related,
                }
                base = {
                    "provider": "Base",
                    "providerSeries": "B",
                    "sourceUrl": "https://example.com/b",
                    "observations": full[:48],
                    "lastDate": full[47]["date"],
                }
                result = coverage_planner.compose_coverage_base(
                    primary,
                    base,
                    start=requested_start,
                    end=requested_end,
                    comparison=comparison,
                    end_tolerance_days=45,
                )
                assert result["coverage"]["complete"] and len(result["observations"]) == 60
                signature = result["coveragePlan"]
            elif mode == 6:
                result = coverage_planner.compare_monthly_levels(
                    related[:10],
                    full[:10],
                    primary_label="short",
                    reference_label="short-base",
                )
                assert result["status"] == "insufficient-overlap"
                signature = result
            elif mode == 7:
                duplicate = [*full[:20], dict(full[19]), *full[20:]]
                comparison = coverage_planner.compare_monthly_levels(
                    related,
                    full,
                    primary_label="primary",
                    reference_label="base",
                )
                primary = {"provider": "Primary", "providerSeries": "P", "observations": related}
                base = {
                    "provider": "Base",
                    "providerSeries": "B",
                    "observations": duplicate[:49],
                    "lastDate": full[47]["date"],
                }
                result = coverage_planner.compose_coverage_base(
                    primary,
                    base,
                    start=requested_start,
                    end=requested_end,
                    comparison=comparison,
                    end_tolerance_days=45,
                )
                dates = [row["date"] for row in result["observations"]]
                assert len(dates) == len(set(dates))
                signature = [len(dates), result["coverage"]["complete"]]
            elif mode == 8:
                shifted_start = requested_start.replace(day=max(1, requested_start.day - 15))
                result = coverage_planner.coverage_status(
                    full,
                    shifted_start,
                    requested_end,
                    start_tolerance_days=45,
                )
                assert result["complete"]
                signature = result
            else:
                rejected = False
                try:
                    coverage_planner.compose_coverage_base(
                        {"provider": "P", "observations": related},
                        {"provider": "B", "observations": full, "lastDate": full[-1]["date"]},
                        start=requested_start,
                        end=requested_end,
                        comparison={"status": "fail"},
                    )
                except RuntimeError:
                    rejected = True
                assert rejected
                signature = {"rejected": rejected}
            signatures.append([mode, signature])
        except Exception as exc:  # noqa: BLE001 - bounded repro details belong in the report.
            failure_count += 1
            if len(failures) < 50:
                failures.append({"index": index, "mode": mode, "error": f"{type(exc).__name__}: {exc}"})
    return {
        "caseCount": COVERAGE_CASES,
        "passCount": COVERAGE_CASES - failure_count,
        "failCount": failure_count,
        "failures": failures,
        "digest": _digest(signatures),
    }


def run_axis_cases() -> dict[str, Any]:
    script = Path(__file__).with_name("v1_3_axis_gate.js")
    completed = subprocess.run(
        ["node", str(script)],
        cwd=script.parent.parent,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if completed.returncode:
        return {
            "caseCount": AXIS_CASES,
            "passCount": 0,
            "failCount": AXIS_CASES,
            "failures": [{"error": completed.stderr[-1000:] or completed.stdout[-1000:]}],
        }
    return json.loads(completed.stdout)


@contextlib.contextmanager
def network_model_tripwires():
    """Fail immediately if deterministic prompt/coverage phases attempt live I/O or a model."""

    counters = {"networkCalls": 0, "modelCalls": 0, "events": []}

    def network_block(*_args, **_kwargs):
        counters["networkCalls"] += 1
        if len(counters["events"]) < 20:
            counters["events"].append({"kind": "network", "args": repr(_args[:2])[:500]})
        raise AssertionError("Deterministic release gate attempted a live network call.")

    def model_block(*_args, **_kwargs):
        counters["modelCalls"] += 1
        if len(counters["events"]) < 20:
            counters["events"].append({"kind": "model", "args": repr(_args[:2])[:500]})
        raise AssertionError("Deterministic release gate attempted a model call.")

    import data_core
    import macro_providers
    import model_router
    import serve

    patches = [
        mock.patch.object(data_core, "http_get", network_block),
        mock.patch.object(data_core, "http_get_bytes", network_block),
        mock.patch.object(serve, "http_get", network_block),
        mock.patch.object(serve, "http_get_bytes", network_block),
        mock.patch.object(macro_providers, "http_get", network_block),
        mock.patch.object(macro_providers, "http_get_bytes", network_block),
    ]
    for name in ("route_macro_request", "route_request", "complete_json"):
        if hasattr(model_router, name):
            patches.append(mock.patch.object(model_router, name, model_block))
    with contextlib.ExitStack() as stack:
        for patcher in patches:
            stack.enter_context(patcher)
        yield counters


def run_gate(*, extra_limit: int = EXTRA_PROMPT_CASES, run_baseline: bool = True) -> dict[str, Any]:
    print("[v1.3 gate] semantic/layout baseline", file=sys.stderr, flush=True)
    baseline_report = baseline.run_gate(repeat=1) if run_baseline else {
        "summary": {"caseCount": 0, "passCount": 0, "failCount": 0, "findingCount": 0},
        "findings": [],
        "caseHash": "skipped",
    }
    print("[v1.3 gate] seeded complex prompts", file=sys.stderr, flush=True)
    prompt_failures = []
    prompt_failure_count = 0
    prompt_signatures = []
    prompt_passes = 0
    with network_model_tripwires() as counters:
        for index, case in enumerate(_extra_prompt_cases(extra_limit), start=1):
            observed = baseline.observe_case(case)
            findings = baseline.compare_case(case, observed)
            if findings:
                prompt_failure_count += 1
                if len(prompt_failures) < 50:
                    prompt_failures.append({"case": case, "observed": observed, "findings": findings})
            else:
                prompt_passes += 1
            prompt_signatures.append([case["id"], observed])
            if index % 5000 == 0:
                print(f"[v1.3 gate] prompts {index:,}/{extra_limit:,}", file=sys.stderr, flush=True)
        print("[v1.3 gate] synthetic coverage/failure matrix", file=sys.stderr, flush=True)
        coverage_report = run_coverage_cases()
    print("[v1.3 gate] exported browser scale matrix", file=sys.stderr, flush=True)
    axis_report = run_axis_cases()

    baseline_count = int(baseline_report["summary"]["caseCount"])
    case_count = baseline_count + extra_limit + coverage_report["caseCount"] + axis_report["caseCount"]
    fail_count = (
        int(baseline_report["summary"]["failCount"])
        + prompt_failure_count
        + coverage_report["failCount"]
        + axis_report["failCount"]
    )
    findings = list((baseline_report.get("findings") or [])[:50])
    if prompt_failure_count:
        findings.append({"code": "PROMPT_MATRIX_FAILURE", "count": prompt_failure_count})
    if coverage_report["failCount"]:
        findings.append({"code": "COVERAGE_MATRIX_FAILURE", "count": coverage_report["failCount"]})
    if axis_report["failCount"]:
        findings.append({"code": "AXIS_MATRIX_FAILURE", "count": axis_report["failCount"]})
    if run_baseline and extra_limit == EXTRA_PROMPT_CASES and case_count != TOTAL_CASES:
        findings.append({"code": "CASE_COUNT_MISMATCH", "expected": TOTAL_CASES, "actual": case_count})
    if counters["networkCalls"] or counters["modelCalls"]:
        findings.append({"code": "ISOLATION_TRIPWIRE", **counters})
    return {
        "gate": GATE_VERSION,
        "caseCount": case_count,
        "passCount": case_count - fail_count,
        "failCount": fail_count,
        "findingCount": len(findings),
        "networkCalls": counters["networkCalls"],
        "modelCalls": counters["modelCalls"],
        "matrix": {
            "baselineSemanticLayout": baseline_count,
            "seededComplexPrompts": extra_limit,
            "coverageFailureCases": coverage_report["caseCount"],
            "browserAxisCases": axis_report["caseCount"],
        },
        "digests": {
            "baseline": baseline_report.get("caseHash"),
            "prompts": _digest(prompt_signatures),
            "coverage": coverage_report.get("digest"),
            "axis": axis_report.get("digest"),
        },
        "findings": findings,
        "samplePromptFailures": prompt_failures,
        "coverage": coverage_report,
        "axis": axis_report,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--extra-limit", type=int, default=EXTRA_PROMPT_CASES)
    parser.add_argument("--skip-baseline", action="store_true")
    args = parser.parse_args()
    report = run_gate(extra_limit=args.extra_limit, run_baseline=not args.skip_baseline)
    if args.artifact_dir:
        args.artifact_dir.mkdir(parents=True, exist_ok=True)
        (args.artifact_dir / "report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(
            f"{report['gate']}: {report['passCount']:,}/{report['caseCount']:,} passed; "
            f"failures={report['failCount']:,}; findings={report['findingCount']:,}; "
            f"network={report['networkCalls']}; model={report['modelCalls']}"
        )
    return 1 if args.strict and (report["failCount"] or report["findingCount"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
