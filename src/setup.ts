import type { Interface } from "node:readline/promises";
import { Effect, Result } from "effect";
import {
  type CalendarConfig,
  type Calendars,
  interpretAnswer,
  interpretPath,
  isEmail,
  loadConfig,
  parseCalendarNames,
  saveConfig,
} from "./config.js";
import { InvalidInput, ioError, type KhalError } from "./errors.js";
import { calendarsArgs, execute } from "./khal.js";
import { loadSettings, type Settings, type SettingsInput } from "./settings.js";

/** Asks a question with an editable prefilled answer. */
const ask = (
  rl: Interface,
  question: string,
  prefill: string | undefined,
): Effect.Effect<string, KhalError> =>
  Effect.tryPromise({
    try: () => {
      const answer = rl.question(question);
      if (prefill !== undefined) rl.write(prefill);
      return answer;
    },
    catch: ioError,
  });

/** Re-prompts until the answer is valid. Resolves to undefined when skipped. */
export const promptFor = (
  rl: Interface,
  calendar: string,
  current: string | undefined,
): Effect.Effect<string | undefined, KhalError> => {
  // an existing mapping wins; an email-like calendar name is the next best guess
  const fallback = current ?? (isEmail(calendar) ? calendar : undefined);
  const hint = fallback ? "" : " (blank to skip)";
  const loop: Effect.Effect<string | undefined, KhalError> = Effect.flatMap(
    ask(rl, `Your email on '${calendar}'${hint}: `, fallback),
    (answer) =>
      Result.match(interpretAnswer(answer, fallback), {
        onFailure: (msg): Effect.Effect<string | undefined, KhalError> =>
          Effect.flatMap(
            Effect.sync(() => console.error(`  ${msg}`)),
            () => loop,
          ),
        onSuccess: (addr): Effect.Effect<string | undefined, KhalError> => Effect.succeed(addr),
      }),
  );
  return loop;
};

/**
 * Which calendar new events go to when a call names none. Asked only when khal has several
 * calendars; the answer must be one of them. Re-prompts until it is.
 */
export const promptDefaultCalendar = (
  rl: Interface,
  names: readonly string[],
  current: string | undefined,
): Effect.Effect<string, KhalError> => {
  const fallback = current !== undefined && names.includes(current) ? current : undefined;
  const loop: Effect.Effect<string, KhalError> = Effect.flatMap(
    ask(rl, `Calendar for new events when none is named (${names.join(", ")}): `, fallback),
    (answer) => {
      const chosen = answer.trim() === "" ? fallback : answer.trim();
      return chosen !== undefined && names.includes(chosen)
        ? Effect.succeed(chosen)
        : Effect.flatMap(
            Effect.sync(() => console.error(`  must be one of: ${names.join(", ")}`)),
            () => loop,
          );
    },
  );
  return loop;
};

/**
 * Steps through the calendars, prefilling each prompt with the calendar's configured address.
 * Only the address is asked for and changed; everything else configured for a calendar (its
 * reminder, its path) and every calendar khal no longer has stay as they are.
 */
export const configure = (
  rl: Interface,
  names: readonly string[],
  existing: Calendars,
): Effect.Effect<Calendars, KhalError> =>
  Effect.reduce(
    names,
    (): Calendars => existing,
    (acc, name) => {
      const current: CalendarConfig | undefined = Object.hasOwn(acc, name) ? acc[name] : undefined;
      return Effect.map(
        promptFor(rl, name, current?.email),
        (email): Calendars => (email === undefined ? acc : { ...acc, [name]: { ...current, email } }),
      );
    },
  );

/**
 * Asks for the directory of a calendar's .ics files (needed by the tools that change existing
 * events). Blank keeps the configured one, or skips. Re-prompts until the answer is valid.
 */
