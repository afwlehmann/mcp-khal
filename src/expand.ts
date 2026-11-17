import { Result } from "effect";
import ICAL from "ical.js";
import { InvalidInput } from "./errors.js";
import {
  ianaZone,
  instantToWall,
  resolveZone,
  utcZone,
  type Wall,
  wallFromUtcMs,
  wallToInstant,
  wallToUtcMs,
  type Zone,
} from "./timezone.js";

// Pure expansion of one event file (main event plus exceptions) into its occurrences. Rules are expanded on wall-clock values and each
// result is converted to an instant with the zone of the event, so DST never shifts local times.

type V<A> = Result.Result<A, InvalidInput>;

const fail = (message: string): V<never> => Result.fail(new InvalidInput({ message }));

/**
 * Upper bound of the instances of one rule that are kept (those that can show up in the window
 * asked for), so a rule without end cannot fill the memory. Instances before the window are
 * skipped and do not count against it.
 */
export const MAX_OCCURRENCES = 10_000;

/**
 * Upper bound of the instances a rule is walked through, window or not: skipping ahead to the
 * window costs one step per instance, a rule like FREQ=SECONDLY from years ago is refused.
 */
export const MAX_WALKED = 300_000;

const DAY_MS = 86_400_000;

/** One occurrence: instants (epoch ms, `end` exclusive), whether it is an all-day event, and its start date. */
export interface Instance {
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
  /** `YYYY-MM-DD` of the start in the event's own zone (the host zone for floating and all-day events). */
  readonly isoStartDate: string;
  /** `YYYY-MM-DD` of the start in the host zone: the date the user sees in `list_events`. */
  readonly hostIsoDate: string;
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

const isoDate = (w: Wall): string => `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`;

const isIsoDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const sequence = <A, B>(xs: readonly A[], f: (a: A) => V<B>): V<readonly B[]> => {
  const out: B[] = [];
  for (const x of xs) {
    const r = f(x);
    if (Result.isFailure(r)) return fail(r.failure.message);
    out.push(r.success);
  }
  return Result.succeed(out);
};

const attempt = <A>(f: () => A, message: string): V<A> =>
  Result.try({ try: f, catch: () => new InvalidInput({ message }) });

// ---- strict reading of the text (RFC 5545 3.3, 3.8) ----
//
// ical.js is lenient (it reads "20240101T100000-0800" as a local time and drops a lowercase "z"),
// and its jCal output has already lost what was written. So the values the expansion depends on
// are checked on the raw text first; whatever is not standard is reported, never guessed. The
// tolerated deviations (BOM, LF and lone CR line ends, tab folds, lowercase property names) are
// the ones handled here and in the reader of the files.

interface RawProp {
  /** which component (in order of its BEGIN line) the property belongs to */
  readonly comp: number;
  /** the innermost component type, upper case */
  readonly owner: string;
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
}

const splitOutsideQuotes = (s: string, sep: string): readonly string[] => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
};

const colonOutsideQuotes = (line: string): number => {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) return i;
  }
  return -1;
};

const rawProps = (lines: readonly string[]): readonly RawProp[] => {
  const out: RawProp[] = [];
  const stack: { readonly id: number; readonly type: string }[] = [];
  let next = 0;
  const unfolded = lines
    .join("\n")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  for (const line of unfolded) {
    const colon = colonOutsideQuotes(line);
    if (colon < 0) continue;
    const [rawName = "", ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
    const name = rawName.toUpperCase();
    const value = line.slice(colon + 1);
    if (name === "BEGIN") {
      stack.push({ id: next++, type: value.trim().toUpperCase() });
    } else if (name === "END") {
      stack.pop();
    } else {
      const params = new Map(
        rawParams.map((p) => {
          const eq = p.indexOf("=");
          const v = eq < 0 ? "" : p.slice(eq + 1);
          return [(eq < 0 ? p : p.slice(0, eq)).toUpperCase(), v.replace(/^"(.*)"$/, "$1")] as const;
        }),
      );
      const top = stack[stack.length - 1];
      out.push({ comp: top?.id ?? -1, owner: top?.type ?? "", name, params, value });
    }
  }
  return out;
};

const DATE_TEXT = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_TEXT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
const DURATION_TEXT = /^[+-]?P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;

const daysInMonth = (year: number, month: number): number => {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
};

const isRealDate = (y: number, m: number, d: number): boolean =>
  m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);

/** RFC 5545 3.3.6: `dur-value` with at least one component (and no years or months). */
const isDurationText = (v: string): boolean => DURATION_TEXT.test(v) && !/[PT]$/.test(v);

const dateTimeProblem = (
  name: string,
  type: string,
  tzid: string | undefined,
  item: string,
): string | undefined => {
  if (type === "DATE") {
    const m = DATE_TEXT.exec(item);
    if (m === null || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
      return `${name} "${item}" is not a valid DATE (YYYYMMDD)`;
    }
    return tzid === undefined ? undefined : `${name} is a DATE and must not have a TZID`;
  }
  const m = DATE_TIME_TEXT.exec(item);
  if (m === null) {
    return DATE_TEXT.test(item)
      ? `${name} "${item}" is a DATE: it needs VALUE=DATE`
      : `${name} "${item}" is not a valid DATE-TIME (YYYYMMDDTHHMMSS, with Z for UTC)`;
  }
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
  // a leap second is only read as the last second of a UTC day (and then as 59)
  const leap = second === 60 && m[7] === "Z" && hour === 23 && minute === 59;
  if (
    !isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) ||
    hour > 23 ||
    minute > 59 ||
    (second > 59 && !leap)
  ) {
    return `${name} "${item}" is not a valid DATE-TIME`;
  }
  return m[7] === "Z" && tzid !== undefined ? `${name} is in UTC (Z) and must not have a TZID` : undefined;
};

