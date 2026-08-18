# Zillow parser fixtures

`search-page.html` is **hand-constructed** from Zillow's documented `__NEXT_DATA__`
shape. It is not a captured page, and it is labelled that way deliberately rather than
being passed off as real: the environment this was built in blocks all outbound HTTPS
(every host returns 403 from the egress proxy), so a real capture was not obtainable
here.

It still does real work — it pins the parser's field mapping, the malformed-row skip
path, epoch-vs-ISO date handling, and the block-detection logic — but it cannot prove
the mapping matches Zillow's *current* live output. Only a real page can do that.

To replace it with the real thing, from a machine with normal internet access:

```bash
npm run verify-live          # fetches one real page and writes live-capture.html
npm test                     # parser tests then run against the real capture too
```

`blocked-page.html` is likewise a constructed sample of a challenge interstitial, used
to check that block detection fires on page chrome and — more importantly — does *not*
fire on ordinary listing prose.
