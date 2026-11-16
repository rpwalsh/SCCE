// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalStringify, createHasher, ownedNativeLiteral, readWorkspaceOwnedProgramContracts, sourceOwnedProgramBehaviorFromDocumentation,
  SOURCE_OWNED_CONTRACT_COMPILER_RECIPE, workspaceContractComponentRecipe, COGNITIVE_OPERATOR_IDS, createClock, createIdFactory,
  createProgramGraphBuilder, programIntentForTurn, projectSourceOwnedProgramBehavior, type SemanticEntailmentResult, type WorkspaceContractProjection } from "@scce/kernel";
import { codeRequestSignal } from "../../../kernel/src/code-request.js";
import { grammarSourceOwnedTestCases } from "../grammar-source-owned-test-contracts.js";
import { sourceOwnedTestContractProjections } from "../source-owned-test-contracts.js";
import { ordinaryWorkspaceProgramFixture } from "./fixtures/ordinary-workspace-program.js";
import { NodeBuildTestAdapter } from "../process.js";
import { runProcess } from "../document.js";
import type { ScceRuntimeConfig } from "../config.js";

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const access = { tenantId: "workspace-contract-test", principalId: "owner", compartments: [], maximumExportClass: "restricted" as const };
const provider = "def preserve(value):\n    return value\n";
const publicTests = "import unittest as framework\nfrom subject import preserve as invoke\nclass Check(framework.TestCase):\n    def test_empty(self):\n        self.assertEqual(invoke(()), ())\n    def test_singleton(self):\n        self.assertEqual(invoke(('public',)), ('public',))\n    def test_nested(self):\n        self.assertEqual(invoke(([('public', 7)], ((), [3]))), ([('public', 7)], ((), [3])))\nif __name__ == '__main__': framework.main()\n";
function files(test = publicTests, extra: Record<string, string> = {}) {
  return Object.entries({ "subject.py": provider, "checks.py": test, ...extra }).map(([path, text]) => ({ path, text, languageId: "python" as const, sourceHash: hash(text), sourceVersionId: `version_${hash(text).slice(7)}` }));
}
async function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("scce-python-tuple-")) throw Error("invalid tuple fixture cleanup target");
  await rm(resolved, { recursive: true, force: true });
}

it("retains empty, singleton and nested tuple/list identity across source extraction and existing behavior IR", async () => {
  const owned = files(), cases = await grammarSourceOwnedTestCases(owned);
  expect(cases).toHaveLength(3);
  expect(cases.map(row => row.expectedResult)).toEqual([[], ["public"], [[["public", 7]], [[], [3]]]]);
  expect(cases[0]!.nativeExpected).toMatchObject({ kind: "value", value: [], nativePythonShape: { kind: "tuple", items: [] } });
  expect(cases[1]!.nativeExpected).toMatchObject({ nativePythonShape: { kind: "tuple", items: [null] } });
  expect(cases[2]!.nativeExpected).toMatchObject({ nativePythonShape: { kind: "tuple", items: [
    { kind: "list", items: [{ kind: "tuple", items: [null, null] }] },
    { kind: "tuple", items: [{ kind: "tuple", items: [] }, { kind: "list", items: [null] }] }
  ] } });
  for (const row of cases) {
    expect(row.nativeArguments).toEqual([row.nativeExpected]);
    expect(hash(publicTests.slice(row.expectedSpan.start, row.expectedSpan.end))).toBe(row.expectedSpan.textHash);
    expect(hash(publicTests.slice(row.assertionSpan.start, row.assertionSpan.end))).toBe(row.assertionSpan.textHash);
  }
  const patterns = [...sourceOwnedTestContractProjections(cases, "fixture://tuple").values()].flat().map(patternJson => ({ patternJson }));
  const behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText: "Python preserve", patterns,
    intent: { languageId: "python", symbols: [], references: [{ sourceFamily: "fixture://tuple", relativePath: "subject.py", sourceHash: owned[0]!.sourceHash, score: 1 }], audit: null } });
  expect(behavior.behaviorRequirements).toHaveLength(3);
  expect(behavior.behaviorRequirements.map(row => row.sourceContract!.nativeExpected)).toEqual(cases.map(row => row.nativeExpected));
  expect(behavior.behaviorRequirements.map(row => row.sourceContract!.nativeArguments)).toEqual(cases.map(row => row.nativeArguments));
  const rootAssertions = await grammarSourceOwnedTestCases(files("from subject import preserve\ndef checks():\n    assert preserve(()) == ()\n    assert preserve((7,)) == (7,)\n"));
  expect(rootAssertions).toHaveLength(2);
  const directAlias = await grammarSourceOwnedTestCases(files(publicTests.replace("import unittest as framework", "from unittest import TestCase as Base").replace("framework.TestCase", "Base").replace("if __name__ == '__main__': framework.main()\n", "")));
  expect(directAlias).toHaveLength(3);
});

