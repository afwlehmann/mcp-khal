import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Sandbox, sandbox, unfold } from "./testlib.js";

// End-to-end tests of the real process edge (cli.ts, index.ts). The compiled server is spawned
// over stdio; vitest.global-setup.ts rebuilds dist/ before the run. Everything the server sees
// (HOME, XDG_*, TMPDIR, its config and the calendars) lives in one sandbox directory.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const textOf = (r: unknown): string =>
  ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

/** The environment of the server: built from scratch, only PATH is taken over. */
const envIn = (box: Sandbox, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: box.dir,
  XDG_CONFIG_HOME: join(box.dir, "xdg-config"),
  XDG_DATA_HOME: join(box.dir, "xdg-data"),
  XDG_CACHE_HOME: join(box.dir, "xdg-cache"),
  TMPDIR: box.dir,
  TZ: "Europe/Berlin",
  ...extra,
});

const run = (
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout,
        stderr,
      }),
    );
    child.stdin?.end();
  });

/** Writes `config` (an object, or raw text) as the sandbox's config file; returns its path. */
const writeConfig = async (box: Sandbox, config: object | string, name = "cfg.json"): Promise<string> => {
  const path = join(box.dir, name);
  await writeFile(path, typeof config === "string" ? config : JSON.stringify(config));
  return path;
};

interface Running {
  readonly client: Client;
  readonly call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  readonly log: () => string;
  readonly close: () => Promise<void>;
}

const start = async (
  box: Sandbox,
  config: string,
  extraEnv: Record<string, string> = {},
): Promise<Running> => {
  const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
  let serverLog = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: envIn(box, { MCP_KHAL_CONFIG: config, ...extraEnv }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  await client.connect(transport);
  return {
    client,
    call: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), isError: isError(r) };
    },
    log: () => serverLog,
    close: () => client.close(),
  };
};

interface Listed {
  calendar: string;
  uid: string;
  title: string;
  startDate: string;
  startTime: string;
  location: string;
  attendees: string;
}

const eventsOf = (text: string): Listed[] => JSON.parse(text) as Listed[];

const uidOf = (created: string): string => {
  const m = /\(uid ([^)\s]+)\)/.exec(created);
  if (m?.[1] === undefined) throw new Error(`no uid in ${created}`);
  return m[1];
};

