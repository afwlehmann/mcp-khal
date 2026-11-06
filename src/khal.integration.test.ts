import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, serializeConfig } from "./config.js";
import type { KhalEvent } from "./khal.js";
import { runKhal } from "./khal.js";
import { createServer } from "./server.js";
import { loadSettings, type Settings } from "./settings.js";
import { runSetup } from "./setup.js";
import { runOk, unfold } from "./testlib.js";

// Integration tests against the REAL khal. Run them inside the dev shell:
//
//   nix develop --command npm run test:integration
//
// Everything lives in one throwaway directory: HOME, the XDG directories, TMPDIR, khal's config
// and database, the calendars and the mcp-khal config. The environment handed to khal is built
// from scratch (only PATH is taken over), so nothing of the real home directory is read or written.

const sandboxEnv = (root: string, path: string): Record<string, string> => ({
  PATH: path,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  TMPDIR: join(root, "tmp"),
  TZ: "UTC",
  MCP_KHAL_CONFIG: join(root, "config", "mcp-khal.json"),
});

const khalConfig = (root: string): string => `[calendars]

[[work]]
path = ${join(root, "calendars", "work")}
type = calendar

[[home]]
path = ${join(root, "calendars", "home")}
type = calendar

[default]
default_calendar = work

[locale]
timeformat = %H:%M
dateformat = %Y-%m-%d
longdateformat = %Y-%m-%d
datetimeformat = %Y-%m-%d %H:%M
longdatetimeformat = %Y-%m-%d %H:%M
local_timezone = UTC
default_timezone = UTC
`;

// A reminder "at the start": khal normalises it to P0D (what we write for imports is -PT0M)
const ZERO_TRIGGER = /^-?(PT0[MS]|P0D)$/;

const textOf = (r: unknown): string =>
  ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