it.each([
  { label: "nonliteral expected tuple", test: publicTests.replace("('public',))", "(unknown,))"), count: 2, removed: ["public"] },
  { label: "unbound subject", test: publicTests.replace("invoke(())", "unbound(())"), count: 2, removed: [] },
  { label: "starred nonliteral input", test: publicTests.replace("invoke(('public',))", "invoke((*unknown,))"), count: 2, removed: ["public"] },
  { label: "rebound framework", test: publicTests.replace("class Check", "framework = custom\nclass Check"), count: 0, removed: [] },
  { label: "overridden standard assertion", test: publicTests.replace("class Check", "framework.TestCase.assertEqual = lambda *args: None\nclass Check"), count: 0, removed: [] },
  { label: "receiver shadows imported subject", test: publicTests.replace("def test_empty(self):\n        self.assertEqual", "def test_empty(invoke):\n        invoke.assertEqual"), count: 2, removed: [] },
  { label: "replaced class lifecycle", test: publicTests + "Check.setUp = custom\n", count: 0, removed: [] },
  { label: "overwritten test method", test: publicTests.replace("def test_singleton", "def test_empty"), count: 0, removed: [] },
  { label: "custom TestCase lifecycle", test: publicTests.replace("    def test_empty", "    def setUp(self):\n        pass\n    def test_empty"), count: 0, removed: [] }
])("withholds $label", async ({ test, count, removed }) => {
  const cases = await grammarSourceOwnedTestCases(files(test));
  expect(cases).toHaveLength(count);
  if (count === 2) expect(cases.some(row => canonicalStringify(row.expectedResult) === canonicalStringify(removed))).toBe(false);
});

it("refuses an incomplete snapshot and local unittest shadow before acquiring tuple contracts", async () => {
  const owned = files();
  expect(await grammarSourceOwnedTestCases(owned, { knownPaths: owned.map(row => row.path), complete: false })).toEqual([]);
  expect(await grammarSourceOwnedTestCases(files(publicTests, { "unittest.py": "class TestCase: pass\n" }))).toEqual([]);
});

it("rejects malformed tuple witnesses while preserving existing primitive native number semantics", () => {
  const valid = { kind: "value", value: [[], 1], nativePythonShape: { kind: "tuple", items: [{ kind: "list", items: [] }, null] } };
  expect(ownedNativeLiteral(valid, [[], 1])).toEqual(valid);
  for (const shape of [{ kind: "tuple", items: [] }, { kind: "set", items: [null, null] }, { kind: "tuple", items: [null, null] },
    { kind: "tuple", items: [{ kind: "list", items: [] }, { kind: "tuple", items: [] }] }, { ...valid.nativePythonShape, extra: true }]) {
    expect(ownedNativeLiteral({ ...valid, nativePythonShape: shape }, [[], 1])).toBeUndefined();
  }
  expect(ownedNativeLiteral({ kind: "value", value: 0, nativeNumberKind: "float", nativeNegativeZero: true }, 0)).toMatchObject({ nativeNumberKind: "float", nativeNegativeZero: true });
  expect(ownedNativeLiteral({ kind: "value", value: 2, nativeNumberKind: "integer" }, 2)).toMatchObject({ nativeNumberKind: "integer" });
});

