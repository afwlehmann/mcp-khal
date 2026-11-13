import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { InvalidInput, type KhalError } from "./errors.js";
import { type Event, events, isMaster, mapEvents, prop, setProp, touch } from "./ics.js";
import { execute, listArgs, parseEvents } from "./khal.js";
import { titleWarning } from "./newEvent.js";
import { textField } from "./recurrence.js";
import {
  compactDate,
  dateMs,
  dayOf,
  formatWall,
  listedDates,
  parseWall,
  recurrenceId,
  ruleCount,
  untilBefore,
  withCount,
  withUntil,
} from "./series.js";
import type { Settings } from "./settings.js";
import { findEvent, writeEvent } from "./vdir.js";

type V<A> = Result.Result<A, InvalidInput>;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });
const fail = (message: string): V<never> => Result.fail(invalid(message));

/** Which events of a recurring event a change applies to. */
export type Scope = "all" | "instance" | "from_date";

export interface UpdateParams {
  readonly calendar: string;
  readonly uid: string;
  /** default `all`; `instance` and `from_date` need `date` */
  readonly scope?: Scope | undefined;
  /** `YYYY-MM-DD` of the occurrence for `instance` and `from_date` */
  readonly date?: string | undefined;
  readonly summary?: string | undefined;
  /** empty string removes the location */
  readonly location?: string | undefined;
  /** empty string removes the description */
  readonly description?: string | undefined;
  /** `YYYY-MM-DD HH:MM`, together with `end` */
  readonly start?: string | undefined;
  /** `HH:MM` on the day of `start` */
  readonly end?: string | undefined;
}

// ---------- what changes ----------

interface Times {
  /** compact date of the new start */
  readonly date: string;
  readonly start: string;
  readonly end: string;
}

interface Changes {
  readonly summary: string | null | undefined;
  readonly location: string | null | undefined;
  readonly description: string | null | undefined;
  readonly times: Times | undefined;
}

const parseTimes = (start: string, end: string): V<Times> => {
  const s = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(start.trim());
  const e = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(end.trim());
  if (!s) return fail("start must be YYYY-MM-DD HH:MM (24h)");
  if (!e) return fail("end must be HH:MM (24h), on the day of start");
  const date = compactDate(s[1] ?? "");
  if (date === undefined) return fail("start is not a real calendar date");
  if (`${e[1]}${e[2]}` <= `${s[2]}${s[3]}`) return fail("end must be after start");
  return Result.succeed({ date, start: `${s[2]}${s[3]}00`, end: `${e[1]}${e[2]}00` });
};

/** A text change: `undefined` leaves the property alone, null removes it. */
const textChange = (
  field: string,
  v: string | undefined,
  allowEmpty: boolean,
): V<string | null | undefined> => {
  if (v === undefined) return Result.succeed(undefined);
  if (v.trim() === "") return allowEmpty ? Result.succeed(null) : fail(`${field} must not be empty`);
  return textField(field, v);
};

const parseChanges = (p: UpdateParams): V<Changes> =>
  Result.gen(function* () {
    if ([p.summary, p.location, p.description, p.start, p.end].every((v) => v === undefined))
      return yield* fail("nothing to change: give summary, location, description, or start and end");
    if ((p.start === undefined) !== (p.end === undefined))
      return yield* fail("start and end must be given together");
    return {
      summary: yield* textChange("summary", p.summary, false),
      location: yield* textChange("location", p.location, true),
      description: yield* textChange("description", p.description, true),
      times: p.start !== undefined && p.end !== undefined ? yield* parseTimes(p.start, p.end) : undefined,
    };
  });

