/**
 * Reading open-house days and times out of indexed search text.
 *
 * Zillow publishes open-house schedules to search engines the same way it publishes
 * prices, so a result snippet carries strings like `Open 11am-1pm` or
 * `Open Saturday 12-1:30pm (8/22)`. That text is the only place this app can get an
 * open-house time without fetching zillow.com, which returns 403 to everything.
 *
 * Two rules govern everything here, and both exist because the failure they prevent is
 * worse than returning nothing:
 *
 *  - A time that cannot be read with confidence is DROPPED, never guessed. An open house
 *    the app fails to show is a missed Saturday. An open house the app invents sends
 *    someone to a stranger's door.
 *  - A date that has already passed is STALE CACHE, not an event. Search indexes keep old
 *    snippets for years; a snippet reading "Open Saturday, Nov 6" is a listing from a
 *    previous November, and presenting it as upcoming is the same failure as inventing it.
 */

/** An open house, in the home's own local wall-clock time. */
export interface ParsedOpenHouse {
  /** Local wall clock, `YYYY-MM-DDTHH:mm`. Never UTC — a 1pm open house is 1pm there. */
  localStart: string;
  localEnd: string;
  /**
   * How the date was determined.
   *  - `explicit` — the text stated a calendar date.
   *  - `weekday`  — the text named a weekday and it was resolved forward from today.
   */
  dateSource: 'explicit' | 'weekday';
  /** The substring this came from, so a wrong reading can be traced to its source. */
  sourceText: string;
}

export interface OpenHouseContext {
  /** "Now", for resolving weekdays forward and rejecting stale dates. */
  today: Date;
  /** IANA zone of the listing, e.g. `America/New_York`. */
  timezone: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * How far in the past an explicit date may fall before it is treated as stale cache.
 *
 * Not zero: a snippet crawled this morning can legitimately describe an open house that
 * ended a few hours ago, and a listing whose event was yesterday is still worth showing
 * as "just happened". Beyond a few days it is certainly an old crawl.
 */
const STALE_AFTER_DAYS = 3;

/**
 * Reads every open house stated in a piece of text.
 *
 * Returns an empty array for text that states none, which is the common case — most
 * listings have no open house, and that is not an error.
 */
export function parseOpenHouses(text: string, ctx: OpenHouseContext): ParsedOpenHouse[] {
  if (!text) return [];

  const cleaned = text.replace(/\s+/g, ' ');
  const out: ParsedOpenHouse[] = [];
  const seen = new Set<string>();

  for (const segment of splitEvents(cleaned)) {
    const parsed = parseOne(segment, ctx);
    if (!parsed) continue;

    // The same event can be described twice in one snippet; keep it once.
    const key = `${parsed.localStart}|${parsed.localEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }

  return out;
}

/**
 * Splits text describing several events into one segment each.
 *
 * "Open Saturday, Nov 6 and Sunday, Nov 7" is two events, not one spanning both. Splitting
 * on the weekday names rather than on "and" keeps "12 and 2pm" style phrasing intact.
 */
function splitEvents(text: string): string[] {
  const dayPattern = new RegExp(`\\b(?=(?:${Object.keys(WEEKDAYS).join('|')})\\b)`, 'gi');
  const parts = text.split(dayPattern).filter((p) => p.trim().length > 0);

  // No weekday named at all: the whole string is at most one event.
  return parts.length > 1 ? parts : [text];
}

function parseOne(segment: string, ctx: OpenHouseContext): ParsedOpenHouse | null {
  const window = parseTimeWindow(segment);
  if (!window) return null;

  const date = resolveDate(segment, ctx);
  if (!date) return null;

  const stamp = (h: number, m: number) =>
    `${date.iso}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const localStart = stamp(window.startHour, window.startMinute);
  const localEnd = stamp(window.endHour, window.endMinute);

  // Any ordering failure that survived inference means the text was not understood.
  if (localEnd <= localStart) return null;

  return { localStart, localEnd, dateSource: date.source, sourceText: segment.trim() };
}

interface TimeWindow {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/**
 * Reads a start-to-end window: `11am-1pm`, `12-2pm`, `11am-12:30pm`, `1-4`.
 *
 * Deliberately requires BOTH ends. `time slots from 11:00 am onwards` states a start and
 * no finish, and inventing a plausible finish is exactly the fabrication this file
 * refuses — an open house shown as ending at 1pm when it really ended at noon sends
 * someone to a locked door.
 */
export function parseTimeWindow(text: string): TimeWindow | null {
  const m = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|\bto\b|\buntil\b)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i,
  );
  if (!m) return null;

  const startMeridiem = normalizeMeridiem(m[3]);
  const endMeridiem = normalizeMeridiem(m[6]);

  const rawStart = Number(m[1]);
  const rawEnd = Number(m[4]);
  if (!isClockHour(rawStart) || !isClockHour(rawEnd)) return null;

  const startMinute = m[2] ? Number(m[2]) : 0;
  const endMinute = m[5] ? Number(m[5]) : 0;
  if (startMinute > 59 || endMinute > 59) return null;

  const startHour = toTwentyFour(rawStart, startMeridiem, endMeridiem);
  const endHour = toTwentyFour(rawEnd, endMeridiem, startMeridiem);

  return { startHour, startMinute, endHour, endMinute };
}

function isClockHour(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 12;
}

function normalizeMeridiem(raw: string | undefined): 'am' | 'pm' | null {
  if (!raw) return null;
  return raw.replace(/\./g, '').toLowerCase().startsWith('p') ? 'pm' : 'am';
}

/**
 * Twelve-hour clock to twenty-four.
 *
 * `own` is this end's own am/pm; `other` is the other end's, which carries it when only
 * one side is marked — "12-2pm" means noon to 2pm, not midnight to 2pm.
 *
 * With neither marked, an hour of 1 through 7 is the afternoon. "Open 1-4" is a Sunday
 * afternoon open house; nobody holds one from 1am to 4am, and reading it that way would
 * put an event on the calendar at a time it certainly is not.
 */
function toTwentyFour(hour: number, own: 'am' | 'pm' | null, other: 'am' | 'pm' | null): number {
  const meridiem = own ?? other;

  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  if (meridiem === 'am') return hour === 12 ? 0 : hour;

  return hour >= 1 && hour <= 7 ? hour + 12 : hour;
}

interface ResolvedDate {
  /** `YYYY-MM-DD`. */
  iso: string;
  source: 'explicit' | 'weekday';
}

/**
 * Works out which day an event falls on.
 *
 * An explicit calendar date wins over a weekday name, because a snippet naming both is
 * describing that specific date. A weekday alone resolves forward to its next occurrence.
 */
function resolveDate(segment: string, ctx: OpenHouseContext): ResolvedDate | null {
  const explicit = parseExplicitDate(segment, ctx);
  if (explicit) return explicit;

  const weekday = segment.match(new RegExp(`\\b(${Object.keys(WEEKDAYS).join('|')})\\b`, 'i'));
  if (!weekday) return null;

  const target = WEEKDAYS[weekday[1].toLowerCase()];
  const start = startOfDay(ctx.today);
  const delta = (target - start.getUTCDay() + 7) % 7;

  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + delta);
  return { iso: date.toISOString().slice(0, 10), source: 'weekday' };
}

