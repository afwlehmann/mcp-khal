import { link, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import { calendarOf } from "./config.js";
import { InvalidInput, ioError, type KhalError } from "./errors.js";
import { serialize, uidOf, unfoldLines } from "./ics.js";
import type { Settings } from "./settings.js";

// Effects on a calendar's vdir (the directory of .ics files). khal sees a change on its next run.

export interface StoredEvent {
  /** absolute path of the .ics file */
  readonly file: string;
  readonly lines: readonly string[];
}

/** control characters and line/paragraph separators */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

/** Longest calendar name or uid accepted. */
export const MAX_NAME = 255;

/** Files bigger than this are not events: they are skipped instead of being read into memory. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The path of a new file in a vdir. The name is a single plain file name (letters, digits and
 * `._@-`, not starting with a dot), so it can never leave the directory or hide.
 */
export const newFileIn = (dir: string, name: string): string | InvalidInput =>
  /^[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,200}$/.test(name)
    ? join(dir, name)
    : invalid(`'${name}' is not a safe file name`);

/** The vdir of a calendar, or why there is none. */
export const vdirOf = (settings: Settings, calendar: string): string | InvalidInput => {
  const name = calendar.trim();
  if (name === "" || name.length > MAX_NAME || CONTROL.test(name))
    return invalid(
      `calendar must be a calendar name (at most ${MAX_NAME} characters, no control characters)`,
    );
  return (
    calendarOf(settings.calendars, name)?.path ??
    invalid(
      `calendar '${name}' has no path configured: set calendars.${name}.path in the config (the directory of its .ics files) to change existing events`,
    )
  );
};

/** Finds the .ics file holding the event with this UID. */
export const findEvent = (
  settings: Settings,
  calendar: string,
  uid: string,
): Effect.Effect<StoredEvent, KhalError> =>
  Effect.gen(function* () {
    const wanted = uid.trim();
    if (wanted === "" || wanted.length > MAX_NAME || CONTROL.test(wanted))
      return yield* Effect.fail(
        invalid(`uid must not be empty, longer than ${MAX_NAME} characters or contain control characters`),
      );
    const dir = vdirOf(settings, calendar);
    if (typeof dir !== "string") return yield* Effect.fail(dir);
    const names = yield* Effect.tryPromise({ try: () => readdir(dir), catch: ioError });
    const stored = yield* Effect.forEach(
      names.filter((n) => n.endsWith(".ics")),
      (name) =>
        Effect.tryPromise({
          try: async (): Promise<StoredEvent | undefined> => {
            const file = join(dir, name);
            const info = await stat(file);
            return info.isFile() && info.size <= MAX_FILE_BYTES
              ? { file, lines: unfoldLines(await readFile(file, "utf8")) }
              : undefined;
          },
          catch: ioError,
        }),
      { concurrency: 8 },
    );
    const found = stored.find((s) => s !== undefined && uidOf(s.lines) === wanted);
    return found === undefined
      ? yield* Effect.fail(invalid(`no event with uid '${wanted}' in calendar '${calendar.trim()}'`))
      : found;
  });

/** Creates a new file, failing (and changing nothing) when one with that name exists already. */
export const createEvent = (file: string, lines: readonly string[]): Effect.Effect<void, KhalError> => {
  const tmp = join(dirname(file), `.${basename(file)}.mcp-khal.tmp`);
  return Effect.tryPromise({
    try: async () => {
      await rm(tmp, { force: true }); // left behind by a crashed run
      await writeFile(tmp, serialize(lines), { encoding: "utf8", flag: "wx" });
      await link(tmp, file);
    },
    catch: ioError,
  }).pipe(Effect.ensuring(Effect.promise(() => rm(tmp, { force: true }))));
};

/** Replaces the file atomically (write next to it, then rename), so khal never sees half a file. */
export const writeEvent = (file: string, lines: readonly string[]): Effect.Effect<void, KhalError> => {
  const tmp = join(dirname(file), `.${basename(file)}.mcp-khal.tmp`);
  return Effect.tryPromise({
    try: async () => {
      await writeFile(tmp, serialize(lines), "utf8");
      await rename(tmp, file);
    },
    catch: ioError,
  }).pipe(Effect.tapError(() => Effect.promise(() => rm(tmp, { force: true }))));
};