const scopeOf = (p: UpdateParams): V<{ scope: Scope; date: string | undefined }> => {
  const scope = p.scope ?? "all";
  if (scope === "all")
    return p.date === undefined
      ? Result.succeed({ scope, date: undefined })
      : fail("date is only for scope 'instance' and 'from_date'");
  if (p.date === undefined) return fail(`scope '${scope}' needs the date (YYYY-MM-DD) of the occurrence`);
  const date = compactDate(p.date);
  return date === undefined ? fail("date must be a real date, YYYY-MM-DD") : Result.succeed({ scope, date });
};

const text = (e: Event, name: string, v: string | null | undefined): Event =>
  v === undefined ? e : setProp(e, name, v === null ? undefined : `${name}:${v}`);

/** Text and time changes applied to one VEVENT (not yet marked as modified). */
const applyChanges = (e: Event, ch: Changes): V<Event> =>
  Result.gen(function* () {
    const edited = text(
      text(text(e, "SUMMARY", ch.summary), "LOCATION", ch.location),
      "DESCRIPTION",
      ch.description,
    );
    const dtstart = prop(e, "DTSTART");
    if (ch.times === undefined) return edited;
    if (dtstart === undefined) return yield* fail("the event has no DTSTART");
    if (/VALUE=DATE(;|$)/i.test(dtstart.params) || dtstart.value.length === 8)
      return yield* fail("all-day events cannot be moved: only events with a start time");
    // the times are in the event's own zone: its TZID, UTC when it is stored in UTC, else floating
    const zone = /Z$/i.test(dtstart.value) ? "Z" : "";
    return setProp(
      setProp(
        setProp(edited, "DTSTART", `DTSTART${dtstart.params}:${ch.times.date}T${ch.times.start}${zone}`),
        "DTEND",
        `DTEND${dtstart.params}:${ch.times.date}T${ch.times.end}${zone}`,
      ),
      "DURATION",
      undefined,
    );
  });

const without = (e: Event, names: readonly string[]): Event =>
  names.reduce((acc, n) => setProp(acc, n, undefined), e);

/** The event moved to the occurrence on `compact`: same time of day and length. */
const shiftedTo = (e: Event, compact: string): V<Event> => {
  const dtstart = prop(e, "DTSTART");
  const start = dtstart === undefined ? undefined : parseWall(dtstart.value);
  if (dtstart === undefined || start === undefined) return fail("the event has no readable DTSTART");
  const delta = dateMs(compact) + (start.hasTime ? start.ms - dayOf(start) : 0) - start.ms;
  const dtend = prop(e, "DTEND");
  const end = dtend === undefined ? undefined : parseWall(dtend.value);
  const moved = setProp(
    e,
    "DTSTART",
    `DTSTART${dtstart.params}:${formatWall({ ...start, ms: start.ms + delta })}`,
  );
  return Result.succeed(
    dtend === undefined || end === undefined
      ? moved
      : setProp(moved, "DTEND", `DTEND${dtend.params}:${formatWall({ ...end, ms: end.ms + delta })}`),
  );
};

const mainEvent = (lines: readonly string[]): V<Event> => {
  const master = events(lines).find(isMaster);
  return master === undefined ? fail("the file holds no main event to change") : Result.succeed(master);
};

const isRecurring = (master: Event): boolean => prop(master, "RRULE") !== undefined;

const exceptionDate = (e: Event): string | undefined => prop(e, "RECURRENCE-ID")?.value.slice(0, 8);

// ---------- scope: all ----------

/**
 * The file's lines with the main event changed: the whole series for a recurring one. Only text and
 * the time can change; a series keeps its rule. Moving a series that has exceptions is refused,
 * because its exceptions would no longer match. Exceptions keep their own text.
 */
export const updateLines = (lines: readonly string[], p: UpdateParams, now: Date): V<string[]> =>
  Result.gen(function* () {
    const master = yield* mainEvent(lines);
    const ch = yield* parseChanges(p);
    if (
      ch.times !== undefined &&
      (events(lines).length > 1 ||
        prop(master, "EXDATE") !== undefined ||
        prop(master, "RDATE") !== undefined)
    )
      return yield* fail(
        "a series with exceptions cannot be moved as a whole: change single occurrences (scope 'instance') or the ones from a date on (scope 'from_date')",
      );
    const edited = yield* applyChanges(master, ch);
    return mapEvents(lines, (e, main) => (main ? touch(edited, now) : e));
  });

