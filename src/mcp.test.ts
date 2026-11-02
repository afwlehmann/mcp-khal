import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeMapping } from "./config.js";
import { type FakeKhal, fakeKhal, removeDir, tempDir } from "./testlib.js";

// the compiled server; vitest.global-setup.ts rebuilds dist/ before the run
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

describe("MCP server over stdio", () => {
  let fake: FakeKhal;
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    fake = await fakeKhal({
      stdout: "work|2026-11-01|10:00|2026-11-01|11:00|Lunch|Cafe|notes\n",
    });
    dir = await tempDir();
    const config = join(dir, "cfg.json");
    await writeFile(config, serializeMapping({ work: "me@work.com" }));
    client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI],
        env: { PATH: `${fake.dir}:${process.env.PATH ?? ""}`, MCP_KHAL_CONFIG: config },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await fake.cleanup();
    await removeDir(dir);
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

  it("new_event invites attendees using the mapped organizer", async () => {
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
    expect((await fake.imported()) ?? "").toMatch(/ORGANIZER:mailto:me@work\.com/);
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
    const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [CLI],
          env: { PATH: `${failing.dir}:${process.env.PATH ?? ""}` },
        }),
      );
      const r = await client.callTool({ name: "list_calendars", arguments: {} });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toMatch(/NonZeroExit: calendar exploded/);
    } finally {
      await client.close();
      await failing.cleanup();
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
    const r = await run(["setup"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/InvalidInput: setup needs an interactive terminal/);
  });
});
