import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { InvalidInput, ioError, type KhalError } from "./errors.js";

/** calendar name -> the user's own address on that calendar */
export type Mapping = Readonly<Record<string, string>>;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

// ---------- pure ----------

export const isEmail = (s: string): boolean => /^[^\s@,;:<>]+@[^\s@,;:<>]+\.[^\s@,;:<>]+$/.test(s);

export const configPath = (env: Readonly<Record<string, string | undefined>>, home: string): string =>
  env.MCP_KHAL_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "mcp-khal.json");

export const parseCalendarNames = (stdout: string): string[] =>
  stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");

export const parseMapping = (json: string): Result.Result<Mapping, InvalidInput> =>
  Result.gen(function* () {
    const raw = yield* Result.try({
      try: (): unknown => JSON.parse(json),
      catch: (e) => invalid(`config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`),
    });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return yield* Result.fail(invalid("config must be a JSON object of calendar name -> email"));
    const bad = Object.entries(raw).find(([, v]) => typeof v !== "string" || !isEmail(v));
    if (bad) return yield* Result.fail(invalid(`config entry '${bad[0]}' is not a valid email address`));
    return raw as Mapping;
  });

export const serializeMapping = (m: Mapping): string => JSON.stringify(m, null, 2) + "\n";

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
  if (explicit !== undefined)
    return isEmail(explicit)
      ? Result.succeed(explicit)
      : Result.fail(invalid(`'${explicit}' is not a valid email address`));
  if (calendar === undefined)
    return Result.fail(invalid("calendar (or organizer) is required to determine your address for invites"));
  const mapped = mapping[calendar];
  if (mapped !== undefined) return Result.succeed(mapped);
  return isEmail(calendar)
    ? Result.succeed(calendar)
    : Result.fail(
        invalid(`no address known for calendar '${calendar}'; run \`mcp-khal setup\` or pass one explicitly`),
      );
};

// ---------- effects ----------

export const defaultConfigPath = (): string => configPath(process.env, homedir());

/** A missing file is an empty mapping, not an error. */
export const loadMapping = (path: string): Effect.Effect<Mapping, KhalError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (u) => u as NodeJS.ErrnoException,
  }).pipe(
    Effect.matchEffect({
      onFailure: (e): Effect.Effect<Mapping, KhalError> =>
        e.code === "ENOENT" ? Effect.succeed({}) : Effect.fail(ioError(e)),
      onSuccess: (content): Effect.Effect<Mapping, KhalError> => Effect.fromResult(parseMapping(content)),
    }),
  );

export const saveMapping = (path: string, m: Mapping): Effect.Effect<void, KhalError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: ioError });
    yield* Effect.tryPromise({ try: () => writeFile(path, serializeMapping(m), "utf8"), catch: ioError });
  });
