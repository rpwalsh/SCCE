// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { it, expect } from "vitest";
import { codeSurfaceTokens, createHasher, persistedKneserNey, trainKneserNey, toJsonValue } from "@scce/kernel";
import { ordinaryWorkspaceProgramFixture } from "./fixtures/ordinary-workspace-program.js";
import { localizeWorkspaceDiagnostics, prepareWorkspaceCodeCommand, runWorkspaceCodeCommand } from "../workspace-code-command.js";
import { checkerDiagnostics } from "../tree-sitter-code-mouth-ports.js";
import { runProcess } from "../document.js";
import { findCodeVerifierCapability } from "../code-verifier-discovery.js";
import type { StructuredPatchValidationPolicy } from "../structured-patch-validation.js";

const access = { tenantId: "workspace-contract-test", principalId: "owner", compartments: [], maximumExportClass: "restricted" as const };
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const source = `export function aggregate(rows: readonly (readonly [string, number])[]): [string, number][] {
 const balances = new Map<string, number>();
 for (const [label, amount] of rows) {
  const previous = balances.get(label) ?? 0;
  balances.set(label, previous + amount);
 }
 return [...balances].sort(([a], [b]) => a.localeCompare(b));
}
`;
async function fixture(mode: "named" | "namespace" | "ambiguous" | "same-file" | "unbound" = "named") {
 const root = await mkdtemp(path.join(tmpdir(), "scce-owned-test-subject-"));
 const files: Record<string, string> = {
  "package.json": JSON.stringify({ type: "module" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", noEmit: true, strict: true, allowJs: true, checkJs: false, allowImportingTsExtensions: true, types: [] }, include: ["**/*.ts", "**/*.mjs"] }),
  "src/ledger.ts": source.replace("previous + amount", "previous - amount"),
  "src/public.ts": 'export { aggregate as foldEntries } from "./ledger.ts";\n',
  "src/index.ts": 'export * from "./public.ts";\n',
  "checks.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\n'
   + (mode === "namespace" ? 'import * as port from "./src/index.ts";\n' : 'import { foldEntries as invoke } from "./src/index.ts";\n')
   + `test("first public contract", () => { assert.deepStrictEqual(${mode === "namespace" ? "port.foldEntries" : "invoke"}([["rent",19],["rent",-7],["food",5]]), [["food",5],["rent",12]]); });\n`
   + `test("second public contract", () => { assert.deepStrictEqual(${mode === "namespace" ? "port.foldEntries" : "invoke"}([["work",-4],["work",9]]), [["work",5]]); });\n`
 };
 if (mode === "namespace") files["checks.mjs"] = `// ${String.fromCodePoint(0x1f9ed)}Cafe\u0301\r\n` + files["checks.mjs"];
 if (mode === "ambiguous" || mode === "same-file" || mode === "unbound") {
  const otherSource = source.replace("aggregate", "anotherAggregate").replace("previous + amount", "previous - amount");
  if (mode === "same-file") files["src/ledger.ts"] += otherSource; else files["src/other.ts"] = otherSource;
  files["checks.mjs"] += mode !== "unbound"
   ? `import { anotherAggregate as other } from "./src/${mode === "same-file" ? "ledger" : "other"}.ts";\ntest("third public contract", () => { assert.deepStrictEqual(other([["left",8]]), [["left",8]]); });\ntest("fourth public contract", () => { assert.deepStrictEqual(other([["right",3]]), [["right",3]]); });\n`
   : 'import { anotherAggregate as other } from "./src/other.ts";\nconst expected = [["left",8]];\ntest("unbound public contract", () => { assert.deepStrictEqual(other([["left",8]]), expected); });\n';
 }
 for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
 const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, { maxFiles: 20, maxFileBytes: 200000 });
 expect(ingested.failed).toBe(0);
 // A public source reference supplies token statistics, not a patch or the independent check's answers.
 const model = trainKneserNey(codeSurfaceTokens(source.replace("aggregate", "publicReference")), { order: 5, discount: 0.75 });
 f.storage.languageMemory.listNgramModels = async () => [{ id: "public.reference.grouped-entries", streamId: "oss_code:reference", languageHint: "opaque", maxOrder: model.order, discount: model.discount, updatedAt: 1,
  modelJson: toJsonValue({ sourceSystem: "oss_code", formalLanguage: "typescript", model: persistedKneserNey(model) }) }];
 const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: "owned.test-subject", commands: [
  { executable: process.execPath, argv: [compiler, "--project", "tsconfig.json", "--noEmit"], checkIds: ["compiler"] },
  { executable: process.execPath, argv: ["--test", "checks.mjs"], checkIds: ["tests"] }
 ], timeoutMs: 15000, maxOutputBytes: 100000, maxWorkspaceFiles: 20, maxWorkspaceBytes: 300000, environment: {} };
 const input = { storage: f.storage, workspaceRoot: root, request: "Repair the project's failing checks.", maxAttempts: 3, projectValidation: { policy }, informationAccess: access };
 return { ...f, root, files, input, run: () => runWorkspaceCodeCommand(input) };
}
async function cleanup(root: string) {
 const target = path.resolve(root); if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("scce-owned-test-subject-")) throw Error("invalid fixture cleanup target");
 await rm(target, { recursive: true, force: true });
}

