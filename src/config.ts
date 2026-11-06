import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Effect, Result } from "effect";
import { InvalidInput, ioError, type KhalError } from "./errors.js";
import {
  collect,
  collectAll,
  orInvalidInput,
  type Problems,
  problem,
  type Validated,
  valid,
} from "./validation.js";

/** calendar name -> the user's own address on that calendar */
export type Mapping = Readonly<Record<string, string>>;

export type Env = Readonly<Record<string, string | undefined>>;

/** `15m`, `2h`, `1d`, or `none` for no reminder at all */
export type AlarmSetting = string;

export const NO_ALARM = "none";

export interface Config {
  /** the khal executable: a name looked up on PATH or an absolute path */
  readonly khal: string;
  readonly calendarEmails: Mapping;
  /** reminder for events without an explicit `alarm`, unless the calendar has its own */
  readonly defaultAlarm: AlarmSetting;
  /** calendar name -> reminder for new events on that calendar (overrides `defaultAlarm`) */
  readonly calendarAlarms: Mapping;
}

export const DEFAULT_KHAL = "khal";
export const defaultConfig: Config = {
  khal: DEFAULT_KHAL,
  calendarEmails: {},
  defaultAlarm: NO_ALARM,
  calendarAlarms: {},
};

// ---------- pure ----------
// Every value read from the environment or the config file is trimmed before it is checked, and
// independent checks accumulate their problems (see validation.ts) instead of stopping at the first.

export const isEmail = (s: string): boolean => /^[^\s@,;:<>]+@[^\s@,;:<>]+\.[^\s@,;:<>]+$/.test(s);

/** `<n>m`, `<n>h` or `<n>d` (n = 0..9999 minutes, hours or days before the start), or `none`. */
export const isAlarmSetting = (s: string): boolean => s === NO_ALARM || /^\d{1,4}[mhd]$/.test(s);

const ALARM_HINT = "a reminder like 30m, 2h or 1d (minutes, hours, days before the start), or 'none'";

const CONTROL = /[\u0000-\u001f\u007f]/;

/** An environment variable counts as unset when it is empty or only whitespace. */
const envValue = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
};

export type ConfigSource = "MCP_KHAL_CONFIG" | "XDG_CONFIG_HOME" | "default";

/**
 * Where the config file is: `$MCP_KHAL_CONFIG`, else `$XDG_CONFIG_HOME/mcp-khal.json`, else
 * `~/.config/mcp-khal.json`. Set variables must be absolute paths, because a relative path would
 * silently depend on the working directory of the MCP client.
 */
export const configLocation = (
  env: Env,
  home: string,
): Validated<{ readonly path: string; readonly source: ConfigSource }> => {
  const explicit = envValue(env, "MCP_KHAL_CONFIG");
  if (explicit !== undefined)
    return isAbsolute(explicit)
      ? valid({ path: explicit, source: "MCP_KHAL_CONFIG" })
      : problem(`MCP_KHAL_CONFIG must be an absolute path, got ${JSON.stringify(explicit)}`);
  const xdg = envValue(env, "XDG_CONFIG_HOME");
  if (xdg !== undefined)
    return isAbsolute(xdg)
      ? valid({ path: join(xdg, "mcp-khal.json"), source: "XDG_CONFIG_HOME" })
      : problem(`XDG_CONFIG_HOME must be an absolute path, got ${JSON.stringify(xdg)}`);
  return valid({ path: join(home, ".config", "mcp-khal.json"), source: "default" });
};

/**
 * The khal executable is a bare command name (looked up on PATH) or an absolute path. A relative
 * path would depend on the working directory and `~` is not expanded, so both are rejected.
 * `label` names where the value came from, e.g. "config 'khal'" or "MCP_KHAL_BIN".
 */
export const checkBinary = (raw: string, label: string): Validated<string> => {
  const v = raw.trim();
  if (v === "" || CONTROL.test(v))
    return problem(`${label} must be a non-empty command name or absolute path without control characters`);
  if (isAbsolute(v)) return valid(v);
  if (v.startsWith("~"))
    return problem(
      `${label} must not start with '~', which is not expanded; use an absolute path (got ${v})`,
    );
  if (/[\s/\\]/.test(v) || v.startsWith("-"))
    return problem(
      `${label} must be a bare command name (looked up on PATH) or an absolute path, got ${JSON.stringify(v)}`,
    );
  return valid(v);
};

