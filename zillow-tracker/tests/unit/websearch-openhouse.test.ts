import { describe, expect, it } from 'vitest';
import { parseOpenHouses, parseTimeWindow } from '../../src/lib/providers/websearch/openHouse';

/**
 * Every non-synthetic string here was returned by a live web search of zillow.com during
 * planning — provenance matters because this project forbids invented data and the
 * parser exists to keep that promise. Synthetic edge cases are labelled `// synthetic`.
 */

const TZ = 'America/New_York';
// A fixed today so tests never depend on the wall clock.
const TODAY = new Date('2026-08-22T15:00:00Z'); // a Saturday

describe('parseTimeWindow', () => {
  it('reads a fully-marked window', () => {
    expect(parseTimeWindow('Open 11am-1pm')).toEqual({
      startHour: 11, startMinute: 0, endHour: 13, endMinute: 0,
    });
  });

  it('carries the end meridiem back to a bare start', () => {
    // "12-2pm" is noon to 2pm; reading the 12 as midnight would put the event twelve
    // hours earlier than the real one.
    expect(parseTimeWindow('Open 12-2pm')).toMatchObject({ startHour: 12, endHour: 14 });
    expect(parseTimeWindow('Open 10am-12pm')).toMatchObject({ startHour: 10, endHour: 12 });
  });

  it('reads half hours', () => {
    expect(parseTimeWindow('Open 11am-12:30pm'))
      .toEqual({ startHour: 11, startMinute: 0, endHour: 12, endMinute: 30 });
  });

  it('assumes the afternoon when nobody wrote am or pm', () => {
    // "Open 1-4" is the only realistic reading of a Sunday open house; nobody holds one
    // between 1am and 4am, and treating it that way would put the event on the calendar
    // at a time it certainly is not.
    expect(parseTimeWindow('Open Sunday 1-4')).toMatchObject({ startHour: 13, endHour: 16 });
  });

  it('accepts en-dash, em-dash, "to", and "until" as separators', () => {
    for (const sep of ['-', '–', '—', ' to ', ' until ']) {
      expect(parseTimeWindow(`Open 11am${sep}1pm`), sep)
        .toMatchObject({ startHour: 11, endHour: 13 });
    }
  });

  it('returns null when only the start is stated', () => {
    // "time slots from 11:00 am onwards" is a start with no end. Inventing an end is
    // exactly the fabrication this parser refuses.
    expect(parseTimeWindow('time slots from 11:00 am onwards')).toBeNull();
  });

  it('returns null for garbage', () => {
    for (const s of ['', 'no times here', '$1,234,567', '4 beds 3 baths']) {
      expect(parseTimeWindow(s), s).toBeNull();
    }
  });
});

describe('parseOpenHouses — real strings from live Zillow snippets', () => {
  const REAL_SNIPPETS: Array<[string, string, number]> = [
    ['1311 E Fort Ave, Baltimore, MD 21230 - Open Sat 11am-1pm',           '2026-08-22T11:00', 13],
    ['236 S Collington Ave, Baltimore, MD 21231 - Open Sat 12-2pm',        '2026-08-22T12:00', 14],
    ['1711 Wickes Ave, Baltimore, MD 21230 - Open Sat 10am-12pm',          '2026-08-22T10:00', 12],
    ['1337 S Charles St, Baltimore, MD 21230 - Open Sat 12-2pm',           '2026-08-22T12:00', 14],
    ['117 N Belnord Ave, Baltimore, MD 21224 - Open Sat 11am-1pm',         '2026-08-22T11:00', 13],
    ['3213 E Baltimore St, Baltimore, MD 21224 - Open Sat 10am-12pm',      '2026-08-22T10:00', 12],
    ['2513 E Fayette St, Baltimore, MD 21224 - Open Sun 12-2pm',           '2026-08-23T12:00', 14],
    ['5309 Catalpha Rd, Baltimore, MD 21214 - Open Sun 11am-12:30pm',      '2026-08-23T11:00', 12.5],
    ['11706 Hatcher Pl, Silver Spring, MD 20902 is open on Saturday from 11am-2pm', '2026-08-22T11:00', 14],
    ['9309 Warren St, Silver Spring, MD 20910 - Open Sunday 1-4',          '2026-08-23T13:00', 16],
  ];

  for (const [snippet, start, endHour] of REAL_SNIPPETS) {
    it(`parses: ${snippet.slice(0, 50)}…`, () => {
      const [event] = parseOpenHouses(snippet, { today: TODAY, timezone: TZ });
      expect(event).toBeDefined();
      expect(event.localStart).toBe(start);
      const [h, m] = event.localEnd.slice(11).split(':').map(Number);
      expect(h + m / 60).toBeCloseTo(endHour, 5);
    });
  }

  it('takes an explicit date over a weekday when both appear', () => {
    // Real string. The (8/22) is a Saturday and matches — this exercises the "explicit
    // wins" rule, not a mismatch.
    const [event] = parseOpenHouses(
      '121 Whitmoor Ter, Silver Spring, MD 20901 - Open Saturday 12-1:30pm (8/22), $475,000',
      { today: TODAY, timezone: TZ },
    );
    expect(event.localStart).toBe('2026-08-22T12:00');
    expect(event.localEnd).toBe('2026-08-22T13:30');
    expect(event.dateSource).toBe('explicit');
  });
});

