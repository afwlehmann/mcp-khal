import type { Interface } from "node:readline/promises";
import { Effect, Result } from "effect";
import {
  type CalendarConfig,
  type Calendars,
  interpretAnswer,
  interpretPath,
  isEmail,
  loadConfig,
  saveConfig,
} from "./config.js";
import { InvalidInput, ioError, type KhalError } from "./errors.js";
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

const say = (line: string): Effect.Effect<void> => Effect.sync(() => console.error(`  ${line}`));

/** Re-prompts until the answer is valid. Resolves to undefined when skipped. */
export const promptFor = (
  rl: Interface,
  calendar: string,
  current: string | undefined,
): Effect.Effect<string | undefined, KhalError> => {
  // an existing address wins; an email-like calendar name is the next best guess
  const fallback = current ?? (isEmail(calendar) ? calendar : undefined);
  const hint = fallback ? "" : " (blank to skip)";
  const loop: Effect.Effect<string | undefined, KhalError> = Effect.flatMap(
    ask(rl, `Your email on '${calendar}'${hint}: `, fallback),
    (answer) =>
      Result.match(interpretAnswer(answer, fallback), {
        onFailure: (msg): Effect.Effect<string | undefined, KhalError> =>
          Effect.flatMap(say(msg), () => loop),
        onSuccess: (addr): Effect.Effect<string | undefined, KhalError> => Effect.succeed(addr),
      }),
  );
  return loop;
};

/**
 * Asks for the directory of a calendar's .ics files. It is required: blank keeps the configured
 * one, and without one the question is asked again. Re-prompts until the answer is valid.
 */
export const promptPath = (
  rl: Interface,
  calendar: string,
  current: string | undefined,
  taken: readonly string[],
): Effect.Effect<string, KhalError> => {
  const loop: Effect.Effect<string, KhalError> = Effect.flatMap(
    ask(rl, `Folder of the .ics files of '${calendar}': `, current),
    (answer) =>
      Result.match(interpretPath(answer, current, taken), {
        onFailure: (msg): Effect.Effect<string, KhalError> => Effect.flatMap(say(msg), () => loop),
        onSuccess: (path): Effect.Effect<string, KhalError> =>
          path === undefined
            ? Effect.flatMap(say("the folder is required"), () => loop)
            : Effect.succeed(path),
      }),
  );
  return loop;
};

/** One calendar: its folder (required), then the user's address (optional). Its reminder stays as it is. */
export const promptCalendar = (
  rl: Interface,
  name: string,
  current: CalendarConfig | undefined,
  taken: readonly string[],
): Effect.Effect<CalendarConfig, KhalError> =>
  Effect.gen(function* () {
    const path = yield* promptPath(rl, name, current?.path, taken);
    const email = yield* promptFor(rl, name, current?.email);
    return { ...current, path, ...(email === undefined ? {} : { email }) };
  });

/** Answer to "name of another calendar": blank finishes; a name must be new and without control characters. */
export const interpretName = (
  answer: string,
  existing: readonly string[],
): Result.Result<string | undefined, string> => {
  const name = answer.trim();
  if (name === "") return Result.succeed(undefined);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name))
    return Result.fail("a calendar name must not contain control characters");
  return existing.includes(name) ? Result.fail(`'${name}' is already configured`) : Result.succeed(name);
};

/**
 * Which calendar new events go to when a call names none. Asked only when there are several
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
        : Effect.flatMap(say(`must be one of: ${names.join(", ")}`), () => loop);
    },
  );
  return loop;
};

/** Asks for the folder and address of every configured calendar, then offers to add more. */
export const configure = (rl: Interface, existing: Calendars): Effect.Effect<Calendars, KhalError> =>
  Effect.gen(function* () {
    let calendars: Calendars = existing;
    const pathsExcept = (name: string): string[] =>
      Object.entries(calendars).flatMap(([n, c]) => (n === name ? [] : [c.path]));

    for (const name of Object.keys(existing).sort()) {
      const asked = yield* promptCalendar(rl, name, calendars[name], pathsExcept(name));
      calendars = { ...calendars, [name]: asked };
    }

    for (;;) {
      const names = Object.keys(calendars);
      const answer = yield* ask(
        rl,
        names.length === 0 ? "Name of the first calendar: " : "Name of another calendar (blank to finish): ",
        undefined,
      );
      const name = yield* Result.match(interpretName(answer, names), {
        onFailure: (msg): Effect.Effect<string | undefined | null, KhalError> =>
          Effect.flatMap(say(msg), () => Effect.succeed(null)),
        onSuccess: (n): Effect.Effect<string | undefined | null, KhalError> => Effect.succeed(n),
      });
      if (name === null) continue;
      if (name === undefined) {
        if (names.length === 0) {
          yield* say("at least one calendar is needed");
          continue;
        }
        return calendars;
      }
      const added = yield* promptCalendar(rl, name, undefined, pathsExcept(name));
      calendars = { ...calendars, [name]: added };
    }
  });

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

    const existing = yield* loadConfig(settings.configPath);

    io.log(`Configuring calendars. Config: ${settings.configPath}\n`);
    const { calendars, defaultCalendar } = yield* Effect.acquireUseRelease(
      Effect.sync(io.openPrompt),
      (rl) =>
        Effect.gen(function* () {
          const calendars = yield* configure(rl, existing.calendars);
          const names = Object.keys(calendars).sort();
          // with one calendar that is the default and nothing is written; with several it is required
          const defaultCalendar =
            names.length > 1 ? yield* promptDefaultCalendar(rl, names, existing.defaultCalendar) : undefined;
          return { calendars, defaultCalendar };
        }),
      (rl) => Effect.sync(() => rl.close()),
    );

    yield* saveConfig(settings.configPath, {
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
