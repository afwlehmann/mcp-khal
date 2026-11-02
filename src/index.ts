#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import type { KhalError } from "./errors.js";
import {
  calendarsArgs, execute, importIcs, listArgs, newArgs, parseEvents, rangeArgs, searchArgs,
} from "./khal.js";
import { RecurrenceSpec, buildRecurringIcs, toRecurringParams } from "./recurrence.js";

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
const timestamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const server = new McpServer({ name: "mcp-khal", version: "1.0.0" });

server.tool("list_calendars", "List configured khal calendars.", {}, () =>
  respond(execute(calendarsArgs()), plain),
);

server.tool(
  "list_events",
  "List events in a date range (khal syntax, e.g. 'today 7d', 'tomorrow', '2026-11-01 2026-11-07'). Returns JSON.",
  { range: z.string().optional(), calendar: z.string().optional() },
  (p) => respond(Effect.map(execute(listArgs(p)), parseEvents), json),
);

server.tool(
  "events_in_range",
  "List all events intersecting a time range (khal decides overlap). start/end use khal syntax, e.g. '2026-10-28 10:00' and '2026-10-28 11:00'. Returns JSON.",
  { start: z.string(), end: z.string(), calendar: z.string().optional() },
  (p) => respond(Effect.map(execute(rangeArgs(p)), parseEvents), json),
);

server.tool(
  "search_events",
  "Search events by text. Returns JSON.",
  { query: z.string(), calendar: z.string().optional() },
  (p) => respond(Effect.map(execute(searchArgs(p)), parseEvents), json),
);

server.tool(
  "new_event",
  "Create an event. Without `recurrence`: start/end use khal syntax, e.g. start='2026-11-01 10:00', end='11:00' or '1h'; omit end for default duration. With `recurrence` (a series, e.g. every 2nd Wednesday: {pattern:{kind:'monthly_weekday',nth:2,weekday:'wednesday'}}): start must be 'YYYY-MM-DD HH:MM' (first occurrence, must satisfy the pattern) and end 'HH:MM' is required; times are local.",
  {
    calendar: z.string().optional(),
    start: z.string(),
    end: z.string().optional(),
    summary: z.string(),
    location: z.string().optional(),
    description: z.string().optional(),
    alarm: z.string().optional().describe("Alarm offset, e.g. '15m'"),
    recurrence: RecurrenceSpec.optional(),
  },
  ({ recurrence, ...p }) =>
    respond(
      recurrence === undefined
        ? execute(newArgs(p))
        : Effect.gen(function* () {
            const params = yield* Effect.fromResult(toRecurringParams({ ...p, recurrence }));
            const ics = yield* Effect.fromResult(
              buildRecurringIcs(params, `${randomUUID()}@mcp-khal`, timestamp()),
            );
            return yield* importIcs(p.calendar, ics);
          }),
      plain,
    ),
);

await server.connect(new StdioServerTransport());