describe('rejecting stale cache — the failure that matters most', () => {
  // A search index keeps snippets for years. Presenting them as upcoming would send
  // someone to a locked door on a Saturday morning.
  const CTX = { today: TODAY, timezone: TZ };

  it('drops a "Nov 6" from a previous November — with today in August', () => {
    // Real string. "Nov 6" here is stale: Nov 6 has not yet happened this year, but
    // rolling it forward to the next Nov 6 is 76+ days out, well past when any real open
    // house would be announced. The parser must return nothing.
    expect(parseOpenHouses(
      '10212 Douglas Ave, Silver Spring, MD 20902 - Open Saturday, Oct 2 and Sunday, Oct 3 with time slots from 11:00 am onwards',
      CTX,
    )).toEqual([]);
  });

  it('drops a stale multi-day snippet with no year', () => {
    // Real string. Two "past" dates and a start-only time — even if the times parsed,
    // both dates are stale, so nothing survives.
    expect(parseOpenHouses(
      'Open Friday, Nov 26, Saturday, Nov 27, and Sunday, Nov 28 with time slots from 9:00 am onwards',
      CTX,
    )).toEqual([]);
  });

  it('keeps an event from a couple of days ago (recent-crawl allowance)', () => {
    // synthetic — Aug 20 is two days before TODAY, still within the fresh-crawl window,
    // so a snippet describing it may legitimately show up.
    const [event] = parseOpenHouses('Open 8/20 12-2pm', CTX);
    expect(event?.localStart).toBe('2026-08-20T12:00');
  });

  it('drops a date from six months back with no year', () => {
    // synthetic — Feb 15 is roughly six months past; rolling to next Feb 15 is far out
    // of any plausible open-house window.
    expect(parseOpenHouses('Open 2/15 12-2pm', CTX)).toEqual([]);
  });
});

describe('multiple events in one string', () => {
  it('splits a Saturday and a Sunday event apart', () => {
    // synthetic date so both fall within the fresh window (this weekend).
    const events = parseOpenHouses(
      'Open Saturday, 8/22 12-2pm and Sunday, 8/23 1-3pm',
      { today: TODAY, timezone: TZ },
    );
    expect(events).toHaveLength(2);
    expect(events[0].localStart).toBe('2026-08-22T12:00');
    expect(events[1].localStart).toBe('2026-08-23T13:00');
  });

  it('deduplicates when the same event is described twice', () => {
    const events = parseOpenHouses(
      'Open Saturday 12-2pm. Also Saturday 12-2pm.',
      { today: TODAY, timezone: TZ },
    );
    expect(events).toHaveLength(1);
  });
});

describe('never fabricates', () => {
  it('returns nothing for a start-only "onwards" phrase', () => {
    expect(parseOpenHouses('Open Saturday from 11:00 am onwards', { today: TODAY, timezone: TZ }))
      .toEqual([]);
  });

  it('returns nothing for text stating no time at all', () => {
    expect(parseOpenHouses('Beautiful home, 4 beds and 3 baths, $650,000', { today: TODAY, timezone: TZ }))
      .toEqual([]);
    expect(parseOpenHouses('', { today: TODAY, timezone: TZ })).toEqual([]);
  });

  it('returns nothing when a start-end pair fails to order after inference', () => {
    // synthetic — "2pm-12" would only make sense if the 12 rolled to the next day, which
    // is not how open houses read. Drop rather than heal.
    expect(parseOpenHouses('Open Saturday 2pm-12', { today: TODAY, timezone: TZ })).toEqual([]);
  });
});

describe('weekday resolution', () => {
  it('resolves "Saturday" to today when today is Saturday', () => {
    const [event] = parseOpenHouses('Open Saturday 11am-1pm', { today: TODAY, timezone: TZ });
    expect(event.localStart).toBe('2026-08-22T11:00');
    expect(event.dateSource).toBe('weekday');
  });

  it('resolves "Sunday" to tomorrow when today is Saturday', () => {
    const [event] = parseOpenHouses('Open Sunday 1-3pm', { today: TODAY, timezone: TZ });
    expect(event.localStart).toBe('2026-08-23T13:00');
  });

  it('resolves next Wednesday, not today', () => {
    // synthetic — today is Sat 8/22, so next Wed is 8/26.
    const [event] = parseOpenHouses('Open Wednesday 5-7pm', { today: TODAY, timezone: TZ });
    expect(event.localStart).toBe('2026-08-26T17:00');
  });
});
