import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { resolveOrganizer } from "./config.js";
import { InvalidInput, type KhalError } from "./errors.js";
import { execute, importIcs, type NewParams, newArgs } from "./khal.js";
import { buildIcs, type RecurrenceSpec, toIcsParams } from "./recurrence.js";

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
 * uid and clock are injectable so tests can be deterministic.
 */
export const newEvent = (
  { recurrence, attendees = [], organizer, ...p }: NewEventInput,
  uid: string = randomUUID(),
  now: Date = new Date(),
): Effect.Effect<string, KhalError> => {
  const invited = attendees.length > 0;
  if (!invited && organizer !== undefined)
    return Effect.fail(new InvalidInput({ message: "organizer is only valid together with attendees" }));
  if (!invited && recurrence === undefined) return execute(newArgs(p));
  return Effect.gen(function* () {
    const from = invited ? yield* resolveOrganizer(p.calendar, organizer) : undefined;
    const params = yield* Effect.fromResult(toIcsParams({ ...p, recurrence, attendees, organizer: from }));
    const ics = yield* Effect.fromResult(buildIcs(params, `${uid}@mcp-khal`, timestamp(now)));
    return yield* importIcs(p.calendar, ics);
  });
};
