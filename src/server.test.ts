import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CalendarConfig, Calendars } from "./config.js";
import { createServer, MAX_ATTENDEES, renderEvents } from "./server.js";
import { removeDir, tempDir, testSettings, unfold } from "./testlib.js";

const textOf = (r: unknown): string =>
  ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

const connect = async (calendars: Calendars): Promise<Client> => {
  const server = createServer(testSettings({ calendars }), {
    uid: () => "fixed-uid",
    now: () => new Date("2026-11-02T10:00:00Z"),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
};

const LUNCH = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:uid-1",
  "DTSTAMP:20261101T000000Z",
  "DTSTART;TZID=Europe/Berlin:20261103T100000",
  "DTEND;TZID=Europe/Berlin:20261103T110000",
  "SUMMARY:Lunch",
  "LOCATION:Cafe",
  "ATTENDEE;CN=Bob:mailto:bob@x.org",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("MCP server (in process)", () => {
  let dir: string;
  let work: string;
  let client: Client;

  beforeAll(async () => {
    dir = await tempDir();
    work = join(dir, "work");
    await mkdir(work);
    await mkdir(join(dir, "home"));
    await writeFile(join(work, "uid-1.ics"), LUNCH);
    await writeFile(join(work, "broken.ics"), "this is not a calendar");
    client = await connect({
      work: { email: "me@work.com", path: work },
      home: { path: join(dir, "home") },
    });
  });
  afterAll(async () => {
    await client.close();
    await removeDir(dir);
  });

  it("lists exactly the documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "end_event_series",
      "events_in_range",
      "list_calendars",
      "list_events",
      "new_event",
      "respond_to_event",
      "search_events",
      "update_event",
    ]);
  });

  it("tells agents to ask the user before the write tool, and only there", async () => {
    const { tools } = await client.listTools();
    const described = (name: string): string => tools.find((t) => t.name === name)?.description ?? "";
    expect(described("new_event")).toMatch(/WRITE OPERATION/);
    expect(described("new_event")).toMatch(/Ask the user for confirmation/);
    for (const name of ["update_event", "end_event_series", "respond_to_event"]) {
      expect(described(name)).toMatch(/WRITE OPERATION/);
      expect(described(name)).toMatch(/cannot be undone/);
      expect(described(name)).toMatch(/Ask the user for confirmation/);
    }
    for (const name of ["list_calendars", "list_events", "events_in_range", "search_events"]) {
      expect(described(name)).not.toMatch(/WRITE OPERATION/);
      expect(described(name)).not.toMatch(/khal/);
    }
  });

  it("list_calendars returns the sorted names", async () => {
    const r = await client.callTool({ name: "list_calendars", arguments: {} });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toBe("home\nwork");
  });

  it("list_events returns JSON and lists unreadable files after it", async () => {
    const r = await client.callTool({
      name: "list_events",
      arguments: { range: "2026-11-01 2026-11-08", calendar: "work" },
    });
    const [json, problems] = textOf(r).split("\n\nProblems");
    const events = JSON.parse(json ?? "") as { title: string; location: string; startTime: string }[];
    expect(events.map((e) => e.title)).toEqual(["Lunch"]);
    expect(events[0]?.location).toBe("Cafe");
    expect(events[0]?.startTime).toBe("10:00");
    expect(problems).toMatch(/broken\.ics/);
  });

  it("events_in_range and search_events return JSON", async () => {
    const range = await client.callTool({
      name: "events_in_range",
      arguments: { start: "2026-11-03", end: "2026-11-04", calendar: "work" },
    });
    expect(textOf(range)).toMatch(/Lunch/);
    const search = await client.callTool({
      name: "search_events",
      arguments: { query: "LUNCH", calendar: "work" },
    });
    expect(textOf(search)).toMatch(/Lunch/);
    const none = await client.callTool({
      name: "search_events",
      arguments: { query: "nothing like this", calendar: "work", range: "2026-11-01 2026-11-08" },
    });
    expect(JSON.parse(textOf(none).split("\n\nProblems")[0] ?? "") as unknown[]).toEqual([]);
  });

  it("new_event writes an ics file into the calendar's directory, with injected uid and clock", async () => {
    const r = await client.callTool({
      name: "new_event",
      arguments: {
        calendar: "home",
        start: "2026-11-04T10:00",
        duration: "1h",
        timezone: "Europe/Berlin",
        summary: "Invite / Plain",
        attendees: ["you@x.com"],
        organizer: "me@x.com",
      },
    });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toMatch(/WARNING/);
    const files = await readdir(join(dir, "home"));
    expect(files).toEqual(["fixed-uid@mcp-khal.ics"]);
    const ics = unfold(await readFile(join(dir, "home", "fixed-uid@mcp-khal.ics"), "utf8"));
    expect(ics).toMatch(/ORGANIZER:mailto:me@x\.com/);
    expect(ics).toMatch(/DTSTART;TZID=Europe\/Berlin:20261104T100000/);
    expect(ics).toMatch(/DTSTAMP:20261102T100000Z/);
  });

  it("mentions khal in no tool description and no argument description", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      // the product name `mcp-khal` is fine; the khal program is not mentioned any more
      expect(t.description ?? "").not.toMatch(/(?<![\w-])khal(?![\w-])/i);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/(?<![\w-])khal(?![\w-])/i);
    }
    const respond = tools.find((t) => t.name === "respond_to_event")?.description ?? "";
    expect(respond).toMatch(/Nothing is sent to the organizer/);
  });

  it("describes the ISO range grammar and the structured event fields", async () => {
    const { tools } = await client.listTools();
    const described = (name: string): string => tools.find((t) => t.name === name)?.description ?? "";
    expect(described("list_events")).toMatch(/YYYY-MM-DD/);
    expect(described("list_events")).toMatch(/7d/);
    expect(described("list_events")).toMatch(/startTime/);
    expect(described("events_in_range")).toMatch(/exclusive/);
    expect(described("new_event")).toMatch(/YYYY-MM-DDTHH:MM/);
  });

  it("rejects more attendees than allowed, over-long addresses and over-long strings", async () => {
    const base = { calendar: "home", start: "2026-11-04T10:00", duration: "1h", summary: "X" };
    const attempt = async (extra: Record<string, unknown>) => {
      const r = await client.callTool({ name: "new_event", arguments: { ...base, ...extra } });
      return isError(r);
    };
    const many = Array.from({ length: MAX_ATTENDEES + 1 }, (_, i) => `a${i}@x.com`);
    expect(await attempt({ attendees: many, organizer: "me@x.com" })).toBe(true);
    expect(await attempt({ attendees: [`${"a".repeat(250)}@x.com`], organizer: "me@x.com" })).toBe(true);
    expect(await attempt({ attendees: ["a@x.com"], organizer: `${"a".repeat(250)}@x.com` })).toBe(true);
    expect(await attempt({ alarm: "1".repeat(40) })).toBe(true);
    expect(await attempt({ calendar: "h".repeat(300) })).toBe(true);
    expect(await readdir(join(dir, "home"))).not.toContain("fixed-uid@mcp-khal.ics.tmp");
  });

  it("rejects a control character in an attendee address as an error result", async () => {
    const r = await client.callTool({
      name: "new_event",
      arguments: {
        calendar: "home",
        start: "2026-11-05T10:00",
        duration: "1h",
        summary: "Y",
        organizer: "me@x.com",
        attendees: ["a@x.com\u0085ATTENDEE:mailto:v@corp.com"],
      },
    });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/^InvalidInput:.*not a valid email address/);
  });

  it("reports invalid input as an error result, not a crash", async () => {
    const r = await client.callTool({ name: "list_events", arguments: { calendar: "-x" } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/^InvalidInput:/);
    const bad = await client.callTool({ name: "list_events", arguments: { range: "next week" } });
    expect(isError(bad)).toBe(true);
    const again = await client.callTool({ name: "list_calendars", arguments: {} });
    expect(isError(again)).toBe(false);
  });
});

describe("MCP server without a calendar path", () => {
  it("list_calendars names the calendar missing its path", async () => {
    const client = await connect({ work: {} as CalendarConfig });
    try {
      const r = await client.callTool({ name: "list_calendars", arguments: {} });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toMatch(/calendar 'work' has no path configured/);
    } finally {
      await client.close();
    }
  });
});

describe("renderEvents", () => {
  it("is plain JSON without problems and appends them otherwise", () => {
    expect(renderEvents({ events: [], problems: [] })).toBe("[]");
    expect(renderEvents({ events: [], problems: ["a.ics: bad"] })).toBe(
      "[]\n\nProblems (these files or events could not be used):\n- a.ics: bad",
    );
  });
});
