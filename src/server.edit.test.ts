import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { removeDir, runFail, tempDir, testSettings } from "./testlib.js";
import { writeEvent } from "./vdir.js";

const textOf = (r: unknown): string =>
  ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

const EVENT = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:u1",
  "SUMMARY:Standup",
  "DTSTART:20301016T090000",
  "DTEND:20301016T093000",
  "ORGANIZER:mailto:boss@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
  "RRULE:FREQ=DAILY",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("tools that change existing events (in process)", () => {
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = await tempDir();
    const vdir = join(dir, "work");
    await mkdir(vdir);
    await writeFile(join(vdir, "u1.ics"), `${EVENT}\r\n`);
    const server = createServer(
      testSettings({ calendars: { work: { path: vdir, email: "me@example.com" } } }),
      { uid: () => "fixed-uid", now: () => new Date("2030-01-01T10:00:00Z") },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });
  afterAll(async () => {
    await client.close();
    await removeDir(dir);
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: textOf(r), error: isError(r) };
  };
  const stored = () => readFile(join(dir, "work", "u1.ics"), "utf8");

  it("update_event changes the file in the calendar's vdir", async () => {
    const r = await call("update_event", { calendar: "work", uid: "u1", summary: "Sync" });
    expect(r.error, r.text).toBe(false);
    expect(await stored()).toContain("SUMMARY:Sync");
  });

  it("end_event_series reports problems as error results", async () => {
    const missing = await call("end_event_series", {
      calendar: "work",
      uid: "nope",
      last_date: "2030-10-19",
    });
    expect(missing.error).toBe(true);
    expect(missing.text).toMatch(/^InvalidInput: no event with uid 'nope'/);
    const badShape = await call("end_event_series", { calendar: "work", uid: "u1", last_date: "soon" });
    expect(badShape.error).toBe(true);
    expect(badShape.text).toMatch(/YYYY-MM-DD/);
    const notADate = await call("end_event_series", { calendar: "work", uid: "u1", last_date: "2030-02-31" });
    expect(notADate.error).toBe(true);
    expect(notADate.text).toMatch(/real date/);
  });

  it("respond_to_event answers an invitation, or reports why it cannot", async () => {
    const ok = await call("respond_to_event", { calendar: "work", uid: "u1", response: "declined" });
    expect(ok.error, ok.text).toBe(false);
    expect(await stored()).toContain("PARTSTAT=DECLINED:mailto:me@example.com");
    const missing = await call("respond_to_event", { calendar: "work", uid: "nope", response: "accepted" });
    expect(missing.error).toBe(true);
  });

  it("update_event reports a missing event as an error result", async () => {
    const r = await call("update_event", { calendar: "work", uid: "nope", summary: "x" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/^InvalidInput: no event with uid 'nope'/);
  });
});

describe("writeEvent", () => {
  it("fails with an I/O error, leaving nothing behind, when the directory is missing", async () => {
    const dir = await tempDir();
    try {
      expect((await runFail(writeEvent(join(dir, "missing", "x.ics"), ["A:1"])))._tag).toBe("IoError");
    } finally {
      await removeDir(dir);
    }
  });
});
