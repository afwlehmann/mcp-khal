import { Effect } from "effect";
import { resolveAddress, resolveAlarm, resolveCalendar } from "./config.js";
import { InvalidInput, type KhalError } from "./errors.js";
import { execute, importIcs, type NewParams, newArgs } from "./khal.js";
import { buildIcs, type RecurrenceSpec, toIcsParams } from "./recurrence.js";
import type { Settings } from "./settings.js";

export type NewEventInput = NewParams & {
  recurrence?: RecurrenceSpec | undefined;
  attendees?: readonly string[] | undefined;
  organizer?: string | undefined;
};

/** ICS DTSTAMP, e.g. 20261102T100000Z */
export const timestamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * Plain events go through `khal new`; series and invites are built as ICS and imported.
 * The uid and the clock are passed in, so this never reads global state.
 */
export const newEvent = (
  settings: Settings,
  { recurrence, attendees = [], organizer, ...p }: NewEventInput,
  uid: string,
  now: Date,
): Effect.Effect<string, KhalError> => {
  const invited = attendees.length > 0;
  if (!invited && organizer !== undefined)
    return Effect.fail(new InvalidInput({ message: "organizer is only valid together with attendees" }));
  // the calendar the call names, else the default calendar; khal's own default is never relied on
  const calendar = resolveCalendar(settings, p.calendar);
  if (calendar === undefined)
    return Effect.fail(
      new InvalidInput({
        message:
          'no calendar given and no default calendar is configured: pass "calendar" (see list_calendars) or set "defaultCalendar" in the config',
      }),
    );
  // an explicit alarm wins, then the calendar's own `alarm`; `none` or neither means no reminder
  const withAlarm = { ...p, calendar, alarm: resolveAlarm(settings, calendar, p.alarm) };
  if (!invited && recurrence === undefined) return execute(settings, newArgs(withAlarm));
  return Effect.gen(function* () {
    const from = invited
      ? yield* Effect.fromResult(resolveAddress(settings.calendars, calendar, organizer))
      : undefined;
    const params = yield* Effect.fromResult(
      toIcsParams({ ...withAlarm, recurrence, attendees, organizer: from }),
    );
    const ics = yield* Effect.fromResult(buildIcs(params, `${uid}@mcp-khal`, timestamp(now)));
    return yield* importIcs(settings, calendar, ics);
  });
};
