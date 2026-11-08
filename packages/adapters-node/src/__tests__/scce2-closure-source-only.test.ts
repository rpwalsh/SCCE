// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { getFixtureLanguagePatternProjection, replaceFixtureLanguagePatternProjection } from "../../../kernel/src/__tests__/language-pattern-projection-fixture.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAlphaFieldEngine,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createInMemoryDialogueMemoryStore,
  createLanguageMemoryRuntime,
  createLanguageAcquisitionEngine,
  createMouth,
  createSemanticEntailmentEngine,
  evidenceProofBoundary,
  isLanguageConstructionPattern,
  realizeLearnedSurface,
  assertBrainLifecycleTransition,
  type BenchmarkStore,
  type BlobStore,
  type BrainImportLedgerRecord,
  type BrainImportStore,
  type BrainImportSummary,
  type BrainLifecycleRecord,
  type CapabilityAuditStore,
  type ConversationStore,
  type ConversationTurnRecord,
  type ConstructGraph,
  type ConstructStore,
  type ContentHash,
  type CorrectionMemoryStore,
  type UserModelClaimStore,
  type UserModelClaimRecord,
  type TaskResumptionSnapshotStore,
  type TaskResumptionSnapshotRecord,
  type DocumentGenerationSessionStore,
  type DocumentGenerationSessionRecord,
  type EventLedger,
  type EventRangeQuery,
  type EvidenceQuery,
  type EvidenceSearchResult,
  type EvidenceSpan,
  type EvidenceStore,
  type FlowCacheStore,
  type ForecastState,
  type ForecastStore,
  type GraphEdge,
  type GraphSlice,
  type GraphSliceQuery,
  type GraphStore,
  type Hyperedge,
  type IngestionCheckpoint,
  type IngestionCheckpointStore,
  type JsonValue,
  type LanguageMemoryStore,
  type LanguagePatternRecord,
  type LanguageProfile,
  type LanguageUnitRecord,
  type LocalizationStore,
  type ModelStore,
  type NgramModelRecord,
  type NgramObservation,
  type PpfCacheRecord,
  type ProofStore,
  type QuarantineStore,
  type ScceEvent,
  type ScceStorage,
  type SemanticFrameRecord,
  type SelfRewriteStore,
  type SourceVersion,
  type TemporalGraph,
  type TemporalGraphQuery,
  type TranslationAlignmentRecord,
  type WorkspaceStore
} from "@scce/kernel";
import { createScce2ToV3Importer } from "../scce2/scce2-to-v3-importer.js";
import { routeEngineeringCorpusFixture } from "../engineering-corpus-folder.js";

const closureMeaning = {
  subject: "The azurite operator", predicate: "preserves", object: "70% thermal margin", relationId: "relation.closure.preserves"
};

