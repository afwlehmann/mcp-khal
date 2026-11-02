import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import {
  InvalidInput, NonZeroExit, NotInstalled, Timeout, ioError, type KhalError,
} from "./errors.js";

/** Pure validation outcome. */
type V<A> = Result.Result<A, InvalidInput>;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

// ---------- pure validation ----------

const nonEmpty = (field: string) => (s: string): V<string> => {
  const t = s.trim();
  return t === "" ? Result.fail(invalid(`${field} must not be empty`)) : Result.succeed(t);
};

const noControlChars = (field: string) => (s: string): V<string> =>
  /[\u0000-\u0008\u000b-\u001f]/.test(s)
    ? Result.fail(invalid(`${field} contains control characters`))
    : Result.succeed(s);

/** A single value that can never be mistaken for an option. */
const safeToken = (field: string) => (s: string): V<string> =>
  Result.gen(function* () {
    const t = yield* nonEmpty(field)(s);
    if (t.startsWith("-")) return yield* Result.fail(invalid(`${field} must not start with '-'`));
    return yield* noControlChars(field)(t);
  });

/** Like safeToken but allows internal whitespace (e.g. "today 7d"); each word is checked. */
const safeTokenWords = (field: string) => (s: string): V<string> =>
  Result.gen(function* () {
    const words = yield* Result.all(s.trim().split(/\s+/).map(safeToken(field)));
    return words.join(" ");
  });

const optional =
  (v: (s: string) => V<string>) =>
  (s: string | undefined): V<string | undefined> =>
    s === undefined ? Result.succeed(undefined) : v(s);

const flag = (name: string, v: string | undefined): readonly string[] =>
  v === undefined ? [] : [name, v];

// ---------- pure argv builders ----------

export const EVENT_FORMAT =
  "{calendar}|{start-date}|{start-time}|{end-date}|{end-time}|{title}|{location}|{description}";

export interface ListParams { range?: string; calendar?: string }
export interface RangeParams { start: string; end: string; calendar?: string }
export interface SearchParams { query: string; calendar?: string }
export interface NewParams {
  calendar?: string;
  start: string;
  end?: string;
  summary: string;
  location?: string;
  description?: string;
  alarm?: string;
}

export const calendarsArgs = (): V<readonly string[]> => Result.succeed(["printcalendars"]);

export const listArgs = (p: ListParams): V<readonly string[]> =>
  Result.gen(function* () {
    const range = (yield* optional(safeTokenWords("range"))(p.range)) ?? "today 7d";
    const cal = yield* optional(safeToken("calendar"))(p.calendar);
    return [
      "list", ...flag("-a", cal), "--day-format", "", "--format", EVENT_FORMAT, ...range.split(/\s+/),
    ];
  });

/** Events intersecting [start, end]; overlap semantics are delegated to `khal list`. */
export const rangeArgs = (p: RangeParams): V<readonly string[]> =>
  Result.gen(function* () {
    const start = yield* safeTokenWords("start")(p.start);
    const end = yield* safeTokenWords("end")(p.end);
    return yield* listArgs({ range: `${start} ${end}`, calendar: p.calendar });
  });

export const searchArgs = (p: SearchParams): V<readonly string[]> =>
  Result.gen(function* () {
    const query = yield* safeToken("query")(p.query);
    const cal = yield* optional(safeToken("calendar"))(p.calendar);
    return ["search", ...flag("-a", cal), "--format", EVENT_FORMAT, "--", query];
  });

export const newArgs = (p: NewParams): V<readonly string[]> =>
  Result.gen(function* () {
    const cal = yield* optional(safeToken("calendar"))(p.calendar);
    const start = yield* safeTokenWords("start")(p.start);
    const end = yield* optional(safeTokenWords("end"))(p.end);
    const summary = yield* safeToken("summary")(p.summary);
    const loc = yield* optional((s) => Result.flatMap(nonEmpty("location")(s), noControlChars("location")))(p.location);
    const desc = yield* optional(noControlChars("description"))(p.description);
    const alarm = yield* optional(safeToken("alarm"))(p.alarm);
    return [
      "new", ...flag("-a", cal), ...flag("-l", loc), ...flag("-m", alarm), "--",
      ...start.split(/\s+/),
      ...(end === undefined ? [] : end.split(/\s+/)),
      summary,
      ...(desc === undefined ? [] : ["::", desc]),
    ];
  });

// ---------- effects ----------

const classify = (
  e: NodeJS.ErrnoException & { killed?: boolean },
  stdout: string,
  stderr: string,
  timeoutMs: number,
): KhalError =>
  e.code === "ENOENT"
    ? new NotInstalled({ message: "khal executable not found on PATH" })
    : e.killed
      ? new Timeout({ message: `khal timed out after ${timeoutMs}ms` })
      : new NonZeroExit({
          code: typeof e.code === "number" ? e.code : null,
          message: (stderr || stdout || e.message).trim(),
        });

/** Runs khal without a shell; the child is killed if the fiber is interrupted. */
export const runKhal = (args: readonly string[], timeoutMs = 15_000): Effect.Effect<string, KhalError> =>
  Effect.callback<string, KhalError>((resume) => {
    const child = execFile(
      "khal",
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C.UTF-8" } },
      (error, stdout, stderr) =>
        error
          ? resume(Effect.fail(classify(error as NodeJS.ErrnoException, stdout, stderr, timeoutMs)))
          : resume(Effect.succeed(stdout)),
    );
    return Effect.sync(() => {
      child.kill();
    });
  });

/** Run a validated argv. */
export const execute = (build: V<readonly string[]>): Effect.Effect<string, KhalError> =>
  Effect.flatMap(Effect.fromResult(build), (args) => runKhal(args));

/** Write ics to a temp dir, `khal import` it, and always clean up. */
export const importIcs = (calendar: string | undefined, ics: string): Effect.Effect<string, KhalError> =>
  Effect.gen(function* () {
    const cal = yield* Effect.fromResult(optional(safeToken("calendar"))(calendar));
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "mcp-khal-")), catch: ioError }),
      (dir) =>
        Effect.gen(function* () {
          const file = join(dir, "event.ics");
          yield* Effect.tryPromise({ try: () => writeFile(file, ics, "utf8"), catch: ioError });
          return yield* runKhal(["import", ...flag("-a", cal), "--batch", file]);
        }),
      (dir) =>
        Effect.tryPromise({ try: () => rm(dir, { recursive: true, force: true }), catch: ioError }).pipe(
          Effect.orElseSucceed(() => undefined),
        ),
    );
  });

// ---------- output parsing ----------

export interface KhalEvent {
  calendar: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  title: string;
  location: string;
  description: string;
}

export const parseEvents = (stdout: string): KhalEvent[] =>
  stdout
    .split("\n")
    .filter((l) => l.split("|").length >= 8)
    .map((l) => {
      const [calendar, startDate, startTime, endDate, endTime, title, location, ...rest] = l.split("|");
      return {
        calendar: calendar!, startDate: startDate!, startTime: startTime!,
        endDate: endDate!, endTime: endTime!, title: title!,
        location: location!, description: rest.join("|"),
      };
    });
