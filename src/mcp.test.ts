import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serializeConfig } from "./config.js";
import { type FakeKhal, fakeKhal, removeDir, tempDir } from "./testlib.js";

// End-to-end tests of the real process edge (cli.ts, index.ts). The compiled server is spawned;
// vitest.global-setup.ts rebuilds dist/ before the run.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const textOf = (r: unknown): string =>
  ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

const run = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
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

describe("the server process finds khal through its configuration", () => {
  let fake: FakeKhal;
  let dir: string;

  beforeAll(async () => {
    fake = await fakeKhal({ stdout: "work\n" });
    dir = await tempDir();
  });
  afterAll(async () => {
    await fake.cleanup();
    await removeDir(dir);
  });

  /** khal is deliberately NOT on PATH: only the config or the environment can locate it. */
  const listCalendars = async (khalInConfig: string, extraEnv: Record<string, string> = {}) => {
    const config = join(dir, "cfg.json");
    await writeFile(
      config,
      serializeConfig({
        khal: khalInConfig,
        calendars: { work: { email: "me@work.com" } },
      }),
    );
    const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [CLI],
          env: { PATH: process.env.PATH ?? "", MCP_KHAL_CONFIG: config, ...extraEnv },
        }),
      );
      return await client.callTool({ name: "list_calendars", arguments: {} });
    } finally {
      await client.close();
    }
  };

  it("uses the khal path from the config file", async () => {
    const r = await listCalendars(join(fake.dir, "khal"));
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toBe("work\n");
  });

  it("lets MCP_KHAL_BIN override the config file", async () => {
    const r = await listCalendars("/does/not/exist/khal", { MCP_KHAL_BIN: join(fake.dir, "khal") });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toBe("work\n");
  });
});

describe("the server process logs its configuration at startup", () => {
  it("writes one line to stderr with the effective khal and masked addresses, never the environment", async () => {
    const dir = await tempDir();
    const fake = await fakeKhal({ stdout: "work\n" });
    const khalBin = join(fake.dir, "khal");
    const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    let serverLog = "";
    try {
      const config = join(dir, "cfg.json");
      await writeFile(
        config,
        serializeConfig({
          khal: "/cfg/khal",
          calendars: { work: { email: "me@work.com" } },
        }),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI],
        env: {
          PATH: process.env.PATH ?? "",
          MCP_KHAL_CONFIG: config,
          MCP_KHAL_BIN: khalBin,
          API_TOKEN: "t0ps3cret",
        },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        serverLog += chunk.toString();
      });
      await client.connect(transport);
      await vi.waitFor(() => expect(serverLog).toMatch(/mcp-khal starting with configuration/));
      expect(serverLog).toContain(`"binary":${JSON.stringify(khalBin)},"source":"MCP_KHAL_BIN"`);
      expect(serverLog).toContain(`"configPath":${JSON.stringify(config)}`);
      expect(serverLog).toContain("m***@work.com");
      expect(serverLog).not.toContain("me@work.com");
      expect(serverLog).not.toContain("t0ps3cret");
    } finally {
      await client.close();
      await fake.cleanup();
      await removeDir(dir);
    }
  });
});