/** The environment variable wins over the config file's `khal`. */
export const resolveKhalBinary = (
  env: Env,
  config: Config,
): { readonly binary: string; readonly source: "MCP_KHAL_BIN" | "config" } => {
  const fromEnv = envValue(env, "MCP_KHAL_BIN");
  return fromEnv !== undefined
    ? { binary: fromEnv, source: "MCP_KHAL_BIN" }
    : { binary: config.khal, source: "config" };
};

/** `MCP_KHAL_BIN`, when set, must be a valid executable name too. */
export const checkEnvBinary = (env: Env): Validated<string | undefined> => {
  const fromEnv = envValue(env, "MCP_KHAL_BIN");
  return fromEnv === undefined ? valid(undefined) : checkBinary(fromEnv, "MCP_KHAL_BIN");
};

export const parseCalendarNames = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const checkCalendarName = (name: string, where: string): Validated<string> => {
  const n = name.trim();
  if (n === "") return problem(`${where} has an empty calendar name`);
  if (CONTROL.test(n))
    return problem(`${where} has a calendar name with control characters: ${JSON.stringify(n)}`);
  return valid(n);
};

/** A JSON object of calendar name -> value, every entry checked, names trimmed and unique. */
const parseCalendarMap = (
  raw: unknown,
  where: string,
  kind: string,
  parseValue: (value: unknown, name: string) => Validated<string>,
): Validated<Mapping> => {
  if (!isRecord(raw)) return problem(`${where} must be a JSON object of calendar name -> ${kind}`);
  const entries = collectAll(
    Object.entries(raw).map(([name, value]) =>
      Result.map(
        collect({ name: checkCalendarName(name, where), value: parseValue(value, name) }),
        ({ name: n, value: v }) => [n, v] as const,
      ),
    ),
  );
  return Result.flatMap(entries, (list) => {
    const names = list.map(([n]) => n);
    const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    return duplicates.length > 0
      ? collectAll(
          duplicates.map((n) =>
            problem(`${where} lists calendar '${n}' more than once (names are compared after trimming)`),
          ),
        ).pipe(Result.map(() => ({}) as Mapping))
      : valid(Object.fromEntries(list) as Mapping);
  });
};

const parseEmails = (raw: unknown, where: string): Validated<Mapping> =>
  parseCalendarMap(raw, where, "email", (value, name) =>
    typeof value === "string" && isEmail(value.trim())
      ? valid(value.trim())
      : problem(`${where} entry '${name}' is not a valid email address`),
  );

const parseAlarm = (raw: unknown, where: string): Validated<AlarmSetting> =>
  typeof raw === "string" && isAlarmSetting(raw.trim())
    ? valid(raw.trim())
    : problem(`${where} must be ${ALARM_HINT}, got ${JSON.stringify(raw)}`);

const parseCalendarAlarms = (raw: unknown): Validated<Mapping> =>
  parseCalendarMap(raw, "calendarAlarms", "reminder", (value, name) =>
    parseAlarm(value, `calendarAlarms entry '${name}'`),
  );

const parseBinary = (raw: unknown): Validated<string> =>
  typeof raw === "string"
    ? checkBinary(raw, "config 'khal'")
    : problem(`config 'khal' must be a string, got ${JSON.stringify(raw)}`);

const CONFIG_KEYS: readonly string[] = ["khal", "calendarEmails", "defaultAlarm", "calendarAlarms"];

/**
 * `{ "khal": "khal", "calendarEmails": { "work": "me@example.com" }, "defaultAlarm": "15m",
 *    "calendarAlarms": { "work": "1d" } }`; all keys are optional.
 * A flat `{ "work": "me@example.com" }` (the format of v1.0.0) is still understood.
 * Every problem of the file is reported, not only the first.
 */
