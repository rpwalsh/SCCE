// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { COGNITIVE_OPERATOR_IDS, codeRequestSignal, createClock, createHasher, createIdFactory, createProgramGraphBuilder,
  programIntentForTurn, replanOwnerBehaviorProgramIntent, UnsupportedProgramLanguageError, featureSet,
  type EvidenceSpan, type SemanticEntailmentResult } from "@scce/kernel";
import { NodeBuildTestAdapter } from "../process.js";
import type { ScceRuntimeConfig } from "../config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("explicit owner program language", () => {
  const hasher = createHasher();
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
  const entailment = { force: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, evidenceIds: [], obligations: [],
    proof: { id: ids.proofId({ claimId: ids.claimId("owner-language"), evidenceIds: [], transforms: [], validatorVersion: "fixture" }),
      claimId: ids.claimId("owner-language"), proofGraph: { nodes: [], edges: [] } } } as unknown as SemanticEntailmentResult;
  function foreign(extension: string): EvidenceSpan {
    const text = extension === "ts" ? "export function observed(value: number) { return value; }" : "def observed(value):\n    return value\n";
    const sourceId = ids.sourceId("oss_code", `fixture://foreign/program.${extension}`);
    const sourceVersionId = ids.sourceVersionId(`${sourceId}:${hasher.digestHex(text)}`);
    const contentHash = ids.contentHash(text);
    return { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: contentHash }), sourceId, sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), chunkHash: contentHash }), contentHash,
      text, textPreview: text, mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: [...text].length,
      provenance: { uri: `fixture://foreign/program.${extension}`, sourceSystem: "oss_code" }, features: featureSet(text), status: "promoted", alpha: 1,
      observedAt: 1, languageHints: {}, scriptHints: {}, trustVector: {} };
  }

  it.each([
    { language: "TypeScript", id: "typescript", extension: "ts", foreignExtension: "py", mediaType: "text/typescript" },
    { language: "Python", id: "python", extension: "py", foreignExtension: "ts", mediaType: "text/x-python" }
  ])("keeps $language ahead of foreign corpus metadata and executes its actual backend", async row => {
    const text = `${row.language} double(3)=6; double(7)=14; double(-2)=-4; double(11)=22`;
    const intent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: codeRequestSignal(text), evidence: [] })!;
    const builder = createProgramGraphBuilder({ idFactory: ids, hasher });
    const evidence = [foreign(row.foreignExtension)];
    const build = (programIntent: typeof intent) => builder.build({ episodeId: ids.episodeId(), text, entailment, evidence, createdAt: 1, programIntent });
    const probe = build(intent);
    expect(probe.program?.language).toBe(row.id);
    expect(probe.program?.entrypoint).toBe(`src/program.${row.extension}`);
    const blueprint = probe.program!.nodes.find(node => node.kind === "implementation_blueprint")!;
    expect(blueprint.metadata).toHaveProperty("primaryLanguage", row.id);
    const root = await mkdtemp(path.join(tmpdir(), "scce-owner-language-")); roots.push(root);
    const native = new NodeBuildTestAdapter({ runtime: { tempRoot: root } } as ScceRuntimeConfig);
    const failed = await native.executeProgram({ episodeId: probe.episodeId, construct: probe });
    expect(failed.build.code, failed.build.stderr).toBe(0);
    expect(failed.test.code).not.toBe(0);
    const retry = replanOwnerBehaviorProgramIntent({ intent, program: probe.program!, hasher,
      failure: { observationId: hasher.digestHex(failed.test.stderr), programId: probe.program!.id, planHash: hasher.digestHex(JSON.stringify(probe.program!.files)),
        validatorId: "validator.actual-native", checkId: "tests", status: "failed", ownerRequirementIds: intent.behaviorRequirements!.map(item => item.id), command: probe.program!.test } });
    const selected = build(retry.intent);
    const passed = await native.executeProgram({ episodeId: selected.episodeId, construct: selected });
    expect(passed.passed, `${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
    expect(passed.testExecutionReceipt?.status).toBe("executed");
    expect(selected.program!.language).toBe(row.id);
    expect(passed.artifacts.find(file => file.path === `src/program.${row.extension}`)?.mediaType).toBe(row.mediaType);
    if (row.id === "typescript") {
      expect(selected.program!.build.args).toEqual(["--experimental-strip-types", "--check", "src/program.ts"]);
      const content = passed.artifacts.find(file => file.path === "src/program.ts")!.content;
      expect(content).toContain("...args: [number]): number");
      expect(passed.artifacts.find(file => file.role === "test")!.content).toContain("src/program.ts");
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src/program.ts"), content, "utf8");
      const caller = path.join(root, "caller.ts");
      const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] };
      const errors = () => ts.getPreEmitDiagnostics(ts.createProgram([caller], options)).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
      await writeFile(caller, "import {double} from './src/program.ts'; const formatted: string = double(2).toFixed();", "utf8");
      expect(errors().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
      await writeFile(caller, "import {double} from './src/program.ts'; double('wrong-type');", "utf8");
      expect(errors().some(diagnostic => diagnostic.code === 2345)).toBe(true);
    }
  });

  it("reports an unsupported explicit backend instead of emitting another language", () => {
    const text = "Rust double(3)=6; double(7)=14; double(-2)=-4; double(11)=22";
    const programIntent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: codeRequestSignal(text), evidence: [] })!;
    expect(() => createProgramGraphBuilder({ idFactory: ids, hasher }).build({ episodeId: ids.episodeId(), text, programIntent, entailment, evidence: [], createdAt: 1 }))
      .toThrow(UnsupportedProgramLanguageError);
    try { createProgramGraphBuilder({ idFactory: ids, hasher }).build({ episodeId: ids.episodeId(), text, programIntent, entailment, evidence: [], createdAt: 1 }); }
    catch (error) { expect(error).toMatchObject({ code: "SCCE_PROGRAM_LANGUAGE_UNSUPPORTED", status: "unsupported", languageId: "rust" }); }
  });
});
