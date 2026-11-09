// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as kernelModule from "@scce/kernel";
import { createClock, createHasher, createIdFactory, createScceKernel, toJsonValue, CONTEXTUAL_QA_CONSTRUCTION_RECIPE,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type ContentHash, type EvidenceSpan, type IngestionCheckpoint,
  type SourceVersion, type TranscriptTurn } from "@scce/kernel";
import { trainDialogueCorpus } from "../dialogue-corpus.js";
import { trainStoredCorpusConstructions } from "../stored-corpus-construction-training.js";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { requestSeedLanguagePattern } from "../../../kernel/src/request-language-hydration.js";
import { jsonRecord } from "../../../kernel/src/kernel-answer-primitives.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const label = { tenantId: "stored.qa", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
function humanTranscript() {
  const human = JSON.parse(readFileSync(new URL("../../../kernel/src/__tests__/fixtures/squad-contextual-qa-family.json", import.meta.url), "utf8")) as {
    sha256: string; records: Array<{ articleTitle: string; context: string; qa: { id: string; question: string; answers: Array<{ text: string; answer_start: number }> } }> };
  const hasher = createHasher(), turns: TranscriptTurn[] = []; let text = "";
  for (const row of human.records) {
    const answer = row.qa.answers[0]!, question = row.qa.question.normalize("NFC"), reply = answer.text.normalize("NFC"), context = row.context.normalize("NFC");
    expect([...row.context].slice(answer.answer_start, answer.answer_start + [...answer.text].length).join("")).toBe(answer.text);
    const start = [...text].length, replyStart = start + [...question].length + 1, contextStart = replyStart + [...reply].length + 1;
    const answerStart = contextStart + [...[...row.context].slice(0, answer.answer_start).join("").normalize("NFC")].length;
    const common = { sourceRecordId: row.qa.id, sourceFamilyId: `source.article.${hasher.digestHex(JSON.stringify([human.sha256, row.articleTitle]))}` };
    text += `${question}\n${reply}\n${context}\n`;
    turns.push({ ...common, index: turns.length, speakerId: "human.question", surface: question, startCodePoint: start, endCodePoint: replyStart - 1 });
    turns.push({ ...common, index: turns.length, speakerId: "human.answer", surface: reply, startCodePoint: replyStart, endCodePoint: contextStart - 1,
      replyToTurnIndex: turns.length - 1, commitmentScope: "external", supportingSourceRanges: [{ startCodePoint: contextStart,
        endCodePoint: [...text].length - 1, surface: context, answerRange: { startCodePoint: answerStart, endCodePoint: answerStart + [...reply].length } }] });
  }
  return { schema: "scce.dialogue_transcript.v1", text, turns, sourceMetadata: { originalTrainingSha256: human.sha256, split: "train", authorship: "human_authored" } };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scce-stored-qa-")); roots.push(root);
  const transcript = humanTranscript(); await writeFile(path.join(root, "human.json"), JSON.stringify(transcript));
  const clock = createClock({ fixedTime: 1000, stepMs: 1 }), hasher = createHasher(), evidence: EvidenceSpan[] = [];
  const { storage } = storageFixtureForEvaluation({ evidence, clockNow: () => clock.now() });
  const sources = new Map<string, SourceVersion>(), blobs = new Map<ContentHash, Uint8Array>(), checkpoints = new Map<string, IngestionCheckpoint>();
  storage.blobs = { put: async bytes => { const key = `sha256_${hasher.digestHex(bytes)}` as ContentHash; blobs.set(key, new Uint8Array(bytes)); return key; },
    get: async key => { const value = blobs.get(key); if (!value) throw Error("source blob unavailable"); return value; }, exists: async key => blobs.has(key) };
  storage.evidence.putSourceVersion = async source => { sources.set(String(source.sourceVersionId), structuredClone(source)); };
  storage.evidence.sourceVersionById = async id => sources.get(String(id)) ?? null;
  storage.evidence.sourceVersionsForEvidence = async ids => [...sources.values()].filter(source => evidence.some(span => ids.includes(span.id) && span.sourceVersionId === source.sourceVersionId));
  storage.evidence.putEvidenceSpan = async span => { const index = evidence.findIndex(row => row.id === span.id); if (index >= 0) evidence[index] = span; else evidence.push(span); };
  storage.evidence.putEvidenceSpans = async rows => { for (const span of rows) await storage.evidence.putEvidenceSpan(span); };
  storage.evidence.searchEvidence = async query => evidence.filter(span => (!query.sourceVersionId || query.sourceVersionId === span.sourceVersionId)
    && (!query.status || query.status === "any" || span.status === query.status)).map(span => ({ span, score: 1, reason: "owned fixture" }));
  storage.evidence.listEvidenceBackedSourceVersions = async query => [...sources.values()].filter(source => {
    const metadata = jsonRecord(source.metadata);
    return (!query?.sourceSystems || query.sourceSystems.includes(String(metadata.sourceSystemId ?? metadata.sourceSystem)))
      && (!query?.sourceVersionIds || query.sourceVersionIds.includes(source.sourceVersionId))
      && (!query?.afterSourceVersionId || String(source.sourceVersionId) > query.afterSourceVersionId)
      && (query?.minByteLength === undefined || source.byteLength >= query.minByteLength)
      && (query?.maxByteLength === undefined || source.byteLength <= query.maxByteLength)
      && evidence.some(span => span.sourceVersionId === source.sourceVersionId && span.status === "promoted");
  }).sort((a, b) => String(a.sourceVersionId).localeCompare(String(b.sourceVersionId))).slice(0, query?.limit ?? 128).map(source => ({
    sourceVersionId: source.sourceVersionId, contentHash: source.contentHash, canonicalUri: source.canonicalUri, byteLength: source.byteLength,
    maxAlpha: 1, promotedSpanCount: evidence.filter(span => span.sourceVersionId === source.sourceVersionId && span.status === "promoted").length }));
  storage.ingestion = { get: async id => checkpoints.get(id) ?? null, put: async row => { checkpoints.set(row.id, structuredClone(row)); }, list: async () => [...checkpoints.values()] };
  const list = storage.languageMemory.listLanguagePatterns.bind(storage.languageMemory);
  storage.languageMemory.listLanguagePatterns = async query => (await list(query)).filter(row => !query?.sourceSystem || jsonRecord(row.patternJson).sourceSystem === query.sourceSystem)
    .filter(row => !query?.contextualQaRequestFeatures || (jsonRecord(row.patternJson).contextualQaRequestFeatures as string[] | undefined)?.some(feature => query.contextualQaRequestFeatures!.includes(feature)))
    .map(row => query?.view === "request_seed" ? requestSeedLanguagePattern(row) : structuredClone(row));
  storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
  storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
  const ids = createIdFactory({ clock, hasher, namespace: "stored.qa", deterministicReplay: true });
  const kernel = () => createScceKernel({ storage, clock, idFactory: ids, deterministicReplay: true, sourceInformationLabel: label,
    informationAccess: { tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted" },
    files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw Error("not code"); } } });
  const train = () => trainDialogueCorpus({ storage, rootPath: root, informationLabel: label, authorship: "human_authored", ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 64 });
  const replay = () => trainStoredCorpusConstructions({ storage, sourceSystem: "dialogue", minArticleBytes: 0, maxArticleBytes: 2 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 });
  return { root, transcript, storage, sources, blobs, evidence, checkpoints, train, replay, kernel };
}
it("recompiles genuine human QA from canonical archives after files are removed, upgrades once and answers cold ordinary turns", async () => {
  const f = await fixture(), first = await f.train();
  expect(first.contextualQaConstructions).toMatchObject({ qualifiedFamilies: 1, patternsPersisted: 1 });
  const source = [...f.sources.values()][0]!, original = structuredClone(source), archive = jsonRecord(jsonRecord(source.metadata).transcriptArchive);
  expect(archive).toMatchObject({ sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, authorship: "human_authored", turnCount: 10 });
  const archived = JSON.parse(Buffer.from(f.blobs.get(archive.archiveHash as ContentHash)!).toString("utf8"));
  expect(archived.turns[1].supportingSourceRanges[0].answerRange).toEqual(f.transcript.turns[1]!.supportingSourceRanges![0]!.answerRange);
  await rm(f.root, { recursive: true });
  const warm = await f.replay(); expect(warm.contextualQa?.reports[0], JSON.stringify({ deferred: warm.contextualQa?.deferred, failed: warm.batchesFailed, skipped: warm.sourcesSkipped })).toMatchObject({ qualifiedFamilies: 1, patternsPersisted: 1, unchanged: false });
  const checkpoint = [...f.checkpoints.values()].find(row => row.rootUri.startsWith("scce://stored-dialogue-qa/") && jsonRecord(row.metadata).schema === "scce.dialogue_contextual_qa_compilation.v1")!;
  const pattern = (await f.storage.languageMemory.listLanguagePatterns()).find(row => jsonRecord(row.patternJson).componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE)!;
  const owner = f.evidence.find(span => pattern.evidenceIds.includes(span.id))!;
  const key = { profileId: pattern.profileId, sourceId: owner.sourceId, sourceVersionId: owner.sourceVersionId, sourceSystem: "dialogue",
    patternSchema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, componentRecipe: CONTEXTUAL_QA_CONSTRUCTION_RECIPE, informationLabel: label };
  const previous = (await f.storage.languageMemory.getLanguagePatternProjection!(key))!;
  await f.storage.languageMemory.replaceLanguagePatternProjection!({ patterns: [], projection: { ...previous, patternIds: [], sourceDependencies: [] } });
  checkpoint.metadata = { ...jsonRecord(checkpoint.metadata), compilerFingerprint: CONTEXTUAL_QA_CONSTRUCTION_RECIPE, projections: [] };
  const compiler = vi.spyOn(kernelModule, "compileLanguageTrainingBatch"), write = vi.spyOn(f.storage.ingestion, "put");
  const models = JSON.stringify(await f.storage.languageMemory.listNgramModels());
  expect((await f.replay()).contextualQa?.reports[0]).toMatchObject({ qualifiedFamilies: 1, patternsPersisted: 1, unchanged: false });
  expect(compiler).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
  expect((await f.storage.languageMemory.getLanguagePatternProjection!(key))?.patternIds).toEqual([pattern.id]);
  expect(f.sources.get(String(source.sourceVersionId))).toEqual(original);
  expect(JSON.stringify(await f.storage.languageMemory.listNgramModels())).toBe(models);
  vi.clearAllMocks();
  expect((await f.replay()).contextualQa?.reports[0]?.unchanged).toBe(true);
  expect(compiler).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  await f.kernel().ingest({ uri: "fixture://fresh-current-owned-fact", content: "V\u00eblora stations route glyphs for Neralis_\u6e2f\ud83e\udded.", namespace: "workspace", mediaType: "text/plain", informationLabel: label,
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" },
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fresh-current", accessScope: "owner_private", licenseStatus: "owner_authorized" } });
  const request = "What type of stations route glyphs for Neralis_\u6e2f\ud83e\udded?";
  expect((await f.kernel().turn({ text: request })).answer).toBe("V\u00eblora");
  expect((await f.kernel().turn({ text: request, requestedAuthority: "factual" })).answer).toBe("V\u00eblora");
  expect((await f.kernel().turn({ text: request.replace("route", "invert"), requestedAuthority: "factual" })).answer).toBe("");
});
it("defers absent or invalid declared archives instead of publishing a partial owner pool", async () => {
  const f = await fixture(); await f.train();
  const source = [...f.sources.values()][0]!, original = structuredClone(source), patterns = createHasher().digestHex(JSON.stringify(await f.storage.languageMemory.listLanguagePatterns()));
  const { transcriptArchive: _archive, ...metadata } = jsonRecord(source.metadata); source.metadata = metadata;
  const missing = await f.replay(); expect(missing.contextualQa?.reports).toEqual([]);
  expect(missing.contextualQa?.deferred).toContainEqual({ sourceVersionId: String(source.sourceVersionId), reason: "transcript_annotations_unavailable" });
  source.metadata = original.metadata;
  const descriptor = jsonRecord(jsonRecord(source.metadata).transcriptArchive);
  f.blobs.delete(descriptor.archiveHash as ContentHash);
  const bad = await f.replay(); expect(bad.contextualQa?.reports).toEqual([]);
  expect(bad.contextualQa?.deferred.some(row => row.reason.includes("source blob unavailable"))).toBe(true);
  expect(createHasher().digestHex(JSON.stringify(await f.storage.languageMemory.listLanguagePatterns()))).toBe(patterns);
});
it("upgrades a completed pre-archive source once without recompiling models or changing canonical source metadata", async () => {
  const f = await fixture(); await f.train();
  const source = [...f.sources.values()][0]!, metadata = jsonRecord(source.metadata), descriptor = jsonRecord(metadata.transcriptArchive);
  const { transcriptArchive: _archive, ...originalMetadata } = metadata;
  source.metadata = originalMetadata; f.blobs.delete(descriptor.archiveHash as ContentHash);
  const checkpoint = [...f.checkpoints.values()].find(row => jsonRecord(row.metadata).schema === "scce.corpusTrainingCheckpoint.v1")!;
  const { transcriptArchive: _reportArchive, ...oldReport } = jsonRecord(jsonRecord(checkpoint.metadata).report);
  checkpoint.metadata = { ...jsonRecord(checkpoint.metadata), report: oldReport };
  const before = createHasher().digestHex(JSON.stringify(await f.storage.languageMemory.listLanguagePatterns()));
  const compiler = vi.spyOn(kernelModule, "compileLanguageTrainingBatch"), putSource = vi.spyOn(f.storage.evidence, "putSourceVersion"),
    putBlob = vi.spyOn(f.storage.blobs, "put"), putCheckpoint = vi.spyOn(f.storage.ingestion, "put");
  const result = await f.train(); expect(result.filesSkipped).toEqual([]);
  expect(compiler).not.toHaveBeenCalled(); expect(putSource).toHaveBeenCalledTimes(1); expect(putBlob).toHaveBeenCalledTimes(1); expect(putCheckpoint).toHaveBeenCalledTimes(1);
  const current = f.sources.get(String(source.sourceVersionId))!, { transcriptArchive: added, ...retained } = jsonRecord(current.metadata);
  expect(retained).toEqual(originalMetadata); expect(added).toEqual(descriptor);
  expect(current.sourceId).toBe(source.sourceId); expect(current.sourceVersionId).toBe(source.sourceVersionId);
  expect(current.canonicalUri).toBe(source.canonicalUri); expect(current.contentHash).toBe(source.contentHash);
  expect(createHasher().digestHex(JSON.stringify(await f.storage.languageMemory.listLanguagePatterns()))).toBe(before);
  vi.clearAllMocks(); await f.train();
  expect(compiler).not.toHaveBeenCalled(); expect(putSource).not.toHaveBeenCalled(); expect(putBlob).not.toHaveBeenCalled(); expect(putCheckpoint).not.toHaveBeenCalled();
});
it("keeps projections with dependencies outside the bounded pool byte-identical and never checkpoints their deferred upgrade", async () => {
  const f = await fixture(); await f.train(); await f.replay();
  const pattern = (await f.storage.languageMemory.listLanguagePatterns()).find(row => jsonRecord(row.patternJson).componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE)!;
  const teacher = f.evidence.find(span => pattern.evidenceIds.includes(span.id))!;
  await f.kernel().ingest({ uri: "fixture://outside-current-owner", content: "Independent owner current source.", namespace: "workspace", mediaType: "text/plain", informationLabel: label,
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" },
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "outside-owner", accessScope: "owner_private", licenseStatus: "owner_authorized" } });
  const outside = f.evidence.find(span => span.sourceVersionId !== teacher.sourceVersionId)!;
  const key = { profileId: pattern.profileId, sourceId: teacher.sourceId, sourceVersionId: teacher.sourceVersionId, sourceSystem: "dialogue",
    patternSchema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, componentRecipe: CONTEXTUAL_QA_CONSTRUCTION_RECIPE, informationLabel: label };
  const prior = (await f.storage.languageMemory.getLanguagePatternProjection!(key))!;
  const guarded = { ...prior, sourceDependencies: [...prior.sourceDependencies!, { sourceId: outside.sourceId, sourceVersionId: outside.sourceVersionId, evidenceIds: [outside.id] }] };
  await f.storage.languageMemory.replaceLanguagePatternProjection!({ patterns: [pattern], projection: guarded });
  const put = vi.spyOn(f.storage.ingestion, "put"), expected = JSON.stringify(guarded);
  for (let repeat = 0; repeat < 2; repeat++) {
    const report = await f.replay();
    expect(report.contextualQa?.reports[0]).toMatchObject({ patternsPersisted: 0,
      deferredProjections: [{ sourceVersionId: String(teacher.sourceVersionId), reason: "dependencies_outside_pool" }] });
    expect(JSON.stringify(await f.storage.languageMemory.getLanguagePatternProjection!(key))).toBe(expected);
    expect(put).not.toHaveBeenCalled();
  }
});
