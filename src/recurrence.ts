import { Result } from "effect";
import { z } from "zod";
import { InvalidInput } from "./errors.js";

type V<A> = Result.Result<A, InvalidInput>;

// ---------- schema: invalid combinations are unrepresentable ----------

export const Weekday = z.enum([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);
export type Weekday = z.infer<typeof Weekday>;

/** 1st..4th or last. */
const Nth = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]);
const Interval = z.number().int().min(1).max(99).optional().describe("Every n-th period; default 1");

export const Recurrence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), interval: Interval }),
  z.object({
    kind: z.literal("weekly"),
    interval: Interval,
    weekdays: z.array(Weekday).min(1).describe("Must include the weekday of the first occurrence"),
  }),
  z.object({
    kind: z.literal("monthly_day"),
    interval: Interval,
    day: z.number().int().min(1).max(31).describe("Day of month; must equal the day of the first occurrence"),
  }),
  z.object({
    kind: z.literal("monthly_weekday"),
    interval: Interval,
    nth: Nth.describe("1-4, or -1 for the last"),
    weekday: Weekday,
  }),
  z.object({ kind: z.literal("yearly"), interval: Interval }),
]);
export type Recurrence = z.infer<typeof Recurrence>;

export const Ending = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never") }),
  z.object({ kind: z.literal("count"), count: z.number().int().min(1).max(1000) }),
  z.object({ kind: z.literal("until"), date: z.string().describe("YYYY-MM-DD, inclusive") }),
]);
export type Ending = z.infer<typeof Ending>;

/** `ending` only exists inside a recurrence. */
export const RecurrenceSpec = z.object({
  pattern: Recurrence,
  ending: Ending.optional().describe("Default: never"),
});
export type RecurrenceSpec = z.infer<typeof RecurrenceSpec>;

export interface RecurringEventParams {
  readonly summary: string;
  readonly date: string; // YYYY-MM-DD, first occurrence
  readonly startTime: string; // HH:MM
  readonly endTime: string; // HH:MM, later than startTime
  readonly recurrence: Recurrence;
  readonly ending?: Ending;
  readonly location?: string;
  readonly description?: string;
  readonly alarm?: string; // e.g. 15m, 2h, 1d
}

export interface NewEventWithRecurrence {
  readonly summary: string;
  readonly start: string; // YYYY-MM-DD HH:MM
  readonly end?: string; // HH:MM
  readonly location?: string;
  readonly description?: string;
  readonly alarm?: string;
  readonly recurrence: RecurrenceSpec;
}

// ---------- pure helpers ----------

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

/** Adapt unified tool input to the strict recurring-event shape. */
export const toRecurringParams = (p: NewEventWithRecurrence): V<RecurringEventParams> =>
  Result.gen(function* () {
    const s = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(p.start.trim());
    if (!s) return yield* Result.fail(invalid("with recurrence, start must be 'YYYY-MM-DD HH:MM'"));
    if (p.end === undefined) return yield* Result.fail(invalid("with recurrence, end ('HH:MM') is required"));
    const e = /^\d{2}:\d{2}$/.exec(p.end.trim());
    if (!e) return yield* Result.fail(invalid("with recurrence, end must be 'HH:MM'"));
    return {
      summary: p.summary,
      date: s[1]!,
      startTime: s[2]!,
      endTime: e[0],
      recurrence: p.recurrence.pattern,
      ending: p.recurrence.ending,
      location: p.location,
      description: p.description,
      alarm: p.alarm,
    };
  });

const BYDAY: Record<Weekday, string> = {
  monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH",
  friday: "FR", saturday: "SA", sunday: "SU",
};
const WEEKDAY_BY_UTC_DAY: readonly Weekday[] = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
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

const parseTime = (field: string, s: string): V<number> => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m
    ? Result.succeed(Number(m[1]) * 60 + Number(m[2]))
    : Result.fail(invalid(`${field} must be HH:MM (24h)`));
};

const compactDate = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, "");
const compactTime = (t: string): string => `${t.replace(":", "")}00`;

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
        "FREQ=WEEKLY", ...intervalPart(r.interval),
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

const endingParts = (e: Ending, until: Date | undefined): string[] => {
  switch (e.kind) {
    case "never":
      return [];
    case "count":
      return [`COUNT=${e.count}`];
    case "until":
      // floating UNTIL to match the floating DTSTART
      return until ? [`UNTIL=${compactDate(until)}T235959`] : [];
  }
};

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const escapeText = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const textField = (field: string, s: string | undefined): V<string | undefined> =>
  s === undefined ? Result.succeed(undefined)
  : CONTROL.test(s) ? Result.fail(invalid(`${field} contains control characters`))
  : Result.succeed(escapeText(s));

const alarmLines = (alarm: string | undefined): V<string[]> => {
  if (alarm === undefined) return Result.succeed([]);
  const m = /^(\d{1,4})([mhd])$/.exec(alarm.trim());
  if (!m) return Result.fail(invalid("alarm must look like 15m, 2h or 1d"));
  const trigger = m[2] === "d" ? `-P${m[1]}D` : `-PT${m[1]}${m[2]!.toUpperCase()}`;
  return Result.succeed(["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", `TRIGGER:${trigger}`, "END:VALARM"]);
};

/** Pure: uid and stamp are injected so the output is deterministic. */
export const buildRecurringIcs = (
  p: RecurringEventParams,
  uid: string,
  stamp: string, // YYYYMMDDTHHMMSSZ
): V<string> =>
  Result.gen(function* () {
    if (p.summary.trim() === "") return yield* Result.fail(invalid("summary must not be empty"));
    const date = yield* parseDate("date", p.date);
    const start = yield* parseTime("startTime", p.startTime);
    const end = yield* parseTime("endTime", p.endTime);
    if (end <= start) return yield* Result.fail(invalid("endTime must be later than startTime"));
    if (!matchesRule(p.recurrence, date))
      return yield* Result.fail(
        invalid(`date ${p.date} does not satisfy the recurrence rule (first occurrence must match)`),
      );

    const ending: Ending = p.ending ?? { kind: "never" };
    const until = ending.kind === "until" ? yield* parseDate("ending.date", ending.date) : undefined;
    if (until && until < date) return yield* Result.fail(invalid("ending.date is before date"));

    const summary = yield* textField("summary", p.summary);
    const location = yield* textField("location", p.location);
    const description = yield* textField("description", p.description);
    const alarm = yield* alarmLines(p.alarm);

    const day = compactDate(date);
    const rrule = [...ruleParts(p.recurrence), ...endingParts(ending, until)].join(";");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//mcp-khal//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${day}T${compactTime(p.startTime)}`,
      `DTEND:${day}T${compactTime(p.endTime)}`,
      `RRULE:${rrule}`,
      `SUMMARY:${summary}`,
      ...(location ? [`LOCATION:${location}`] : []),
      ...(description ? [`DESCRIPTION:${description}`] : []),
      ...alarm,
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    return lines.join("\r\n") + "\r\n";
  });
