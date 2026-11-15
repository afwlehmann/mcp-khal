import { Result } from "effect";
import { z } from "zod";
import { isEmail } from "./config.js";
import { InvalidInput } from "./errors.js";
import type { EventTimes } from "./range.js";
import { ianaZone, wallToInstant } from "./timezone.js";
import { type VTimezone, vtimezone } from "./vtimezone.js";

type V<A> = Result.Result<A, InvalidInput>;

// ---------- schema: invalid combinations are unrepresentable ----------

export const Weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
export type Weekday = z.infer<typeof Weekday>;

/** 1st..4th or last. */
const Nth = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]);
const Interval = z.number().int().min(1).max(99).optional().describe("Every n-th period; default 1");

// Every object is strict: a rule part the caller invents (BYMONTHDAY on a weekly rule, BYSETPOS,
// BYHOUR on an all-day event, ...) is an error, never silently dropped. The shapes below are the
// only ones that exist, and each of them is a combination RFC 5545 3.3.10 allows.
export const Recurrence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("daily"), interval: Interval }),
  z.strictObject({
    kind: z.literal("weekly"),
    interval: Interval,
    weekdays: z.array(Weekday).min(1).max(7).describe("Must include the weekday of the first occurrence"),
  }),
  z.strictObject({
    kind: z.literal("monthly_day"),
    interval: Interval,
    day: z.number().int().min(1).max(31).describe("Day of month; must equal the day of the first occurrence"),
  }),
  z.strictObject({
    kind: z.literal("monthly_weekday"),
    interval: Interval,
    nth: Nth.describe("1-4, or -1 for the last"),
    weekday: Weekday,
  }),
  z.strictObject({ kind: z.literal("yearly"), interval: Interval }),
]);
export type Recurrence = z.infer<typeof Recurrence>;

export const Ending = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("never") }),
  z.strictObject({ kind: z.literal("count"), count: z.number().int().min(1).max(1000) }),
  z.strictObject({ kind: z.literal("until"), date: z.string().max(32).describe("YYYY-MM-DD, inclusive") }),
]);
export type Ending = z.infer<typeof Ending>;

/** `ending` only exists inside a recurrence. */
export const RecurrenceSpec = z.strictObject({
  pattern: Recurrence,
  ending: Ending.optional().describe("Default: never"),
});
export type RecurrenceSpec = z.infer<typeof RecurrenceSpec>;

export interface IcsEventParams {
  readonly summary: string;
  /** start and end as parsed by `parseEventTimes` (all-day, or timed in an IANA zone) */
  readonly times: EventTimes;
  readonly recurrence?: Recurrence | undefined;
  readonly ending?: Ending | undefined;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  readonly alarm?: string | undefined; // e.g. 15m, 2h, 1d
  readonly organizer?: string | undefined; // required when attendees is non-empty
  readonly attendees?: readonly string[] | undefined;
}

// ---------- pure helpers ----------

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

const BYDAY: Record<Weekday, string> = {
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
  sunday: "SU",
};
const WEEKDAY_BY_UTC_DAY: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const parseDate = (field: string, s: string): V<Date> => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return Result.fail(invalid(`${field} must be YYYY-MM-DD`));
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    ? Result.succeed(date)
    : Result.fail(invalid(`${field} is not a real calendar date`));
};

const compactDate = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, "");
/** `2026-11-04` -> `20261104`, `2026-11-04T10:00:00` -> `20261104T100000` */
const compact = (s: string): string => s.replace(/[-:]/g, "");
const utcStamp = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** 1..4 counting from the start of the month. */
const nthFromStart = (d: Date): number => Math.ceil(d.getUTCDate() / 7);
const isLastOfWeekdayInMonth = (d: Date): boolean => {
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return d.getUTCDate() + 7 > daysInMonth;
};

/** Does the first occurrence satisfy the rule? (RFC 5545 leaves a mismatch ambiguous.) */
const matchesRule = (r: Recurrence, d: Date): boolean => {
  const weekday = WEEKDAY_BY_UTC_DAY[d.getUTCDay()]!;
  switch (r.kind) {
    case "daily":
    case "yearly":
      return true;
    case "weekly":
      return r.weekdays.includes(weekday);
    case "monthly_day":
      return d.getUTCDate() === r.day;
    case "monthly_weekday":
      return weekday === r.weekday && (r.nth === -1 ? isLastOfWeekdayInMonth(d) : nthFromStart(d) === r.nth);
  }
};

