import { Effect, Result } from "effect";
import { isoOf, occurrenceDates } from "./editEvent.js";
import { InvalidInput, type KhalError } from "./errors.js";
import { events, isMaster, mapEvents, prop, setProp, touch } from "./ics.js";
import { compactDate, dateMs, dayOf, formatWall, parseWall, untilBefore, withUntil } from "./series.js";
import type { Settings } from "./settings.js";
import { findEvent, writeEvent } from "./vdir.js";

type V<A> = Result.Result<A, InvalidInput>;

const fail = (message: string): V<never> => Result.fail(new InvalidInput({ message }));

export interface EndParams {
  readonly calendar: string;
  readonly uid: string;
  /** `YYYY-MM-DD`: the last occurrence that stays */
  readonly lastDate: string;
}

const exceptionDate = (lines: readonly string[]): string =>
  prop(lines, "RECURRENCE-ID")?.value.slice(0, 8) ?? "";

/**
 * Ends a series after its occurrence on `lastDate`: the rule gets an UNTIL just before the next day
 * (replacing a COUNT), and exceptions after `lastDate` are dropped. The first occurrence cannot be
 * the last date, because that would remove the whole event.
 */
export const endSeriesLines = (lines: readonly string[], p: EndParams, now: Date): V<string[]> =>
  Result.gen(function* () {
    const last = compactDate(p.lastDate);
    if (last === undefined) return yield* fail("last_date must be a real date, YYYY-MM-DD");
    const master = events(lines).find(isMaster);
    if (master === undefined) return yield* fail("the file holds no main event to change");
    const rule = prop(master, "RRULE");
    const dtstart = prop(master, "DTSTART");
    const start = dtstart === undefined ? undefined : parseWall(dtstart.value);
    if (rule === undefined || dtstart === undefined || start === undefined)
      return yield* fail("the event is not a recurring event");
    if (dateMs(last) < dayOf(start))
      return yield* fail(
        "last_date is before the series starts: ending it there would remove the whole event",
      );
    const next = formatWall({ ms: dateMs(last) + 86_400_000, hasTime: false, utc: false });
    const until = yield* untilBefore(dtstart, next);
    const ended = touch(setProp(master, "RRULE", `RRULE:${withUntil(rule.value, until)}`), now);
    return mapEvents(lines, (e, main) => (main ? ended : exceptionDate(e) > last ? undefined : e));
  });

/** Ends a recurring event after `lastDate`; the date has to be an occurrence khal lists. */
export const endSeries = (settings: Settings, p: EndParams, now: Date): Effect.Effect<string, KhalError> =>
  Effect.gen(function* () {
    const stored = yield* findEvent(settings, p.calendar, p.uid);
    const lines = yield* Effect.fromResult(endSeriesLines(stored.lines, p, now));
    const uid = p.uid.trim();
    const iso = isoOf(compactDate(p.lastDate) ?? "");
    if (!(yield* occurrenceDates(settings, p.calendar, uid, `${iso} 1d`)).includes(iso))
      return yield* Effect.fail(new InvalidInput({ message: `event ${uid} has no occurrence on ${iso}` }));
    yield* writeEvent(stored.file, lines);
    return `Ended event ${uid} in calendar ${p.calendar.trim()}: its last occurrence is on ${iso}.\n`;
  });
