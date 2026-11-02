import { createInterface, type Interface } from "node:readline/promises";
import { Effect, Result } from "effect";
import {
  defaultConfigPath, interpretAnswer, isEmail, loadMapping, parseCalendarNames, saveMapping,
  type Mapping,
} from "./config.js";
import { InvalidInput, type KhalError } from "./errors.js";
import { calendarsArgs, execute } from "./khal.js";

/** Asks a question with an editable prefilled answer. */
const ask = (rl: Interface, question: string, prefill: string | undefined): Effect.Effect<string> =>
  Effect.promise(() => {
    const answer = rl.question(question);
    if (prefill !== undefined) rl.write(prefill);
    return answer;
  });

/** Re-prompts until the answer is valid. Resolves to undefined when skipped. */
const promptFor = (
  rl: Interface,
  calendar: string,
  current: string | undefined,
): Effect.Effect<string | undefined> => {
  // an existing mapping wins; an email-like calendar name is the next best guess
  const fallback = current ?? (isEmail(calendar) ? calendar : undefined);
  const hint = fallback ? "" : " (blank to skip)";
  const loop: Effect.Effect<string | undefined> = Effect.flatMap(
    ask(rl, `Your email on '${calendar}'${hint}: `, fallback),
    (answer) =>
      Result.match(interpretAnswer(answer, fallback), {
        onFailure: (msg): Effect.Effect<string | undefined> =>
          Effect.flatMap(Effect.sync(() => console.error(`  ${msg}`)), () => loop),
        onSuccess: (addr): Effect.Effect<string | undefined> => Effect.succeed(addr),
      }),
  );
  return loop;
};

const program: Effect.Effect<void, KhalError> = Effect.gen(function* () {
  if (!process.stdin.isTTY)
    return yield* Effect.fail(new InvalidInput({ message: "setup needs an interactive terminal." }));

  const path = defaultConfigPath();
  const names = parseCalendarNames(yield* execute(calendarsArgs()));
  if (names.length === 0) return yield* Effect.fail(new InvalidInput({ message: "khal reports no calendars." }));
  const existing = yield* loadMapping(path);

  console.log(`Configuring ${names.length} calendar(s). Config: ${path}\n`);
  const mapping = yield* Effect.acquireUseRelease(
    Effect.sync(() => createInterface({ input: process.stdin, output: process.stdout })),
    (rl) =>
      Effect.reduce(
        names,
        (): Mapping => existing,
        (acc, name) =>
          Effect.map(promptFor(rl, name, acc[name]), (addr): Mapping =>
            addr === undefined ? acc : { ...acc, [name]: addr },
          ),
      ),
    (rl) => Effect.sync(() => rl.close()),
  );

  yield* saveMapping(path, mapping);
  console.log(`\nSaved ${Object.keys(mapping).length} mapping(s) to ${path}`);
});

/** Returns a process exit code. */
export const runSetup = (): Promise<number> =>
  Effect.runPromise(
    Effect.match(program, {
      onFailure: (e) => {
        console.error(`${e._tag}: ${e.message}`);
        return 1;
      },
      onSuccess: () => 0,
    }),
  );