export const parseConfigValidated = (json: string): Validated<Config> =>
  Result.flatMap(
    Result.try({
      try: (): unknown => JSON.parse(json),
      catch: (e): Problems => [`config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    }),
    (raw): Validated<Config> => {
      if (!isRecord(raw)) return problem("config must be a JSON object");

      const legacy = Object.values(raw).every((v) => typeof v === "string" && isEmail(v.trim()));
      if (legacy)
        return Result.map(parseEmails(raw, "config"), (calendarEmails) => ({
          ...defaultConfig,
          calendarEmails,
        }));

      return Result.map(
        collect({
          unknownKeys: collectAll(
            Object.keys(raw)
              .filter((k) => !CONFIG_KEYS.includes(k))
              .map((k) =>
                problem(
                  `unknown config key '${k}' (expected ${CONFIG_KEYS.map((x) => `'${x}'`).join(", ")})`,
                ),
              ),
          ),
          khal: raw.khal === undefined ? valid(DEFAULT_KHAL) : parseBinary(raw.khal),
          calendarEmails:
            raw.calendarEmails === undefined
              ? valid({} as Mapping)
              : parseEmails(raw.calendarEmails, "calendarEmails"),
          defaultAlarm:
            raw.defaultAlarm === undefined ? valid(NO_ALARM) : parseAlarm(raw.defaultAlarm, "defaultAlarm"),
          calendarAlarms:
            raw.calendarAlarms === undefined ? valid({} as Mapping) : parseCalendarAlarms(raw.calendarAlarms),
        }),
        ({ khal, calendarEmails, defaultAlarm, calendarAlarms }): Config => ({
          khal,
          calendarEmails,
          defaultAlarm,
          calendarAlarms,
        }),
      );
    },
  );

export const parseConfig = (json: string): Result.Result<Config, InvalidInput> =>
  orInvalidInput(parseConfigValidated(json));

export const serializeConfig = (c: Config): string =>
  `${JSON.stringify(
    {
      khal: c.khal,
      calendarEmails: c.calendarEmails,
      defaultAlarm: c.defaultAlarm,
      calendarAlarms: c.calendarAlarms,
    },
    null,
    2,
  )}\n`;

/**
 * The reminder for a new event: an explicit `alarm` wins, then the calendar's own setting, then
 * the default. `none` (explicit or configured) means no reminder, expressed as `undefined`.
 */
export const resolveAlarm = (
  settings: Pick<Config, "defaultAlarm" | "calendarAlarms">,
  calendar: string | undefined,
  explicit: string | undefined,
): string | undefined => {
  const name = calendar?.trim();
  const chosen =
    explicit?.trim() ??
    (name !== undefined && Object.hasOwn(settings.calendarAlarms, name)
      ? settings.calendarAlarms[name]
      : settings.defaultAlarm);
  return chosen === undefined || chosen === NO_ALARM ? undefined : chosen;
};

/** Answer to a setup prompt: blank keeps the default (or skips), otherwise must be an email. */
export const interpretAnswer = (
  answer: string,
  fallback: string | undefined,
): Result.Result<string | undefined, string> => {
  const a = answer.trim();
  if (a === "") return Result.succeed(fallback);
  return isEmail(a) ? Result.succeed(a) : Result.fail(`'${a}' is not a valid email address`);
};

/** Which address represents the user on this calendar? Explicit > mapping > email-like name. */
export const resolveAddress = (
  mapping: Mapping,
  calendar: string | undefined,
  explicit?: string,
): Result.Result<string, InvalidInput> => {
  const invalid = (message: string) => Result.fail(new InvalidInput({ message }));
  const from = explicit?.trim();
  if (from !== undefined)
    return isEmail(from) ? Result.succeed(from) : invalid(`'${from}' is not a valid email address`);
  const name = calendar?.trim();
  if (name === undefined || name === "")
    return invalid("calendar (or organizer) is required to determine your address for invites");
  if (Object.hasOwn(mapping, name)) return Result.succeed(mapping[name]!);
  return isEmail(name)
    ? Result.succeed(name)
    : invalid(`no address known for calendar '${name}'; run \`mcp-khal setup\` or pass one explicitly`);
};

// ---------- effects (the path is always passed in) ----------

/** The parsed file; `undefined` when it does not exist. Problems of the content accumulate. */
export const readConfig = (path: string): Effect.Effect<Validated<Config> | undefined, KhalError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (u) => u as NodeJS.ErrnoException,
  }).pipe(
    Effect.matchEffect({
      onFailure: (e): Effect.Effect<Validated<Config> | undefined, KhalError> =>
        e.code === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(ioError(e)),
      onSuccess: (content) => Effect.succeed(parseConfigValidated(content)),
    }),
  );

/** A missing file is the default configuration, not an error. */
export const loadConfig = (path: string): Effect.Effect<Config, KhalError> =>
  Effect.flatMap(readConfig(path), (read) =>
    read === undefined ? Effect.succeed(defaultConfig) : Effect.fromResult(orInvalidInput(read)),
  );

export const saveConfig = (path: string, c: Config): Effect.Effect<void, KhalError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: ioError });
    yield* Effect.tryPromise({ try: () => writeFile(path, serializeConfig(c), "utf8"), catch: ioError });
  });
