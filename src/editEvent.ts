import { dirname } from "node:path";
import { Effect, Result } from "effect";
import { resolveAddress } from "./config.js";
import { type AppError, InvalidInput } from "./errors.js";
import { hostOccurrenceDatesIn, type Instance, occurrencesIn } from "./expand.js";
import { type Event, events, isMaster, mapEvents, type Prop, prop, setProp } from "./ics.js";
import { titleWarning } from "./newEvent.js";
import { textField } from "./recurrence.js";
import {
  checkFile,
  compactDate,
  formatWall,
  instantOf,
  listedInstants,
  markEvent,
  normAddress,
  overrideTimes,
  parseWall,
  ruleAllows,
  ruleCount,
  sameAddress,
  sequenceAll,
  untilValue,
  valueAt,
  type Wall,
  withCount,
  withoutMethod,
  withUntil,
  type Zones,
  zonesOf,
} from "./series.js";
import type { Settings } from "./settings.js";
import {
  ianaZone,
  instantToWall,
  wallFromUtcMs,
  wallToInstant,
  wallToUtcMs,
  type Zone,
  type Wall as ZoneWall,
} from "./timezone.js";
import { createEvent, findEvent, newFileIn, writeEvent } from "./vdir.js";

type V<A> = Result.Result<A, InvalidInput>;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });
const fail = (message: string): V<never> => Result.fail(invalid(message));

const DAY_MS = 86_400_000;

/** Which events of a recurring event a change applies to. */
export type Scope = "all" | "instance" | "from_date";

/**
 * What the pure edit functions need to know about the machine and the user; the process edge
 * reads them once (the host zone from the settings, the address from the calendar's config).
 */
export interface EditEnv {
  /** IANA zone the dates and times of the tools are in: the one `list_events` shows them in */
  readonly hostZone: string;
  /** the user's own address on this calendar; undefined when none is configured */
  readonly me: string | undefined;
}

/** For callers that change text only: no time is read, so neither zone nor address matters. */
const TEXT_ONLY: EditEnv = { hostZone: "UTC", me: undefined };

export const envOf = (settings: Settings, calendar: string): EditEnv => ({
  hostZone: settings.timezone,
  me: Result.getOrElse(resolveAddress(settings.calendars, calendar), () => undefined),
});

export interface UpdateParams {
  readonly calendar: string;
  readonly uid: string;
  /** default `all`; `instance` and `from_date` need `date` */
  readonly scope?: Scope | undefined;
  /** `YYYY-MM-DD` of the occurrence for `instance` and `from_date`, as `list_events` shows it (host zone) */
  readonly date?: string | undefined;
  readonly summary?: string | undefined;
  /** empty string removes the location */
  readonly location?: string | undefined;
  /** empty string removes the description */
  readonly description?: string | undefined;
  /** `YYYY-MM-DD HH:MM` in the host zone, together with `end` */
  readonly start?: string | undefined;
  /** `HH:MM` in the host zone on the day of `start` */
  readonly end?: string | undefined;
  /** the organizer cannot be changed: a value is always refused */
  readonly organizer?: string | undefined;
}

// ---------- what changes ----------

interface Times {
  /** compact date of the new start (host zone) */
  readonly date: string;
  /** the new start and end as the host zone's wall clock */
  readonly start: ZoneWall;
  readonly end: ZoneWall;
}

interface Changes {
  readonly summary: string | null | undefined;
  readonly location: string | null | undefined;
  readonly description: string | null | undefined;
  readonly times: Times | undefined;
}

const wallOf = (date: string, hour: string | undefined, minute: string | undefined): ZoneWall => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(4, 6)),
  day: Number(date.slice(6, 8)),
  hour: Number(hour),
  minute: Number(minute),
  second: 0,
});

const parseTimes = (start: string, end: string): V<Times> => {
  const s = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(start.trim());
  const e = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(end.trim());
  if (!s) return fail("start must be YYYY-MM-DD HH:MM (24h)");
  if (!e) return fail("end must be HH:MM (24h), on the day of start");
  const date = compactDate(s[1] ?? "");
  if (date === undefined) return fail("start is not a real calendar date");
  if (`${e[1]}${e[2]}` <= `${s[2]}${s[3]}`) return fail("end must be after start");
  return Result.succeed({ date, start: wallOf(date, s[2], s[3]), end: wallOf(date, e[1], e[2]) });
};

/** Longest summary, location and description accepted (characters). */
export const MAX_TITLE = 1_000;
export const MAX_DESCRIPTION = 20_000;

