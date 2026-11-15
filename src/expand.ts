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

// Pure expansion of one event file (main event plus exceptions) into its occurrences. It replaces
// asking khal which days an event shows up on. Rules are expanded on wall-clock values and each
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
const HOUR_MS = 3_600_000;

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
    wall: { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: n(6) },
    isDate: m[4] === undefined,
    utc: m[7] === "Z",
    tzid: m[7] === "Z" || m[4] === undefined ? undefined : tzid,
  });
};

const timeVals = (prop: ICAL.Property): V<readonly TimeVal[]> => {
  const jcal: unknown[] = prop.jCal;
  if (jcal[2] === "period") return fail(`${prop.name.toUpperCase()} with PERIOD values is not supported`);
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
}

const dayNumber = (w: Wall): number => Date.UTC(w.year, w.month - 1, w.day) / DAY_MS;

/** Day number of the date an instant has in a zone. */
const dayIn = (zone: Zone, ms: number): number => dayNumber(instantToWall(zone, ms));

const durationOf = (ctx: Ctx, c: ICAL.Component, start: TimeVal, zone: Zone, startMs: number): V<Dur> =>
  Result.gen(function* () {
    const durProp = c.getFirstProperty("duration");
    if (durProp !== null) {
      const d = yield* attempt(() => {
        const v = durProp.getFirstValue() as ICAL.Duration;
        return {
          seconds: v.toSeconds(),
          days: v.weeks * 7 + v.days,
          ms: ((v.hours * 60 + v.minutes) * 60 + v.seconds) * 1000,
        };
      }, "the DURATION is not valid");
      if (!Number.isFinite(d.seconds + d.days + d.ms)) return yield* fail("the DURATION is not valid");
      if (d.seconds < 0) return yield* fail("the DURATION of an event must not be negative");
      return start.isDate ? { days: Math.ceil(d.seconds / 86_400), ms: 0 } : { days: d.days, ms: d.ms };
    }
    const endVals = yield* allTimeVals(c, "dtend");
    const end = endVals[0];
    if (end === undefined) return start.isDate ? { days: 1, ms: 0 } : { days: 0, ms: HOUR_MS };
    if (start.isDate && end.isDate) {
      const days = dayNumber(end.wall) - dayNumber(start.wall);
      if (days < 0) return yield* fail("the event ends before it starts");
      return { days, ms: 0 };
    }
    const endMs = yield* toInstant(ctx, end, zone);
    if (endMs < startMs) return yield* fail("the event ends before it starts");
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
    return { allDay: start.isDate, zone, startMs, startWall: start.wall, dur };
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
    const it = yield* attempt(() => {
      const recur = prop.getFirstValue() as ICAL.Recur;
      recur.until = null;
      return recur.iterator(ICAL.Time.fromData({ ...ev.startWall, isDate: ev.allDay }));
    }, "the recurrence rule is not valid");
    const zone = ev.allDay ? ctx.host : ev.zone;
    const out: number[] = [];
    for (;;) {
      const next = yield* attempt(() => it.next(), "the recurrence rule cannot be expanded");
      if (next === null || next === undefined) break;
      if (++budget.walked > MAX_WALKED) return yield* fail("too many occurrences");
      const wall: Wall = {
        year: next.year,
        month: next.month,
        day: next.day,
        hour: ev.allDay ? 0 : next.hour,
        minute: ev.allDay ? 0 : next.minute,
        second: ev.allDay ? 0 : next.second,
      };
      // cheap skip before the window (offsets are far below 2 days); the exact check follows
      if (wallToUtcMs(wall) < lowMs - 2 * DAY_MS) continue;
      const ms = wallToInstant(zone, wall);
      if (pastUntil !== undefined && pastUntil(wall, ms)) break;
      if (ms >= toMs) break;
      if (ms < lowMs) continue;
      if (++budget.kept > MAX_OCCURRENCES) return yield* fail("too many occurrences");
      out.push(ms);
    }
    return out;
  });

interface Override {
  /** the instant of the instance it replaces (for a date-valued RECURRENCE-ID: the first match, once resolved) */
  readonly ridMs: number;
  /** set when RECURRENCE-ID is a date on a timed series: it names every instance of that date in the series' zone */
  readonly ridDay: number | undefined;
  readonly thisAndFuture: boolean;
  readonly ev: Ev;
}

