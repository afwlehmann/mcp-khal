import { Effect } from "effect";
import { type Config, configPath, type Env, loadConfig, type Mapping, resolveKhalBinary } from "./config.js";
import type { KhalError } from "./errors.js";

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

/** Pure: combine the already-read environment and config. */
export const buildSettings = (input: {
  readonly env: Env;
  readonly config: Config;
  readonly configPath: string;
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
    childEnv: { ...input.env, LC_ALL: "C.UTF-8" },
    tmpDir: input.tmpDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
};

/** Reads the config file named by the environment, once, and builds the settings. */
export const loadSettings = (input: SettingsInput): Effect.Effect<Settings, KhalError> => {
  const path = configPath(input.env, input.home);
  return Effect.map(loadConfig(path), (config) =>
    buildSettings({ env: input.env, config, configPath: path, tmpDir: input.tmpDir }),
  );
};