const periodProblem = (name: string, tzid: string | undefined, item: string): string | undefined => {
  const [a, b, ...rest] = item.split("/");
  if (a === undefined || b === undefined || rest.length > 0) return `${name} "${item}" is not a valid PERIOD`;
  const first = dateTimeProblem(name, "DATE-TIME", tzid, a);
  if (first !== undefined) return first;
  if (/^[+-]?P/.test(b)) {
    return isDurationText(b) && !b.startsWith("-") && /[1-9]/.test(b)
      ? undefined
      : `the duration of the PERIOD "${item}" must be positive`;
  }
  const second = dateTimeProblem(name, "DATE-TIME", tzid, b);
  if (second !== undefined) return second;
  const ms = (s: string): number => {
    const w = DATE_TIME_TEXT.exec(s) ?? [];
    return Date.UTC(Number(w[1]), Number(w[2]) - 1, Number(w[3]), Number(w[4]), Number(w[5]), Number(w[6]));
  };
  return ms(a) < ms(b) ? undefined : `the PERIOD "${item}" must start before it ends`;
};

const timeProblem = (p: RawProp): string | undefined => {
  const multi = p.name === "RDATE" || p.name === "EXDATE";
  const type = (p.params.get("VALUE") ?? "DATE-TIME").toUpperCase();
  if (p.name === "EXDATE" && type === "PERIOD") return "EXDATE with PERIOD values is not supported";
  const allowed = p.name === "RDATE" ? ["DATE", "DATE-TIME", "PERIOD"] : ["DATE", "DATE-TIME"];
  if (!allowed.includes(type)) return `${p.name} cannot have VALUE=${type}`;
  const tzid = p.params.get("TZID");
  return (multi ? p.value.split(",") : [p.value])
    .map((item) =>
      type === "PERIOD" ? periodProblem(p.name, tzid, item) : dateTimeProblem(p.name, type, tzid, item),
    )
    .find((m) => m !== undefined);
};

type Anchor = "date" | "floating" | "utc" | "tzid";

const anchorOf = (p: RawProp): Anchor =>
  DATE_TEXT.test(p.value)
    ? "date"
    : p.value.endsWith("Z")
      ? "utc"
      : p.params.has("TZID")
        ? "tzid"
        : "floating";

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const FREQS = ["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const BY_RANGES: Readonly<Record<string, readonly [number, number, boolean]>> = {
  BYSECOND: [0, 60, false],
  BYMINUTE: [0, 59, false],
  BYHOUR: [0, 23, false],
  BYMONTH: [1, 12, false],
  BYMONTHDAY: [1, 31, true],
  BYYEARDAY: [1, 366, true],
  BYWEEKNO: [1, 53, true],
  BYSETPOS: [1, 366, true],
};

/** RFC 5545 3.3.10: UNTIL has the type of DTSTART (a UTC date-time for UTC, TZID and observances). */
const untilProblem = (until: string, anchor: Anchor | "observance" | undefined): string | undefined => {
  const isDate = DATE_TEXT.test(until);
  const bad = dateTimeProblem("UNTIL", isDate ? "DATE" : "DATE-TIME", undefined, until);
  if (bad !== undefined) return bad;
  const utc = until.endsWith("Z");
  switch (anchor) {
    case undefined:
      return undefined;
    case "date":
      return isDate ? undefined : "UNTIL must be a DATE when DTSTART is a DATE";
    case "floating":
      return !isDate && !utc ? undefined : "UNTIL must be a floating date-time when DTSTART is floating";
    default:
      return !isDate && utc
        ? undefined
        : "UNTIL must be a UTC date-time (ending in Z) when DTSTART is UTC, has a TZID or is an observance";
  }
};

const byValueProblem = (key: string, value: string): string | undefined => {
  const range = BY_RANGES[key];
  if (range === undefined) return undefined;
  const [lo, hi, signed] = range;
  const ok = value
    .split(",")
    .every(
      (s) =>
        (signed ? /^[+-]?\d+$/ : /^\d+$/).test(s) && Math.abs(Number(s)) >= lo && Math.abs(Number(s)) <= hi,
    );
  return ok ? undefined : `${key}=${value} is out of range`;
};

/** A BYDAY item: a weekday, with a number (1 to 53, signed) for MONTHLY and YEARLY only. */
const bydayProblem = (value: string, freq: string, weekno: boolean): string | undefined => {
  const items = value.split(",").map((s) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s));
  if (items.some((m) => m === null)) return `BYDAY=${value} is not a list of weekdays`;
  const numbers = items.flatMap((m) => {
    const n = m?.[1];
    return n === undefined ? [] : [Math.abs(Number(n))];
  });
  if (numbers.some((n) => n < 1 || n > 53)) return `BYDAY=${value} has a number out of range`;
  if (numbers.length > 0 && freq !== "MONTHLY" && freq !== "YEARLY") {
    return "a number in BYDAY is only valid for FREQ=MONTHLY or YEARLY";
  }
  return numbers.length > 0 && weekno ? "a number in BYDAY is not valid together with BYWEEKNO" : undefined;
};

