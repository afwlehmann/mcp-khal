import { Effect, Result } from "effect";
import { DateTime } from "luxon";
import { type CalendarRef, selectCalendars } from "./calendars.js";
import { InvalidInput } from "./errors.js";
import { type Instance, occurrencesIn } from "./expand.js";
import { type Event, events as eventsOf, isMaster, mapEvents, type Prop, param, prop, props } from "./ics.js";
import { parseRange } from "./range.js";
import { type RawEvent, readCalendar } from "./reader.js";
import type { Settings } from "./settings.js";
import { ianaZone, instantToWall, type Wall, wallFromUtcMs } from "./timezone.js";

// The read side of the server: events of the vdirs of the calendars, expanded to occurrences and
// rendered as `CalendarEvent`. The clock (`now`) is a parameter, the host zone comes from
// `settings.timezone`. Files that cannot be used are returned as `problems` next to the events,
// never dropped.

/** One occurrence of an event as the read tools return it (dates and times in the host zone). */
export interface CalendarEvent {
  readonly calendar: string;
  readonly startDate: string;
  readonly startTime: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly title: string;
  readonly location: string;
  readonly organizer: string;
  /** names and addresses of the invitees; no accept/decline status */
  readonly attendees: string;
  readonly uid: string;
  readonly status: string;
  readonly cancelled: string;
  readonly allDay: string;
  readonly repeatPattern: string;
  readonly description: string;
}

type V<A> = Result.Result<A, InvalidInput>;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

/** Days searched before and after today when `search_events` gets no range. */
export const SEARCH_PAST_DAYS = 365;
export const SEARCH_FUTURE_DAYS = 365;

/** Longest search text. */
export const MAX_QUERY_LENGTH = 1_000;

export interface EventsResult {
  readonly events: readonly CalendarEvent[];
  /** sorted; one message per unusable file or occurrence expansion */
  readonly problems: readonly string[];
}

export interface ListQuery {
  readonly calendar?: string | undefined;
  readonly range?: string | undefined;
}
export interface RangeQuery {
  readonly calendar?: string | undefined;
  readonly start: string;
  readonly end: string;
}
export interface SearchQuery {
  readonly calendar?: string | undefined;
  readonly query: string;
  /** same words as `list_events`; default: a year back and a year ahead */
  readonly range?: string | undefined;
}

// ---------- pure: text of an event ----------

/** The recurrence rules as text: each RRULE value without blanks, several joined by ", ". */
export const repeatPattern = (rules: readonly string[]): string =>
  rules
    .map((r) =>
      r
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p !== "")
        .join(";"),
    )
    .filter((r) => r !== "")
    .join(", ");

/**
 * RFC 5545 3.3.11 TEXT unescaping. A backslash before a colon is not standard (a colon is never
 * escaped) but some producers write it; it is read as a plain colon.
 */
