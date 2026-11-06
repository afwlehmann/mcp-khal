import { Result } from "effect";
import { InvalidInput } from "./errors.js";

/**
 * Error accumulation. effect 4 has no `Validation` module, so this is a `Result` whose failure is
 * a non-empty list of problems: independent checks all run and all their problems are reported,
 * instead of stopping at the first one. (`Result.flatMap` still short-circuits, which is right
 * when a later check depends on an earlier one.)
 */
export type Problems = readonly [string, ...string[]];
export type Validated<A> = Result.Result<A, Problems>;

export const valid = <A>(value: A): Validated<A> => Result.succeed(value);

export const problem = (message: string): Validated<never> => Result.fail([message]);

const problemsOf = (v: Validated<unknown>): readonly string[] =>
  Result.match(v, { onFailure: (p) => p, onSuccess: () => [] });

/** The value of a validation that is known to have succeeded (the problems were checked first). */
const successValue = <A>(v: Validated<A>): A | undefined =>
  Result.match(v, { onFailure: () => undefined, onSuccess: (a) => a });

const toProblems = (list: readonly string[]): Problems => {
  const [first, ...rest] = list;
  return [first ?? "invalid", ...rest];
};

/** Runs nothing itself: combines already computed validations, keeping every problem in order. */
export const collect = <T extends Readonly<Record<string, Validated<unknown>>>>(
  fields: T,
): Validated<{ readonly [K in keyof T]: T[K] extends Validated<infer A> ? A : never }> => {
  const problems = Object.values(fields).flatMap(problemsOf);
  if (problems.length > 0) return Result.fail(toProblems(problems));
  const values = Object.fromEntries(Object.entries(fields).map(([key, v]) => [key, successValue(v)]));
  return Result.succeed(values as never);
};

export const collectAll = <A>(items: readonly Validated<A>[]): Validated<readonly A[]> => {
  const problems = items.flatMap(problemsOf);
  return problems.length > 0
    ? Result.fail(toProblems(problems))
    : Result.succeed(items.map((v) => successValue(v) as A));
};

/** One problem is reported as is; several become a bullet list. */
export const toInvalidInput = (problems: Problems): InvalidInput =>
  new InvalidInput({
    message:
      problems.length === 1
        ? problems[0]
        : `${problems.length} problems:\n${problems.map((p) => `- ${p}`).join("\n")}`,
  });

export const orInvalidInput = <A>(v: Validated<A>): Result.Result<A, InvalidInput> =>
  Result.mapError(v, toInvalidInput);
