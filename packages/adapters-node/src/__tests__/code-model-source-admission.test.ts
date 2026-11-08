// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { anchorFeatureSet, codeSurfaceTokens, createClock, createEvidenceExtractor, createHasher, createIdFactory,
  createLanguageAcquisitionEngine, toJsonValue, trainKneserNey,
  type EvidenceQuery, type LanguageProfileQuery, type NgramModelQuery, type NgramModelRecord, type SourceVersionId } from "@scce/kernel";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTypeScriptCodeMouthPorts } from "../code-mouth.js";
import { createLearnedCodeProposer } from "../learned-code-proposer.js";
import * as treeSitterRepair from "../tree-sitter-repair-spans.js";

afterEach(() => vi.restoreAllMocks());

it("admits a retrieved source and every tied source before higher-mass lower-coverage source candidates", async () => {
  const repairPreparation = vi.spyOn(treeSitterRepair, "treeSitterRepairSpans");
  const source = "package ledger\nfunc total(amount float64) float64 {\n balances := amount\n return balances\n}\n";
  const targetText = source.replace("return balances", "return balnces");
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher();
  const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
  const sourceVersionId = "source.test-authored.ledger" as SourceVersionId;
  const profile = createLanguageAcquisitionEngine({ idFactory }).acquire({ text: source, sourceVersionId, createdAt: 1 });
  const extracted = createEvidenceExtractor({ idFactory, hasher }).extract({
    sourceId: "source.ledger" as never, sourceVersionId, namespace: "corpus:oss_code", uri: "scce://opaque-source",
    text: source, mediaType: "text/plain", languageProfile: profile, sourceTrust: {} as never, observedAt: 1, maxChunkBytes: 4096
  }).spans.map(span => ({ ...span, status: "promoted" as const, provenance: { sourceSystem: "oss_code", formalLanguage: "go" } }));
  const row = (id: string, profileId: string, text: string): NgramModelRecord => {
    const model = trainKneserNey(codeSurfaceTokens(text), { order: 5 });
    return { id, streamId: `opaque:${id}`, languageHint: "script:Latin;direction:ltr", maxOrder: model.order,
      discount: model.discount, updatedAt: 1, modelJson: toJsonValue({ sourceSystem: "oss_code", formalLanguage: "go", profileId, model }) };
  };
  const tiedSourceVersionId = "source.test-authored.ledger-copy" as SourceVersionId;
  const tiedProfile = { ...profile, id: "profile.ledger-copy", sourceVersionId: tiedSourceVersionId };
  const relevant = row("relevant-source", profile.id, source);
  const tiedRelevant = row("tied-relevant-source", tiedProfile.id, source);
  const rows = [...Array.from({ length: 97 }, (_, index) => row(`prior-${index}`, "profile.lower-coverage",
    "package other\nfunc unrelated(input int) int { return input + 42 }\n".repeat(8))), relevant, tiedRelevant];
  const modelQueries: NgramModelQuery[] = [], evidenceQueries: EvidenceQuery[] = [], profileQueries: LanguageProfileQuery[] = [];
  const proposer = createLearnedCodeProposer({ modelLimit: 8, storage: {
    evidence: { searchEvidence: async (query: EvidenceQuery) => {
      evidenceQueries.push(query);
      if (query.openingBlockPrior !== false) return [];
      const hits = extracted.filter(span => query.features?.some(feature => span.features.includes(feature)))
        .map(span => ({ span, score: 1, reason: "indexed feature overlap" }));
      return [
        ...hits.map(hit => ({ ...hit, span: { ...hit.span, sourceVersionId: "source.foreign" as SourceVersionId, provenance: { sourceSystem: "oss_code", formalLanguage: "python" } } })),
        ...hits.map(hit => ({ ...hit, span: { ...hit.span, sourceVersionId: "source.docs" as SourceVersionId, provenance: { sourceSystem: "oss_docs", formalLanguage: "go" } } })),
        ...hits.map(hit => ({ ...hit, span: { ...hit.span, sourceVersionId: "source.quarantined" as SourceVersionId, status: "quarantined" as const } })),
        ...hits,
        ...hits.map(hit => ({ ...hit, span: { ...hit.span, sourceVersionId: tiedSourceVersionId } })),
        ...[0, 1].flatMap(parity => hits.map(hit => ({ ...hit, span: { ...hit.span,
          sourceVersionId: "source.lower-coverage" as SourceVersionId,
          features: hit.span.features.filter(feature => query.features?.includes(feature)).filter((_, index) => index % 2 === parity)
        } })))
      ];
    } },
    model: { listLanguageProfiles: async (query: LanguageProfileQuery) => {
      profileQueries.push(query);
      return [{ ...profile, id: "profile.lower-coverage", sourceVersionId: "source.lower-coverage" as SourceVersionId }, tiedProfile, profile]
        .filter(candidate => query.sourceVersionIds?.includes(candidate.sourceVersionId)).slice(0, query.limit);
    } },
    languageMemory: { listNgramModels: async (query: NgramModelQuery) => {
      modelQueries.push(query);
      return rows.filter(record => {
        const metadata = record.modelJson as Record<string, unknown>;
        return metadata.sourceSystem === query.sourceSystem && metadata.formalLanguage === query.formalLanguage
          && (!query.profileIds || query.profileIds.includes(String(metadata.profileId)));
      }).slice(0, query.limit);
    } }
  } as never });
  expect(proposer.corpusAvailability("go")).toMatchObject({ status: "unqueried", modelsAvailable: null });
  expect(modelQueries).toEqual([]);
  expect(evidenceQueries).toEqual([]);
  const input = { request: "balnces", context: { targetPath: "arbitrary.go", targetText, language: "go", imports: [], symbols: [] },
    diagnostics: [{ id: "checker.actual", class: "type" as const, path: "arbitrary.go", line: 4, column: 9,
      message: "undefined: balnces", raw: "arbitrary.go:4:9: undefined: balnces", confidence: 1 }], attempt: 1 };
  const [proposal] = await Promise.all([proposer.propose(input), proposer.propose({ ...input, attempt: 2 })]);
  expect(proposal).toMatchObject({ operations: [{ kind: "replace", startLine: 4, endLine: 4, content: " return balances" }],
    audit: { sourceModelKeys: [relevant.id, tiedRelevant.id] } });
  expect(evidenceQueries[0]).toEqual({ features: anchorFeatureSet(codeSurfaceTokens(targetText).join(" ")), status: "promoted", openingBlockPrior: false, limit: 8 });
  expect(profileQueries).toEqual([
    { sourceVersionIds: [sourceVersionId], referencedByLanguageMemory: true, limit: 8 },
    { sourceVersionIds: [tiedSourceVersionId], referencedByLanguageMemory: true, limit: 7 }
  ]);
  expect(modelQueries).toEqual([
    { sourceSystem: "oss_code", formalLanguage: "go", profileIds: [profile.id], limit: 8 },
    { sourceSystem: "oss_code", formalLanguage: "go", profileIds: [tiedProfile.id], limit: 7 }
  ]);
  expect(await proposer.availableModelCount("go")).toBe(2);
  expect(proposer.corpusAvailability("go")).toMatchObject({ status: "loaded", modelsAvailable: 2, countSemantics: "admitted_run_models" });
  await proposer.propose({ ...input, attempt: 3 });
  expect(modelQueries).toHaveLength(2);
  expect(profileQueries).toHaveLength(2);
  expect(evidenceQueries.filter(query => query.openingBlockPrior === false)).toHaveLength(1);
  expect(repairPreparation).toHaveBeenCalledTimes(1);
  await proposer.propose({ ...input, context: { ...input.context, targetText: targetText + "\n" }, attempt: 4 });
  expect(repairPreparation).toHaveBeenCalledTimes(2);
  expect(proposer.corpusAvailability("python")).toMatchObject({ status: "unqueried", modelsAvailable: null });
});

