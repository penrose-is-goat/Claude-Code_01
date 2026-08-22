"""Command-line semantic audit runner for all three Side Tools.

Examples from the side-tools directory::

    python -m qa.runner --tool all --no-variants
    python -m qa.runner --tool all --strict
    python -m qa.runner --tool macro --json

The default command is report-oriented and exits zero even when the current
application has findings. ``--strict`` is the release gate and exits nonzero
when a contract or fixture invariant fails.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from typing import Any, Iterable

from .adapters import run_current
from .contracts import Finding, finding_dicts, validate_contract, validate_fixture_invariants
from .corpora import SEEDS, iter_cases, load_corpus


TOOLS = tuple(SEEDS)


def _case_result(case: dict[str, Any]) -> dict[str, Any]:
    tool = str(case["tool"])
    observed = run_current(tool, str(case["prompt"]))
    findings = validate_contract(case, observed)
    return {
        "tool": tool,
        "caseId": case["id"],
        "baseId": case.get("baseId", case["id"]),
        "variant": case.get("variant", "base"),
        "prompt": case["prompt"],
        "status": "pass" if not findings else "fail",
        "findings": finding_dicts(findings),
        "observed": observed,
    }


def _invariant_result(tool: str) -> dict[str, Any]:
    findings = validate_fixture_invariants(load_corpus(tool))
    return {
        "tool": tool,
        "status": "pass" if not findings else "fail",
        "findings": finding_dicts(findings),
    }


def run_audit(
    *,
    tool: str = "all",
    include_variants: bool = True,
    generated_variants: bool = True,
    limit: int | None = None,
) -> dict[str, Any]:
    """Run deterministic current-module audits without live data or models."""

    selected_tools = TOOLS if tool == "all" else (tool,)
    case_results: list[dict[str, Any]] = []
    invariant_results: list[dict[str, Any]] = []
    for selected_tool in selected_tools:
        corpus = load_corpus(selected_tool)
        invariant_results.append(_invariant_result(selected_tool))
        cases = iter_cases(
            selected_tool,
            include_variants=include_variants,
            generated_variants=generated_variants,
        )
        for case in cases:
            case["tool"] = selected_tool
            case_results.append(_case_result(case))
            if limit is not None and len(case_results) >= limit:
                break
        if limit is not None and len(case_results) >= limit:
            break

    all_findings = [finding for result in case_results for finding in result["findings"]]
    all_findings.extend(finding for result in invariant_results for finding in result["findings"])
    status_counts = Counter(result["status"] for result in case_results)
    status_counts.update(result["status"] for result in invariant_results)
    return {
        "schemaVersion": 1,
        "mode": "deterministic-current-modules",
        "seeds": {name: SEEDS[name] for name in selected_tools},
        "tools": list(selected_tools),
        "summary": {
            "caseCount": len(case_results),
            "casePassCount": sum(result["status"] == "pass" for result in case_results),
            "caseFailCount": sum(result["status"] == "fail" for result in case_results),
            "invariantPassCount": sum(result["status"] == "pass" for result in invariant_results),
            "invariantFailCount": sum(result["status"] == "fail" for result in invariant_results),
            "findingCount": len(all_findings),
            "statusCounts": dict(status_counts),
        },
        "invariants": invariant_results,
        "cases": case_results,
    }


def _format_text(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "Side Tools deterministic semantic audit",
        f"Tools: {', '.join(report['tools'])}",
        f"Seeds: {json.dumps(report['seeds'], sort_keys=True)}",
        (
            f"Cases: {summary['caseCount']} total, {summary['casePassCount']} pass, "
            f"{summary['caseFailCount']} fail; fixture invariants: "
            f"{summary['invariantPassCount']} pass, {summary['invariantFailCount']} fail"
        ),
    ]
    for result in report["invariants"]:
        lines.append(f"[{'PASS' if result['status'] == 'pass' else 'FAIL'}] {result['tool']} fixture invariants")
        for finding in result["findings"]:
            lines.append(f"  {finding['code']}: {finding['message']}")
    for result in report["cases"]:
        if result["status"] == "pass":
            continue
        lines.append(f"[FAIL] {result['caseId']} ({result['variant']})")
        for finding in result["findings"]:
            lines.append(f"  {finding['code']}: {finding['message']}")
        observed_error = result["observed"].get("error")
        if observed_error:
            lines.append(f"  observed error: {observed_error}")
    if not summary["caseFailCount"] and not summary["invariantFailCount"]:
        lines.append("All deterministic contract and invariant checks passed.")
    else:
        lines.append("Current-module findings are reported above; use --strict for a release-gate exit code.")
    return "\n".join(lines)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tool", choices=["all", *TOOLS], default="all")
    parser.add_argument("--no-variants", action="store_true", help="Run base prompts only.")
    parser.add_argument("--no-generated-variants", action="store_true", help="Use explicit fixture variants only.")
    parser.add_argument("--limit", type=int, default=None, help="Stop after this many cases across selected tools.")
    parser.add_argument("--json", action="store_true", help="Print the complete JSON report.")
    parser.add_argument("--strict", action="store_true", help="Exit 1 if any contract or invariant fails.")
    args = parser.parse_args(list(argv) if argv is not None else None)
    report = run_audit(
        tool=args.tool,
        include_variants=not args.no_variants,
        generated_variants=not args.no_generated_variants,
        limit=args.limit,
    )
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else _format_text(report))
    failed = report["summary"]["caseFailCount"] + report["summary"]["invariantFailCount"]
    return 1 if args.strict and failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