const rruleProblem = (value: string, anchor: Anchor | "observance" | undefined): string | undefined => {
  const parts = value.split(";").map((p) => {
    const eq = p.indexOf("=");
    return [
      (eq < 0 ? p : p.slice(0, eq)).toUpperCase(),
      eq < 0 ? "" : p.slice(eq + 1).toUpperCase(),
    ] as const;
  });
  const keys = parts.map(([k]) => k);
  if (new Set(keys).size !== keys.length) return "a part of the RRULE occurs more than once";
  const known = ["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYDAY", "WKST", ...Object.keys(BY_RANGES)];
  const unknown = keys.find((k) => !known.includes(k));
  if (unknown !== undefined) return `unknown RRULE part "${unknown}"`;
  const part = new Map(parts);
  const freq = part.get("FREQ");
  if (freq === undefined) return "an RRULE needs FREQ";
  if (!FREQS.includes(freq)) return `FREQ=${freq} is not valid`;
  if (part.has("COUNT") && part.has("UNTIL")) return "an RRULE has COUNT or UNTIL, never both";
  const count = part.get("COUNT");
  if (count !== undefined && !(/^\d+$/.test(count) && Number(count) > 0))
    return `COUNT=${count} is not a positive integer`;
  const interval = part.get("INTERVAL");
  if (interval !== undefined && !(/^\d+$/.test(interval) && Number(interval) > 0)) {
    return `INTERVAL=${interval} is not a positive integer`;
  }
  const wkst = part.get("WKST");
  if (wkst !== undefined && !WEEKDAYS.includes(wkst)) return `WKST=${wkst} is not a weekday`;
  const until = part.get("UNTIL");
  const untilBad = until === undefined ? undefined : untilProblem(until, anchor);
  if (untilBad !== undefined) return untilBad;
  const byBad = parts.map(([k, v]) => byValueProblem(k, v)).find((m) => m !== undefined);
  if (byBad !== undefined) return byBad;
  const byday = part.get("BYDAY");
  const bydayBad = byday === undefined ? undefined : bydayProblem(byday, freq, part.has("BYWEEKNO"));
  if (bydayBad !== undefined) return bydayBad;
  // the table of RFC 5545 3.3.10: "N/A" cells must not be used
  if (part.has("BYWEEKNO") && freq !== "YEARLY") return "BYWEEKNO is only valid for FREQ=YEARLY";
  if (part.has("BYYEARDAY") && ["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) {
    return `BYYEARDAY is not valid for FREQ=${freq}`;
  }
  if (part.has("BYMONTHDAY") && freq === "WEEKLY") return "BYMONTHDAY is not valid for FREQ=WEEKLY";
  const others = keys.filter((k) => k.startsWith("BY") && k !== "BYSETPOS");
  return part.has("BYSETPOS") && others.length === 0 ? "BYSETPOS needs another BYxxx rule part" : undefined;
};

const ONCE = ["DTSTART", "DTEND", "DURATION", "RECURRENCE-ID"];

/** The first problem with the dates, durations and rules of the events and observances of the file. */
const rawProblem = (lines: readonly string[]): string | undefined => {
  const props = rawProps(lines);
  const relevant = props.filter((p) => ["VEVENT", "STANDARD", "DAYLIGHT"].includes(p.owner));
  const perProp = relevant
    .map((p) => {
      if (["DTSTART", "DTEND", "RECURRENCE-ID", "RDATE", "EXDATE"].includes(p.name)) return timeProblem(p);
      if (p.name === "DURATION" && p.owner === "VEVENT" && !isDurationText(p.value)) {
        return `DURATION "${p.value}" is not a valid duration (no years or months; weeks stand alone)`;
      }
      if (p.name === "RRULE") {
        const start = relevant.find((s) => s.comp === p.comp && s.name === "DTSTART");
        return rruleProblem(
          p.value,
          p.owner === "VEVENT" ? (start === undefined ? undefined : anchorOf(start)) : "observance",
        );
      }
      return undefined;
    })
    .find((m) => m !== undefined);
  if (perProp !== undefined) return perProp;
  const events = relevant.filter((p) => p.owner === "VEVENT");
  const comps = [...new Set(events.map((p) => p.comp))];
  return comps
    .map((c) => {
      const own = events.filter((p) => p.comp === c);
      const twice = ONCE.find((n) => own.filter((p) => p.name === n).length > 1);
      if (twice !== undefined) return `an event has more than one ${twice}`;
      if (own.some((p) => p.name === "DTEND") && own.some((p) => p.name === "DURATION")) {
        return "an event has both DTEND and DURATION";
      }
      return own.filter((p) => p.name === "RRULE").length > 1
        ? "an event has more than one RRULE (undefined by RFC 5545 3.8.5.3)"
        : undefined;
    })
    .find((m) => m !== undefined);
};

// ---- values read from the file ----

/** A date or date-time value as written: wall clock plus how it is anchored. */
interface TimeVal {
  readonly wall: Wall;
  readonly isDate: boolean;
  readonly utc: boolean;
  readonly tzid: string | undefined;
}

const VALUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z)?)?$/;

const parseTimeVal = (raw: string, tzid: string | undefined): V<TimeVal> => {
  const m = VALUE.exec(raw);
  if (m === null) return fail(`"${raw}" is not a valid date or date-time`);
  const n = (i: number): number => Number(m[i] ?? 0);
  return Result.succeed({
    // a leap second (23:59:60Z) is read as the last second of the minute (RFC 5545 3.3.5)
    wall: { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: Math.min(n(6), 59) },
    isDate: m[4] === undefined,
    utc: m[7] === "Z",
    tzid: m[7] === "Z" || m[4] === undefined ? undefined : tzid,
  });
};

const timeVals = (prop: ICAL.Property): V<readonly TimeVal[]> => {
  const jcal: unknown[] = prop.jCal;
  const tzid = prop.getParameter("tzid");
  return sequence(jcal.slice(3), (raw) =>
    parseTimeVal(String(raw), typeof tzid === "string" ? tzid : undefined),
  );
};

const allTimeVals = (c: ICAL.Component, name: string): V<readonly TimeVal[]> =>
  Result.map(sequence(c.getAllProperties(name), timeVals), (lists) => lists.flat());

// ---- context: host zone and zone lookup ----

interface Ctx {
  readonly host: Zone;
  readonly zoneFor: (tzid: string) => V<Zone>;
}

const makeCtx = (hostZone: string, vtimezones: readonly ICAL.Component[]): V<Ctx> =>
  Result.map(ianaZone(hostZone), (host) => {
    const cache = new Map<string, V<Zone>>();
    const zoneFor = (tzid: string): V<Zone> => {
      const hit = cache.get(tzid);
      if (hit !== undefined) return hit;
      const r = resolveZone(tzid, vtimezones);
      cache.set(tzid, r);
      return r;
    };
    return { host, zoneFor };
  });