describe("cli", () => {
  const env = { PATH: process.env.PATH };

  it("rejects an unknown command with exit code 2", async () => {
    const r = await run(["bogus"], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command 'bogus'/);
  });

  it("setup refuses to run without a terminal", async () => {
    const r = await run(["setup"], {
      ...env,
      MCP_KHAL_CONFIG: join(process.env.TMPDIR ?? "/tmp", "none.json"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/InvalidInput: setup needs an interactive terminal/);
  });

  it("the server refuses to start on an invalid reminder and names the key", async () => {
    const dir = await tempDir();
    try {
      const config = join(dir, "bad-alarm.json");
      await writeFile(config, '{"calendars":{"work":{"alarm":"in an hour"}}}');
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /mcp-khal cannot start: InvalidInput: calendars\.work\.alarm must be a reminder like 30m, 2h or 1d/,
      );
    } finally {
      await removeDir(dir);
    }
  });

  it("the server explains where the retired calendarEmails and calendarAlarms keys went", async () => {
    const dir = await tempDir();
    try {
      const config = join(dir, "old.json");
      await writeFile(config, '{"calendarEmails":{"work":"me@work.com"},"calendarAlarms":{"work":"1d"}}');
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/2 problems:/);
      expect(r.stderr).toContain(`config key 'calendarEmails' has moved into "calendars"`);
      expect(r.stderr).toContain(`config key 'calendarAlarms' has moved into "calendars"`);
    } finally {
      await removeDir(dir);
    }
  });

  describe("the server checks its configuration at startup and refuses to start", () => {
    let fake: FakeKhal;
    let dir: string;

    beforeAll(async () => {
      fake = await fakeKhal({ stdout: "work\nhome\n" });
      dir = await tempDir();
    });
    afterAll(async () => {
      await fake.cleanup();
      await removeDir(dir);
    });

    const configWith = async (name: string, content: object): Promise<string> => {
      const path = join(dir, name);
      await writeFile(path, JSON.stringify(content));
      return path;
    };

    it("when khal cannot be found, naming the configured binary", async () => {
      const config = await configWith("no-khal.json", { khal: "/does/not/exist/khal" });
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /mcp-khal cannot start: InvalidInput: khal \(\/does\/not\/exist\/khal, from config\) cannot be run: NotInstalled: khal executable '\/does\/not\/exist\/khal' not found/,
      );
    });

    it("when the config names a calendar that khal does not have", async () => {
      const config = await configWith("typo.json", {
        khal: join(fake.dir, "khal"),
        defaultCalendar: "work",
        calendars: { wrok: { email: "me@work.com" } },
      });
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /the config names calendars that khal does not know: wrok \(khal has: home, work\)/,
      );
    });

    it("when khal has several calendars and the config names no default calendar", async () => {
      const config = await configWith("no-default.json", { khal: join(fake.dir, "khal") });
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        'khal has several calendars (home, work): set "defaultCalendar" to the one new events go to when a call names no calendar',
      );
    });

    it("when the default calendar does not exist in khal", async () => {
      const config = await configWith("bad-default.json", {
        khal: join(fake.dir, "khal"),
        defaultCalendar: "wrok",
      });
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("defaultCalendar 'wrok' does not exist in khal (khal has: home, work)");
    });

    it("when MCP_KHAL_CONFIG names a file that does not exist", async () => {
      const r = await run([], { ...env, MCP_KHAL_CONFIG: join(dir, "missing.json") });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/MCP_KHAL_CONFIG points to .*missing\.json, which does not exist/);
    });

    it("listing every problem, not only the first", async () => {
      const config = await configWith("many.json", {
        khal: "./khal",
        defaultCalendar: 42,
        calendars: { work: { email: "nope" } },
      });
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config, MCP_KHAL_BIN: "~/khal" });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/mcp-khal cannot start: InvalidInput: 4 problems:/);
      for (const part of [
        "MCP_KHAL_BIN must not start with '~'",
        "config 'khal' must be a bare command name",
        "defaultCalendar must be a calendar name",
        "calendars.work.email is not a valid email address",
      ])
        expect(r.stderr).toContain(part);
    });

    it("but starts when everything checks out", async () => {
      const config = await configWith("fine.json", {
        khal: join(fake.dir, "khal"),
        defaultCalendar: " work ",
        calendars: { work: { email: " me@work.com " }, " home ": { alarm: "none" } },
      });
      const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [CLI],
            env: { PATH: process.env.PATH ?? "", MCP_KHAL_CONFIG: config },
          }),
        );
        const r = await client.callTool({ name: "list_calendars", arguments: {} });
        expect(isError(r)).toBe(false);
      } finally {
        await client.close();
      }
    });
  });

  it("the server refuses to start on a corrupt config and says why", async () => {
    const dir = await tempDir();
    try {
      const config = join(dir, "corrupt.json");
      await writeFile(config, "{ not json");
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/mcp-khal cannot start: InvalidInput: config is not valid JSON/);
    } finally {
      await removeDir(dir);
    }
  });
});
