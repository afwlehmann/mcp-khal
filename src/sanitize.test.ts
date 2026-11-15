import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_DESCRIPTION, MAX_TITLE, scopeOf, updateEvent, updateLines } from "./editEvent.js";
import { createServer } from "./server.js";
import { failure, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "./testlib.js";
import { createEvent, findEvent, MAX_FILE_BYTES, MAX_NAME, newFileIn, vdirOf } from "./vdir.js";

const NOW = new Date("2030-01-01T10:00:00Z");

const EVENT = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:u1",
  "SUMMARY:Standup",
  "DTSTART:20301016T090000",
  "DTEND:20301016T093000",
  "RRULE:FREQ=DAILY",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("names and files", () => {
  it("accepts only plain file names for new files", () => {
    expect(newFileIn("/v", "abc-1@mcp-khal.ics")).toBe("/v/abc-1@mcp-khal.ics");
    for (const bad of [
      "",
      "../x.ics",
      "a/b.ics",
      "/etc/x.ics",
      ".hidden.ics",
      "a b.ics",
      "a\nb.ics",
      "x".repeat(300),
    ])
      expect(typeof newFileIn("/v", bad), JSON.stringify(bad)).not.toBe("string");
  });

  it("limits the length of a calendar name", () => {
    const settings = testSettings({ calendars: {} });
    const long = "c".repeat(MAX_NAME + 1);
    expect(vdirOf(settings, long)).toMatchObject({ message: expect.stringContaining("at most 255") });
  });

  describe("in a vdir", () => {
    let dir: string;
    let vdir: string;
    const settings = () => testSettings({ calendars: { work: { path: vdir } } });

    beforeAll(async () => {
      dir = await tempDir();
      vdir = join(dir, "work");
      await mkdir(vdir);
      await writeFile(join(vdir, "u1.ics"), EVENT);
      await mkdir(join(vdir, "folder.ics"));
      await writeFile(join(vdir, "huge.ics"), `${"X-JUNK:1\r\n".repeat(MAX_FILE_BYTES / 10)}UID:huge\r\n`);
    });
    afterAll(() => removeDir(dir));

    it("rejects a uid that is too long and skips directories and huge files", async () => {
      expect((await runFail(findEvent(settings(), "work", "u".repeat(MAX_NAME + 1)))).message).toMatch(
        /longer than 255/,
      );
      expect((await runOk(findEvent(settings(), "work", "u1"))).file).toBe(join(vdir, "u1.ics"));
      expect((await runFail(findEvent(settings(), "work", "huge"))).message).toMatch(/no event with uid/);
    });

    it("never overwrites an existing file when creating one", async () => {
      const taken = join(vdir, "u1.ics");
      expect((await runFail(createEvent(taken, ["A:1"])))._tag).toBe("IoError");
      expect(await readFile(taken, "utf8")).toBe(EVENT);
      const fresh = join(vdir, "fresh.ics");
      await runOk(createEvent(fresh, ["A:1"]));
      expect(await readFile(fresh, "utf8")).toBe("A:1\r\n");
      expect((await readdir(vdir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    it("refuses to split a series under an unsafe new uid, writing nothing", async () => {
      const before = (await readdir(vdir)).sort();
      const p = {
        calendar: "work",
        uid: "u1",
        summary: "x",
        scope: "from_date",
        date: "2030-10-18",
      } as const;
      const e = await runFail(updateEvent(settings(), p, "../x", NOW));
      expect(e.message).toMatch(/not a safe file name/);
      expect((await readdir(vdir)).sort()).toEqual(before);
      expect(await readFile(join(vdir, "u1.ics"), "utf8")).toBe(EVENT);
    });
  });
});

describe("text limits and scope", () => {
  const lines = EVENT.split("\r\n");
  const base = { calendar: "work", uid: "u1" };

  it("rejects text that is too long, and accepts text at the limit", () => {
    expect(failure(updateLines(lines, { ...base, summary: "s".repeat(MAX_TITLE + 1) }, NOW)).message).toMatch(
      /summary must not be longer than 1000/,
    );
    expect(
      failure(updateLines(lines, { ...base, location: "l".repeat(MAX_TITLE + 1) }, NOW)).message,
    ).toMatch(/location must not be longer/);
    expect(
      failure(updateLines(lines, { ...base, description: "d".repeat(MAX_DESCRIPTION + 1) }, NOW)).message,
    ).toMatch(/description must not be longer than 20000/);
    expect(updateLines(lines, { ...base, summary: "s".repeat(MAX_TITLE) }, NOW)._tag).toBe("Success");
  });

  it("rejects a scope that is not one of the three", () => {
    expect(failure(scopeOf({ scope: "everything" as never })).message).toMatch(/scope must be/);
  });

  it("escapes line breaks, so text can never inject ICS lines", () => {
    const out = unwrap(updateLines(lines, { ...base, summary: "a\r\nEND:VEVENT\r\nBEGIN:VEVENT" }, NOW));
    expect(out.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(out).toContain("SUMMARY:a\\nEND:VEVENT\\nBEGIN:VEVENT");
  });

  it("rejects control characters and unicode line separators in text", () => {
    for (const evil of ["a b", "a\u0085b", "a\u0000b"])
      expect(failure(updateLines(lines, { ...base, summary: evil }, NOW)).message).toMatch(
        /control characters/,
      );
  });
});

describe("the tools refuse malformed input before touching anything", () => {
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = await tempDir();
    const vdir = join(dir, "work");
    await mkdir(vdir);
    await writeFile(join(vdir, "u1.ics"), `${EVENT}\r\n`);
    const server = createServer(
      testSettings({ calendars: { work: { path: vdir, email: "me@example.com" } } }),
      {
        uid: () => "fixed-uid",
        now: () => NOW,
      },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });
  afterAll(async () => {
    await client.close();
    await removeDir(dir);
  });

  const refused = async (name: string, args: Record<string, unknown>): Promise<boolean> => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
    return r.isError === true;
  };

  it.each([
    ["update_event", { calendar: "work", uid: "u1", summary: "x", scope: "instance", date: "20301018" }],
    ["update_event", { calendar: "work", uid: "u1", summary: "x", scope: "weekly" }],
    ["update_event", { calendar: "work", uid: "u".repeat(300), summary: "x" }],
    ["update_event", { calendar: "c".repeat(300), uid: "u1", summary: "x" }],
    ["update_event", { calendar: "work", uid: "u1", summary: "s".repeat(MAX_TITLE + 1) }],
    ["update_event", { calendar: "work", uid: "u1", description: "d".repeat(MAX_DESCRIPTION + 1) }],
    ["end_event_series", { calendar: "work", uid: "u1", last_date: "2030-10-18; rm -rf /" }],
    ["respond_to_event", { calendar: "work", uid: "u1", response: "maybe" }],
    ["respond_to_event", { calendar: "work", uid: "u1", response: "accepted", scope: "from_date" }],
    ["new_event", { start: "tomorrow", summary: "s".repeat(MAX_TITLE + 1) }],
  ])("%s %j", async (name, args) => {
    expect(await refused(name, args)).toBe(true);
  });

  it("leaves the event file untouched by all of that", async () => {
    expect(await readFile(join(dir, "work", "u1.ics"), "utf8")).toBe(`${EVENT}\r\n`);
  });
});