it("executes a source-owned Python tuple program and rejects a compiling list-returning mutant", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-python-tuple-native-"));
  try {
    for (const file of files()) await writeFile(path.join(root, file.path), file.text);
    const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, { maxFiles: 10, maxFileBytes: 100000 });
    const context = { schema: "scce.workspace.program-context.v1", workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt };
    const owned = await readWorkspaceOwnedProgramContracts({ storage: f.storage, context, informationAccess: access });
    expect(owned.status).toBe("available"); if (owned.status !== "available") throw Error(owned.reasonId);
    const sourceVersion = f.versions.find(row => row.canonicalUri.endsWith("subject.py"))!;
    const intent = { languageId: "python", symbols: [], references: [{ sourceFamily: `scce://workspace/${encodeURIComponent(context.workspaceId)}`, relativePath: "subject.py", sourceHash: String(sourceVersion.contentHash), score: 1 }], audit: null };
    const behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText: "Python preserve", intent, patterns: owned.contracts });
    expect(behavior.behaviorRequirements).toHaveLength(3);
    const codeSignal = projectSourceOwnedProgramBehavior({ codeSignal: codeRequestSignal("Python preserve"), intent, sourceBehavior: behavior });
    const programIntent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal, evidence: [] })!;
    const hasher = createHasher(), clock = createClock({ fixedTime: 93000, stepMs: 1 }), ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const construct = createProgramGraphBuilder({ idFactory: ids, hasher }).build({ episodeId: ids.episodeId(), text: "Python preserve", createdAt: clock.now(), evidence: [], programIntent, entailment: emptyEntailment(ids) });
    const native = new NodeBuildTestAdapter({ runtime: { tempRoot: root } } as ScceRuntimeConfig);
    const passed = await native.executeProgram({ episodeId: construct.episodeId, construct });
    expect(passed.passed, JSON.stringify(passed)).toBe(true); expect(passed.testExecutionReceipt?.status).toBe("executed");
    const sourceFile = construct.program!.files.find(file => file.path === construct.program!.entrypoint)!;
    expect(sourceFile.content).toContain("return args[0] if len(args) == 1 else list(args)");
    const artifacts = construct.artifacts.map(artifact => {
      if (artifact.path !== sourceFile.path) return artifact;
      const content = artifact.content.replace("return args[0] if len(args) == 1 else list(args)", "return list(args[0]) if len(args) == 1 else list(args)");
      return { ...artifact, content, contentHash: `sha256_${createHasher().digestHex(content)}` as typeof artifact.contentHash };
    });
    const mutated = artifacts.find(artifact => artifact.path === sourceFile.path)!;
    expect(mutated.content).not.toBe(sourceFile.content);
    const rejected = await native.executeProgram({ episodeId: construct.episodeId, construct: { ...construct, artifacts } });
    expect(rejected.build.code, rejected.build.stderr).toBe(0);
    expect(rejected.passed).toBe(false); expect(rejected.test.code).not.toBe(0);
    expect(rejected.testExecutionReceipt?.status).toBe("executed");
    const hiddenRoot = path.join(root, "independent"); await mkdir(hiddenRoot);
    const hiddenFile = path.join(hiddenRoot, "subject.py"); await writeFile(hiddenFile, sourceFile.content);
    const independent = await runProcess("python", ["-c", "from subject import preserve; value=([('withheld-842',-19)], ((), [73])); got=preserve(value); assert got == value; assert type(got) is tuple; assert type(got[0]) is list; assert type(got[0][0]) is tuple; assert type(got[1]) is tuple; assert type(got[1][0]) is tuple; assert type(got[1][1]) is list; assert preserve(()) == (); assert type(preserve(('private',))) is tuple"], { cwd: hiddenRoot });
    expect(independent.code, independent.stderr).toBe(0);
    expect(JSON.stringify(f.spans)).not.toContain("withheld-842");
  } finally { await cleanup(root); }
}, 90000);

