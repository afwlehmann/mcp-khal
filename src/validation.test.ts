import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidInput } from "./errors.js";
import { failure, unwrap } from "./testlib.js";
import {
  collect,
  collectAll,
  orInvalidInput,
  problem,
  toInvalidInput,
  type Validated,
  valid,
} from "./validation.js";

describe("collect", () => {
  it("combines valid values by name", () => {
    expect(unwrap(collect({ a: valid(1), b: valid("x") }))).toEqual({ a: 1, b: "x" });
  });

  it("keeps every problem, in field order, instead of stopping at the first", () => {
    const result: Validated<unknown> = collect({
      a: problem("first"),
      b: valid(2),
      c: Result.fail(["second", "third"] as const),
    });
    expect(failure(result)).toEqual(["first", "second", "third"]);
  });

  it("succeeds with no fields", () => {
    expect(unwrap(collect({}))).toEqual({});
  });
});

describe("collectAll", () => {
  it("collects the values of a list", () => {
    expect(unwrap(collectAll([valid(1), valid(2)]))).toEqual([1, 2]);
    expect(unwrap(collectAll([]))).toEqual([]);
  });

  it("collects every problem of a list", () => {
    expect(failure(collectAll([problem("a"), valid(1), problem("b")]))).toEqual(["a", "b"]);
  });
});

describe("toInvalidInput", () => {
  it("passes a single problem through unchanged", () => {
    const e = toInvalidInput(["only one"]);
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toBe("only one");
  });

  it("turns several problems into a bullet list that says how many", () => {
    expect(toInvalidInput(["a", "b"]).message).toBe("2 problems:\n- a\n- b");
  });
});

describe("orInvalidInput", () => {
  it("maps the problems of a failed validation and leaves successes alone", () => {
    expect(unwrap(orInvalidInput(valid(7)))).toBe(7);
    expect(failure(orInvalidInput(collect({ a: problem("x"), b: problem("y") }))).message).toBe(
      "2 problems:\n- x\n- y",
    );
  });
});
