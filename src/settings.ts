import { isAbsolute } from "node:path";
import { Effect, Result } from "effect";
import {
  type Config,
  type ConfigSource,
  checkEnvBinary,
  configLocation,
  defaultConfig,
  type Env,
  type Mapping,
  readConfig,
  resolveKhalBinary,
} from "./config.js";
import type { KhalError } from "./errors.js";
import { collect, problem, toInvalidInput, type Validated, valid } from "./validation.js";

/**
 * Everything the server needs from its surroundings, read once at startup and passed on.
 * No other module touches `process.env`, the home directory or the config file.
 */
export interface Settings {
  /** the khal executable that is run */
  readonly khal: string;
  /** where `khal` came from: the environment overrides the config file */
  readonly khalSource: "MCP_KHAL_BIN" | "config";
  readonly calendarEmails: Mapping;
  /** reminder for new events without an explicit `alarm`: `15m`, `2h`, `1d` or `none` */
  readonly defaultAlarm: string;
  /** calendar name -> reminder that overrides `defaultAlarm` for that calendar */
  readonly calendarAlarms: Mapping;
  readonly configPath: string;
  /** which variable (or the default) decided `configPath` */
  readonly configSource: ConfigSource;
  /** whether the config file exists; a missing one means the defaults */
  readonly configFound: boolean;
  /** the full environment handed to khal */
  readonly childEnv: Env;
  /** where temporary files are created */
  readonly tmpDir: string;
  readonly timeoutMs: number;
}

/** What the edge (index.ts, cli.ts) reads from the process and hands over. */
export interface SettingsInput {
  readonly env: Env;
  readonly home: string;
  readonly tmpDir: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Pure: combine the already-read and already-validated environment and config. */
export const buildSettings = (input: {
  readonly env: Env;
  readonly config: Config;
  readonly configPath: string;
  readonly configSource?: ConfigSource;
  readonly configFound?: boolean;
  readonly tmpDir: string;
}): Settings => {
  const { binary, source } = resolveKhalBinary(input.env, input.config);
  return {
    khal: binary,
    khalSource: source,
    calendarEmails: input.config.calendarEmails,
    defaultAlarm: input.config.defaultAlarm,
    calendarAlarms: input.config.calendarAlarms,
    configPath: input.configPath,
    configSource: input.configSource ?? "default",
    configFound: input.configFound ?? true,
    childEnv: { ...input.env, LC_ALL: "C.UTF-8" },
    tmpDir: input.tmpDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
};

const checkTmpDir = (raw: string): Validated<string> => {
  const dir = raw.trim();
  return dir !== "" && isAbsolute(dir)
    ? valid(dir)
    : problem(`the temporary directory must be an absolute path, got ${JSON.stringify(raw)}`);
};

/**
 * Reads the config file named by the environment, once, and builds the settings. Everything that
 * is wrong with the environment variables and the file is reported together, not one at a time.
 */
export const loadSettings = (input: SettingsInput): Effect.Effect<Settings, KhalError> =>
  Effect.gen(function* () {
    const location = configLocation(input.env, input.home);
    // the file can only be read when its location is known; a bad location is reported anyway
    const read = yield* Result.match(location, {
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (l) => readConfig(l.path),
    });

    const checked = collect({
      location,
      envBinary: checkEnvBinary(input.env),
      tmpDir: checkTmpDir(input.tmpDir),
      config: read ?? valid(defaultConfig),
    });

    return yield* Result.match(checked, {
      onFailure: (problems) => Effect.fail(toInvalidInput(problems)),
      onSuccess: (v) =>
        Effect.succeed(
          buildSettings({
            env: input.env,
            config: v.config,
            configPath: v.location.path,
            configSource: v.location.source,
            configFound: read !== undefined,
            tmpDir: v.tmpDir,
          }),
        ),
    });
  });