const toInstant = (ctx: Ctx, tv: TimeVal, fallback: Zone): V<number> => {
  if (tv.isDate) return Result.succeed(wallToInstant(ctx.host, tv.wall));
  if (tv.utc) return Result.succeed(wallToUtcMs(tv.wall));
  if (tv.tzid !== undefined) {
    return Result.map(ctx.zoneFor(tv.tzid), (zone) => wallToInstant(zone, tv.wall));
  }
  return Result.succeed(wallToInstant(fallback, tv.wall));
};

// ---- one VEVENT ----

/**
 * Length of an occurrence. `days` are nominal: calendar days of the wall clock, so 1 day is 23 or
 * 25 hours across a DST change of a timed event (RFC 5545 3.3.6). `ms` is exact elapsed time
 * (hours, minutes, seconds, or the difference of two instants). An all-day event uses `days` only.
 */
interface Dur {
  readonly days: number;
  readonly ms: number;
}

interface Ev {
  readonly allDay: boolean;
  /** Zone the wall-clock values of the event live in (the host zone for floating and all-day). */
  readonly zone: Zone;
  readonly startMs: number;
  readonly startWall: Wall;
  readonly dur: Dur;
  /** a date-time without Z and without TZID (always false for an all-day event) */
  readonly floating: boolean;
}

const dayNumber = (w: Wall): number => Date.UTC(w.year, w.month - 1, w.day) / DAY_MS;

const isFloating = (tv: TimeVal): boolean => !tv.isDate && !tv.utc && tv.tzid === undefined;

/** A DURATION value as nominal days plus exact milliseconds (RFC 5545 3.3.6); negative ones are an error. */
const durOfValue = (raw: string): V<Dur> =>
  Result.gen(function* () {
    const d = yield* attempt(() => {
      const v = ICAL.Duration.fromString(raw);
      return {
        seconds: v.toSeconds(),
        days: v.weeks * 7 + v.days,
        ms: ((v.hours * 60 + v.minutes) * 60 + v.seconds) * 1000,
      };
    }, "the DURATION is not valid");
    if (!Number.isFinite(d.seconds + d.days + d.ms)) return yield* fail("the DURATION is not valid");
    if (d.seconds < 0) return yield* fail("the DURATION of an event must not be negative");
    return { days: d.days, ms: d.ms };
  });

/**
 * Length from DURATION or DTEND (RFC 5545 3.6.1, 3.8.2.2, 3.8.2.5). Without both a timed event has
 * no length and an all-day event lasts one day. DTEND has the type of DTSTART and lies after it.
 * Tolerated deviation: an all-day DTEND equal to DTSTART is read as one day (some writers emit it).
 */
const durationOf = (ctx: Ctx, c: ICAL.Component, start: TimeVal, zone: Zone, startMs: number): V<Dur> =>
  Result.gen(function* () {
    const durProp = c.getFirstProperty("duration");
    if (durProp !== null) {
      const d = yield* durOfValue(String(durProp.jCal[3]));
      if (start.isDate && d.ms !== 0) {
        return yield* fail("the DURATION of an all-day event must be in days or weeks");
      }
      return d;
    }
    const endVals = yield* allTimeVals(c, "dtend");
    const end = endVals[0];
    if (end === undefined) return start.isDate ? { days: 1, ms: 0 } : { days: 0, ms: 0 };
    if (end.isDate !== start.isDate) {
      return yield* fail("DTEND must have the same type as DTSTART (both DATE or both DATE-TIME)");
    }
    if (start.isDate) {
      const days = dayNumber(end.wall) - dayNumber(start.wall);
      if (days < 0) return yield* fail("the event ends before it starts");
      return { days: Math.max(days, 1), ms: 0 };
    }
    if (isFloating(end) !== isFloating(start)) {
      return yield* fail("DTEND is floating exactly when DTSTART is floating");
    }
    const endMs = yield* toInstant(ctx, end, zone);
    if (endMs < startMs) return yield* fail("the event ends before it starts");
    if (endMs === startMs) return yield* fail("DTEND must be later than DTSTART");
    return { days: 0, ms: endMs - startMs };
  });

const eventOf = (ctx: Ctx, c: ICAL.Component): V<Ev> =>
  Result.gen(function* () {
    const starts = yield* allTimeVals(c, "dtstart");
    const start = starts[0];
    if (start === undefined) return yield* fail("an event has no DTSTART");
    const zone = start.isDate
      ? ctx.host
      : start.utc
        ? utcZone
        : start.tzid !== undefined
          ? yield* ctx.zoneFor(start.tzid)
          : ctx.host;
    const startMs = yield* toInstant(ctx, start, zone);
    const dur = yield* durationOf(ctx, c, start, zone, startMs);
    return { allDay: start.isDate, zone, startMs, startWall: start.wall, dur, floating: isFloating(start) };
  });

/** End instant (exclusive) of an occurrence starting at `startMs` (`wall` is its start in the event's zone). */
const endOf = (ctx: Ctx, ev: Pick<Ev, "allDay" | "zone">, startMs: number, wall: Wall, dur: Dur): number => {
  if (ev.allDay) {
    return wallToInstant(ctx.host, {
      ...wallFromUtcMs(Date.UTC(wall.year, wall.month - 1, wall.day + dur.days)),
      hour: 0,
      minute: 0,
      second: 0,
    });
  }
  if (dur.days === 0) return startMs + dur.ms;
  const moved = wallFromUtcMs(wallToUtcMs(wall) + dur.days * DAY_MS);
  return wallToInstant(ev.zone, moved) + dur.ms;
};

const build = (ctx: Ctx, ev: Pick<Ev, "allDay" | "zone">, startMs: number, dur: Dur): Instance => {
  const wall = instantToWall(ev.allDay ? ctx.host : ev.zone, startMs);
  return {
    start: startMs,
    end: endOf(ctx, ev, startMs, wall, dur),
    allDay: ev.allDay,
    isoStartDate: isoDate(wall),
    hostIsoDate: isoDate(instantToWall(ctx.host, startMs)),
  };
};

