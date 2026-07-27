import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImportGraph, predictAffectedFiles, predictAffectedTests } from "../affected-test-prediction.js";

describe("affected-test prediction: synthetic import graph (plan item 189)", () => {
  function reader(files: Record<string, string>) {
    return (path: string) => files[path];
  }

  it("predicts a directly-changed file and everything that transitively imports it", () => {
    const files = {
      "a.ts": `export const a = 1;`,
      "b.ts": `import { a } from "./a.js"; export const b = a + 1;`,
      "c.ts": `import { b } from "./b.js"; export const c = b + 1;`,
      "unrelated.ts": `export const unrelated = true;`,
      "__tests__/c.test.ts": `import { c } from "../c.js";`
    };
    const affected = predictAffectedFiles({
      allFilePaths: Object.keys(files),
      readFile: reader(files),
      changedFilePaths: ["a.ts"]
    });
    expect(affected.has("a.ts")).toBe(true);
    expect(affected.has("b.ts")).toBe(true);
    expect(affected.has("c.ts")).toBe(true);
    expect(affected.has("__tests__/c.test.ts")).toBe(true);
    expect(affected.has("unrelated.ts")).toBe(false);
  });

  it("does not mark a file as affected just because it shares a directory or name pattern with the changed file", () => {
    const files = {
      "sparse-ranking.ts": `export const x = 1;`,
      "sparse-ranking-comparison-log.ts": `export const y = 2;` // similar name, no real import relationship
    };
    const affected = predictAffectedFiles({
      allFilePaths: Object.keys(files),
      readFile: reader(files),
      changedFilePaths: ["sparse-ranking.ts"]
    });
    expect(affected.has("sparse-ranking-comparison-log.ts")).toBe(false);
  });

  it("silently skips an unresolvable (external package or out-of-set) import specifier rather than erroring", () => {
    const files = {
      "a.ts": `import { thing } from "some-external-package"; import { missing } from "./missing.js"; export const a = 1;`
    };
    expect(() => buildImportGraph({ allFilePaths: Object.keys(files), readFile: reader(files) })).not.toThrow();
    const graph = buildImportGraph({ allFilePaths: Object.keys(files), readFile: reader(files) });
    expect(graph.get("a.ts")).toEqual(new Set());
  });

  it("predictAffectedTests filters to only test-file paths", () => {
    const files = {
      "a.ts": `export const a = 1;`,
      "b.ts": `import { a } from "./a.js";`,
      "__tests__/b.test.ts": `import { } from "../b.js";`
    };
    const tests = predictAffectedTests({ allFilePaths: Object.keys(files), readFile: reader(files), changedFilePaths: ["a.ts"] });
    expect(tests).toEqual(["__tests__/b.test.ts"]);
  });
});

describe("affected-test prediction validated against this repo's real files (plan item 190)", () => {
  const kernelSrcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  function readRepoFile(relativePath: string): string | undefined {
    try {
      return readFileSync(join(kernelSrcDir, relativePath), "utf8");
    } catch {
      return undefined;
    }
  }

  it("a real change to sparse-ranking.ts predicts sparse-ranking.test.ts as affected, using this repo's actual source", () => {
    const allFilePaths = [
      "sparse-ranking.ts",
      "primitives.ts",
      "types.ts",
      "__tests__/sparse-ranking.test.ts"
    ];
    const tests = predictAffectedTests({
      allFilePaths,
      readFile: readRepoFile,
      changedFilePaths: ["sparse-ranking.ts"]
    });
    expect(tests).toContain("__tests__/sparse-ranking.test.ts");
  });

  it("a real change to an unrelated file (primitives.ts) does not spuriously predict sparse-ranking.test.ts if it never actually imports it", () => {
    // primitives.ts is a low-level dependency many files import, so this
    // instead verifies the negative case with a real leaf module that
    // sparse-ranking.test.ts genuinely does not depend on.
    const allFilePaths = [
      "sparse-ranking.ts",
      "primitives.ts",
      "__tests__/sparse-ranking.test.ts",
      "voice-profile.ts",
      "__tests__/voice-profile.test.ts"
    ];
    const tests = predictAffectedTests({
      allFilePaths,
      readFile: readRepoFile,
      changedFilePaths: ["voice-profile.ts"]
    });
    expect(tests).toEqual(["__tests__/voice-profile.test.ts"]);
    expect(tests).not.toContain("__tests__/sparse-ranking.test.ts");
  });
});