const unescapeText = (s: string): string =>
  s.replace(/\\([nN,;:\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

const textOf = (e: Event, name: string): string => unescapeText(prop(e, name)?.value.trim() ?? "");

const MAILTO = /^mailto:/i;

/** `Name <address>`, or whichever of the two exists. */
const person = (p: Prop): string => {
  const email = p.value.trim().replace(MAILTO, "");
  const name = param(p, "CN")?.trim() ?? "";
  return name !== "" && email !== "" ? `${name} <${email}>` : name !== "" ? name : email;
};

/** Title shown instead of the summary of an event the read tools must not reveal. */
export const PRIVATE_TITLE = "Private event";

export type Classification = "PUBLIC" | "PRIVATE" | "CONFIDENTIAL";

/**
 * RFC 5545 3.8.1.3 CLASS: PUBLIC when absent, and any value that is not PUBLIC, PRIVATE or
 * CONFIDENTIAL counts as PRIVATE. Of several CLASS lines the first counts.
 */
export const classification = (e: Event): Classification => {
  const v = prop(e, "CLASS")?.value.trim().toUpperCase();
  return v === undefined || v === "PUBLIC" ? "PUBLIC" : v === "CONFIDENTIAL" ? "CONFIDENTIAL" : "PRIVATE";
};

/** RFC 5545 3.8.2.7 TRANSP: OPAQUE when absent or not TRANSPARENT. */
export const transparency = (e: Event): "OPAQUE" | "TRANSPARENT" =>
  prop(e, "TRANSP")?.value.trim().toUpperCase() === "TRANSPARENT" ? "TRANSPARENT" : "OPAQUE";

interface Text {
  readonly title: string;
  readonly location: string;
  readonly organizer: string;
  readonly attendees: string;
  readonly status: string;
  readonly description: string;
  readonly repeat: string;
  /** true when the details are hidden (CLASS is not PUBLIC): `title` is then the placeholder */
  readonly hidden: boolean;
}

/**
 * The text of one VEVENT, with only its own recurrence rules (an exception has none). An event
 * whose CLASS is not PUBLIC shows only its placeholder title and its status: no location,
 * description, organizer, attendees or repeat rule. An exception without CLASS of its own
 * inherits the hiding of its main event (it must not reveal what the series hides).
 */
const textFields = (e: Event, inheritedHidden: boolean): Text => {
  const status = (prop(e, "STATUS")?.value.trim() ?? "").toUpperCase();
  const hidden = prop(e, "CLASS") === undefined ? inheritedHidden : classification(e) !== "PUBLIC";
  return hidden
    ? {
        title: PRIVATE_TITLE,
        location: "",
        organizer: "",
        attendees: "",
        status,
        description: "",
        repeat: "",
        hidden: true,
      }
    : {
        title: textOf(e, "SUMMARY"),
        location: textOf(e, "LOCATION"),
        organizer: (([o]) => (o === undefined ? "" : person(o)))(props(e, "ORGANIZER")),
        attendees: props(e, "ATTENDEE")
          .map(person)
          .filter((a) => a !== "")
          .join(", "),
        status,
        description: textOf(e, "DESCRIPTION"),
        repeat: repeatPattern(props(e, "RRULE").map((r) => r.value)),
        hidden: false,
      };
};

// ---------- pure: dates in the host zone ----------

const pad = (n: number): string => String(n).padStart(2, "0");
const isoDate = (w: Wall): string => `${String(w.year).padStart(4, "0")}-${pad(w.month)}-${pad(w.day)}`;
const clock = (w: Wall): string => `${pad(w.hour)}:${pad(w.minute)}`;
const dayBefore = (w: Wall): Wall => wallFromUtcMs(Date.UTC(w.year, w.month - 1, w.day - 1));

const render = (
  calendar: string,
  uid: string,
  t: Text,
  i: Instance,
  startW: Wall,
  endW: Wall,
): CalendarEvent => {
  const startDate = isoDate(startW);
  // an all-day end is exclusive (the next day at 00:00); the output shows the last day
  const endDate = i.allDay
    ? ((last) => (last < startDate ? startDate : last))(isoDate(dayBefore(endW)))
    : isoDate(endW);
  return {
    calendar,
    startDate,
    startTime: i.allDay ? "" : clock(startW),
    endDate,
    endTime: i.allDay ? "" : clock(endW),
    title: t.title,
    location: t.location,
    organizer: t.organizer,
    attendees: t.attendees,
    uid,
    status: t.status,
    cancelled: t.status === "CANCELLED" ? "CANCELLED" : "",
    allDay: i.allDay ? "True" : "False",
    repeatPattern: t.repeat,
    description: t.description,
  };
};

// ---------- pure: one file to rendered occurrences ----------

const OVERRIDE_ONLY = /^(RECURRENCE-ID|RRULE|RDATE|EXDATE)[;:]/i;

/** The file reduced to one exception, made a stand-alone event: its own start tells where it lies. */
const onlyOverride = (lines: readonly string[], target: Event): readonly string[] => {
  const key = target.join("\n");
  return mapEvents(lines, (e, master) =>
    master || e.join("\n") !== key ? undefined : e.filter((l) => !OVERRIDE_ONLY.test(l)),
  );
};

export interface Ranked {
  readonly start: number;
  readonly end: number;
  readonly event: CalendarEvent;
  /** the details of the event are hidden (CLASS is not PUBLIC); search must not look at it */
  readonly hidden?: boolean;
}

/**
 * The occurrences of one file in `[fromMs, toMs)`, rendered in the host zone. Exceptions bring
 * their own text; a failure of the file is a problem (the file is skipped), not an error.
 */
export const renderFile = (
  calendar: string,
  raw: RawEvent,
  fromMs: number,
  toMs: number,
  hostZone: string,
): { readonly events: readonly Ranked[]; readonly problems: readonly string[] } => {
  const problem = (message: string) => ({ events: [] as Ranked[], problems: [`${raw.file}: ${message}`] });
  const evs = eventsOf(raw.lines);
  const master = evs.find(isMaster);
  const host = ianaZone(hostZone);
  if (evs.length === 0) return problem("the file holds no main event");
  if (Result.isFailure(host)) return problem(host.failure.message);
  const zone = host.success;

  // A file with exceptions only (RFC 4791 4.1) has no main event: each exception stands for itself.
  const expanded: Result.Result<readonly Instance[], InvalidInput> =
    master === undefined ? Result.succeed([]) : occurrencesIn(raw.lines, fromMs, toMs, hostZone);
  // what a failure says (zone names, rules, durations) is a detail of the event: not for a hidden one
  const secret = master !== undefined && classification(master) !== "PUBLIC";
  const HIDDEN_PROBLEM = "the event cannot be expanded (its details are hidden)";
  if (Result.isFailure(expanded)) return problem(secret ? HIDDEN_PROBLEM : expanded.failure.message);

  const base = master === undefined ? undefined : textFields(master, false);
  const runs = evs
    .filter((e) => !isMaster(e))
    .map((o) => ({
      text: textFields(o, base?.hidden ?? false),
      run: occurrencesIn(onlyOverride(raw.lines, o), fromMs, toMs, hostZone),
    }));
  const failures = runs.flatMap(({ run, text }) =>
    Result.isFailure(run) ? [`${raw.file}: ${text.hidden ? HIDDEN_PROBLEM : run.failure.message}`] : [],
  );
  const standalone = runs.flatMap(({ text, run }) =>
    Result.isSuccess(run) ? run.success.map((i) => ({ i, text })) : [],
  );
  const overrideTexts = new Map(standalone.map(({ i, text }) => [i.start, text] as const));
  const place = (i: Instance, t: Text): Ranked => ({
    start: i.start,
    end: i.end,
    hidden: t.hidden,
    event: render(calendar, raw.uid, t, i, instantToWall(zone, i.start), instantToWall(zone, i.end)),
  });
  return {
    events:
      base === undefined
        ? standalone.map(({ i, text }) => place(i, text))
        : expanded.success.map((i) => place(i, overrideTexts.get(i.start) ?? base)),
    problems: failures,
  };
};

// ---------- pure: order and search ----------

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** By start, end, title, then calendar and uid so the order is the same on every run. */
export const sortRanked = (xs: readonly Ranked[]): readonly Ranked[] =>
  [...xs].sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      compare(a.event.title, b.event.title) ||
      compare(a.event.calendar, b.event.calendar) ||
      compare(a.event.uid, b.event.uid),
  );

const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

/** Case-insensitive plain substring match over title, location and description. */
export const matchesQuery = (e: CalendarEvent, query: string): boolean => {
  const q = fold(query);
  return [e.title, e.location, e.description].some((f) => fold(f).includes(q));
};

/** C0 and C1 control characters (newline and tab included) and the Unicode line and paragraph separators. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Trimmed search text: not empty, not too long, no control characters. */
export const checkQuery = (raw: string): V<string> => {
  const q = raw.trim();
  return q === ""
    ? Result.fail(invalid("query must not be empty"))
    : q.length > MAX_QUERY_LENGTH
      ? Result.fail(invalid(`query is longer than ${MAX_QUERY_LENGTH} characters`))
      : CONTROL.test(q)
        ? Result.fail(invalid("query contains control characters"))
        : Result.succeed(q);
};

/** Default search window as range words: a year back to a year ahead of today. */
export const searchWindow = (now: Date, zone: string): string => {
  const today = DateTime.fromJSDate(now, { zone }).startOf("day");
  return `${today.minus({ days: SEARCH_PAST_DAYS }).toISODate()} ${today.plus({ days: SEARCH_FUTURE_DAYS }).toISODate()}`;
};

// ---------- effects ----------

const collect = (
  settings: Settings,
  calendar: string | undefined,
  range: V<{ readonly from: Date; readonly to: Date }>,
  keep: (r: Ranked) => boolean,
): Effect.Effect<EventsResult, InvalidInput> =>
  Effect.gen(function* () {
    const window = yield* Effect.fromResult(range);
    const refs: readonly CalendarRef[] = yield* Effect.fromResult(
      selectCalendars(settings.calendars, calendar),
    );
    const fromMs = window.from.getTime();
    const toMs = window.to.getTime();
    const perCalendar = yield* Effect.forEach(
      refs,
      (ref) =>
        Effect.map(readCalendar(ref.path), (read) => {
          const files = read.events.map((e) => renderFile(ref.name, e, fromMs, toMs, settings.timezone));
          return {
            ranked: files.flatMap((f) => f.events).filter(keep),
            problems: [...read.problems, ...files.flatMap((f) => f.problems)],
          };
        }),
      { concurrency: 4 },
    );
    return {
      events: sortRanked(perCalendar.flatMap((c) => c.ranked)).map((r) => r.event),
      problems: perCalendar.flatMap((c) => c.problems).sort(compare),
    };
  });

const all = (): boolean => true;

/** Events of one calendar (or all) in the range of days; default today and the next 7 days. */
export const listEvents = (
  settings: Settings,
  q: ListQuery,
  now: Date,
): Effect.Effect<EventsResult, InvalidInput> =>
  collect(settings, q.calendar, parseRange(q.range ?? "", now, settings.timezone), all);

/** Events intersecting the days from `start` up to (excluding) `end`: ISO dates, `today` or `tomorrow`. */
export const eventsInRange = (
  settings: Settings,
  q: RangeQuery,
  now: Date,
): Effect.Effect<EventsResult, InvalidInput> =>
  collect(settings, q.calendar, parseRange(`${q.start.trim()} ${q.end.trim()}`, now, settings.timezone), all);

/**
 * Occurrences whose title, location or description contain the text (no patterns), in the window.
 * Events with hidden details (CLASS not PUBLIC) never match: not even their placeholder title.
 */
export const searchEvents = (
  settings: Settings,
  q: SearchQuery,
  now: Date,
): Effect.Effect<EventsResult, InvalidInput> =>
  Effect.gen(function* () {
    const query = yield* Effect.fromResult(checkQuery(q.query));
    const words = q.range === undefined ? searchWindow(now, settings.timezone) : q.range;
    return yield* collect(
      settings,
      q.calendar,
      parseRange(words, now, settings.timezone),
      (r) => r.hidden !== true && matchesQuery(r.event, query),
    );
  });