/** A text change: `undefined` leaves the property alone, null removes it. */
const textChange = (
  field: string,
  v: string | undefined,
  allowEmpty: boolean,
  max: number,
): V<string | null | undefined> => {
  if (v === undefined) return Result.succeed(undefined);
  if (v.length > max) return fail(`${field} must not be longer than ${max} characters`);
  if (v.trim() === "") return allowEmpty ? Result.succeed(null) : fail(`${field} must not be empty`);
  return textField(field, v);
};

const parseChanges = (p: UpdateParams): V<Changes> =>
  Result.gen(function* () {
    if (p.organizer !== undefined)
      return yield* fail(
        "the organizer of an event cannot be changed: that would need an invitation to the attendees, which this server cannot send",
      );
    if ([p.summary, p.location, p.description, p.start, p.end].every((v) => v === undefined))
      return yield* fail("nothing to change: give summary, location, description, or start and end");
    if ((p.start === undefined) !== (p.end === undefined))
      return yield* fail("start and end must be given together");
    return {
      summary: yield* textChange("summary", p.summary, false, MAX_TITLE),
      location: yield* textChange("location", p.location, true, MAX_TITLE),
      description: yield* textChange("description", p.description, true, MAX_DESCRIPTION),
      times: p.start !== undefined && p.end !== undefined ? yield* parseTimes(p.start, p.end) : undefined,
    };
  });

export const scopeOf = (p: {
  scope?: Scope | undefined;
  date?: string | undefined;
}): V<{ scope: Scope; date: string | undefined }> => {
  const scope = p.scope ?? "all";
  if (!["all", "instance", "from_date"].includes(scope))
    return fail("scope must be 'all', 'instance' or 'from_date'");
  if (scope === "all")
    return p.date === undefined
      ? Result.succeed({ scope, date: undefined })
      : fail("date is only for scope 'instance' and 'from_date'");
  if (p.date === undefined) return fail(`scope '${scope}' needs the date (YYYY-MM-DD) of the occurrence`);
  const date = compactDate(p.date);
  return date === undefined ? fail("date must be a real date, YYYY-MM-DD") : Result.succeed({ scope, date });
};

/**
 * The text of a property changes; a changed DESCRIPTION drops the vendor's HTML copy of it
 * (X-ALT-DESC), which would otherwise show the old text. Every other X- property stays untouched.
 */
const text = (e: Event, name: string, v: string | null | undefined): Event => {
  if (v === undefined) return e;
  const changed = setProp(e, name, v === null ? undefined : `${name}:${v}`);
  return name === "DESCRIPTION" ? setProp(changed, "X-ALT-DESC", undefined) : changed;
};

// ---------- who may revise ----------

/**
 * An event with an ORGANIZER that is not the user belongs to somebody else: its time and
 * recurrence are not ours to change (we cannot tell the attendees). An event without ORGANIZER is
 * the user's own.
 */
export const requireMayRevise = (master: Event, env: EditEnv): V<undefined> => {
  const organizer = prop(master, "ORGANIZER");
  return organizer === undefined || sameAddress(organizer.value, env.me)
    ? Result.succeed(undefined)
    : fail(
        `only the organizer can change the time or recurrence of an event: this one is organized by ${normAddress(organizer.value)}, not by you (${env.me ?? "no address is configured for this calendar"}); its text can still be changed in your own calendar`,
      );
};

/** A note for the tool result when the user changes an event somebody else organizes. */
export const organizerNote = (lines: readonly string[], env: EditEnv): string | undefined => {
  const organizer = prop(events(lines).find(isMaster) ?? [], "ORGANIZER");
  return organizer === undefined || sameAddress(organizer.value, env.me)
    ? undefined
    : `Note: ${normAddress(organizer.value)} organizes this event and is not told about the change: only your own calendar file changed.`;
};

// ---------- applying the changes ----------

interface Applied {
  readonly event: Event;
  /** DTSTART, DTEND or DURATION changed: a revision in the sense of RFC 5546 2.1.4 */
  readonly revised: boolean;
}

/**
 * Text and time changes applied to one VEVENT (not yet marked as modified). The times are the host
 * zone's, as `list_events` shows them: a UTC event gets the UTC instant, a TZID event the wall clock
 * of its own zone, a floating event the floating time. A series cannot be moved to a day its own
 * rule does not name.
 */
