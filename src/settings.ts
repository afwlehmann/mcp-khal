import { Effect, Result } from "effect";
import { IANAZone } from "luxon";
import {
  type Calendars,
  type Config,
  type ConfigSource,
  configLocation,
  type Env,
  parseConfigWithEnv,
  readConfigText,
} from "./config.js";
import type { AppError } from "./errors.js";
import { collect, problem, toInvalidInput, type Validated, valid } from "./validation.js";

/**
 * Everything the server needs from its surroundings, read once at startup and passed on.
 * No other module touches `process.env`, the home directory or the config file.
 */
export interface Settings {
  /** the calendar `new_event` uses when the call names none; unset with a single calendar */
  readonly defaultCalendar?: string;
  /** per calendar: the folder of its .ics files, the user's address there and the reminder for new events */
  readonly calendars: Calendars;
  readonly configPath: string;
  /** which variable (or the default) decided `configPath` */
  readonly configSource: ConfigSource;
  /** whether the config file exists; a missing one means the defaults */
  readonly configFound: boolean;
  /** the host's IANA time zone (e.g. `Europe/Berlin`), read once at the edge */
  readonly timezone: string;
}

/** What the edge (index.ts, cli.ts) reads from the process and hands over. */
export interface SettingsInput {
  readonly env: Env;
  readonly home: string;
  /** the host's time zone: `Intl.DateTimeFormat().resolvedOptions().timeZone` (honours TZ) */
  readonly timezone: string;
}

/** Pure: combine the already-validated config and the host zone. */
export const buildSettings = (input: {
  readonly config: Config;
  readonly configPath: string;
  readonly configSource?: ConfigSource;
  readonly configFound?: boolean;
  readonly timezone: string;
}): Settings => ({
  ...(input.config.defaultCalendar === undefined ? {} : { defaultCalendar: input.config.defaultCalendar }),
  calendars: input.config.calendars,
  configPath: input.configPath,
  configSource: input.configSource ?? "default",
  configFound: input.configFound ?? true,
  timezone: input.timezone,
});

/** Pure: the host zone must be a known IANA zone name. */
export const checkTimezone = (raw: string): Validated<string> => {
  const zone = raw.trim();
  return zone !== "" && IANAZone.isValidZone(zone)
    ? valid(zone)
    : problem(
        `the host time zone must be a known IANA zone such as Europe/Berlin, got ${JSON.stringify(raw)}`,
      );
};

/**
 * Reads the config file named by the environment, once, and builds the settings. Everything that
 * is wrong with the environment variables and the file is reported together, not one at a time.
 */
export const loadSettings = (input: SettingsInput): Effect.Effect<Settings, AppError> =>
  Effect.gen(function* () {
    const location = configLocation(input.env, input.home);
    // the file can only be read when its location is known; a bad location is reported anyway
    const text = yield* Result.match(location, {
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (l) => readConfigText(l.path),
    });

    // the file (when there is one) with the environment laid over it
    const checked = collect({
      location,
      timezone: checkTimezone(input.timezone),
      config: parseConfigWithEnv(text, input.env),
    });

    return yield* Result.match(checked, {
      onFailure: (problems) => Effect.fail(toInvalidInput(problems)),
      onSuccess: (v) =>
        Effect.succeed(
          buildSettings({
            config: v.config,
            configPath: v.location.path,
            configSource: v.location.source,
            configFound: text !== undefined,
            timezone: v.timezone,
          }),
        ),
    });
  });
