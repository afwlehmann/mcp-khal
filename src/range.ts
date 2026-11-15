import { Result } from "effect";
import { DateTime, IANAZone } from "luxon";
import { InvalidInput } from "./errors.js";

// Pure parsing of the time inputs of the tools: the range of `list_events` and the start / end /
// duration of `new_event`. Nothing is read here: the clock (`now`) and the host zone are parameters.
// Days are added as calendar days in the zone, never as 24 hours, so a DST change cannot shift them.

type V<A> = Result.Result<A, InvalidInput>;

const fail = (message: string): V<never> => Result.fail(new InvalidInput({ message }));

/** Longest range or duration in days. */
export const MAX_SPAN_DAYS = 3660;

/** Range used when none is given: today and the following days. */
export const DEFAULT_RANGE_DAYS = 7;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS = /^(\d{1,5})d$/;

const checkZone = (zone: string): V<string> =>
  IANAZone.isValidZone(zone) ? Result.succeed(zone) : fail(`'${zone}' is not an IANA time zone name`);

/** A strictly valid `YYYY-MM-DD` as the start of that day in the zone. */
const startOfDate = (iso: string, zone: string): V<DateTime> => {
  const t = DATE.test(iso) ? DateTime.fromISO(iso, { zone }) : undefined;
  return t?.isValid === true && t.toISODate() === iso
    ? Result.succeed(t.startOf("day"))
    : fail(`'${iso}' is not a date (YYYY-MM-DD)`);
};

/** A day word: `today`, `tomorrow` or an ISO date. */
const dayWord = (word: string, today: DateTime, zone: string): V<DateTime> =>
  word === "today"
    ? Result.succeed(today)
    : word === "tomorrow"
      ? Result.succeed(today.plus({ days: 1 }).startOf("day"))
      : startOfDate(word, zone);

export interface DateRange {
  /** first day, ISO date */
  readonly fromDate: string;
  /** day after the last day, ISO date (exclusive) */
  readonly toDate: string;
  /** start of `fromDate` in the zone */
  readonly from: Date;
  /** start of `toDate` in the zone (exclusive) */
  readonly to: Date;
  readonly zone: string;
}

const rangeOf = (from: DateTime, to: DateTime, zone: string): V<DateRange> => {
  const fromDate = from.toISODate();
  const toDate = to.toISODate();
  if (fromDate === null || toDate === null) return fail("the range is outside the supported dates");
  if (toDate <= fromDate)
    return fail(`the range must end after it starts (${fromDate} .. ${toDate}, end is exclusive)`);
  const days = Math.round(to.startOf("day").diff(from.startOf("day"), "days").days);
  return days > MAX_SPAN_DAYS
    ? fail(`the range is ${days} days long; at most ${MAX_SPAN_DAYS} days are allowed`)
    : Result.succeed({ fromDate, toDate, from: from.toJSDate(), to: to.toJSDate(), zone });
};

const HINT =
  "use '', 'today', 'tomorrow', 'YYYY-MM-DD', 'YYYY-MM-DD YYYY-MM-DD' (end exclusive) or '<today|tomorrow|YYYY-MM-DD> <n>d'";

/**
 * A range of days as ISO words, half-open `[fromDate, toDate)`:
 * `''` = today and the next 7 days; `today`, `tomorrow`, `2026-11-02` = that one day;
 * `2026-11-02 2026-11-09` = from the first up to (excluding) the second; `today 7d` = 7 days from today.
 */
export const parseRange = (input: string, now: Date, zone: string): V<DateRange> =>
  Result.flatMap(checkZone(zone), (z) => {
    const today = DateTime.fromJSDate(now, { zone: z }).startOf("day");
    const words = input
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "");
    const bad = (): V<never> => fail(`'${input.trim()}' is not a range: ${HINT}`);
    const [a, b, ...rest] = words;
    if (a === undefined) return rangeOf(today, today.plus({ days: DEFAULT_RANGE_DAYS }).startOf("day"), z);
    if (rest.length > 0) return bad();
    return Result.flatMap(
      Result.mapError(
        dayWord(a, today, z),
        () => new InvalidInput({ message: `'${input.trim()}' is not a range: ${HINT}` }),
      ),
      (from) => {
        if (b === undefined) return rangeOf(from, from.plus({ days: 1 }).startOf("day"), z);
        const n = DAYS.exec(b)?.[1];
        if (n !== undefined) {
          const count = Number(n);
          return count < 1
            ? fail(`'${b}' must be at least 1d`)
            : count > MAX_SPAN_DAYS
              ? fail(`'${b}' is too long; at most ${MAX_SPAN_DAYS}d are allowed`)
              : rangeOf(from, from.plus({ days: count }).startOf("day"), z);
        }
        return Result.flatMap(
          Result.mapError(
            dayWord(b, today, z),
            () => new InvalidInput({ message: `'${input.trim()}' is not a range: ${HINT}` }),
          ),
          (to) => rangeOf(from, to, z),
        );
      },
    );
  });

// ---------- new_event ----------

export type EventTimes =
  | {
      readonly allDay: true;
      /** first day, ISO date */
      readonly startDate: string;
      /** day after the last day, ISO date: what DTEND holds */
      readonly endDate: string;
    }
  | {
      readonly allDay: false;
      /** local wall-clock time in `zone`, `YYYY-MM-DDTHH:MM:SS` */
      readonly start: string;
      readonly end: string;
      readonly zone: string;
      readonly startInstant: Date;
      readonly endInstant: Date;
    };

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const LOCAL = "yyyy-MM-dd'T'HH:mm:ss";
const DURATION = /^(?:(\d{1,5})d)?(?:(\d{1,5})h)?(?:(\d{1,6})m)?$/;

