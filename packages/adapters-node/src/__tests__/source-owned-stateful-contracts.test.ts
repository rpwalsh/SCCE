// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildTypeScriptSemanticProgramIndex } from "../typescript-semantic-program-index.js";
import { sourceOwnedTestCases } from "../source-owned-test-contracts.js";
import { sourceOwnedProgramBehaviorFromDocumentation, sourceOwnedBehaviorRequirementsFromDocumentation,
  projectSourceOwnedProgramBehavior, type CodeIntent } from "../../../kernel/src/code-intent.js";
import { codeRequestSignal } from "../../../kernel/src/code-request.js";
import { COGNITIVE_OPERATOR_IDS, createClock, createHasher, createIdFactory, createProgramGraphBuilder,
  programIntentForTurn, replanOwnerBehaviorProgramIntent, toJsonValue, type SemanticEntailmentResult } from "@scce/kernel";
import { NodeBuildTestAdapter } from "../process.js";
import type { ScceRuntimeConfig } from "../config.js";

async function fixture(callback: string) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-stateful-source-"));
  const entries = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src/**/*.ts", "examples/**/*.ts"] }),
    "src/phonebook.ts": "const state = new Map<string,string>(); export function f0(key:string,value:string) { state.set(key,value); } export function f1(key:string) { return state.get(key); }\n",
    "examples/phonebook.spec.ts": "import { test } from 'node:test'; import assert from 'node:assert/strict'; import {f0 as k0,f1 as k1} from '../src/phonebook.js'; test('observed sequence', () => {" + callback + "});\n"
  };
  for (const [name, text] of Object.entries(entries)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
  const program = await buildTypeScriptSemanticProgramIndex({ workspaceRoot: root, tsconfigPath: "tsconfig.json",
    bounds: { workspacePaths: Object.keys(entries), observedTestPaths: ["examples/phonebook.spec.ts"], maxFiles: 8, maxFileBytes: 32000, maxTotalBytes: 64000 } });
  const source = program.files.find(file => file.path === "src/phonebook.ts")!, test = program.files.find(file => file.path === "examples/phonebook.spec.ts")!;
  const cases = sourceOwnedTestCases({ program, sourceVersions: new Map([[source.path, { sourceVersionId: "owned-source", sourceHash: source.contentHash }]]),
    testVersions: new Map([[test.path, { sourceVersionId: "owned-examples", sourceHash: test.contentHash }]]), sourceTexts: new Map([[test.path, entries["examples/phonebook.spec.ts"]]]) });
  const intent: CodeIntent = { languageId: "typescript", symbols: [], references: [{ relativePath: source.path, sourceFamily: "repo:owned", sourceHash: source.contentHash, languageId: "typescript", score: 1 }], audit: null };
  const patterns = [{ patternJson: toJsonValue({ schema: "scce.source_owned_test_contract.v1", repositoryFamily: "repo:owned",
    sourcePath: source.path, sourceHash: source.contentHash, sourceVersionId: "owned-source", formalLanguage: "typescript",
    targetSymbolId: cases[0]?.targetSymbolId ?? "missing", targetName: cases[0]?.targetName ?? "missing", cases }) }];
  return { root, cases, intent, patterns };
}

