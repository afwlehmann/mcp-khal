import { access, constants } from "node:fs/promises";
import { Effect, Result } from "effect";
import { parseCalendarNames } from "./config.js";
import type { KhalError } from "./errors.js";
import { calendarsArgs, execute, runKhal } from "./khal.js";
import type { Settings } from "./settings.js";
import { collect, problem, toInvalidInput, type Validated, valid } from "./validation.js";

/** Names the config mentions that khal does not know (compared exactly, after trimming). */
export const unknownCalendars = (configured: readonly string[], known: readonly string[]): string[] =>
  configured.filter((name) => !known.includes(name));

/** Runs an effect as a validation: a failure becomes one problem instead of aborting the checks. */
const attempt = <A>(
  eff: Effect.Effect<A, KhalError>,
  describe: (e: KhalError) => string,
): Effect.Effect<Validated<A>> =>
  Effect.match(eff, { onFailure: (e) => problem(describe(e)), onSuccess: (a) => valid(a) });

const checkCalendars = (settings: Settings, known: string): Validated<void> => {
  const names = parseCalendarNames(known);
  const unknown = unknownCalendars(Object.keys(settings.calendars), names);
  return unknown.length === 0
    ? valid(undefined)
    : problem(
        `the config names calendars that khal does not know: ${unknown.join(", ")} (khal has: ${names.join(", ") || "none"})`,
      );
};

/**
 * Checks at server start that what the configuration says matches the machine. All checks run and
 * all their problems are reported together. The calendar check needs a working khal, so it is
 * skipped (not repeated as a second problem) when khal itself cannot be run.
 */
export const preflight = (settings: Settings): Effect.Effect<void, KhalError> =>
  Effect.gen(function* () {
    const configFile: Validated<void> =
      settings.configSource === "MCP_KHAL_CONFIG" && !settings.configFound
        ? problem(`MCP_KHAL_CONFIG points to ${settings.configPath}, which does not exist`)
        : valid(undefined);

    const tmpDir = yield* attempt(
      Effect.tryPromise({
        try: () => access(settings.tmpDir, constants.W_OK),
        catch: (u) => u as KhalError,
      }),
      () => `the temporary directory ${settings.tmpDir} does not exist or is not writable`,
    );

    const khalRuns = yield* attempt(
      runKhal(settings, ["--version"]),
      (e) => `khal (${settings.khal}, from ${settings.khalSource}) cannot be run: ${e._tag}: ${e.message}`,
    );

    const calendars: Validated<void> = yield* Result.isSuccess(khalRuns)
      ? Effect.map(
          attempt(
            execute(settings, calendarsArgs()),
            (e) => `khal cannot list its calendars: ${e._tag}: ${e.message}`,
          ),
          (listed) => Result.flatMap(listed, (out) => checkCalendars(settings, out)),
        )
      : Effect.succeed(valid(undefined));

    return yield* Result.match(collect({ configFile, tmpDir, khalRuns, calendars }), {
      onFailure: (problems) => Effect.fail(toInvalidInput(problems)),
      onSuccess: () => Effect.void,
    });
  });
