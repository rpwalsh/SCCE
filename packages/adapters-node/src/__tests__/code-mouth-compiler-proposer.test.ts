// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompilerRepairProposal, proposeCompilerOwnedRepair } from "../code-mouth-compiler-proposer.js";

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", noEmit: true, noUnusedLocals: true },
  include: ["src/**/*.ts"]
}, null, 2);

async function project(source: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "scce-compiler-proposer-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", private: true }), "utf8");
  await writeFile(join(root, "tsconfig.json"), TSCONFIG, "utf8");
  await writeFile(join(root, "src", "target.ts"), source, "utf8");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("compiler-owned repair", () => {
  it("derives a fix the compiler owns without any model", async () => {
    const source = "import { readFile } from \"node:fs/promises\";\n\nexport function greet(name: string): string {\n  return \"hello \" + name;\n}\n";
    const fixture = await project(source);
    try {
      const proposal = await proposeCompilerOwnedRepair({
        workspaceRoot: fixture.root,
        targetPath: "src/target.ts",
        targetText: source,
        requestText: "remove the unused import TS6133",
        attempt: 1
      });
      expect(isCompilerRepairProposal(proposal)).toBe(true);
      if (!isCompilerRepairProposal(proposal)) return;
      expect(proposal.diagnosticCode).toBe(6133);
      expect(proposal.fixName).toBe("unusedIdentifier");
      expect(proposal.surface).not.toContain("node:fs/promises");
      expect(proposal.surface).toContain("export function greet");
      expect(proposal.operations).toHaveLength(1);
      expect(proposal.operations[0]!.kind).toBe("replace");
    } finally {
      await fixture.cleanup();
    }
  });

  it("offers the compiler's candidates instead of guessing when the request names no fix", async () => {
    const source = "import { readFile } from \"node:fs/promises\";\n\nexport const value = 1;\n";
    const fixture = await project(source);
    try {
      const result = await proposeCompilerOwnedRepair({
        workspaceRoot: fixture.root,
        targetPath: "src/target.ts",
        targetText: source,
        requestText: "tidy this file up",
        attempt: 1
      });
      expect(isCompilerRepairProposal(result)).toBe(false);
      expect(result && "candidates" in result ? result.candidates.length : 0).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("yields nothing when the file has no compiler-owned fix, leaving the model lane to answer", async () => {
    const source = "export function total(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n";
    const fixture = await project(source);
    try {
      const result = await proposeCompilerOwnedRepair({
        workspaceRoot: fixture.root,
        targetPath: "src/target.ts",
        targetText: source,
        requestText: "make it faster",
        attempt: 1
      });
      expect(result).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a path outside the workspace root", async () => {
    const fixture = await project("export const value = 1;\n");
    try {
      const result = await proposeCompilerOwnedRepair({
        workspaceRoot: join(fixture.root, "src"),
        targetPath: "../../elsewhere.ts",
        targetText: "export const value = 1;\n",
        requestText: "TS6133",
        attempt: 1
      });
      expect(result).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});
