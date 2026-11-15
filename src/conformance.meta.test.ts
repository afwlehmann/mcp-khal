import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  citations,
  loadRegistry,
  loadUncovered,
  problems,
  renderReport,
  testFiles,
  UNCOVERED_FILE,
  uncoveredIds,
} from "./conformance.js";

// The meta test of the conformance suite: every requirement of the registries in spec/ is
// either cited by a test (`itReq`) or listed, with the reason, as not applicable/deferred.
// spec/uncovered.json is a ratchet: it lists the required requirements that still have no test;
// it may only shrink. `UPDATE_CONFORMANCE=1` rewrites it and docs/conformance.md.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specDir = join(root, "spec");
const update = process.env.UPDATE_CONFORMANCE === "1";

const state = async () => {
  const reqs = await loadRegistry(specDir);
  const cited = citations(await testFiles(join(root, "src"), ["conformance.meta.test.ts"]));
  return { reqs, cited };
};

describe("conformance registry", () => {
  it("is consistent: unique ids, reasons for what is not required, no citation of an unknown id", async () => {
    const { reqs, cited } = await state();
    const uncovered = update ? uncoveredIds(reqs, cited) : await loadUncovered(specDir);
    if (update) {
      await writeFile(
        join(specDir, UNCOVERED_FILE),
        `${JSON.stringify(uncoveredIds(reqs, cited), null, 2)}\n`,
      );
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "docs", "conformance.md"), renderReport(reqs, cited, root));
    }
    expect(problems(reqs, cited, uncovered)).toEqual([]);
  });

  it("has a report in docs/conformance.md that is up to date", async () => {
    const { reqs, cited } = await state();
    const current = await readFile(join(root, "docs", "conformance.md"), "utf8").catch(() => "");
    expect(current).toBe(renderReport(reqs, cited, root));
  });

  it("covers every required requirement of the registries once the ratchet is empty", async () => {
    const { reqs, cited } = await state();
    const open = uncoveredIds(reqs, cited);
    // the ratchet may only shrink: the open list is exactly what spec/uncovered.json says
    expect(open).toEqual([...(await loadUncovered(specDir))].sort());
  });
});
