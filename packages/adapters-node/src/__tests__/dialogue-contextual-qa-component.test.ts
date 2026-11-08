// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createScceKernel, createClock, createHasher, createIdFactory, contextualQaRequestMatches, verifyContextualQaConstruction,
  CONTEXTUAL_QA_CONSTRUCTION_RECIPE, type EvidenceSpan, type IngestionCheckpoint, type LanguagePatternRecord, type TranscriptTurn,
  type ContextualQaRequestForm } from "@scce/kernel";
import { trainDialogueCorpus } from "../dialogue-corpus.js";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { requestSeedLanguagePattern } from "../../../kernel/src/request-language-hydration.js";
import { jsonRecord } from "../../../kernel/src/kernel-answer-primitives.js";
import { contextualQaForRequest } from "../../../kernel/src/contextual-qa-runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const label = { tenantId: "qa.fixture", principals: ["qa.owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };

function corpus() {
  let text = ""; const turns: TranscriptTurn[] = [];
  for (const [index, [name, answer]] of [["Aster", "17"], ["Beryl", "29"], ["Cobalt", "41"], ["Dahlia", "53"]].entries()) {
    const question = `\u27e1 ${name} \u22b9?`, context = `${name} \ua66e ${answer}.`, sourceRecordId = `original.record.${index}`;
    const start = [...text].length, replyStart = start + [...question].length + 1, contextStart = replyStart + [...answer!].length + 1;
    text += `${question}\n${answer}\n${context}\n`;
    turns.push({ index: turns.length, sourceRecordId, speakerId: "human.question", surface: question, startCodePoint: start, endCodePoint: replyStart - 1 });
    turns.push({ index: turns.length, sourceRecordId, speakerId: "human.answer", surface: answer!, startCodePoint: replyStart, endCodePoint: contextStart - 1,
      replyToTurnIndex: turns.length - 1, commitmentScope: "external", supportingSourceRanges: [{ surface: context, startCodePoint: contextStart, endCodePoint: [...text].length - 1 }] });
  }
  return { schema: "scce.dialogue_transcript.v1", text, turns };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scce-contextual-qa-")); roots.push(root);
  await writeFile(path.join(root, "human.json"), JSON.stringify(corpus()));
  const clock = createClock({ fixedTime: 1000, stepMs: 1 }), hasher = createHasher(), evidence: EvidenceSpan[] = [];
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "qa.fixture" });
  const { storage } = storageFixtureForEvaluation({ evidence, clockNow: () => clock.now() });
  storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
  storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
  const checkpoints = new Map<string, IngestionCheckpoint>();
  storage.ingestion = { get: async id => checkpoints.get(id) ?? null, put: async row => { checkpoints.set(row.id, structuredClone(row)); },
    list: async () => [...checkpoints.values()] } as typeof storage.ingestion;
  storage.evidence.putEvidenceSpan = async span => { const old = evidence.findIndex(row => row.id === span.id); if (old >= 0) evidence[old] = span; else evidence.push(span); };
  storage.evidence.putEvidenceSpans = async spans => { for (const span of spans) await storage.evidence.putEvidenceSpan(span); };
  storage.evidence.searchEvidence = async query => evidence.filter(span => (!query.sourceVersionId || span.sourceVersionId === query.sourceVersionId)
    && (!query.status || query.status === "any" || query.status === span.status)).map(span => ({ span, score: 1, reason: "fixture" }));
  const rawList = storage.languageMemory.listLanguagePatterns.bind(storage.languageMemory);
  storage.languageMemory.listLanguagePatterns = async query => (await rawList(query)).filter(row => {
    const metadata = jsonRecord(row.patternJson);
    return (!query?.sourceSystem || metadata.sourceSystem === query.sourceSystem)
      && (!query?.contextualQaRequestFeatures || Array.isArray(metadata.contextualQaRequestFeatures)
        && metadata.contextualQaRequestFeatures.some(feature => typeof feature === "string" && query.contextualQaRequestFeatures!.includes(feature)));
  }).map(row => query?.view === "request_seed" ? requestSeedLanguagePattern(row) : structuredClone(row));
  const train = () => trainDialogueCorpus({ storage, rootPath: root, informationLabel: label, authorship: "human_authored",
    ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 64 });
  const kernel = () => createScceKernel({ storage, clock, idFactory: ids, deterministicReplay: true, sourceInformationLabel: label,
    informationAccess: { tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted" },
    files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw Error("not a code request"); } } });
  return { root, storage, evidence, hasher, checkpoints, train, kernel };
}

