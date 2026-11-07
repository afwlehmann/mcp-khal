import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import type { Settings } from "./settings.js";

/** Test helpers; excluded from the production build. */
export const unwrap = <A, E>(r: Result.Result<A, E>): A =>
  Result.match(r, {
    onFailure: (e) => {
      throw new Error(`expected success, got ${JSON.stringify(e)}`);
    },
    onSuccess: (a) => a,
  });

export const failure = <A, E>(r: Result.Result<A, E>): E =>
  Result.match(r, {
    onFailure: (e) => e,
    onSuccess: () => {
      throw new Error("expected failure");
    },
  });

/** Undo RFC 5545 line folding. */
export const unfold = (ics: string): string => ics.replace(/\r\n /g, "");

/** Runs an effect and returns its outcome as a plain value. */
export const outcome = <A, E>(
  eff: Effect.Effect<A, E>,
): Promise<{ ok: true; value: A } | { ok: false; error: E }> =>
  Effect.runPromise(
    Effect.match(eff, {
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );

export const runOk = async <A, E>(eff: Effect.Effect<A, E>): Promise<A> => {
  const o = await outcome(eff);
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o.value;
};

export const runFail = async <A, E>(eff: Effect.Effect<A, E>): Promise<E> => {
  const o = await outcome(eff);
  if (o.ok) throw new Error("expected failure");
  return o.error;
};

export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "mcp-khal-test-"));

export const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

/** Settings for tests; nothing is read from the real environment except PATH for the shell tools. */
export const testSettings = (overrides: Partial<Settings> = {}): Settings => ({
  khal: "khal",
  khalSource: "config",
  defaultAlarm: "none",
  calendars: {},
  configPath: join(tmpdir(), "mcp-khal-tests-no-such-dir", "mcp-khal.json"),
  configSource: "default",
  configFound: true,
  childEnv: { PATH: process.env.PATH },
  tmpDir: tmpdir(),
  timeoutMs: 15_000,
  ...overrides,
});

export interface FakeKhalOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
  /** seconds to sleep before answering, to provoke timeouts */
  readonly sleep?: number;
  /** exit with 1 and the stderr text when the first argument is this subcommand; others succeed */
  readonly failOn?: string;
}

export interface FakeKhal {
  /** directory containing the fake `khal` executable */
  readonly dir: string;
  /** settings that run this fake khal */
  readonly settings: (overrides?: Partial<Settings>) => Settings;
  /** every invocation's argv, in order */
  readonly calls: () => Promise<string[][]>;
  /** contents of the last file passed to `khal import`, if any */
  readonly imported: () => Promise<string | undefined>;
  /** the value of MCP_TEST_MARK in the environment khal was started with */
  readonly mark: () => Promise<string | undefined>;
  readonly cleanup: () => Promise<void>;
}

/** A stand-in `khal` executable that records its argv and answers with canned output. */
export const fakeKhal = async (opts: FakeKhalOptions = {}): Promise<FakeKhal> => {
  const dir = await tempDir();
  const script = `#!/bin/sh
{ for a in "$@"; do printf '%s\\n' "$a"; done; printf '%s\\n' '--end--'; } >> "${dir}/calls.log"
printf '%s' "\${MCP_TEST_MARK-unset}" > "${dir}/mark"
if [ "$1" = "import" ]; then for last; do :; done; cp "$last" "${dir}/imported.ics"; fi
if [ -f "${dir}/sleep" ]; then sleep "$(cat "${dir}/sleep")"; fi
if [ -f "${dir}/failon" ] && [ "$1" = "$(cat "${dir}/failon")" ]; then cat "${dir}/err" >&2; exit 1; fi
cat "${dir}/out"
cat "${dir}/err" >&2
exit "$(cat "${dir}/exit")"
`;
  await writeFile(join(dir, "out"), opts.stdout ?? "");
  await writeFile(join(dir, "err"), opts.stderr ?? "");
  await writeFile(join(dir, "exit"), String(opts.exit ?? 0));
  if (opts.sleep !== undefined) await writeFile(join(dir, "sleep"), String(opts.sleep));
  if (opts.failOn !== undefined) await writeFile(join(dir, "failon"), opts.failOn);
  await writeFile(join(dir, "khal"), script);
  await chmod(join(dir, "khal"), 0o755);

  const read = (name: string): Promise<string | undefined> =>
    readFile(join(dir, name), "utf8").catch(() => undefined);

  return {
    dir,
    settings: (overrides = {}) =>
      testSettings({ khal: join(dir, "khal"), configPath: join(dir, "cfg.json"), ...overrides }),
    calls: async () => {
      const log = (await read("calls.log")) ?? "";
      return log
        .split("--end--\n")
        .filter((block) => block !== "")
        .map((block) => block.split("\n").slice(0, -1));
    },
    imported: () => read("imported.ics"),
    mark: () => read("mark"),
    cleanup: () => removeDir(dir),
  };
};
