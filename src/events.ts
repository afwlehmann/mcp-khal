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

/** RFC 5545 TEXT unescaping. */
const unescapeText = (s: string): string =>
  s.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

const textOf = (e: Event, name: string): string => unescapeText(prop(e, name)?.value.trim() ?? "");

const MAILTO = /^mailto:/i;

/** `Name <address>`, or whichever of the two exists. */
const person = (p: Prop): string => {
  const email = p.value.trim().replace(MAILTO, "");
  const name = param(p, "CN")?.trim() ?? "";
  return name !== "" && email !== "" ? `${name} <${email}>` : name !== "" ? name : email;
};

interface Text {
  readonly title: string;
  readonly location: string;
  readonly organizer: string;
  readonly attendees: string;
  readonly status: string;
  readonly description: string;
  readonly repeat: string;
}

/** The text of one VEVENT, with only its own recurrence rules (an exception has none). */
const textFields = (e: Event): Text => ({
  title: textOf(e, "SUMMARY"),
  location: textOf(e, "LOCATION"),
  organizer: (([o]) => (o === undefined ? "" : person(o)))(props(e, "ORGANIZER")),
  attendees: props(e, "ATTENDEE")
    .map(person)
    .filter((a) => a !== "")
    .join(", "),
  status: (prop(e, "STATUS")?.value.trim() ?? "").toUpperCase(),
  description: textOf(e, "DESCRIPTION"),
  repeat: repeatPattern(props(e, "RRULE").map((r) => r.value)),
});

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
  // an all-day end is exclusive (the next day at 00:00); khal shows the last day
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
  if (master === undefined) return problem("the file holds no main event");
  if (Result.isFailure(host)) return problem(host.failure.message);
  const zone = host.success;

  const expanded = occurrencesIn(raw.lines, fromMs, toMs, hostZone);
  if (Result.isFailure(expanded)) return problem(expanded.failure.message);

  const overrides = evs.filter((e) => !isMaster(e));
  const overrideTexts = new Map<number, Text>();
  const failures: string[] = [];
  for (const o of overrides) {
    const r = occurrencesIn(onlyOverride(raw.lines, o), fromMs, toMs, hostZone);
    if (Result.isFailure(r)) failures.push(`${raw.file}: ${r.failure.message}`);
    else for (const i of r.success) overrideTexts.set(i.start, textFields(o));
  }
  const base = textFields(master);
  return {
    events: expanded.success.map((i) => ({
      start: i.start,
      end: i.end,
      event: render(
        calendar,
        raw.uid,
        overrideTexts.get(i.start) ?? base,
        i,
        instantToWall(zone, i.start),
        instantToWall(zone, i.end),
      ),
    })),
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
  keep: (e: CalendarEvent) => boolean,
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
            ranked: files.flatMap((f) => f.events).filter((r) => keep(r.event)),
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

/** Occurrences whose title, location or description contain the text (no patterns), in the window. */
export const searchEvents = (
  settings: Settings,
  q: SearchQuery,
  now: Date,
): Effect.Effect<EventsResult, InvalidInput> =>
  Effect.gen(function* () {
    const query = yield* Effect.fromResult(checkQuery(q.query));
    const words = q.range === undefined ? searchWindow(now, settings.timezone) : q.range;
    return yield* collect(settings, q.calendar, parseRange(words, now, settings.timezone), (e) =>
      matchesQuery(e, query),
    );
  });
