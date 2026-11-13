import { Effect, Result } from "effect";
import { InvalidInput, type KhalError } from "./errors.js";
import { events, isMaster, mapEvents, prop, setProp, touch } from "./ics.js";
import { titleWarning } from "./newEvent.js";
import { textField } from "./recurrence.js";
import type { Settings } from "./settings.js";
import { findEvent, writeEvent } from "./vdir.js";

type V<A> = Result.Result<A, InvalidInput>;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });
const fail = (message: string): V<never> => Result.fail(invalid(message));

export interface UpdateParams {
  readonly calendar: string;
  readonly uid: string;
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

interface Times {
  readonly date: string;
  readonly start: string;
  readonly end: string;
}

const parseTimes = (start: string, end: string): V<Times> => {
  const s = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(start.trim());
  const e = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(end.trim());
  if (!s) return fail("start must be YYYY-MM-DD HH:MM (24h)");
  if (!e) return fail("end must be HH:MM (24h), on the day of start");
  const [y, mo, d] = [Number(s[1]), Number(s[2]), Number(s[3])];
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d)
    return fail("start is not a real calendar date");
  if (`${e[1]}${e[2]}` <= `${s[4]}${s[5]}`) return fail("end must be after start");
  return Result.succeed({
    date: `${s[1]}${s[2]}${s[3]}`,
    start: `${s[4]}${s[5]}00`,
    end: `${e[1]}${e[2]}00`,
  });
};

/** A text change: `undefined` leaves the property alone, an empty string removes it. */
const textChange = (
  field: string,
  v: string | undefined,
  allowEmpty: boolean,
): V<string | null | undefined> => {
  if (v === undefined) return Result.succeed(undefined);
  if (v.trim() === "") return allowEmpty ? Result.succeed(null) : fail(`${field} must not be empty`);
  return textField(field, v);
};

/**
 * The file's lines with the main event changed. Only text and the time of the (first) occurrence can
 * change; a series keeps its rule. Moving a series that has exceptions is refused, because its
 * exceptions would no longer match.
 */
export const updateLines = (lines: readonly string[], p: UpdateParams, now: Date): V<string[]> =>
  Result.gen(function* () {
    const all = events(lines);
    const master = all.find(isMaster);
    if (master === undefined) return yield* fail("the file holds no main event to change");
    if ([p.summary, p.location, p.description, p.start, p.end].every((v) => v === undefined))
      return yield* fail("nothing to change: give summary, location, description, or start and end");
    if ((p.start === undefined) !== (p.end === undefined))
      return yield* fail("start and end must be given together");

    const summary = yield* textChange("summary", p.summary, false);
    const location = yield* textChange("location", p.location, true);
    const description = yield* textChange("description", p.description, true);

    const times =
      p.start !== undefined && p.end !== undefined ? yield* parseTimes(p.start, p.end) : undefined;
    const dtstart = prop(master, "DTSTART");
    if (times !== undefined) {
      if (dtstart === undefined) return yield* fail("the event has no DTSTART");
      if (/VALUE=DATE(;|$)/i.test(dtstart.params) || dtstart.value.length === 8)
        return yield* fail("all-day events cannot be moved: only events with a start time");
      if (all.length > 1 || prop(master, "EXDATE") !== undefined || prop(master, "RDATE") !== undefined)
        return yield* fail("a series with exceptions cannot be moved: its exceptions would no longer match");
    }

    const text = (e: readonly string[], name: string, v: string | null | undefined): readonly string[] =>
      v === undefined ? e : setProp(e, name, v === null ? undefined : `${name}:${v}`);
    const changed = (e: readonly string[]): readonly string[] => {
      const edited = text(
        text(text(e, "SUMMARY", summary), "LOCATION", location),
        "DESCRIPTION",
        description,
      );
      if (times === undefined || dtstart === undefined) return touch(edited, now);
      // the times are in the event's own zone: its TZID, UTC when it is stored in UTC, else floating
      const zone = /Z$/i.test(dtstart.value) ? "Z" : "";
      const moved = setProp(
        setProp(
          setProp(edited, "DTSTART", `DTSTART${dtstart.params}:${times.date}T${times.start}${zone}`),
          "DTEND",
          `DTEND${dtstart.params}:${times.date}T${times.end}${zone}`,
        ),
        "DURATION",
        undefined,
      );
      return touch(moved, now);
    };
    return mapEvents(lines, (e, main) => (main ? changed(e) : e));
  });

/** Changes an existing event in the calendar's vdir. */
export const updateEvent = (
  settings: Settings,
  p: UpdateParams,
  now: Date,
): Effect.Effect<string, KhalError> =>
  Effect.gen(function* () {
    const stored = yield* findEvent(settings, p.calendar, p.uid);
    const lines = yield* Effect.fromResult(updateLines(stored.lines, p, now));
    yield* writeEvent(stored.file, lines);
    const warning = p.summary === undefined ? undefined : titleWarning(p.summary);
    return `Updated event ${p.uid.trim()} in calendar ${p.calendar.trim()}.${warning === undefined ? "" : `\n${warning}`}\n`;
  });
