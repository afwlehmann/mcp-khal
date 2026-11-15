import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import { listCalendars } from "./calendars.js";
import { MAX_DESCRIPTION, MAX_TITLE, updateEvent } from "./editEvent.js";
import { endSeries } from "./endSeries.js";
import type { KhalError } from "./errors.js";
import { type EventsResult, eventsInRange, listEvents, searchEvents } from "./events.js";
import { newEvent } from "./newEvent.js";
import { MAX_ADDRESS, RecurrenceSpec } from "./recurrence.js";
import { respondToEvent } from "./respondEvent.js";
import type { Settings } from "./settings.js";
import { MAX_NAME } from "./vdir.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

/** Run an effect at the edge: failures become MCP error results, never exceptions. */
const respond = <A>(eff: Effect.Effect<A, KhalError>, render: (a: A) => string): Promise<ToolResult> =>
  Effect.runPromise(
    Effect.match(eff, {
      onFailure: (e) => text(`${e._tag}: ${e.message}`, true),
      onSuccess: (a) => text(render(a)),
    }),
  );

const plain = (s: string): string => s;

/** The events as JSON; files that could not be read follow as a list, never silently dropped. */
export const renderEvents = (r: EventsResult): string => {
  const events = JSON.stringify(r.events, null, 2);
  return r.problems.length === 0
    ? events
    : `${events}\n\nProblems (these files or events could not be used):\n${r.problems.map((p) => `- ${p}`).join("\n")}`;
};

/** Most attendees one invitation may have. */
export const MAX_ATTENDEES = 50;

const RANGE_WORDS = "Days are ISO dates 'YYYY-MM-DD', 'today' or 'tomorrow'; the end day is exclusive";

/** A calendar day as the tools take it; the pure functions check that it is a real date. */
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/** Sources of non-determinism, passed in so the server itself reads no global state. */
export interface ServerDeps {
  readonly uid: () => string;
  readonly now: () => Date;
}