// ---------- scope: one instance ----------

/**
 * Changes one occurrence of a series by writing an exception (a VEVENT with RECURRENCE-ID); an
 * exception that exists already is changed instead. The series itself stays as it is.
 */
export const updateInstance = (lines: readonly string[], p: UpdateParams, now: Date): V<string[]> =>
  Result.gen(function* () {
    const { date } = yield* scopeOf(p);
    const ch = yield* parseChanges(p);
    const master = yield* mainEvent(lines);
    if (date === undefined || !isRecurring(master)) return yield* fail("the event is not a recurring event");
    const existing = events(lines).find((e) => !isMaster(e) && exceptionDate(e) === date);
    if (existing !== undefined) {
      const edited = touch(yield* applyChanges(existing, ch), now);
      return mapEvents(lines, (e, main) => (!main && exceptionDate(e) === date ? edited : e));
    }
    const dtstart = prop(master, "DTSTART");
    const rid = dtstart === undefined ? undefined : recurrenceId(dtstart, date);
    if (rid === undefined) return yield* fail("the event has no readable DTSTART");
    const own = yield* shiftedTo(
      without(master, ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "SEQUENCE"]),
      date,
    );
    const created = touch(yield* applyChanges(setProp(own, "RECURRENCE-ID", rid), ch), now);
    const end = lines.map((l) => l.toUpperCase()).lastIndexOf("END:VCALENDAR");
    return end < 0
      ? yield* fail("the file has no END:VCALENDAR")
      : [...lines.slice(0, end), ...created, ...lines.slice(end)];
  });

// ---------- scope: from a date on ----------

/** What has to be known about the series before it is split. */
export const seriesInfo = (lines: readonly string[]): V<{ count: number | undefined; startIso: string }> =>
  Result.gen(function* () {
    const master = yield* mainEvent(lines);
    const rule = prop(master, "RRULE");
    const start = parseWall(prop(master, "DTSTART")?.value ?? "");
    if (rule === undefined || start === undefined) return yield* fail("the event is not a recurring event");
    return { count: ruleCount(rule.value), startIso: new Date(start.ms).toISOString().slice(0, 10) };
  });

/**
 * Splits a series at `date`: the old series ends just before it, and the occurrences from `date`
 * on become a new series (new UID) that carries the changes. `before` is the number of occurrences
 * before `date`, needed only for a series with COUNT. Exceptions or listed dates on or after `date`
 * are refused, because they would have to move to the new series.
 */
export const splitSeries = (
  lines: readonly string[],
  p: UpdateParams,
  newUid: string,
  now: Date,
  before: number | undefined,
): V<{ original: string[]; created: string[] }> =>
  Result.gen(function* () {
    const { date } = yield* scopeOf(p);
    const ch = yield* parseChanges(p);
    const master = yield* mainEvent(lines);
    const rule = prop(master, "RRULE");
    const dtstart = prop(master, "DTSTART");
    const start = dtstart === undefined ? undefined : parseWall(dtstart.value);
    if (date === undefined || rule === undefined || dtstart === undefined || start === undefined)
      return yield* fail("the event is not a recurring event");
    if (dateMs(date) <= dayOf(start))
      return yield* fail(
        "date is the first occurrence or earlier: use scope 'all' to change the whole series",
      );
    if (ch.times !== undefined && ch.times.date !== date)
      return yield* fail("from_date changes the time of day, not the date: start must be on the given date");
    if (
      events(lines).some((e) => !isMaster(e) && (exceptionDate(e) ?? "") >= date) ||
      listedDates(master).some((d) => d >= date)
    )
      return yield* fail(
        "the series has exceptions on or after that date; change those occurrences one by one (scope 'instance')",
      );
    const count = ruleCount(rule.value);
    const remaining = count === undefined ? undefined : count - (before ?? 0);
    if (remaining !== undefined && remaining < 1) return yield* fail("no occurrences left from that date on");

    const until = yield* untilBefore(dtstart, date);
    const ended = touch(setProp(master, "RRULE", `RRULE:${withUntil(rule.value, until)}`), now);
    const base = yield* shiftedTo(without(master, ["RECURRENCE-ID", "EXDATE", "RDATE", "SEQUENCE"]), date);
    const following = setProp(
      setProp(base, "UID", `UID:${newUid}`),
      "RRULE",
      remaining === undefined ? `RRULE:${rule.value}` : `RRULE:${withCount(rule.value, remaining)}`,
    );
    const created = touch(yield* applyChanges(following, ch), now);
    return {
      original: mapEvents(lines, (e, main) => (main ? ended : e)),
      created: mapEvents(lines, (_e, main) => (main ? created : undefined)),
    };
  });