/** Generous upper bound of the length of an occurrence (nominal days may add an hour or two). */
const spanOf = (d: Dur): number => d.days * DAY_MS + d.ms + DAY_MS;

// ---- recurrence ----

/** A master instance: `orig` is the instant the rule produced, `start` where a THISANDFUTURE override put it. */
interface Item {
  readonly orig: number;
  readonly start: number;
  readonly dur: Dur;
}

/** Does an instance (its wall clock and its instant) lie after the UNTIL of the rule? */
type PastUntil = (wall: Wall, ms: number) => boolean;

/**
 * UNTIL (inclusive). A date means the whole day; a UTC value is an instant, compared as such (so
 * it is converted to the zone of the event whatever the DST); a floating value is wall clock.
 */
const untilOf = (ev: Ev, raw: unknown): V<PastUntil | undefined> => {
  if (typeof raw !== "string") return Result.succeed(undefined);
  return Result.map(parseTimeVal(raw, undefined), (tv): PastUntil => {
    if (tv.isDate || ev.allDay) {
      const end = wallToUtcMs({ ...tv.wall, hour: 23, minute: 59, second: 59 });
      return (wall) => wallToUtcMs(wall) > end;
    }
    const end = wallToUtcMs(tv.wall);
    return tv.utc ? (_wall, ms) => ms > end : (wall) => wallToUtcMs(wall) > end;
  });
};

/** One step of a rule walk: the wall clock, and the exact instant when the rule steps in exact time. */
interface Step {
  readonly wall: Wall;
  readonly ms: number | undefined;
}

/**
 * Walls of a MONTHLY or YEARLY rule without BYxxx parts: DTSTART's day every INTERVAL months or
 * years; dates that do not exist are skipped (RFC 5545 3.3.10).
 */
const calendarWalls = (freq: string, start: Wall, interval: number, allDay: boolean): (() => Wall | null) => {
  const time = allDay ? { hour: 0, minute: 0, second: 0 } : start;
  let n = 0;
  return () => {
    for (;;) {
      const months = start.year * 12 + (start.month - 1) + n++ * interval * (freq === "YEARLY" ? 12 : 1);
      const year = Math.floor(months / 12);
      const month = (months % 12) + 1;
      if (year > 9999) return null;
      if (isRealDate(year, month, start.day)) {
        return { year, month, day: start.day, hour: time.hour, minute: time.minute, second: time.second };
      }
    }
  };
};

/** What a rule walk has used so far (shared by all rules of one event). */
interface Budget {
  walked: number;
  kept: number;
}

/**
 * Instants of the rule before `toMs`. Instances before `lowMs` are skipped: they are walked (the
 * rule starts at DTSTART) but not kept and not counted against `MAX_OCCURRENCES`.
 */
const walkRule = (
  ctx: Ctx,
  ev: Ev,
  prop: ICAL.Property,
  lowMs: number,
  toMs: number,
  budget: Budget,
): V<readonly number[]> =>
  Result.gen(function* () {
    const jcal: unknown[] = prop.jCal;
    const value = jcal[3];
    const pastUntil = yield* untilOf(
      ev,
      typeof value === "object" && value !== null ? (value as { until?: unknown }).until : undefined,
    );
    const recur = yield* attempt(
      () => prop.getFirstValue() as ICAL.Recur,
      "the recurrence rule is not valid",
    );
    // COUNT is applied here (it includes DTSTART, which ical.js leaves out when the rule does not hit it)
    const count = typeof recur.count === "number" && recur.count > 0 ? recur.count : undefined;
    const parts = recur.parts as Record<string, number[] | string[] | undefined>;
    const weekNos = parts.BYWEEKNO as number[] | undefined;
    // BYYEARDAY limits a sub-daily rule (RFC 5545 3.3.10 table); ical.js only knows it for YEARLY
    const subDaily = ["HOURLY", "MINUTELY", "SECONDLY"].includes(String(recur.freq));
    const yearDays = subDaily ? (parts.BYYEARDAY as number[] | undefined) : undefined;
    if (yearDays !== undefined) delete parts.BYYEARDAY;
    if (weekNos !== undefined && (parts.BYYEARDAY || parts.BYMONTHDAY || parts.BYSETPOS)) {
      return yield* fail("BYWEEKNO together with BYYEARDAY, BYMONTHDAY or BYSETPOS is not supported");
    }
    const interval = typeof recur.interval === "number" && recur.interval > 0 ? recur.interval : 1;
    const freq = String(recur.freq);
    const noBy = Object.keys(parts).length === 0;
    const source = yield* attempt((): (() => Step | null) => {
      if (weekNos !== undefined) {
        const next = weekNoWalls(recur, ev.startWall, weekNos);
        return () => {
          const wall = next();
          return wall === null ? null : { wall, ms: undefined };
        };
      }
      // RFC 5545 3.3.10: rules finer than DAILY step in exact time (a gap hour is skipped, a
      // repeated hour occurs twice). Only without BYxxx parts; with them the walk stays on the wall
      // clock (limitation: BYxxx expansion and filters of a sub-daily rule across a DST change).
      if (subDaily && !ev.allDay && noBy) {
        const unit = freq === "HOURLY" ? 3_600_000 : freq === "MINUTELY" ? 60_000 : 1000;
        let n = 0;
        return () => {
          const ms = ev.startMs + n++ * interval * unit;
          return { wall: instantToWall(ev.zone, ms), ms };
        };
      }
      // RFC 5545 3.3.10: an invalid date (29 February of a common year, the 31st of a short month)
      // is skipped, not rolled over (ical.js rolls over and then drifts)
      if ((freq === "YEARLY" || freq === "MONTHLY") && noBy && ev.startWall.day > 28) {
        const next = calendarWalls(freq, ev.startWall, interval, ev.allDay);
        return () => {
          const wall = next();
          return wall === null ? null : { wall, ms: undefined };
        };
      }
      recur.until = null;
      recur.count = null;
      if (ev.allDay) {
        // RFC 5545 3.3.10: BYHOUR, BYMINUTE and BYSECOND have no meaning for a DATE: ignored
        for (const key of ["BYHOUR", "BYMINUTE", "BYSECOND"]) delete parts[key];
      }
      const it = recur.iterator(ICAL.Time.fromData({ ...ev.startWall, isDate: ev.allDay }));
      return () => {
        const next = it.next();
        if (next === null || next === undefined) return null;
        return {
          wall: {
            year: next.year,
            month: next.month,
            day: next.day,
            hour: ev.allDay ? 0 : next.hour,
            minute: ev.allDay ? 0 : next.minute,
            second: ev.allDay ? 0 : next.second,
          },
          ms: undefined,
        };
      };
    }, "the recurrence rule is not valid");
    const zone = ev.allDay ? ctx.host : ev.zone;
    const startsAt = wallToUtcMs(ev.startWall);
    const out: number[] = [];
    let produced = 0;
    let first = true;
    for (;;) {
      const step = yield* attempt(source, "the recurrence rule cannot be expanded");
      const wall = step === null ? null : step.wall;
      if (wall !== null) {
        if (++budget.walked > MAX_WALKED) return yield* fail("too many occurrences");
        if (yearDays !== undefined && !matchesYearDay(wall, yearDays)) continue;
      }
      if (first) {
        first = false;
        // DTSTART is the first instance even when the rule does not produce it (RFC 5545 3.3.10)
        if (
          wall === null ||
          (step?.ms === undefined ? wallToUtcMs(wall) !== startsAt : step.ms !== ev.startMs)
        ) {
          produced++;
          if (ev.startMs >= lowMs && ev.startMs < toMs) {
            if (++budget.kept > MAX_OCCURRENCES) return yield* fail("too many occurrences");
            out.push(ev.startMs);
          }
        }
      }
      if (wall === null || (count !== undefined && produced >= count)) break;
      produced++;
      // cheap skip before the window (offsets are far below 2 days); the exact check follows
      if (wallToUtcMs(wall) < lowMs - 2 * DAY_MS) continue;
      const ms = step?.ms ?? wallToInstant(zone, wall);
      if (pastUntil !== undefined && pastUntil(wall, ms)) break;
      if (ms >= toMs) break;
      if (ms < lowMs) continue;
      if (++budget.kept > MAX_OCCURRENCES) return yield* fail("too many occurrences");
      out.push(ms);
    }
    return out;
  });