const overrideOf = (ctx: Ctx, main: Ev, c: ICAL.Component): V<Override> =>
  Result.gen(function* () {
    const prop = c.getFirstProperty("recurrence-id");
    const rids = prop === null ? [] : yield* timeVals(prop);
    const rid = rids[0];
    if (prop === null || rid === undefined) return yield* fail("an exception has no RECURRENCE-ID");
    const range = String(prop.getParameter("range") ?? "").toUpperCase();
    if (range === "THISANDPRIOR") return yield* fail("RANGE=THISANDPRIOR is not supported");
    const ridDay = rid.isDate && !main.allDay ? dayNumber(rid.wall) : undefined;
    const ridMs =
      ridDay === undefined ? yield* toInstant(ctx, rid, main.zone) : wallToInstant(main.zone, rid.wall);
    const ev = yield* eventOf(ctx, c);
    return { ridMs, ridDay, thisAndFuture: range === "THISANDFUTURE", ev };
  });

/** An override with a date-valued RECURRENCE-ID takes the instant of the first instance of that date. */
const resolveRid = (main: Ev, base: readonly Item[], o: Override): Override => {
  if (o.ridDay === undefined) return o;
  const hit = base.find((i) => dayIn(main.zone, i.orig) === o.ridDay);
  return hit === undefined ? o : { ...o, ridMs: hit.orig };
};

/**
 * How far a THISANDFUTURE override moved its own instance: the difference of its new start and
 * the instance it replaces, both read on the wall clock of the override's zone (so a DST change
 * between the two dates does not enter), in ms. Dates and time of day both count.
 */
const futureShift = (o: Override): number =>
  wallToUtcMs(instantToWall(o.ev.zone, o.ev.startMs)) - wallToUtcMs(instantToWall(o.ev.zone, o.ridMs));

/** Moves a later instance by the shift of the THISANDFUTURE exception (on the wall clock of the series) and gives it its duration. */
const applyFuture = (main: Ev, o: Override, item: Item): Item => {
  if (main.allDay || item.orig <= o.ridMs) return { ...item, dur: o.ev.dur };
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
    const rdates = yield* allTimeVals(c, "rdate");
    const added = yield* sequence(rdates, (tv) => toInstant(ctx, tv, ev.zone));
    const exdates = yield* allTimeVals(c, "exdate");
    // a date-valued EXDATE on a timed series removes the instances of that date in the series' zone
    const excludedDays = new Set(
      exdates.filter((tv) => tv.isDate && !ev.allDay).map((tv) => dayNumber(tv.wall)),
    );
    const excluded = new Set(
      yield* sequence(
        exdates.filter((tv) => !(tv.isDate && !ev.allDay)),
        (tv) => toInstant(ctx, tv, ev.zone),
      ),
    );
    return [...new Set([...ruled, ...added])]
      .filter(
        (ms) =>
          ms < toMs &&
          !excluded.has(ms) &&
          (excludedDays.size === 0 || !excludedDays.has(dayIn(ev.zone, ms))),
      )
      .sort((a, b) => a - b)
      .map((ms) => ({ orig: ms, start: ms, dur: ev.dur }));
  });

/** Every instance of the event that starts before `toMs` and can reach into `[fromMs, toMs)`, sorted by start. */
const expandAll = (
  lines: readonly string[],
  hostZone: string,
  fromMs: number,
  toMs: number,
): V<readonly Instance[]> =>
  Result.gen(function* () {
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
    const base = yield* mainItems(ctx, main, ev, fromMs - slack, toMs);
    const overrides = raw.map((o) => resolveRid(ev, base, o));
    const shifted = overrides
      .filter((o) => o.thisAndFuture)
      .sort((a, b) => a.ridMs - b.ridMs)
      .reduce((items, o) => items.map((i) => (i.orig >= o.ridMs ? applyFuture(ev, o, i) : i)), base);
    const replacedInstants = new Set(overrides.filter((o) => o.ridDay === undefined).map((o) => o.ridMs));
    const replacedDays = new Set(overrides.flatMap((o) => (o.ridDay === undefined ? [] : [o.ridDay])));
    const kept = shifted.filter(
      (i) =>
        !replacedInstants.has(i.orig) &&
        (replacedDays.size === 0 || !replacedDays.has(dayIn(ev.zone, i.orig))),
    );
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
