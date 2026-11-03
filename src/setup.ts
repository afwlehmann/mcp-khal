import type { Interface } from "node:readline/promises";
import { Effect, Result } from "effect";
import {
  interpretAnswer,
  isEmail,
  loadConfig,
  type Mapping,
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

/** Steps through the calendars, prefilling each prompt from the accumulated mapping. */
export const configure = (
  rl: Interface,
  names: readonly string[],
  existing: Mapping,
): Effect.Effect<Mapping, KhalError> =>
  Effect.reduce(
    names,
    (): Mapping => existing,
    (acc, name) =>
      Effect.map(
        promptFor(rl, name, acc[name]),
        (addr): Mapping => (addr === undefined ? acc : { ...acc, [name]: addr }),
      ),
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

    const names = parseCalendarNames(yield* execute(settings, calendarsArgs()));
    if (names.length === 0)
      return yield* Effect.fail(new InvalidInput({ message: "khal reports no calendars." }));
    // the file's own values, so an MCP_KHAL_BIN override is never written back into it
    const existing = yield* loadConfig(settings.configPath);

    io.log(`Configuring ${names.length} calendar(s). Config: ${settings.configPath}\n`);
    const mapping = yield* Effect.acquireUseRelease(
      Effect.sync(io.openPrompt),
      (rl) => configure(rl, names, existing.calendarEmails),
      (rl) => Effect.sync(() => rl.close()),
    );

    yield* saveConfig(settings.configPath, { ...existing, calendarEmails: mapping });
    io.log(`\nSaved ${Object.keys(mapping).length} mapping(s) to ${settings.configPath}`);
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
