"""Dependency-free semantic QA harness for Side Tools."""

from .corpora import SEEDS, iter_cases, load_corpus


def run_audit(*args, **kwargs):
    """Lazy import to keep ``python -m qa.runner`` warning-free."""

    from .runner import run_audit as _run_audit

    return _run_audit(*args, **kwargs)


__all__ = ["SEEDS", "iter_cases", "load_corpus", "run_audit"]
