import { createInterface, type Interface } from "node:readline/promises";
import { Effect, Result } from "effect";
import {
  defaultConfigPath,
  interpretAnswer,
  isEmail,
  loadMapping,
  type Mapping,
  parseCalendarNames,
  saveMapping,
} from "./config.js";
import { InvalidInput, ioError, type KhalError } from "./errors.js";
import { calendarsArgs, execute } from "./khal.js";

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

/** The terminal and filesystem location setup works with; injectable for tests. */
export interface SetupIo {
  readonly isTTY: boolean;
  readonly path: string;
  readonly openPrompt: () => Interface;
  readonly log: (line: string) => void;
}

export const setup = (io: SetupIo): Effect.Effect<void, KhalError> =>
  Effect.gen(function* () {
    if (!io.isTTY)
      return yield* Effect.fail(new InvalidInput({ message: "setup needs an interactive terminal." }));

    const names = parseCalendarNames(yield* execute(calendarsArgs()));
    if (names.length === 0)
      return yield* Effect.fail(new InvalidInput({ message: "khal reports no calendars." }));
    const existing = yield* loadMapping(io.path);

    io.log(`Configuring ${names.length} calendar(s). Config: ${io.path}\n`);
    const mapping = yield* Effect.acquireUseRelease(
      Effect.sync(io.openPrompt),
      (rl) => configure(rl, names, existing),
      (rl) => Effect.sync(() => rl.close()),
    );

    yield* saveMapping(io.path, mapping);
    io.log(`\nSaved ${Object.keys(mapping).length} mapping(s) to ${io.path}`);
  });

const processIo = (): SetupIo => ({
  isTTY: Boolean(process.stdin.isTTY),
  path: defaultConfigPath(),
  openPrompt: () => createInterface({ input: process.stdin, output: process.stdout }),
  log: (line) => console.log(line),
});

/** Returns a process exit code. */
export const runSetup = (): Promise<number> =>
  Effect.runPromise(
    Effect.match(setup(processIo()), {
      onFailure: (e) => {
        console.error(`${e._tag}: ${e.message}`);
        return 1;
      },
      onSuccess: () => 0,
    }),
  );
