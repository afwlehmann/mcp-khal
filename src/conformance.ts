import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Test tooling (not part of the server): the requirement registries in spec/, the tests that
// cite them, and the report that says which requirement is tested where.

export type Level = "MUST" | "MUST NOT" | "SHOULD" | "SHOULD NOT" | "MAY" | "policy";

export interface Requirement {
  /** `RFC5545:3.3.10:count-xor-until`, `VDIR:atomic-writes`, `POLICY:strip-method-on-write` */
  readonly id: string;
  readonly rfc: number | string;
  readonly section?: string;
  readonly url?: string;
  readonly level: Level;
  readonly quote?: string;
  readonly verified: "quoted" | "paraphrase" | "memory";
  readonly scope: readonly string[];
  readonly matrixRef?: string;
  /** one sentence: the input and the expected result */
  readonly test: string;
  readonly status: "required" | "n/a" | "deferred";
  readonly reason?: string;
  /** the registry file it came from */
  readonly file: string;
}

/** The registry files: every `spec/*.json` except the list of requirements that still lack a test. */
export const UNCOVERED_FILE = "uncovered.json";

export const loadRegistry = async (specDir: string): Promise<Requirement[]> => {
  const files = (await readdir(specDir)).filter((f) => f.endsWith(".json") && f !== UNCOVERED_FILE).sort();
  const lists = await Promise.all(
    files.map(async (file) => {
      const rows = JSON.parse(await readFile(join(specDir, file), "utf8")) as Omit<Requirement, "file">[];
      return rows.map((r): Requirement => ({ ...r, file }));
    }),
  );
  return lists.flat();
};

export const loadUncovered = async (specDir: string): Promise<string[]> =>
  JSON.parse(await readFile(join(specDir, UNCOVERED_FILE), "utf8").catch(() => "[]")) as string[];

const ID = /\b(?:RFC\d{4}|VDIR|POLICY):[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*/g;

/** Every test file below `dir` (recursive), except the files named in `except`. */
export const testFiles = async (
  dir: string,
  except: readonly string[],
): Promise<{ readonly name: string; readonly text: string }[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts") && !except.includes(e.name))
    .map((e) => join(e.parentPath, e.name));
  return Promise.all(names.sort().map(async (name) => ({ name, text: await readFile(name, "utf8") })));
};

/** requirement id -> the test files that cite it */
export const citations = (files: readonly { name: string; text: string }[]): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const f of files)
    for (const raw of f.text.match(ID) ?? []) {
      const id = raw.replace(/[.-]+$/, "");
      const cited = out.get(id) ?? [];
      if (!cited.includes(f.name)) out.set(id, [...cited, f.name]);
    }
  return out;
};

/** What is wrong with the registry and its citations; empty when everything fits. */
export const problems = (
  reqs: readonly Requirement[],
  cited: ReadonlyMap<string, readonly string[]>,
  uncovered: readonly string[],
): string[] => {
  const ids = reqs.map((r) => r.id);
  const known = new Set(ids);
  const out: string[] = [];
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) out.push(`duplicate id ${id}`);
  for (const r of reqs) {
    if (r.status !== "required" && (r.reason ?? "").trim() === "")
      out.push(`${r.id} is ${r.status} without a reason`);
    if (r.verified === "quoted" && (r.quote ?? "").trim() === "")
      out.push(`${r.id} is quoted without a quote`);
  }
  for (const id of cited.keys())
    if (!known.has(id)) out.push(`a test cites ${id}, which is not in the registry`);
  const needing = reqs.filter((r) => r.status === "required").map((r) => r.id);
  for (const id of needing)
    if (!cited.has(id) && !uncovered.includes(id))
      out.push(
        `${id} has no test (cite it with itReq, or it is a new requirement: add it to spec/${UNCOVERED_FILE})`,
      );
  for (const id of uncovered) {
    if (!known.has(id)) out.push(`spec/${UNCOVERED_FILE} lists ${id}, which is not in the registry`);
    else if (cited.has(id)) out.push(`${id} has a test now: remove it from spec/${UNCOVERED_FILE}`);
    else if (!needing.includes(id)) out.push(`spec/${UNCOVERED_FILE} lists ${id}, which is not required`);
  }
  return out;
};

/** The ids of the required requirements no test cites yet, sorted. */
export const uncoveredIds = (
  reqs: readonly Requirement[],
  cited: ReadonlyMap<string, readonly string[]>,
): string[] =>
  reqs
    .filter((r) => r.status === "required" && !cited.has(r.id))
    .map((r) => r.id)
    .sort();

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** `docs/conformance.md`: one table per registry file, with the tests of every requirement. */
export const renderReport = (
  reqs: readonly Requirement[],
  cited: ReadonlyMap<string, readonly string[]>,
  root: string,
): string => {
  const rel = (f: string): string => f.slice(root.length + 1);
  const required = reqs.filter((r) => r.status === "required");
  const covered = required.filter((r) => cited.has(r.id));
  const lines = [
    "# Conformance",
    "",
    "Generated from `spec/*.json` and the tests that cite a requirement id (`itReq`). Do not edit by hand:",
    "`UPDATE_CONFORMANCE=1 npx vitest run src/conformance.meta.test.ts` rewrites it.",
    "",
    `Required requirements with a test: **${covered.length} of ${required.length}**.`,
    "",
  ];
  for (const file of [...new Set(reqs.map((r) => r.file))]) {
    const mine = reqs.filter((r) => r.file === file);
    lines.push(`## ${file}`, "", "| Id | Level | Status | Tests |", "|---|---|---|---|");
    for (const r of mine) {
      const id = r.url === undefined ? `\`${r.id}\`` : `[\`${r.id}\`](${r.url})`;
      const tests = (cited.get(r.id) ?? []).map((t) => `\`${rel(t)}\``).join(", ");
      const status = r.status === "required" ? "required" : `${r.status}: ${cell(r.reason ?? "")}`;
      lines.push(`| ${id} | ${r.level} | ${status} | ${tests} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
};
