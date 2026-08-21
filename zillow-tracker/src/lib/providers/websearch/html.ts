import type { SearchResult } from './parse';

/**
 * Parsing a search engine's own HTML results page.
 *
 * This exists so the app works with no API key, no account and no configuration. Asking
 * someone to register for a search API before their house-hunting app will show them a
 * single house is a broken product, and that is what shipped: a fresh install typed in a
 * place and got a wall of setup instructions instead of listings.
 *
 * DuckDuckGo publishes a no-JavaScript HTML endpoint intended for exactly this kind of
 * plain client. It is the same public results page a person sees in a browser, requested
 * the same way, at human speed — the sweep paces itself and stops on a refusal rather
 * than hammering.
 *
 * The parsing is deliberately structural-but-forgiving: anchors are found by class, and
 * a class rename degrades to "no results" rather than to wrong results. Nothing here is
 * specific to Zillow; the Zillow-shaped parsing all happens later in parse.ts against the
 * title and snippet these functions extract.
 */

/**
 * DuckDuckGo wraps outbound links in a redirect:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.zillow.com%2F...&rut=...
 *
 * The real URL is the `uddg` parameter. Missing this step yields a page full of
 * duckduckgo.com links and zero recognizable Zillow pages, which looks exactly like
 * "no listings found".
 */
export function unwrapRedirect(href: string): string {
  const raw = href.startsWith('//') ? `https:${href}` : href;

  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) return target;
    return url.toString();
  } catch {
    return raw;
  }
}

/** Turns the entities a results page actually contains back into text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Ampersand last, or "&amp;lt;" decodes to "<" instead of "&lt;".
    .replace(/&amp;/g, '&');
}

/** Strips tags — search engines bold the matched terms inside titles and snippets. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parses the DuckDuckGo HTML endpoint (html.duckduckgo.com/html/).
 *
 * Structure confirmed against `deedy5/ddgs`, a maintained scraper that runs against the
 * live endpoint: results are `<div class="...body...">` blocks, the title lives in an
 * `<h2>`, and the outbound href and the snippet text both hang off the anchor in that
 * block. Both the class-named anchors (`result__a`, `result__snippet`) and the bare
 * structural form are accepted, because the class names are the part most likely to be
 * renamed and the shape is the part least likely to be.
 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  if (!html) return results;

  // Split into result blocks first so a title is only ever paired with its own snippet.
  // Matching titles and snippets independently and zipping them silently mismatches the
  // pair whenever one result happens to lack a snippet.
  const blocks = html.split(/<div[^>]*class="[^"]*\b(?:results?_links|links_main|result__body)\b[^"]*"/i).slice(1);
  const source = blocks.length > 0 ? blocks : [html];

  for (const block of source) {
    const href =
      matchAnchorHref(block, 'result__a') ??
      matchAnchorHref(block, 'result__snippet') ??
      block.match(/<a[^>]*href="([^"]+)"/i)?.[1];
    if (!href) continue;

    const url = unwrapRedirect(decodeEntities(href));

    // Sponsored results are served through y.js and are not organic index entries.
    if (/^https?:\/\/(?:[^/]*\.)?duckduckgo\.com\/y\.js/i.test(url)) continue;
    if (/^https?:\/\/(?:[^/]*\.)?duckduckgo\.com\//i.test(url)) continue;

    // The title is in the h2 when present; otherwise the text of the titled anchor.
    const title =
      pickText(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]) ??
      pickText(block.match(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1]);
    if (!title) continue;

    const snippet =
      pickText(block.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i)?.[1]);

    results.push({ url, title, description: snippet });
  }

  return dedupeByUrl(results);
}

/** Finds an anchor's href by class, tolerating either attribute order. */
function matchAnchorHref(block: string, className: string): string | undefined {
  const cls = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    block.match(new RegExp(`<a[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*href="([^"]+)"`, 'i'))?.[1] ??
    block.match(new RegExp(`<a[^>]*href="([^"]+)"[^>]*class="[^"]*\\b${cls}\\b[^"]*"`, 'i'))?.[1]
  );
}

function pickText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = stripTags(html);
  return text.length > 0 ? text : undefined;
}

/**
 * Parses Mojeek (mojeek.com/search), an independent index used as a second opinion.
 *
 * Having two unrelated engines matters for a coverage claim: if one is rate-limiting or
 * has thin Zillow coverage for an area, a single-engine harvest reports a small market
 * and cannot tell that from a small harvest.
 *
 * Structure per `deedy5/ddgs`: results are `<li>` items in a `<ul class="results">`,
 * title and href in `h2 > a`, snippet in `<p class="s">`.
 */
export function parseMojeekHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  if (!html) return results;

  const listMatch = html.match(/<ul[^>]*class="[^"]*\bresults\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  const list = listMatch ? listMatch[1] : html;

  for (const item of list.split(/<li[\s>]/i).slice(1)) {
    const anchor = item.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;

    const url = decodeEntities(anchor[1]);
    const title = pickText(anchor[2]);
    if (!url || !title || url.startsWith('/')) continue;

    const snippet = pickText(item.match(/<p[^>]*class="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    results.push({ url, title, description: snippet });
  }

  return dedupeByUrl(results);
}

/**
 * Parses the DuckDuckGo Lite endpoint (lite.duckduckgo.com/lite/), a table layout used
 * as a fallback when the HTML endpoint returns a challenge page.
 */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  if (!html) return results;

  const rows = [...html.matchAll(
    /<a[^>]*class="[^"]*\bresult-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*\bresult-link\b|$)/gi,
  )];

  for (const row of rows) {
    const url = unwrapRedirect(decodeEntities(row[1]));
    const title = stripTags(row[2]);
    if (!url || !title) continue;

    const snippet = row[3]?.match(/class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    results.push({ url, title, description: snippet ? stripTags(snippet[1]) : undefined });
  }

  return dedupeByUrl(results);
}

/**
 * Detects a bot challenge or rate-limit page.
 *
 * This matters more than it looks: a challenge page parses to zero results, which is
 * indistinguishable from "this area has no listings" unless it is named. A harvest that
 * silently reports an empty market because it got rate-limited is the exact failure this
 * project's canary rules exist to prevent.
 */
export function detectBlockPage(html: string): string | null {
  if (!html) return 'empty response';

  const head = html.slice(0, 4000).toLowerCase();
  if (/unfortunately, bots use duckduckgo too/.test(head)) return 'DuckDuckGo anti-bot page';
  if (/\bcaptcha\b/.test(head)) return 'CAPTCHA challenge';
  if (/too many requests|rate limit/.test(head)) return 'rate limited';
  if (/<title>[^<]*(?:blocked|forbidden|denied)[^<]*<\/title>/.test(head)) return 'blocked page';
  return null;
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = byUrl.get(r.url);
    // Prefer the copy that carries a description — that is where the listing facts are.
    if (!existing || (!existing.description && r.description)) byUrl.set(r.url, r);
  }
  return [...byUrl.values()];
}
