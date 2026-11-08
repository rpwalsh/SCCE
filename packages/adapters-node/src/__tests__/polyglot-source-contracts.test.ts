// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHasher, createClock, createIdFactory, sourceOwnedProgramBehaviorFromDocumentation, projectSourceOwnedProgramBehavior,
  codeRequestSignal, programIntentForTurn, COGNITIVE_OPERATOR_IDS, createProgramGraphBuilder, createProgramPlanner,
  replanOwnerBehaviorProgramIntent, type SemanticEntailmentResult } from "@scce/kernel";
import { grammarSourceOwnedTestCases, type GrammarContractFile } from "../grammar-source-owned-test-contracts.js";
import { sourceOwnedTestContractProjections } from "../source-owned-test-contracts.js";
import { scalarSourceContractFixtures, statefulSourceContractFixtures } from "./fixtures/polyglot-source-contracts.js";
import { NodeBuildTestAdapter } from "../process.js";
import { findCodeVerifierCapability } from "../code-verifier-discovery.js";
import type { ScceRuntimeConfig } from "../config.js";

type Fixture = (typeof scalarSourceContractFixtures)[number] | (typeof statefulSourceContractFixtures)[number];
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function snapshot(item: Fixture, entries: Record<string, string> = { ...item.files }): GrammarContractFile[] {
  return Object.entries(entries).filter(([name]) => /\.(?:py|go|rs)$/u.test(name)).map(([name, text]) => ({
    path: name, text, languageId: item.languageId, sourceHash: hash(text), sourceVersionId: `source_version_${hash(text).slice(7)}` }));
}
async function acquired(item: Fixture, entries?: Record<string, string>) {
  const files = snapshot(item, entries), cases = await grammarSourceOwnedTestCases(files);
  const patterns = [...sourceOwnedTestContractProjections(cases, "fixture://public-source").values()].flat().map(patternJson => ({ patternJson }));
  const source = files.find(file => file.path === item.sourcePath)!;
  const requestText = "Create the documented public module.";
  const intent = { languageId: item.languageId, symbols: [], references: [{ sourceFamily: "fixture://public-source", relativePath: source.path, sourceHash: source.sourceHash, score: 1 }], audit: null };
  const behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText, intent, patterns });
  const signal = projectSourceOwnedProgramBehavior({ codeSignal: codeRequestSignal(requestText), intent, sourceBehavior: behavior });
  const programIntent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: signal, evidence: [] })!;
  return { files, cases, patterns, behavior, programIntent, requestText };
}