describe("SCCE2 bridge closure source-only loop", () => {
  it("keeps inspect read-only, imports idempotently, and feeds proof, alpha, Mouth, and hygiene-safe traces", async () => {
    const root = await writeSyntheticScce2Brain();
    try {
      const clock = createClock({ fixedTime: 12000, stepMs: 1 });
      const hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "closure" });
      const storage = new MemoryScceStorage(hasher.digestHex);
      const importer = createScce2ToV3Importer({ storage, clock, hasher, idFactory: ids, namespace: "closure" });

      const beforeInspect = storage.snapshot();
      const inspection = await importer.inspect(root);
      expect(storage.snapshot()).toEqual(beforeInspect);
      expect(inspection.importable.graphShards).toBe(1);
      expect(inspection.importable.languageShards).toBe(1);
      expect(inspection.importable.profileExcerptEvidenceSpans).toBe(2);
      expect(inspection.importable.learnedConceptPriors).toBe(1);
      expect(inspection.warnings.some(item => item.includes("brain bundle"))).toBe(true);

      const first = await importer.import(root, {
        now: clock.now(),
        graphConceptLimit: 16,
        graphRelationLimit: 16,
        fileEvidenceLimitPerShard: 8,
        hashWorkExtentBytes: 256 * 1024,
        maxHashBytesPerFile: 256 * 1024
      });
      const afterFirst = storage.snapshot();
      const second = await importer.import(root, {
        now: clock.now(),
        graphConceptLimit: 16,
        graphRelationLimit: 16,
        fileEvidenceLimitPerShard: 8,
        hashWorkExtentBytes: 256 * 1024,
        maxHashBytesPerFile: 256 * 1024
      });
      expect(second.importRunId).toBe(first.importRunId);
      expect(storage.snapshot()).toEqual(afterFirst);
      expect(storage.eventsRows.length).toBe(2);

      const summary = await storage.brainImports.summarize({ importRunId: first.importRunId });
      expect(summary.activeBrainVersion).toBe(first.activeBrainVersion);
      expect(summary.activeImportRunIds).toContain(String(first.importRunId));
      expect(summary.importedLanguagePriorCount).toBeGreaterThan(0);
      expect(summary.importedGraphPriorCount).toBeGreaterThan(0);
      expect(summary.importedDirectEvidenceCount).toBe(1);
      expect(summary.profileExcerptEvidenceCount).toBe(1);
      expect(summary.importedLearnedPriorCount).toBeGreaterThanOrEqual(summary.importedLanguagePriorCount + summary.importedGraphPriorCount);
      expect(summary.unknownPriorCount).toBeGreaterThan(0);
      expect(summary.runs[0]?.warnings.some(item => item.includes("brain bundle"))).toBe(true);

      const direct = storage.evidenceSpans.find(span => forceClassOf(span.provenance) === "direct_evidence");
      const profileExcerpt = storage.evidenceSpans.find(span => forceClassOf(span.provenance) === "profile_excerpt_evidence");
      expect(direct).toBeDefined();
      expect(profileExcerpt).toBeDefined();
      if (!direct || !profileExcerpt) throw new Error("synthetic evidence import failed");
      expect(evidenceProofBoundary(direct).certifiesFactualProof).toBe(true);
      expect(evidenceProofBoundary(profileExcerpt).certifiesFactualProof).toBe(false);

      const proofEngine = createSemanticEntailmentEngine({ idFactory: ids, hasher });
      const directProof = proofEngine.check({ text: direct.text, evidence: [direct], nodes: storage.graphNodes(), field: emptyField(), createdAt: clock.now() });
      const profileProof = proofEngine.check({ text: profileExcerpt.text, evidence: [profileExcerpt], nodes: storage.graphNodes(), field: emptyField(), createdAt: clock.now() });
      expect(directProof.evidenceIds.map(String)).toContain(String(direct.id));
      expect(profileProof.evidenceIds).toEqual([]);

      const field = createAlphaFieldEngine().activate({ text: direct.text, nodes: storage.graphNodes(), edges: storage.graphEdges() });
      const importedPriorTrace = jsonRecord(field.ppfDiagnostics).importedPriorTrace;
      expect(Number(jsonRecord(importedPriorTrace).importedGraphNodeCountActivated ?? 0)).toBeGreaterThan(0);
      expect(Number(jsonRecord(importedPriorTrace).importedGraphEdgeCountActivated ?? 0)).toBeGreaterThan(0);

      const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
      const languageState = languageRuntime.hydrateFromImportedBrain({
        importRunId: String(first.importRunId),
        models: storage.ngramModels,
        observations: storage.ngramObservations,
        units: storage.languageUnits,
        patterns: storage.languagePatterns,
        semanticFrames: storage.semanticFrames,
        constructionEvidence: storage.evidenceSpans
      });
      expect(languageState.importedLanguagePriorCount).toBeGreaterThan(0);
      expect(languageState.importedConstructionBundles).toHaveLength(1);
      expect(languageState.rejectedConstructionPatterns).toEqual([]);
      expect(languageState.importedConstructionBundles[0]!.sourceExamples.every(example => example.evidenceId === String(profileExcerpt.id)
        && example.sourceVersionId === String(profileExcerpt.sourceVersionId))).toBe(true);

      const correctionMemory = createCorrectionMemory({ idFactory: ids, hasher });
      const correction = correctionMemory.record({
        episodeId: ids.episodeId(),
        ownerFeedbackEventId: ids.eventId(),
        now: clock.now(),
        correction: {
          kind: "preferred_surface",
          observedSurface: "azurite",
          preferredSurface: "azurite closure",
          languageId: "closure-language",
          weight: 0.94
        }
      });
      const speakInput = {
        construct: constructGraph(ids, direct),
        field,
        languageProfile: languageProfile(ids, profileExcerpt, clock.now()),
        evidence: [direct],
        entailment: directProof,
        languageMemory: languageState,
        targetLanguage: "closure-language",
        correctionRules: [correction],
        brainMarker: {
          activeBrainVersion: summary.activeBrainVersion ?? null,
          activeImportRunIds: summary.activeImportRunIds,
          importedLanguagePriorCount: summary.importedLanguagePriorCount,
          importedGraphPriorCount: summary.importedGraphPriorCount,
          importedDirectEvidenceCount: summary.importedDirectEvidenceCount,
          profileExcerptEvidenceCount: summary.profileExcerptEvidenceCount,
          importedLearnedPriorCount: summary.importedLearnedPriorCount,
          unknownPriorCount: summary.unknownPriorCount
        }
      };
      const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory, hashText: (text: string) => hasher.digestHex(text) });
      const spoken = await mouth.speak(speakInput);

      expect(spoken.realizationTrace.selected.path).toBe("generated");
      expect(spoken.text).not.toBe(direct.text);
      expect(spoken.text).toContain("70%");
      expect(spoken.text).toContain("azurite closure");
      expect(spoken.text).toContain(closureMeaning.subject);
      expect(spoken.text).not.toContain("The azurite closure operator");
      expect(spoken.evidenceRefs).toEqual([direct.id]);
      expect(spoken.surfaceValid).toBe(true);
      expect(spoken.text.indexOf(closureMeaning.object)).toBeLessThan(spoken.text.indexOf(closureMeaning.subject));
      expect(spoken.realizationTrace.selected.id).toMatch(/^candidate:generated:learned-construction:/u);
      expect(spoken.text).not.toContain("no-kind-compatible-evidence");
      expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("activeBrainVersion");
      expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("generatedSurfacePieces");
      expect(JSON.stringify(spoken.realizationTrace.corrections)).toContain(correction.id);
      expect(JSON.stringify(spoken.realizationTrace.preservation)).toContain("score");
      const traceText = JSON.stringify(spoken.realizationTrace);
      expect(traceText).not.toContain(forbiddenTerm([116, 114, 97, 110, 115, 102, 111, 114, 109, 101, 114], [119, 101, 105, 103, 104, 116]));
      expect(traceText).not.toContain(forbiddenTerm([109, 111, 100, 101, 108], [119, 101, 105, 103, 104, 116]));

      const untrainedState = languageRuntime.hydrateFromImportedBrain({
        importRunId: String(first.importRunId), models: storage.ngramModels, observations: storage.ngramObservations,
        units: storage.languageUnits, patterns: storage.languagePatterns.filter(pattern => !isLanguageConstructionPattern(pattern)),
        semanticFrames: storage.semanticFrames, constructionEvidence: storage.evidenceSpans
      });
      const withoutForms = await mouth.speak({ ...speakInput, languageMemory: untrainedState });
      expect(withoutForms.text).toBe(direct.text);
      expect(withoutForms.realizationTrace.selected.id).not.toMatch(/^candidate:generated:learned-construction:/u);
      expect(withoutForms.text).not.toContain("azurite closure");
      expect(withoutForms.text).not.toContain("is what");
      expect(withoutForms.text).toContain(closureMeaning.subject);

      const corpusRoot = await writePhase4CorpusFixture();
      try {
        const corpus = await routeEngineeringCorpusFixture(corpusRoot);
        expect(corpus.dryRun).toBe(true);
        expect(corpus.mutation).toEqual({ postgres: false, filesystemWrites: false, serverStarted: false });
        expect(corpus.routeAudit.passed).toBe(true);
        expect(corpus.observations.byKind.language).toBeGreaterThan(0);
        expect(corpus.observations.byKind.table).toBeGreaterThan(0);
        expect(corpus.observations.byKind.log_event).toBeGreaterThan(0);
        expect(corpus.observations.byKind.code).toBeGreaterThan(0);
        expect(corpus.routes.forbiddenStores.language_memory).toBeGreaterThan(0);
        expect(corpus.engineering.packageManagers).toContain("pnpm");
        expect(JSON.stringify(corpus.engineering.commandCandidates)).toContain("build");
        expect(JSON.stringify(corpus.engineering.commandCandidates)).toContain("test");
        expect(summary.importedDirectEvidenceCount).toBe(1);
        expect(evidenceProofBoundary(profileExcerpt).certifiesFactualProof).toBe(false);
      } finally {
        await rm(corpusRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["source_hash", "range"] as const)("rejects %s construction annotations without activating them", async fault => {
    const root = await writeSyntheticScce2Brain(fault);
    try {
      const clock = createClock({ fixedTime: 12500, stepMs: 1 }), hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: `closure-invalid-${fault}` });
      const storage = new MemoryScceStorage(hasher.digestHex);
      const importer = createScce2ToV3Importer({ storage, clock, hasher, idFactory: ids, namespace: "closure-invalid" });
      await expect(importer.import(root, { now: clock.now() })).rejects.toThrow(/source construction/u);
      expect(storage.languagePatterns.some(isLanguageConstructionPattern)).toBe(false);
      expect((await storage.brainImports.active()).activeImportRunIds).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("imports astral/CJK source coordinates and realizes their owned construction without changing source identity", async () => {
    const fixture = await writeUnicodeScce2Brain();
    try {
      const clock = createClock({ fixedTime: 12600, stepMs: 1 }), hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "closure-unicode" });
      const storage = new MemoryScceStorage(hasher.digestHex);
      const importer = createScce2ToV3Importer({ storage, clock, hasher, idFactory: ids, namespace: "closure-unicode" });
      await importer.import(fixture.root, { now: clock.now() });
      const source = storage.evidenceSpans.find(span => span.text === fixture.excerpt)!;
      expect(source).toBeDefined();
      const bytes = Buffer.from(fixture.excerpt, "utf8"), sourceVersionId = ids.sourceVersionId(bytes);
      expect(source.sourceVersionId).toBe(sourceVersionId);
      expect(source.id).toBe(ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: ids.contentHash(bytes) }));
      expect(source.charEnd).toBe([...fixture.excerpt].length);
      expect(source.charEnd).not.toBe(fixture.excerpt.length);
      expect(source.byteEnd).toBe(bytes.length);
      expect(Buffer.from(await storage.blobs.get(source.contentHash))).toEqual(bytes);
      const provenance = jsonRecord(source.provenance), original = jsonRecord(provenance.originalSource);
      expect(provenance.charRange).toEqual([0, [...fixture.excerpt].length]);
      expect(provenance.byteRange).toEqual([0, bytes.length]);
      expect(provenance.coordinateSystemId).toBe("unicode.code_point.v1");
      expect(provenance.coordinateSourceVersionId).toBe(sourceVersionId);
      expect(original).toEqual({ uri: "fixture://unicode/source", version: "unicode-version-1", byteRange: [100, 100 + bytes.length], charRange: [50, 50 + [...fixture.excerpt].length] });
      const version = (await storage.evidence.sourceVersionsForEvidence([source.id]))[0]!;
      expect(version.sourceId).toBe(source.sourceId);
      expect(version.contentHash).toBe(source.contentHash);
      expect(jsonRecord(jsonRecord(version.metadata).provenance).charRange).toEqual(provenance.charRange);
      const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
      const state = runtime.hydrateFromImportedBrain({ models: [], observations: [], units: [], patterns: storage.languagePatterns, constructionEvidence: [source] });
      expect(state.rejectedConstructionPatterns).toEqual([]);
      expect(state.importedConstructionBundles).toHaveLength(1);
      const bundle = state.importedConstructionBundles[0]!;
      expect(bundle.sourceExamples.map(example => example.roles.map(role => role.surface))).toEqual(fixture.forms.map(form => form.slots));
      expect(bundle.sourceExamples.every(example => example.evidenceId === String(source.id) && example.sourceVersionId === String(source.sourceVersionId)
        && example.evidenceCharStart === 0 && example.evidenceCharEnd === [...fixture.excerpt].length)).toBe(true);
      const example = bundle.sourceExamples[0]!;
      const realized = realizeLearnedSurface({ hasher, constructions: bundle.constructions, formClasses: bundle.formClasses, plan: {
        id: "meaning.unicode.crossed", profileKey: bundle.targetProfileId, roleSignature: example.roles.map(role => role.roleId),
        slots: example.roles.map(role => ({ roleId: role.roleId, occurrenceId: role.occurrenceId,
          variants: [{ id: `${role.occurrenceId}.crossed`, profileKey: bundle.targetProfileId, surface: role.slotIndex === 2 ? "🦉丁" : role.surface, evidenceIds: [String(source.id)] }] }))
      } });
      expect(realized.status).toBe("realized");
      if (realized.status === "realized") {
        expect(realized.realization.text).toBe("🧪甲が🦉丁を運ぶ。");
        expect(realized.realization.provenance.verification).toBe("unverified");
      }

      const { coordinateSystemId: _system, coordinateSourceVersionId: _coordinateOwner, ...historicalProvenance } = provenance;
      const historical = { ...source, charEnd: fixture.excerpt.length, provenance: { ...historicalProvenance, charRange: [0, fixture.excerpt.length] } };
      await storage.evidence.putEvidenceSpan(historical);
      await importer.import(fixture.root, { now: clock.now() });
      expect(await storage.evidence.getEvidence(source.id)).toEqual(historical);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it.each(["utf16_offsets", "utf16_system"] as const)("rejects declared %s instead of guessing an alternative coordinate system", async fault => {
    const fixture = await writeUnicodeScce2Brain(fault);
    try {
      const clock = createClock({ fixedTime: 12700, stepMs: 1 }), hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: `closure-${fault}` });
      const storage = new MemoryScceStorage(hasher.digestHex);
      const importer = createScce2ToV3Importer({ storage, clock, hasher, idFactory: ids, namespace: "closure-unicode" });
      await expect(importer.import(fixture.root, { now: clock.now() })).rejects.toThrow(/source construction/u);
      expect(storage.languagePatterns.some(isLanguageConstructionPattern)).toBe(false);
      expect((await storage.brainImports.active()).activeImportRunIds).toEqual([]);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("never activates a stopped partial import and resumes it to an explicit completion record", async () => {
    const root = await writeSyntheticScce2Brain();
    const stopFile = path.join(root, ".stop-import");
    try {
      await writeFile(stopFile, "stop\n", "utf8");
      const clock = createClock({ fixedTime: 13000, stepMs: 1 });
      const hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "closure-stop" });
      const storage = new MemoryScceStorage(hasher.digestHex);
      const importer = createScce2ToV3Importer({ storage, clock, hasher, idFactory: ids, namespace: "closure-stop" });

      const stopped = await importer.import(root, { now: clock.now(), stopFile });
      expect(stopped.stopped).toBe(true);
      expect((await storage.brainImports.active()).activeImportRunIds).toEqual([]);
      expect((await storage.brainImports.getLifecycle(String(stopped.importRunId)))?.state).toBe("STOPPED");
      expect((await storage.brainImports.listLedger({ importRunId: stopped.importRunId, limit: 1000 })).some(row => row.sectionId === "__import_complete__")).toBe(false);

      await rm(stopFile, { force: true });
      const completed = await importer.import(root, { now: clock.now(), stopFile });
      expect(completed.importRunId).toBe(stopped.importRunId);
      expect(completed.stopped).not.toBe(true);
      expect((await storage.brainImports.active()).activeImportRunIds).toContain(String(completed.importRunId));
      expect((await storage.brainImports.getLifecycle(String(completed.importRunId)))?.state).toBe("ACTIVE");
      const ledger = await storage.brainImports.listLedger({ importRunId: completed.importRunId, limit: 1000 });
      expect(ledger.some(row => row.sectionId === "__import_complete__" && jsonRecord(row.metadata).complete === true)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the prior ACTIVE brain when activation fails before the atomic commit", async () => {
    const firstRoot = await writeSyntheticScce2Brain();
    const secondRoot = await writeSyntheticScce2Brain();
    try {
      const clock = createClock({ fixedTime: 17000, stepMs: 1 });
      const hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "closure-activation-failpoint" });
      const storage = new MemoryScceStorage(hasher.digestHex);
      const importer = createScce2ToV3Importer({ storage, clock, hasher, idFactory: ids, namespace: "closure-activation-failpoint" });
      const first = await importer.import(firstRoot, { now: clock.now() });
      const before = await storage.brainImports.active();
      expect(before.activeImportRunIds[0]).toBe(first.importRunId);

      storage.failNextBrainActivation();
      await expect(importer.import(secondRoot, { now: clock.now() })).rejects.toThrow("activation failpoint");

      expect(await storage.brainImports.active()).toEqual(before);
      expect((await storage.brainImports.getLifecycle(String(first.importRunId)))?.state).toBe("ACTIVE");
      expect((await storage.brainImports.listLifecycle({ state: "READY" })).length).toBe(1);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("advertises only the lifecycle row that is actually ACTIVE after replacement", async () => {
    const firstRoot = await writeSyntheticScce2Brain();
    const secondRoot = await writeSyntheticScce2Brain();
    try {
      const clock = createClock({ fixedTime: 18000, stepMs: 1 });
      const hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "closure-activation-replacement" });
      const storage = new MemoryScceStorage(hasher.digestHex);
      const importer = createScce2ToV3Importer({ storage, clock, hasher, idFactory: ids, namespace: "closure-activation-replacement" });
      const first = await importer.import(firstRoot, { now: clock.now() });
      const second = await importer.import(secondRoot, { now: clock.now() });

      expect(await storage.brainImports.active()).toEqual({
        activeBrainVersion: second.activeBrainVersion,
        activeImportRunIds: [second.importRunId]
      });
      expect((await storage.brainImports.getLifecycle(String(first.importRunId)))?.state).toBe("READY");
      expect((await storage.brainImports.getLifecycle(String(second.importRunId)))?.state).toBe("ACTIVE");
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });
});

function closureConstructionTeaching() {
  const forms = [
    { text: "For azurite assessment, 20% thermal margin is what The annex operator preserves.", slots: ["The annex operator", "preserves", "20% thermal margin"] },
    { text: "For azurite assessment, 30% thermal margin is what The atrium operator preserves.", slots: ["The atrium operator", "preserves", "30% thermal margin"] }
  ];
  const introduction = "The profile-only closure claim is not external proof.\n";
  const excerpt = introduction + forms.map(form => form.text).join("\n");
  const sourceTextHash = createHasher().digestHex(Buffer.from(excerpt, "utf8"));
  let offset = [...introduction].length;
  const sourceConstructions = forms.map(form => {
    const observation = {
      bindingId: closureMeaning.relationId, sourceTextHash,
      coordinateSystemId: "unicode.code_point.v1" as const,
      surfaceStartCodePoint: offset, surfaceEndCodePoint: offset + [...form.text].length,
      roles: form.slots.map((surface, slotIndex) => {
        const startCodePoint = [...form.text.slice(0, form.text.indexOf(surface))].length;
        return { slotIndex, startCodePoint, endCodePoint: startCodePoint + [...surface].length,
          graphBinding: { relationId: closureMeaning.relationId, roleId: `role.closure.${slotIndex}`, valueKind: ["entity", "relation", "quantity"][slotIndex]! } };
      })
    };
    offset = observation.surfaceEndCodePoint + 1;
    return observation;
  });
  return { excerpt, sourceConstructions };
}

async function writeUnicodeScce2Brain(fault?: "utf16_offsets" | "utf16_system") {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce2-unicode-"));
  await mkdir(path.join(root, "language"), { recursive: true });
  const forms = [
    { text: "🧪甲が🦉乙を運ぶ。", slots: ["🧪甲", "運ぶ", "🦉乙"] },
    { text: "🧪丙が🦉丁を運ぶ。", slots: ["🧪丙", "運ぶ", "🦉丁"] }
  ];
  const excerpt = `\n${forms.map(form => form.text).join("\n")}\n`;
  const sourceTextHash = createHasher().digestHex(Buffer.from(excerpt, "utf8"));
  const length = (text: string) => fault === "utf16_offsets" ? text.length : [...text].length;
  const sourceConstructions = forms.map(form => ({
    bindingId: "relation.unicode.transport", sourceTextHash,
    coordinateSystemId: fault === "utf16_system" ? "unicode.utf16.v1" : "unicode.code_point.v1",
    surfaceStartCodePoint: length(excerpt.slice(0, excerpt.indexOf(form.text))),
    surfaceEndCodePoint: length(excerpt.slice(0, excerpt.indexOf(form.text))) + length(form.text),
    roles: form.slots.map((surface, slotIndex) => ({ slotIndex,
      startCodePoint: length(form.text.slice(0, form.text.indexOf(surface))),
      endCodePoint: length(form.text.slice(0, form.text.indexOf(surface))) + length(surface),
      graphBinding: { relationId: "relation.unicode.transport", roleId: `role.unicode.${slotIndex}`, valueKind: ["entity", "relation", "entity"][slotIndex]! }
    }))
  }));
  await writeJson(path.join(root, "language", "language-shard-0001.profile.json"), {
    schema: "scce.learnedLanguageProfileShard.v1", sourceId: "unicode-source", shardId: "language-shard-0001", languageId: "unicode-language",
    fileEvidence: [{ title: "Unicode source", excerpt, sourceConstructions, originalSourceUri: "fixture://unicode/source",
      originalSourceVersionId: "unicode-version-1", originalByteRange: [100, 100 + Buffer.byteLength(excerpt)], originalCharRange: [50, 50 + [...excerpt].length] }]
  });
  return { root, excerpt, forms };
}

async function writeSyntheticScce2Brain(teachingFault?: "source_hash" | "range"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce2-closure-"));
  const teaching = closureConstructionTeaching();
  if (teachingFault === "source_hash") teaching.sourceConstructions[0]!.sourceTextHash = "not-the-exported-bytes";
  if (teachingFault === "range") teaching.sourceConstructions[0]!.surfaceEndCodePoint = [...teaching.excerpt].length + 1;
  await mkdir(path.join(root, "language"), { recursive: true });
  await writeJson(path.join(root, "concept-graph.json"), {
    concepts: [
      { id: "azurite-operator", names: ["azurite operator"], type: "process", domain: "closure" },
      { id: "thermal-margin", names: ["thermal margin"], type: "metric", domain: "closure" }
    ],
    relations: [
      { subject: "azurite-operator", predicate: "preserves", object: "thermal-margin", confidence: 0.91 }
    ]
  });
  await writeJson(path.join(root, "language", "language-shard-0001.profile.json"), {
    schema: "scce.learnedLanguageProfileShard.v1",
    sourceId: "closure-fixture",
    shardId: "language-shard-0001",
    languageId: "closure-language",
    script: "Latn",
    confidence: 0.93,
    tokenizationProfile: {
      observedTokens: [
        { value: "azurite", count: 8 },
        { value: "operator", count: 7 },
        { value: "preserves", count: 5 }
      ],
      observedTitleTokens: [
        { value: "azurite operator", count: 9 },
        { value: "thermal margin", count: 6 }
      ],
      codepointBuckets: [
        { value: "Latn", count: 16 }
      ]
    },
    syntaxProfile: {
      punctuation: [{ value: ".", count: 4 }],
      linePatterns: [{ value: "subject predicate number object", count: 3 }]
    },
    fileEvidence: [
      {
        id: "direct-closure-evidence",
        title: "exact external source",
        excerpt: "The azurite operator preserves 70% thermal margin.",
        originalSourceUri: "fixture://closure/direct",
        originalSourceVersionId: "fixture-version-1",
        originalByteRange: [0, 52],
        originalCharRange: [0, 52]
      },
      {
        id: "profile-only-evidence",
        title: "profile excerpt without coordinates",
        ...teaching
      }
    ]
  });
  await writeFile(path.join(root, "unsupported.brain"), "not a valid SCCE2 brain bundle", "utf8");
  return root;
}

async function writePhase4CorpusFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-phase4-cross-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "logs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), [
    "# Cross Phase Corpus",
    "",
    "This source-only corpus paragraph should become language-eligible prose.",
    "",
    "| timestamp | value_ms | note |",
    "| --- | --- | --- |",
    "| 2026-01-01T00:00 | 10 | table note remains typed and inspectable |",
    "| 2026-01-01T00:01 | 12 | table note remains typed and inspectable |",
    "| 2026-01-01T00:02 | 14 | table note remains typed and inspectable |"
  ].join("\n"), "utf8");
  await writeJson(path.join(root, "package.json"), {
    name: "phase4-cross",
    version: "1.0.0",
    scripts: { build: "tsc -p tsconfig.json", test: "vitest run" },
    dependencies: { "@example/runtime": "^1.0.0" },
    devDependencies: { typescript: "^5.8.0", vitest: "^3.2.0" }
  });
  await writeFile(path.join(root, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      '@example/runtime':",
    "        specifier: ^1.0.0",
    "        version: 1.0.0"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "src", "app.ts"), [
    "import { createServer } from '@example/runtime';",
    "export function startCrossPhase() { return createServer().get('/api/cross-phase', handler); }",
    "test('starts cross phase server', () => startCrossPhase());"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "data", "sample.csv"), [
    "timestamp,value_ms,note",
    "2026-01-01T00:00,10,the first cross phase row remains typed prose.",
    "2026-01-01T00:01,12,the second cross phase row remains typed prose.",
    "2026-01-01T00:02,14,the third cross phase row remains typed prose."
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "logs", "app.log"), [
    "2026-01-01T00:00:00Z INFO api message text",
    "{\"timestamp\":\"2026-01-01T00:00:01Z\",\"level\":\"error\",\"component\":\"api\",\"message\":\"retry\",\"attempt\":2}"
  ].join("\n"), "utf8");
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function constructGraph(ids: ReturnType<typeof createIdFactory>, evidence: EvidenceSpan): ConstructGraph {
  const text = evidence.text;
  if (![closureMeaning.subject, closureMeaning.predicate, closureMeaning.object].every(surface => text.includes(surface))) throw new Error("selected closure meaning is not in its source");
  const fact = { ...closureMeaning, sourceNodeId: "node.closure.operator", targetNodeId: "node.closure.margin", forceClass: "direct_evidence",
    score: 1, activation: 1, overlap: 1, support: 1, certificationPower: 1, semanticQuality: 1, answerGrade: true, finalQuestionFit: 1, questionSlotScore: 1,
    sourceVersionId: String(evidence.sourceVersionId), evidenceIds: [String(evidence.id)] };
  return {
    id: ids.constructId({ test: "closure", text }),
    episodeId: ids.episodeId(),
    forceVector: {},
    nodes: [{ id: "construct:closure-answer", kind: "construct:semantic_answer", label: fact.subject, metadata: {
      schema: "scce.semantic_answer_construct.v1", questionShapeId: "question.shape.closure", selectedSubject: fact.subject,
      selectedFacts: [fact], activatedNeighborhood: [fact], selectedRelations: [fact.relationId],
      supportIds: [String(evidence.id)],
      answerSlots: [{ id: "slot.closure", relationIds: [fact.relationId], factKeys: [[fact.subject, fact.predicate, fact.object, fact.relationId].map(value => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim()).join("\u0001")], support: fact.support, activation: fact.activation }],
      forceId: "output.force.source_bound_answer", boundaryId: "output.force.source_bound",
      certificationBoundary: { directEvidenceCount: 1, evidenceSpanIds: [String(evidence.id)], sourceVersionIds: [String(evidence.sourceVersionId)], externalFactCertification: evidenceProofBoundary(evidence).certifiesFactualProof }
    } }],
    edges: [],
    artifacts: []
  };
}