const intervalPart = (n: number | undefined): string[] => (n !== undefined && n > 1 ? [`INTERVAL=${n}`] : []);

const ruleParts = (r: Recurrence): string[] => {
  switch (r.kind) {
    case "daily":
      return ["FREQ=DAILY", ...intervalPart(r.interval)];
    case "weekly":
      return [
        "FREQ=WEEKLY",
        ...intervalPart(r.interval),
        `BYDAY=${[...new Set(r.weekdays)].map((w) => BYDAY[w]).join(",")}`,
      ];
    case "monthly_day":
      return ["FREQ=MONTHLY", ...intervalPart(r.interval), `BYMONTHDAY=${r.day}`];
    case "monthly_weekday":
      return ["FREQ=MONTHLY", ...intervalPart(r.interval), `BYDAY=${r.nth}${BYDAY[r.weekday]}`];
    case "yearly":
      return ["FREQ=YEARLY", ...intervalPart(r.interval)];
  }
};

const endingParts = (e: Ending, until: string | undefined): string[] => {
  switch (e.kind) {
    case "never":
      return [];
    case "count":
      return [`COUNT=${e.count}`];
    case "until":
      return until === undefined ? [] : [`UNTIL=${until}`];
  }
};

/**
 * UNTIL of a series, inclusive of the last day: a date for all-day events, else the end of that day
 * in the event's zone as a UTC time (RFC 5545 requires UTC when DTSTART has a time zone).
 */
const untilValue = (t: EventTimes, until: Date): V<string> =>
  t.allDay
    ? Result.succeed(compactDate(until))
    : Result.map(ianaZone(t.zone), (zone) =>
        utcStamp(
          wallToInstant(zone, {
            year: until.getUTCFullYear(),
            month: until.getUTCMonth() + 1,
            day: until.getUTCDate(),
            hour: 23,
            minute: 59,
            second: 59,
          }),
        ),
      );

const whenLines = (t: EventTimes, tz: VTimezone | undefined): string[] =>
  t.allDay
    ? [`DTSTART;VALUE=DATE:${compact(t.startDate)}`, `DTEND;VALUE=DATE:${compact(t.endDate)}`]
    : tz === undefined || tz.lines.length === 0
      ? [`DTSTART:${compact(t.start)}Z`, `DTEND:${compact(t.end)}Z`]
      : [`DTSTART;TZID=${tz.tzid}:${compact(t.start)}`, `DTEND;TZID=${tz.tzid}:${compact(t.end)}`];

// Anything an ICS parser may treat as a line break (CR, NEL, U+2028/2029 for Python's splitlines)
// or other control character. Only tab and LF survive; CRLF is normalised to LF before the check.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const escapeText = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

export const textField = (field: string, s: string | undefined): V<string | undefined> => {
  if (s === undefined) return Result.succeed(undefined);
  const normalised = s.replace(/\r\n/g, "\n");
  return CONTROL.test(normalised)
    ? Result.fail(invalid(`${field} contains control characters`))
    : Result.succeed(escapeText(normalised));
};

const alarmLines = (alarm: string | undefined): V<string[]> => {
  if (alarm === undefined) return Result.succeed([]);
  const m = /^(\d{1,4})([mhd])$/.exec(alarm.trim());
  if (!m) return Result.fail(invalid("alarm must look like 15m, 2h or 1d"));
  const trigger = m[2] === "d" ? `-P${m[1]}D` : `-PT${m[1]}${m[2]!.toUpperCase()}`;
  return Result.succeed([
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    `TRIGGER:${trigger}`,
    "END:VALARM",
  ]);
};

/** RFC 5545 line folding: at most 75 octets per line, continuations start with a space. */
export const fold = (line: string): string => {
  const { done, cur } = [...line].reduce(
    (acc, ch) => {
      const n = Buffer.byteLength(ch);
      const limit = acc.done.length === 0 ? 75 : 74;
      return acc.bytes + n > limit
        ? { done: [...acc.done, acc.cur], cur: ch, bytes: n }
        : { done: acc.done, cur: acc.cur + ch, bytes: acc.bytes + n };
    },
    { done: [] as string[], cur: "", bytes: 0 },
  );
  return [...done, cur].join("\r\n ");
};

/** Longest address accepted (RFC 5321 path limit). */
export const MAX_ADDRESS = 254;

