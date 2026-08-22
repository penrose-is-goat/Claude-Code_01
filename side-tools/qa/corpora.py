"""Load and expand deterministic semantic fixture corpora."""

from __future__ import annotations

import copy
import json
import random
import re
from pathlib import Path
from typing import Any, Iterator


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
SEEDS = {"macro": 3001, "fed": 3002, "treasury": 3003}


def load_corpus(tool: str) -> dict[str, Any]:
    if tool not in SEEDS:
        raise ValueError(f"Unknown Side Tools corpus: {tool}")
    path = FIXTURE_DIR / f"{tool}.json"
    with path.open("r", encoding="utf-8") as handle:
        corpus = json.load(handle)
    if corpus.get("tool") != tool or corpus.get("seed") != SEEDS[tool]:
        raise ValueError(f"Corpus metadata is invalid for {tool}: {path}")
    return corpus


TYPO_REPLACEMENTS = {
    "capitalization": ("capitilzation", "capitalizaton"),
    "outstanding": ("outstading", "outstandig"),
    "probabilities": ("probablities", "probabilites"),
    "probability": ("probablity", "probabilty"),
    "historical": ("historcal", "historial"),
    "auction": ("aucton", "auctionn"),
    "auctions": ("auctons", "auctiones"),
    "services": ("servcies", "servicees"),
    "percent": ("persent", "precent"),
    "market": ("makret", "markett"),
    "securities": ("securites", "securitise"),
}

PARAPHRASE_REPLACEMENTS = (
    (r"\bshow me\b", "display"),
    (r"\bgraph\b", "plot"),
    (r"\bchart\b", "plot"),
    (r"\bcompare\b", "contrast"),
    (r"\bversus\b", "against"),
    (r"\bprior snapshots\b", "earlier dated snapshots"),
    (r"\bnext meeting\b", "upcoming meeting"),
    (r"\bauction results\b", "auction records"),
    (r"\bfor the last\b", "over the past"),
    (r"\b10 year\b", "ten-year"),
    (r"\b30 year\b", "thirty-year"),
)


def _seed_for_case(seed: int, case_id: str) -> int:
    return seed + sum((index + 1) * ord(char) for index, char in enumerate(case_id))


def _generated_variant(case: dict[str, Any], kind: str, seed: int) -> dict[str, Any] | None:
    prompt = str(case["prompt"])
    rng = random.Random(_seed_for_case(seed, f"{case['id']}:{kind}"))
    if kind == "typo":
        matches = [word for word in TYPO_REPLACEMENTS if re.search(rf"\b{re.escape(word)}\b", prompt, re.IGNORECASE)]
        if not matches:
            return None
        word = matches[rng.randrange(len(matches))]
        replacement = TYPO_REPLACEMENTS[word][rng.randrange(len(TYPO_REPLACEMENTS[word]))]
        variant_prompt = re.sub(rf"\b{re.escape(word)}\b", replacement, prompt, count=1, flags=re.IGNORECASE)
    elif kind == "metatext":
        prefixes = (
            "For an auditable research request, ",
            "Please use the verified data and ",
            "As a research analyst, ",
        )
        variant_prompt = prefixes[rng.randrange(len(prefixes))] + prompt[:1].lower() + prompt[1:]
    elif kind == "paraphrase":
        variant_prompt = prompt
        replacements = list(PARAPHRASE_REPLACEMENTS)
        rng.shuffle(replacements)
        for pattern, replacement in replacements:
            variant_prompt = re.sub(pattern, replacement, variant_prompt, flags=re.IGNORECASE)
        if variant_prompt == prompt:
            variant_prompt = f"Please display the following research request: {prompt}"
    else:
        raise ValueError(f"Unknown generated variant kind: {kind}")
    return {
        "kind": kind,
        "prompt": re.sub(r"\s+", " ", variant_prompt).strip(),
        "generated": True,
        "seed": _seed_for_case(seed, f"{case['id']}:{kind}"),
    }


def iter_cases(
    tool: str,
    *,
    include_variants: bool = True,
    generated_variants: bool = True,
) -> Iterator[dict[str, Any]]:
    """Yield base cases and stable explicit/generated prompt variants."""

    corpus = load_corpus(tool)
    seed = int(corpus["seed"])
    for base in corpus.get("cases", []):
        case = copy.deepcopy(base)
        case["variant"] = "base"
        case["baseId"] = base["id"]
        yield case
        if not include_variants:
            continue
        seen_prompts = {str(base["prompt"]).strip().lower()}
        explicit = list(base.get("variants", []))
        generated = []
        if generated_variants:
            for kind in ("typo", "metatext", "paraphrase"):
                variant = _generated_variant(base, kind, seed)
                if variant:
                    generated.append(variant)
        for index, variant in enumerate([*explicit, *generated], start=1):
            prompt = str(variant.get("prompt") or "").strip()
            if not prompt or prompt.lower() in seen_prompts:
                continue
            seen_prompts.add(prompt.lower())
            expanded = copy.deepcopy(base)
            expanded["id"] = f"{base['id']}::v{index:02d}"
            expanded["baseId"] = base["id"]
            expanded["prompt"] = prompt
            expanded["variant"] = str(variant.get("kind") or "variant")
            expanded["variantGenerated"] = bool(variant.get("generated"))
            expanded["variantSeed"] = variant.get("seed")
            expanded.pop("variants", None)
            yield expanded


def case_counts(tool: str, *, include_variants: bool = True) -> dict[str, int]:
    corpus = load_corpus(tool)
    base_count = len(corpus.get("cases", []))
    expanded_count = sum(1 for _ in iter_cases(tool, include_variants=include_variants))
    return {"base": base_count, "expanded": expanded_count}