function languageProfile(ids: ReturnType<typeof createIdFactory>, source: EvidenceSpan, now: number): LanguageProfile {
  return {
    ...createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: source.sourceVersionId, text: source.text, createdAt: now }),
    id: "closure-language",
  };
}

function emptyField() {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    ppfDiagnostics: {},
    alphaTrace: {
      alpha: 0.7,
      thresholds: { virtual: 0.49, visible: 0.7, bonded: 0.8366600265340756, structural: 0.51 },
      relations: [],
      adjacency: matrix,
      laplacian: matrix,
      normalizedLaplacian: matrix,
      surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
      contradictionMass: 0,
      bondedLeakage: 0
    },
    causalMass: []
  };
}

function forceClassOf(value: JsonValue): string | undefined {
  return typeof value === "object" && value && !Array.isArray(value) && typeof value.provenanceClass === "string" ? value.provenanceClass : undefined;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

class MemoryScceStorage implements ScceStorage {
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  readonly eventsRows: ScceEvent[] = [];
  readonly sourceVersions = new Map<string, SourceVersion>();
  readonly evidenceSpans: EvidenceSpan[] = [];
  readonly nodes = new Map<string, GraphSlice["nodes"][number]>();
  readonly edges = new Map<string, GraphSlice["edges"][number]>();
  readonly hyperedges = new Map<string, Hyperedge>();
  readonly blobs: BlobStore;
  readonly ngramObservations: NgramObservation[] = [];
  readonly ngramModels: NgramModelRecord[] = [];
  readonly languageUnits: LanguageUnitRecord[] = [];
  readonly languagePatterns: LanguagePatternRecord[] = [];
  readonly semanticFrames: SemanticFrameRecord[] = [];
  readonly translationAlignments: TranslationAlignmentRecord[] = [];
  readonly conversationRows: ConversationTurnRecord[] = [];
  private readonly ledger = new Map<string, BrainImportLedgerRecord>();
  private readonly lifecycles = new Map<string, BrainLifecycleRecord>();
  private activeBrain?: { activeBrainVersion?: string; activeImportRunIds: string[] };
  private failActivation = false;
  readonly workspaceRows = new Map<string, Awaited<ReturnType<WorkspaceStore["getWorkspace"]>>>();
  readonly workspaceFiles: Awaited<ReturnType<WorkspaceStore["listSourceFiles"]>> = [];
  readonly workspaceReports: Awaited<ReturnType<WorkspaceStore["listReports"]>> = [];
  readonly dialogueMemory = createInMemoryDialogueMemoryStore();

  constructor(digest: (input: string | Uint8Array) => string) {
    this.blobs = new MemoryBlobStore(digest);
  }

  events: EventLedger = {
    append: async event => {
      if (!this.eventsRows.some(row => row.id === event.id)) this.eventsRows.push(event);
    },
    appendBatch: async events => {
      for (const event of events) await this.events.append(event);
    },
    readEpisode: async episodeId => this.eventsRows.filter(event => event.episodeId === episodeId),
    readRange: async query => this.eventsRows
      .filter(event => !query.episodeId || event.episodeId === query.episodeId)
      .filter(event => !query.typeId || event.typeId === query.typeId)
      .filter(event => query.afterT === undefined || event.t > query.afterT)
      .filter(event => query.beforeT === undefined || event.t < query.beforeT)
      .slice(0, query.limit ?? 1000),
    latestLedgerHash: async () => this.eventsRows.at(-1)?.hash ?? ""
  };

  conversation: ConversationStore = {
    putTurn: async record => {
      const index = this.conversationRows.findIndex(row => row.id === record.id);
      if (index >= 0) this.conversationRows[index] = record;
      else this.conversationRows.push(record);
    },
    listTurns: async query => this.conversationRows
      .filter(row => row.sessionId === query.sessionId)
      .filter(row => query.beforeTurnIndex === undefined || row.turnIndex < query.beforeTurnIndex)
      .sort((a, b) => b.turnIndex - a.turnIndex || b.id.localeCompare(a.id))
      .slice(0, query.limit ?? 24)
      .reverse()
  };

  ingestion: IngestionCheckpointStore = {
    put: async checkpoint => { void checkpoint; },
    get: async () => null,
    list: async () => []
  };

  workspace: WorkspaceStore = {
    putWorkspace: async record => { this.workspaceRows.set(record.id, record); },
    getWorkspace: async id => this.workspaceRows.get(id) ?? null,
    latestWorkspace: async () => [...this.workspaceRows.values()].filter((row): row is NonNullable<typeof row> => Boolean(row)).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null,
    putSourceFile: async record => {
      const index = this.workspaceFiles.findIndex(file => file.workspaceId === record.workspaceId && file.path === record.path);
      if (index >= 0) this.workspaceFiles[index] = record;
      else this.workspaceFiles.push(record);
    },
    listSourceFiles: async query => this.workspaceFiles
      .filter(file => !query?.workspaceId || file.workspaceId === query.workspaceId)
      .filter(file => !query?.corpusId || file.corpusId === query.corpusId)
      .filter(file => !query?.status || file.ingestionStatus === query.status)
      .slice(0, query?.limit ?? 10000),
    putReport: async record => {
      const index = this.workspaceReports.findIndex(report => report.id === record.id);
      if (index >= 0) this.workspaceReports[index] = record;
      else this.workspaceReports.push(record);
    },
    listReports: async query => this.workspaceReports
      .filter(report => !query?.workspaceId || report.workspaceId === query.workspaceId)
      .filter(report => !query?.reportKind || report.reportKind === query.reportKind)
      .slice(0, query?.limit ?? 100)
  };

  graph: GraphStore = {
    upsertNode: async node => { this.nodes.set(String(node.id), node); },
    upsertEdge: async edge => { this.edges.set(String(edge.id), edge); },
    upsertHyperedge: async edge => { this.hyperedges.set(String(edge.id), edge); },
    getSlice: async query => this.graphSlice(query),
    getTemporalSlice: async query => ({ ...this.graphSlice(query), temporalQuery: query }),
    materializeAlphaGraph: async () => emptyField().alphaTrace
  };

  evidence: EvidenceStore = {
    putSourceVersion: async source => { this.sourceVersions.set(String(source.sourceVersionId), source); },
    putEvidenceSpan: async span => {
      const index = this.evidenceSpans.findIndex(row => row.id === span.id);
      if (index >= 0) this.evidenceSpans[index] = span;
      else this.evidenceSpans.push(span);
    },
    promoteEvidence: async ids => this.evidenceSpans.filter(span => ids.includes(span.id)).length,
    getEvidence: async id => this.evidenceSpans.find(span => span.id === id) ?? null,
    getEvidenceBatch: async ids => this.evidenceSpans.filter(span => ids.includes(span.id)),
    searchEvidence: async query => this.searchEvidence(query),
    sourceVersionsForEvidence: async ids => this.evidenceSpans
      .filter(span => ids.includes(span.id))
      .flatMap(span => {
        const source = this.sourceVersions.get(String(span.sourceVersionId));
        return source ? [source] : [];
      })
  };

  quarantine: QuarantineStore = {
    put: async source => { void source; },
    get: async () => null,
    listPending: async () => [],
    markDecision: async (id, decision) => { void id; void decision; }
  };

  proofs: ProofStore = {
    putProof: async proof => { void proof; },
    getProof: async () => null,
    findProofsForClaim: async () => []
  };

  constructs: ConstructStore = {
    putConstruct: async graph => { void graph; },
    putValidation: async graph => { void graph; },
    putEmission: async graph => { void graph; },
    putBuildTest: async (episodeId, constructId, result) => { void episodeId; void constructId; void result; },
    getConstruct: async () => null
  };

  capabilities: CapabilityAuditStore = {
    putPlan: async plan => { void plan; },
    listByEpisode: async () => []
  };

  forecasts: ForecastStore = {
    putState: async state => { void state; },
    putForecast: async forecast => { void forecast; },
    getSeries: async () => []
  };

  benchmarks: BenchmarkStore = {
    putRun: async run => { void run; },
    putCase: async result => { void result; },
    summarize: async () => ({ runs: 0, cases: 0, meanScore: 0 })
  };

  model: ModelStore = {
    readModel: async () => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
    writeModel: async model => { void model; },
    putLanguageProfile: async profile => { void profile; },
    listLanguageProfiles: async () => []
  };

  languageMemory: LanguageMemoryStore = {
    putNgramObservation: async observation => { this.upsert(this.ngramObservations, observation, row => row.id); },
    putNgramObservationsBatch: async observations => {
      for (const observation of observations) this.upsert(this.ngramObservations, observation, row => row.id);
    },
    putNgramModel: async model => { this.upsert(this.ngramModels, model, row => row.id); },
    putLanguageUnit: async unit => { this.upsert(this.languageUnits, unit, row => row.id); },
    getLanguagePatternProjection: getFixtureLanguagePatternProjection,
    replaceLanguagePatternProjection: replaceFixtureLanguagePatternProjection,
    putLanguagePattern: async pattern => { this.upsert(this.languagePatterns, pattern, row => row.id); },
    putSemanticFrame: async frame => { this.upsert(this.semanticFrames, frame, row => row.id); },
    putTranslationAlignment: async alignment => { this.upsert(this.translationAlignments, alignment, row => row.id); },
    listNgramModels: async query => this.ngramModels
      .filter(model => !query?.streamId || model.streamId === query.streamId)
      .filter(model => !query?.languageHint || model.languageHint === query.languageHint)
      .slice(0, query?.limit ?? 1000),
    listNgramObservations: async query => this.filterBySource(this.ngramObservations, query?.sourceSystem).slice(0, query?.limit ?? 1000),
    listLanguageUnits: async query => this.filterBySource(this.languageUnits, query?.sourceSystem).slice(0, query?.limit ?? 1000),
    listLanguagePatterns: async query => this.filterBySource(this.languagePatterns, query?.sourceSystem).slice(0, query?.limit ?? 1000),
    listSemanticFrames: async query => this.filterBySource(this.semanticFrames, query?.sourceSystem).slice(0, query?.limit ?? 1000),
    listTranslationAlignments: async query => this.translationAlignments.slice(0, query?.limit ?? 1000)
  };

  brainImports: BrainImportStore = {
    putLedger: async record => {
      const duplicate = [...this.ledger.values()].find(row => row.importRunId === record.importRunId && row.sectionId === record.sectionId);
      if (duplicate) this.ledger.delete(duplicate.id);
      this.ledger.set(record.id, record);
    },
    listLedger: async query => this.ledgerRows(query),
    summarize: async query => this.summarizeLedger(query),
    putLifecycle: async record => {
      const existing = this.lifecycles.get(record.importRunId);
      if (existing && (existing.brainVersion !== record.brainVersion || existing.rootPath !== record.rootPath)) throw new Error(`brain lifecycle identity conflict for ${record.importRunId}`);
      if (!existing) this.lifecycles.set(record.importRunId, structuredClone(record));
    },
    getLifecycle: async importRunId => structuredClone(this.lifecycles.get(importRunId) ?? null),
    listLifecycle: async query => [...this.lifecycles.values()]
      .filter(row => !query?.state || row.state === query.state)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, query?.limit ?? 100)
      .map(row => structuredClone(row)),
    transitionLifecycle: async input => {
      const current = this.lifecycles.get(input.importRunId);
      if (!current) throw new Error(`brain lifecycle not found for ${input.importRunId}`);
      if (current.state !== input.expectedState) throw new Error(`brain lifecycle compare-and-set failed for ${input.importRunId}: expected ${input.expectedState}, found ${current.state}`);
      assertBrainLifecycleTransition(current.state, input.toState);
      const next: BrainLifecycleRecord = {
        ...current,
        state: input.toState,
        validation: input.validation ?? current.validation,
        reason: input.reason,
        revision: current.revision + 1,
        updatedAt: input.updatedAt
      };
      this.lifecycles.set(input.importRunId, next);
      return structuredClone(next);
    },
    activateReady: async input => {
      const current = this.lifecycles.get(input.importRunId);
      if (!current) throw new Error(`brain lifecycle not found for ${input.importRunId}`);
      if (current.brainVersion !== input.brainVersion) throw new Error(`brain lifecycle version mismatch for ${input.importRunId}`);
      if (current.state !== "READY") throw new Error(`brain activation requires READY, found ${current.state}`);
      if (this.failActivation) {
        this.failActivation = false;
        throw new Error("brain activation failpoint before commit");
      }
      const previousImportRunId = this.activeBrain?.activeImportRunIds[0];
      const previous = previousImportRunId ? this.lifecycles.get(previousImportRunId) : undefined;
      if (previous?.state === "ACTIVE") this.lifecycles.set(previous.importRunId, { ...previous, state: "READY", reason: `deactivated by ${input.importRunId}`, revision: previous.revision + 1, updatedAt: input.updatedAt });
      this.lifecycles.set(input.importRunId, { ...current, state: "ACTIVE", reason: undefined, revision: current.revision + 1, updatedAt: input.updatedAt });
      this.activeBrain = { activeBrainVersion: input.brainVersion, activeImportRunIds: [input.importRunId] };
      return { activeBrainVersion: input.brainVersion, activeImportRunIds: this.activeBrain.activeImportRunIds };
    },
    active: async () => this.activeBrain ?? { activeImportRunIds: [] }
  };

  corrections: CorrectionMemoryStore = {
    putRule: async rule => { void rule; },
    listRules: async () => []
  };

  // Real, working in-memory implementations, matching this class's own
  // "Memory..." intent -- not no-op stubs that would silently hide a
  // real persistence bug even though this particular test doesn't
  // exercise these paths.
  private readonly userModelClaimRecords = new Map<string, UserModelClaimRecord>();
  userModelClaims: UserModelClaimStore = {
    putClaim: async claim => {
      const key = `${claim.conversationId} ${claim.id}`;
      if (!this.userModelClaimRecords.has(key)) this.userModelClaimRecords.set(key, claim);
    },
    listClaims: async query => {
      let rows = [...this.userModelClaimRecords.values()].filter(row => row.conversationId === query.conversationId);
      if (query.subject) rows = rows.filter(row => row.subject === query.subject);
      if (query.scope) rows = rows.filter(row => row.scope === query.scope);
      rows = rows.slice().sort((left, right) => right.observedAt - left.observedAt);
      return rows.slice(0, query.limit ?? 200);
    }
  };

  private readonly taskResumptionRecords: TaskResumptionSnapshotRecord[] = [];
  taskResumption: TaskResumptionSnapshotStore = {
    putSnapshot: async record => { this.taskResumptionRecords.push(record); },
    getLatestSnapshot: async goalId => {
      const matching = this.taskResumptionRecords.filter(record => record.goalId === goalId);
      return matching.length ? matching.reduce((latest, record) => record.capturedAt > latest.capturedAt ? record : latest) : null;
    }
  };

  private readonly documentGenerationRecords = new Map<string, DocumentGenerationSessionRecord>();
  private documentGenerationKey(id: string, conversationId: string): string { return `${conversationId} ${id}`; }
  documentGeneration: DocumentGenerationSessionStore = {
    putSession: async record => { this.documentGenerationRecords.set(this.documentGenerationKey(record.id, record.conversationId), record); },
    getSession: async (id, conversationId) => this.documentGenerationRecords.get(this.documentGenerationKey(id, conversationId)) ?? null,
    compareAndPutSession: async (record, expectedUpdatedAt) => {
      const current = this.documentGenerationRecords.get(this.documentGenerationKey(record.id, record.conversationId)) ?? null;
      if ((current?.updatedAt ?? null) !== expectedUpdatedAt) return { stored: false, currentUpdatedAt: current?.updatedAt ?? null };
      this.documentGenerationRecords.set(this.documentGenerationKey(record.id, record.conversationId), record);
      return { stored: true, currentUpdatedAt: record.updatedAt };
    }
  };

  localization: LocalizationStore = {
    putBundle: async bundle => { void bundle; },
    listBundles: async () => [],
    promoteBundle: async (id, promotedAt) => { void id; void promotedAt; }
  };

  flowCache: FlowCacheStore = {
    putPpf: async record => { void record; },
    getPpf: async () => null,
    putAlphaTrace: async record => { void record; },
    listAlphaTraces: async () => []
  };

  selfRewrite: SelfRewriteStore = {
    putEpisode: async record => { void record; },
    putPatch: async record => { void record; },
    listEpisodes: async () => [],
    listPatches: async () => []
  };

  async init(): Promise<void> {}
  async migrate(): Promise<void> {}
  async verify(): Promise<{ ok: boolean; tables: string[]; errors: string[] }> {
    return { ok: true, tables: [], errors: [] };
  }
  async stats(): Promise<JsonValue> {
    return this.snapshot();
  }
  async close(): Promise<void> {}

  failNextBrainActivation(): void {
    this.failActivation = true;
  }

  snapshot(): JsonValue {
    return {
      events: this.eventsRows.length,
      sources: this.sourceVersions.size,
      evidence: this.evidenceSpans.length,
      nodes: this.nodes.size,
      edges: this.edges.size,
      hyperedges: this.hyperedges.size,
      ngramObservations: this.ngramObservations.length,
      ngramModels: this.ngramModels.length,
      languageUnits: this.languageUnits.length,
      languagePatterns: this.languagePatterns.length,
      semanticFrames: this.semanticFrames.length,
      ledger: this.ledger.size
    };
  }

  graphNodes(): GraphSlice["nodes"] {
    return [...this.nodes.values()];
  }

  graphEdges(): GraphSlice["edges"] {
    return [...this.edges.values()];
  }

  private graphSlice(query: GraphSliceQuery): GraphSlice {
    return {
      nodes: this.graphNodes().slice(0, query.limitNodes ?? 1000),
      edges: this.graphEdges().slice(0, query.limitEdges ?? 1000),
      hyperedges: [...this.hyperedges.values()],
      bounded: true,
      query
    };
  }

  private searchEvidence(query: EvidenceQuery): EvidenceSearchResult[] {
    return this.evidenceSpans
      .filter(span => !query.sourceVersionId || span.sourceVersionId === query.sourceVersionId)
      .filter(span => !query.text || span.text.includes(query.text))
      .filter(span => query.status === "any" || span.status === (query.status ?? "promoted"))
      .slice(0, query.limit ?? 32)
      .map(span => ({ span, score: 1, reason: "memory-evidence-match" }));
  }

  private ledgerRows(query: Parameters<BrainImportStore["listLedger"]>[0]): BrainImportLedgerRecord[] {
    return [...this.ledger.values()]
      .filter(row => !query?.importRunId || row.importRunId === query.importRunId)
      .filter(row => !query?.forceClass || row.forceClass === query.forceClass)
      .sort((a, b) => b.importedAt - a.importedAt || a.sectionId.localeCompare(b.sectionId))
      .slice(0, query?.limit ?? 1000);
  }

  private async summarizeLedger(query: Parameters<BrainImportStore["summarize"]>[0]): Promise<BrainImportSummary> {
    const rows = this.ledgerRows(query);
    const runs = new Map<string, BrainImportSummary["runs"][number]>();
    for (const row of rows) {
      const current = runs.get(row.importRunId) ?? {
        importRunId: row.importRunId,
        brainVersion: row.brainVersion,
        rootPath: row.rootPath,
        importedAt: row.importedAt,
        rows: 0,
        forceClasses: {},
        rowCounts: {},
        warnings: []
      };
      current.rows++;
      current.importedAt = Math.max(current.importedAt, row.importedAt);
      current.forceClasses[row.forceClass] = (current.forceClasses[row.forceClass] ?? 0) + 1;
      for (const [key, value] of Object.entries(row.rowCounts)) current.rowCounts[key] = (current.rowCounts[key] ?? 0) + value;
      current.warnings = [...new Set([...current.warnings, ...row.warnings])];
      runs.set(row.importRunId, current);
    }
    const importedLanguagePriorCount = rows
      .filter(row => row.forceClass === "learned_language_prior")
      .reduce((sum, row) => sum + countLanguageRows(row.rowCounts), 0);
    const importedGraphPriorCount = rows
      .filter(row => row.forceClass === "learned_concept_prior")
      .reduce((sum, row) => sum + countGraphRows(row.rowCounts), 0);
    const importedProgramPriorCount = rows
      .filter(row => row.forceClass === "learned_program_prior")
      .reduce((sum, row) => sum + countLanguageRows(row.rowCounts), 0);
    return {
      activeBrainVersion: this.activeBrain?.activeBrainVersion,
      activeImportRunIds: this.activeBrain?.activeImportRunIds ?? [],
      importedLanguagePriorCount,
      importedGraphPriorCount,
      importedDirectEvidenceCount: rows.filter(row => row.forceClass === "direct_evidence").reduce((sum, row) => sum + (row.rowCounts.evidence_spans ?? 0), 0),
      profileExcerptEvidenceCount: rows.filter(row => row.forceClass === "profile_excerpt_evidence").reduce((sum, row) => sum + (row.rowCounts.evidence_spans ?? 0), 0),
      importedLearnedPriorCount: importedLanguagePriorCount + importedGraphPriorCount + importedProgramPriorCount,
      importedProgramPriorCount,
      unknownPriorCount: rows.filter(row => row.forceClass === "unknown_prior").length,
      runs: [...runs.values()].sort((a, b) => b.importedAt - a.importedAt).slice(0, query?.limit ?? 24)
    };
  }

  private upsert<T>(rows: T[], value: T, key: (value: T) => string): void {
    const id = key(value);
    const index = rows.findIndex(row => key(row) === id);
    if (index >= 0) rows[index] = value;
    else rows.push(value);
  }

  private filterBySource<T extends { metadata?: JsonValue; modelJson?: JsonValue; patternJson?: JsonValue; frameJson?: JsonValue }>(rows: readonly T[], sourceSystem: string | undefined): T[] {
    if (!sourceSystem) return [...rows];
    return rows.filter(row => rowSourceSystem(row) === sourceSystem);
  }
}