it("keeps every corpus store unread when the compiler owns the repair", async () => {
  const prefix = path.join(tmpdir(), "scce-code-source-admission-");
  const root = await mkdtemp(prefix);
  let reads = 0;
  const unread = async () => { reads++; throw new Error("compiler-owned repair read the corpus"); };
  const proposer = createLearnedCodeProposer({ storage: {
    evidence: { searchEvidence: unread }, model: { listLanguageProfiles: unread }, languageMemory: { listNgramModels: unread }
  } as never });
  try {
    await writeFile(path.join(root, "source.ts"), "export const value = Math.abss(-1);\n");
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, files: ["source.ts"] }));
    const ports = createTypeScriptCodeMouthPorts({ workspaceRoot: root, learnedProposer: proposer });
    const context = await ports.retrieve("source.ts");
    const verified = await ports.verify("source.ts");
    expect(verified.diagnostics.some(diagnostic => diagnostic.raw?.includes("TS2551"))).toBe(true);
    const proposal = await ports.propose({ request: "TS2551 fixName:spelling", context, diagnostics: verified.diagnostics, attempt: 1 });
    expect(proposal).toMatchObject({ source: "compiler_owned" });
    expect(reads).toBe(0);
    expect(proposer.corpusAvailability("typescript")).toMatchObject({ status: "unqueried", modelsAvailable: null });
  } finally {
    expect(root.startsWith(prefix)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