export const createServer = (settings: Settings, deps: ServerDeps): McpServer => {
  const server = new McpServer({ name: "mcp-khal", version: "3.0.0" });

  server.tool("list_calendars", "List the configured calendars (names, sorted), one per line.", {}, () =>
    respond(
      Effect.map(Effect.fromResult(listCalendars(settings.calendars)), (refs) =>
        refs.map((r) => r.name).join("\n"),
      ),
      plain,
    ),
  );

  server.tool(
    "list_events",
    `List events in a range of days. \`range\` is a day word ('today', 'tomorrow' or 'YYYY-MM-DD'), optionally followed by a second day or a length such as '7d' (e.g. 'today 7d', '2026-11-01 2026-11-08'). ${RANGE_WORDS}. Omit it for today and the next 7 days. Times are in the server's local time zone. Each event has the fields calendar, startDate, startTime, endDate, endTime, title, location, organizer, attendees, uid, status, cancelled, allDay, repeatPattern and description. Returns JSON; files that could not be read are listed after it.`,
    { range: z.string().max(64).optional(), calendar: z.string().max(MAX_NAME).optional() },
    (p) => respond(listEvents(settings, p, deps.now()), renderEvents),
  );

  server.tool(
    "events_in_range",
    `List all events intersecting the days from \`start\` up to \`end\`. ${RANGE_WORDS}. Returns JSON; files that could not be read are listed after it.`,
    { start: z.string().max(32), end: z.string().max(32), calendar: z.string().max(MAX_NAME).optional() },
    (p) => respond(eventsInRange(settings, p, deps.now()), renderEvents),
  );

  server.tool(
    "search_events",
    "Search events by text (case-insensitive substring of title, location or description; no patterns). Searches a year back and a year ahead unless `range` is given (same words as list_events). Returns JSON; files that could not be read are listed after it.",
    {
      query: z.string().max(1000),
      calendar: z.string().max(MAX_NAME).optional(),
      range: z.string().max(64).optional(),
    },
    (p) => respond(searchEvents(settings, p, deps.now()), renderEvents),
  );

  server.tool(
    "new_event",
    "WRITE OPERATION: this changes the user's calendar. Ask the user for confirmation before calling it (show the summary, time, calendar and any attendees), and never invite attendees without their explicit approval. Create an event by writing a new .ics file into the calendar's directory (the calendar needs a `path` in the server's config). `start` and `end` are ISO: 'YYYY-MM-DD' for an all-day event (`end` is then the last day, inclusive) or 'YYYY-MM-DDTHH:MM' for a timed one; give either `end` or `duration` ('1h', '30m', '1h30m', '2d'), not both. Times are in `timezone` (an IANA name such as 'Europe/Berlin'), by default the server's local zone. With `recurrence` (a series, e.g. every 2nd Wednesday: {pattern:{kind:'monthly_weekday',nth:2,weekday:'wednesday'}}): `start` is the first occurrence and must satisfy the pattern. With `attendees`, an invite is created with ORGANIZER taken from the calendar's configured email (or `organizer`). If the summary contains '/', the result carries a warning: some CalDAV servers have synchronization problems with such titles; pass it on to the user.",
    {
      calendar: z
        .string()
        .max(MAX_NAME)
        .optional()
        .describe(
          "Calendar name (see list_calendars). Omit it to use the server's configured default calendar (or the only calendar)",
        ),
      start: z.string().max(64).describe("'YYYY-MM-DD' (all-day) or 'YYYY-MM-DDTHH:MM'"),
      end: z.string().max(64).optional().describe("Same form as start; excludes duration"),
      duration: z.string().max(32).optional().describe("'1h', '30m', '1h30m', '2d'; excludes end"),
      timezone: z
        .string()
        .max(64)
        .optional()
        .describe("IANA zone of a timed event; default: the server's zone"),
      summary: z.string().max(MAX_TITLE),
      location: z.string().max(MAX_TITLE).optional(),
      description: z.string().max(MAX_DESCRIPTION).optional(),
      alarm: z
        .string()
        .max(16)
        .optional()
        .describe(
          "Reminder before the start, e.g. '15m', '2h', '1d'. Omit it to get the reminder configured for the calendar (none if it has none); use 'none' for no reminder at all",
        ),
      recurrence: RecurrenceSpec.optional(),
      attendees: z
        .array(z.string().max(MAX_ADDRESS))
        .max(MAX_ATTENDEES)
        .optional()
        .describe(
          `Email addresses to invite (at most ${MAX_ATTENDEES}, each at most ${MAX_ADDRESS} characters)`,
        ),
      organizer: z
        .string()
        .max(MAX_ADDRESS)
        .optional()
        .describe(
          "Override the organizer address; default is the calendar's configured email (`mcp-khal setup`)",
        ),
    },
    ({ timezone, ...p }) =>
      respond(newEvent(settings, { ...p, zone: timezone }, deps.uid(), deps.now()), plain),
  );

  server.tool(
    "update_event",
    "WRITE OPERATION: this changes an existing event in the user's calendar and cannot be undone (the previous version is not kept). Ask the user for confirmation before calling it (show the event and exactly what changes). Edits the event's .ics file, so the calendar needs a `path` in the server's config. Identify the event by `calendar` and `uid` (both are in the output of the read tools). Only the given fields change: summary, location, description (empty string removes it), and the time via `start` ('YYYY-MM-DD HH:MM') together with `end` ('HH:MM' on the same day). For a recurring event choose with `scope` what changes: 'all' (default: the whole series, moving it too), 'instance' (only the occurrence on `date`; it may be moved to another day) or 'from_date' (the occurrence on `date` and all after it: the series is split, the old part ends before `date`, the rest is a new series with a new uid; only the time of day can change, not the date). `instance` and `from_date` need `date` ('YYYY-MM-DD') of an existing occurrence. The times are in the event's own time zone (UTC for an event stored in UTC). All-day events cannot be moved. A series with exceptions cannot be moved as a whole, and 'from_date' refuses a series with exceptions on or after `date`. Attendees are not changed and no invitation update is sent. If the new summary contains '/', the result carries a warning about CalDAV synchronization; pass it on to the user.",
    {
      calendar: z.string().max(MAX_NAME).describe("Calendar name (see list_calendars) the event is in"),
      uid: z.string().max(MAX_NAME).describe("The event's `uid` from the read tools"),
      scope: z
        .enum(["all", "instance", "from_date"])
        .optional()
        .describe(
          "Recurring events: 'all' (default), only the occurrence on `date`, or `date` and all after it",
        ),
      date: DAY.optional().describe("'YYYY-MM-DD' of the occurrence, for scope 'instance' and 'from_date'"),
      summary: z.string().max(MAX_TITLE).optional(),
      location: z.string().max(MAX_TITLE).optional(),
      description: z.string().max(MAX_DESCRIPTION).optional(),
      start: z.string().max(32).optional().describe("New start 'YYYY-MM-DD HH:MM'; needs `end`"),
      end: z.string().max(32).optional().describe("New end 'HH:MM' on the day of `start`; needs `start`"),
    },
    (p) => respond(updateEvent(settings, p, deps.uid(), deps.now()), plain),
  );

  server.tool(
    "end_event_series",
    "WRITE OPERATION: this ends a recurring event in the user's calendar: every occurrence after `last_date` disappears, and it cannot be undone (the previous version is not kept). Ask the user for confirmation before calling it (show the event and its new last day). Edits the event's .ics file, so the calendar needs a `path` in the server's config. Identify the event by `calendar` and `uid` (both are in the output of the read tools). `last_date` ('YYYY-MM-DD') is the last occurrence that stays; it must be an existing occurrence after the first one (use update_event to change a series, nothing here deletes a whole event). Exceptions after `last_date` are dropped; no cancellation is sent to attendees.",
    {
      calendar: z.string().max(MAX_NAME).describe("Calendar name (see list_calendars) the event is in"),
      uid: z.string().max(MAX_NAME).describe("The event's `uid` from the read tools"),
      last_date: DAY.describe("'YYYY-MM-DD' of the last occurrence that stays"),
    },
    (p) =>
      respond(
        endSeries(settings, { calendar: p.calendar, uid: p.uid, lastDate: p.last_date }, deps.now()),
        plain,
      ),
  );

  server.tool(
    "respond_to_event",
    "WRITE OPERATION: this changes the user's own participation status (accept, decline or tentative) on an invitation in their calendar and cannot be undone (the previous version is not kept). Ask the user for confirmation before calling it (show the event and the answer). Edits the event's .ics file, so the calendar needs a `path` in the server's config; the user's address is the calendar's configured `email`, which must be among the event's attendees. Identify the event by `calendar` and `uid` (both are in the output of the read tools). For a recurring event `scope` is 'all' (default) or 'instance' (only the occurrence on `date`, 'YYYY-MM-DD'). Nothing is sent to the organizer: they are not notified unless the user's sync or mail tooling does that, so tell the user so.",
    {
      calendar: z.string().max(MAX_NAME).describe("Calendar name (see list_calendars) the event is in"),
      uid: z.string().max(MAX_NAME).describe("The event's `uid` from the read tools"),
      response: z.enum(["accepted", "declined", "tentative"]),
      scope: z
        .enum(["all", "instance"])
        .optional()
        .describe("Recurring events: 'all' (default) or one occurrence"),
      date: DAY.optional().describe("'YYYY-MM-DD' of the occurrence, for scope 'instance'"),
    },
    (p) => respond(respondToEvent(settings, p, deps.now()), plain),
  );

  return server;
};