class MemoryBlobStore implements BlobStore {
  private readonly rows = new Map<string, Uint8Array>();

  constructor(private readonly digest: (input: string | Uint8Array) => string) {}

  async put(content: Uint8Array, mediaType: string): Promise<ContentHash> {
    void mediaType;
    const hash = `sha256_${this.digest(content)}` as ContentHash;
    this.rows.set(hash, content);
    return hash;
  }

  async get(hash: ContentHash): Promise<Uint8Array> {
    return this.rows.get(hash) ?? new Uint8Array();
  }

  async exists(hash: ContentHash): Promise<boolean> {
    return this.rows.has(hash);
  }
}

function rowSourceSystem(row: { metadata?: JsonValue; modelJson?: JsonValue; patternJson?: JsonValue; frameJson?: JsonValue }): string | undefined {
  for (const value of [row.metadata, row.modelJson, row.patternJson, row.frameJson]) {
    const record = jsonRecord(value);
    if (typeof record.sourceSystem === "string") return record.sourceSystem;
  }
  return undefined;
}

function countLanguageRows(rowCounts: Record<string, number>): number {
  return (rowCounts.language_units ?? 0) + (rowCounts.language_patterns ?? 0) + (rowCounts.ngram_observations ?? 0) + (rowCounts.ngram_models ?? 0) + (rowCounts.semantic_frames ?? 0);
}

function countGraphRows(rowCounts: Record<string, number>): number {
  return (rowCounts.graph_nodes ?? 0) + (rowCounts.graph_edges ?? 0) + (rowCounts.graph_hyperedges ?? 0);
}

function forbiddenTerm(left: readonly number[], right: readonly number[]): string {
  return `${String.fromCharCode(...left)} ${String.fromCharCode(...right)}`;
}
