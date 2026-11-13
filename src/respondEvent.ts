import { Effect, Result } from "effect";
import { resolveAddress } from "./config.js";
import { editInstance, isoOf, occurrenceDates, type Scope, scopeOf } from "./editEvent.js";
import { InvalidInput, type KhalError } from "./errors.js";
import { type Event, events, isMaster, mapEvents, mapProps, props, restamp } from "./ics.js";
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
  /** `all` (default) or `instance`, which needs `date` */
  readonly scope?: Extract<Scope, "all" | "instance"> | undefined;
  readonly date?: string | undefined;
}

const isMine = (address: string, value: string): boolean =>
  value.toLowerCase() === `mailto:${address.toLowerCase()}`;

/** The user's ATTENDEE line with the new PARTSTAT (and no RSVP request any more). */
const answered = (params: string, partstat: string): string =>
  `${params.replace(/;(PARTSTAT|RSVP)=[^;:]*/gi, "")};PARTSTAT=${partstat}`;

/** The event with the user's answer; refused when the user is not among its attendees. */
const answer = (event: Event, address: string, response: Response, now: Date): V<Event> =>
  props(event, "ATTENDEE").some((p) => isMine(address, p.value))
    ? Result.succeed(
        restamp(
          mapProps(event, "ATTENDEE", (p, line) =>
            isMine(address, p.value) ? `ATTENDEE${answered(p.params, PARTSTAT[response])}:${p.value}` : line,
          ),
          now,
        ),
      )
    : fail(`${address} is not invited to this event (no ATTENDEE line with that address)`);

/**
 * Sets the user's participation status. `all`: the main event and every exception that lists the user;
 * `instance`: only the occurrence on `date` (an exception is written for it when there is none).
 */
export const respondLines = (
  lines: readonly string[],
  p: RespondParams,
  address: string,
  now: Date,
): V<string[]> =>
  Result.gen(function* () {
    const { scope, date } = yield* scopeOf(p);
    if (scope === "from_date") return yield* fail("scope must be 'all' or 'instance'");
    if (scope === "instance" && date !== undefined)
      return yield* editInstance(lines, date, (e) => answer(e, address, p.response, now));
    const master = events(lines).find(isMaster);
    if (master === undefined) return yield* fail("the file holds no main event");
    yield* answer(master, address, p.response, now);
    return mapEvents(lines, (e) => Result.getOrElse(answer(e, address, p.response, now), () => e));
  });

/** Answers an invitation in the calendar's vdir; no reply is sent to the organizer. */
export const respondToEvent = (
  settings: Settings,
  p: RespondParams,
  now: Date,
): Effect.Effect<string, KhalError> =>
  Effect.gen(function* () {
    const stored = yield* findEvent(settings, p.calendar, p.uid);
    const address = yield* Effect.fromResult(resolveAddress(settings.calendars, p.calendar));
    const { scope, date } = yield* Effect.fromResult(scopeOf(p));
    const uid = p.uid.trim();
    if (scope === "instance" && date !== undefined) {
      const iso = isoOf(date);
      if (!(yield* occurrenceDates(settings, p.calendar, uid, `${iso} 1d`)).includes(iso))
        return yield* Effect.fail(new InvalidInput({ message: `event ${uid} has no occurrence on ${iso}` }));
    }
    yield* writeEvent(stored.file, yield* Effect.fromResult(respondLines(stored.lines, p, address, now)));
    const what = scope === "instance" && date !== undefined ? `the occurrence on ${isoOf(date)} of ` : "";
    return `Marked ${address} as ${p.response} for ${what}event ${uid} in calendar ${p.calendar.trim()}. No reply was sent to the organizer.\n`;
  });
