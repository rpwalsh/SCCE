import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDeveloperRepo,
  dryRunDeveloperRepoPlan,
  graphDeveloperRepo,
  inspectDeveloperRepo,
  parseRepoDiagnosticsFixture
} from "../repo-intelligence-folder.js";

describe("repo intelligence folder runtime", () => {
  it("analyzes a temp repo into inspectable source-only Developer Intelligence graphs", async () => {
    const root = await createRepoFixture();
    try {
      const analysis = await analyzeDeveloperRepo(root);
      const snapshot = analysis.snapshot;

      expect(analysis.schema).toBe("scce.repoIntelligenceAnalysis.v1");
      expect(analysis.dryRun).toBe(true);
      expect(analysis.mutation).toEqual({ postgres: false, filesystemWrites: false, serverStarted: false, network: false });
      expect(snapshot.summary.fileCount).toBeGreaterThanOrEqual(6);
      expect(snapshot.engineeringContext.plannerHints.packageManagers.some(manager => manager.startsWith("pnpm"))).toBe(true);
      expect(snapshot.buildGraph.buildCommands.map(command => command.scriptName)).toContain("build");
      expect(snapshot.testGraph.testCommands.map(command => command.scriptName)).toContain("test");
      expect(snapshot.dependencyGraph.dependencies.map(dep => dep.name)).toEqual(expect.arrayContaining(["@example/runtime", "vitest", "typescript"]));
      expect(snapshot.symbolGraph.nodes.map(symbol => symbol.name)).toEqual(expect.arrayContaining(["WidgetState", "WidgetRuntime", "renderWidget", "parseRecord"]));
      expect(snapshot.symbolGraph.imports.some(item => item.moduleSpecifier === "@example/runtime")).toBe(true);
      expect(snapshot.symbolGraph.exports.some(item => item.exportedNames.includes("renderWidget"))).toBe(true);
      expect(snapshot.evidenceSpans.some(span => span.sourcePath === "README.md")).toBe(true);
      expect(snapshot.codeFacts.every(fact => fact.sourcePath !== "README.md")).toBe(true);
      expect(snapshot.hydration.valid).toBe(true);
      expect(snapshot.files.map(file => file.sourcePath)).not.toContain("source-export.zip");
      expect(analysis.unsupportedFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "source-export.zip", reason: "archive_file" })
      ]));

      const inspect = await inspectDeveloperRepo(root);
      const inspectRecord = asRecord(inspect);
      expect(asRecord(inspectRecord.summary).symbolCount).toBe(snapshot.summary.symbolCount);
      expect(JSON.stringify(inspectRecord.buildCommands)).toContain("tsc -p tsconfig.json");

      const graph = asRecord(await graphDeveloperRepo(root));
      expect(asRecord(graph.nodes).symbols).toBeTruthy();
      expect(asRecord(graph.edges).dependency).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses compiler, stack, and test diagnostic fixtures into structured records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-phase9-diag-"));
    const fixture = path.join(root, "diagnostics.txt");
    await writeFile(fixture, [
      "src/widget.ts(7,15): error TS2322: Type number is not assignable to type string.",
      "    at renderWidget (src/widget.ts:11:3)",
      "FAIL src/widget.test.ts renders widget",
      "expected value to equal rendered output"
    ].join("\n"), "utf8");
    try {
      const result = await parseRepoDiagnosticsFixture(fixture);
      expect(result.schema).toBe("scce.repoDiagnosticFixture.v1");
      expect(result.dryRun).toBe(true);
      expect(result.diagnostics.some(item => item.diagnosticKindId === "diagnostic.kind.compiler" && item.diagnosticCode === "TS2322" && item.line === 7 && item.column === 15)).toBe(true);
      expect(result.diagnostics.some(item => item.observedSeverity === "stack" && item.relatedSymbol === "renderWidget")).toBe(true);
      expect(result.diagnostics.some(item => item.diagnosticKindId === "diagnostic.kind.test" && item.testName === "renders widget")).toBe(true);
      expect(result.validationInput.riskIds).toEqual(expect.arrayContaining(["diagnostic.kind.compiler", "diagnostic.kind.test"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dry-run plan uses observed commands and leaves fixture files unchanged", async () => {
    const root = await createRepoFixture();
    try {
      const before = await fileHashes(root, ["package.json", "src/widget.ts", "src/widget.test.ts", "README.md"]);
      const plan = await dryRunDeveloperRepoPlan(root);
      const after = await fileHashes(root, ["package.json", "src/widget.ts", "src/widget.test.ts", "README.md"]);

      expect(plan.schema).toBe("scce.repoPlanDryRun.v1");
      expect(plan.dryRun).toBe(true);
      expect(plan.mutation).toEqual({ postgres: false, filesystemWrites: false, serverStarted: false, network: false });
      expect(plan.observedBuildCommands.map(command => command.command)).toContain("tsc -p tsconfig.json");
      expect(plan.observedTestCommands.map(command => command.command)).toContain("vitest run");
      expect(plan.observedDependencies.map(dep => dep.name)).toContain("@example/runtime");
      expect(plan.observedSourceLayout).toEqual(expect.arrayContaining(["src/widget.ts", "src/widget.test.ts", "README.md"]));
      expect(after).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-phase9-repo-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "phase9-dev-intel",
    version: "1.0.0",
    scripts: {
      build: "tsc -p tsconfig.json",
      test: "vitest run",
      dev: "vite --host 127.0.0.1"
    },
    dependencies: {
      "@example/runtime": "^1.0.0"
    },
    devDependencies: {
      typescript: "^5.8.0",
      vitest: "^3.2.0"
    }
  }, null, 2), "utf8");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
    include: ["src/**/*.ts"]
  }, null, 2), "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      '@example/runtime':",
    "        specifier: ^1.0.0"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "README.md"), [
    "# Phase 9 Repo",
    "",
    "This repository fixture documents the widget runtime and command surface.",
    "The README is language evidence, not a code fact."
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "src", "widget.ts"), [
    "import { createRuntime } from '@example/runtime';",
    "export interface WidgetState { ready: boolean }",
    "export class WidgetRuntime {",
    "  runtime = createRuntime();",
    "}",
    "export function renderWidget(state: WidgetState) {",
    "  return state.ready ? 'ready' : 'waiting';",
    "}",
    "export function parseRecord(value: string) {",
    "  return value.trim();",
    "}"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "src", "widget.test.ts"), [
    "import { test, expect } from 'vitest';",
    "import { renderWidget } from './widget.js';",
    "test('renders widget', () => {",
    "  expect(renderWidget({ ready: true })).toBe('ready');",
    "});"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "src", "nested", "helper.js"), [
    "export function helper(value) {",
    "  return String(value);",
    "}"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "source-export.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  return root;
}

async function fileHashes(root: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    out[file] = createHash("sha256").update(bytes).digest("hex");
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
