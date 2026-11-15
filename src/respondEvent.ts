import { Effect, Result } from "effect";
import { resolveAddress } from "./config.js";
import { editInstance, isoOf, requireOccurrence, type Scope, scopeOf } from "./editEvent.js";
import { type AppError, InvalidInput } from "./errors.js";
import { type Event, events, isMaster, mapEvents, mapProps, prop, props } from "./ics.js";
import { checkFile, markEvent, normAddress, withoutMethod } from "./series.js";
import type { Settings } from "./settings.js";
import { findEvent, writeEvent } from "./vdir.js";

type V<A> = Result.Result<A, InvalidInput>;

const fail = (message: string): V<never> => Result.fail(new InvalidInput({ message }));

export type Response = "accepted" | "declined" | "tentative";

const PARTSTAT: Readonly<Record<Response, string>> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
};

export interface RespondParams {
  readonly calendar: string;
  readonly uid: string;
  readonly response: Response;
  /** `all` (default) or `instance`, which needs `date` (the host-zone day `list_events` shows) */
  readonly scope?: Extract<Scope, "all" | "instance"> | undefined;
  readonly date?: string | undefined;
}

/** Does this ATTENDEE value name the user? `mailto:` is ignored in any case, and so is the case of the address. */
const isMine = (address: string, value: string): boolean => normAddress(value) === normAddress(address);

/** The parameters of a property line (`;A=1;B="x;y"`) as separate `A=1` parts; a quoted value may hold `;`. */
const splitParams = (params: string): string[] => {
  if (params === "") return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of params.slice(1)) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  return [...parts, current];
};

/** The parameters with `name` set to `value` in place (added at the end when missing); the others stay as they are. */
export const withParam = (params: string, name: string, value: string): string => {
  const parts = splitParams(params);
  const named = (s: string): boolean => s.slice(0, Math.max(s.indexOf("="), 0)).toUpperCase() === name;
  const at = parts.findIndex(named);
  const set = `${name}=${value}`;
  const next = at < 0 ? [...parts, set] : parts.flatMap((s, i) => (i === at ? [set] : named(s) ? [] : [s]));
  return next.map((s) => `;${s}`).join("");
};

/**
 * The event with the user's answer: only their ATTENDEE line changes, and only its PARTSTAT (the
 * other parameters, RSVP included, stay as the organizer wrote them: RSVP is the organizer's
 * request for a reply, which this server does not send). SEQUENCE is the organizer's and stays;
 * DTSTAMP and LAST-MODIFIED are refreshed. Refused when the user is not among the attendees, or
 * when the event has no ORGANIZER (ATTENDEE lines without one are no group-scheduled event).
 */
const answer = (event: Event, p: RespondParams, address: string, now: Date): V<Event> => {
  const { response, uid } = p;
  if (!Object.hasOwn(PARTSTAT, response)) return fail("response must be accepted, declined or tentative");
  if (!props(event, "ATTENDEE").some((a) => isMine(address, a.value)))
    return fail(`${address} is not invited to event ${uid.trim()} (no ATTENDEE line with that address)`);
  if (prop(event, "ORGANIZER") === undefined)
    return fail(
      `event ${uid.trim()} has attendees but no ORGANIZER, so it is no invitation that can be answered; nothing was changed`,
    );
  return Result.succeed(
    markEvent(
      mapProps(event, "ATTENDEE", (a, line) =>
        isMine(address, a.value)
          ? `ATTENDEE${withParam(a.params, "PARTSTAT", PARTSTAT[response])}:${a.value}`
          : line,
      ),
      now,
      false,
    ),
  );
};

/**
 * Sets the user's participation status. `all`: the main event only (exceptions keep their own
 * answer); `instance`: only the occurrence on the host-zone day `date`, as an exception with the
 * attendee list of the series copied and only the user's PARTSTAT changed (the main event is not
 * touched). Stored files carry no METHOD.
 */
export const respondLines = (
  lines: readonly string[],
  p: RespondParams,
  address: string,
  now: Date,
  hostZone: string,
): V<string[]> =>
  Result.gen(function* () {
    yield* checkFile(lines);
    const { scope, date } = yield* scopeOf(p);
    if (scope === "from_date") return yield* fail("scope must be 'all' or 'instance'");
    if (scope === "instance" && date !== undefined)
      return withoutMethod(
        yield* editInstance(lines, date, (e) => answer(e, p, address, now), {
          hostZone,
          me: address,
        }),
      );
    const master = events(lines).find(isMaster);
    if (master === undefined) return yield* fail("the file holds no main event");
    const answered = yield* answer(master, p, address, now);
    return withoutMethod(mapEvents(lines, (e, main) => (main ? answered : e)));
  });

/** Answers an invitation in the calendar's vdir; no reply is sent to the organizer. */
export const respondToEvent = (
  settings: Settings,
  p: RespondParams,
  now: Date,
): Effect.Effect<string, AppError> =>
  Effect.gen(function* () {
    const stored = yield* findEvent(settings, p.calendar, p.uid);
    const address = yield* Effect.fromResult(resolveAddress(settings.calendars, p.calendar));
    const { scope, date } = yield* Effect.fromResult(scopeOf(p));
    const uid = p.uid.trim();
    if (scope === "instance" && date !== undefined) {
      yield* Effect.fromResult(requireOccurrence(stored.lines, uid, isoOf(date), settings.timezone));
    }
    yield* writeEvent(
      stored.file,
      yield* Effect.fromResult(respondLines(stored.lines, p, address, now, settings.timezone)),
    );
    const what = scope === "instance" && date !== undefined ? `the occurrence on ${isoOf(date)} of ` : "";
    return `Marked ${address} as ${p.response} for ${what}event ${uid} in calendar ${p.calendar.trim()}. No reply was sent to the organizer.\n`;
  });