/**
 * Reads `(8/22)`, `8/22/2026`, `Nov 6` and `November 6, 2026`.
 *
 * Returns null for a date more than a few days past. A search index keeps snippets for
 * years, so "Open Saturday, Nov 6" from a crawl two Novembers ago will otherwise resolve
 * to a cheerful upcoming event. That is the single worst bug this parser could have:
 * every other failure shows too little, this one shows something false.
 */
function parseExplicitDate(segment: string, ctx: OpenHouseContext): ResolvedDate | null {
  const today = startOfDay(ctx.today);
  const thisYear = today.getUTCFullYear();

  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;

  const numeric = segment.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    month = Number(numeric[1]) - 1;
    day = Number(numeric[2]);
    if (numeric[3]) {
      const y = Number(numeric[3]);
      year = y < 100 ? 2000 + y : y;
    }
  } else {
    const named = segment.match(
      new RegExp(`\\b(${Object.keys(MONTHS).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'i'),
    );
    if (named) {
      month = MONTHS[named[1].toLowerCase()];
      day = Number(named[2]);
      if (named[3]) year = Number(named[3]);
    }
  }

  if (month == null || day == null || month < 0 || month > 11 || day < 1 || day > 31) return null;

  // With no year stated, assume the current one and let the staleness check below decide.
  const candidate = new Date(Date.UTC(year ?? thisYear, month, day));
  if (candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) return null;

  const daysPast = Math.floor((today.getTime() - candidate.getTime()) / 86_400_000);

  if (daysPast > STALE_AFTER_DAYS) {
    // A yearless date that already passed might mean next year — but only if it is
    // plausibly near. A snippet saying "Nov 6" in August means this coming November;
    // one saying "Nov 6" in December is last month's crawl and stays rejected.
    if (year != null) return null;

    const nextYear = new Date(Date.UTC(thisYear + 1, month, day));
    const daysAhead = Math.floor((nextYear.getTime() - today.getTime()) / 86_400_000);
    // Open houses are announced days or weeks out, never a year. Anything that has to
    // roll into next year to be in the future is a stale snippet.
    if (daysAhead > 60) return null;
    return { iso: nextYear.toISOString().slice(0, 10), source: 'explicit' };
  }

  return { iso: candidate.toISOString().slice(0, 10), source: 'explicit' };
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
