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
        calendarEmails: { work: "me@work.com" },
        defaultAlarm: "none",
        calendarAlarms: {},
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

  it("names the configured binary when it cannot be found", async () => {
    const r = await listCalendars("/does/not/exist/khal");
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/NotInstalled: khal executable '\/does\/not\/exist\/khal' not found/);
  });
});

describe("the server process logs its configuration at startup", () => {
  it("writes one line to stderr with the effective khal and masked addresses, never the environment", async () => {
    const dir = await tempDir();
    const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    let serverLog = "";
    try {
      const config = join(dir, "cfg.json");
      await writeFile(
        config,
        serializeConfig({
          khal: "/cfg/khal",
          calendarEmails: { work: "me@work.com" },
          defaultAlarm: "none",
          calendarAlarms: {},
        }),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI],
        env: {
          PATH: process.env.PATH ?? "",
          MCP_KHAL_CONFIG: config,
          MCP_KHAL_BIN: "/env/khal",
          API_TOKEN: "t0ps3cret",
        },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        serverLog += chunk.toString();
      });
      await client.connect(transport);
      await vi.waitFor(() => expect(serverLog).toMatch(/mcp-khal starting with configuration/));
      expect(serverLog).toContain('"binary":"/env/khal","source":"MCP_KHAL_BIN"');
      expect(serverLog).toContain(`"configPath":${JSON.stringify(config)}`);
      expect(serverLog).toContain("m***@work.com");
      expect(serverLog).not.toContain("me@work.com");
      expect(serverLog).not.toContain("t0ps3cret");
    } finally {
      await client.close();
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
      await writeFile(config, '{"calendarAlarms":{"work":"in an hour"}}');
      const r = await run([], { ...env, MCP_KHAL_CONFIG: config });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /mcp-khal cannot start: InvalidInput: calendarAlarms entry 'work' must be a reminder like 30m, 2h or 1d/,
      );
    } finally {
      await removeDir(dir);
    }
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