// ---------- effects ----------

/** ISO dates (YYYY-MM-DD) on which khal shows an occurrence of the event, within a khal range. */
export const occurrenceDates = (
  settings: Settings,
  calendar: string,
  uid: string,
  range: string,
): Effect.Effect<string[], KhalError> =>
  Effect.map(execute(settings, listArgs({ range, calendar })), (out) =>
    parseEvents(out)
      .filter((e) => e.uid === uid)
      .map((e) => e.startDate),
  );

export const isoOf = (compact: string): string =>
  `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

/** Changes an existing event, or part of a series, in the calendar's vdir. */
export const updateEvent = (
  settings: Settings,
  p: UpdateParams,
  newUid: string,
  now: Date,
): Effect.Effect<string, KhalError> =>
  Effect.gen(function* () {
    const stored = yield* findEvent(settings, p.calendar, p.uid);
    const { scope, date } = yield* Effect.fromResult(scopeOf(p));
    const uid = p.uid.trim();
    const where = `in calendar ${p.calendar.trim()}`;
    const warning = p.summary === undefined ? undefined : titleWarning(p.summary);
    const done = (what: string): string => `${what}${warning === undefined ? "" : `\n${warning}`}\n`;

    if (scope === "all" || date === undefined) {
      yield* writeEvent(stored.file, yield* Effect.fromResult(updateLines(stored.lines, p, now)));
      return done(`Updated event ${uid} ${where}.`);
    }

    // the day has to be an occurrence khal knows (not excluded, not beyond the end of the series)
    const iso = isoOf(date);
    if (!(yield* occurrenceDates(settings, p.calendar, uid, `${iso} 1d`)).includes(iso))
      return yield* Effect.fail(invalid(`event ${uid} has no occurrence on ${iso}`));

    if (scope === "instance") {
      yield* writeEvent(stored.file, yield* Effect.fromResult(updateInstance(stored.lines, p, now)));
      return done(`Updated the occurrence on ${iso} of event ${uid} ${where}.`);
    }

    const info = yield* Effect.fromResult(seriesInfo(stored.lines));
    const before =
      info.count === undefined
        ? undefined
        : (yield* occurrenceDates(settings, p.calendar, uid, `${info.startIso} ${iso}`)).filter(
            (d) => d < iso,
          ).length;
    const newId = `${newUid}@mcp-khal`;
    const split = yield* Effect.fromResult(splitSeries(stored.lines, p, newId, now, before));
    // the new series first: a failure in between leaves a duplicate, never a lost event
    yield* writeEvent(join(dirname(stored.file), `${newId}.ics`), split.created);
    yield* writeEvent(stored.file, split.original);
    return done(
      `Updated event ${uid} ${where} from ${iso} on: the old series now ends before that day, the following events are a new series with uid ${newId}.`,
    );
  });