const applyChanges = (lines: readonly string[], e: Event, ch: Changes, env: EditEnv): V<Applied> =>
  Result.gen(function* () {
    const edited = text(
      text(text(e, "SUMMARY", ch.summary), "LOCATION", ch.location),
      "DESCRIPTION",
      ch.description,
    );
    if (ch.times === undefined) return { event: edited, revised: false };
    const dtstart = prop(e, "DTSTART");
    if (dtstart === undefined) return yield* fail("the event has no DTSTART");
    if (/VALUE=DATE(;|$)/i.test(dtstart.params) || dtstart.value.length === 8)
      return yield* fail("all-day events cannot be moved: only events with a start time");
    const form = parseWall(dtstart.value);
    if (form === undefined) return yield* fail("the event has no readable DTSTART");
    const zones = yield* zonesOf(lines, env.hostZone);
    const zone = yield* zones.of(dtstart, dtstart.value);
    const at = (wall: ZoneWall): string => valueAt(zone, form, wallToInstant(zones.host, wall));
    const newStart = at(ch.times.start);
    const moved = setProp(
      setProp(
        setProp(edited, "DTSTART", `DTSTART${dtstart.params}:${newStart}`),
        "DTEND",
        `DTEND${dtstart.params}:${at(ch.times.end)}`,
      ),
      "DURATION",
      undefined,
    );
    const rule = prop(moved, "RRULE");
    const first = parseWall(newStart);
    if (rule !== undefined && first !== undefined && !ruleAllows(rule.value, wallFromUtcMs(first.ms)))
      return yield* fail(
        `the new start does not fit the repeat rule (${rule.value}): the series would no longer repeat on the days it names; move it to a day the rule names or change one occurrence (scope 'instance')`,
      );
    return { event: moved, revised: true };
  });

const without = (e: Event, names: readonly string[]): Event =>
  names.reduce((acc, n) => setProp(acc, n, undefined), e);

/**
 * The event moved to start at the instant `ms`: same length (the exact one for DTEND, the nominal
 * one for DURATION, whole days for an all-day event), every value in its own form and zone.
 */
const shiftTo = (zones: Zones, e: Event, dtstart: Prop, form: Wall, ms: number): V<Event> =>
  Result.gen(function* () {
    const zone = yield* zones.of(dtstart, dtstart.value);
    const oldMs = yield* instantOf(zones, dtstart, dtstart.value);
    const moved = setProp(e, "DTSTART", `DTSTART${dtstart.params}:${valueAt(zone, form, ms)}`);
    const dtend = prop(e, "DTEND");
    const end = dtend === undefined ? undefined : parseWall(dtend.value);
    if (dtend === undefined || end === undefined) return moved;
    if (!form.hasTime) {
      // all-day: whole days, the end moves by as many days as the start
      const days = wallToUtcMs(instantToWall(zone, ms)) - form.ms;
      return setProp(moved, "DTEND", `DTEND${dtend.params}:${formatWall({ ...end, ms: end.ms + days })}`);
    }
    const endMs = yield* instantOf(zones, dtend, dtend.value, zone);
    const endZone = yield* zones.of(dtend, dtend.value);
    return setProp(moved, "DTEND", `DTEND${dtend.params}:${valueAt(endZone, end, ms + (endMs - oldMs))}`);
  });

const mainEvent = (lines: readonly string[]): V<Event> => {
  const master = events(lines).find(isMaster);
  return master === undefined ? fail("the file holds no main event to change") : Result.succeed(master);
};

const isRecurring = (master: Event): boolean => prop(master, "RRULE") !== undefined;

// ---------- occurrences, by the host-zone day the tools show ----------

