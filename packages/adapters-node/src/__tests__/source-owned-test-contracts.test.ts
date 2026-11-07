// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypeScriptSemanticProgramIndex } from "../typescript-semantic-program-index.js";
import { sourceOwnedTestCases } from "../source-owned-test-contracts.js";

describe("source-owned Node assertion contracts", () => {
  it("extracts literal cases only when the semantic index resolves the called target", async () => {
    const entries = {
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src/**/*.ts", "spec/**/*.ts"] }),
      "src/filtre.ts": "export function filtre_éléments(values: number[]) { return [...new Set(values)]; }\n",
      "spec/filtre.spec.ts": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { filtre_éléments } from '../src/filtre.js';\ntest('deduplicates', () => { assert.deepStrictEqual(filtre_éléments([1, 1, 2]), [1, 2]); });\n"
    };
    const root = await mkdtemp(path.join(tmpdir(), "scce-owned-contract-"));
    try {
      for (const [name, text] of Object.entries(entries)) { const file = path.join(root, ...name.split("/")); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
      const paths = Object.keys(entries);
      const program = await buildTypeScriptSemanticProgramIndex({ workspaceRoot: root, tsconfigPath: "tsconfig.json", bounds: { workspacePaths: paths, observedTestPaths: ["spec/filtre.spec.ts"], maxFiles: 8, maxFileBytes: 32_000, maxTotalBytes: 64_000 } });
      const source = program.files.find(file => file.path === "src/filtre.ts")!;
      const test = program.files.find(file => file.path === "spec/filtre.spec.ts")!;
      const cases = sourceOwnedTestCases({ program,
        sourceVersions: new Map([[source.path, { sourceVersionId: "sv-source", sourceHash: source.contentHash }]]),
        testVersions: new Map([[test.path, { sourceVersionId: "sv-test", sourceHash: test.contentHash }]]),
        sourceTexts: new Map([[test.path, entries["spec/filtre.spec.ts"]]])
      });
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({ targetName: "filtre_éléments", sourceVersionId: "sv-source", testSourceVersionId: "sv-test", arguments: [[1, 1, 2]], expectedResult: [1, 2] });
      expect(cases[0]!.inputSpan.end).toBeGreaterThan(cases[0]!.inputSpan.start);
      expect(cases[0]!.expectedSpan.textHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects non-Node assertions and non-literal expected values", async () => {
    const entries = {
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src/**/*.ts", "spec/**/*.ts"] }),
      "src/target.ts": "export function cible(values: number[]) { return values; }\n",
      "spec/target.spec.ts": "import { test } from 'node:test';\nimport { deepStrictEqual } from './custom-assert.js';\nimport { cible } from '../src/target.js';\ntest('no contract', () => { deepStrictEqual(cible([1]), expectedValue); });\n",
      "spec/custom-assert.ts": "export function deepStrictEqual(_a: unknown, _b: unknown) {}\n"
    };
    const root = await mkdtemp(path.join(tmpdir(), "scce-owned-contract-reject-"));
    try {
      for (const [name, text] of Object.entries(entries)) { const file = path.join(root, ...name.split("/")); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
      const paths = Object.keys(entries);
      const program = await buildTypeScriptSemanticProgramIndex({ workspaceRoot: root, tsconfigPath: "tsconfig.json", bounds: { workspacePaths: paths, observedTestPaths: ["spec/target.spec.ts"], maxFiles: 8, maxFileBytes: 32_000, maxTotalBytes: 64_000 } });
      const source = program.files.find(file => file.path === "src/target.ts")!;
      const test = program.files.find(file => file.path === "spec/target.spec.ts")!;
      expect(sourceOwnedTestCases({ program, sourceVersions: new Map([[source.path, { sourceVersionId: "sv", sourceHash: source.contentHash }]]), testVersions: new Map([[test.path, { sourceVersionId: "tv", sourceHash: test.contentHash }]]), sourceTexts: new Map([[test.path, entries["spec/target.spec.ts"]]]) })).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
