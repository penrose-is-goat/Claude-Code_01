# Cross-Tool Semantic QA

This package is a dependency-free, read-only evaluation harness for the three
Side Tools. It does not edit or monkey-patch application modules and it does
not call Ollama or live providers during deterministic runs.

The corpora use fixed seeds:

- Macro Data Lab: `3001`
- Fed Tracker: `3002`
- Treasury Auction Tracker: `3003`

Each corpus contains base requests, explicit typo/metatext/paraphrase variants,
deterministically generated variants, expected concepts or controls, forbidden
concepts, and source/numerical invariant fixtures. The required regression
requests are included verbatim, including the equity/debt comparison, `compare
next meeting to prior snapshots`, and the 2012 10-year Treasury PDF request.

Macro expectations use two separate identifiers: `conceptIds` are the
application's semantic concept keys, while `sourceSeriesIds` are native
provider identifiers such as `BOGZ1LM883164115Q` and `ASTDSL`. A provider ID is
never accepted as a substitute for a wrong semantic concept. Treasury document
intent is asserted through the existing `panels` contract containing
`documents`, together with an empty metric list for document-only requests; the
harness does not require a separate `pdfRequested` field.

Run from `side-tools`:

```powershell
python -m unittest -v test_semantic_qa
python -m qa.runner --tool all --no-variants
python -m qa.runner --tool all --strict
python -m qa.runner --tool all --json > qa-report.json
```

The ordinary runner is report-oriented and exits zero so it can be used against
the current application while it is being repaired. `--strict` is the release
gate and exits nonzero for any contract or invariant finding. No data fetch is
needed for these commands.
