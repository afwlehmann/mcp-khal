import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

/** Settings for tests; nothing is read from the real environment. */
export const testSettings = (overrides: Partial<Settings> = {}): Settings => ({
  calendars: {},
  configPath: join(tmpdir(), "mcp-khal-tests-no-such-dir", "mcp-khal.json"),
  configSource: "default",
  configFound: true,
  timezone: "Europe/Berlin",
  ...overrides,
});

/** A temporary sandbox with one vdir (`work/`) and a config path; removed by `cleanup`. */
export interface Sandbox {
  readonly dir: string;
  /** the vdir of the calendar named `name`, created on demand */
  readonly vdir: (name: string) => Promise<string>;
  /** settings whose calendars are the given names, each with its own vdir under the sandbox */
  readonly settings: (names?: readonly string[], overrides?: Partial<Settings>) => Promise<Settings>;
  readonly read: (relative: string) => Promise<string | undefined>;
  readonly cleanup: () => Promise<void>;
}

export const sandbox = async (): Promise<Sandbox> => {
  const dir = await tempDir();
  const vdir = async (name: string): Promise<string> => {
    const path = join(dir, "calendars", name);
    await mkdir(path, { recursive: true });
    return path;
  };
  return {
    dir,
    vdir,
    settings: async (names = ["work"], overrides = {}) => {
      const calendars = Object.fromEntries(
        await Promise.all(names.map(async (n) => [n, { path: await vdir(n) }] as const)),
      );
      return testSettings({ calendars, configPath: join(dir, "cfg.json"), ...overrides });
    },
    read: (relative) => readFile(join(dir, relative), "utf8").catch(() => undefined),
    cleanup: () => removeDir(dir),
  };
};