describe("owned source stateful contract acquisition", () => {
  it("retains checker-bound ordered writes and reads instead of contradictory scalar examples", async () => {
    const source = await fixture("k0('a','111'); assert.strictEqual(k1('a'),'111'); k0('a','222'); assert.strictEqual(k1('a'),'222');");
    try {
      expect(source.cases).toHaveLength(2);
      expect(source.cases.map(row => row.arguments)).toEqual([["a"], ["a"]]);
      expect(source.cases.map(row => row.expectedResult)).toEqual(["111", "222"]);
      expect(source.cases.map(row => row.invocations?.map(invocation => invocation.targetName))).toEqual([["f0", "f1"], ["f0", "f1", "f0", "f1"]]);
      const input = { requestText: "Create the documented address book.", intent: source.intent, patterns: source.patterns };
      const behavior = sourceOwnedProgramBehaviorFromDocumentation(input);
      expect(behavior.behaviorRequirements).toEqual([]);
      expect(sourceOwnedBehaviorRequirementsFromDocumentation(input)).toEqual([]);
      expect(behavior.statefulBehaviorRequirements).toHaveLength(2);
      expect(behavior.statefulBehaviorRequirements.map(row => row.verificationRole)).toEqual(["fit", "held_out"]);
      expect(behavior.statefulBehaviorRequirements[1]?.sourceContract?.invocations.map(row => row.targetSymbolId)).toEqual(source.cases[1]?.invocations?.map(row => row.targetSymbolId));
      const signal = projectSourceOwnedProgramBehavior({ codeSignal: { ...codeRequestSignal(input.requestText), language: "typescript" }, intent: source.intent, sourceBehavior: behavior });
      expect(signal.language).toBe("typescript");
      expect(signal.statefulBehaviorRequirements).toEqual(behavior.statefulBehaviorRequirements);
    } finally { await rm(source.root, { recursive: true, force: true }); }
  });

  it.each([
    "if (true) { k0('a','111'); } assert.strictEqual(k1('a'),'111'); assert.strictEqual(k1('a'),'222');",
    "unknownOperation(); k0('a','111'); assert.strictEqual(k1('a'),'111'); assert.strictEqual(k1('a'),'222');"
  ])("refuses unbound or conditional invocation order: %s", async callback => {
    const source = await fixture(callback);
    try { expect(source.cases).toEqual([]); } finally { await rm(source.root, { recursive: true, force: true }); }
  });

  it("propagates selected document language without requiring any scalar examples", () => {
    const signal = projectSourceOwnedProgramBehavior({ codeSignal: codeRequestSignal("Create the documented artifact."),
      intent: { languageId: "python", symbols: [], references: [], audit: null }, sourceBehavior: { behaviorRequirements: [], statefulBehaviorRequirements: [] } });
    expect(signal.language).toBe("python");
    expect(signal.behaviorRequirements).toEqual([]);
  });

  it("rejects foreign source ownership, changed target identities and reordered call witnesses", async () => {
    const source = await fixture("k0('a','111'); assert.strictEqual(k1('a'),'111'); k0('a','222'); assert.strictEqual(k1('a'),'222');");
    try {
      for (const corruption of ["foreign-version", "foreign-path", "wrong-target", "reordered", "wrong-final-arguments"]) {
        const patterns = structuredClone(source.patterns);
        const body = patterns[0]!.patternJson as Record<string, unknown>;
        const cases = body.cases as Array<{ invocations: Array<Record<string, unknown>> }>;
        const invocations = cases[0]!.invocations;
        if (corruption === "foreign-version") invocations[0]!.sourceVersionId = "foreign-source";
        if (corruption === "foreign-path") invocations[0]!.sourcePath = "src/unselected.ts";
        if (corruption === "wrong-target") invocations.at(-1)!.targetSymbolId = invocations[0]!.targetSymbolId;
        if (corruption === "reordered") invocations.reverse();
        if (corruption === "wrong-final-arguments") invocations.at(-1)!.arguments = ["other-key"];
        expect(sourceOwnedProgramBehaviorFromDocumentation({ requestText: "Create the documented address book.", intent: source.intent, patterns }), corruption)
          .toEqual({ behaviorRequirements: [], statefulBehaviorRequirements: [] });
      }
    } finally { await rm(source.root, { recursive: true, force: true }); }
  });

  it("originates source-owned phonebook state through actual native failure and retry, then passes private unit and E2E checks", async () => {
    const source = await fixture("k0('a','111'); assert.strictEqual(k1('a'),'111'); k0('a','222'); assert.strictEqual(k1('a'),'222');");
    const privateRoot = await mkdtemp(path.join(tmpdir(), "scce-private-phonebook-"));
    try {
      const requestText = "Create the documented address book.";
      const behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText, intent: source.intent, patterns: source.patterns });
      const codeSignal = projectSourceOwnedProgramBehavior({ codeSignal: codeRequestSignal(requestText), intent: source.intent, sourceBehavior: behavior });
      const initialIntent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal, evidence: [] })!;
      expect(initialIntent.languageId).toBe("typescript");
      expect(initialIntent.statefulBehaviorRequirements).toHaveLength(2);
      const hasher = createHasher(), clock = createClock({ fixedTime: 93000, stepMs: 1 });
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
      const builder = createProgramGraphBuilder({ idFactory: ids, hasher });
      const build = (programIntent: typeof initialIntent) => builder.build({ episodeId: ids.episodeId(), text: requestText,
        createdAt: clock.now(), evidence: [], programIntent,
        entailment: emptyEntailment(ids) });
      const probe = build(initialIntent);
      const native = new NodeBuildTestAdapter({ runtime: { tempRoot: privateRoot } } as ScceRuntimeConfig);
      const failed = await native.executeProgram({ episodeId: probe.episodeId, construct: probe });
      expect(failed.passed).toBe(false);
      expect(failed.test.code).not.toBe(0);
      const retry = replanOwnerBehaviorProgramIntent({ intent: initialIntent, program: probe.program!, hasher,
        failure: { observationId: "observed-native-probe-failure", programId: probe.program!.id,
          planHash: hasher.digestHex(JSON.stringify(probe.program!.files)), validatorId: "validator.actual-native", checkId: "tests", status: "failed",
          ownerRequirementIds: initialIntent.statefulBehaviorRequirements!.map(row => row.id), command: probe.program!.test } });
      expect(retry.selection.transformationId).toBe("program.transformation.state_transition_search.v1");
      const selected = build(retry.intent);
      expect(selected.program!.nodes.filter(node => node.kind === "owner_stateful_behavior_requirement").map(node => node.metadata))
        .toEqual(behavior.statefulBehaviorRequirements.map(row => toJsonValue(row)));
      const passed = await native.executeProgram({ episodeId: selected.episodeId, construct: selected });
      expect(passed.passed, `${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
      expect(passed.testExecutionReceipt?.status).toBe("executed");
      expect(selected.program?.language).toBe("typescript");
      const artifactRoot = path.join(privateRoot, "generated");
      for (const artifact of passed.artifacts) {
        const file = path.join(artifactRoot, artifact.path); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, artifact.content);
      }
      const entry = pathToFileURL(path.join(artifactRoot, selected.program!.entrypoint)).href;
      const scripts = {
        "private.unit.mjs": "import assert from 'node:assert/strict'; const {createStatefulProgram}=await import(process.argv[2]); const book=createStatefulProgram(); book.f0('private-key','private-unit-993'); assert.equal(book.f1('private-key'),'private-unit-993'); book.f0('private-key','private-unit-994'); assert.equal(book.f1('private-key'),'private-unit-994'); console.log('unit read-after-write passed');",
        "private.e2e.mjs": "import assert from 'node:assert/strict'; const {createStatefulProgram}=await import(process.argv[2]); const book=createStatefulProgram(); book.f0('private-first','995'); book.f0('private-second','996'); book.f0('private-first','997'); assert.equal(book.f1('private-second'),'996'); assert.equal(book.f1('private-first'),'997'); console.log('e2e isolated contacts passed');"
      };
      for (const [name, script] of Object.entries(scripts)) {
        const file = path.join(privateRoot, name); await writeFile(file, script);
        const result = await promisify(execFile)(process.execPath, [file, entry], { timeout: 30000 });
        expect(result.stdout).toContain("passed");
      }
      expect(JSON.stringify(source.patterns)).not.toContain("private-key");
      expect(JSON.stringify(source.patterns)).not.toContain("private-unit-993");
      expect(selected.program!.files.filter(file => file.role === "source").every(file => !file.content.includes("private-key"))).toBe(true);
    } finally { await rm(source.root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); }
  });
});

function emptyEntailment(ids: ReturnType<typeof createIdFactory>): SemanticEntailmentResult {
  const claimId = ids.claimId("owned sequence"), proofId = ids.proofId({ claimId, evidenceIds: [], transforms: [], validatorVersion: "fixture" });
  return {
    claim: { id: claimId, text: "", normalized: "", features: [], polarity: 1 },
    verdict: "underdetermined", semanticVerdict: "underdetermined", force: "unknown", support: 0, contradiction: 0, faithfulnessLcb: 0,
    confidence: { verdict: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, faithfulnessLCB: 0, contradiction: 0, stability: 1 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: proofId, claimId, verdict: "unknown", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 93000 }
  };
}