describe("the server process works on the calendars' folders", () => {
  let box: Sandbox;
  let server: Running;

  beforeEach(async () => {
    box = await sandbox();
    const work = await box.vdir("work");
    const home = await box.vdir("home");
    const config = await writeConfig(box, {
      defaultCalendar: "work",
      calendars: {
        work: { path: work, email: "me@work.com", alarm: "15m" },
        home: { path: home },
      },
    });
    server = await start(box, config);
  });
  afterEach(async () => {
    await server.close();
    await box.cleanup();
  });

  it("lists the tools of the server", async () => {
    const { tools } = await server.client.listTools();
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

  it("list_calendars returns the configured names, sorted", async () => {
    const r = await server.call("list_calendars");
    expect(r.isError).toBe(false);
    expect(r.text).toBe("home\nwork");
  });

  it("new_event writes a file that list_events, events_in_range and search_events find", async () => {
    const created = await server.call("new_event", {
      calendar: "home",
      start: "2030-05-06T10:00",
      duration: "1h",
      timezone: "Europe/Berlin",
      summary: "Dentist",
      location: "Main street 1",
    });
    expect(created.isError).toBe(false);
    expect(created.text).toMatch(/Created event 'Dentist' .* in calendar 'home'/);
    const uid = uidOf(created.text);
    expect(await box.read(`calendars/home/${uid}.ics`)).toContain("SUMMARY:Dentist");
    expect(await box.read(`calendars/work/${uid}.ics`)).toBeUndefined();

    const listed = await server.call("list_events", { range: "2030-05-06 2030-05-07" });
    expect(listed.isError).toBe(false);
    const [event, ...rest] = eventsOf(listed.text);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      calendar: "home",
      uid,
      title: "Dentist",
      startDate: expect.stringContaining("2030-05-06"),
      location: "Main street 1",
    });
    expect(event?.startTime).toContain("10:00");

    const inRange = await server.call("events_in_range", { start: "2030-05-01", end: "2030-05-31" });
    expect(eventsOf(inRange.text).map((e) => e.uid)).toEqual([uid]);

    const found = await server.call("search_events", {
      query: "dentist",
      range: "2030-05-01 2030-06-01",
    });
    expect(eventsOf(found.text).map((e) => e.uid)).toEqual([uid]);
    const other = await server.call("search_events", {
      query: "nothing like it",
      range: "2030-05-01 2030-06-01",
    });
    expect(eventsOf(other.text)).toEqual([]);

    const onlyWork = await server.call("list_events", { range: "2030-05-06 2030-05-07", calendar: "work" });
    expect(eventsOf(onlyWork.text)).toEqual([]);
  });

  it("new_event without a calendar uses the default calendar and its reminder", async () => {
    const created = await server.call("new_event", { start: "2030-05-07", summary: "Holiday" });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("in calendar 'work'");
    const ics = unfold((await box.read(`calendars/work/${uidOf(created.text)}.ics`)) ?? "");
    expect(ics).toContain("TRIGGER:-PT15M");
  });

  it("new_event reports bad input as a tool error, not a crash", async () => {
    const r = await server.call("new_event", { calendar: "nope", start: "2030-05-07", summary: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^InvalidInput:/);
    const again = await server.call("list_calendars");
    expect(again.text).toBe("home\nwork");
  });

  it("update_event changes the event's file and the read tools show it", async () => {
    const created = await server.call("new_event", {
      calendar: "work",
      start: "2030-05-06T10:00",
      duration: "1h",
      summary: "Standup",
    });
    const uid = uidOf(created.text);
    const updated = await server.call("update_event", {
      calendar: "work",
      uid,
      summary: "Planning",
      location: "Room 5",
    });
    expect(updated.isError).toBe(false);
    const listed = await server.call("list_events", { range: "2030-05-06 2030-05-07" });
    expect(eventsOf(listed.text)).toMatchObject([{ uid, title: "Planning", location: "Room 5" }]);
    expect(await box.read(`calendars/work/${uid}.ics`)).toContain("SUMMARY:Planning");
  });

  it("update_event refuses an unknown event", async () => {
    const r = await server.call("update_event", { calendar: "work", uid: "nope", summary: "x" });
    expect(r.isError).toBe(true);
  });

  it("respond_to_event sets the participation status of the user", async () => {
    const created = await server.call("new_event", {
      calendar: "work",
      start: "2030-05-08T14:00",
      duration: "30m",
      summary: "Review",
      organizer: "boss@example.com",
      attendees: ["me@work.com", "peer@example.com"],
    });
    expect(created.isError).toBe(false);
    const uid = uidOf(created.text);
    const r = await server.call("respond_to_event", { calendar: "work", uid, response: "declined" });
    expect(r.text).toContain("Marked me@work.com as declined");
    expect(r.isError).toBe(false);
    const ics = unfold((await box.read(`calendars/work/${uid}.ics`)) ?? "");
    expect(ics).toMatch(/ATTENDEE[^\n]*PARTSTAT=DECLINED[^\n]*mailto:me@work\.com/);
  });

  it("respond_to_event refuses an event the user is not invited to", async () => {
    const created = await server.call("new_event", {
      calendar: "work",
      start: "2030-05-08T14:00",
      duration: "30m",
      summary: "Solo",
    });
    const r = await server.call("respond_to_event", {
      calendar: "work",
      uid: uidOf(created.text),
      response: "accepted",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not invited/);
  });

  it("end_event_series removes the occurrences after the last date", async () => {
    // 2030-05-06 is a Monday
    const created = await server.call("new_event", {
      calendar: "work",
      start: "2030-05-06T09:00",
      duration: "15m",
      summary: "Weekly sync",
      recurrence: { pattern: { kind: "weekly", weekdays: ["monday"] } },
    });
    expect(created.isError).toBe(false);
    const uid = uidOf(created.text);
    const before = await server.call("events_in_range", { start: "2030-05-06", end: "2030-06-03" });
    expect(eventsOf(before.text)).toHaveLength(4);

    const ended = await server.call("end_event_series", { calendar: "work", uid, last_date: "2030-05-13" });
    expect(ended.isError).toBe(false);
    expect(ended.text).toContain("last occurrence is on 2030-05-13");
    const after = await server.call("events_in_range", { start: "2030-05-06", end: "2030-06-03" });
    expect(eventsOf(after.text).map((e) => e.startDate.slice(0, 10))).toEqual(["2030-05-06", "2030-05-13"]);
  });

  it("end_event_series refuses an event that does not repeat", async () => {
    const created = await server.call("new_event", {
      calendar: "work",
      start: "2030-05-06T09:00",
      duration: "15m",
      summary: "Once",
    });
    const r = await server.call("end_event_series", {
      calendar: "work",
      uid: uidOf(created.text),
      last_date: "2030-05-13",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a recurring event/);
  });
});

describe("the server process logs its configuration at startup", () => {
  let box: Sandbox;
  beforeEach(async () => {
    box = await sandbox();
  });
  afterEach(() => box.cleanup());

  it("writes one line to stderr with the effective settings and masked addresses, never the environment", async () => {
    const work = await box.vdir("work");
    const config = await writeConfig(box, { calendars: { work: { path: work, email: "me@work.com" } } });
    const server = await start(box, config, { API_TOKEN: "t0ps3cret" });
    try {
      await vi.waitFor(() => expect(server.log()).toMatch(/mcp-khal starting with configuration/));
      expect(server.log()).toContain(`"configPath":${JSON.stringify(config)}`);
      expect(server.log()).toContain(`"path":${JSON.stringify(work)}`);
      expect(server.log()).toContain("m***@work.com");
      expect(server.log()).not.toContain("me@work.com");
      expect(server.log()).not.toContain("t0ps3cret");
    } finally {
      await server.close();
    }
  });

  it("does not read any variable of earlier versions, so MCP_KHAL_BIN changes nothing", async () => {
    const work = await box.vdir("work");
    const config = await writeConfig(box, { calendars: { work: { path: work } } });
    const server = await start(box, config, { MCP_KHAL_BIN: "/old/khal" });
    try {
      expect((await server.call("list_calendars")).text).toBe("work");
      expect(server.log()).not.toContain("MCP_KHAL_BIN");
    } finally {
      await server.close();
    }
  });

  it("finds the config file through XDG_CONFIG_HOME when MCP_KHAL_CONFIG is not set", async () => {
    const work = await box.vdir("work");
    const xdg = join(box.dir, "xdg-config");
    await mkdir(xdg, { recursive: true });
    await writeFile(join(xdg, "mcp-khal.json"), JSON.stringify({ calendars: { work: { path: work } } }));
    const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [CLI], env: envIn(box) }),
      );
      const r = await client.callTool({ name: "list_calendars", arguments: {} });
      expect(isError(r)).toBe(false);
      expect(textOf(r)).toBe("work");
    } finally {
      await client.close();
    }
  });
});