describe("mcp-khal with the real khal, entirely inside a temporary directory", () => {
  let root: string;
  let env: Record<string, string>;
  let settings: Settings;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: textOf(r), error: isError(r) };
  };
  const events = async (name: string, args: Record<string, unknown>): Promise<KhalEvent[]> => {
    const r = await call(name, args);
    expect(r.error, r.text).toBe(false);
    return JSON.parse(r.text) as KhalEvent[];
  };

  /** the .ics file khal stored in the sandbox for the event with this summary (unfolded) */
  const storedIcs = async (calendar: string, summary: string): Promise<string> => {
    const dir = join(root, "calendars", calendar);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ics"));
    const all = await Promise.all(files.map(async (f) => unfold(await readFile(join(dir, f), "utf8"))));
    const found = all.find((content) => content.includes(`SUMMARY:${summary}`));
    expect(found, `no stored event "${summary}" in ${calendar}`).toBeDefined();
    return found ?? "";
  };
  /** the values of all TRIGGER properties, e.g. ["-PT30M"] */
  const triggers = (ics: string): string[] =>
    [...ics.matchAll(/^TRIGGER[^:\r\n]*:([^\r\n]+)/gm)].map((m) => m[1] ?? "");

  beforeAll(async () => {
    // realpath: on macOS the temp directory is a symlink and khal prints resolved paths
    root = await realpath(await mkdtemp(join(tmpdir(), "mcp-khal-it-")));
    for (const dir of ["home", "config/khal", "data", "cache", "tmp", "calendars/work", "calendars/home"])
      await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "config", "khal", "config"), khalConfig(root));
    await writeFile(
      join(root, "config", "mcp-khal.json"),
      serializeConfig({
        khal: "khal",
        calendarEmails: { work: "me@work.com" },
        // work has its own reminder, home explicitly none, the default applies to everything else
        defaultAlarm: "1d",
        calendarAlarms: { work: "30m", home: "none" },
      }),
    );

    env = sandboxEnv(root, process.env.PATH ?? "");
    // the production path: environment + config file -> Settings
    settings = await runOk(loadSettings({ env, home: join(root, "home"), tmpDir: join(root, "tmp") }));

    const version = await runKhal(settings, ["--version"]);
    await runOk(version).catch((e: unknown) => {
      throw new Error(`the real khal is required: run this inside \`nix develop\` (${JSON.stringify(e)})`);
    });

    // unique per event, like the randomUUID of the real server: khal treats equal UIDs as one event
    let counter = 0;
    const server = createServer(settings, {
      uid: () => `integration-uid-${++counter}`,
      now: () => new Date("2030-01-01T00:00:00Z"),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "mcp-khal-integration", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  afterAll(async () => {
    await client?.close();
    if (root === undefined) return;
    await rm(root, { recursive: true, force: true });
    // the sandbox is the only thing the run created, and it is gone again
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("isolation", () => {
    it("keeps every path of the settings inside the temporary directory", () => {
      for (const path of [settings.configPath, settings.tmpDir]) expect(path.startsWith(root)).toBe(true);
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"])
        expect(settings.childEnv[key]?.startsWith(root), key).toBe(true);
    });

    it("hands khal nothing but the sandbox environment and PATH", () => {
      expect(Object.keys(settings.childEnv).sort()).toEqual([...Object.keys(env), "LC_ALL"].sort());
    });

    it("makes khal read the config of the sandbox: only its calendars exist", async () => {
      const out = await runOk(runKhal(settings, ["printcalendars"]));
      expect(
        out
          .split("\n")
          .filter((l) => l !== "")
          .sort(),
      ).toEqual(["home", "work"]);
    });
  });

  describe("reading", () => {
    it("lists the calendars of the sandbox config", async () => {
      const r = await call("list_calendars", {});
      expect(r.error, r.text).toBe(false);
      expect(r.text.split("\n").map((l) => l.trim())).toEqual(expect.arrayContaining(["home", "work"]));
    });

    it("reports an empty calendar as an empty list", async () => {
      expect(await events("list_events", { range: "2030-01-14 2030-01-16" })).toEqual([]);
    });
  });

  describe("plain events (khal new)", () => {
    it("creates an event that khal then lists, searches and finds by time range", async () => {
      const created = await call("new_event", {
        calendar: "work",
        start: "2030-01-15 12:00",
        end: "13:00",
        summary: "Lunch",
        location: "Cafe",
        description: "bring notes",
        alarm: "15m",
      });
      expect(created.error, created.text).toBe(false);

      const [lunch, ...rest] = await events("list_events", { range: "2030-01-15", calendar: "work" });
      expect(rest).toEqual([]);
      expect(lunch).toMatchObject({
        calendar: "work",
        startDate: "2030-01-15",
        startTime: "12:00",
        endTime: "13:00",
        title: "Lunch",
        location: "Cafe",
      });
      expect(lunch?.description).toContain("bring notes");

      const found = await events("search_events", { query: "Lunch" });
      expect(found.map((e) => e.title)).toContain("Lunch");

      const inRange = await events("events_in_range", {
        start: "2030-01-15 12:30",
        end: "2030-01-15 12:45",
      });
      expect(inRange.map((e) => e.title)).toEqual(["Lunch"]);
      expect(await events("events_in_range", { start: "2030-01-15 14:00", end: "2030-01-15 15:00" })).toEqual(
        [],
      );
    });

    it("keeps events of other calendars apart", async () => {
      expect(await events("list_events", { range: "2030-01-15", calendar: "home" })).toEqual([]);
    });

    it("surfaces khal's own errors as error results", async () => {
      const r = await call("list_events", { range: "2030-01-15", calendar: "no-such-calendar" });
      expect(r.error).toBe(true);
      expect(r.text).toMatch(/^NonZeroExit:/);
    });

    it("rejects option-like input before khal ever runs", async () => {
      const r = await call("list_events", { calendar: "-x" });
      expect(r.error).toBe(true);
      expect(r.text).toMatch(/^InvalidInput:/);
    });
  });

  describe("series and invites (ICS imported by khal)", () => {
    it("imports a weekly series with a count that khal expands into occurrences", async () => {
      const created = await call("new_event", {
        calendar: "work",
        start: "2030-01-16 09:00",
        end: "09:30",
        summary: "Standup",
        recurrence: {
          pattern: { kind: "weekly", weekdays: ["wednesday"] },
          ending: { kind: "count", count: 3 },
        },
      });
      expect(created.error, created.text).toBe(false);

      const standups = (await events("list_events", { range: "2030-01-14 2030-02-04" })).filter(
        (e) => e.title === "Standup",
      );
      expect(standups.map((e) => e.startDate)).toEqual(["2030-01-16", "2030-01-23", "2030-01-30"]);
      expect(new Set(standups.map((e) => `${e.startTime}-${e.endTime}`))).toEqual(new Set(["09:00-09:30"]));
    });

    it("imports an invite whose escaped text survives khal, with organizer from the mapping", async () => {
      const created = await call("new_event", {
        calendar: "work",
        start: "2030-01-17 10:00",
        end: "11:00",
        summary: "Design review, part 1; agenda",
        location: "Room 1, Floor 2",
        description: "line1\nline2",
        attendees: ["you@example.com", "Other@Example.com"],
      });
      expect(created.error, created.text).toBe(false);

      const [review] = (await events("list_events", { range: "2030-01-17" })).filter((e) =>
        e.title.startsWith("Design review"),
      );
      expect(review?.title).toBe("Design review, part 1; agenda");
      expect(review?.location).toBe("Room 1, Floor 2");

      // the vdir file khal wrote, inside the sandbox
      const dir = join(root, "calendars", "work");
      const files = (await readdir(dir)).filter((f) => f.endsWith(".ics"));
      const ics = (
        await Promise.all(files.map(async (f) => unfold(await readFile(join(dir, f), "utf8"))))
      ).find((content) => content.includes("Design review"));
      expect(ics, "khal stored the invite").toBeDefined();
      expect(ics).toMatch(/ORGANIZER:mailto:me@work\.com/);
      expect(ics).toMatch(/ATTENDEE;[^\r\n]*:mailto:you@example\.com/);
      expect(ics).toMatch(/ATTENDEE;[^\r\n]*:mailto:Other@Example\.com/);
    });

    it("refuses an invite when no organizer address is known for the calendar", async () => {
      const r = await call("new_event", {
        calendar: "home",
        start: "2030-01-18 10:00",
        end: "11:00",
        summary: "Nobody home",
        attendees: ["you@example.com"],
      });
      expect(r.error).toBe(true);
      expect(r.text).toMatch(/no address known for calendar 'home'/);
      expect(await events("list_events", { range: "2030-01-18" })).toEqual([]);
    });
  });

  describe("default reminders (work: 30m, home: none, everything else: 1d)", () => {
    const base = { start: "2030-02-04 10:00", end: "11:00" };
    const create = async (args: Record<string, unknown>) => {
      const r = await call("new_event", { ...base, ...args });
      expect(r.error, r.text).toBe(false);
    };

    it("applies the calendar's reminder to a plain event created through khal new", async () => {
      await create({ calendar: "work", summary: "Plain on work" });
      expect(triggers(await storedIcs("work", "Plain on work"))).toEqual(["-PT30M"]);
    });

    it("applies the calendar's reminder to an imported series", async () => {
      await create({
        calendar: "work",
        summary: "Series on work",
        recurrence: { pattern: { kind: "daily" }, ending: { kind: "count", count: 2 } },
      });
      expect(triggers(await storedIcs("work", "Series on work"))).toEqual(["-PT30M"]);
    });

    it("applies the calendar's reminder to an imported invite", async () => {
      await create({ calendar: "work", summary: "Invite on work", attendees: ["you@example.com"] });
      expect(triggers(await storedIcs("work", "Invite on work"))).toEqual(["-PT30M"]);
    });

    it("adds no reminder on a calendar configured with 'none', on either path", async () => {
      await create({ calendar: "home", summary: "Plain on home" });
      expect(triggers(await storedIcs("home", "Plain on home"))).toEqual([]);
      await create({
        calendar: "home",
        summary: "Series on home",
        recurrence: { pattern: { kind: "daily" } },
      });
      expect(triggers(await storedIcs("home", "Series on home"))).toEqual([]);
    });

    it("lets an explicit alarm override the calendar's reminder, in days and in minutes", async () => {
      await create({ calendar: "work", summary: "Explicit days plain", alarm: "1d" });
      expect(triggers(await storedIcs("work", "Explicit days plain"))).toEqual(["-P1D"]);
      await create({
        calendar: "work",
        summary: "Explicit minutes series",
        alarm: "10m",
        recurrence: { pattern: { kind: "daily" } },
      });
      expect(triggers(await storedIcs("work", "Explicit minutes series"))).toEqual(["-PT10M"]);
    });

    it("lets an explicit 'none' suppress the configured reminder, on either path", async () => {
      await create({ calendar: "work", summary: "None plain", alarm: "none" });
      expect(triggers(await storedIcs("work", "None plain"))).toEqual([]);
      await create({
        calendar: "work",
        summary: "None series",
        alarm: "none",
        recurrence: { pattern: { kind: "daily" } },
      });
      expect(triggers(await storedIcs("work", "None series"))).toEqual([]);
    });

    it("uses the default reminder when no calendar is named (khal files it in its default calendar)", async () => {
      await create({ summary: "No calendar named" });
      expect(triggers(await storedIcs("work", "No calendar named"))).toEqual(["-P1D"]);
    });

    it("accepts a reminder of 0m (at the start) through khal new", async () => {
      await create({ calendar: "work", summary: "Zero plain", alarm: "0m" });
      const [trigger, ...rest] = triggers(await storedIcs("work", "Zero plain"));
      expect(rest).toEqual([]);
      expect(trigger).toMatch(ZERO_TRIGGER);
    });

    it("accepts a reminder of 0m (at the start) in an imported series", async () => {
      await create({
        calendar: "work",
        summary: "Zero series",
        alarm: "0m",
        recurrence: { pattern: { kind: "daily" } },
      });
      const [trigger, ...rest] = triggers(await storedIcs("work", "Zero series"));
      expect(rest).toEqual([]);
      expect(trigger).toMatch(ZERO_TRIGGER);
      const listed = await events("list_events", { range: "2030-02-04", calendar: "work" });
      expect(listed.map((e) => e.title)).toContain("Zero series");
    });
  });

  describe("what khal left behind", () => {
    it("keeps its database and every calendar file inside the sandbox", async () => {
      // where exactly depends on the platform (XDG on Linux, ~/Library/Application Support on macOS),
      // but with HOME and XDG_* pointing into the sandbox it has to be somewhere below the root
      const everything = await readdir(root, { recursive: true });
      expect(everything.some((f) => f.endsWith("khal.db"))).toBe(true);
      const all = await readdir(join(root, "calendars", "work"));
      const work = all.filter((f) => f.endsWith(".ics"));
      // Lunch (khal new), the Standup series and the invite
      expect(work.length, JSON.stringify(all)).toBeGreaterThanOrEqual(3);
    });

    it("leaves no temporary ICS file behind in the sandbox's tmp directory", async () => {
      const leftovers = await readdir(join(root, "tmp"));
      expect(leftovers.filter((f) => f.startsWith("mcp-khal-"))).toEqual([]);
    });
  });

  describe("setup", () => {
    it("asks for every calendar khal reports and writes the mapping into the sandbox", async () => {
      const setupConfig = join(root, "config", "setup-test.json");
      const asked: string[] = [];
      const rl = {
        question: async (q: string) => {
          asked.push(q);
          return q.includes("'home'") ? "me@home.org" : "me@work.com";
        },
        write: () => {},
        close: () => {},
      } as unknown as Interface;

      const code = await runSetup(
        {
          env: { ...env, MCP_KHAL_CONFIG: setupConfig },
          home: join(root, "home"),
          tmpDir: join(root, "tmp"),
        },
        { isTTY: true, openPrompt: () => rl, log: () => {} },
        (line) => {
          throw new Error(line);
        },
      );

      expect(code).toBe(0);
      expect(asked).toHaveLength(2);
      expect(await runOk(loadConfig(setupConfig))).toEqual({
        khal: "khal",
        calendarEmails: { home: "me@home.org", work: "me@work.com" },
        defaultAlarm: "none",
        calendarAlarms: {},
      });
    });
  });
});
