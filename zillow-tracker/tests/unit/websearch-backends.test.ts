import { describe, expect, it, vi } from 'vitest';
import {
  MojeekBackend, extractMojeekResults, resolveBackend, defaultBackends,
} from '../../src/lib/providers/websearch/backends';

/**
 * Mojeek's response shape is unconfirmed against the live API from this container's
 * network — every field-name variant below is a shape the parser must tolerate, and the
 * "unrecognized shape" test is the one that actually protects the product. If the field
 * names shift, wrong shape becomes "no results", never wrong results or a crash.
 */

const KEY = 'test-key';

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('extractMojeekResults', () => {
  it('reads the documented response.results shape with desc', () => {
    const results = extractMojeekResults({
      response: { results: [
        { url: 'https://www.zillow.com/homedetails/1_zpid/', title: 'a', desc: 'x' },
        { url: 'https://www.zillow.com/homedetails/2_zpid/', title: 'b', desc: 'y' },
      ]},
    });
    expect(results).toEqual([
      { url: 'https://www.zillow.com/homedetails/1_zpid/', title: 'a', description: 'x' },
      { url: 'https://www.zillow.com/homedetails/2_zpid/', title: 'b', description: 'y' },
    ]);
  });

  it('accepts a bare top-level results array', () => {
    const results = extractMojeekResults({
      results: [{ url: 'https://example.test/', title: 't', desc: 'd' }],
    });
    expect(results).toHaveLength(1);
  });

  it('accepts description or snippet as alternatives to desc', () => {
    for (const [key, val] of [['description', 'from description'], ['snippet', 'from snippet']]) {
      const r = extractMojeekResults({ response: { results: [
        { url: 'https://x.test/', title: 't', [key]: val },
      ] } });
      expect(r[0].description, key).toBe(val);
    }
  });

  it('drops rows without a url or title rather than emitting placeholders', () => {
    const r = extractMojeekResults({ response: { results: [
      { url: 'https://x.test/', title: '' },
      { url: '', title: 't' },
      { title: 'no url' },
      { url: 'https://x.test/y', title: 'good', desc: 'ok' },
    ] } });
    expect(r).toEqual([{ url: 'https://x.test/y', title: 'good', description: 'ok' }]);
  });

  it('accepts link as an alternate to url, in case the field is renamed', () => {
    expect(extractMojeekResults({ results: [{ link: 'https://x.test/', title: 't' }] }))
      .toHaveLength(1);
  });

  it('degrades to no results on an unrecognized shape, never to wrong results', () => {
    // The load-bearing test: the shape is unverified, and if Mojeek changes it, silence
    // must be the failure mode. Anything that would surface invented data is a defect.
    for (const bad of [null, undefined, 'string', 42, {}, { results: 'not-array' },
                       { response: { results: 'not-array' } }, { response: null }, []]) {
      expect(extractMojeekResults(bad as unknown), JSON.stringify(bad)).toEqual([]);
    }
  });
});

describe('MojeekBackend', () => {
  it('reports itself unconfigured with no key', () => {
    expect(new MojeekBackend('').isConfigured()).toBe(false);
    expect(new MojeekBackend(KEY).isConfigured()).toBe(true);
  });

  it('runs a well-formed query and parses results', async () => {
    const b = new MojeekBackend(KEY, fakeFetch({
      response: { results: [{ url: 'https://x.test/', title: 't', desc: 'd' }] },
    }));
    const r = await b.search('anything');
    expect(r).toHaveLength(1);
  });

  it('names the quota specifically on 429, so support is one line not a lookup', async () => {
    const b = new MojeekBackend(KEY, fakeFetch({}, 429));
    await expect(b.search('q')).rejects.toThrow(/quota|rate limit|2,000/i);
  });

  it('distinguishes an invalid key from a rate limit', async () => {
    for (const status of [401, 403]) {
      const b = new MojeekBackend(KEY, fakeFetch({}, status));
      await expect(b.search('q'), String(status)).rejects.toThrow(/rejected the API key/i);
    }
  });

  it('reports server errors distinctly from client errors', async () => {
    const b = new MojeekBackend(KEY, fakeFetch({}, 502));
    await expect(b.search('q')).rejects.toThrow(/server error/i);
  });

  it('never puts the API key into an error message', async () => {
    const secret = 'sk_never_leak_this_value';
    const b = new MojeekBackend(secret, fakeFetch({}, 401));
    try {
      await b.search('q');
    } catch (err) {
      // A leaked key in stderr or a shared error trace is a real incident. This test is
      // the one that guarantees it cannot happen through the normal error path.
      expect(String(err)).not.toContain(secret);
    }
  });
});

describe('resolveBackend', () => {
  const prevMojeek = process.env.MOJEEK_API_KEY;
  const prevBrave = process.env.BRAVE_SEARCH_API_KEY;
  const prevGoogle = process.env.GOOGLE_CSE_KEY;
  const prevSearxng = process.env.SEARXNG_URL;

  function clearEnv() {
    delete process.env.MOJEEK_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_CSE_KEY;
    delete process.env.GOOGLE_CSE_CX;
    delete process.env.SEARXNG_URL;
    delete process.env.SEARCH_BACKEND;
  }
  function restore() {
    if (prevMojeek) process.env.MOJEEK_API_KEY = prevMojeek; else delete process.env.MOJEEK_API_KEY;
    if (prevBrave) process.env.BRAVE_SEARCH_API_KEY = prevBrave; else delete process.env.BRAVE_SEARCH_API_KEY;
    if (prevGoogle) process.env.GOOGLE_CSE_KEY = prevGoogle; else delete process.env.GOOGLE_CSE_KEY;
    if (prevSearxng) process.env.SEARXNG_URL = prevSearxng; else delete process.env.SEARXNG_URL;
  }

  it('picks Mojeek when its key is present, even if others are also set', () => {
    clearEnv();
    try {
      process.env.MOJEEK_API_KEY = 'mojeek-key';
      process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
      const { backend, hints } = resolveBackend(defaultBackends());
      expect(backend?.id).toBe('mojeek');
      expect(hints).toEqual([]);
    } finally { restore(); }
  });

  it('picks Brave when only Brave is configured', () => {
    clearEnv();
    try {
      process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
      const { backend } = resolveBackend(defaultBackends());
      expect(backend?.id).toBe('brave');
    } finally { restore(); }
  });

  it('leads the setup hint with Mojeek when nothing is configured', () => {
    clearEnv();
    try {
      const { backend, hints } = resolveBackend(defaultBackends());
      expect(backend).toBeNull();
      // The point of the reorder: a fresh install must be told the two-minute answer
      // FIRST, not sent to a dead Google signup and a paywalled Brave signup.
      expect(hints[0]).toMatch(/Mojeek/i);
      expect(hints[0]).toMatch(/no credit card/i);
    } finally { restore(); }
  });

  it('honours SEARCH_BACKEND override and reports its own setup hint on failure', () => {
    clearEnv();
    try {
      process.env.SEARCH_BACKEND = 'mojeek';
      const { backend, hints } = resolveBackend(defaultBackends());
      expect(backend).toBeNull();
      expect(hints.join(' ')).toMatch(/MOJEEK_API_KEY/);
    } finally { restore(); }
  });

  it('reports an unknown SEARCH_BACKEND value with its actual value', () => {
    clearEnv();
    try {
      process.env.SEARCH_BACKEND = 'never-existed';
      const { backend, hints } = resolveBackend(defaultBackends());
      expect(backend).toBeNull();
      expect(hints[0]).toContain('never-existed');
    } finally { restore(); }
  });
});
