import { Result } from "effect";
import { InvalidInput } from "./errors.js";
import { ianaZone, type Wall, wallFromUtcMs, type Zone } from "./timezone.js";

// Pure generation of an RFC 5545 VTIMEZONE from IANA data. The offsets of the zone are sampled from
// 1970 to 2100, every change is located to the second, and consecutive years with the same rule
// ("last Sunday of March at 02:00, +01:00 -> +02:00") are merged into one era that becomes a
// STANDARD / DAYLIGHT component with a yearly RRULE. The last era is open ended, so dates after
// 2100 follow the current rule. A zone that never changes gets a fixed-offset STANDARD stub.
//
// A zone whose current rule is not a fixed "n-th weekday of a month" (Israel: Friday before the
// last Sunday of March, Chile, Paraguay, Morocco with its Ramadan changes) has a different weekday
// number in different years, so no yearly RRULE describes it. Its changes from the first year with
// the same kind of changes on (the "tail") are written as RDATE lists through 2100 instead of being
// dropped after the last year of a rule that does not repeat.

type V<A> = Result.Result<A, InvalidInput>;

export interface VTimezone {
  /** the TZID to write in `DTSTART;TZID=...` */
  readonly tzid: string;
  /** BEGIN:VTIMEZONE .. END:VTIMEZONE; empty for UTC, which is written with a `Z` suffix instead */
  readonly lines: readonly string[];
}

const SECOND = 1000;
const DAY_MS = 86_400_000;
const FIRST_YEAR = 1970;
const LAST_YEAR = 2100;
/** An era at least this long (a full cycle of weekdays and leap years) is a rule that repeats. */
const REGULAR_YEARS = 28;
/** Dates per RDATE line. */
const RDATES_PER_LINE = 4;
const SCAN_START = Date.UTC(FIRST_YEAR, 0, 1);
const SCAN_END = Date.UTC(LAST_YEAR + 1, 0, 1);
/** Sampling step: two changes closer than this that cancel each other are not seen. */
const STEP = 10 * DAY_MS;

const UTC_NAMES: ReadonlySet<string> = new Set([
  "utc",
  "etc/utc",
  "etc/uct",
  "uct",
  "etc/universal",
  "universal",
  "etc/zulu",
  "zulu",
  "etc/gmt",
  "etc/gmt0",
  "etc/gmt+0",
  "etc/gmt-0",
  "etc/greenwich",
  "gmt",
  "gmt0",
  "gmt+0",
  "gmt-0",
  "greenwich",
]);

/** Is this zone name plain UTC (no VTIMEZONE needed)? */
export const isUtcName = (name: string): boolean => UTC_NAMES.has(name.trim().toLowerCase());

const TZID = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

/** The zone name as ICS wants it: the canonical spelling when only the case differs, else as given. */
const tzidOf = (name: string): V<string> => {
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  const tzid = canonical.toLowerCase() === name.toLowerCase() ? canonical : name;
  return TZID.test(tzid)
    ? Result.succeed(tzid)
    : Result.fail(new InvalidInput({ message: `'${name}' is not a named IANA time zone` }));
};

/** A change of the UTC offset (seconds, east positive) at the instant `atMs`. */
interface Onset {
  readonly atMs: number;
  readonly from: number;
  readonly to: number;
}

const offsetSeconds = (zone: Zone, ms: number): number => Math.round(zone.offsetMinutes(ms) * 60);

/** All changes in `(lo, hi]` given the offsets at both ends; `lo` and `hi` are whole seconds. */
const between = (zone: Zone, lo: number, offLo: number, hi: number, offHi: number): readonly Onset[] => {
  if (offLo === offHi) return [];
  if (hi - lo <= SECOND) return [{ atMs: hi, from: offLo, to: offHi }];
  const mid = lo + Math.floor((hi - lo) / (2 * SECOND)) * SECOND;
  const offMid = offsetSeconds(zone, mid);
  return [...between(zone, lo, offLo, mid, offMid), ...between(zone, mid, offMid, hi, offHi)];
};

