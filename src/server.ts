import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { KhalError } from "./errors.js";
import { calendarsArgs, execute, listArgs, parseEvents, rangeArgs, searchArgs } from "./khal.js";
import { newEvent } from "./newEvent.js";
import { RecurrenceSpec } from "./recurrence.js";
import type { Settings } from "./settings.js";

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
const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** Sources of non-determinism, passed in so the server itself reads no global state. */
export interface ServerDeps {
  readonly uid: () => string;
  readonly now: () => Date;
}

export const createServer = (settings: Settings, deps: ServerDeps): McpServer => {
  const server = new McpServer({ name: "mcp-khal", version: "1.2.0" });

  server.tool("list_calendars", "List configured khal calendars.", {}, () =>
    respond(execute(settings, calendarsArgs()), plain),
  );

  server.tool(
    "list_events",
    "List events in a date range (khal syntax, e.g. 'today 7d', 'tomorrow', '2026-11-01 2026-11-07'). Returns JSON.",
    { range: z.string().optional(), calendar: z.string().optional() },
    (p) => respond(Effect.map(execute(settings, listArgs(p)), parseEvents), json),
  );

  server.tool(
    "events_in_range",
    "List all events intersecting a time range (khal decides overlap). start/end use khal syntax, e.g. '2026-10-28 10:00' and '2026-10-28 11:00'. Returns JSON.",
    { start: z.string(), end: z.string(), calendar: z.string().optional() },
    (p) => respond(Effect.map(execute(settings, rangeArgs(p)), parseEvents), json),
  );

  server.tool(
    "search_events",
    "Search events by text. Returns JSON.",
    { query: z.string(), calendar: z.string().optional() },
    (p) => respond(Effect.map(execute(settings, searchArgs(p)), parseEvents), json),
  );

  server.tool(
    "new_event",
    "WRITE OPERATION: this changes the user's calendar. Ask the user for confirmation before calling it (show the summary, time, calendar and any attendees), and never invite attendees without their explicit approval. Create an event. Without `recurrence`: start/end use khal syntax, e.g. start='2026-11-01 10:00', end='11:00' or '1h'; omit end for default duration. With `recurrence` (a series, e.g. every 2nd Wednesday: {pattern:{kind:'monthly_weekday',nth:2,weekday:'wednesday'}}): start must be 'YYYY-MM-DD HH:MM' (first occurrence, must satisfy the pattern) and end 'HH:MM' is required; times are local. With `attendees`, an ICS invite is created (same start/end format as recurrence) with ORGANIZER taken from the calendar->email mapping.",
    {
      calendar: z.string().optional(),
      start: z.string(),
      end: z.string().optional(),
      summary: z.string(),
      location: z.string().optional(),
      description: z.string().optional(),
      alarm: z
        .string()
        .optional()
        .describe(
          "Reminder before the start, e.g. '15m', '2h', '1d'. Omit it to get the default configured for the calendar (often none); use 'none' for no reminder at all",
        ),
      recurrence: RecurrenceSpec.optional(),
      attendees: z
        .array(z.string())
        .optional()
        .describe("Email addresses to invite; needs start 'YYYY-MM-DD HH:MM' and end 'HH:MM'"),
      organizer: z
        .string()
        .optional()
        .describe(
          "Override the organizer address; default comes from the calendar mapping (`mcp-khal setup`)",
        ),
    },
    (p) => respond(newEvent(settings, p, deps.uid(), deps.now()), plain),
  );

  return server;
};