export const promptPath = (
  rl: Interface,
  calendar: string,
  current: string | undefined,
  taken: readonly string[],
): Effect.Effect<string | undefined, KhalError> => {
  const loop: Effect.Effect<string | undefined, KhalError> = Effect.flatMap(
    ask(rl, `Folder of the .ics files of '${calendar}'${current ? "" : " (blank to skip)"}: `, current),
    (answer) =>
      Result.match(interpretPath(answer, current, taken), {
        onFailure: (msg): Effect.Effect<string | undefined, KhalError> =>
          Effect.flatMap(
            Effect.sync(() => console.error(`  ${msg}`)),
            () => loop,
          ),
        onSuccess: (path): Effect.Effect<string | undefined, KhalError> => Effect.succeed(path),
      }),
  );
  return loop;
};

/** Steps through the calendars asking for their paths; nothing else about a calendar changes. */
export const configurePaths = (
  rl: Interface,
  names: readonly string[],
  existing: Calendars,
): Effect.Effect<Calendars, KhalError> =>
  Effect.reduce(
    names,
    (): Calendars => existing,
    (acc, name) => {
      const current: CalendarConfig | undefined = Object.hasOwn(acc, name) ? acc[name] : undefined;
      const taken = Object.entries(acc).flatMap(([n, c]) =>
        n !== name && c.path !== undefined ? [c.path] : [],
      );
      return Effect.map(
        promptPath(rl, name, current?.path, taken),
        (path): Calendars => (path === undefined ? acc : { ...acc, [name]: { ...current, path } }),
      );
    },
  );

/** The terminal setup talks to; supplied by the edge (cli.ts) and replaceable in tests. */
export interface SetupIo {
  readonly isTTY: boolean;
  readonly openPrompt: () => Interface;
  readonly log: (line: string) => void;
}

export const setup = (settings: Settings, io: SetupIo): Effect.Effect<void, KhalError> =>
  Effect.gen(function* () {
    if (!io.isTTY)
      return yield* Effect.fail(new InvalidInput({ message: "setup needs an interactive terminal." }));

    // khal reports its calendars in no particular order; ask in a stable one
    const names = parseCalendarNames(yield* execute(settings, calendarsArgs())).sort();
    if (names.length === 0)
      return yield* Effect.fail(new InvalidInput({ message: "khal reports no calendars." }));
    // the file's own values, so an MCP_KHAL_BIN override is never written back into it
    const existing = yield* loadConfig(settings.configPath);

    io.log(`Configuring ${names.length} calendar(s). Config: ${settings.configPath}\n`);
    const { calendars, defaultCalendar } = yield* Effect.acquireUseRelease(
      Effect.sync(io.openPrompt),
      (rl) =>
        Effect.gen(function* () {
          const withEmails = yield* configure(rl, names, existing.calendars);
          const calendars = yield* configurePaths(rl, names, withEmails);
          // with one calendar that is the default and nothing is written; with several it is required
          const defaultCalendar =
            names.length > 1 ? yield* promptDefaultCalendar(rl, names, existing.defaultCalendar) : undefined;
          return { calendars, defaultCalendar };
        }),
      (rl) => Effect.sync(() => rl.close()),
    );

    yield* saveConfig(settings.configPath, {
      khal: existing.khal,
      ...(defaultCalendar === undefined ? {} : { defaultCalendar }),
      calendars,
    });
    io.log(`\nSaved ${Object.keys(calendars).length} calendar(s) to ${settings.configPath}`);
  });

/** Loads the settings, runs setup and returns a process exit code. */
export const runSetup = (
  input: SettingsInput,
  io: SetupIo,
  logError: (line: string) => void,
): Promise<number> =>
  Effect.runPromise(
    Effect.match(
      Effect.flatMap(loadSettings(input), (settings) => setup(settings, io)),
      {
        onFailure: (e) => {
          logError(`${e._tag}: ${e.message}`);
          return 1;
        },
        onSuccess: () => 0,
      },
    ),
  );