const WEEKDAY_INDEX: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Weekday (0 = Sunday) of a day number (days since 1970-01-01, a Thursday). */
const weekdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7;

const yearDayOf = (w: Wall): number =>
  (Date.UTC(w.year, w.month - 1, w.day) - Date.UTC(w.year, 0, 1)) / DAY_MS + 1;

const matchesYearDay = (w: Wall, days: readonly number[]): boolean => {
  const inYear = daysInYear(w.year);
  return days.some((d) => (d > 0 ? d : inYear + d + 1) === yearDayOf(w));
};

const daysInYear = (year: number): number => (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;

/**
 * Walls of a YEARLY rule with BYWEEKNO (ical.js ignores it). Week 1 is the first week, starting on
 * WKST (default Monday), with at least four days in the year; a negative number counts from the
 * last week. The days are those of BYDAY (the weekday of DTSTART when absent), limited by BYMONTH,
 * at the times of BYHOUR/BYMINUTE/BYSECOND (those of DTSTART when absent). Dates before DTSTART
 * are not instances.
 */
const weekNoWalls = (recur: ICAL.Recur, start: Wall, weekNos: readonly number[]): (() => Wall | null) => {
  const parts = recur.parts as Record<string, (number | string)[] | undefined>;
  const wkst = typeof recur.wkst === "number" ? recur.wkst - 1 : 1;
  const interval = recur.interval > 0 ? recur.interval : 1;
  const startDay = dayNumber(start);
  const weekdays = new Set(
    (parts.BYDAY ?? [])
      .map((d) => WEEKDAY_INDEX[String(d).slice(-2)] ?? 0)
      .concat(parts.BYDAY === undefined ? [weekdayOf(startDay)] : []),
  );
  const months = new Set((parts.BYMONTH ?? []).map(Number));
  const list = (key: string, own: number): number[] =>
    [...new Set((parts[key] ?? [own]).map(Number))].sort((a, b) => a - b);
  const times = list("BYHOUR", start.hour).flatMap((hour) =>
    list("BYMINUTE", start.minute).flatMap((minute) =>
      list("BYSECOND", start.second).map((second) => ({ hour, minute, second })),
    ),
  );
  const firstWeekStart = (year: number): number => {
    const jan4 = Date.UTC(year, 0, 4) / DAY_MS;
    return jan4 - ((weekdayOf(jan4) - wkst + 7) % 7);
  };
  const startMs = wallToUtcMs(start);
  const yearWalls = (year: number): Wall[] => {
    const base = firstWeekStart(year);
    const weeks = (firstWeekStart(year + 1) - base) / 7;
    const days = weekNos
      .map((n) => (n > 0 ? n : weeks + n + 1))
      .filter((k) => k >= 1 && k <= weeks)
      .flatMap((k) => [0, 1, 2, 3, 4, 5, 6].map((d) => base + (k - 1) * 7 + d))
      .filter(
        (d) =>
          weekdays.has(weekdayOf(d)) && (months.size === 0 || months.has(wallFromUtcMs(d * DAY_MS).month)),
      );
    return [...new Set(days)]
      .flatMap((d) => times.map((t) => ({ ...wallFromUtcMs(d * DAY_MS), ...t })))
      .filter((w) => wallToUtcMs(w) >= startMs)
      .sort((a, b) => wallToUtcMs(a) - wallToUtcMs(b));
  };
  let year = start.year;
  let emptyYears = 0;
  let queue: Wall[] = [];
  return () => {
    while (queue.length === 0) {
      // a rule that never matches (say week 53 of years without one) ends instead of looping
      if (year > 9999 || emptyYears > 100) return null;
      queue = yearWalls(year);
      emptyYears = queue.length === 0 ? emptyYears + 1 : 0;
      year += interval;
    }
    return queue.shift() ?? null;
  };
};

interface Override {
  /** the instant of the instance it replaces */
  readonly ridMs: number;
  readonly thisAndFuture: boolean;
  readonly ev: Ev;
}

/**
 * An exception (RFC 5545 3.8.4.4). Its RECURRENCE-ID has the type of the DTSTART of the series
 * (DATE or DATE-TIME) and is floating exactly when that is. RANGE=THISANDPRIOR is deprecated and
 * never written: reading it is reported as unsupported.
 */
const overrideOf = (ctx: Ctx, main: Ev, c: ICAL.Component): V<Override> =>
  Result.gen(function* () {
    const prop = c.getFirstProperty("recurrence-id");
    const rids = prop === null ? [] : yield* timeVals(prop);
    const rid = rids[0];
    if (prop === null || rid === undefined) return yield* fail("an exception has no RECURRENCE-ID");
    const range = String(prop.getParameter("range") ?? "").toUpperCase();
    if (range === "THISANDPRIOR") return yield* fail("RANGE=THISANDPRIOR is not supported");
    if (range !== "" && range !== "THISANDFUTURE") return yield* fail(`RANGE=${range} is not valid`);
    if (rid.isDate !== main.allDay) {
      return yield* fail(
        "RECURRENCE-ID must have the same type as the DTSTART of the series (DATE or DATE-TIME)",
      );
    }
    if (isFloating(rid) !== main.floating) {
      return yield* fail("RECURRENCE-ID is floating exactly when the DTSTART of the series is floating");
    }
    const ridMs = yield* toInstant(ctx, rid, main.zone);
    const ev = yield* eventOf(ctx, c);
    return { ridMs, thisAndFuture: range === "THISANDFUTURE", ev };
  });

/**
 * How far a THISANDFUTURE override moved its own instance: the difference of its new start and
 * the instance it replaces, both read on the wall clock of the override's zone (so a DST change
 * between the two dates does not enter), in ms. Dates and time of day both count.
 */
const futureShift = (o: Override): number =>
  wallToUtcMs(instantToWall(o.ev.zone, o.ev.startMs)) - wallToUtcMs(instantToWall(o.ev.zone, o.ridMs));

/** Moves a later instance by the shift of the THISANDFUTURE exception (on the wall clock of the series) and gives it its duration. */
const applyFuture = (main: Ev, o: Override, item: Item): Item => {
  if (item.orig <= o.ridMs) return { ...item, dur: o.ev.dur };
  const moved = wallFromUtcMs(wallToUtcMs(instantToWall(main.zone, item.orig)) + futureShift(o));
  return { orig: item.orig, start: wallToInstant(main.zone, moved), dur: o.ev.dur };
};

const mainItems = (ctx: Ctx, c: ICAL.Component, ev: Ev, lowMs: number, toMs: number): V<readonly Item[]> =>
  Result.gen(function* () {
    const rules = c.getAllProperties("rrule");
    const budget: Budget = { walked: 0, kept: 0 };
    const ruled =
      rules.length === 0
        ? [ev.startMs]
        : (yield* sequence(rules, (r) => walkRule(ctx, ev, r, lowMs, toMs, budget))).flat();
    const added = yield* rdatesOf(ctx, c, ev);
    const exdates = yield* allTimeVals(c, "exdate");
    // the values of RDATE and EXDATE have the type of DTSTART (a policy: a mismatch would match nothing)
    if (exdates.some((tv) => tv.isDate !== ev.allDay)) {
      return yield* fail("EXDATE must have the same type as DTSTART (both DATE or both DATE-TIME)");
    }
    const excluded = new Set(yield* sequence(exdates, (tv) => toInstant(ctx, tv, ev.zone)));
    // set = (DTSTART + RRULE + RDATE) minus EXDATE: an EXDATE beats an RDATE, equal instants count once
    const periods = new Map(added.flatMap((a) => (a.dur === undefined ? [] : [[a.ms, a.dur] as const])));
    return [...new Set([...ruled, ...added.map((a) => a.ms)])]
      .filter((ms) => ms < toMs && !excluded.has(ms))
      .sort((a, b) => a - b)
      .map((ms) => ({ orig: ms, start: ms, dur: periods.get(ms) ?? ev.dur }));
  });

/** RDATE values: instants, and for a PERIOD its own length (which replaces the one of the event). */
const rdatesOf = (
  ctx: Ctx,
  c: ICAL.Component,
  ev: Ev,
): V<readonly { readonly ms: number; readonly dur: Dur | undefined }[]> =>
  Result.gen(function* () {
    const out: { ms: number; dur: Dur | undefined }[] = [];
    for (const prop of c.getAllProperties("rdate")) {
      const jcal: unknown[] = prop.jCal;
      const tzid = prop.getParameter("tzid");
      const tz = typeof tzid === "string" ? tzid : undefined;
      for (const raw of jcal.slice(3)) {
        if (jcal[2] === "period") {
          const [from, to] = Array.isArray(raw) ? raw.map(String) : [];
          if (from === undefined || to === undefined) return yield* fail("an RDATE PERIOD is not valid");
          if (ev.allDay) return yield* fail("an RDATE PERIOD cannot be used in an all-day event");
          const start = yield* parseTimeVal(from, tz);
          const startMs = yield* toInstant(ctx, start, ev.zone);
          if (/^[+-]?P/.test(to)) {
            out.push({ ms: startMs, dur: yield* durOfValue(to) });
          } else {
            const end = yield* parseTimeVal(to, tz);
            out.push({ ms: startMs, dur: { days: 0, ms: (yield* toInstant(ctx, end, ev.zone)) - startMs } });
          }
        } else {
          const tv = yield* parseTimeVal(String(raw), tz);
          if (tv.isDate !== ev.allDay) {
            return yield* fail("RDATE must have the same type as DTSTART (both DATE or both DATE-TIME)");
          }
          out.push({ ms: yield* toInstant(ctx, tv, ev.zone), dur: undefined });
        }
      }
    }
    return out;
  });

/** Every instance of the event that starts before `toMs` and can reach into `[fromMs, toMs)`, sorted by start. */
const expandAll = (
  lines: readonly string[],
  hostZone: string,
  fromMs: number,
  toMs: number,
): V<readonly Instance[]> =>
  Result.gen(function* () {
    const problem = rawProblem(lines);
    if (problem !== undefined) return yield* fail(problem);
    const calendar = yield* attempt(
      () => new ICAL.Component(ICAL.parse(lines.join("\r\n"))),
      "the file is not valid iCalendar data",
    );
    const ctx = yield* makeCtx(hostZone, calendar.getAllSubcomponents("vtimezone"));
    const vevents = calendar.getAllSubcomponents("vevent");
    const main = vevents.find((v) => !v.hasProperty("recurrence-id"));
    if (main === undefined) return yield* fail("the file holds no main event");
    const ev = yield* eventOf(ctx, main);
    const raw = yield* sequence(
      vevents.filter((v) => v !== main),
      (v) => overrideOf(ctx, ev, v),
    );
    // instances starting this long before the window may still be moved or stretched into it
    const slack =
      Math.max(spanOf(ev.dur), ...raw.map((o) => spanOf(o.ev.dur))) +
      Math.max(0, ...raw.filter((o) => o.thisAndFuture).map((o) => Math.abs(futureShift(o)))) +
      2 * DAY_MS;
    // a THISANDFUTURE override that moves its instances earlier brings instances that start after
    // the window on the rule into it: the walk reaches as far further as the largest shift (plus a
    // day for DST); the final filter on the shifted start drops the others
    const reach =
      Math.max(0, ...raw.filter((o) => o.thisAndFuture).map((o) => Math.abs(futureShift(o)))) +
      (raw.some((o) => o.thisAndFuture) ? DAY_MS : 0);
    const base = yield* mainItems(ctx, main, ev, fromMs - slack, toMs + reach);
    const overrides = raw;
    const shifted = overrides
      .filter((o) => o.thisAndFuture)
      .sort((a, b) => a.ridMs - b.ridMs)
      .reduce((items, o) => items.map((i) => (i.orig >= o.ridMs ? applyFuture(ev, o, i) : i)), base);
    const replacedInstants = new Set(overrides.map((o) => o.ridMs));
    const kept = shifted.filter((i) => !replacedInstants.has(i.orig));
    const fromRule = kept.map((i) => build(ctx, ev, i.start, i.dur));
    const fromOverrides = overrides.map((o) => build(ctx, o.ev, o.ev.startMs, o.ev.dur));
    return [...fromRule, ...fromOverrides]
      .filter((i) => i.start < toMs)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  });

/**
 * Instances of the event overlapping the half-open window `[fromMs, toMs)` (epoch ms), sorted by
 * start. An event overlaps when it starts before `toMs` and ends after `fromMs`; one without
 * length counts when its start lies in the window. `hostZone` (an IANA name) places floating and
 * all-day events. Exceptions (RECURRENCE-ID) replace single instances, EXDATE removes them, RDATE
 * adds them. Instances of a rule before the window are skipped (see `MAX_OCCURRENCES`).
 */
export const occurrencesIn = (
  lines: readonly string[],
  fromMs: number,
  toMs: number,
  hostZone: string,
): V<readonly Instance[]> =>
  Result.gen(function* () {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs)
      return yield* fail("the time range must have its start before its end");
    const all = yield* expandAll(lines, hostZone, fromMs, toMs);
    return all.filter((i) => (i.end === i.start ? i.start >= fromMs : i.start < toMs && i.end > fromMs));
  });