describe("polyglot source-owned assertion contracts", () => {
  it.each(scalarSourceContractFixtures)("binds $languageId literal assertions to unique declarations and exact public source spans", async item => {
    const source = await acquired(item);
    expect(source.cases).toHaveLength(3);
    expect(source.behavior.behaviorRequirements).toHaveLength(3);
    expect(source.programIntent.languageId).toBe(item.languageId);
    for (const row of source.cases) {
      expect(row.targetName).toBe("f0");
      expect(row.bindingResolverId).toBe("scce.source_contract.grammar_static_scope.v1");
      const test = source.files.find(file => file.path === row.testPath)!;
      for (const part of [row.callSpan, row.inputSpan, row.expectedSpan, row.assertionSpan]) {
        expect(part.textHash).toBe(hash(test.text.slice(part.start, part.end)));
        expect(part.end).toBeGreaterThan(part.start);
      }
      expect(row.callSpan.start).toBeGreaterThanOrEqual(row.assertionSpan.start);
      expect(row.callSpan.end).toBeLessThanOrEqual(row.assertionSpan.end);
    }
  });

  it.each(statefulSourceContractFixtures)("retains $languageId writes and prior reads in the same stateful IR", async item => {
    const source = await acquired(item);
    expect(source.behavior.behaviorRequirements).toEqual([]);
    expect(source.behavior.statefulBehaviorRequirements.map(row => row.invocations.map(call => call.callableId)))
      .toEqual([["f0", "f1"], ["f0", "f1", "f0", "f1"]]);
    expect(source.behavior.statefulBehaviorRequirements.map(row => row.expectedResult)).toEqual([111, 222]);
    for (const row of source.cases) for (const call of row.invocations ?? []) {
      const test = source.files.find(file => file.path === row.testPath)!;
      expect(call.callSpan.textHash).toBe(hash(test.text.slice(call.callSpan.start, call.callSpan.end)));
    }
  });

  it.each(scalarSourceContractFixtures)("rejects $languageId stale bytes and unresolved declarations", async item => {
    const files = snapshot(item);
    expect(await grammarSourceOwnedTestCases(files.map(file => file.path === item.sourcePath ? { ...file, sourceHash: `sha256:${"0".repeat(64)}` } : file))).toEqual([]);
    const entries: Record<string, string> = { ...item.files };
    entries[item.sourcePath] = entries[item.sourcePath]!.replace(/\bf0\b/u, "different_symbol");
    expect(await grammarSourceOwnedTestCases(snapshot(item, entries))).toEqual([]);
  });

  it.each(statefulSourceContractFixtures)("rejects $languageId conditional invocation traces", async item => {
    const entries: Record<string, string> = { ...item.files };
    entries[item.testPath] = item.languageId === "python" ? entries[item.testPath]!.replace("    g0('a', 111)", "    if True:\n        g0('a', 111)")
      : item.languageId === "go" ? entries[item.testPath]!.replace(' f0("a", 111)', ' if true { f0("a", 111) }')
      : entries[item.testPath]!.replace('  f0("a", 111);', '  if true { f0("a", 111); }');
    expect(await grammarSourceOwnedTestCases(snapshot(item, entries))).toEqual([]);
  });

  it("rejects Python binding shadowing, duplicate Go package symbols, and a shadowed Rust assertion macro", async () => {
    const python = scalarSourceContractFixtures[0], go = scalarSourceContractFixtures[1], rust = scalarSourceContractFixtures[2];
    expect(await grammarSourceOwnedTestCases(snapshot(python, { ...python.files, "checks.py": `${python.files["checks.py"]}\nclass g0:\n    pass\n` }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(go, { ...go.files, "other.go": "package opaque\nvar f0 = 4\n" }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(rust, { ...rust.files, "lib.rs": `macro_rules! assert_eq { ($a:expr,$b:expr) => {} }\n${rust.files["lib.rs"]}` }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(rust, { ...rust.files, "lib.rs": rust.files["lib.rs"].replace("fn values()", "fn f0()") }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(rust, { ...rust.files, "lib.rs": rust.files["lib.rs"].replace("use super::f0;", "") }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(python, { ...python.files, "checks.py": python.files["checks.py"].replace("from provider", "from .provider") }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(python, { ...python.files, "checks.py": `${python.files["checks.py"]}\nfrom unknown_module import *\n` }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(python, { ...python.files, "checks.py": `${python.files["checks.py"]}\ndel g0\n` }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(rust, { ...rust.files, "lib.rs": rust.files["lib.rs"].replace("use super::f0;", "use super::f0; use unknown_module::f0;") }))).toEqual([]);
    expect(await grammarSourceOwnedTestCases(snapshot(go, { ...go.files, "provider_test.go": go.files["provider_test.go"].replace("t *testing.T", "t testing.T") }))).toEqual([]);
  });

  it.each(statefulSourceContractFixtures)("rejects an entire $languageId trace when an earlier expected value is unbound", async item => {
    const entries: Record<string, string> = { ...item.files };
    entries[item.testPath] = item.languageId === "python" ? entries[item.testPath]!.replace("assert g1('a') == 111", "assert g1('a') == unknown_value")
      : item.languageId === "go" ? entries[item.testPath]!.replace('if f1("a") != 111', 'if f1("a") != unknown_value')
      : entries[item.testPath]!.replace('assert_eq!(f1("a"), 111)', 'assert_eq!(f1("a"), unknown_value)');
    expect(await grammarSourceOwnedTestCases(snapshot(item, entries))).toEqual([]);
  });

  it.each(statefulSourceContractFixtures)("refuses $languageId integer precision loss in the shared JSON value domain", async item => {
    const entries: Record<string, string> = { ...item.files };
    entries[item.testPath] = entries[item.testPath]!.replaceAll("111", "9007199254740993");
    expect(await grammarSourceOwnedTestCases(snapshot(item, entries))).toEqual([]);
  });

  it("decodes native Go legacy octal literals without changing their integer value", async () => {
    const item = scalarSourceContractFixtures[1], entries: Record<string, string> = { ...item.files };
    entries[item.testPath] = entries[item.testPath]!.replace("f0(1) != 2", "f0(010) != 011");
    const cases = await grammarSourceOwnedTestCases(snapshot(item, entries));
    expect(cases[0]).toMatchObject({ arguments: [8], expectedResult: 9 });
  });

  it("preserves Unicode and astral prefixes in Python literal call coordinates", async () => {
    const item = statefulSourceContractFixtures[0], entries: Record<string, string> = { ...item.files };
    entries[item.testPath] = `# 🪶Ω\n${entries[item.testPath]!.replaceAll("'a'", "'🪶Ω'")}`;
    const cases = await grammarSourceOwnedTestCases(snapshot(item, entries));
    expect(cases).toHaveLength(2);
    expect(cases.map(row => row.arguments)).toEqual([["🪶Ω"], ["🪶Ω"]]);
    expect(cases[1]!.callSpan.textHash).toBe(hash(entries[item.testPath]!.slice(cases[1]!.callSpan.start, cases[1]!.callSpan.end)));
  });

  it("reports unresolved native source types as unavailable instead of running a host-language substitute", async () => {
    for (const item of [statefulSourceContractFixtures[1], statefulSourceContractFixtures[2]]) {
      const entries:Record<string,string>={...item.files};
      entries[item.sourcePath]=entries[item.sourcePath]!+(item.languageId==="go"?"\ntype int = int32\n":"\ntype i64 = i32;\n");
      const source = await acquired(item,entries), hasher = createHasher(), clock = createClock({ fixedTime: 1 });
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
      const emitted = createProgramPlanner({ idFactory: ids, hasher }).emitIfAvailable({ episodeId: ids.episodeId(), requestText: source.requestText,
        evidence: [], programIntent: source.programIntent, entailment: emptyEntailment(ids) });
      expect(emitted.availability).toEqual({ status: "unavailable", languageId: item.languageId,reasonIds: ["program.emission.native_abi_missing"] });
      expect(emitted.program).toBeUndefined();
    }
  });

  it.each([scalarSourceContractFixtures[0], scalarSourceContractFixtures[2], statefulSourceContractFixtures[0]])("executes $languageId acquired behavior through native failure, retry and unseen validation", async item => {
    const source = await acquired(item), root = await mkdtemp(path.join(tmpdir(), "scce-private-polyglot-"));
    try {
      const hasher = createHasher(), clock = createClock({ fixedTime: 93000, stepMs: 1 });
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true }), builder = createProgramGraphBuilder({ idFactory: ids, hasher });
      const build = (programIntent: typeof source.programIntent) => builder.build({ episodeId: ids.episodeId(), text: source.requestText, evidence: [],
        createdAt: clock.now(), entailment: emptyEntailment(ids), programIntent });
      const initial = build(source.programIntent), native = new NodeBuildTestAdapter({ runtime: { tempRoot: root } } as ScceRuntimeConfig);
      const failed = await native.executeProgram({ episodeId: initial.episodeId, construct: initial });
      expect(failed.passed).toBe(false);
      expect(failed.test.code).not.toBe(0);
      const retry = replanOwnerBehaviorProgramIntent({ intent: source.programIntent, program: initial.program!, hasher,
        failure: { observationId: "observed-native-failure", programId: initial.program!.id,
          planHash: hasher.digestHex(JSON.stringify(initial.program!.files)), validatorId: "validator.actual-native", checkId: "tests", status: "failed",
          ownerRequirementIds: [...source.behavior.behaviorRequirements, ...source.behavior.statefulBehaviorRequirements].map(row => row.id), command: initial.program!.test } });
      const selected = build(retry.intent), passed = await native.executeProgram({ episodeId: selected.episodeId, construct: selected });
      expect(selected.program!.language).toBe(item.languageId);
      expect(passed.passed, `${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
      expect(passed.testExecutionReceipt?.status).toBe("executed");
      const artifactRoot = path.join(root, "sealed-validator");
      for (const file of passed.artifacts) { const target = path.join(artifactRoot, file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.content); }
      if (item.languageId === "python") {
        const stateful = source.behavior.statefulBehaviorRequirements.length > 0;
        const script = `import importlib.util\np=importlib.util.spec_from_file_location('sealed_program', ${JSON.stringify(path.join(artifactRoot, selected.program!.entrypoint))})\nm=importlib.util.module_from_spec(p)\np.loader.exec_module(m)\n` + (stateful
          ? "b=m.createStatefulProgram()\nb['f0']('sealed-key', 993)\nassert b['f1']('sealed-key') == 993\nb['f0']('sealed-key', 994)\nassert b['f1']('sealed-key') == 994\nb['f0']('sealed-other', 995)\nassert b['f1']('sealed-key') == 994\n"
          : "assert m.f0(17) == 18\nassert m.f0(-7) == -6\n");
        const validator = path.join(root, "private_validator.py"); await writeFile(validator, script);
        await promisify(execFile)("python", [validator], { timeout: 30000 });
      } else {
        const capability = await findCodeVerifierCapability("rust");
        expect(capability.status).toBe("available"); if (capability.status !== "available") throw new Error(capability.reason);
        const validator = path.join(root, "private_validator.rs"), executable = path.join(root, "private_validator.exe");
        await writeFile(validator, `#[path=${JSON.stringify(path.join(artifactRoot, selected.program!.entrypoint).replaceAll("\\", "/"))}] mod program;\n#[test] fn private_values() { assert_eq!(program::f0(17.5),18.5); assert_eq!(program::f0(-7.0),-6.0); }`);
        await promisify(execFile)(capability.verifier.command, ["--edition", "2021", "--test", validator, "-o", executable], { timeout: 60000 });
        await promisify(execFile)(executable, [], { timeout: 30000 });
      }
      expect(JSON.stringify(source.patterns)).not.toContain("sealed-key");
      expect(JSON.stringify(source.patterns)).not.toContain("17.5");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function emptyEntailment(ids: ReturnType<typeof createIdFactory>): SemanticEntailmentResult {
  const claimId = ids.claimId("public source contract"), proofId = ids.proofId({ claimId, evidenceIds: [], transforms: [], validatorVersion: "fixture" });
  return { claim: { id: claimId, text: "", normalized: "", features: [], polarity: 1 }, verdict: "underdetermined", semanticVerdict: "underdetermined",
    force: "unknown", support: 0, contradiction: 0, faithfulnessLcb: 0,
    confidence: { verdict: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0, roleCoverage: 0,
      relationCompatibility: 0, transformationSupport: 0, causalMass: 0, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, faithfulnessLCB: 0, contradiction: 0, stability: 1 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: proofId, claimId, verdict: "unknown", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 93000 } };
}