it("normal source training publishes contextual roles, cold hydrates and answers a fresh raw direct source through kernel.turn", async () => {
  const f = await fixture(), trained = await f.train();
  expect(trained.contextualQaConstructions).toMatchObject({ pairs: 4, qualifiedFamilies: 1, patternsPersisted: 1, unchanged: false });
  const patterns = await f.storage.languageMemory.listLanguagePatterns();
  const qa = patterns.filter(pattern => jsonRecord(pattern.patternJson).componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE);
  expect(qa).toHaveLength(1);
  expect(verifyContextualQaConstruction({ pattern: JSON.parse(JSON.stringify(qa[0])) as LanguagePatternRecord, evidence: f.evidence, hasher: f.hasher })).toBeDefined();
  expect(contextualQaRequestMatches(jsonRecord(qa[0]!.patternJson).contextualQaRequestForm as ContextualQaRequestForm, "\u27e1 \u65b0\u6e2f\ud83e\udded \u22b9?")).toBe(true);
  const read = vi.spyOn(f.storage.evidence, "searchEvidence"), put = vi.spyOn(f.storage.ingestion, "put");
  expect((await f.train()).contextualQaConstructions?.unchanged).toBe(true);
  expect(put).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  const kernel = f.kernel();
  await kernel.ingest({ uri: "fixture://new-current-fact", content: "\u65b0\u6e2f\ud83e\udded \ua66e 907.", mediaType: "text/plain", namespace: "workspace", informationLabel: label,
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" },
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "new-current-fact", accessScope: "owner_private", licenseStatus: "owner_authorized" } });
  const result = await f.kernel().turn({ text: "\u27e1 \u65b0\u6e2f\ud83e\udded \u22b9?", requestedAuthority: "factual" });
  expect(result.answer).toBe("907");
  expect(result.evidence.every(span => !qa[0]!.evidenceIds.includes(span.id))).toBe(true);
  const semantic = result.constructGraph.nodes.find(node => node.kind === "construct:semantic_answer")!;
  expect(jsonRecord(jsonRecord(semantic.metadata).certificationBoundary).externalFactCertification).toBe(false);
  const negative = await f.kernel().turn({ text: "\u27e1 \u65b0\u6e2f\ud83e\udded \u22ba?", requestedAuthority: "factual" });
  expect(negative.answer).not.toContain("907");
  const requestText = "\u27e1 \u65b0\u6e2f\ud83e\udded \u22b9?";
  const owner = f.evidence.find(span => qa[0]!.evidenceIds.includes(span.id))!;
  const ownerStatus = owner.status; owner.status = "quarantined";
  expect(await contextualQaForRequest({ storage: f.storage, hasher: f.hasher, requestText, evidence: f.evidence })).toBeUndefined();
  expect((await f.kernel().turn({ text: requestText, requestedAuthority: "factual" })).answer).not.toBe("907");
  owner.status = ownerStatus;
  const version = owner.sourceVersionId; owner.sourceVersionId = "source.version.superseded" as typeof version;
  expect(await contextualQaForRequest({ storage: f.storage, hasher: f.hasher, requestText, evidence: f.evidence })).toBeUndefined();
  owner.sourceVersionId = version;
  const getEvidence = f.storage.evidence.getEvidenceBatch;
  f.storage.evidence.getEvidenceBatch = async ids => (await getEvidence(ids)).filter(span => span.id !== owner.id);
  expect(await contextualQaForRequest({ storage: f.storage, hasher: f.hasher, requestText, evidence: f.evidence })).toBeUndefined();
  f.storage.evidence.getEvidenceBatch = getEvidence;
  expect(await contextualQaForRequest({ storage: f.storage, hasher: f.hasher, requestText, evidence: f.evidence.filter(span => span.id !== result.evidence[0]!.id) })).toBeUndefined();
});

it("records unqualified contextual input once and skips unrelated dialogue components", async () => {
  const f = await fixture(), raw = corpus();
  for (const turn of raw.turns) turn.sourceFamilyId = "same.original.context";
  await writeFile(path.join(f.root, "human.json"), JSON.stringify(raw));
  const first = await f.train();
  expect(first.contextualQaConstructions).toMatchObject({ pairs: 4, qualifiedFamilies: 0, patternsPersisted: 0, unchanged: false });
  expect(first.contextualQaConstructions?.rejected.some(row => row.reason === "independent_role_contrast_missing")).toBe(true);
  const receipt = [...f.checkpoints.values()].filter(row => jsonRecord(row.metadata).schema === "scce.dialogue_contextual_qa_compilation.v1");
  expect(receipt).toHaveLength(1);
  expect(jsonRecord(receipt[0]!.metadata)).toMatchObject({ compilerFingerprint: CONTEXTUAL_QA_CONSTRUCTION_RECIPE, projections: [] });
  const put = vi.spyOn(f.storage.ingestion, "put"), search = vi.spyOn(f.storage.evidence, "searchEvidence");
  expect((await f.train()).contextualQaConstructions?.unchanged).toBe(true);
  expect(put).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
});
