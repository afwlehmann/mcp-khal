import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Calendars } from "./config.js";
import { createServer } from "./server.js";
import { type FakeKhal, fakeKhal, unfold } from "./testlib.js";

const textOf = (r: unknown): string =>
  ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

const connect = async (fake: FakeKhal, calendars: Calendars = {}): Promise<Client> => {
  const server = createServer(fake.settings({ calendars }), {
    uid: () => "fixed-uid",
    now: () => new Date("2026-11-02T10:00:00Z"),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
};

describe("MCP server (in process)", () => {
  let fake: FakeKhal;
  let client: Client;

  beforeAll(async () => {
    fake = await fakeKhal({ stdout: "work|2026-11-01|10:00|2026-11-01|11:00|Lunch|Cafe|notes\n" });
    client = await connect(fake, { work: { email: "me@work.com" } });
  });
  afterAll(async () => {
    await client.close();
    await fake.cleanup();
  });

  it("lists exactly the documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "events_in_range",
      "list_calendars",
      "list_events",
      "new_event",
      "search_events",
    ]);
  });

  it("tells agents to ask the user before the write tool, and only there", async () => {
    const { tools } = await client.listTools();
    const described = (name: string): string => tools.find((t) => t.name === name)?.description ?? "";
    expect(described("new_event")).toMatch(/WRITE OPERATION/);
    expect(described("new_event")).toMatch(/Ask the user for confirmation/);
    for (const name of ["list_calendars", "list_events", "events_in_range", "search_events"])
      expect(described(name)).not.toMatch(/WRITE OPERATION/);
  });

  it("list_calendars returns khal's output", async () => {
    const r = await client.callTool({ name: "list_calendars", arguments: {} });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toMatch(/Lunch/);
  });

  it("list_events returns parsed JSON", async () => {
    const r = await client.callTool({ name: "list_events", arguments: { range: "today", calendar: "work" } });
    const events = JSON.parse(textOf(r)) as { title: string; location: string }[];
    expect(events[0]?.title).toBe("Lunch");
    expect(events[0]?.location).toBe("Cafe");
  });

  it("events_in_range and search_events return parsed JSON", async () => {
    const range = await client.callTool({
      name: "events_in_range",
      arguments: { start: "2026-11-01 10:00", end: "2026-11-01 11:00" },
    });
    expect(JSON.parse(textOf(range)) as unknown[]).toHaveLength(1);
    const search = await client.callTool({ name: "search_events", arguments: { query: "lunch" } });
    expect(JSON.parse(textOf(search)) as unknown[]).toHaveLength(1);
  });

  it("new_event creates a plain event", async () => {
    const before = (await fake.calls()).length;
    const r = await client.callTool({
      name: "new_event",
      arguments: { calendar: "work", start: "tomorrow 10:00", end: "1h", summary: "Plain" },
    });
    expect(isError(r)).toBe(false);
    const calls = await fake.calls();
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["new", "-a", "work"]);
  });

  it("new_event invites attendees using the organizer from the settings, with injected uid and clock", async () => {
    const r = await client.callTool({
      name: "new_event",
      arguments: {
        calendar: "work",
        start: "2026-11-04 10:00",
        end: "11:00",
        summary: "Invite",
        attendees: ["you@x.com"],
      },
    });
    expect(isError(r)).toBe(false);
    const ics = unfold((await fake.imported()) ?? "");
    expect(ics).toMatch(/ORGANIZER:mailto:me@work\.com/);
    expect(ics).toMatch(/UID:fixed-uid@mcp-khal/);
    expect(ics).toMatch(/DTSTAMP:20261102T100000Z/);
  });

  it("reports invalid input as an error result, not a crash", async () => {
    const r = await client.callTool({ name: "list_events", arguments: { calendar: "-x" } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/^InvalidInput:/);
    const again = await client.callTool({ name: "list_calendars", arguments: {} });
    expect(isError(again)).toBe(false);
  });
});

describe("MCP server when khal fails", () => {
  it("returns the khal error as an error result", async () => {
    const failing = await fakeKhal({ stderr: "calendar exploded", exit: 1 });
    const client = await connect(failing);
    try {
      const r = await client.callTool({ name: "list_calendars", arguments: {} });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toMatch(/NonZeroExit: calendar exploded/);
    } finally {
      await client.close();
      await failing.cleanup();
    }
  });
});