it.each(["named", "namespace"] as const)("repairs the unique owned production subject through %s re-exports from a protected test-only failure", async mode => {
 const f = await fixture(mode);
 try {
  const result = await f.run();
  expect(result.initialVerification).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: false });
  expect(result.initialVerification!.diagnostics.length).toBeGreaterThan(0);
  expect(result.initialVerification!.diagnostics.every(row => row.path === path.join(f.root, "checks.mjs")), JSON.stringify(result.initialVerification!.diagnostics)).toBe(true);
  expect(result.localization, JSON.stringify(result.localization)).toMatchObject({ status: "selected", targetPath: "src/ledger.ts", selectionBasis: "observed_assertion_and_owned_callable" });
  expect(result.localization.subjectBindings!.every(row => row.subject.bindingResolverId === "scce.source_contract.typescript_checker.v1"
   && row.subject.testHash === `sha256_${createHasher().digestHex(f.files["checks.mjs"]!)}`
   && row.subject.targetHash === `sha256_${createHasher().digestHex(f.files["src/ledger.ts"]!)}`)).toBe(true);
  expect(result.result, JSON.stringify(result.result)).toMatchObject({ outcome: "resolved", proposalSources: ["learned_construction"] });
  expect(result.projectVerification).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: true });
  expect(await readFile(path.join(f.root, "src/ledger.ts"), "utf8")).toBe(source);
  for (const [name, content] of Object.entries(f.files)) if (name !== "src/ledger.ts") expect(await readFile(path.join(f.root, name), "utf8")).toBe(content);
  const hidden = await runProcess(process.execPath, ["--input-type=module", "-e", "import assert from 'node:assert/strict';const {foldEntries}=await import('./src/index.ts');assert.deepEqual(foldEntries([['new',73],['new',-41],['Δ',-8],['Δ',5]]),[['new',32],['Δ',-3]]);assert.deepEqual(foldEntries([]),[]);"], { cwd: f.root });
  expect(hidden.code, hidden.stderr).toBe(0);
 } finally { await cleanup(f.root); }
}, 90000);

it.each(["ambiguous", "same-file", "unbound"] as const)("refuses %s failing production subjects without choosing an imported provider", async mode => {
 const f = await fixture(mode);
 try {
  const result = await f.run();
  expect(result.initialVerification).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: false });
  expect(result.localization.status).toBe("unresolved");
  if (mode === "same-file") expect(result.localization.reasonId).toBe("workspace.code.ambiguous_subjects");
  expect(result.result).toMatchObject({ outcome: "no_proposal", attempts: 0, appliedOperations: [] });
  for (const [name, content] of Object.entries(f.files)) expect(await readFile(path.join(f.root, name), "utf8")).toBe(content);
 } finally { await cleanup(f.root); }
}, 90000);

it("retains mixed file-URI, plain-path and foreign native frames while excluding generic reporter summaries", async () => {
 const f = await fixture();
 try {
  const prepared = await prepareWorkspaceCodeCommand(f.input), testFile = path.join(f.root, "checks.mjs"), foreign = path.join(tmpdir(), "foreign-owned-by-someone-else", "checks.mjs");
  const diagnostics = checkerDiagnostics({ code: 1, stdout: "opaque summary checks.mjs:4:1", stderr: `at uri (${pathToFileURL(testFile).href}:4:46)\nat plain (${testFile}:5:47)\nat foreign (${foreign}:2:3)` }, "", "javascript", f.root);
  expect(diagnostics.map(row => row.path)).toEqual([testFile, testFile, foreign]);
  const result = localizeWorkspaceDiagnostics(prepared, diagnostics);
  expect(result).toMatchObject({ status: "unresolved", reasonId: "workspace.code.unmapped_observation" });
  expect(result.unmappedDiagnosticIds).toContain(diagnostics[2]!.id);
  expect(result.subjectBindings!.length).toBeGreaterThan(0);
 } finally { await cleanup(f.root); }
}, 90000);

