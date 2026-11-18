import { access, constants, stat } from "node:fs/promises";
import { Effect, Result } from "effect";
import type { AppError } from "./errors.js";
import type { Settings } from "./settings.js";
import { collect, collectAll, problem, toInvalidInput, type Validated, valid } from "./validation.js";

/** Runs an effect as a validation: a failure becomes one problem instead of aborting the checks. */
const attempt = <A>(
  eff: Effect.Effect<A, AppError>,
  describe: (e: AppError) => string,
): Effect.Effect<Validated<A>> =>
  Effect.match(eff, { onFailure: (e) => problem(describe(e)), onSuccess: (a) => valid(a) });

/**
 * Every configured calendar `path` must be a directory the server can read; all unreadable ones are
 * listed together. A directory that cannot be written does not stop the server: the tools that
 * write fail with a message, the others work.
 */
export const checkVdirs = (settings: Settings): Effect.Effect<Validated<readonly unknown[]>> =>
  Effect.map(
    Effect.all(
      Object.entries(settings.calendars)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, c]) =>
          attempt(
            Effect.tryPromise({
              try: async () => {
                if (!(await stat(c.path)).isDirectory()) throw new Error("not a directory");
                await access(c.path, constants.R_OK);
              },
              catch: (u) => u as AppError,
            }),
            () => `calendars.${name}.path ${c.path} is not a directory that can be read`,
          ),
        ),
    ),
    (checks) => collectAll(checks),
  );

/**
 * Checks at server start that what the configuration says matches the machine. All checks run and
 * all their problems are reported together.
 */
export const preflight = (settings: Settings): Effect.Effect<Settings, AppError> =>
  Effect.gen(function* () {
    const configFile: Validated<void> =
      settings.configSource === "MCP_KHAL_CONFIG" && !settings.configFound
        ? problem(`MCP_KHAL_CONFIG points to ${settings.configPath}, which does not exist`)
        : valid(undefined);

    const noCalendars: Validated<void> =
      Object.keys(settings.calendars).length === 0
        ? problem(
            `no calendars are configured in ${settings.configPath}: add calendars.<name>.path (the folder of the calendar's .ics files), set MCP_KHAL_CALENDARS_<NAME>_PATH, or run \`mcp-khal setup\``,
          )
        : valid(undefined);

    const vdirs = yield* checkVdirs(settings);

    return yield* Result.match(collect({ configFile, noCalendars, vdirs }), {
      onFailure: (problems) => Effect.fail(toInvalidInput(problems)),
      onSuccess: () => Effect.succeed(settings),
    });
  });