export const isoOf = (compact: string): string =>
  `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

/** `[start of the day, start of the next day)` as instants, the day being a date in `host`. */
const dayWindow = (host: Zone, iso: string): readonly [number, number] => {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const at = (day: number): number => wallToInstant(host, wallFromUtcMs(Date.UTC(y, m - 1, day)));
  return [at(d), at(d + 1)];
};

/** The occurrences that start on the host-zone day `iso`, overrides included, as `list_events` shows them. */
const instancesOn = (lines: readonly string[], iso: string, hostZone: string): V<readonly Instance[]> =>
  Result.gen(function* () {
    if (compactDate(iso) === undefined) return yield* fail("the date must be a real date, YYYY-MM-DD");
    const host = yield* ianaZone(hostZone);
    const [from, to] = dayWindow(host, iso);
    const all = yield* occurrencesIn(lines, from, to, hostZone);
    return all.filter((i) => i.hostIsoDate === iso);
  });

/**
 * ISO dates (YYYY-MM-DD) in `[from, to)` on which the stored event has an occurrence: EXDATE,
 * UNTIL and COUNT are honoured, exceptions count at their own date. The dates are those of the
 * host zone, the ones the tools take and show.
 */
export const occurrenceDates = (
  lines: readonly string[],
  from: string,
  to: string,
  hostZone: string,
): V<readonly string[]> => hostOccurrenceDatesIn(lines, from, to, hostZone);

/** Fails unless the event has an occurrence on the host-zone day `iso`. */
export const requireOccurrence = (
  lines: readonly string[],
  uid: string,
  iso: string,
  hostZone: string,
): V<void> =>
  Result.flatMap(instancesOn(lines, iso, hostZone), (day) =>
    day.length > 0 ? Result.succeed(undefined) : fail(`event ${uid} has no occurrence on ${iso}`),
  );

/**
 * Start instants of the rule's own instances in the range (the stored series without its
 * exceptions, EXDATE and RDATE): COUNT counts instances that EXDATE removes (RFC 5545 3.3.10,
 * 3.8.5.3) and not the ones RDATE adds, and every instance counts, also several on one day.
 */
export const ruleInstants = (
  lines: readonly string[],
  hostZone: string,
  range: { readonly from?: number; readonly to: number },
): V<readonly number[]> =>
  Result.gen(function* () {
    const solo = mapEvents(lines, (e, main) => (main ? without(e, ["EXDATE", "RDATE"]) : undefined));
    const master = events(solo).find(isMaster);
    const dtstart = master === undefined ? undefined : prop(master, "DTSTART");
    if (dtstart === undefined) return yield* fail("the event has no DTSTART");
    const zones = yield* zonesOf(solo, hostZone);
    const startMs = yield* instantOf(zones, dtstart, dtstart.value);
    const from = startMs - DAY_MS;
    if (range.to <= from) return [] as number[];
    const found = yield* occurrencesIn(solo, from, range.to, hostZone);
    return found
      .map((i) => i.start)
      .filter((ms) => ms >= (range.from ?? Number.NEGATIVE_INFINITY) && ms < range.to);
  });

/** Number of instances of the series' rule before the host-zone day `iso` (excluded ones count, several per day count each). */
export const occurrencesBefore = (lines: readonly string[], iso: string, hostZone: string): V<number> =>
  Result.gen(function* () {
    const host = yield* ianaZone(hostZone);
    const [from] = dayWindow(host, iso);
    return (yield* ruleInstants(lines, hostZone, { to: from })).length;
  });

// ---------- scope: all ----------

/**
 * The file's lines with the main event changed: the whole series for a recurring one. Only text and
 * the time can change; a series keeps its rule. Moving a series that has exceptions is refused,
 * because its exceptions would no longer match. Exceptions keep their own text. DTSTAMP and
 * LAST-MODIFIED are refreshed; SEQUENCE grows only when the organizer moves the event.
 */
export const updateLines = (
  lines: readonly string[],
  p: UpdateParams,
  now: Date,
  env: EditEnv = TEXT_ONLY,
): V<string[]> =>
  Result.gen(function* () {
    yield* checkFile(lines);
    const master = yield* mainEvent(lines);
    const ch = yield* parseChanges(p);
    if (ch.times !== undefined) {
      yield* requireMayRevise(master, env);
      if (
        events(lines).length > 1 ||
        prop(master, "EXDATE") !== undefined ||
        prop(master, "RDATE") !== undefined
      )
        return yield* fail(
          "a series with exceptions cannot be moved as a whole: change single occurrences (scope 'instance') or the ones from a date on (scope 'from_date')",
        );
    }
    const applied = yield* applyChanges(lines, master, ch, env);
    const marked = markEvent(applied.event, now, applied.revised);
    return withoutMethod(mapEvents(lines, (e, main) => (main ? marked : e)));
  });

// ---------- scope: one instance ----------

/**
 * Changes one occurrence of a series by writing an exception (a VEVENT with RECURRENCE-ID); an
 * exception that exists already is changed instead. The series itself stays as it is.
 */
export const updateInstance = (
  lines: readonly string[],
  p: UpdateParams,
  now: Date,
  env: EditEnv,
): V<string[]> =>
  Result.gen(function* () {
    const { date } = yield* scopeOf(p);
    const ch = yield* parseChanges(p);
    if (date === undefined) return yield* fail("the event is not a recurring event");
    yield* checkFile(lines);
    if (ch.times !== undefined) yield* requireMayRevise(yield* mainEvent(lines), env);
    const written = yield* editInstance(
      lines,
      date,
      (e) => Result.map(applyChanges(lines, e, ch, env), (a) => markEvent(a.event, now, a.revised)),
      env,
    );
    return withoutMethod(written);
  });

/**
 * Applies `edit` to the exception of the occurrence on the host-zone day `date` (compact), writing
 * the exception first (a copy of the main event moved to that occurrence) when there is none. The
 * new exception's RECURRENCE-ID is the original start of the occurrence, in the form of DTSTART
 * (RFC 5545 3.8.4.4). `edit` marks the event as modified.
 */
export const editInstance = (
  lines: readonly string[],
  date: string,
  edit: (e: Event) => V<Event>,
  env: EditEnv,
): V<string[]> =>
  Result.gen(function* () {
    yield* checkFile(lines);
    const master = yield* mainEvent(lines);
    if (!isRecurring(master)) return yield* fail("the event is not a recurring event");
    const dtstart = prop(master, "DTSTART");
    const form = dtstart === undefined ? undefined : parseWall(dtstart.value);
    if (dtstart === undefined || form === undefined) return yield* fail("the event has no readable DTSTART");
    const end = lines.map((l) => l.toUpperCase()).lastIndexOf("END:VCALENDAR");
    if (end < 0) return yield* fail("the file has no END:VCALENDAR");
    const iso = isoOf(date);
    const zones = yield* zonesOf(lines, env.hostZone);
    const zone = yield* zones.of(dtstart, dtstart.value);
    const day = yield* instancesOn(lines, iso, env.hostZone);
    const [only, ...more] = day;
    if (only === undefined) return yield* fail(`the event has no occurrence on ${iso}`);
    if (more.length > 0)
      return yield* fail(
        `the event has ${day.length} occurrences on ${iso}: one of them cannot be picked by its day`,
      );
    // an exception is found by where it starts now, which is where `list_events` shows it
    const overrides = events(lines).filter((e) => !isMaster(e));
    const times = yield* sequenceAll(overrides, (o) => overrideTimes(zones, o, zone));
    const existing = overrides[times.findIndex((t) => t.start === only.start)];
    if (existing !== undefined) {
      const edited = yield* edit(existing);
      const key = existing.join("\n");
      return mapEvents(lines, (e, main) => (!main && e.join("\n") === key ? edited : e));
    }
    const own = yield* shiftTo(
      zones,
      without(master, ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"]),
      dtstart,
      form,
      only.start,
    );
    const rid = `RECURRENCE-ID${dtstart.params}:${valueAt(zone, form, only.start)}`;
    const created = yield* edit(setProp(own, "RECURRENCE-ID", rid));
    return [...lines.slice(0, end), ...created, ...lines.slice(end)];
  });

// ---------- scope: from a date on ----------

/**
 * Splits a series at the host-zone day `date`: the old series ends with its last instance before
 * that day, and the instances from the day on become a new series (new UID, SEQUENCE 0, an
 * unchanged copy of the attendee list and their status; no invitation is sent) that carries the
 * changes. A COUNT is divided by counting every instance of the rule before the day, excluded ones
 * and several per day included. Exceptions or listed dates on or after the day are refused, because
 * they would have to move to the new series.
 */
export const splitSeries = (
  lines: readonly string[],
  p: UpdateParams,
  newUid: string,
  now: Date,
  env: EditEnv,
): V<{ original: string[]; created: string[] }> =>
  Result.gen(function* () {
    yield* checkFile(lines);
    const { date } = yield* scopeOf(p);
    const ch = yield* parseChanges(p);
    const master = yield* mainEvent(lines);
    const rule = prop(master, "RRULE");
    const dtstart = prop(master, "DTSTART");
    const form = dtstart === undefined ? undefined : parseWall(dtstart.value);
    if (date === undefined || rule === undefined || dtstart === undefined || form === undefined)
      return yield* fail("the event is not a recurring event");
    yield* requireMayRevise(master, env);
    const zones = yield* zonesOf(lines, env.hostZone);
    const zone = yield* zones.of(dtstart, dtstart.value);
    const [dayFrom, dayTo] = dayWindow(zones.host, isoOf(date));

    const before = yield* ruleInstants(lines, env.hostZone, { to: dayFrom });
    const last = before.at(-1);
    if (last === undefined)
      return yield* fail(
        "date is the first occurrence or earlier: use scope 'all' to change the whole series",
      );
    if (ch.times !== undefined && ch.times.date !== date)
      return yield* fail("from_date changes the time of day, not the date: start must be on the given date");

    const overrides = events(lines).filter((e) => !isMaster(e));
    const moved = yield* sequenceAll(overrides, (o) => overrideTimes(zones, o, zone));
    const listed = [
      ...(yield* listedInstants(zones, master, "EXDATE", zone)),
      ...(yield* listedInstants(zones, master, "RDATE", zone)),
    ];
    if (moved.some((t) => t.rid >= dayFrom || t.start >= dayFrom) || listed.some((ms) => ms >= dayFrom))
      return yield* fail(
        "the series has exceptions on or after that date; change those occurrences one by one (scope 'instance')",
      );

    const count = ruleCount(rule.value);
    const remaining = count === undefined ? undefined : count - before.length;
    if (remaining !== undefined && remaining < 1) return yield* fail("no occurrences left from that date on");
    const [first] = yield* ruleInstants(lines, env.hostZone, { from: dayFrom, to: dayTo });
    if (first === undefined)
      return yield* fail(
        "the repeat rule has no occurrence on that day (it is an added date or a moved occurrence): change it with scope 'instance'",
      );

    const until = untilValue(zones.host, dtstart, form, last);
    const ended = markEvent(setProp(master, "RRULE", `RRULE:${withUntil(rule.value, until)}`), now, true);
    const base = yield* shiftTo(
      zones,
      without(master, ["RECURRENCE-ID", "EXDATE", "RDATE", "SEQUENCE"]),
      dtstart,
      form,
      first,
    );
    const following = setProp(
      setProp(base, "UID", `UID:${newUid}`),
      "RRULE",
      `RRULE:${remaining === undefined ? rule.value : withCount(rule.value, remaining)}`,
    );
    const applied = yield* applyChanges(lines, following, ch, env);
    const created = setProp(markEvent(applied.event, now, false), "SEQUENCE", "SEQUENCE:0");
    return {
      original: withoutMethod(mapEvents(lines, (e, main) => (main ? ended : e))),
      created: withoutMethod(mapEvents(lines, (_e, main) => (main ? created : undefined))),
    };
  });

// ---------- effects ----------

/** Changes an existing event, or part of a series, in the calendar's vdir. */
export const updateEvent = (
  settings: Settings,
  p: UpdateParams,
  newUid: string,
  now: Date,
): Effect.Effect<string, AppError> =>
  Effect.gen(function* () {
    const stored = yield* findEvent(settings, p.calendar, p.uid);
    const { scope, date } = yield* Effect.fromResult(scopeOf(p));
    const env = envOf(settings, p.calendar);
    const uid = p.uid.trim();
    const where = `in calendar ${p.calendar.trim()}`;
    const warning = p.summary === undefined ? undefined : titleWarning(p.summary);
    const note = organizerNote(stored.lines, env);
    const done = (what: string): string =>
      `${what}${warning === undefined ? "" : `\n${warning}`}${note === undefined ? "" : `\n${note}`}\n`;

    if (scope === "all" || date === undefined) {
      yield* writeEvent(
        stored.file,
        yield* Effect.fromResult(updateLines(stored.lines, p, now, env)),
        stored.etag,
      );
      return done(`Updated event ${uid} ${where}.`);
    }

    // the day has to be a real occurrence (not excluded, not beyond the end of the series)
    const iso = isoOf(date);
    yield* Effect.fromResult(requireOccurrence(stored.lines, uid, iso, env.hostZone));

    if (scope === "instance") {
      yield* writeEvent(
        stored.file,
        yield* Effect.fromResult(updateInstance(stored.lines, p, now, env)),
        stored.etag,
      );
      return done(`Updated the occurrence on ${iso} of event ${uid} ${where}.`);
    }

    const newId = newUid;
    const newFile = newFileIn(dirname(stored.file), `${newId}.ics`);
    if (typeof newFile !== "string") return yield* Effect.fail(newFile);
    const split = yield* Effect.fromResult(splitSeries(stored.lines, p, newId, now, env));
    // the new series first: a failure in between leaves a duplicate, never a lost event
    yield* createEvent(newFile, split.created);
    yield* writeEvent(stored.file, split.original, stored.etag);
    return done(
      `Updated event ${uid} ${where} from ${iso} on: the old series now ends before that day, the following events are a new series with uid ${newId}.`,
    );
  });
