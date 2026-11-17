import { Effect, Result } from "effect";
import {
  type EditEnv,
  envOf,
  isoOf,
  requireMayRevise,
  requireOccurrence,
  ruleInstants,
} from "./editEvent.js";
import { type AppError, InvalidInput } from "./errors.js";
import { events, isMaster, mapEvents, type Prop, prop, setProp } from "./ics.js";
import {
  checkFile,
  compactDate,
  filterEntries,
  instantOf,
  markEvent,
  overrideTimes,
  parseWall,
  untilValue,
  withoutMethod,
  withUntil,
  zonesOf,
} from "./series.js";
import type { Settings } from "./settings.js";
import { ianaZone, wallFromUtcMs, wallToInstant } from "./timezone.js";
import { findEvent, writeEvent } from "./vdir.js";

type V<A> = Result.Result<A, InvalidInput>;

const fail = (message: string): V<never> => Result.fail(new InvalidInput({ message }));

export interface EndParams {
  readonly calendar: string;
  readonly uid: string;
  /** `YYYY-MM-DD` in the host zone, as `list_events` shows it: the last occurrence that stays */
  readonly lastDate: string;
}

/**
 * Ends a series after its occurrence on `lastDate` (a host-zone day): the rule gets an UNTIL that
 * is its last remaining instance, of the type DTSTART asks for (a DATE, UTC, or a floating time),
 * replacing a COUNT. Dates added by RDATE and excluded by EXDATE after the end go too, and so do
 * exceptions that belong after it, so the last occurrence shown is the last one there is. The
 * recurrence changes, so the organizer's SEQUENCE grows by one; somebody else's event is refused.
 * The first occurrence can be the last date, but nothing can end before it, because that would
 * remove the whole event.
 */
export const endSeriesLines = (
  lines: readonly string[],
  p: EndParams,
  now: Date,
  env: EditEnv,
): V<string[]> =>
  Result.gen(function* () {
    yield* checkFile(lines);
    const last = compactDate(p.lastDate);
    if (last === undefined) return yield* fail("last_date must be a real date, YYYY-MM-DD");
    const master = events(lines).find(isMaster);
    if (master === undefined) return yield* fail("the file holds no main event to change");
    const rule = prop(master, "RRULE");
    const dtstart = prop(master, "DTSTART");
    const form = dtstart === undefined ? undefined : parseWall(dtstart.value);
    if (rule === undefined || dtstart === undefined || form === undefined)
      return yield* fail("the event is not a recurring event");
    yield* requireMayRevise(master, env);

    const zones = yield* zonesOf(lines, env.hostZone);
    const zone = yield* zones.of(dtstart, dtstart.value);
    const host = yield* ianaZone(env.hostZone);
    const [y = 0, m = 1, d = 1] = isoOf(last).split("-").map(Number);
    // everything from the start of the next host-zone day on is after the end
    const cutoff = wallToInstant(host, wallFromUtcMs(Date.UTC(y, m - 1, d + 1)));
    // the rule's own last instance (UNTIL bounds the rule, not the dates RDATE adds)
    const instances = yield* ruleInstants(lines, env.hostZone, { to: cutoff });
    const latest = instances.at(-1);
    if (latest === undefined)
      return yield* fail(
        "last_date is before the series starts: ending it there would remove the whole event",
      );

    const beforeEnd = (listed: Prop, entry: string): boolean =>
      Result.getOrElse(
        Result.map(instantOf(zones, listed, entry.split("/")[0] ?? "", zone), (ms) => ms < cutoff),
        () => true,
      );
    const trimmed = filterEntries(filterEntries(master, "RDATE", beforeEnd), "EXDATE", beforeEnd);
    const until = untilValue(zones.host, dtstart, form, latest);
    const ended = markEvent(setProp(trimmed, "RRULE", `RRULE:${withUntil(rule.value, until)}`), now, true);
    const beyond = (e: readonly string[]): boolean =>
      Result.getOrElse(
        Result.map(overrideTimes(zones, e, zone), (t) => t.rid >= cutoff || t.start >= cutoff),
        () => false,
      );
    return withoutMethod(mapEvents(lines, (e, main) => (main ? ended : beyond(e) ? undefined : e)));
  });

/** Ends a recurring event after `lastDate`; the date has to be a real occurrence. */
export const endSeries = (settings: Settings, p: EndParams, now: Date): Effect.Effect<string, AppError> =>
  Effect.gen(function* () {
    const stored = yield* findEvent(settings, p.calendar, p.uid);
    const env = envOf(settings, p.calendar);
    const lines = yield* Effect.fromResult(endSeriesLines(stored.lines, p, now, env));
    const uid = p.uid.trim();
    const iso = isoOf(compactDate(p.lastDate) ?? "");
    yield* Effect.fromResult(requireOccurrence(stored.lines, uid, iso, env.hostZone));
    yield* writeEvent(stored.file, lines, stored.etag);
    return `Ended event ${uid} in calendar ${p.calendar.trim()}: its last occurrence is on ${iso}.\n`;
  });
