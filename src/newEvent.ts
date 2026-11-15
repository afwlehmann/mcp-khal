import { Effect } from "effect";
import { resolveAddress, resolveAlarm, resolveCalendar } from "./config.js";
import { InvalidInput, type KhalError } from "./errors.js";
import { stamp, unfoldLines } from "./ics.js";
import { parseEventTimes } from "./range.js";
import { buildIcs, type RecurrenceSpec } from "./recurrence.js";
import type { Settings } from "./settings.js";
import { createEvent, newFileIn, vdirOf } from "./vdir.js";

export interface NewEventInput {
  readonly calendar?: string | undefined;
  /** `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM[:SS]` (timed) */
  readonly start: string;
  /** same form as `start`; for all-day events the last day (inclusive) */
  readonly end?: string | undefined;
  /** `1h`, `30m`, `1h30m`, `2d`; excludes `end` */
  readonly duration?: string | undefined;
  /** IANA zone of a timed event; the host zone when unset */
  readonly zone?: string | undefined;
  readonly summary: string;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  readonly alarm?: string | undefined;
  readonly recurrence?: RecurrenceSpec | undefined;
  readonly attendees?: readonly string[] | undefined;
  readonly organizer?: string | undefined;
}

/** ICS DTSTAMP, e.g. 20261102T100000Z */
export const timestamp = stamp;

/** Advice for the calling agent when a title contains "/", else undefined. */
export const titleWarning = (summary: string): string | undefined =>
  summary.includes("/")
    ? 'WARNING: the title contains "/". Some CalDAV servers have synchronization problems with such titles. The event was created; tell the user, and suggest a title without "/" (e.g. "-" or "and") if sync trouble appears.'
    : undefined;

/**
 * Builds the event as ICS and writes it as a new file `<uid>.ics` into the calendar's vdir. The uid and the clock are passed in, so this never reads global state; the host
 * zone comes from the settings. A successful result names the uid and carries a warning for the
 * agent when the title contains "/".
 */
export const newEvent = (
  settings: Settings,
  input: NewEventInput,
  uid: string,
  now: Date,
): Effect.Effect<string, KhalError> => {
  const warning = titleWarning(input.summary);
  return Effect.map(create(settings, input, uid, now), (out) =>
    warning === undefined ? out : `${out}\n${warning}`,
  );
};

const create = (
  settings: Settings,
  { recurrence, attendees = [], organizer, calendar: named, start, end, duration, zone, ...p }: NewEventInput,
  uid: string,
  now: Date,
): Effect.Effect<string, KhalError> => {
  const invited = attendees.length > 0;
  if (!invited && organizer !== undefined)
    return Effect.fail(new InvalidInput({ message: "organizer is only valid together with attendees" }));
  // the calendar the call names, else the default calendar; there is no other default
  const calendar = resolveCalendar(settings, named);
  if (calendar === undefined)
    return Effect.fail(
      new InvalidInput({
        message:
          'no calendar given and no default calendar is configured: pass "calendar" (see list_calendars) or set "defaultCalendar" in the config',
      }),
    );
  return Effect.gen(function* () {
    const dir = vdirOf(settings, calendar);
    if (typeof dir !== "string") return yield* Effect.fail(dir);
    const fullUid = `${uid}@mcp-khal`;
    const file = newFileIn(dir, `${fullUid}.ics`);
    if (typeof file !== "string") return yield* Effect.fail(file);
    const times = yield* Effect.fromResult(
      parseEventTimes({ start, end, duration, zone }, settings.timezone),
    );
    const from = invited
      ? yield* Effect.fromResult(resolveAddress(settings.calendars, calendar, organizer))
      : undefined;
    // an explicit alarm wins, then the calendar's own `alarm`; `none` or neither means no reminder
    const ics = yield* Effect.fromResult(
      buildIcs(
        {
          summary: p.summary,
          times,
          recurrence: recurrence?.pattern,
          ending: recurrence?.ending,
          location: p.location,
          description: p.description,
          alarm: resolveAlarm(settings, calendar, p.alarm),
          organizer: from,
          attendees: attendees.map((a) => a.trim()),
        },
        fullUid,
        timestamp(now),
      ),
    );
    yield* createEvent(file, unfoldLines(ics));
    return `Created event '${p.summary.trim()}' (uid ${fullUid}) in calendar '${calendar}'.`;
  });
};