const datesIn = (
  lines: readonly string[],
  from: string,
  to: string,
  hostZone: string,
  pick: (i: Instance) => string,
): V<readonly string[]> =>
  Result.gen(function* () {
    if (!isIsoDate(from) || !isIsoDate(to) || from >= to)
      return yield* fail("the date range must be real dates (YYYY-MM-DD) with the start before the end");
    // a start date in [from, to) in any zone lies within a day or two of the days `from` and `to`
    const fromMs = new Date(`${from}T00:00:00Z`).getTime() - 2 * DAY_MS;
    const toMs = new Date(`${to}T00:00:00Z`).getTime() + 2 * DAY_MS;
    const all = yield* expandAll(lines, hostZone, fromMs, toMs);
    return [...new Set(all.map(pick).filter((d) => d >= from && d < to))].sort();
  });

/**
 * ISO dates (in the zone of the event) of the occurrences whose start date lies in `[from, to)`,
 * in order. See `occurrencesIn` for the exceptions; a rule that yields more than `MAX_OCCURRENCES`
 * instances in or before `to` is an error.
 */
export const occurrenceDatesIn = (
  lines: readonly string[],
  from: string,
  to: string,
  hostZone: string,
): V<readonly string[]> => datesIn(lines, from, to, hostZone, (i) => i.isoStartDate);

/** Like `occurrenceDatesIn`, but the dates are those of the host zone, as `list_events` shows them. */
export const hostOccurrenceDatesIn = (
  lines: readonly string[],
  from: string,
  to: string,
  hostZone: string,
): V<readonly string[]> => datesIn(lines, from, to, hostZone, (i) => i.hostIsoDate);