/** `1h`, `30m`, `1h30m`, `2d`, `1d2h`: days, hours, minutes; at least one, not zero. */
export const parseDuration = (
  input: string,
): V<{ readonly days: number; readonly hours: number; readonly minutes: number }> => {
  const s = input.trim().toLowerCase();
  const m = s === "" ? null : DURATION.exec(s);
  if (m === null)
    return fail(`'${input.trim()}' is not a duration: use days, hours and minutes like 1h, 30m, 1h30m or 2d`);
  const d = { days: Number(m[1] ?? 0), hours: Number(m[2] ?? 0), minutes: Number(m[3] ?? 0) };
  if (d.days + d.hours + d.minutes === 0) return fail(`'${input.trim()}' is a duration of zero`);
  return d.days + d.hours / 24 + d.minutes / 1440 > MAX_SPAN_DAYS
    ? fail(`'${input.trim()}' is too long; at most ${MAX_SPAN_DAYS} days are allowed`)
    : Result.succeed(d);
};

/** A local date-time that exists in the zone (a DST gap is an error, not silently moved). */
const localTime = (iso: string, zone: string): V<DateTime> => {
  const t = DATETIME.test(iso) ? DateTime.fromISO(iso, { zone }) : undefined;
  if (t === undefined || !t.isValid)
    return fail(`'${iso}' is not a date-time (YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS)`);
  const wanted = iso.length === 16 ? `${iso}:00` : iso;
  return t.toFormat(LOCAL) === wanted
    ? Result.succeed(t)
    : fail(`'${iso}' does not exist in ${zone} (clock change)`);
};

const isDate = (s: string): boolean => DATE.test(s);

/**
 * Start, end and duration of a new event.
 * `start` is `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM[:SS]` (timed, in `zone`, else the host zone).
 * `end` has the same form as `start` and, for all-day events, is the last day (inclusive); the
 * result holds the exclusive day ICS needs. `end` and `duration` exclude each other. Defaults:
 * 1h for timed and 1 day for all-day events. An end before the start is an error.
 */
export const parseEventTimes = (
  input: {
    readonly start: string;
    readonly end?: string | undefined;
    readonly duration?: string | undefined;
    readonly zone?: string | undefined;
  },
  hostZone: string,
): V<EventTimes> => {
  const start = input.start.trim();
  const end = input.end?.trim() || undefined;
  const duration = input.duration?.trim() || undefined;
  if (end !== undefined && duration !== undefined) return fail("give either end or duration, not both");
  return Result.flatMap(checkZone(input.zone?.trim() || hostZone), (zone) =>
    isDate(start) ? allDay(start, end, duration, input.zone, zone) : timed(start, end, duration, zone),
  );
};

const allDay = (
  start: string,
  end: string | undefined,
  duration: string | undefined,
  givenZone: string | undefined,
  zone: string,
): V<EventTimes> => {
  if (givenZone?.trim()) return fail("zone only applies to events with a time; the start is a date");
  if (end !== undefined && !isDate(end))
    return fail(`start is a date, so end must be a date too (YYYY-MM-DD), got '${end}'`);
  return Result.flatMap(startOfDate(start, zone), (from) =>
    Result.flatMap(
      end !== undefined
        ? Result.flatMap(startOfDate(end, zone), (last) =>
            last < from
              ? fail(`end ${end} is before start ${start}`)
              : Result.succeed(last.plus({ days: 1 }).startOf("day")),
          )
        : duration !== undefined
          ? Result.flatMap(parseDuration(duration), (d) =>
              d.hours + d.minutes > 0
                ? fail(`an all-day event lasts whole days (like 2d), got '${duration}'`)
                : Result.succeed(from.plus({ days: d.days }).startOf("day")),
            )
          : Result.succeed(from.plus({ days: 1 }).startOf("day")),
      (to) => {
        const startDate = from.toISODate();
        const endDate = to.toISODate();
        return startDate === null || endDate === null || !DATE.test(endDate)
          ? fail("the event is outside the supported dates")
          : Math.round(to.diff(from, "days").days) > MAX_SPAN_DAYS
            ? fail(`the event is longer than ${MAX_SPAN_DAYS} days`)
            : Result.succeed<EventTimes>({ allDay: true, startDate, endDate });
      },
    ),
  );
};

const timed = (
  start: string,
  end: string | undefined,
  duration: string | undefined,
  zone: string,
): V<EventTimes> => {
  if (end !== undefined && !DATETIME.test(end))
    return fail(`start has a time, so end must have one too (YYYY-MM-DDTHH:MM), got '${end}'`);
  return Result.flatMap(localTime(start, zone), (from) =>
    Result.flatMap(
      end !== undefined
        ? Result.flatMap(localTime(end, zone), (to) =>
            to < from ? fail(`end ${end} is before start ${start}`) : Result.succeed(to),
          )
        : Result.map(
            duration === undefined
              ? Result.succeed({ days: 0, hours: 1, minutes: 0 })
              : parseDuration(duration),
            (d) => from.plus({ days: d.days }).plus({ hours: d.hours, minutes: d.minutes }),
          ),
      (to) =>
        Result.succeed<EventTimes>({
          allDay: false,
          start: from.toFormat(LOCAL),
          end: to.toFormat(LOCAL),
          zone,
          startInstant: from.toJSDate(),
          endInstant: to.toJSDate(),
        }),
    ),
  );
};
