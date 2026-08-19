# Zillow parser fixtures

`search-page.html` is **hand-constructed** from Zillow's documented `__NEXT_DATA__`
shape. It is not a captured page. The environment this was built in blocks all outbound
HTTPS (every host 403s at the egress proxy), so a real capture was not obtainable here.

## Cross-validation against real sources

Because the fixture cannot prove the mapping is right, the parser was checked against two
independent sources that *do* have real contact with Zillow. Both found genuine bugs the
fixture had hidden:

**[johnbalvin/pyzill](https://github.com/johnbalvin/pyzill)** — a Python client that
issues real requests to Zillow.

1. It calls `html.unescape()` before `json.loads()`. Zillow serves the blob with entities
   escaped, so a direct `JSON.parse` throws. Our parser did not decode entities, and would
   have failed on its first real page — reported as a malformed blob, which reads like a
   schema change rather than an encoding detail. Fixed: raw parse is tried first, then a
   decoded retry.
2. Its docs state `mapResults` "contains all the listings from all paginations" while
   `listResults` "is more for the right side bar". Our parser preferred `listResults`,
   which silently under-collects — you get the page you can see, not the area you asked
   for. Fixed: both arrays are merged and deduplicated by zpid.

**[@use_homi/real-estate-portal-schemas](https://www.npmjs.com/package/@use_homi/real-estate-portal-schemas)**
— query-parameter schemas "verified against the live site on 2026-04-22 via browser
automation".

3. Confirms the `/{city-slug}/` endpoint shape this project builds, and that a slug
   without a `regionId` "will still work for basic navigation" — so `buildSearchUrl` is
   sound as written.
4. Its verified `filterState` schema contains **no** open-house key, which supports
   reaching open houses through the `/open-house/` URL path rather than a filter
   parameter, as this project does.

These checks validate the field mapping and URL construction. They still cannot prove the
parser handles Zillow's current live *bytes*.

## Getting a real capture

From any machine with normal internet access:

```bash
npm run verify-live   # fetches one real page and writes live-capture.html
npm test              # the parser tests then prefer that real capture
```

`blocked-page.html` is likewise a constructed sample of a challenge interstitial, used to
check that block detection fires on page chrome and — more importantly — does *not* fire
on ordinary listing prose.