function emptyEntailment(ids: ReturnType<typeof createIdFactory>): SemanticEntailmentResult {
  const claimId = ids.claimId("owned tuple"), proofId = ids.proofId({ claimId, evidenceIds: [], transforms: [], validatorVersion: "fixture" });
  return {
    claim: { id: claimId, text: "", normalized: "", features: [], polarity: 1 },
    verdict: "underdetermined", semanticVerdict: "underdetermined", force: "unknown", support: 0, contradiction: 0, faithfulnessLcb: 0,
    confidence: { verdict: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, faithfulnessLCB: 0, contradiction: 0, stability: 1 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: proofId, claimId, verdict: "unknown", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 93000 }
  };
}

it("invalidates only the old Python component cache and republishes an empty legacy projection without reingestion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-python-tuple-cache-"));
  try {
    for (const file of files()) await writeFile(path.join(root, file.path), file.text);
    const f = ordinaryWorkspaceProgramFixture(root), first = await f.runtime.ingest(root, { maxFiles: 10, maxFileBytes: 100000 });
    const workspace = (await f.storage.workspace.getWorkspace(first.workspace.id))!, metadata = workspace.metadata as any, receipt = metadata.sourceContracts;
    const projection = JSON.parse(Buffer.from(await f.storage.blobs.get(receipt.blobHash)).toString("utf8")) as WorkspaceContractProjection;
    const records = await f.storage.workspace.listSourceFiles({ workspaceId: workspace.id });
    const fileKeys = records.map(row => [row.path, row.contentHash, row.sourceVersionId, row.ingestionStatus === "missing"]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const legacyRecipe = `${SOURCE_OWNED_CONTRACT_COMPILER_RECIPE}:${createHasher().digestHex(canonicalStringify({ complete: true, files: fileKeys, owners: projection.owners }))}`;
    expect(legacyRecipe).not.toBe(receipt.componentRecipe);
    const legacy = { ...projection, componentRecipe: legacyRecipe, contracts: [] }, blobHash = await f.storage.blobs.put(new TextEncoder().encode(canonicalStringify(legacy)), "application/json");
    await f.storage.workspace.putWorkspace({ ...workspace, metadata: { ...metadata, sourceContracts: { ...receipt, blobHash, componentRecipe: legacyRecipe, contractCount: 0 } } });
    const context = { schema: "scce.workspace.program-context.v1", workspaceId: workspace.id, expectedWorkspaceUpdatedAt: workspace.updatedAt };
    expect(await readWorkspaceOwnedProgramContracts({ storage: f.storage, context, informationAccess: access })).toMatchObject({ status: "unavailable", reasonId: "workspace.contracts.current_owner_scope_changed" });
    const ids = f.versions.map(row => row.sourceVersionId), profiles = await f.storage.model.listLanguageProfiles(), ingest = vi.spyOn(f.kernel, "ingest"), publication = vi.spyOn(f.storage.blobs, "put");
    const updated = await f.runtime.ingest(root, { maxFiles: 10, maxFileBytes: 100000 });
    expect(updated.sourceContracts).toMatchObject({ status: "compiled", contracts: 1 });
    expect(ingest).not.toHaveBeenCalled(); expect(publication).toHaveBeenCalledTimes(1);
    expect(f.versions.map(row => row.sourceVersionId)).toEqual(ids); expect(await f.storage.model.listLanguageProfiles()).toEqual(profiles);
    context.expectedWorkspaceUpdatedAt = updated.workspace.updatedAt;
    expect(await readWorkspaceOwnedProgramContracts({ storage: f.storage, context, informationAccess: access })).toMatchObject({ status: "available" });
    const nonPython = records.map(row => ({ ...row, path: row.path.replace(/\.py$/u, ".ts") }));
    const keys = nonPython.map(row => [row.path, row.contentHash, row.sourceVersionId, row.ingestionStatus === "missing"]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(workspaceContractComponentRecipe({ complete: true, records: nonPython, owners: projection.owners })).toBe(`${SOURCE_OWNED_CONTRACT_COMPILER_RECIPE}:${createHasher().digestHex(canonicalStringify({ complete: true, files: keys, owners: projection.owners }))}`);
  } finally { await cleanup(root); }
}, 90000);