it.each(["quarantined", "stale"] as const)("refuses %s source ownership before any protected-test localization", async kind => {
 const f = await fixture();
 try {
  if (kind === "stale") await writeFile(path.join(f.root, "src/ledger.ts"), f.files["src/ledger.ts"] + "// changed after ingestion\n");
  else { const version = f.versions.find(row => (row.metadata as any)?.workspaceFile?.path === "src/ledger.ts")!; for (const span of f.spans.filter(row => row.sourceVersionId === version.sourceVersionId)) span.status = "quarantined"; }
  await expect(f.run()).rejects.toThrow(kind === "stale" ? "canonical workspace file identity changed: src/ledger.ts" : "automatic localization source ownership unavailable");
  expect(await readFile(path.join(f.root, "checks.mjs"), "utf8")).toBe(f.files["checks.mjs"]);
 } finally { await cleanup(f.root); }
}, 90000);

it("repairs the Python tuple assertion subject through the existing learned behavioral port", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "scce-owned-test-subject-"));
 try {
  const tool = await findCodeVerifierCapability("python"); if (tool.status !== "available") throw Error(tool.reason);
  const original = "def aggregate(rows):\n    balances = {}\n    for label, amount in rows:\n        previous = balances.get(label, 0)\n        balances[label] = previous + amount\n    return sorted(balances.items())\n";
  const tests = "import unittest\nfrom ledger import aggregate as invoke\nclass Check(unittest.TestCase):\n    def test_first(self):\n        self.assertEqual(invoke([('rent',19),('rent',-7),('food',5)]), [('food',5),('rent',12)])\n    def test_second(self):\n        self.assertEqual(invoke([('work',-4),('work',9)]), [('work',5)])\nif __name__ == '__main__': unittest.main()\n";
  await writeFile(path.join(root, "ledger.py"), original.replace("previous + amount", "previous - amount"));
  await writeFile(path.join(root, "checks.py"), tests);
  await writeFile(path.join(root, "entry.py"), "from ledger import aggregate as fold_entries\n");
  const f = ordinaryWorkspaceProgramFixture(root); expect((await f.runtime.ingest(root, { maxFiles: 10, maxFileBytes: 100000 })).failed).toBe(0);
  const model = trainKneserNey(codeSurfaceTokens(original.replace("aggregate", "public_reference")), { order: 5, discount: 0.75 });
  f.storage.languageMemory.listNgramModels = async () => [{ id: "public.reference.grouped-entries.py", streamId: "oss_code:reference.py", languageHint: "opaque", maxOrder: model.order, discount: model.discount, updatedAt: 1,
   modelJson: toJsonValue({ sourceSystem: "oss_code", formalLanguage: "python", model: persistedKneserNey(model) }) }];
  const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: "owned.python.test-subject", commands: [
   { executable: tool.verifier.command, argv: ["-m", "py_compile", "ledger.py", "checks.py", "entry.py"], checkIds: ["compiler"] },
   { executable: tool.verifier.command, argv: ["checks.py"], checkIds: ["tests"] }
  ], timeoutMs: 15000, maxOutputBytes: 100000, maxWorkspaceFiles: 10, maxWorkspaceBytes: 200000, environment: {} };
  const result = await runWorkspaceCodeCommand({ storage: f.storage, workspaceRoot: root, request: "Repair the project's failing checks.", maxAttempts: 3, projectValidation: { policy }, informationAccess: access });
  expect(result.initialVerification).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: false });
  expect(result.initialVerification!.diagnostics.every(row => row.path === path.join(root, "checks.py")), JSON.stringify(result.initialVerification!.diagnostics)).toBe(true);
  expect(result.localization, JSON.stringify(result.localization)).toMatchObject({ status: "selected", targetPath: "ledger.py", selectionBasis: "observed_assertion_and_owned_callable" });
  expect(result.result, JSON.stringify(result.result)).toMatchObject({ outcome: "resolved" });
  const proposalSources = result.result.proposalSources ?? [];
  expect(proposalSources.length).toBeGreaterThan(0);
  expect(proposalSources.every(source => source === "learned_construction")).toBe(true);
  expect(result.projectVerification).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: true });
  expect(await readFile(path.join(root, "ledger.py"), "utf8")).toBe(original);
  expect(await readFile(path.join(root, "checks.py"), "utf8")).toBe(tests);
  const hidden = await runProcess(tool.verifier.command, ["-c", "from entry import fold_entries; got=fold_entries([('fresh',73),('fresh',-41),('new',-8),('new',5)]); assert got == [('fresh',32),('new',-3)]; assert all(isinstance(row,tuple) for row in got); assert fold_entries([]) == []"], { cwd: root });
  expect(hidden.code, hidden.stderr).toBe(0);
 } finally { await cleanup(root); }
}, 90000);
