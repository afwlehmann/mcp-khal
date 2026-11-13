import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** The vdir of a calendar, or why there is none. */
export const vdirOf = (settings: Settings, calendar: string): string | InvalidInput => {
  const name = calendar.trim();
  if (name === "" || CONTROL.test(name)) return invalid("calendar must be a calendar name");
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
    if (wanted === "" || CONTROL.test(wanted))
      return yield* Effect.fail(invalid("uid must not be empty or contain control characters"));
    const dir = vdirOf(settings, calendar);
    if (typeof dir !== "string") return yield* Effect.fail(dir);
    const names = yield* Effect.tryPromise({ try: () => readdir(dir), catch: ioError });
    const stored = yield* Effect.forEach(
      names.filter((n) => n.endsWith(".ics")),
      (name) =>
        Effect.tryPromise({
          try: async (): Promise<StoredEvent> => ({
            file: join(dir, name),
            lines: unfoldLines(await readFile(join(dir, name), "utf8")),
          }),
          catch: ioError,
        }),
      { concurrency: 8 },
    );
    const found = stored.find((s) => uidOf(s.lines) === wanted);
    return found === undefined
      ? yield* Effect.fail(invalid(`no event with uid '${wanted}' in calendar '${calendar.trim()}'`))
      : found;
  });

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
