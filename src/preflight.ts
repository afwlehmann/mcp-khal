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

/** khal reports its calendars in no particular order; anything shown to the user is sorted. */
const sorted = (names: readonly string[]): string[] => [...names].sort();

/** Runs an effect as a validation: a failure becomes one problem instead of aborting the checks. */
const attempt = <A>(
  eff: Effect.Effect<A, KhalError>,
  describe: (e: KhalError) => string,
): Effect.Effect<Validated<A>> =>
  Effect.match(eff, { onFailure: (e) => problem(describe(e)), onSuccess: (a) => valid(a) });

/**
 * The calendars of the config against the calendars khal has. Returns the calendar new events go
 * to when a call names none: the configured `defaultCalendar`, which has to exist, or the only
 * calendar khal has. With several calendars the default must be configured: asking khal for its
 * own default by name is not enough, so nothing is guessed.
 */
export const checkCalendars = (settings: Settings, names: readonly string[]): Validated<string> => {
  const has = sorted(names).join(", ") || "none";
  const unknown = sorted(unknownCalendars(Object.keys(settings.calendars), names));
  const { defaultCalendar } = settings;
  const [only] = names;

  const configured: Validated<undefined> =
    unknown.length === 0
      ? valid(undefined)
      : problem(
          `the config names calendars that khal does not know: ${unknown.join(", ")} (khal has: ${has})`,
        );

  const fallback: Validated<string> =
    only !== undefined && names.length === 1
      ? valid(only)
      : problem(
          names.length === 0
            ? "khal has no calendars: there is nowhere to create events"
            : `khal has several calendars (${has}): set "defaultCalendar" to the one new events go to when a call names no calendar`,
        );

  const effective: Validated<string> =
    defaultCalendar === undefined
      ? fallback
      : names.includes(defaultCalendar)
        ? valid(defaultCalendar)
        : problem(`defaultCalendar '${defaultCalendar}' does not exist in khal (khal has: ${has})`);

  return Result.map(collect({ configured, effective }), (v) => v.effective);
};

/**
 * Checks at server start that what the configuration says matches the machine. All checks run and
 * all their problems are reported together. The calendar checks need a working khal, so they are
 * skipped (not repeated as a second problem) when khal itself cannot be run.
 *
 * Returns the settings with the default calendar filled in, so the rest of the server always
 * knows which calendar a new event goes to.
 */
export const preflight = (settings: Settings): Effect.Effect<Settings, KhalError> =>
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

    const calendars: Validated<string | undefined> = yield* Result.isSuccess(khalRuns)
      ? Effect.map(
          attempt(
            execute(settings, calendarsArgs()),
            (e) => `khal cannot list its calendars: ${e._tag}: ${e.message}`,
          ),
          (listed) => Result.flatMap(listed, (out) => checkCalendars(settings, parseCalendarNames(out))),
        )
      : Effect.succeed(valid(undefined));

    return yield* Result.match(collect({ configFile, tmpDir, khalRuns, calendars }), {
      onFailure: (problems) => Effect.fail(toInvalidInput(problems)),
      onSuccess: (v) =>
        Effect.succeed<Settings>({
          ...settings,
          ...(v.calendars === undefined ? {} : { defaultCalendar: v.calendars }),
        }),
    });
  });