/** Any control character (C0, DEL, C1 incl. U+0085) or U+2028/2029 would break the ICS line or inject a property. */
const ADDRESS_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** Characters that may not appear in a URI (RFC 3986) or that start a query or fragment of a mailto URI (RFC 6068). */
const ADDRESS_NOT_URI = /["\\^`{}|%?#]/;

/** A CAL-ADDRESS is a URI (RFC 5545 3.3.3): always `mailto:`, in the form of RFC 6047 2.3. */
const mailto = (field: string, s: string): V<string> =>
  s.length <= MAX_ADDRESS && !ADDRESS_CONTROL.test(s) && !ADDRESS_NOT_URI.test(s) && isEmail(s)
    ? Result.succeed(`mailto:${s}`)
    : Result.fail(invalid(`${field} ${JSON.stringify(s)} is not a valid email address`));

/** ORGANIZER + ATTENDEE lines; attendees without an organizer are rejected. */
const inviteLines = (organizer: string | undefined, attendees: readonly string[] | undefined): V<string[]> =>
  Result.gen(function* () {
    if (attendees === undefined || attendees.length === 0) return [];
    if (organizer === undefined) return yield* Result.fail(invalid("attendees require an organizer address"));
    const org = yield* mailto("organizer", organizer);
    const lower = (s: string): string => s.toLowerCase();
    const others = attendees.filter(
      (a, i, all) => lower(a) !== lower(organizer) && all.findIndex((b) => lower(b) === lower(a)) === i,
    );
    if (others.length === 0)
      return yield* Result.fail(invalid("attendees must include someone other than the organizer"));
    const att = yield* Result.all(others.map((a) => mailto("attendee", a)));
    return [
      `ORGANIZER:${org}`,
      ...att.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:${a}`),
    ];
  });

/**
 * A UID is written as is (it is TEXT, but never escaped), so it must be plain: letters, digits and
 * `._@-`, fewer than 255 octets, no `..`. That keeps it free of anything that needs escaping, of
 * line breaks and of path tricks (RFC 5545 3.8.4.7, RFC 7986 5.3).
 */
const UID_FORM = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._@-]{0,253}$/;

/** DTSTAMP is always a UTC date-time (RFC 5545 3.8.7.2). */
const STAMP_FORM = /^\d{8}T\d{6}Z$/;

/** Pure: uid and stamp are injected so the output is deterministic. */
export const buildIcs = (
  p: IcsEventParams,
  uid: string,
  stamp: string, // YYYYMMDDTHHMMSSZ
): V<string> =>
  Result.gen(function* () {
    if (!UID_FORM.test(uid))
      return yield* Result.fail(
        invalid("uid must be 1-254 characters of letters, digits and . _ @ - (no '..')"),
      );
    if (!STAMP_FORM.test(stamp))
      return yield* Result.fail(invalid("DTSTAMP must be a UTC time like 20261102T100000Z"));
    if (p.summary.trim() === "") return yield* Result.fail(invalid("summary must not be empty"));
    const t = p.times;
    const firstDay = t.allDay ? t.startDate : t.start.slice(0, 10);
    const date = yield* parseDate("date", firstDay);
    if (!t.allDay && t.endInstant.getTime() <= t.startInstant.getTime())
      return yield* Result.fail(invalid("end must be later than start"));
    if (p.recurrence !== undefined && !matchesRule(p.recurrence, date))
      return yield* Result.fail(
        invalid(`date ${firstDay} does not satisfy the recurrence rule (first occurrence must match)`),
      );

    const ending: Ending = p.ending ?? { kind: "never" };
    const until = ending.kind === "until" ? yield* parseDate("ending.date", ending.date) : undefined;
    if (until && until < date) return yield* Result.fail(invalid("ending.date is before date"));
    const untilText = until === undefined ? undefined : yield* untilValue(t, until);
    const tz = t.allDay ? undefined : yield* vtimezone(t.zone);

    const summary = yield* textField("summary", p.summary);
    const location = yield* textField("location", p.location);
    const description = yield* textField("description", p.description);
    const alarm = yield* alarmLines(p.alarm);
    const invite = yield* inviteLines(p.organizer, p.attendees);

    const rrule =
      p.recurrence === undefined
        ? []
        : [`RRULE:${[...ruleParts(p.recurrence), ...endingParts(ending, untilText)].join(";")}`];
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//mcp-khal//EN",
      ...(tz?.lines ?? []),
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      ...whenLines(t, tz),
      ...rrule,
      `SUMMARY:${summary}`,
      ...invite,
      ...(location ? [`LOCATION:${location}`] : []),
      ...(description ? [`DESCRIPTION:${description}`] : []),
      ...alarm,
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    return `${lines.map(fold).join("\r\n")}\r\n`;
  });