describe("cli", () => {
  let box: Sandbox;
  beforeAll(async () => {
    box = await sandbox();
  });
  afterAll(() => box.cleanup());

  it("rejects an unknown command with exit code 2", async () => {
    const r = await run(["bogus"], envIn(box));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command 'bogus'/);
  });

  it("setup refuses to run without a terminal", async () => {
    const r = await run(["setup"], envIn(box, { MCP_KHAL_CONFIG: join(box.dir, "none.json") }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/InvalidInput: setup needs an interactive terminal/);
  });
});

describe("the server checks its configuration at startup and refuses to start", () => {
  let box: Sandbox;
  let work: string;
  let home: string;

  beforeAll(async () => {
    box = await sandbox();
    work = await box.vdir("work");
    home = await box.vdir("home");
  });
  afterAll(() => box.cleanup());

  /** Starts the server on a config file with this content and returns what it did. */
  const startWith = async (name: string, config: object | string, extraEnv: Record<string, string> = {}) => {
    const path = await writeConfig(box, config, name);
    return run([], envIn(box, { MCP_KHAL_CONFIG: path, ...extraEnv }));
  };

  it("on an invalid reminder, naming the key", async () => {
    const r = await startWith("bad-alarm.json", { calendars: { work: { path: work, alarm: "in an hour" } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /mcp-khal cannot start: InvalidInput: calendars\.work\.alarm must be a reminder like 30m, 2h or 1d/,
    );
  });

  it("on an invalid address", async () => {
    const r = await startWith("bad-email.json", { calendars: { work: { path: work, email: "nope" } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("calendars.work.email is not a valid email address");
  });

  it("on a calendar without a path, saying that the path is required", async () => {
    const r = await startWith("no-path.json", { calendars: { work: { email: "me@work.com" } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("calendars.work.path is required");
  });

  it("on a relative path", async () => {
    const r = await startWith("relative.json", { calendars: { work: { path: "calendars/work" } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("calendars.work.path must be an absolute path");
  });

  it("when the folder of a calendar does not exist, naming calendar and folder", async () => {
    const missing = join(box.dir, "calendars", "gone");
    const r = await startWith("missing-dir.json", { calendars: { work: { path: missing } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      `mcp-khal cannot start: InvalidInput: calendars.work.path ${missing} is not a directory that can be read`,
    );
  });

  it("when the path of a calendar is a file", async () => {
    const file = join(box.dir, "a-file");
    await writeFile(file, "");
    const r = await startWith("file-path.json", { calendars: { work: { path: file } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`calendars.work.path ${file} is not a directory`);
  });

  it("when no calendar is configured", async () => {
    const r = await startWith("empty.json", {});
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no calendars are configured in .*empty\.json/);
  });

  it("when two calendars share one folder", async () => {
    const r = await startWith("same-path.json", {
      defaultCalendar: "work",
      calendars: { work: { path: work }, home: { path: work } },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("have the same path");
  });

  it("when there are several calendars and no default calendar", async () => {
    const r = await startWith("no-default.json", {
      calendars: { work: { path: work }, home: { path: home } },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'several calendars are configured (home, work): set "defaultCalendar" (or MCP_KHAL_DEFAULT_CALENDAR) to the one new events go to when a call names no calendar',
    );
  });

  it("when the default calendar is not a configured calendar", async () => {
    const r = await startWith("bad-default.json", {
      defaultCalendar: "wrok",
      calendars: { work: { path: work }, home: { path: home } },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("defaultCalendar 'wrok' is not one of the configured calendars (home, work)");
  });

  it("when MCP_KHAL_CONFIG names a file that does not exist", async () => {
    const r = await run([], envIn(box, { MCP_KHAL_CONFIG: join(box.dir, "missing.json") }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/MCP_KHAL_CONFIG points to .*missing\.json, which does not exist/);
  });

  it("when MCP_KHAL_CONFIG is a relative path", async () => {
    const r = await run([], envIn(box, { MCP_KHAL_CONFIG: "cfg.json" }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MCP_KHAL_CONFIG must be an absolute path");
  });

  it("when the config is not valid JSON, saying why", async () => {
    const r = await startWith("corrupt.json", "{ not json");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/mcp-khal cannot start: InvalidInput: config is not valid JSON/);
  });

  it("explaining where the retired calendarEmails and calendarAlarms keys went", async () => {
    const r = await startWith("old.json", {
      calendarEmails: { work: "me@work.com" },
      calendarAlarms: { work: "1d" },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/2 problems:/);
    expect(r.stderr).toContain(`config key 'calendarEmails' has moved into "calendars"`);
    expect(r.stderr).toContain(`config key 'calendarAlarms' has moved into "calendars"`);
  });

  it("listing every problem, not only the first", async () => {
    const r = await startWith("many.json", {
      defaultCalendar: 42,
      calendars: { work: { path: "relative", email: "nope" }, home: { alarm: "soon" } },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/mcp-khal cannot start: InvalidInput: 5 problems:/);
    for (const part of [
      "defaultCalendar must be a calendar name",
      "calendars.work.path must be an absolute path",
      "calendars.work.email is not a valid email address",
      "calendars.home.alarm must be a reminder",
      "calendars.home.path is required",
    ])
      expect(r.stderr).toContain(part);
  });
});
