import assert from "node:assert/strict";
import { Result } from "effect";

/** Test helpers; excluded from the production build. */
export const unwrap = <A, E>(r: Result.Result<A, E>): A =>
  Result.match(r, {
    onFailure: (e) => assert.fail(`expected success, got ${JSON.stringify(e)}`),
    onSuccess: (a) => a,
  });

export const failure = <A, E>(r: Result.Result<A, E>): E =>
  Result.match(r, {
    onFailure: (e) => e,
    onSuccess: () => assert.fail("expected failure"),
  });