const onsetsOf = (zone: Zone): { readonly first: number; readonly onsets: readonly Onset[] } => {
  const count = Math.ceil((SCAN_END - SCAN_START) / STEP);
  const points = Array.from({ length: count + 1 }, (_, i) => {
    const ms = SCAN_START + i * STEP;
    return { ms, off: offsetSeconds(zone, ms) };
  });
  return {
    first: points[0]!.off,
    onsets: points.slice(1).flatMap((p, i) => between(zone, points[i]!.ms, points[i]!.off, p.ms, p.off)),
  };
};

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

const formatOffset = (seconds: number): string => {
  const a = Math.abs(seconds);
  const s = a % 60;
  return `${seconds < 0 ? "-" : "+"}${pad(Math.floor(a / 3600))}${pad(Math.floor((a % 3600) / 60))}${s === 0 ? "" : pad(s)}`;
};

const formatLocal = (w: Wall): string =>
  `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** One change described as a yearly rule: the n-th (or last) weekday of a month at a time of day. */
interface Rule {
  readonly onset: Onset;
  /** local time before the change, which is what DTSTART of the component holds */
  readonly wall: Wall;
  readonly byDay: string;
  /** equal keys mean the same rule */
  readonly key: string;
}

const ruleOf = (onset: Onset): Rule => {
  const wall = wallFromUtcMs(onset.atMs + onset.from * SECOND);
  const daysInMonth = new Date(Date.UTC(wall.year, wall.month, 0)).getUTCDate();
  const nth = wall.day + 7 > daysInMonth ? -1 : Math.ceil(wall.day / 7);
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  const byDay = `${nth}${BYDAY[weekday]}`;
  const time = wall.hour * 3600 + wall.minute * 60 + wall.second;
  return { onset, wall, byDay, key: [wall.month, byDay, time, onset.from, onset.to].join("|") };
};

interface YearRules {
  readonly year: number;
  readonly rules: readonly Rule[];
}

/** Consecutive years with the same rules. */
interface Era {
  readonly first: YearRules;
  readonly last: YearRules;
  readonly key: string;
}

const eraKey = (y: YearRules): string => y.rules.map((r) => r.key).join(";");

/** The rules of every year from `FIRST_YEAR` to `LAST_YEAR` (local year of the change). */
const yearsOf = (onsets: readonly Onset[]): readonly YearRules[] => {
  const rules = onsets.map(ruleOf);
  return Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => ({
    year: FIRST_YEAR + i,
    rules: rules.filter((r) => r.wall.year === FIRST_YEAR + i),
  }));
};

const erasOf = (years: readonly YearRules[]): readonly Era[] =>
  years.reduce<readonly Era[]>((eras, y) => {
    const prev = eras[eras.length - 1];
    return prev !== undefined && prev.key === eraKey(y)
      ? [...eras.slice(0, -1), { ...prev, last: y }]
      : [...eras, { first: y, last: y, key: eraKey(y) }];
  }, []);

/**
 * Does the zone end with changes that repeat no yearly rule? True when the last era has changes
 * but is shorter than a cycle of weekdays: the rule of the last years is not "n-th weekday".
 */
const hasIrregularTail = (eras: readonly Era[]): boolean => {
  const last = eras[eras.length - 1];
  return last !== undefined && last.first.rules.length > 0 && LAST_YEAR - last.first.year + 1 < REGULAR_YEARS;
};

/** What kind of changes a year has: the offsets before and after each, in order (not when). */
const shapeOf = (y: YearRules): string => y.rules.map((r) => `${r.onset.from}>${r.onset.to}`).join(";");

/** Index of the first year of the longest run of years at the end that have the shape of the last year. */
const tailStart = (years: readonly YearRules[]): number => {
  const last = years[years.length - 1];
  const shape = last === undefined ? "" : shapeOf(last);
  return years.map((y, i) => (shapeOf(y) === shape ? -1 : i)).reduce((a, b) => Math.max(a, b), -1) + 1;
};

/** The UNTIL of a bounded era: UTC, a day or two after the last change, long before the next. */
const untilOf = (rule: Rule): string => {
  const w = rule.wall;
  return `${formatLocal(wallFromUtcMs(Date.UTC(w.year, w.month - 1, w.day + 2)))}Z`;
};

const eraLines = (era: Era, open: boolean): readonly string[] => {
  const targets = era.first.rules.map((r) => r.onset.to);
  const top = Math.max(...targets);
  const low = Math.min(...targets);
  return era.first.rules.flatMap((rule, i) => {
    const lastRule = era.last.rules[i]!;
    const rrule =
      era.last.year === era.first.year
        ? []
        : [
            `RRULE:${[
              "FREQ=YEARLY",
              `BYMONTH=${rule.wall.month}`,
              `BYDAY=${rule.byDay}`,
              ...(open ? [] : [`UNTIL=${untilOf(lastRule)}`]),
            ].join(";")}`,
          ];
    const kind = top > low && rule.onset.to === top ? "DAYLIGHT" : "STANDARD";
    return [
      `BEGIN:${kind}`,
      `DTSTART:${formatLocal(rule.wall)}`,
      `TZOFFSETFROM:${formatOffset(rule.onset.from)}`,
      `TZOFFSETTO:${formatOffset(rule.onset.to)}`,
      ...rrule,
      `END:${kind}`,
    ];
  });
};

const chunks = <A>(xs: readonly A[], size: number): readonly (readonly A[])[] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, k) => xs.slice(k * size, (k + 1) * size));

/**
 * The years of an irregular tail: one component per kind of change, with the first change as
 * DTSTART and every later one in RDATE lines. They list every change through `LAST_YEAR`.
 */
const tailLines = (tail: readonly YearRules[]): readonly string[] => {
  const [first] = tail;
  if (first === undefined) return [];
  const targets = first.rules.map((r) => r.onset.to);
  const top = Math.max(...targets);
  const low = Math.min(...targets);
  return first.rules.flatMap((rule, i) => {
    const kind = top > low && rule.onset.to === top ? "DAYLIGHT" : "STANDARD";
    const later = tail.slice(1).flatMap((y) => {
      const r = y.rules[i];
      return r === undefined ? [] : [formatLocal(r.wall)];
    });
    return [
      `BEGIN:${kind}`,
      `DTSTART:${formatLocal(rule.wall)}`,
      `TZOFFSETFROM:${formatOffset(rule.onset.from)}`,
      `TZOFFSETTO:${formatOffset(rule.onset.to)}`,
      ...chunks(later, RDATES_PER_LINE).map((c) => `RDATE:${c.join(",")}`),
      `END:${kind}`,
    ];
  });
};

const eraBody = (eras: readonly Era[], lastIsOpen: boolean): readonly string[] =>
  eras.flatMap((era, i) =>
    era.first.rules.length === 0 ? [] : eraLines(era, lastIsOpen && i === eras.length - 1),
  );

const componentLines = (zone: Zone, tzid: string): readonly string[] => {
  const { first, onsets } = onsetsOf(zone);
  const years = yearsOf(onsets.filter((o) => wallFromUtcMs(o.atMs + o.from * SECOND).year <= LAST_YEAR));
  const eras = erasOf(years);
  const split = tailStart(years);
  const body =
    onsets.length === 0
      ? [
          "BEGIN:STANDARD",
          `DTSTART:${formatLocal(wallFromUtcMs(SCAN_START))}`,
          `TZOFFSETFROM:${formatOffset(first)}`,
          `TZOFFSETTO:${formatOffset(first)}`,
          "END:STANDARD",
        ]
      : hasIrregularTail(eras)
        ? [...eraBody(erasOf(years.slice(0, split)), false), ...tailLines(years.slice(split))]
        : eraBody(eras, true);
  return ["BEGIN:VTIMEZONE", `TZID:${tzid}`, ...body, "END:VTIMEZONE"];
};

/**
 * The VTIMEZONE of an IANA zone and the TZID to use for it. UTC (and its aliases) has no
 * VTIMEZONE: its times are written with a `Z` suffix. A name that is not an IANA zone is an error.
 */
export const vtimezone = (name: string): V<VTimezone> => {
  const n = name.trim();
  return Result.flatMap(
    ianaZone(n),
    (zone): V<VTimezone> =>
      isUtcName(n)
        ? Result.succeed({ tzid: "UTC", lines: [] })
        : Result.map(tzidOf(n), (tzid) => ({ tzid, lines: componentLines(zone, tzid) })),
  );
};
