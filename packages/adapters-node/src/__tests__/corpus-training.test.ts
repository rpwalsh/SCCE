// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { getFixtureLanguagePatternProjection, replaceFixtureLanguagePatternProjection } from "../../../kernel/src/__tests__/language-pattern-projection-fixture.js";
import { readFileSync } from "node:fs";
const humanCreativePair = JSON.parse(readFileSync(new URL("../../../kernel/src/__tests__/fixtures/dolly-human-creative-pair.json", import.meta.url), "utf8")) as { text: string };
import { CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA } from "../../../kernel/src/language-construction-memory.js";
import { compileCreativeRequestFrameFromCompatibilityModels } from "../../../kernel/src/creative-event-compatibility.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  corpusRegistryEntriesFromConfig,
  trainDialogueCorpus,
  trainGutenbergCorpus,
  trainLanguageCorpusText,
  trainOssCorpus,
  trainStoredCorpusConstructions,
  validateConfig,
  type ScceRuntimeConfig
} from "../index.js";
import { canonicalCorpusSourceSystemId, createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine, createLanguageMemoryRuntime, inductionCharBudget, resolveEvidenceSourceIdentity, CORPUS_ROLE_IDS, COGNITIVE_OPERATOR_IDS, hydrateLanguageConstructionPatterns, isLanguageConstructionPattern, requestCommunicativeActModelFromPatterns, classifyRequestCommunicativeAct, codeModelsFromRecords, generateLearnedCodeRepairs, createMouth, createCorrectionMemory, createSemanticEntailmentEngine, codeIntentFromDocumentation, sourceOwnedBehaviorRequirementsFromDocumentation, programIntentForTurn, codeRequestSignal, evaluateProgramExpression, featureSet, searchProgramTransformations, createScceKernel, withSurfaceContract, toJsonValue, DEFAULT_NGRAM_SETTINGS, type FieldState } from "@scce/kernel";
import { compilationArtifactIds } from "../../../kernel/src/__tests__/owned-source-fixture.js";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { compileSourceCodeFunctions } from "../source-code-function-learning.js";
import { NodeBuildTestAdapter } from "../process.js";
import { SOURCE_CONSTRUCTION_CONTEXT_RECIPE_ID } from "@scce/kernel";
import { SURFACE_REALIZATION_STRATEGY_IDS } from "../../../kernel/src/surface-contract.js";
import { prepareLanguageCorpusTraining, commitLanguageCorpusTraining, readCompletedCorpusCheckpoint, corpusSourceVersionIdFor, LANGUAGE_CORPUS_TRAINING_RECIPE_ID, LANGUAGE_CODE_CORPUS_TRAINING_RECIPE_ID, languageCorpusTrainingRecipeId, type LanguageCorpusTrainingInput } from "../language-corpus-trainer.js";
import { LANGUAGE_TRAINING_BATCH_RECIPE_ID } from "../../../kernel/src/language-training-recipe.js";
import { blobContentHash } from "../postgres.js";
import { createWikipediaV3Ingestor } from "../wikipedia-v3-ingestor.js";
import * as corpusTrainer from "../language-corpus-trainer.js";
import { MIN_WIKIPEDIA_MAX_ARTICLE_CHARS } from "../config.js";
import { INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID } from "../../../kernel/src/language-induction-memory.js";
import { LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA } from "../../../kernel/src/language-construction-memory.js";
import { SOURCE_CONSTRUCTION_BINDINGS_COMPONENT_RECIPE_ID } from "../../../kernel/src/language-construction-memory.js";
import { SOURCE_ENTITY_GRAPH_COMPONENT_RECIPE_ID } from "../corpus-source-graph-projection.js";
import * as languageInduction from "../../../kernel/src/language-induction.js";
import * as kernelPrimitives from "../../../kernel/src/primitives.js";
import { primeLearnedAnswerUnitForms } from "../../../kernel/src/learned-answer-unit-forms.js";
import { requestUnitMatchesSurface } from "../../../kernel/src/local-evidence-runtime.js";
import { scopeLanguageMemoryStateToLanguage } from "../../../kernel/src/language-memory-runtime.js";
import { conversationalSession } from "../../../kernel/src/__tests__/conversational-session-fixture.js";
import { requestFeatures } from "../../../kernel/src/request-requirement-learning.js";
import { CORPUS_SOURCE_SYSTEM_IDS } from "../../../kernel/src/corpus-registry.js";
import { REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM } from "../../../kernel/src/request-communicative-act.js";
import type {
  EvidenceSpan,
  GraphNode,
  GraphSnapshot,
  Hyperedge,
  InformationLabel,
  IngestionCheckpoint,
  JsonValue,
  LanguagePatternRecord,
  LanguageProfile,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  ScceEvent,
  ScceStorage,
  SemanticFrameRecord,
  SourceVersion,
  SourceVersionId
} from "@scce/kernel";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("learned rows carry the shard's provenance once", () => {
  it("recompiles derived callable semantics on a component upgrade without rejecting unchanged source bytes", async () => {
    const fixture = memoryStorage();
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); }, get: async id => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    const text = "export function observed(value: number) { return value + 1; }";
    const sourceHash = createHasher().digestHex(text);
    const metadata = { sourceHash, formalLanguage: "typescript" };
    const input = { storage: fixture.storage, sourceSystem: "oss_code", sourceUri: "fixture://callable-component/source.ts", streamUri: "oss_code:source.ts", text,
      informationLabel: publicCorpusInformationLabel, skipNgramObservationPersistence: true, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      corpusCheckpoint: { rootUri: "fixture://callable-component", itemUri: "source.ts", contentHash: sourceHash, byteLength: Buffer.byteLength(text) } };
    await trainLanguageCorpusText({ ...input, corpusMetadata: { ...metadata, codeFunctionConstructions: [] } });
    const checkpoint = [...checkpoints.values()][0]!;
    const oldMetadata = recordOf(checkpoint.metadata);
    checkpoint.metadata = { ...oldMetadata, componentRecipes: { ...recordOf(oldMetadata.componentRecipes), sourceCodeFunctions: "retired.compiler" } };
    const constructions = compileSourceCodeFunctions({ text, path: "source.ts", languageId: "typescript", sourceHash });
    expect(constructions).toHaveLength(1);
    await trainLanguageCorpusText({ ...input, corpusMetadata: toJsonValue({ ...metadata, codeFunctionConstructions: constructions }) });
    expect(checkpoints.size).toBe(1);
    expect(fixture.state.patterns.filter(row => row.patternKind === "source_code_function")).toHaveLength(1);
  });
  it("publishes source callable replacements and retires the callable set when recompilation learns none", async () => {
    const root = await tempDir("oss-callable-projection-");
    const file = path.join(root, "source.ts");
    const fixture = memoryStorage();
    const publications: Parameters<NonNullable<ScceStorage["languageMemory"]["replaceLanguagePatternProjection"]>>[0][] = [];
    fixture.storage.languageMemory.replaceLanguagePatternProjection = async input => {
      publications.push(structuredClone(input));
      await replaceFixtureLanguagePatternProjection.call(fixture.storage.languageMemory, input);
    };
    const options = { storage: fixture.storage, rootPath: root, maxFiles: 2, includeDocs: false, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 };
    await writeFile(file, "export function original(value: number) { return value + 1; }");
    await trainOssCorpus(options);
    await writeFile(file, "export function revised(value: number) { return value * 2; }");
    await trainOssCorpus(options);
    await writeFile(file, "export function sideEffect(value: number) { console.log(value); return value; }");
    await trainOssCorpus(options);
    expect(publications).toHaveLength(6);
    const callablePublications = publications.filter(row => row.projection.patternSchema === "scce.source_code_function_pattern.v1");
    const assertionPublications = publications.filter(row => row.projection.patternSchema === "scce.source_owned_test_contract.v1");
    expect(callablePublications).toHaveLength(3);
    expect(assertionPublications).toHaveLength(3);
    expect(new Set(publications.map(row => row.projection.sourceId)).size).toBe(1);
    expect(new Set(publications.map(row => row.projection.sourceVersionId)).size).toBe(3);
    expect(callablePublications.map(row => row.projection.patternIds.length)).toEqual([1, 1, 0]);
    expect(assertionPublications.map(row => row.projection.patternIds)).toEqual([[], [], []]);
    for (const row of callablePublications) expect(row.projection.patternIds).toEqual(row.patterns.filter(pattern => pattern.patternKind === "source_code_function").map(pattern => pattern.id).sort());
  });
  it("projects real lowercase source relations using the canonical batch's one prepared model", async () => {
    const fixture = memoryStorage();
    const observations: Awaited<ReturnType<NonNullable<ScceStorage["relationObservations"]>["list"]>> = [];
    fixture.storage.relationObservations = { list: async () => observations, put: async rows => { observations.push(...rows); } };
    const engine = vi.spyOn(languageInduction, "createLanguageInductionEngine");
    try {
      await trainLanguageCorpusText({ storage: fixture.storage, sourceSystem: "gutenberg", sourceUri: "fixture://lowercase-entity", streamUri: "fixture://lowercase-entity",
        text: "ada visited london. ada visited paris. ada visited berlin. ada visited madrid. eve visited london. eve visited paris. eve visited berlin. eve visited madrid.",
        createdAt: 1700000000000, skipNgramObservationPersistence: true, informationLabel: publicCorpusInformationLabel });
      expect(engine).toHaveBeenCalledTimes(1);
      expect(observations.filter(row => row.channel === "weak_free_surface").length).toBeGreaterThan(0);
      expect(observations.every(row => fixture.state.sourceVersions.some(source => source.sourceId === row.sourceId))).toBe(true);
      expect(fixture.state.patterns.some(row => recordOf(row.patternJson).schema === "scce.induced_language_model.semantic_memory.v1")).toBe(true);
    } finally { engine.mockRestore(); }
  });

  it.each([{ sourceSystem: "oss_code", languageOnly: false }, { sourceSystem: "gutenberg", languageOnly: true }])(
    "does not invoke a natural creative compiler for $sourceSystem languageOnly=$languageOnly", async mode => {
      const fixture = memoryStorage();
      const compile = vi.fn(() => { throw new Error("natural compiler must remain outside this source role"); });
      await trainLanguageCorpusText({ storage: fixture.storage, ...mode, sourceUri: `fixture://dispatch/${mode.sourceSystem}`, streamUri: `fixture://dispatch/${mode.sourceSystem}`,
        text: "export const value = 1;", informationLabel: publicCorpusInformationLabel, creativeEventCompiler: { id: "fixture.natural.compiler", compile }, skipNgramObservationPersistence: true });
      expect(compile).not.toHaveBeenCalled();
      expect(fixture.state.models).toHaveLength(1);
      expect(fixture.state.patterns.some(row => recordOf(row.patternJson).componentRecipe === INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID)).toBe(false);
    });

  it("learns scoped forms from raw source and upgrades only the projection component without duplicating models", async () => {
    const fixture = memoryStorage();
    const activeProjectionWrites: Array<NonNullable<ScceStorage["languageMemory"]["replaceLanguagePatternProjection"]> extends (input: infer T) => Promise<void> ? T : never> = [];
    const upsert = <T extends { id: string }>(target: T[], rows: readonly T[]) => {
      for (const row of rows) { const index = target.findIndex(prior => prior.id === row.id); if (index < 0) target.push(row); else target[index] = row; }
    };
    fixture.storage.languageMemory.putNgramModels = async rows => { upsert(fixture.state.models, rows); };
    fixture.storage.languageMemory.putLanguageUnits = async rows => { upsert(fixture.state.units, rows); };
    fixture.storage.languageMemory.putLanguagePatterns = async rows => { upsert(fixture.state.patterns, rows); };
    fixture.storage.languageMemory.replaceLanguagePatternProjection = async input => {
      activeProjectionWrites.push(structuredClone(input));
      await replaceFixtureLanguagePatternProjection.call(fixture.storage.languageMemory, input);
    };
    fixture.storage.languageMemory.putSemanticFrames = async rows => { upsert(fixture.state.frames, rows); };
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); }, get: async id => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    const text = "walla r0. wallawalla r0. tinu r0. tinutinu r0. kobo r0. kobokobo r0. cat chased mouse. dog chased ball. cat chased ball. dog chased mouse. cat chased. dog chased.";
    const evidence = corpusEvidenceSpan("raw-forms", text, 0);
    const profile = createLanguageAcquisitionEngine({ idFactory: corpusTestIds }).acquire({ sourceVersionId: evidence.sourceVersionId, text, createdAt: 1700000000000 });
    const graphNodes: GraphNode[] = [];
    const relationFacts: Hyperedge[] = [];
    const addFact = (name: string, subject: string, object?: string) => {
      const subjectId = `node.${name}.subject`;
      graphNodes.push({ id: subjectId as GraphNode["id"], representation: { surface: subject }, typeId: "type.entity" as GraphNode["typeId"],
        alpha: 1, evidenceIds: [evidence.id], features: [], createdAt: 1700000000000, updatedAt: 1700000000000, metadata: {} });
      const participantPorts: Hyperedge["participantPorts"] = [{ nodeId: subjectId as Hyperedge["participantPorts"][number]["nodeId"],
        portId: "role.agent", roleId: "role.agent", valueKind: "entity.person", realization: "observed", evidenceIds: [evidence.id] }];
      const memberNodeIds: Hyperedge["memberNodeIds"] = [subjectId as Hyperedge["memberNodeIds"][number]];
      if (object !== undefined) {
        const objectId = `node.${name}.object`;
        graphNodes.push({ id: objectId as GraphNode["id"], representation: { surface: object }, typeId: "type.entity" as GraphNode["typeId"],
          alpha: 1, evidenceIds: [evidence.id], features: [], createdAt: 1700000000000, updatedAt: 1700000000000, metadata: {} });
        participantPorts.push({ nodeId: objectId as Hyperedge["participantPorts"][number]["nodeId"], portId: "role.patient", roleId: "role.patient",
          valueKind: "entity.object", realization: "observed", evidenceIds: [evidence.id] });
        memberNodeIds.push(objectId as Hyperedge["memberNodeIds"][number]);
      } else participantPorts.push({ nodeId: null, portId: "role.patient", roleId: "role.patient", valueKind: "entity.object", realization: "omitted", evidenceIds: [evidence.id] });
      relationFacts.push({ schema: "scce.hyperedge.v2", id: `fact.${name}` as Hyperedge["id"], relationId: "relation.chase" as Hyperedge["relationId"],
        participantPorts, memberNodeIds, qualifiers: {}, modality: { extractionChannel: "source_declared_structured" }, evidenceIds: [evidence.id], weightVector: {}, temporalScope: {}, provenanceRefs: [],
        createdAt: 1700000000000, updatedAt: 1700000000000 });
    };
    addFact("cat-mouse", "cat", "mouse"); addFact("dog-ball", "dog", "ball"); addFact("cat-ball", "cat", "ball"); addFact("dog-mouse", "dog", "mouse");
    addFact("cat-request", "cat"); addFact("dog-request", "dog");
    const graphSnapshotAdditions: GraphSnapshot = { nodes: graphNodes, edges: [], hyperedges: relationFacts };
    const input = { storage: fixture.storage, sourceSystem: "gutenberg", sourceUri: "fixture://raw-forms", streamUri: "fixture://raw-forms", text, createdAt: 1700000000000,
      ngramMaxOrder: 3, skipNgramObservationPersistence: true, informationLabel: publicCorpusInformationLabel,
      sourceVersionId: evidence.sourceVersionId, evidence: [evidence], profile, graphSnapshotAdditions,
      corpusCheckpoint: { rootUri: "fixture://raw-forms", itemUri: "forms.txt", contentHash: blobContentHash(Buffer.from(text)), byteLength: Buffer.byteLength(text) } };
    await trainLanguageCorpusText(input);
    expect(activeProjectionWrites).toHaveLength(1);
    expect(activeProjectionWrites[0]!.projection.componentRecipe).toBe(LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID);
    expect(activeProjectionWrites[0]!.projection.patternIds).toEqual(fixture.state.patterns
      .filter(row => recordOf(row.patternJson).schema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA).map(row => row.id).sort());
    const morphology = fixture.state.patterns.filter(row => recordOf(row.patternJson).schema === "scce.induced_language_model.morphology_memory.v1");
    expect(morphology).toHaveLength(1);
    expect(recordOf(morphology[0]!.patternJson).componentRecipe).toBe(INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID);
    const learnedNullPattern = fixture.state.patterns.find(row => {
      if (!isConstructionBundle(row)) return false;
      const bundle = recordOf(row.patternJson).bundle as { sourceExamples?: Array<{ nullRoles?: Array<{ graphBinding?: { roleId?: string } }> }> };
      return bundle.sourceExamples?.some(example => example.nullRoles?.some(role => role.graphBinding?.roleId === "role.patient")) ?? false;
    });
    expect(learnedNullPattern).toBeDefined();
    const stalePatternJson = structuredClone(learnedNullPattern!.patternJson) as Record<string, unknown>;
    const staleBundle = stalePatternJson.bundle as { sourceExamples: Array<{ nullRoles?: Array<{ graphBinding?: { roleId?: string } }> }> };
    for (const example of staleBundle.sourceExamples) for (const role of example.nullRoles ?? []) {
      if (role.graphBinding?.roleId === "role.patient") delete role.graphBinding;
    }
    const staleIndex = fixture.state.patterns.findIndex(row => row.id === learnedNullPattern!.id);
    fixture.state.patterns[staleIndex] = { ...learnedNullPattern!, patternJson: stalePatternJson as JsonValue };
    const runtime = createLanguageMemoryRuntime({ hasher: corpusTestHasher, idFactory: corpusTestIds });
    const state = scopeLanguageMemoryStateToLanguage(runtime.hydrate({ models: fixture.state.models, units: fixture.state.units, patterns: fixture.state.patterns,
      semanticFrames: fixture.state.frames, constructionEvidence: fixture.state.evidence }), "language.raw", { profile: () => "language.raw", corpus: () => "language.raw" });
    primeLearnedAnswerUnitForms({ deltas: state.structuralDeltas ?? [], profileIds: new Set(state.importedPatterns.map(row => row.profileId)) });
    try {
      expect(requestUnitMatchesSurface("walla", "wallawalla")).toBe(true);
      expect(requestUnitMatchesSurface("wallawalla", "wallawallb")).toBe(false);
    } finally { primeLearnedAnswerUnitForms({ deltas: [], profileIds: new Set() }); }
    const before = structuredClone({ models: fixture.state.models, units: fixture.state.units, frames: fixture.state.frames, patterns: fixture.state.patterns });
    const beforePatternIds = before.patterns.map(row => row.id).sort();
    const checkpoint = [...checkpoints.values()][0]!;
    const metadata = { ...recordOf(checkpoint.metadata) };
    delete (metadata.componentRecipes as Record<string, JsonValue>).sourceConstructionProjection;
    checkpoints.set(checkpoint.id, { ...checkpoint, metadata });
    const writesBeforeUpgrade = fixture.state.events.length;
    const upgraded = await trainLanguageCorpusText(input);
    expect(activeProjectionWrites).toHaveLength(2);
    expect(activeProjectionWrites[1]!.projection.sourceId).toBe(activeProjectionWrites[0]!.projection.sourceId);
    expect(upgraded.artifacts.ngramModelIds).toEqual(before.models.map(row => row.id));
    expect(fixture.state.events.length).toBeGreaterThan(writesBeforeUpgrade);
    expect(fixture.state.models).toEqual(before.models);
    expect(fixture.state.units).toEqual(before.units);
    expect(fixture.state.frames).toEqual(before.frames);
    expect(fixture.state.patterns.find(row => row.id === learnedNullPattern!.id)?.patternJson).not.toEqual(stalePatternJson);
    const repaired = fixture.state.patterns.filter(isConstructionBundle).some(row => {
      const bundle = recordOf(row.patternJson).bundle as { sourceExamples?: Array<{ nullRoles?: Array<{ graphBinding?: { roleId?: string } }> }> };
      return bundle.sourceExamples?.some(example => example.nullRoles?.some(role => role.graphBinding?.roleId === "role.patient")) ?? false;
    });
    expect(repaired).toBe(true);
    expect(fixture.state.patterns.map(row => row.id).sort()).toEqual(beforePatternIds);
    expect(fixture.state.patterns.some(row => row.id === learnedNullPattern!.id)).toBe(true);
    expect(checkpoints.size).toBe(1);
    expect([...checkpoints.values()][0]!.id).toBe(checkpoint.id);
    expect(recordOf([...checkpoints.values()][0]!.metadata).componentRecipes).toEqual({ inducedLanguageMemory: INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
      sourceConstructionProjection: LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID,
      sourceConstructionBindings: SOURCE_CONSTRUCTION_BINDINGS_COMPONENT_RECIPE_ID, sourceEntityGraph: SOURCE_ENTITY_GRAPH_COMPONENT_RECIPE_ID,
      constructionContext: SOURCE_CONSTRUCTION_CONTEXT_RECIPE_ID });
    const writes = fixture.state.events.length;
    await trainLanguageCorpusText(input);
    expect(activeProjectionWrites).toHaveLength(2);
    expect(fixture.state.events).toHaveLength(writes);
    expect(fixture.state.models.map(row => row.id)).toEqual(before.models.map(row => row.id));
  });
  it("keeps actual corpus CLI and manual training on one canonical model identity", async () => {
    const root = await tempDir("oss-canonical-training-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "owned.ts"), "export function combine(left: number, right: number): number { return left + right; }");
    const fixture = memoryStorage();
    const options = { storage: fixture.storage, rootPath: root, maxFiles: 2, includeDocs: false,
      ngramMaxOrder: DEFAULT_NGRAM_SETTINGS.maxOrder, ngramMaxCountersPerOrder: 12000, ngramVocabularyLimit: 24000 };
    const trained = await trainOssCorpus(options);
    expect(trained.filesSkipped).toEqual([]);
    expect(fixture.state.models).toHaveLength(1);
    const original = structuredClone(fixture.state.models[0]!);
    let modelWrites = 0;
    fixture.storage.languageMemory.putNgramModel = async row => {
      modelWrites++;
      const prior = fixture.state.models.findIndex(model => model.id === row.id);
      if (prior >= 0) fixture.state.models[prior] = { ...row, modelJson: { ...recordOf(fixture.state.models[prior]!.modelJson), ...recordOf(row.modelJson) } };
      else fixture.state.models.push(row);
    };
    fixture.storage.languageMemory.listNgramModels = async query => fixture.state.models.filter(row => (!query?.sourceSystem || recordOf(row.modelJson).sourceSystem === query.sourceSystem)
      && (!query?.profileIds?.length || query.profileIds.includes(String(recordOf(row.modelJson).profileId))));
    const clock = createClock({ fixedTime: 120000, stepMs: 1 });
    const hasher = createHasher();
    const recorded = storageFixtureForEvaluation({ evidence: fixture.state.evidence, clockNow: () => clock.now() });
    const storage: ScceStorage = { ...recorded.storage, languageMemory: fixture.storage.languageMemory,
      evidence: { ...recorded.storage.evidence, sourceVersionsForEvidence: async ids => fixture.state.sourceVersions.filter(source => fixture.state.evidence.some(span => ids.includes(span.id) && span.sourceVersionId === source.sourceVersionId)) },
      blobs: { ...fixture.storage.blobs, get: async hash => { const bytes = fixture.state.blobs.find(bytes => blobContentHash(bytes) === hash); if (!bytes) throw new Error("canonical test source missing"); return bytes; } },
      transaction: fixture.storage.transaction, model: { ...fixture.storage.model,
        readModel: async () => ({ languageProfiles: fixture.state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }) } };
    const kernel = createScceKernel({ storage, clock, idFactory: createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "manual-kernel-producer" }), deterministicReplay: true,
      files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw new Error("no alternate compiler producer"); } } });
    const result = await kernel.train({ config: { learningGoals: [], promotion: { minTrust: 0.45 } } });
    expect(result.promotedEvidence).toBeGreaterThan(0);
    expect(modelWrites).toBe(0);
    expect(fixture.state.models).toHaveLength(1);
    expect(fixture.state.models[0]!.id).toBe(original.id);
    expect(fixture.state.models[0]!.modelJson).toEqual(original.modelJson);
    for (const key of ["formalLanguage", "sourceHash", "relativePath", "sourceUri"]) {
      expect(recordOf(fixture.state.models[0]!.modelJson)[key]).toEqual(recordOf(original.modelJson)[key]);
    }
    expect(await storage.languageMemory.listNgramModels({ sourceSystem: "oss_code" })).toHaveLength(1);
    expect(fixture.state.observations).toEqual([]);
  });

  it("reuses the exact full-source chunk and artifact set for multi-span nondefault compilation", async () => {
    const fixture = memoryStorage();
    const text = ("Amber records preserve river measurements before the first calibration. "
      + "Cobalt observations describe valley readings after the second inspection.\n\n").repeat(1100);
    const result = await trainLanguageCorpusText({ storage: fixture.storage, sourceSystem: "gutenberg", streamUri: "fixture://full-source-compiled",
      sourceUri: "fixture://full-source-compiled", text, createdAt: 1700000000000, informationLabel: publicCorpusInformationLabel,
      maxEvidenceChunkBytes: 4096, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 11,
      languageOnly: true, skipNgramObservationPersistence: true });
    expect(fixture.state.evidence.length).toBeGreaterThan(1);
    expect(fixture.state.models.length).toBeGreaterThan(1);
    expect(fixture.state.units.length).toBeGreaterThan(0);
    expect(fixture.state.patterns.length).toBeGreaterThan(0);
    expect(fixture.state.frames.length).toBeGreaterThan(0);
    const before = structuredClone({ models: fixture.state.models, units: fixture.state.units, patterns: fixture.state.patterns, frames: fixture.state.frames, profiles: fixture.state.profiles });
    expect(recordOf(recordOf(before.models[0]!.modelJson).sourceCompilation).options).toMatchObject({ maxOrder: 2, maxCountersPerOrder: 64, vocabularyLimit: 11, languageOnly: true });
    const clock = createClock({ fixedTime: 130000, stepMs: 1 });
    const hasher = createHasher();
    const selected = fixture.state.evidence.slice(1, 2);
    const recorded = storageFixtureForEvaluation({ evidence: selected, clockNow: () => clock.now() });
    const storage: ScceStorage = { ...recorded.storage, languageMemory: fixture.storage.languageMemory, transaction: fixture.storage.transaction,
      evidence: { ...recorded.storage.evidence, sourceVersionsForEvidence: async () => fixture.state.sourceVersions.filter(source => source.sourceVersionId === result.sourceVersionId) },
      blobs: { ...fixture.storage.blobs, get: async hash => { const bytes = fixture.state.blobs.find(bytes => blobContentHash(bytes) === hash); if (!bytes) throw new Error("canonical source missing"); return bytes; } },
      inducedLanguageModels: { putModel: async () => { throw new Error("canonical replay must not reproject induced artifacts"); }, readById: async () => undefined, listRecent: async () => [] },
      model: { ...fixture.storage.model, readModel: async () => ({ languageProfiles: fixture.state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }) } };
    const kernel = createScceKernel({ storage, clock, idFactory: createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "manual-nondefault-producer" }), deterministicReplay: true,
      sourceInformationLabel: publicCorpusInformationLabel, files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw new Error("no alternate producer"); } } });
    const input = { config: { learningGoals: [], promotion: { minTrust: 0.45 } } };
    const trained = await kernel.train(input);
    expect(trained.promotedEvidence).toBeGreaterThan(0);
    expect({ models: fixture.state.models, units: fixture.state.units, patterns: fixture.state.patterns, frames: fixture.state.frames, profiles: fixture.state.profiles }).toEqual(before);
    const promoted = recorded.events.filter(event => event.typeId === "LearningPromoted").at(-1);
    expect(recordOf(recordOf(promoted?.payload).trainingLanguage).reusedModels).toBe(before.models.length);
    const partial = fixture.state.models.pop()!;
    await expect(kernel.train(input)).rejects.toThrow("canonical source compilation model inventory");
    fixture.state.models.push(partial);
    const first = fixture.state.models[0]!;
    fixture.state.models[0] = { ...first, modelJson: { ...recordOf(first.modelJson), compact: { changed: true } } };
    await expect(kernel.train(input)).rejects.toThrow("canonical source compilation model inventory");
    fixture.state.models[0] = first;
    for (const family of ["units", "patterns", "frames"] as const) {
      const index = family === "patterns" ? fixture.state.patterns.findIndex(row => row.patternKind !== "source_compilation") : fixture.state[family].length - 1;
      const removed = fixture.state[family].splice(index, 1)[0]!;
      await expect(kernel.train(input)).rejects.toThrow("artifact inventory");
      (fixture.state[family] as Array<typeof removed>).splice(index, 0, removed);
    }
    const allModels = fixture.state.models.splice(0);
    await expect(kernel.train(input)).rejects.toThrow("canonical source compilation model inventory");
    fixture.state.models.push(...allModels);
  });

  it.each(["local", "git"])("keeps unchanged file learning stable across a %s snapshot update", async kind => {
    const root = await tempDir("oss-incremental-");
    await mkdir(path.join(root, "src"), { recursive: true });
    const a = "// Combine the first reading.\nexport function first(left: number, right: number): number { return left + right; }";
    const b = "// Compare the second reading.\nexport function second(left: number, right: number): number { return left - right; }";
    await writeFile(path.join(root, "src", "a.ts"), a);
    await writeFile(path.join(root, "src", "b.ts"), b);
    const fixture = memoryStorage();
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); },
      get: async id => checkpoints.get(id) ?? null, list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    const provenance = (commit: string, texts: { a: string; b: string }) => ({ remoteUrl: "https://github.com/example/incremental.git",
      commitSha: commit.repeat(40), snapshotHash: createHasher().digestHex(texts.a + texts.b),
      fileHashes: { "src/a.ts": createHasher().digestHex(texts.a), "src/b.ts": createHasher().digestHex(texts.b) } });
    const options = { storage: fixture.storage, rootPath: root, maxFiles: 5, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 };
    const first = await trainOssCorpus({ ...options, ...(kind === "git" ? { repositoryProvenance: provenance("a", { a, b }) } : {}) });
    expect(first.filesSkipped).toEqual([]);
    expect(fixture.state.models).toHaveLength(4);
    const bHash = blobContentHash(Buffer.from(b));
    const bRows = () => Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key,
      rows.filter((row: unknown) => JSON.stringify(row).includes(bHash))]));
    const unchanged = structuredClone(bRows());
    const originalOwners = fixture.state.sourceVersions.filter(row => recordOf(row.metadata).relativePath === "src/a.ts").map(row => row.sourceId);
    const changedA = a.replace("left + right", "left * right");
    const nextRoot = kind === "git" ? await tempDir("oss-next-snapshot-") : root;
    await mkdir(path.join(nextRoot, "src"), { recursive: true });
    await writeFile(path.join(nextRoot, "src", "a.ts"), changedA);
    await writeFile(path.join(nextRoot, "src", "b.ts"), b);
    const secondOptions = { ...options, rootPath: nextRoot, ...(kind === "git" ? { repositoryProvenance: provenance("b", { a: changedA, b }) } : {}) };
    const second = await trainOssCorpus(secondOptions);
    expect(second.filesSkipped).toEqual([]);
    expect(second.snapshotHash).not.toBe(first.snapshotHash);
    expect(second.sourceUriBase).toBe(first.sourceUriBase);
    expect(bRows()).toEqual(unchanged);
    expect(fixture.state.models).toHaveLength(6);
    expect(fixture.state.models.filter(row => recordOf(row.modelJson).sourceHash === bHash)).toHaveLength(2);
    expect(fixture.state.models.filter(row => recordOf(row.modelJson).sourceHash === blobContentHash(Buffer.from(changedA)))).toHaveLength(2);
    expect(new Set(fixture.state.models.map(row => row.id)).size).toBe(6);
    expect(new Set(fixture.state.sourceVersions.filter(row => recordOf(row.metadata).relativePath === "src/a.ts").map(row => row.sourceId))).toEqual(new Set(originalOwners));
    expect([...checkpoints.values()].filter(row => row.status === "complete")).toHaveLength(6);
    const firstWitness = fixture.state.sourceVersions.find(row => recordOf(row.metadata).sourceHash === bHash);
    expect(recordOf(firstWitness?.metadata).acquisitionProvenance).toEqual(first.acquisitionProvenance);
    expect(fixture.state.sourceVersions.filter(row => recordOf(row.metadata).sourceHash === blobContentHash(Buffer.from(changedA)))
      .every(row => JSON.stringify(recordOf(row.metadata).acquisitionProvenance) === JSON.stringify(second.acquisitionProvenance))).toBe(true);
    const counts = Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]));
    await trainOssCorpus(secondOptions);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(counts);
  });

  it("reaches a compact code construction beyond the style model quota in an actual chat turn", async () => {
    const root = await tempDir("oss-code-population-");
    await mkdir(path.join(root, "src"), { recursive: true });
    for (let index = 0; index < 13; index++) {
      await writeFile(path.join(root, "src", `${String(index).padStart(2, "0")}-other.ts`),
        `export function other${index}(left: number, right: number): number { return left - right; }`);
    }
    await writeFile(path.join(root, "src", "zz-target.ts"), "export function knownAdd(left: number, right: number): number { return left + right; }");
    const fixture = memoryStorage();
    await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 20, includeDocs: false, ngramMaxOrder: 5, ngramMaxCountersPerOrder: 64 });
    expect(fixture.state.models).toHaveLength(14);
    expect(fixture.state.units).toHaveLength(0);
    expect(fixture.state.frames).toHaveLength(0);
    expect(fixture.state.patterns.filter(row => row.patternKind === "source_code_function")).toHaveLength(14);
    expect(fixture.state.patterns.filter(row => row.patternKind === "source_compilation")).toHaveLength(14);
    expect(fixture.state.patterns.every(row => row.patternKind === "source_code_function" || row.patternKind === "source_compilation")).toBe(true);
    const targetModel = fixture.state.models.find(row => recordOf(row.modelJson).relativePath === "src/zz-target.ts")!;
    const targetPattern = fixture.state.patterns.find(row => row.patternKind === "source_code_function"
      && recordOf(row.patternJson).sourceHash === recordOf(targetModel.modelJson).sourceHash)!;
    expect(targetPattern).toBeDefined();
    const modelReads: Array<{ sourceSystem?: string; ids: string[] }> = [];
    const patternReads: Array<NonNullable<Parameters<ScceStorage["languageMemory"]["listLanguagePatterns"]>[0]>> = [];
    const matchesSource = (metadata: JsonValue, expected?: string) => !expected
      || canonicalCorpusSourceSystemId(String(recordOf(metadata).sourceSystem)) === canonicalCorpusSourceSystemId(expected);
    fixture.storage.languageMemory.listNgramModels = async query => {
      const rows = fixture.state.models.filter(row => matchesSource(row.modelJson, query?.sourceSystem)
        && (!query?.profileIds?.length || query.profileIds.includes(String(recordOf(row.modelJson).profileId))));
      const selected = rows.slice(0, query?.limit ?? rows.length);
      modelReads.push({ sourceSystem: query?.sourceSystem, ids: selected.map(row => row.id) });
      return selected;
    };
    let exposeCodePatterns = true;
    fixture.storage.languageMemory.listLanguagePatterns = async query => {
      patternReads.push(query ?? {});
      return fixture.state.patterns.filter(row => matchesSource(row.patternJson, query?.sourceSystem)
        && (!query?.patternKind || row.patternKind === query.patternKind)
        && (!query?.formalLanguage || recordOf(row.patternJson).formalLanguage === query.formalLanguage)
        && (query?.parameterCount === undefined || recordOf(row.patternJson).parameterCount === query.parameterCount)
        && (!query?.profileIds?.length || query.profileIds.includes(row.profileId))
        && (exposeCodePatterns || row.patternKind !== "source_code_function")).slice(0, query?.limit ?? fixture.state.patterns.length);
    };
    const boot = () => {
      const clock = createClock({ fixedTime: 98000, stepMs: 1 });
      const hasher = createHasher();
      const recorded = storageFixtureForEvaluation({ evidence: [], clockNow: () => clock.now() });
      const storage: ScceStorage = { ...recorded.storage, model: { ...fixture.storage.model,
        readModel: async () => ({ languageProfiles: fixture.state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 1 }) },
        userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
        taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
        documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
        languageMemory: fixture.storage.languageMemory };
      return { recorded, kernel: createScceKernel({ storage, clock, idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }), deterministicReplay: true,
        files: { streamPath: async function* () { throw new Error("no workspace request"); } },
        buildTest: { executeProgram: async () => { throw new Error("no compiler-owned generator"); } } }) };
    };
    const request = { text: "TypeScript freshPulse(2,3)=5; freshPulse(-5,8)=3", metadata: { session: { sessionId: "many-model-code", recentTurns: [] } } };
    const active = boot();
    const turn = await active.kernel.turn(request);
    expect(turn.answer).toContain("function freshPulse(");
    expect(turn.answer).toContain("left + right");
    expect(modelReads.some(row => row.ids.length === 12 && !row.ids.includes(targetModel.id))).toBe(true);
    expect(patternReads.some(query => query.patternKind === "source_code_function" && query.formalLanguage === "typescript"
      && query.parameterCount === 2 && !query.profileIds?.length && !query.languageId)).toBe(true);
    const mouth = active.recorded.events.filter(event => event.typeId === "MouthSpoken").at(-1);
    expect(JSON.stringify(mouth?.payload)).toContain(targetPattern.id);
    expect(JSON.stringify(mouth?.payload)).toContain('"sourceRecordKind":"language_pattern"');
    const exports: Record<string, (...args: number[]) => number> = {};
    runInNewContext(ts.transpileModule(turn.answer, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
    expect(exports.freshPulse?.(100.5, 7.25)).toBe(107.75);
    exposeCodePatterns = false;
    const ablated = await boot().kernel.turn(request);
    expect(ablated.answer).not.toContain("function freshPulse(");
  });

  it("binds persisted source assertions from documentation through program planning and held-out execution", async () => {
    const root = await tempDir("oss-source-owned-contract-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "spec"), { recursive: true });
    const sourceText = "/** Increment a value by one. */\nexport function add_one(value: number): number { return value + 1; }\n";
    const testText = [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add_one } from '../src/add-one.js';",
      "test('increments values', () => {",
      "  assert.strictEqual(add_one(1), 2);",
      "  assert.strictEqual(add_one(2), 3);",
      "  assert.strictEqual(add_one(5), 6);",
      "});"
    ].join("\n");
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src/**/*.ts", "spec/**/*.ts"] }));
    await writeFile(path.join(root, "src", "add-one.ts"), sourceText);
    await writeFile(path.join(root, "spec", "add-one.spec.ts"), testText);
    const fixture = memoryStorage();
    const contractProjectionWrites: Parameters<NonNullable<ScceStorage["languageMemory"]["replaceLanguagePatternProjection"]>>[0][] = [];
    const activeContractsBySource = new Map<string, string[]>();
    fixture.storage.languageMemory.replaceLanguagePatternProjection = async input => {
      if (input.projection.patternSchema === "scce.source_owned_test_contract.v1") {
        contractProjectionWrites.push(structuredClone(input));
        const oldIds = new Set(activeContractsBySource.get(input.projection.sourceId) ?? []);
        for (let index = fixture.state.patterns.length - 1; index >= 0; index--) if (oldIds.has(fixture.state.patterns[index]!.id)) fixture.state.patterns.splice(index, 1);
        const ids = input.patterns.map(pattern => pattern.id);
        fixture.state.patterns.push(...input.patterns);
        activeContractsBySource.set(input.projection.sourceId, ids);
        return;
      }
      const upsert = <T extends { id: string }>(target: T[], rows: readonly T[]) => {
        const byId = new Map(target.map(row => [row.id, row])); for (const row of rows) byId.set(row.id, row);
        target.splice(0, target.length, ...byId.values());
      };
      upsert(fixture.state.patterns, input.patterns);
    };
    const report = await trainOssCorpus({ storage: fixture.storage, rootPath: root, sourceUriBase: "scce://assertion-fixture", maxFiles: 20,
      maxFilesPerRun: 20, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    const persisted = fixture.state.patterns.filter(pattern => pattern.patternKind === "source_code_assertion_contract");
    expect(persisted).toHaveLength(1);
    const contract = recordOf(persisted[0]!.patternJson);
    expect(contract).toMatchObject({ schema: "scce.source_owned_test_contract.v1", repositoryFamily: report.sourceUriBase,
      sourcePath: "src/add-one.ts", formalLanguage: "typescript", sourceHash: blobContentHash(Buffer.from(sourceText)) });
    const docs = fixture.state.evidence.filter(span => recordOf(span.provenance).relativePath === "src/add-one.ts"
      && recordOf(span.provenance).sourceSystem === "oss_docs");
    expect(docs.length).toBeGreaterThan(0);
    const requestText = "Implement the source behavior in src/add-one.ts.";
    const codeIntent = codeIntentFromDocumentation({ requestText, documentation: docs });
    expect(codeIntent.references[0]).toMatchObject({ relativePath: "src/add-one.ts", sourceFamily: report.sourceUriBase,
      sourceHash: blobContentHash(Buffer.from(sourceText)) });
    const requirements = sourceOwnedBehaviorRequirementsFromDocumentation({ requestText, intent: codeIntent, patterns: persisted });
    expect(requirements).toHaveLength(3);
    expect(requirements.map(row => row.verificationRole)).toEqual(["fit", "fit", "held_out"]);
    expect(requirements[0]!.sourceSpan).toEqual({ charStart: 0, charEnd: [...requestText].length });
    expect(requirements[0]!.sourceContract?.assertionSpan.start).toBeGreaterThan(0);
    const signal = codeRequestSignal(requestText, { typedBehavior: { behaviorRequirements: requirements, statefulBehaviorRequirements: [] } });
    const intent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning],
      codeSignal: signal, evidence: docs });
    expect(intent?.behaviorRequirements).toEqual(requirements);
    const search = searchProgramTransformations(requirements);
    expect(search.selected).toHaveLength(1);
    expect(search.selected[0]!.callableId).toBe("add_one");
    expect(evaluateProgramExpression(search.selected[0]!.producedIr, requirements.at(-1)!.arguments)).toBe(6);

    const clock = createClock({ fixedTime: 99000, stepMs: 1 });
    const recorded = storageFixtureForEvaluation({ evidence: fixture.state.evidence, clockNow: () => clock.now() });
    const runtimeStorage: ScceStorage = { ...recorded.storage,
      model: { ...fixture.storage.model, readModel: async () => ({ languageProfiles: fixture.state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 1 }) },
      userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
      taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
      documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
      languageMemory: fixture.storage.languageMemory };
    const runtime = createScceKernel({ storage: runtimeStorage, clock, idFactory: createIdFactory({ clock, hasher: createHasher(), deterministicReplay: true }),
      deterministicReplay: true, files: { streamPath: async function* () {} },
      buildTest: new NodeBuildTestAdapter({ runtime: { tempRoot: root } } as ScceRuntimeConfig) });
    const turn = await runtime.turn({ text: "Implement a TypeScript function add_one(value: number): number." });
    expect(turn.answer).toContain("function add_one(");
    expect(recorded.events.some(event => event.typeId === "ProgramGraphBuilt")).toBe(true);
    expect(recorded.events.some(event => event.typeId === "TestExecuted" && recordOf(event.payload).passed === true)).toBe(true);
    const ownedProjection = contractProjectionWrites.find(write => write.projection.patternIds.length === 1);
    expect(ownedProjection).toBeDefined();
    expect(fixture.state.sourceVersions.some(source => Object.hasOwn(recordOf(source.metadata), "sourceOwnedTestContracts"))).toBe(false);

    await writeFile(path.join(root, "spec", "add-one.spec.ts"), [
      "import { test } from 'node:test';",
      "import { add_one } from '../src/add-one.js';",
      "test('keeps the import live', () => { void add_one; });"
    ].join("\n"));
    await trainOssCorpus({ storage: fixture.storage, rootPath: root, sourceUriBase: "scce://assertion-fixture", maxFiles: 20,
      maxFilesPerRun: 20, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    expect([...contractProjectionWrites].reverse().find(write => write.projection.sourceId === ownedProjection!.projection.sourceId)?.projection.patternIds).toEqual([]);
    expect(fixture.state.patterns.filter(pattern => pattern.patternKind === "source_code_assertion_contract")).toEqual([]);
  });

  it("replays actual OSS training into the learned code producer", async () => {
    const root = await tempDir("oss-code-learned-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "examples.ts"), [
      "interface Row { title: string; }",
      "export function show(row: Row): string {", "  return row.title;", "}",
      "export function label(value: Row): string {", "  return value.title;", "}",
      "export function name(item: Row): string {", "  return item.title;", "}",
      "export function add(left: number, right: number): number { return left + right; }",
      "export function subtract(left: number, right: number): number { return left - right; }"
    ].join("\n"));
    const fixture = memoryStorage();
    await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 2, ngramMaxOrder: 5, ngramMaxCountersPerOrder: 256 });
    expect(fixture.state.observations).toEqual([]);
    const functions = fixture.state.patterns.filter(pattern => pattern.patternKind === "source_code_function");
    expect(functions).toHaveLength(5);
    expect(functions.map(pattern => (pattern.patternJson as { parameterCount: number }).parameterCount).sort()).toEqual([1, 1, 1, 2, 2]);
    expect(functions.every(pattern => (pattern.patternJson as { codeFunctionConstructions: JsonValue[] }).codeFunctionConstructions.length === 1)).toBe(true);
    for (const model of fixture.state.models) expect(model.modelJson).not.toHaveProperty("codeFunctionConstructions");
    for (const source of fixture.state.sourceVersions) expect(source.metadata).not.toHaveProperty("codeFunctionConstructions");
    for (const span of fixture.state.evidence) {
      expect(span.provenance).not.toHaveProperty("codeFunctionConstructions");
      expect(span.provenance).not.toHaveProperty("metadata.codeFunctionConstructions");
    }
    for (const unit of fixture.state.units) expect(unit.metadata).not.toHaveProperty("codeFunctionConstructions");
    for (const frame of fixture.state.frames) expect(frame.frameJson).not.toHaveProperty("codeFunctionConstructions");
    const models = codeModelsFromRecords(fixture.state.models, "typescript");
    const targetText = "interface Row { title: string; }\n\nexport function novel(row: Row): string {\n  return row.titel;\n}\n";
    const candidates = generateLearnedCodeRepairs({ models, languageId: "typescript", targetPath: "src/novel.ts", targetText,
      diagnostics: [{ id: "d", class: "type", line: 4, column: 14, message: "", raw: "", confidence: 1 }], requiredSymbols: ["title", "row"] });
    expect(models.length).toBeGreaterThan(0);
    expect(candidates[0]?.content).toBe("  return row.title;");
    const clock = createClock({ fixedTime: 88000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const language = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const state = language.hydrateFromImportedBrain({ importRunId: "actual-oss", models: fixture.state.models, observations: fixture.state.observations,
      units: fixture.state.units, patterns: fixture.state.patterns, semanticFrames: fixture.state.frames, constructionEvidence: fixture.state.evidence });
    const requestText = "TypeScript combinePulse(2,3)=5; combinePulse(-5,8)=3";
    const fit = codeRequestSignal(requestText).behaviorRequirements;
    expect(fit).toHaveLength(2);
    const heldOut = { ...fit[0]!, id: "private-held-out", arguments: [100.5, 7.25], expectedResult: 107.75, verificationRole: "held_out" as const };
    const matrix = { nodes: [], values: [] };
    const field: FieldState = { requestFeatures: featureSet(requestText, 64), seeds: [], active: [], ppf: [], ppfDiagnostics: {}, causalMass: [], alphaTrace: {
      alpha: 0.7, thresholds: { virtual: 0.49, visible: 0.7, bonded: 0.84, structural: 0.51 }, relations: [], adjacency: matrix, laplacian: matrix, normalizedLaplacian: matrix,
      surfaces: { pressure: 0.2, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0.4 }, contradictionMass: 0, bondedLeakage: 0 } };
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: requestText, evidence: [], nodes: [], field, createdAt: clock.now() });
    const mouth = createMouth({ languageMemory: language, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const input = { requestText, programBehaviorRequirements: [...fit, heldOut], codeLanguage: "typescript", requestedAuthority: "program" as const, field, entailment,
      construct: { id: ids.constructId({ code: true }), episodeId: ids.episodeId(), forceVector: {}, nodes: [], edges: [], artifacts: [] },
      evidence: [], languageMemory: state, languageProfile: fixture.state.profiles[0]! };
    const spoken = await mouth.speak(input);
    expect(spoken.text).toContain("function combinePulse(");
    expect(spoken.text).not.toContain("107.75");
    expect(spoken.realizationTrace.selected.id).toBe("candidate:generated:code:typescript");
    expect(recordOf(spoken.realizationTrace.preservation).score).toBe(1);
    expect(JSON.stringify(spoken.realizationTrace.walshSurfaceEnergy)).toContain("energy.semantic.behavior_covered");
    expect(recordOf(recordOf(spoken.realizationTrace.surfaceContract).commitments).licensed).toBe(true);
    expect(recordOf(recordOf(spoken.realizationTrace.surfaceContract).commitments).decides).toBe(true);
    const mutated = withSurfaceContract(input, { ...spoken, text: spoken.text.replace(" + ", " - ") }, SURFACE_REALIZATION_STRATEGY_IDS.learned);
    expect(mutated.text).toBe("");
    expect(JSON.stringify(mutated.realizationTrace.surfaceContract)).toContain("surface.reject.learned_code_changed_after_realization");
    const generatedPath = path.join(root, "generated.ts");
    await writeFile(generatedPath, spoken.text);
    const program = ts.createProgram([generatedPath], { strict: true, noEmit: true, types: [], skipLibCheck: true, target: ts.ScriptTarget.ES2022 });
    expect(ts.getPreEmitDiagnostics(program).map(row => ts.flattenDiagnosticMessageText(row.messageText, "\n"))).toEqual([]);
    const exports: Record<string, (...args: number[]) => unknown> = {};
    runInNewContext(ts.transpileModule(spoken.text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
    expect(exports.combinePulse?.(...heldOut.arguments as number[])).toBe(heldOut.expectedResult);
    expect(exports.combinePulse?.(0, -2)).toBe(-2);
    const recorded = storageFixtureForEvaluation({ evidence: [], clockNow: () => clock.now() });
    const base = recorded.storage;
    const storage: ScceStorage = { ...base, model: { ...fixture.storage.model, readModel: async () => ({ languageProfiles: fixture.state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 1 }) },
      userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
      taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
      documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
      languageMemory: fixture.storage.languageMemory };
    const kernel = createScceKernel({ storage, clock, idFactory: ids, deterministicReplay: true,
      files: { streamPath: async function* () { throw new Error("no workspace code fixture requested"); } },
      buildTest: { executeProgram: async () => { throw new Error("source realization must not call a compiler-owned code generator"); } } });
    const turn = await kernel.turn({ text: requestText, metadata: { session: { sessionId: "typed-code-chat", recentTurns: [] } } });
    expect(turn.answer).toBe(spoken.text);
    expect(JSON.stringify(recorded.events.filter(event => event.typeId === "MouthSpoken").at(-1)?.payload)).toContain("source-code-function-construction.realize");
    expect(JSON.stringify(recorded.events.filter(event => event.typeId === "MouthSpoken").at(-1)?.payload)).toContain("learned_code");
    const ablated = await mouth.speak({ ...input, languageMemory: language.hydrateFromImportedBrain({ importRunId: "no-code", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }) });
    expect(ablated.text).toBe("");
    const tokenOnly = fixture.state.models.map(record => {
      const metadata = recordOf(record.modelJson);
      const { codeFunctionConstructions: _constructions, ...legacyMetadata } = metadata;
      return { ...record, modelJson: legacyMetadata };
    });
    const noCompleteConstruction = await mouth.speak({ ...input, languageMemory: language.hydrateFromImportedBrain({ importRunId: "tokens-only", models: tokenOnly, observations: [], units: [], patterns: [], semanticFrames: [] }) });
    expect(noCompleteConstruction.text).toBe("");
    const forged = fixture.state.models.map(record => ({ ...record, modelJson: { ...recordOf(record.modelJson), sourceHash: "changed-source-hash" } }));
    const forgedPatterns = functions.map(pattern => ({ ...pattern, patternJson: { ...recordOf(pattern.patternJson), sourceHash: "changed-source-hash" } }));
    const unowned = await mouth.speak({ ...input, languageMemory: language.hydrateFromImportedBrain({ importRunId: "wrong-source", models: forged, observations: [], units: [], patterns: forgedPatterns, semanticFrames: [] }) });
    expect(unowned.text).toBe("");
    const changedHeldOut = await mouth.speak({ ...input, programBehaviorRequirements: [...fit, { ...heldOut, expectedResult: -1 }] });
    expect(changedHeldOut.text).toBe(spoken.text);
  });
  it("stamps units, patterns, frames and models without the page list and keeps it on the learned event", async () => {
    const { storage, state } = memoryStorage();
    const input = {
      storage, sourceSystem: "gutenberg", streamUri: "fixture://provenance-once",
      text: "A reader opens a book. Another reader closes the same book. ".repeat(3), createdAt: 1700000000000,
      languageOnly: true, ngramMaxOrder: 2, ngramVocabularyLimit: 32,
      corpusMetadata: { shardUri: "fixture://shard/1", pages: 2, sourceVersionIds: ["version.a", "version.b"] }
    };
    const report = await commitLanguageCorpusTraining(input, await prepareLanguageCorpusTraining(input));
    expect(report.ngramModels).toBeGreaterThan(0);
    for (const model of state.models) expect(model.modelJson).not.toHaveProperty("sourceVersionIds");
    for (const unit of state.units) expect(unit.metadata).not.toHaveProperty("sourceVersionIds");
    for (const pattern of state.patterns) expect(pattern.patternJson).not.toHaveProperty("sourceVersionIds");
    for (const frame of state.frames) expect(frame.frameJson).not.toHaveProperty("sourceVersionIds");
    expect(state.models.every(model => (model.modelJson as Record<string, JsonValue>).shardUri === "fixture://shard/1")).toBe(true);
    const learned = state.events.find(event => event.typeId === "SymbolPatternLearned");
    const payload = learned!.payload as Record<string, any>;
    expect(payload.corpusMetadata.sourceVersionIds).toEqual(["version.a", "version.b"]);
    expect(typeof payload.graphSurfaceAlignments).toBe("number");
    expect(Array.isArray(payload.graphSurfaceAlignment)).toBe(true);
  });
});

describe("prepared corpus training", () => {
  it("separates acquisition replay provenance while binding prepared and semantic inputs exactly", async () => {
    const fixture = memoryStorage();
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); },
      get: async id => checkpoints.get(id) ?? null, list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    const input = { storage: fixture.storage, sourceSystem: "gutenberg", streamUri: "fixture://acquired-book", sourceUri: "fixture://acquired-book",
      text: "A reader opens the book.", createdAt: 1700000000000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      acquisitionProvenance: { snapshot: "first" }, corpusMetadata: { declaredLicense: "source-license" },
      corpusCheckpoint: { rootUri: "fixture://books", itemUri: "acquired-book" } };
    const prepared = await prepareLanguageCorpusTraining(input);
    await expect(commitLanguageCorpusTraining({ ...input, acquisitionProvenance: { snapshot: "second" } }, prepared)).rejects.toThrow("input changed before commit");
    const first = await commitLanguageCorpusTraining(input, prepared);
    const before = structuredClone(fixture.state);
    expect(await trainLanguageCorpusText({ ...input, acquisitionProvenance: { snapshot: "second" } })).toEqual(first);
    expect(fixture.state).toEqual(before);
    expect(recordOf(fixture.state.sourceVersions[0]?.metadata).acquisitionProvenance).toEqual({ snapshot: "first" });
    await expect(trainLanguageCorpusText({ ...input, corpusMetadata: { declaredLicense: "changed-license" } })).rejects.toThrow("checkpoint binding mismatch");
  });

  it("keeps exact source spans byte-bound and excludes profile excerpts", async () => {
    const fixture = memoryStorage();
    const input = {
      storage: fixture.storage,
      sourceSystem: "gutenberg",
      streamUri: "fixture://moby-search",
      sourceUri: "fixture://moby-search",
      text: "Émile notes that the captain of the Pequod was Ahab. The Pequod carried a crew of sailors.",
      createdAt: 1700000000000,
      languageOnly: true,
      ngramMaxOrder: 2,
      ngramMaxCountersPerOrder: 64,
      corpusMetadata: { title: "Moby Dick", identity: "herman melville pequod ahab" }
    };
    const report = await trainLanguageCorpusText(input);
    const exactSourceSpan = fixture.state.evidence[0]!;
    expect(report.evidence).toBeGreaterThan(0);
    expect(exactSourceSpan.status).toBe("promoted");
    expect(recordOf(exactSourceSpan.provenance).forceClass).toBe("direct_evidence");
    expect(recordOf(exactSourceSpan.trustVector).forceClass).toBe("direct_evidence");
    expect(exactSourceSpan.features).toContain("anchor:sym:pequod");
    const sourceVersion = fixture.state.sourceVersions.find(row => row.sourceVersionId === exactSourceSpan.sourceVersionId)!;
    const persistedFullSource = fixture.state.blobs.find(bytes => blobContentHash(bytes) === sourceVersion.contentHash)!;
    const spanBytes = Buffer.from(persistedFullSource).subarray(exactSourceSpan.byteStart, exactSourceSpan.byteEnd);
    expect(blobContentHash(persistedFullSource)).toBe(sourceVersion.contentHash);
    expect(blobContentHash(spanBytes)).toBe(exactSourceSpan.contentHash);
    expect(spanBytes.toString("utf8")).toBe(exactSourceSpan.text);
    expect([...Buffer.from(persistedFullSource).toString("utf8")].slice(exactSourceSpan.charStart, exactSourceSpan.charEnd).join("")).toBe(exactSourceSpan.text);

    const profileExcerpt: EvidenceSpan = {
      ...exactSourceSpan,
      id: "evidence.profile-excerpt" as EvidenceSpan["id"],
      sourceVersionId: "source_version.profile-excerpt" as EvidenceSpan["sourceVersionId"],
      provenance: toJsonValue({ ...recordOf(exactSourceSpan.provenance), forceClass: "profile_excerpt_evidence" }),
      trustVector: toJsonValue({ ...recordOf(exactSourceSpan.trustVector), forceClass: "profile_excerpt_evidence" })
    };
    fixture.state.evidence.push(profileExcerpt);
    fixture.storage.evidence.searchEvidence = async query => fixture.state.evidence
      .filter(span => query.status !== "promoted" || span.status === "promoted")
      .filter(span => (query.features ?? []).every(feature => span.features.includes(feature)))
      .filter(span => !query.excludeForceClasses?.includes(String(recordOf(span.provenance).forceClass)))
      .slice(0, query.limit ?? fixture.state.evidence.length)
      .map(span => ({ span, score: 1, reason: "fixture anchor index" }));
    const results = await fixture.storage.evidence.searchEvidence({
      features: ["anchor:sym:pequod"], status: "promoted", limit: 64,
      excludeForceClasses: ["profile_excerpt_evidence"]
    });
    expect(results.map(result => result.span.id)).toContain(exactSourceSpan.id);
    expect(results.map(result => result.span.id)).not.toContain(profileExcerpt.id);

  });

  it("avoids graph and natural construction pool reads for automatic formal code training", async () => {
    const fixture = memoryStorage();
    const graph = vi.spyOn(fixture.storage.graph, "getSlice");
    const profiles = vi.spyOn(fixture.storage.model, "listLanguageProfiles");
    const pool = vi.fn(async () => []);
    fixture.storage.evidence.listEvidenceBackedSourceVersions = pool;
    const search = vi.spyOn(fixture.storage.evidence, "searchEvidence");
    const input = { storage: fixture.storage, sourceSystem: "oss_code", streamUri: "fixture://automatic-code",
      text: 'export function label(value: string): string { return "two words" + value; }', createdAt: 1700000000000,
      informationLabel: publicCorpusInformationLabel, constructionPoolUriPrefix: "fixture://", ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 };
    const prepared = await prepareLanguageCorpusTraining(input);
    await commitLanguageCorpusTraining(input, prepared);
    expect(fixture.state.models).toHaveLength(1);
    expect(graph).not.toHaveBeenCalled();
    expect(pool).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(profiles).not.toHaveBeenCalled();
    const prose = { ...input, sourceSystem: "oss_docs", streamUri: "fixture://source-docs", text: "A reader opens the book. Another reader closes the book." };
    await commitLanguageCorpusTraining(prose, await prepareLanguageCorpusTraining(prose));
    expect(graph).toHaveBeenCalledTimes(2);
    expect(pool).toHaveBeenCalledTimes(1);
  });

  const options = (storage: ScceStorage) => ({ storage, sourceSystem: "gutenberg", streamUri: "fixture://prepared-book",
    text: "A reader opens a book. Another reader closes the same book. ".repeat(3), createdAt: 1700000000000,
    languageOnly: true, ngramMaxOrder: 2, ngramVocabularyLimit: 32 });

  it("prepares without writes and atomically commits one opaque, input-bound result", async () => {
    const { storage, state } = memoryStorage();
    const input = options(storage);
    const prepared = await prepareLanguageCorpusTraining(input);
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect("models" in prepared).toBe(false);
    await expect(commitLanguageCorpusTraining(input, { ...prepared })).rejects.toThrow("unrecognized");
    const report = await commitLanguageCorpusTraining(input, prepared);
    expect(report.ngramModels).toBeGreaterThan(0);
    expect(state.sourceVersions).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    await expect(commitLanguageCorpusTraining(input, prepared)).rejects.toThrow("already committed");
    expect(state.events).toHaveLength(1);
  });

  it("rejects changed input or graph dependencies before persisting prepared learning", async () => {
    const { storage, state } = memoryStorage();
    const input = options(storage);
    const prepared = await prepareLanguageCorpusTraining(input);
    await expect(commitLanguageCorpusTraining({ ...input, text: "changed source" }, prepared)).rejects.toThrow("input changed");
    storage.graph.getSlice = async query => ({ bounded: true, query, nodes: [], edges: [], hyperedges: [
      { id: "changed-hyperedge", modality: { extractionChannel: "fixture" } } as any
    ] });
    await expect(commitLanguageCorpusTraining(input, prepared)).rejects.toThrow("graph dependencies changed");
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
  });

  it("rejects a projected graph whose claims cite evidence outside the source being compiled", async () => {
    const fixture = memoryStorage();
    await expect(prepareLanguageCorpusTraining({ storage: fixture.storage, sourceSystem: "gutenberg", streamUri: "fixture://foreign-projection",
      text: "A reader opens a book. Another reader closes the same book.",
      graphSnapshotAdditions: { nodes: [], edges: [], hyperedges: [{ id: "foreign", evidenceIds: ["foreign.evidence"], participantPorts: [] } as any] }
    })).rejects.toThrow("not owned by the admitted source evidence");
    expect(fixture.state.sourceVersions).toEqual([]);
    expect(fixture.state.patterns).toEqual([]);
  });

  it("detaches a creative compiler's small result while keeping the prepared commit input-bound", async () => {
    const { storage, state } = memoryStorage();
    const compilerPattern = {
      id: "creative.fixture.pattern",
      profileId: "creative.fixture.profile",
      patternKind: "semantic_role" as const,
      support: 1,
      entropy: 0,
      patternJson: { schema: "creative.fixture", original: true },
      evidenceIds: [],
      updatedAt: 1
    };
    const input = {
      ...options(storage),
      languageOnly: false,
      creativeEventCompiler: {
        id: "creative.fixture.compiler",
        compile: () => ({ status: "compiled" as const, pattern: compilerPattern, bundle: {} as any })
      }
    };
    const prepared = await prepareLanguageCorpusTraining(input);
    compilerPattern.patternJson.original = false;
    await commitLanguageCorpusTraining(input, prepared);
    const persisted = state.patterns.find(pattern => pattern.id === compilerPattern.id);
    expect(persisted?.patternJson).toMatchObject({ original: true });
    expect(persisted?.patternJson).not.toMatchObject({ original: false });
  });

  it("propagates graph lookup failures and rolls back a later model write failure", async () => {
    const { storage, state } = memoryStorage();
    const input = options(storage);
    const lookup = storage.graph.getSlice;
    storage.graph.getSlice = async () => { throw new Error("graph unavailable"); };
    await expect(prepareLanguageCorpusTraining(input)).rejects.toThrow("graph unavailable");
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
    storage.graph.getSlice = lookup;
    const prepared = await prepareLanguageCorpusTraining(input);
    storage.languageMemory.putNgramModels = async () => { throw new Error("injected model failure"); };
    await expect(commitLanguageCorpusTraining(input, prepared)).rejects.toThrow("injected model failure");
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
  });
});

describe("multi-corpus training", () => {
  it("upgrades an actual v3 source checkpoint to v4 without changing owned inputs or duplicating canonical identities", async () => {
    const legacy = JSON.parse(readFileSync(new URL("./fixtures/legacy-language-batch-v3-checkpoint.json", import.meta.url), "utf8")) as {
      input: Omit<LanguageCorpusTrainingInput, "storage">; checkpoint: IngestionCheckpoint;
      canonical: Pick<MemoryState, "models" | "patterns" | "units" | "frames" | "profiles" | "evidence"> & { sources: SourceVersion[] };
      artifactIds: Record<"sourceVersions" | "models" | "profiles" | "evidence", string[]>;
    };
    expect(recordOf(legacy.checkpoint.metadata).batchRecipe).toBe("kernel.language_training_batch.v3");
    const fixture = memoryStorage();
    const state = fixture.state;
    state.models.push(...legacy.canonical.models);
    state.patterns.push(...legacy.canonical.patterns);
    state.units.push(...legacy.canonical.units);
    state.frames.push(...legacy.canonical.frames);
    state.profiles.push(...legacy.canonical.profiles);
    state.evidence.push(...legacy.canonical.evidence);
    state.sourceVersions.push(...legacy.canonical.sources);
    state.blobs.push(new Uint8Array(Buffer.from(legacy.input.text)));
    fixture.storage.blobs.put = async bytes => { const hash = blobContentHash(bytes); if (!state.blobs.some(row => blobContentHash(row) === hash)) state.blobs.push(new Uint8Array(bytes)); return hash; };
    const upsert = <T extends { id: unknown }>(rows: T[], incoming: readonly T[]) => {
      for (const row of incoming) { const index = rows.findIndex(previous => previous.id === row.id); if (index < 0) rows.push(row); else rows[index] = row; }
    };
    fixture.storage.evidence.putSourceVersion = async row => { const index = state.sourceVersions.findIndex(source => source.sourceVersionId === row.sourceVersionId); if (index < 0) state.sourceVersions.push(row); else state.sourceVersions[index] = row; };
    fixture.storage.evidence.putEvidenceSpans = async rows => { upsert(state.evidence, rows); };
    fixture.storage.model.putLanguageProfile = async row => { upsert(state.profiles, [row]); };
    fixture.storage.languageMemory.putNgramModels = async rows => { upsert(state.models, rows); };
    fixture.storage.languageMemory.putLanguageUnits = async rows => { upsert(state.units, rows); };
    fixture.storage.languageMemory.putSemanticFrames = async rows => { upsert(state.frames, rows); };
    const checkpoints = new Map([[legacy.checkpoint.id, structuredClone(legacy.checkpoint)]]);
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); },
      get: async id => checkpoints.get(id) ?? null, list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    const input = { ...legacy.input, storage: fixture.storage };
    const before = structuredClone(state);
    for (const changed of [
      { ...input, text: `${input.text} changed` }, { ...input, ngramMaxOrder: 3 },
      { ...input, informationLabel: { ...input.informationLabel!, principals: ["different-owner"] } },
      { ...input, corpusMetadata: { declaredLicense: "different-license" } }
    ]) {
      await expect(readCompletedCorpusCheckpoint(changed)).rejects.toThrow("checkpoint binding mismatch");
      await expect(trainLanguageCorpusText(changed)).rejects.toThrow("checkpoint binding mismatch");
    }
    expect(state).toEqual(before);
    expect(await readCompletedCorpusCheckpoint(input)).toBeUndefined();
    expect(checkpoints.get(legacy.checkpoint.id)).toEqual(legacy.checkpoint);
    const upgraded = await trainLanguageCorpusText(input);
    expect(checkpoints.size).toBe(1);
    expect(recordOf(checkpoints.get(legacy.checkpoint.id)!.metadata).batchRecipe).toBe(LANGUAGE_TRAINING_BATCH_RECIPE_ID);
    expect(upgraded.admission).toEqual(recordOf(recordOf(legacy.checkpoint.metadata).report).admission);
    expect(state.sourceVersions.map(row => row.sourceVersionId)).toEqual(legacy.artifactIds.sourceVersions);
    expect(state.sourceVersions).toEqual(legacy.canonical.sources);
    expect(state.evidence.map(row => row.id)).toEqual(legacy.artifactIds.evidence);
    expect(state.profiles.map(row => row.id)).toEqual(legacy.artifactIds.profiles);
    expect(state.models.map(row => row.id)).toEqual(legacy.artifactIds.models);
    expect(state.blobs).toHaveLength(1);
    expect(state.models.every(row => recordOf(recordOf(row.modelJson).sourceCompilation).compilerRecipe === LANGUAGE_TRAINING_BATCH_RECIPE_ID)).toBe(true);
    expect(state.patterns.filter(row => recordOf(row.patternJson).schema === "scce.source_language_compilation_receipt.v1")).toHaveLength(2);
    const completed = structuredClone(state);
    expect(await trainLanguageCorpusText(input)).toEqual(upgraded);
    expect(state).toEqual(completed);
    const clock = createClock({ fixedTime: 150000, stepMs: 1 });
    const hasher = createHasher();
    const recorded = storageFixtureForEvaluation({ evidence: state.evidence, clockNow: () => clock.now() });
    const storage: ScceStorage = { ...recorded.storage, languageMemory: fixture.storage.languageMemory, transaction: fixture.storage.transaction,
      evidence: { ...recorded.storage.evidence, sourceVersionsForEvidence: async ids => state.sourceVersions.filter(source => state.evidence.some(span => ids.includes(span.id) && span.sourceVersionId === source.sourceVersionId)) },
      blobs: { ...fixture.storage.blobs, get: async hash => { const bytes = state.blobs.find(bytes => blobContentHash(bytes) === hash); if (!bytes) throw new Error("owned upgrade source missing"); return bytes; } },
      model: { ...fixture.storage.model, readModel: async () => ({ languageProfiles: state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }) } };
    storage.languageMemory.putNgramModel = async () => { throw new Error("canonical V4 replay must not rewrite models"); };
    const kernel = createScceKernel({ storage, clock, idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }), deterministicReplay: true,
      sourceInformationLabel: input.informationLabel, files: { streamPath: async function* () {} },
      buildTest: { executeProgram: async () => { throw new Error("canonical source replay has no alternate producer"); } } });
    const replay = await kernel.train({ config: { learningGoals: [], promotion: { minTrust: 0.45 } } });
    expect(replay.promotedEvidence).toBeGreaterThan(0);
    const promoted = recorded.events.filter(event => event.typeId === "LearningPromoted").at(-1);
    expect(recordOf(recordOf(promoted?.payload).trainingLanguage).reusedModels).toBe(state.models.length);
    expect(state).toEqual(completed);
  });
  it("qualifies durable ordinary OSS observations across separate document training calls", async () => {
    const root = await tempDir("oss-durable-construction-pool-");
    const texts = [
      "甲 f9 木。乙 f9 石。甲 f9 水。乙 f9 土。",
      "丙 f9 木。丁 f9 石。甲 f9 水。乙 f9 土。",
      "戊 f9 木。己 f9 石。甲 f9 水。乙 f9 土。",
      "庚 f9 木。辛 f9 石。甲 f9 水。乙 f9 土。"
    ];
    for (const [index, text] of texts.entries()) await writeFile(path.join(root, `${index}.md`), text, "utf8");
    const fixture = memoryStorage();
    const queries = installDurableConstructionPool(fixture);
    const reports: Awaited<ReturnType<typeof trainOssCorpus>>[] = [];
    for (let index = 0; index < texts.length; index++) {
      reports.push(await trainOssCorpus({ storage: fixture.storage, rootPath: root, sourceUriBase: "scce://owned-pool", startFileIndex: index,
        ...(index ? { expectedSnapshotHash: reports[0]!.snapshotHash } : {}), maxFilesPerRun: 1, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 }));
    }
    expect(reports[0]!.totals.oss_docs.constructionAcquisition?.sourceObserved).toBeGreaterThan(0);
    expect(reports[0]!.totals.oss_docs.constructionAcquisition?.documentHeldOutQualified).toBe(0);
    expect(reports.at(-1)!.totals.oss_docs.constructionAcquisition?.documentHeldOutQualified).toBeGreaterThan(0);
    expect(queries.every(query => query?.sourceSystem === "oss_docs" && query?.includeUriPrefixes?.[0] === "scce://owned-pool" && query?.maxByteLength === undefined)).toBe(true);
    const pools = fixture.state.events.filter(event => event.typeId === "SymbolPatternLearned").map(event => (event.payload as { constructionPool: { evidenceIds: string[]; utf16Length: number } }).constructionPool);
    expect(pools.at(-1)!.evidenceIds.length).toBeGreaterThan(0);
    expect(pools.every(pool => pool.utf16Length <= inductionCharBudget())).toBe(true);
    const restarted = createLanguageMemoryRuntime({ hasher: createHasher() }).hydrate({ models: [], patterns: fixture.state.patterns.filter(isConstructionBundle), constructionEvidence: fixture.state.evidence });
    expect(restarted.rejectedConstructionPatterns).toEqual([]);
    expect(restarted.importedConstructionBundles.some(bundle => bundle.qualificationStatus === "document_heldout_qualified")).toBe(true);
    const owners = new Map(fixture.state.profiles.map(profile => [profile.id, String(profile.sourceVersionId)]));
    expect(restarted.importedConstructionBundles.every(bundle => bundle.sourceVersionIds.length === 1
      && bundle.sourceVersionIds[0] === owners.get(bundle.targetProfileId))).toBe(true);
    const observations = restarted.importedConstructionBundles.flatMap(bundle => bundle.sourceExamples.map(example => JSON.stringify({
      sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId, start: example.surfaceStartCodePoint, end: example.surfaceEndCodePoint,
      roles: example.roles.map(role => [role.slotIndex, role.occurrenceIndex, role.startCodePoint, role.endCodePoint])
    })));
    expect(new Set(observations).size).toBe(observations.length);
    expect(fixture.state.models.every(model => (model.modelJson as { corpus?: { sourceSystem?: string } }).corpus?.sourceSystem !== "oss_code")).toBe(true);
  });

  it.each(["evidence", "language_profile"])("rejects a prepared construction pool when its durable %s dependency changes", async dependency => {
    const root = await tempDir("oss-pool-dependency-");
    await writeFile(path.join(root, "first.md"), "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.", "utf8");
    const fixture = memoryStorage();
    installDurableConstructionPool(fixture);
    await trainOssCorpus({ storage: fixture.storage, rootPath: root, sourceUriBase: "scce://dependency-pool", maxFilesPerRun: 1, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    const input = { storage: fixture.storage, sourceSystem: "oss_docs", streamUri: "oss_docs:next", sourceUri: "scce://dependency-pool#path=next.md",
      corpusCheckpoint: { rootUri: "scce://dependency-pool", itemUri: "next.md" }, informationLabel: fixture.state.evidence[0]!.informationLabel,
      text: "cat chased cart. dog chased cart. cat chased box. dog chased box.", ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 };
    const prepared = await prepareLanguageCorpusTraining(input);
    const patternsBefore = fixture.state.patterns.length;
    if (dependency === "evidence") fixture.state.evidence[0]!.status = "quarantined";
    else fixture.state.profiles[0]!.charNgrams[0]!.count++;
    await expect(commitLanguageCorpusTraining(input, prepared)).rejects.toThrow(dependency === "evidence" ? "construction evidence changed" : "construction language profiles changed");
    expect(fixture.state.patterns).toHaveLength(patternsBefore);
  });

  it("uses an owned distributed window from a real book larger than the construction budget", async () => {
    const fixture = memoryStorage();
    const queries = installDurableConstructionPool(fixture);
    const prior = (await readFile(new URL("../../../kernel/src/__tests__/fixtures/alice-acquisition-excerpt.txt", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
    const current = await readFile(new URL("../../../kernel/src/__tests__/fixtures/pride-and-prejudice-context-excerpt.txt", import.meta.url), "utf8");
    expect(Buffer.byteLength(prior)).toBeGreaterThan(inductionCharBudget());
    await trainLanguageCorpusText({ storage: fixture.storage, sourceSystem: "gutenberg", sourceUri: "scce://book-context/alice.txt",
      streamUri: "gutenberg:alice", text: prior, languageOnly: true, skipNgramObservationPersistence: true,
      ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    const modelsBefore = fixture.state.models.map(model => model.id);
    const patternsBefore = new Set(fixture.state.patterns.map(pattern => pattern.id));
    const poolOwners = new Set(fixture.state.evidence.map(span => String(span.sourceVersionId)));
    const input = { storage: fixture.storage, sourceSystem: "gutenberg", sourceUri: "scce://book-context/austen.txt", streamUri: "gutenberg:austen",
      constructionPoolUriPrefix: "scce://book-context/", text: current, skipNgramObservationPersistence: true, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 };
    const prepared = await prepareLanguageCorpusTraining(input);
    await commitLanguageCorpusTraining(input, prepared);
    const contextEvent = fixture.state.events.filter(event => event.typeId === "SymbolPatternLearned").at(-1)!;
    const context = (contextEvent.payload as { constructionPool: { utf16Length: number; byteLength: number; windows: Array<{ ownerDocumentId: string; startUtf16: number; endUtf16: number }> } }).constructionPool;
    expect(context.utf16Length).toBeLessThanOrEqual(inductionCharBudget());
    expect(context.byteLength).toBeLessThanOrEqual(inductionCharBudget());
    expect(context.windows.some(window => window.startUtf16 > 0)).toBe(true);
    for (const window of context.windows) {
      const owner = fixture.state.evidence.find(span => String(span.id) === window.ownerDocumentId)!;
      expect(owner).toBeDefined();
      expect(window.endUtf16).toBeLessThanOrEqual(owner.text.length);
    }
    expect(queries.every(query => query?.maxByteLength === undefined)).toBe(true);
    expect(fixture.state.models.filter(model => modelsBefore.includes(model.id)).map(model => model.id)).toEqual(modelsBefore);
    expect(fixture.state.patterns.filter(pattern => !patternsBefore.has(pattern.id)).filter(isConstructionBundle).every(pattern =>
      !(recordOf(pattern.patternJson).sourceVersionIds as string[] | undefined)?.some(id => poolOwners.has(id)))).toBe(true);
  });

  it("excludes an older version of the current source from independent construction context", async () => {
    const fixture = memoryStorage();
    installDurableConstructionPool(fixture);
    const common = { storage: fixture.storage, sourceSystem: "oss_docs", sourceUri: "scce://same-book/source.md", streamUri: "oss_docs:source",
      informationLabel: { tenantId: "context.fixture", principals: ["context.owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const },
      constructionPoolUriPrefix: "scce://same-book/", ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, skipNgramObservationPersistence: true };
    await trainLanguageCorpusText({ ...common, text: "The source describes a small pump. The pump carries water.", languageOnly: true });
    const oldVersions = fixture.state.sourceVersions.map(version => String(version.sourceVersionId));
    await trainLanguageCorpusText({ ...common, text: "The source describes a large pump. The pump carries oil." });
    const context = (fixture.state.events.filter(event => event.typeId === "SymbolPatternLearned").at(-1)!.payload as {
      constructionPool: { sourceVersionIds: string[]; languageCompatibility: unknown[] } }).constructionPool;
    expect(context.sourceVersionIds.some(id => oldVersions.includes(id))).toBe(false);
    expect(context.languageCompatibility).toEqual([]);
  });

  it.each(["different_distribution", "declared_identity_conflict", "profile_absent", "distribution_absent"])("does not relabel pooled source grammar when language compatibility is %s", async reason => {
    const root = await tempDir("oss-pool-language-");
    await writeFile(path.join(root, "first.md"), "The source describes a small pump. The pump carries water. The source describes a large pump. The pump carries oil.", "utf8");
    const fixture = memoryStorage();
    installDurableConstructionPool(fixture);
    await trainOssCorpus({ storage: fixture.storage, rootPath: root, sourceUriBase: "scce://language-pool", maxFilesPerRun: 1, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      ...(reason === "declared_identity_conflict" ? { languageAliases: ["opaque.alpha"] } : {}) });
    const informationLabel = fixture.state.evidence[0]!.informationLabel;
    if (reason === "profile_absent") fixture.state.profiles.splice(0);
    if (reason === "distribution_absent") fixture.state.profiles[0]!.charNgrams = [];
    await trainLanguageCorpusText({ storage: fixture.storage, sourceSystem: "oss_docs", streamUri: "oss_docs:next", sourceUri: "scce://language-pool#path=next.md",
      corpusCheckpoint: { rootUri: "scce://language-pool", itemUri: "next.md" }, informationLabel,
      ...(reason === "declared_identity_conflict" ? { languageAliases: ["opaque.beta"] } : {}),
      text: reason === "different_distribution" ? "この資料は小さな装置を記述する。装置は水を運ぶ。この資料は大きな装置を記述する。装置は油を運ぶ。"
        : "The source describes a small pump. The pump carries water. The source describes a large pump. The pump carries oil.",
      ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    const pool = (fixture.state.events.filter(event => event.typeId === "SymbolPatternLearned").at(-1)!.payload as { constructionPool: { evidenceIds: string[]; languageCompatibility: Array<{ status: string; basis: string }> } }).constructionPool;
    expect(pool.evidenceIds).toEqual([]);
    expect(pool.languageCompatibility).toHaveLength(1);
    expect(pool.languageCompatibility[0]!.status).toBe(reason === "profile_absent" || reason === "distribution_absent" ? "unmeasured" : "incompatible");
    if (reason === "declared_identity_conflict") expect(pool.languageCompatibility[0]!.basis).toBe("source_owned_identity_conflict");
  });

  it.each(["different", "missing"])("keeps code's %s formal-language declaration out of explicitly requested teaching context", async reason => {
    const fixture = memoryStorage();
    installDurableConstructionPool(fixture);
    const common = { storage: fixture.storage, sourceSystem: "oss_code", informationLabel: publicCorpusInformationLabel,
      text: "x = y + z\na = b + c\nx = y + z\na = b + c", ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      constructionSets: [{ bindingId: "code.explicit_pool_scope", observations: [] }] };
    await trainLanguageCorpusText({ ...common, streamUri: "oss_code:first", sourceUri: "scce://code-pool#path=first.py", corpusCheckpoint: { rootUri: "scce://code-pool", itemUri: "first.py" }, corpusMetadata: { formalLanguage: "python" } });
    await trainLanguageCorpusText({ ...common, streamUri: "oss_code:next", sourceUri: "scce://code-pool#path=next.rb", corpusCheckpoint: { rootUri: "scce://code-pool", itemUri: "next.rb" }, corpusMetadata: { formalLanguage: reason === "different" ? "ruby" : null } });
    const pool = (fixture.state.events.filter(event => event.typeId === "SymbolPatternLearned").at(-1)!.payload as { constructionPool: { evidenceIds: string[]; languageCompatibility: Array<{ status: string; basis: string }> } }).constructionPool;
    expect(pool.evidenceIds).toEqual([]);
    expect(pool.languageCompatibility).toMatchObject([{ status: reason === "different" ? "incompatible" : "unmeasured", basis: "declared_formal_language" }]);
  });

  it.each(["other_root", "other_system", "other_label", "inventory_size_mismatch"])("excludes %s evidence from the construction replay pool", async reason => {
    const root = await tempDir("oss-pool-scope-");
    await writeFile(path.join(root, "first.md"), "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.", "utf8");
    const fixture = memoryStorage();
    installDurableConstructionPool(fixture);
    await trainOssCorpus({ storage: fixture.storage, rootPath: root, sourceUriBase: "scce://scope-pool", maxFilesPerRun: 1, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    const list = fixture.storage.evidence.listEvidenceBackedSourceVersions!;
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async query => (await list(query)).map(row => ({ ...row,
      ...(reason === "other_root" ? { canonicalUri: "scce://foreign-pool#path=first.md" } : {}),
      ...(reason === "inventory_size_mismatch" ? { byteLength: inductionCharBudget() + 1 } : {})
    }));
    const informationLabel = structuredClone(fixture.state.evidence[0]!.informationLabel!);
    if (reason === "other_system") fixture.state.evidence[0]!.provenance = { sourceSystem: "oss_code" };
    if (reason === "other_label") fixture.state.evidence[0]!.informationLabel = { ...informationLabel, compartments: ["separate"] };
    await trainLanguageCorpusText({ storage: fixture.storage, sourceSystem: "oss_docs", streamUri: "oss_docs:next", sourceUri: "scce://scope-pool#path=next.md",
      corpusCheckpoint: { rootUri: "scce://scope-pool", itemUri: "next.md" }, informationLabel,
      text: "cat chased cart. dog chased cart. cat chased box. dog chased box.", ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    const pool = (fixture.state.events.filter(event => event.typeId === "SymbolPatternLearned").at(-1)!.payload as { constructionPool: { evidenceIds: string[] } }).constructionPool;
    expect(pool.evidenceIds).toEqual([]);
  });

  it("keeps old Wikipedia-only config valid and parses multi-corpus config into registry entries", () => {
    const oldConfig = configFixture({
      wikipedia: {
        enabled: true,
        dumpPath: "data/wiki/enwiki.xml.bz2",
        indexPath: "data/wiki/enwiki-index.txt.bz2",
        allowedNamespaces: [0],
        memorySafetyBoundMb: 1024,
        ngramMaxOrder: 4
      }
    });
    validateConfig(oldConfig, "old");
    expect(corpusRegistryEntriesFromConfig(oldConfig).find(item => item.sourceSystem === "wikipedia")?.localPath).toBe("data/wiki/enwiki.xml.bz2");

    const nextConfig = configFixture({
      gutenberg: { enabled: true, rootPath: "corpus/gutenberg", maxFilesPerRun: 2, ngramMaxOrder: 5 },
      oss: { enabled: true, rootPath: "corpus/oss", repos: ["vite"], includeDocs: true, includeSource: true, ngramMaxCountersPerOrder: 256 }
    });
    validateConfig(nextConfig, "next");
    const registry = corpusRegistryEntriesFromConfig(nextConfig);
    expect(registry.find(item => item.sourceSystem === "gutenberg")?.enabled).toBe(true);
    expect(registry.find(item => item.sourceSystem === "gutenberg")?.ngram.maxOrder).toBe(5);
    expect(registry.find(item => item.sourceSystem === "oss_docs")?.enabled).toBe(true);
    expect(registry.find(item => item.sourceSystem === "oss_code")?.ngram.maxCountersPerOrder).toBe(256);
  });

  it("stamps shared trainer artifacts with the requested source system", async () => {
    const fixture = memoryStorage();
    const result = await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/1",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(result.sourceSystem).toBe("wikipedia");
    expect(result.sourceSystemId).toBe(canonicalCorpusSourceSystemId("wikipedia"));
    expect(result.sourceSystemId).not.toBe(result.sourceSystem);
    expect(fixture.state.observations.length).toBeGreaterThan(0);
    expect(fixture.state.models.length).toBeGreaterThan(0);
    expect(fixture.state.units.length).toBeGreaterThan(0);
    expect(fixture.state.patterns.length).toBeGreaterThan(0);
    expect(fixture.state.events.some(event => event.typeId === "SymbolPatternLearned" && sourceSystemOf(event.payload) === "wikipedia")).toBe(true);
    expect(fixture.state.observations.every(row => sourceSystemIdOf(row.metadata) === result.sourceSystemId)).toBe(true);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["wikipedia"]));
  });

  it("writes the compiled models without the raw observations when asked", async () => {
    // A corpus ingest wrote its n-gram mass twice: as compiled models, and as the raw observations they were
    // compiled from. Nothing reads the raw form -- its only consumers are a diagnostic summary and a hydration
    // fallback whose own comment records it returning 0 rows in 48 of 48 measured executions -- and nothing
    // learns from it, because training reads evidence spans.
    //
    // The rows never collapse, because their ids are per shard. Measured on a clean scce5 after 4,762
    // articles: 19,382,688 rows and 27GB, roughly 460,000 new rows per shard inserted into a primary key that
    // grew with every shard before it. Throughput fell from 1,217 sources an hour to 348 across five hours.
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/observations-skipped",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      skipNgramObservationPersistence: true,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(fixture.state.observations.length).toBe(0);
    // The mass still lands, in the form the runtime actually hydrates.
    expect(fixture.state.models.length).toBeGreaterThan(0);
    // And everything else the lane produces is untouched.
    expect(fixture.state.units.length).toBeGreaterThan(0);
    expect(fixture.state.patterns.length).toBeGreaterThan(0);
  });

  it("keeps writing observations for callers that did not ask to skip them", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/observations-kept",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(fixture.state.observations.length).toBeGreaterThan(0);
    expect(fixture.state.models.length).toBeGreaterThan(0);
  });

  it("replays a completed corpus checkpoint without repeating learned writes or accepting a changed recipe", async () => {
    const fixture = memoryStorage();
    const checkpoints = new Map<string, any>();
    fixture.storage.ingestion = {
      put: async (checkpoint: IngestionCheckpoint) => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
      get: async (id: string) => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()]
    } as any;
    const input = {
      storage: fixture.storage,
      sourceSystem: "gutenberg",
      streamUri: "fixture://prepared-book",
      text: "A reader opens a book. Another reader closes the same book. ".repeat(3),
      createdAt: 1700000000000,
      languageOnly: true,
      ngramMaxOrder: 2,
      ngramVocabularyLimit: 32,
      corpusCheckpoint: { rootUri: "fixture://gutenberg", itemUri: "book.txt", contentHash: "sha256_fixture", byteLength: 128 }
    };

    const first = await trainLanguageCorpusText(input);
    const counts = Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]));
    const second = await trainLanguageCorpusText(input);

    expect(second).toEqual(first);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(counts);
    expect([...checkpoints.values()]).toHaveLength(1);
    expect([...checkpoints.values()][0].status).toBe("complete");
    expect([...checkpoints.values()][0].metadata.compilerRecipe).toBe(LANGUAGE_CORPUS_TRAINING_RECIPE_ID);
    await expect(trainLanguageCorpusText({ ...input, text: "changed source" })).rejects.toThrow(/checkpoint binding mismatch/iu);
  });

  it("binds checkpoint replay to the creative compiler identity while preserving owned output", async () => {
    const fixture = memoryStorage();
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = {
      put: async row => { checkpoints.set(row.id, structuredClone(row)); },
      get: async id => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()]
    } as ScceStorage["ingestion"];
    const input = {
      storage: fixture.storage,
      sourceSystem: "gutenberg",
      streamUri: "fixture://creative-compiler-book",
      text: "A reader opens a book. Another reader closes the same book. ".repeat(3),
      createdAt: 1700000000000,
      languageOnly: false,
      ngramMaxOrder: 2,
      ngramVocabularyLimit: 32,
      corpusCheckpoint: { rootUri: "fixture://creative-books", itemUri: "book.txt" }
    };
    const pattern = {
      id: "creative.fixture.pattern",
      profileId: "creative.fixture.profile",
      patternKind: "semantic_role" as const,
      support: 1,
      entropy: 0,
      patternJson: { schema: "creative.fixture" },
      evidenceIds: [],
      updatedAt: 1
    };
    const compiler = (id: string) => ({
      id,
      compile: () => ({ status: "compiled" as const, pattern: { ...pattern }, bundle: {} as any })
    });

    const first = await trainLanguageCorpusText({ ...input, creativeEventCompiler: compiler("creative.compiler.v1") });
    const counts = Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]));
    expect(fixture.state.patterns.some(row => row.id === pattern.id)).toBe(true);
    expect(await trainLanguageCorpusText({ ...input, creativeEventCompiler: compiler("creative.compiler.v1") })).toEqual(first);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(counts);
    await expect(trainLanguageCorpusText(input)).rejects.toThrow(/checkpoint binding mismatch/iu);
    await expect(trainLanguageCorpusText({ ...input, creativeEventCompiler: compiler("creative.compiler.v2") })).rejects.toThrow(/checkpoint binding mismatch/iu);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(counts);
    expect(fixture.state.sourceVersions.every(row => row.sourceVersionId === first.sourceVersionId)).toBe(true);
    expect(fixture.state.profiles.every(row => row.sourceVersionId === first.sourceVersionId)).toBe(true);
    expect(fixture.state.models.every(row => (row.modelJson as { sourceSystem?: string }).sourceSystem === "gutenberg")).toBe(true);
  });

  it.each(["wikipedia", "oss_code"])("keeps %s recipe changes separate from other source systems", async sourceSystem => {
    const fixture = memoryStorage();
    const text = sourceSystem === "oss_code" ? "export function f9(x: number): number { return x + 1; }" : "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.";
    const wikiBorrowedSpan = sourceSystem === "wikipedia" ? corpusEvidenceSpan("wiki-recipe", text, 0) : undefined;
    if (wikiBorrowedSpan) {
      const bytes = Buffer.from(text, "utf8");
      fixture.state.evidence.push(wikiBorrowedSpan);
      fixture.state.sourceVersions.push({
        sourceId: wikiBorrowedSpan.sourceId, sourceVersionId: wikiBorrowedSpan.sourceVersionId,
        namespace: "corpus:wikipedia", canonicalUri: "wikipedia://enwiki/source-recipes/wiki-recipe",
        contentHash: blobContentHash(bytes) as SourceVersion["contentHash"], byteLength: bytes.byteLength,
        mediaType: "text/plain", observedAt: 1, sourceTrust: {} as any,
        informationLabel: publicCorpusInformationLabel, metadata: { sourceSystem: "wikipedia" }
      });
      fixture.state.blobs.push(bytes);
    }
    const sourceHash = createHasher().digestHex(text);
    const input = { storage: fixture.storage, sourceSystem, streamUri: `fixture://${sourceSystem}`, sourceUri: `fixture://${sourceSystem}`, text,
      createdAt: 1700000000000, informationLabel: publicCorpusInformationLabel, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      ...(sourceSystem === "oss_code" ? { corpusMetadata: toJsonValue({ sourceHash, formalLanguage: "typescript", codeFunctionConstructions: compileSourceCodeFunctions({ text, path: "f9.ts", languageId: "typescript", sourceHash }) }) } : {}),
      ...(wikiBorrowedSpan ? { persistSource: false, evidence: [wikiBorrowedSpan] } : {}),
      corpusCheckpoint: { rootUri: "fixture://source-recipes", itemUri: sourceSystem } };
    const hasher = createHasher();
    const ids = createIdFactory({ clock: createClock(), hasher, namespace: "corpus-training-checkpoint", deterministicReplay: true });
    const oldId = ids.semanticId("corpus_training_checkpoint", { compilerRecipe: LANGUAGE_CORPUS_TRAINING_RECIPE_ID,
      sourceSystem: canonicalCorpusSourceSystemId(sourceSystem), rootUri: input.corpusCheckpoint.rootUri, itemUri: input.corpusCheckpoint.itemUri });
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); }, get: async id => checkpoints.get(id) ?? null, list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    if (sourceSystem === "oss_code") checkpoints.set(oldId, { id: oldId, rootUri: input.corpusCheckpoint.rootUri, itemUri: input.corpusCheckpoint.itemUri, phase: "stored", status: "complete", offsetBytes: 0, updatedAt: 1,
      metadata: { schema: "scce.corpusTrainingCheckpoint.v1", compilerRecipe: LANGUAGE_CORPUS_TRAINING_RECIPE_ID, binding: "old-code-v2", report: { schema: "scce.languageCorpusTrainingReport.v1", languagePatterns: 0 } } });
    const first = await trainLanguageCorpusText(input);
    expect(first.compilerRecipe).toBe(languageCorpusTrainingRecipeId(sourceSystem));
    if (sourceSystem === "wikipedia") {
      expect(first.compilerRecipe).toBe(LANGUAGE_CORPUS_TRAINING_RECIPE_ID);
      expect(checkpoints.has(oldId)).toBe(true);
    } else {
      expect(first.compilerRecipe).toBe(LANGUAGE_CODE_CORPUS_TRAINING_RECIPE_ID);
      expect(first.sourceCodeFunctionPatterns).toBe(1);
      expect(checkpoints.size).toBe(2);
      expect((checkpoints.get(oldId)!.metadata as { binding: string }).binding).toBe("old-code-v2");
    }
    const rows = fixture.state.patterns.length;
    expect(await trainLanguageCorpusText(input)).toEqual(first);
    expect(fixture.state.patterns).toHaveLength(rows);
  });

  it("scopes the source-evidence recipe checkpoint only to full-source extraction", async () => {
    const fixture = memoryStorage();
    const input = { storage: fixture.storage, sourceSystem: "gutenberg", streamUri: "fixture://source-evidence-recipe",
      sourceUri: "fixture://source-evidence-recipe", text: "A full source owns its exact extracted evidence span.",
      createdAt: 1700000000000, informationLabel: publicCorpusInformationLabel, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      corpusCheckpoint: { rootUri: "fixture://source-evidence", itemUri: "full-source.txt" } };
    const ids = createIdFactory({ clock: createClock(), hasher: createHasher(), namespace: "corpus-training-checkpoint", deterministicReplay: true });
    const checkpointKey = { compilerRecipe: LANGUAGE_CORPUS_TRAINING_RECIPE_ID,
      sourceSystem: canonicalCorpusSourceSystemId(input.sourceSystem), rootUri: input.corpusCheckpoint.rootUri, itemUri: input.corpusCheckpoint.itemUri };
    const legacyId = ids.semanticId("corpus_training_checkpoint", checkpointKey);
    const scopedId = ids.semanticId("corpus_training_checkpoint", { ...checkpointKey, sourceEvidenceRecipe: "scce.language_corpus_source_evidence.v1" });
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); },
      get: async id => checkpoints.get(id) ?? null, list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];

    const first = await trainLanguageCorpusText(input);
    expect(first.compilerRecipe).toBe(LANGUAGE_CORPUS_TRAINING_RECIPE_ID);
    expect(checkpoints.has(scopedId)).toBe(true);
    expect(checkpoints.has(legacyId)).toBe(false);
    const beforeReplay = structuredClone(fixture.state);
    expect(await trainLanguageCorpusText(input)).toEqual(first);
    expect(fixture.state).toEqual(beforeReplay);
  });

  it("recompiles a legacy completed recipe under a new derived checkpoint without changing immutable source identities", async () => {
    const fixture = memoryStorage();
    const input = { storage: fixture.storage, sourceSystem: "gutenberg", streamUri: "fixture://versioned-book", sourceUri: "fixture://versioned-book",
      text: "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.", createdAt: 1700000000000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      corpusCheckpoint: { rootUri: "fixture://gutenberg", itemUri: "book.txt" } };
    const legacyIds = createIdFactory({ clock: createClock(), hasher: createHasher(), namespace: "corpus-training-checkpoint", deterministicReplay: true });
    const legacyId = legacyIds.semanticId("corpus_training_checkpoint", { sourceSystem: canonicalCorpusSourceSystemId(input.sourceSystem), rootUri: input.corpusCheckpoint.rootUri, itemUri: input.corpusCheckpoint.itemUri });
    const legacy = { id: legacyId, rootUri: input.corpusCheckpoint.rootUri, itemUri: input.corpusCheckpoint.itemUri, phase: "stored", status: "complete",
      offsetBytes: 0, updatedAt: 1, metadata: { schema: "scce.corpusTrainingCheckpoint.v1", binding: "legacy-binding", report: { schema: "scce.languageCorpusTrainingReport.v1", sourceVersionId: corpusSourceVersionIdFor(input), languageConstructions: 0 } } } as IngestionCheckpoint;
    const checkpoints = new Map([[legacy.id, structuredClone(legacy)]]);
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); }, get: async id => checkpoints.get(id) ?? null, list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    const report = await trainLanguageCorpusText(input);
    expect(report.compilerRecipe).toBe(LANGUAGE_CORPUS_TRAINING_RECIPE_ID);
    expect(report.sourceVersionId).toBe(corpusSourceVersionIdFor(input));
    expect(report.languageConstructions).toBeGreaterThan(0);
    expect(checkpoints.get(legacyId)).toEqual(legacy);
    expect(checkpoints.size).toBe(2);
    expect(fixture.state.sourceVersions.every(source => source.sourceVersionId === report.sourceVersionId)).toBe(true);
    const current = [...checkpoints.values()].find(row => row.id !== legacyId)!;
    (current.metadata as { compilerRecipe: string }).compilerRecipe = "scce.language_corpus_training.v1";
    await expect(trainLanguageCorpusText(input)).rejects.toThrow("checkpoint binding mismatch");
  });

  it("keeps the canonical construction pool separate from a versioned replay-control root", async () => {
    const fixture = memoryStorage();
    const queries = installDurableConstructionPool(fixture);
    const common = { storage: fixture.storage, sourceSystem: "gutenberg", text: "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.",
      createdAt: 1700000000000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 };
    await trainLanguageCorpusText({ ...common, streamUri: "book:first", sourceUri: "fixture://canonical-books/first.txt", corpusCheckpoint: { rootUri: "fixture://canonical-books/", itemUri: "first.txt" } });
    await trainLanguageCorpusText({ ...common, streamUri: "book:next", sourceUri: "fixture://canonical-books/next.txt",
      constructionPoolUriPrefix: "fixture://canonical-books/", corpusCheckpoint: { rootUri: `scce://stored-corpus-replay/gutenberg/${LANGUAGE_CORPUS_TRAINING_RECIPE_ID}`, itemUri: "next.txt" } });
    expect(queries.at(-1)?.includeUriPrefixes).toEqual(["fixture://canonical-books/"]);
    const pool = (fixture.state.events.filter(event => event.typeId === "SymbolPatternLearned").at(-1)!.payload as { constructionPool: { sourceUriPrefix: string; evidenceIds: string[] }; graphProjection: { mode: string } });
    expect(pool.constructionPool.evidenceIds.length).toBeGreaterThan(0);
    expect(pool.constructionPool.sourceUriPrefix).toBe("fixture://canonical-books/");
    expect(pool.graphProjection.mode).toBe("stored_graph_snapshot");
  });

  it("survives a commit acknowledgement loss by replaying the terminal checkpoint", async () => {
    const fixture = memoryStorage();
    const checkpoints = new Map<string, any>();
    fixture.storage.ingestion = {
      put: async (checkpoint: IngestionCheckpoint) => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
      get: async (id: string) => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()]
    } as any;
    const input = {
      storage: fixture.storage,
      sourceSystem: "gutenberg",
      streamUri: "fixture://prepared-book",
      text: "A reader opens a book. Another reader closes the same book. ".repeat(3),
      createdAt: 1700000000000,
      languageOnly: true,
      ngramMaxOrder: 2,
      ngramVocabularyLimit: 32,
      corpusCheckpoint: { rootUri: "fixture://gutenberg", itemUri: "lost-ack.txt", contentHash: "sha256_lost_ack", byteLength: 64 }
    };
    const transaction = fixture.storage.transaction;
    let depth = 0;
    let loseAcknowledgement = true;
    fixture.storage.transaction = async <T>(callback: () => Promise<T>) => {
      depth += 1;
      try {
        const result = await transaction(callback);
        if (depth === 1 && loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("injected commit acknowledgement loss");
        }
        return result;
      } finally {
        depth -= 1;
      }
    };

    await expect(trainLanguageCorpusText(input)).rejects.toThrow("injected commit acknowledgement loss");
    expect([...checkpoints.values()][0].status).toBe("complete");
    const counts = Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]));
    await trainLanguageCorpusText(input);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(counts);
  });

  it("still drops models too when the whole-lane switch is set, which is a different question", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/lane-skipped",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      skipNgramPersistence: true,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(fixture.state.observations.length).toBe(0);
    expect(fixture.state.models.length).toBe(0);
  });

  it("retains observed source grammar without promoting its document-heldout qualification", async () => {
    const fixture = memoryStorage();
    const evidence = [corpusEvidenceSpan("source.no-heldout", constructionFixtureText(), 0)];

    const result = await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/no-heldout",
      text: evidence.map(span => span.text).join("\n"),
      evidence,
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.constructionCandidates).toBeGreaterThan(0);
    expect(result.languageConstructions).toBeGreaterThan(0);
    expect(result.rejectedLanguageConstructions).toBe(0);
    expect(result.constructionAcquisition).toEqual({ sourceObserved: result.languageConstructions, documentHeldOutQualified: 0, rejectedQualification: result.constructionCandidates });
    expect(fixture.state.patterns.filter(isConstructionBundle).every(pattern => (pattern.patternJson as { bundle: { acquisitionStatus: string } }).bundle.acquisitionStatus === "source_observed")).toBe(true);
    expect(symbolPatternLearnedPayload(fixture.state)?.constructionPromotion).toBeDefined();
  });

  it("promotes auto-induced constructions only after a separate held-out slice is covered", async () => {
    const fixture = memoryStorage();
    const evidence = Array.from({ length: 20 }, (_, index) =>
      corpusEvidenceSpan(`source.heldout.${index}`, constructionFixtureText(), index * 10_000)
    );

    const result = await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/heldout",
      text: evidence.map(span => span.text).join("\n"),
      evidence,
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.constructionCandidates).toBeGreaterThan(0);
    expect(result.languageConstructions).toBeGreaterThan(0);
    expect(fixture.state.patterns.some(pattern => isConstructionBundle(pattern))).toBe(true);
    const promotion = symbolPatternLearnedPayload(fixture.state)?.constructionPromotion;
    expect(JSON.stringify(promotion)).toContain("heldOutCoverage");
    expect(JSON.stringify(promotion)).toContain("promotedInducedConstructionSets");
  });

  it("trains a Project Gutenberg fixture into source-stamped language memory", async () => {
    const root = await tempDir("gutenberg-fixture-");
    await writeFile(path.join(root, "book.txt"), [
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "Chapter 1",
      "",
      "The workshop had a patient rhythm. The sentences were public-domain training material.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    const result = await trainGutenbergCorpus({ storage: fixture.storage, rootPath: root, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    expect(result.filesTrained).toBe(1);
    expect(result.totals.ngramObservations).toBe(0);
    expect(fixture.state.observations).toEqual([]);
    expect(result.totals.ngramModels).toBeGreaterThan(0);
    expect(fixture.state.sourceVersions.length).toBe(2);
    const original = fixture.state.sourceVersions.find(source => source.role === "original");
    const derivative = fixture.state.sourceVersions.find(source => source.role === "evidence-derivative");
    expect(original).toBeDefined();
    expect(derivative?.derivation).toMatchObject({
      kind: "extracted-text",
      transformId: "scce.gutenberg.boilerplate-strip.v1",
      derivedFromSourceVersionId: original?.sourceVersionId,
      originalCoordinateSpace: "source-bytes",
      redactionMap: []
    });
    expect(fixture.state.evidence.every(span => span.sourceVersionId === derivative?.sourceVersionId)).toBe(true);
    const rawBytes = Buffer.from([
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "Chapter 1",
      "",
      "The workshop had a patient rhythm. The sentences were public-domain training material.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const derivativeBytes = Buffer.from("Chapter 1\n\nThe workshop had a patient rhythm. The sentences were public-domain training material.", "utf8");
    expect(fixture.state.blobs.some(bytes => Buffer.from(bytes).equals(rawBytes))).toBe(true);
    expect(fixture.state.blobs.some(bytes => Buffer.from(bytes).equals(derivativeBytes))).toBe(true);
    expect(fixture.state.evidence.length).toBeGreaterThan(0);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["gutenberg"]));
    expect(fixture.state.patterns.some(pattern => {
      const row = pattern.patternJson;
      return Boolean(row && typeof row === "object" && !Array.isArray(row)
        && (row as Record<string, JsonValue>).schema === "scce.creative_event_construction_pattern.v1");
    })).toBe(false);
  });

  it("trains OSS docs and code as separate source systems through the engineering corpus scanner", async () => {
    const root = await tempDir("oss-fixture-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "Readable docs explain the pump API and the maintenance flow.", "utf8");
    await writeFile(path.join(root, "src", "pump.ts"), [
      "// Stabilize pump pressure before returning a status object.",
      "export function stabilizePumpPressure(input: number) {",
      "  return { pressureReading: input, stable: input > 0 };",
      "}"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    const result = await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 10, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    // A source file trains twice, into different corpora: its token stream is code, and its comments and
    // identifier words are documentation. One projection cannot be both, and the code lane is unusable for
    // generation if it holds prose.
    expect(result.codeTrained).toBe(1);
    expect(result.docsTrained).toBe(2);
    expect(result.totals.oss_docs.ngramObservations).toBe(0);
    expect(result.totals.oss_code.ngramObservations).toBe(0);
    expect(fixture.state.observations).toEqual([]);
    expect(result.totals.oss_docs.ngramModels).toBeGreaterThan(0);
    expect(result.totals.oss_code.ngramModels).toBeGreaterThan(0);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["oss_docs", "oss_code"]));
    expect(JSON.stringify(result).toLowerCase()).not.toContain("provider");

    const codeReport = result.reports.find(report => report.sourceSystem === "oss_code")!;
    const proseReport = result.reports.find(report => report.streamUri.endsWith("src/pump.ts") && report.sourceSystem === "oss_docs")!;
    expect(codeReport.streamUri.endsWith("src/pump.ts")).toBe(true);
    expect(proseReport).toBeDefined();
    expect(codeReport.languageUnits).toBe(0);
    expect(codeReport.semanticFrames).toBe(0);
    expect(fixture.state.units.some(row => recordOf(row.metadata).sourceSystem === "oss_docs")).toBe(true);
    expect(fixture.state.frames.some(row => recordOf(row.frameJson).sourceSystem === "oss_docs")).toBe(true);
  });

  it("keeps the OSS cursor on a file with an incompletely trained projection", async () => {
    const root = await tempDir("oss-retry-cursor-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "pump.ts"), "export function pumpPressure(input: number) { return input + 1; }\n", "utf8");
    const fixture = memoryStorage();
    const checkpoints = new Map<string, any>();
    fixture.storage.ingestion = {
      put: async (checkpoint: IngestionCheckpoint) => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
      get: async (id: string) => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()]
    } as any;
    const putModels = fixture.storage.languageMemory.putNgramModels;
    let failOnce = true;
    fixture.storage.languageMemory.putNgramModels = async rows => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected projection failure");
      }
      if (!putModels) throw new Error("fixture language model store is unavailable");
      return putModels(rows);
    };

    const first = await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 10, maxFilesPerRun: 1, includeDocs: true, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    expect(first.filesConsidered).toBe(1);
    expect(first.nextFileIndex).toBe(first.startFileIndex);
    expect(first.filesSkipped.some(item => item.reason.includes("training_failed"))).toBe(true);

    const second = await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 10, maxFilesPerRun: 1, includeDocs: true, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    expect(second.filesConsidered).toBe(1);
    expect(second.nextFileIndex).toBe(1);
    expect(second.codeTrained).toBe(1);
    expect(second.docsTrained).toBe(1);
  });

  it("counts an empty projection once so resume advances to the next file", async () => {
    const root = await tempDir("oss-empty-projection-resume-");
    await writeFile(path.join(root, "a-empty.ts"), "", "utf8");
    await writeFile(path.join(root, "b-valid.ts"), "export function validSurface(input: number) { return input + 1; }\n", "utf8");
    const fixture = memoryStorage();

    const result = await trainOssCorpus({
      storage: fixture.storage,
      rootPath: root,
      maxFiles: 10,
      maxFilesPerRun: 2,
      includeDocs: false,
      includeSource: true,
      ngramMaxOrder: 2,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.filesConsidered).toBe(2);
    expect(result.nextFileIndex).toBe(2);
    expect(result.codeTrained).toBe(1);
    expect(result.filesSkipped).toContainEqual(expect.objectContaining({
      path: "a-empty.ts",
      reason: "empty_language_training_projection"
    }));
  });

  it("names every OSS and Gutenberg source version by title and identity at ingest, not by backfill", async () => {
    const ossRoot = await tempDir("oss-identity-fixture-");
    await mkdir(path.join(ossRoot, "src"), { recursive: true });
    await writeFile(path.join(ossRoot, "README.md"), "Readable docs explain the pump API and the maintenance flow.", "utf8");
    await writeFile(path.join(ossRoot, "src", "pump-pressure.ts"), [
      "// Stabilize pump pressure before returning a status object.",
      "export function stabilizePumpPressure(input: number) {",
      "  return { pressureReading: input, stable: input > 0 };",
      "}"
    ].join("\n"), "utf8");
    const oss = memoryStorage();
    await trainOssCorpus({ storage: oss.storage, rootPath: ossRoot, maxFiles: 10, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    expect(oss.state.sourceVersions.length).toBeGreaterThan(0);
    for (const source of oss.state.sourceVersions) {
      expect(nonEmptyString(recordOf(source.metadata).title)).toBe(true);
      expect(nonEmptyString(recordOf(source.metadata).identity)).toBe(true);
    }
    const codeSource = oss.state.sourceVersions.find(source => String(recordOf(source.metadata).relativePath) === "src/pump-pressure.ts")!;
    expect(String(recordOf(codeSource.metadata).title)).toBe("pump pressure");
    // A source file is about what it declares, so the declared name has to survive into the identity.
    expect(String(recordOf(codeSource.metadata).identity)).toContain("stabilizePumpPressure");
    for (const span of oss.state.evidence) {
      expect(nonEmptyString(resolveEvidenceSourceIdentity(span.provenance).title)).toBe(true);
      expect(nonEmptyString(resolveEvidenceSourceIdentity(span.provenance).identity)).toBe(true);
    }

    const gutenbergRoot = await tempDir("gutenberg-identity-fixture-");
    await writeFile(path.join(gutenbergRoot, "moby-dick_or-the-whale.txt"), [
      "The Project Gutenberg eBook of Moby Dick; Or, The Whale",
      "",
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "Call me Ishmael. The workshop had a patient rhythm and the sentences were public-domain material.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const gutenberg = memoryStorage();
    await trainGutenbergCorpus({ storage: gutenberg.storage, rootPath: gutenbergRoot, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    const book = gutenberg.state.sourceVersions[0]!;
    // One title contract, the producer document.ts already uses: separators in a file name are word boundaries.
    expect(String(recordOf(book.metadata).title)).toBe("moby dick or the whale");
    expect(String(recordOf(book.metadata).identity)).toContain("whale");
    for (const span of gutenberg.state.evidence) {
      expect(nonEmptyString(resolveEvidenceSourceIdentity(span.provenance).identity)).toBe(true);
    }
  });

  it("replays Gutenberg identity projection without carrying the removed license into source or evidence identity", async () => {
    const root = await tempDir("gutenberg-identity-replay-");
    await writeFile(path.join(root, "captain-mira.txt"), [
      "The Project Gutenberg eBook of Captain Mira",
      "Copy this license and observe its restrictions when redistributing the ebook.",
      "*** START OF THE PROJECT GUTENBERG EBOOK CAPTAIN MIRA ***",
      "Captain Mira studied the stars above the harbor.",
      "*** END OF THE PROJECT GUTENBERG EBOOK CAPTAIN MIRA ***"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); }, get: async id => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
    const train = () => trainGutenbergCorpus({ storage: fixture.storage, rootPath: root, maxFilesPerRun: 1,
      maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });
    await train();
    const first = fixture.state.sourceVersions.at(-1)!;
    const identity = String(recordOf(first.metadata).identity);
    expect(identity).toContain("captain mira");
    expect(identity).toContain("stars");
    expect(identity).not.toMatch(/license|restrictions|redistributing/iu);
    expect(fixture.state.evidence.every(span => !String(resolveEvidenceSourceIdentity(span.provenance).identity).match(/license|restrictions|redistributing/iu))).toBe(true);

    const current = [...checkpoints.values()][0]!;
    checkpoints.delete(current.id);
    const ids = createIdFactory({ clock: createClock(), hasher: createHasher(), namespace: "corpus-training-checkpoint", deterministicReplay: true });
    const legacyId = ids.semanticId("corpus_training_checkpoint", { compilerRecipe: LANGUAGE_CORPUS_TRAINING_RECIPE_ID,
      sourceSystem: canonicalCorpusSourceSystemId(String(recordOf(current.metadata).sourceSystem)),
      rootUri: current.rootUri, itemUri: "captain-mira.txt", sourceEvidenceRecipe: "scce.language_corpus_source_evidence.v1" });
    checkpoints.set(legacyId, { ...current, id: legacyId, itemUri: "captain-mira.txt",
      metadata: { ...recordOf(current.metadata), itemUri: "captain-mira.txt" } });
    const before = fixture.state.sourceVersions.length;
    await train();
    expect(checkpoints.size).toBe(2);
    expect(fixture.state.sourceVersions.length).toBeGreaterThan(before);
    expect(fixture.state.sourceVersions.at(-1)?.sourceVersionId).toBe(first.sourceVersionId);
    expect(String(recordOf(fixture.state.sourceVersions.at(-1)?.metadata).identity)).toBe(identity);
  });

  it("keeps the code corpus free of prose and the prose corpus free of syntax", async () => {
    const root = await tempDir("oss-projection-fixture-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "pump.ts"), [
      "// Stabilize pump pressure before returning a status object.",
      "export function stabilizePumpPressure(input: number) {",
      "  return { pressureReading: input, stable: input > 0 };",
      "}"
    ].join("\n"), "utf8");

    // Trained separately so each projection can be read on its own.
    const codeOnly = memoryStorage();
    await trainOssCorpus({ storage: codeOnly.storage, rootPath: root, maxFiles: 10, includeDocs: false, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });
    const docsOnly = memoryStorage();
    await trainOssCorpus({ storage: docsOnly.storage, rootPath: root, maxFiles: 10, includeSource: false, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    expect(allSourceSystems(codeOnly.state)).toEqual(new Set(["oss_code"]));
    // includeSource:false skips the file entirely, so no projection of it is trained at all.
    expect(allSourceSystems(docsOnly.state).size).toBe(0);
  });

  it("stops the Gutenberg run gracefully at the heap-safety checkpoint with a resumable report", async () => {
    const root = await tempDir("gutenberg-heap-fixture-");
    await writeFile(path.join(root, "book.txt"), [
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "This text should never be trained because the heap bound trips first.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    // The option floor is 256 MiB; any live Node process running this test
    // suite is far above that, so the checkpoint deterministically trips
    // before the first file -- proving the bound stops the run instead of
    // letting in-process training continue toward a real OOM.
    const result = await trainGutenbergCorpus({
      storage: fixture.storage,
      rootPath: root,
      maxFilesPerRun: 5,
      maxFileBytes: 100_000,
      heapCheckpointMb: 1
    });

    expect(result.stoppedByHeapSafetyBound).toBe(true);
    expect(result.filesTrained).toBe(0);
    expect(result.heapMiBAtExit).toBeGreaterThan(0);
    expect(fixture.state.sourceVersions.length).toBe(0);
  });

  it("preserves canonical compilation through construction-only replay and manual training", async () => {
    const fixture = memoryStorage();
    const text = constructionFixtureText() + " walla r0. wallawalla r0. tinu r0. tinutinu r0. kobo r0. kobokobo r0.";
    await trainLanguageCorpusText({ storage: fixture.storage, sourceSystem: "wikipedia", sourceUri: "https://example.org/canonical-replay", streamUri: "https://example.org/canonical-replay",
      text, createdAt: 1700000000000, informationLabel: publicCorpusInformationLabel, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 17,
      skipNgramObservationPersistence: true });
    expect(fixture.state.patterns.some(isConstructionBundle)).toBe(true);
    expect(fixture.state.patterns.some(row => recordOf(row.patternJson).schema === "scce.induced_language_model.morphology_memory.v1")).toBe(true);
    const canonical = structuredClone({ models: fixture.state.models, units: fixture.state.units, frames: fixture.state.frames,
      receipts: fixture.state.patterns.filter(row => row.patternKind === "source_compilation"
        && recordOf(row.patternJson).schema === "scce.source_language_compilation_receipt.v1") });
    const originalCoverage = structuredClone(fixture.state.patterns.filter(row => row.patternKind === "source_compilation"
      && recordOf(row.patternJson).schema === "scce.source_induction_coverage.v1"));
    const memberships = new Map(fixture.state.patterns.filter(row => row.patternKind !== "source_compilation")
      .map(row => [row.id, recordOf(row.patternJson).sourceCompilationId]));
    installDurableConstructionPool(fixture);
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async query => fixture.state.sourceVersions
      .filter(source => !query?.afterSourceVersionId || source.sourceVersionId > query.afterSourceVersionId)
      .map(source => ({ sourceVersionId: source.sourceVersionId, contentHash: source.contentHash, canonicalUri: source.canonicalUri,
        byteLength: source.byteLength, maxAlpha: 1, promotedSpanCount: fixture.state.evidence.filter(span => span.sourceVersionId === source.sourceVersionId).length }));
    fixture.storage.evidence.sourceVersionsForEvidence = async ids => fixture.state.sourceVersions.filter(source => fixture.state.evidence.some(span => ids.includes(span.id) && span.sourceVersionId === source.sourceVersionId));
    fixture.storage.blobs.get = async hash => { const bytes = fixture.state.blobs.find(bytes => blobContentHash(bytes) === hash); if (!bytes) throw new Error("canonical replay source missing"); return bytes; };
    fixture.storage.languageMemory.putLanguagePatterns = async rows => {
      for (const row of rows) {
        const prior = fixture.state.patterns.findIndex(existing => existing.id === row.id);
        if (prior < 0) fixture.state.patterns.push(row);
        else {
          const membership = recordOf(fixture.state.patterns[prior]!.patternJson).sourceCompilationId;
          fixture.state.patterns[prior] = { ...row, patternJson: { ...(membership !== undefined ? { sourceCompilationId: membership } : {}), ...recordOf(row.patternJson) } };
        }
      }
    };
    const replay = await trainStoredCorpusConstructions({ storage: fixture.storage, sourceSystem: "wikipedia", minArticleBytes: 0, maxTotalBytes: 65536 });
    expect(replay.batchesFailed).toEqual([]);
    expect(replay.reports.some(report => report.languageConstructions > 0)).toBe(true);
    expect(replay.reports.every(report => report.ngramModels === 0 && report.languageUnits === 0 && report.semanticFrames === 0)).toBe(true);
    expect({ models: fixture.state.models, units: fixture.state.units, frames: fixture.state.frames,
      receipts: fixture.state.patterns.filter(row => row.patternKind === "source_compilation"
        && recordOf(row.patternJson).schema === "scce.source_language_compilation_receipt.v1") }).toEqual(canonical);
    const replayedCoverage = fixture.state.patterns.filter(row => row.patternKind === "source_compilation"
      && recordOf(row.patternJson).schema === "scce.source_induction_coverage.v1");
    const withoutReplayAnnotations = (row: typeof replayedCoverage[number]) => {
      const { lane: _lane, replayRecipeId: _replayRecipeId, ...metadata } = recordOf(row.patternJson);
      return { ...row, patternJson: metadata };
    };
    expect(replayedCoverage.map(withoutReplayAnnotations)).toEqual(originalCoverage.map(withoutReplayAnnotations));
    expect(replayedCoverage.every(row => recordOf(row.patternJson).lane === "stored-corpus-construction-replay"
      && recordOf(row.patternJson).replayRecipeId === LANGUAGE_CORPUS_TRAINING_RECIPE_ID)).toBe(true);
    for (const [id, membership] of memberships) expect(recordOf(fixture.state.patterns.find(row => row.id === id)!.patternJson).sourceCompilationId).toBe(membership);
    const beforeManual = structuredClone({ models: fixture.state.models, units: fixture.state.units, frames: fixture.state.frames, patterns: fixture.state.patterns });
    const clock = createClock({ fixedTime: 140000, stepMs: 1 });
    const hasher = createHasher();
    const recorded = storageFixtureForEvaluation({ evidence: fixture.state.evidence, clockNow: () => clock.now() });
    const storage: ScceStorage = { ...recorded.storage, languageMemory: fixture.storage.languageMemory, evidence: { ...recorded.storage.evidence, sourceVersionsForEvidence: fixture.storage.evidence.sourceVersionsForEvidence },
      blobs: fixture.storage.blobs, transaction: fixture.storage.transaction, model: { ...fixture.storage.model,
        readModel: async () => ({ languageProfiles: fixture.state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }) } };
    const kernel = createScceKernel({ storage, clock, idFactory: createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "manual-after-construction-replay" }), deterministicReplay: true,
      files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw new Error("no alternate producer"); } } });
    await kernel.train({ config: { learningGoals: [], promotion: { minTrust: 0.45 } } });
    expect({ models: fixture.state.models, units: fixture.state.units, frames: fixture.state.frames, patterns: fixture.state.patterns }).toEqual(beforeManual);
  });

  it("trains stored-corpus constructions from evidence-backed blobs, prioritized and byte-bounded", async () => {
    const fixture = memoryStorage();
    const article = (title: string, body: string) =>
      `'${title}' is a subject with real prose. ${`${body} The predicate structure recurs across sentences. It recurs again in a second clause. `.repeat(8)}`;
    const high = Buffer.from(article("High Alpha", "The engine was designed by a careful team."));
    const low = Buffer.from(article("Low Alpha", "The bridge was painted by a different crew."));
    const highHash = blobContentHash(high);
    const lowHash = blobContentHash(low);
    const blobs = new Map<string, Buffer>([[highHash, high], [lowHash, low]]);
    (fixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions = async () => [
      { sourceVersionId: "sv-high", contentHash: highHash, canonicalUri: "https://example.org/high", byteLength: high.length, maxAlpha: 0.9, promotedSpanCount: 1 },
      { sourceVersionId: "sv-low", contentHash: lowHash, canonicalUri: "https://example.org/low", byteLength: low.length, maxAlpha: 0.2, promotedSpanCount: 1 }
    ];
    (fixture.storage as unknown as Record<string, unknown>).blobs = {
      get: async (hash: string) => {
        const found = blobs.get(hash);
        if (!found) throw new Error(`missing blob ${hash}`);
        return found;
      },
      put: async (content: Uint8Array) => blobContentHash(content),
      exists: async () => true
    };

    await seedStoredReplaySources(fixture);
    const originalSources = fixture.state.sourceVersions.map(source => String(source.sourceVersionId));
    const originalProfiles = structuredClone(fixture.state.profiles);
    const originalEvidence = fixture.state.evidence.map(span => String(span.id));
    const report = await trainStoredCorpusConstructions({
      storage: fixture.storage,
      batchBytes: 100,
      maxTotalBytes: 4096
    });

    expect(report.schema).toBe("scce.storedCorpusConstructionTrainReport.v1");
    expect(report.batchesFailed).toEqual([]);
    expect(report.batchesTrained).toBeGreaterThanOrEqual(1);
    expect(report.articlesTrained).toBe(2);
    expect(report.batchesFailed).toEqual([]);
    expect(report.stoppedByHeapSafetyBound).toBe(false);
    // Everything trains under the wikipedia corpus identity so hydration
    // clusters pick the constructions up like any other corpus lane.
    expect(allSourceSystems(fixture.state).size).toBeGreaterThan(0);
    expect(report.reports.map(item => item.sourceVersionId)).toEqual(originalSources);
    expect(report.reports.every(item => item.streamUri.startsWith("https://example.org/"))).toBe(true);
    expect(fixture.state.sourceVersions.map(source => String(source.sourceVersionId))).toEqual(originalSources);
    expect(fixture.state.evidence.map(span => String(span.id))).toEqual(originalEvidence);
    expect(fixture.state.models).toEqual([]);
    expect(fixture.state.observations).toEqual([]);
    expect(report.sourcesSkipped).toEqual([]);
    expect(fixture.state.profiles).toEqual(originalProfiles);
    const writes = Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]));
    const replay = await trainStoredCorpusConstructions({ storage: fixture.storage, batchBytes: 100, maxTotalBytes: 4096 });
    expect(replay.batchesFailed).toEqual([]);
    expect(replay.sourcesSkipped).toEqual([]);
    expect(replay.reports).toEqual(report.reports);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(writes);

    // A one-byte total budget still trains the top-priority batch only.
    const boundedFixture = memoryStorage();
    (boundedFixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions =
      (fixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions;
    (boundedFixture.storage as unknown as Record<string, unknown>).blobs = (fixture.storage as unknown as Record<string, unknown>).blobs;
    // Each repeated article is ~1KB; the 1024-byte floor on the total
    // budget admits the top-priority article, then stops before the next.
    await seedStoredReplaySources(boundedFixture);
    const bounded = await trainStoredCorpusConstructions({
      storage: boundedFixture.storage,
      batchBytes: 100,
      maxTotalBytes: 1024
    });
    expect(bounded.articlesTrained).toBe(1);
  });

  it("asks the graph for the batch's own slice, so the construction lane has surfaces to align to", async () => {
    const article = (title: string, body: string) =>
      `'${title}' is a subject with real prose. ${`${body} The predicate structure recurs across sentences. It recurs again in a second clause. `.repeat(8)}`;
    const blob = Buffer.from(article("Graph Bound", "The engine was designed by a careful team."));
    const fixture = memoryStorage();
    (fixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions = async () => [
      { sourceVersionId: "sv-graph", contentHash: blobContentHash(blob), canonicalUri: "https://example.org/graph", byteLength: blob.length, maxAlpha: 0.9, promotedSpanCount: 1 }
    ];
    (fixture.storage as unknown as Record<string, unknown>).blobs = {
      get: async () => blob,
      put: async (content: Uint8Array) => blobContentHash(content),
      exists: async () => true
    };
    // The graph was projected from the original ingestion's spans, so the lane looks them up by source version.
    (fixture.storage.evidence as unknown as Record<string, unknown>).searchEvidence = async () =>
      [{ span: { id: "evidence.original" }, score: 1 }];
    const sliceQueries: Array<Record<string, unknown>> = [];
    (fixture.storage as unknown as Record<string, unknown>).graph = {
      getSlice: async (query: Record<string, unknown>) => {
        sliceQueries.push(query);
        return { nodes: [], edges: [], hyperedges: [], bounded: true, query };
      }
    };

    await seedStoredReplaySources(fixture);
    const report = await trainStoredCorpusConstructions({ storage: fixture.storage, batchBytes: 4096, maxTotalBytes: 65_536 });

    // Alignment lattices are built only from a batch that carries its graph. Training used to pass none at all,
    // so the construction lane compiled nothing on every run the trainer had ever made.
    expect(report.batchesFailed).toEqual([]);
    expect(report.batchesTrained).toBeGreaterThanOrEqual(1);
    expect(sliceQueries.length).toBeGreaterThan(0);
    expect((sliceQueries[0]!.evidenceIds as unknown[]).length).toBeGreaterThan(0);
    expect(report.batchesFailed).toEqual([]);
  });

  it("replays the selected existing corpus, including file sources, and excludes generated training derivatives", async () => {
    const fixture = memoryStorage();
    const text = "the feed reading provides the observed baseline. compare the reading with the earlier baseline. ";
    const versions = ["dialogue-a", "dialogue-b", "other-corpus", "old-generated"].map(id => ({ sourceVersionId: id,
      contentHash: blobContentHash(Buffer.from(text)), canonicalUri: id === "old-generated" ? "scce://construction-training/dialogue/batch-0000" : `file:///corpus/${id}.txt`,
      byteLength: Buffer.byteLength(text), maxAlpha: 1, promotedSpanCount: 1 }));
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async () => [...versions].sort((left, right) => left.sourceVersionId.localeCompare(right.sourceVersionId)) as any;
    fixture.storage.blobs.get = async () => Buffer.from(text);
    await seedStoredReplaySources(fixture, "dialogue");
    fixture.state.sourceVersions.find(source => String(source.sourceVersionId) === "other-corpus")!.metadata = { sourceSystem: "gutenberg" };
    fixture.state.sourceVersions.find(source => String(source.sourceVersionId) === "old-generated")!.metadata = { sourceSystem: "dialogue", derivation: "construction_training" };
    const sources = structuredClone(fixture.state.sourceVersions);
    const profiles = structuredClone(fixture.state.profiles);
    const evidence = structuredClone(fixture.state.evidence);
    const report = await trainStoredCorpusConstructions({ storage: fixture.storage, sourceSystem: "dialogue", minArticleBytes: 0,
      maxTotalBytes: 4096, batchBytes: 1024 });
    expect(report.batchesFailed).toEqual([]);
    expect(report.articlesTrained).toBe(2);
    expect(report.reports.map(row => row.sourceVersionId)).toEqual(["dialogue-a", "dialogue-b"]);
    expect(report.sourcesSkipped).toEqual([
      { sourceVersionId: "old-generated", reason: "derived_training_source" },
      { sourceVersionId: "other-corpus", reason: "different_or_undeclared_source_system" }
    ]);
    expect(fixture.state.sourceVersions).toEqual(sources);
    expect(fixture.state.profiles).toEqual(profiles);
    expect(fixture.state.evidence).toEqual(evidence);
    expect(fixture.state.models).toEqual([]);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["dialogue"]));
    expect(fixture.state.patterns.every(pattern => pattern.informationLabel?.exportClass === "restricted")).toBe(true);
  });

  it("resumes a bounded source page without rereading earlier blobs and reports article-bound exclusions", async () => {
    const fixture = memoryStorage();
    const prose = "the feed reading is the observed baseline. compare that reading with the earlier baseline. ".repeat(30);
    const texts = new Map([["sv-a-small", "x"], ["sv-b", prose], ["sv-c", prose], ["sv-d", prose], ["sv-z-large", prose.repeat(5)]]);
    const versions = [...texts].map(([id, text]) => ({ sourceVersionId: id, contentHash: blobContentHash(Buffer.from(text)), canonicalUri: `https://example.org/${id}`,
      byteLength: Buffer.byteLength(text), maxAlpha: 1, promotedSpanCount: 1 }));
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async () => versions as any;
    const blobs = new Map([...texts.values()].map(text => [blobContentHash(Buffer.from(text)), Buffer.from(text)]));
    fixture.storage.blobs.get = async hash => { const bytes = blobs.get(hash); if (!bytes) throw new Error(`missing fixture blob ${hash}`); return bytes; };
    await seedStoredReplaySources(fixture);
    const after = (query: any) => versions.filter(row => !query.afterSourceVersionId || row.sourceVersionId > query.afterSourceVersionId);
    const eligible = (query: any) => after(query).filter(row => row.byteLength >= (query.minByteLength ?? 0) && row.byteLength <= (query.maxByteLength ?? Infinity));
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async query => query?.orderBySourceVersionId ? eligible(query).slice(0, query.limit) as any : [];
    fixture.storage.evidence.countEvidenceBackedSourceVersions = async (query = {}) => ({ evidenceBackedSources: after(query).length, derivedTrainingSources: 0, eligibleSources: eligible(query).length,
      belowMinArticleBytes: after(query).filter(row => row.byteLength < (query.minByteLength ?? 0)).length,
      aboveMaxArticleBytes: after(query).filter(row => row.byteLength > (query.maxByteLength ?? Infinity)).length });
    const read: string[] = [];
    const get = fixture.storage.blobs.get;
    fixture.storage.blobs.get = async hash => { read.push(String(hash)); return get(hash); };
    const options = { storage: fixture.storage, minArticleBytes: 100, maxArticleBytes: 10_000, maxTotalBytes: 1024, sourcePageSize: 1 };
    const first = await trainStoredCorpusConstructions(options);
    expect(first.inventory).toEqual({ evidenceBackedSources: 5, derivedTrainingSources: 0, eligibleSources: 3, belowMinArticleBytes: 1, aboveMaxArticleBytes: 1 });
    expect(first.nextSourceVersionId).toBe("sv-b");
    expect(first.exhausted).toBe(false);
    expect(first.eligibleSourcesRemaining).toBe(2);
    expect(read).toEqual([blobContentHash(Buffer.from(texts.get("sv-b")!))]);
    read.length = 0;
    const second = await trainStoredCorpusConstructions({ ...options, afterSourceVersionId: first.nextSourceVersionId! });
    expect(second.nextSourceVersionId).toBe("sv-c");
    expect(second.eligibleSourcesRemaining).toBe(1);
    expect(read).toEqual([blobContentHash(Buffer.from(texts.get("sv-c")!))]);
    read.length = 0;
    const last = await trainStoredCorpusConstructions({ ...options, afterSourceVersionId: second.nextSourceVersionId! });
    expect(last.nextSourceVersionId).toBe("sv-d");
    expect(last.exhausted).toBe(true);
    expect(last.eligibleSourcesRemaining).toBe(0);
    expect(read).toEqual([blobContentHash(Buffer.from(texts.get("sv-d")!))]);
  });

  it("crosses the old 100000-source ceiling using summaries and never hydrates a skipped legacy batch", async () => {
    const fixture = memoryStorage();
    const text = "the feed reading is the observed baseline. compare that reading with the earlier baseline. ".repeat(30);
    const lastIndex = 100_002;
    const lastId = `sv-${String(lastIndex).padStart(6, "0")}`;
    const version = { sourceVersionId: lastId, contentHash: blobContentHash(Buffer.from(text)), canonicalUri: "https://example.org/last",
      byteLength: Buffer.byteLength(text), maxAlpha: 1, promotedSpanCount: 1 };
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async () => [version] as any;
    fixture.storage.blobs.get = async () => Buffer.from(text);
    await seedStoredReplaySources(fixture);
    const pages: number[] = [];
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async (query = {}) => {
      if (!query.orderBySourceVersionId) return [];
      const first = query.afterSourceVersionId ? Number(query.afterSourceVersionId.slice(3)) + 1 : 0;
      const length = Math.min(query.limit!, lastIndex - first + 1);
      pages.push(length);
      return Array.from({ length: Math.max(0, length) }, (_, offset) => ({ ...version,
        sourceVersionId: `sv-${String(first + offset).padStart(6, "0")}` })) as any;
    };
    fixture.storage.evidence.countEvidenceBackedSourceVersions = async () => ({ evidenceBackedSources: lastIndex + 1, derivedTrainingSources: 0, eligibleSources: lastIndex + 1,
      belowMinArticleBytes: 0, aboveMaxArticleBytes: 0 });
    let blobReads = 0;
    let profileReads = 0;
    fixture.storage.blobs.get = async () => { blobReads++; return Buffer.from(text); };
    const profiles = fixture.storage.model.listLanguageProfiles;
    fixture.storage.model.listLanguageProfiles = async query => { profileReads++; return profiles(query); };
    const report = await trainStoredCorpusConstructions({ storage: fixture.storage, startBatchIndex: lastIndex, sourcePageSize: 128,
      batchBytes: 1024, maxTotalBytes: 1024, minArticleBytes: 0 });
    expect(report.batchesFailed).toEqual([]);
    expect(report.sourcesSkipped).toEqual([]);
    expect(report.articlesTrained).toBe(1);
    expect(report.legacyBatchSourcesSkipped).toBe(lastIndex);
    expect(report.nextSourceVersionId).toBe(lastId);
    expect(report.exhausted).toBe(true);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(length => length <= 128)).toBe(true);
    expect(blobReads).toBe(1);
    expect(profileReads).toBe(1);
  });

  it.each([undefined, "42703"])("bounds failed replay work and stops a systemic storage failure immediately: %s", async code => {
    const fixture = memoryStorage();
    const text = "the feed reading is the observed baseline. compare that reading with the earlier baseline. ".repeat(30);
    const versions = ["sv-fail-a", "sv-fail-b", "sv-fail-c"].map(sourceVersionId => ({ sourceVersionId,
      contentHash: blobContentHash(Buffer.from(text)), canonicalUri: `https://example.org/${sourceVersionId}`,
      byteLength: Buffer.byteLength(text), maxAlpha: 1, promotedSpanCount: 1 }));
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async () => versions as any;
    fixture.storage.blobs.get = async () => Buffer.from(text);
    await seedStoredReplaySources(fixture);
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async query => query?.orderBySourceVersionId ? versions as any : [];
    fixture.storage.evidence.countEvidenceBackedSourceVersions = async () => ({ evidenceBackedSources: 3, derivedTrainingSources: 0,
      eligibleSources: 3, belowMinArticleBytes: 0, aboveMaxArticleBytes: 0 });
    let reads = 0;
    fixture.storage.blobs.get = async () => { reads++; return Buffer.from(text); };
    fixture.storage.languageMemory.putLanguagePatterns = async () => { throw Object.assign(new Error("fixture training storage failure"), code ? { code } : {}); };
    const report = await trainStoredCorpusConstructions({ storage: fixture.storage, minArticleBytes: 0, maxTotalBytes: code ? 20_000 : 1024 });
    expect(reads).toBe(1);
    expect(report.sourcesAttempted).toBe(1);
    expect(report.bytesScheduled).toBe(Buffer.byteLength(text));
    expect(report.bytesTrained).toBe(0);
    expect(report.batchesFailed).toHaveLength(1);
    expect(report.batchesFailed[0]!.sourceVersionId).toBe("sv-fail-a");
    expect(report.exhausted).toBe(false);
    if (code) {
      expect(report.stoppedByStorageFailure).toBe(true);
      expect(report.storageFailure?.code).toBe(code);
      expect(report.nextSourceVersionId).toBeNull();
    } else {
      expect(report.stoppedByStorageFailure).toBe(false);
      expect(report.nextSourceVersionId).toBe("sv-fail-a");
    }
  });

  it("bounds attempted documents even when every failed source declares zero bytes", async () => {
    const fixture = memoryStorage();
    const versions = Array.from({ length: 10 }, (_, index) => ({ sourceVersionId: `sv-zero-${index}`, contentHash: "sha256_empty",
      canonicalUri: `https://example.org/zero-${index}`, byteLength: 0, maxAlpha: 1, promotedSpanCount: 1 }));
    fixture.storage.evidence.listEvidenceBackedSourceVersions = async () => versions as any;
    let attempts = 0;
    fixture.storage.evidence.searchEvidence = async () => { attempts++; throw new Error("fixture unavailable evidence"); };
    const report = await trainStoredCorpusConstructions({ storage: fixture.storage, minArticleBytes: 0, maxSourceAttempts: 2 });
    expect(attempts).toBe(2);
    expect(report.sourcesAttempted).toBe(2);
    expect(report.bytesScheduled).toBe(0);
    expect(report.sourcesSkipped).toHaveLength(2);
    expect(report.exhausted).toBe(false);
    expect(report.nextSourceVersionId).toBe("sv-zero-1");
  });

  it("records one file's training failure as an explicit skip and keeps training the rest", async () => {
    const root = await tempDir("oss-failure-fixture-");
    await writeFile(path.join(root, "README.md"), "Readable docs explain the pump API and the maintenance flow.", "utf8");
    await writeFile(path.join(root, "SECURITY.md"), "Report vulnerabilities through the responsible disclosure flow.", "utf8");
    const fixture = memoryStorage();
    // A storage whose language-memory writes fail exactly once poisons the
    // first file's training transaction; the second file must still train.
    let failures = 0;
    const poisoned = {
      ...fixture.storage,
      languageMemory: {
        ...fixture.storage.languageMemory,
        putNgramObservationsBatch: async (rows: unknown[]) => {
          if (failures === 0) {
            failures += 1;
            throw new Error("synthetic language-memory write failure");
          }
          return fixture.storage.languageMemory.putNgramObservationsBatch(rows as never);
        }
      }
    } as typeof fixture.storage;

    const result = await trainOssCorpus({
      storage: poisoned,
      rootPath: root,
      maxFiles: 10,
      maxFileBytes: 100_000,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.stoppedByHeapSafetyBound).toBe(false);
    expect(result.docsTrained).toBe(1);
    expect(result.filesSkipped.some(row => row.reason.startsWith("training_failed: synthetic language-memory write failure"))).toBe(true);
  });
});

describe("raw Wikipedia shares the canonical language compiler", () => {
  it.each([undefined, MIN_WIKIPEDIA_MAX_ARTICLE_CHARS])("ingests raw pages once and reports a clipped surface instead of claiming full training: %s", async maxArticleChars => {
    const root = await tempDir("wiki-shared-compiler-");
    const dumpPath = path.join(root, "enwiki-fixture.xml.bz2");
    const indexPath = path.join(root, "index.txt");
    const body = (await readFile(new URL("../../../kernel/src/__tests__/fixtures/animalia-source.md", import.meta.url), "utf8")).repeat(3);
    const xml = `<mediawiki><page><title>Animalia</title><ns>0</ns><id>1</id><revision><id>11</id><text xml:space="preserve">${body.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</text></revision></page></mediawiki>`;
    await writeFile(dumpPath, execFileSync("python", ["-c", "import bz2,sys;sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read()))"], { input: xml, windowsHide: true }));
    await writeFile(indexPath, "0:1:Animalia\n");
    const fixture = memoryStorage();
    const checkpoints = new Map<string, IngestionCheckpoint>();
    fixture.storage.ingestion = { put: async (row: IngestionCheckpoint) => { checkpoints.set(row.id, structuredClone(row)); },
      get: async (id: string) => checkpoints.get(id) ?? null,
      list: async (query: any) => [...checkpoints.values()].filter(row => row.rootUri === query.rootUri && (!query.status || row.status === query.status)
        && (!query.phase || row.phase === query.phase) && (!query.itemUriPrefix || row.itemUri.startsWith(query.itemUriPrefix)))
        .sort((left, right) => right.offsetBytes - left.offsetBytes).slice(0, query.limit) } as any;
    const blobs = new Map<string, Uint8Array>();
    fixture.storage.blobs.put = async bytes => { const hash = blobContentHash(bytes); blobs.set(hash, Uint8Array.from(bytes)); return hash; };
    fixture.storage.blobs.get = async hash => { const bytes = blobs.get(String(hash)); if (!bytes) throw new Error("missing fixture blob"); return bytes; };
    fixture.storage.evidence.getEvidenceBatch = async ids => fixture.state.evidence.filter(span => ids.includes(span.id));
    fixture.storage.evidence.searchEvidence = async query => fixture.state.evidence.filter(span => !query.sourceVersionId || String(span.sourceVersionId) === String(query.sourceVersionId))
      .map(span => ({ span, score: span.alpha, reason: "exact raw source" }));
    const nodes = new Map<string, any>();
    const edges = new Map<string, any>();
    const hyperedges = new Map<string, any>();
    fixture.storage.graph.upsertNodes = async rows => { for (const row of rows) nodes.set(String(row.id), structuredClone(row)); };
    fixture.storage.graph.upsertEdges = async rows => { for (const row of rows) edges.set(String(row.id), structuredClone(row)); };
    fixture.storage.graph.upsertHyperedges = async rows => { for (const row of rows) hyperedges.set(String(row.id), structuredClone(row)); };
    fixture.storage.graph.getSlice = async query => ({ query, bounded: true, nodes: [...nodes.values()], edges: [...edges.values()],
      hyperedges: [...hyperedges.values()].filter(row => !query.evidenceIds?.length || row.evidenceIds.some((id: string) => query.evidenceIds!.map(String).includes(id))) });
    const config = { runtime: { tempRoot: root, maxChunkBytes: 65536, corpora: { wikipedia: { enabled: true, dumpPath, indexPath,
      maxPagesPerRun: 0, maxBlocksPerRun: 0, ngramShardChars: 100000, memorySafetyBoundMb: 100000,
      ...(maxArticleChars === undefined ? {} : { maxArticleChars }) } } } } as any;
    const ingestor = createWikipediaV3Ingestor({ storage: fixture.storage, config });
    const publish = vi.spyOn(ingestor as any, "registerActiveWikipediaImport").mockResolvedValue(undefined);
    const prepare = vi.spyOn(corpusTrainer, "prepareLanguageCorpusTraining");
    const commit = vi.spyOn(corpusTrainer, "commitLanguageCorpusTraining");
    try {
      const first = await ingestor.ingest({ dumpPath });
      expect(first.pages).toBe(1);
      expect(first.truncatedPages).toBe(maxArticleChars === undefined ? 0 : 1);
      if (maxArticleChars === undefined) expect(first.truncatedCharacters).toBe(0);
      else expect(first.truncatedCharacters).toBeGreaterThan(0);
      const original = fixture.state.sourceVersions.find(source => source.role === "original")!;
      expect(Buffer.from(await fixture.storage.blobs.get(original.contentHash)).toString("utf8")).toBe(body);
      expect(first.languagePatterns).toBeGreaterThan(0);
      const asked = fixture.state.events.find(event => event.typeId === "OwnerAsked")!;
      expect((asked.payload as any).inputManifest.semantics.config.languageTrainingRecipeId).toBe(corpusTrainer.languageCorpusTrainingRecipeId("wikipedia"));
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledTimes(1);
      const input = prepare.mock.calls[0]![0];
      expect(input.persistSource).toBe(false);
      expect(input.graphSnapshotAdditions).toBeDefined();
      expect(fixture.state.profiles).toHaveLength(1);
      const sourceIds = new Set(fixture.state.evidence.map(span => String(span.sourceVersionId)));
      expect(sourceIds.has(String(input.sourceVersionId))).toBe(false);
      const restored = hydrateLanguageConstructionPatterns({ patterns: fixture.state.patterns, evidence: fixture.state.evidence, hasher: createHasher() });
      expect(restored.rejected).toEqual([]);
      expect(restored.bundles.length).toBeGreaterThan(0);
      expect(restored.bundles.every(bundle => bundle.sourceVersionIds.every(id => sourceIds.has(id)))).toBe(true);
      for (const bundle of restored.bundles) for (const example of bundle.sourceExamples) {
        const span = fixture.state.evidence.find(row => String(row.id) === example.evidenceId)!;
        expect([...span.text].slice(example.surfaceStartCodePoint, example.surfaceEndCodePoint).join("")).toBe(example.surface);
      }
      const counts = [fixture.state.sourceVersions.length, fixture.state.evidence.length, fixture.state.profiles.length, fixture.state.patterns.length, fixture.state.models.length];
      const resumed = await ingestor.ingest({ dumpPath });
      expect(resumed.pages).toBe(0);
      expect((publish.mock.calls.at(-1)?.[0] as any).fullTrainingComplete).toBe(maxArticleChars === undefined);
      expect((publish.mock.calls.at(-1)?.[0] as any).result.truncatedPages).toBe(maxArticleChars === undefined ? 0 : 1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect([fixture.state.sourceVersions.length, fixture.state.evidence.length, fixture.state.profiles.length, fixture.state.patterns.length, fixture.state.models.length]).toEqual(counts);
    } finally { prepare.mockRestore(); commit.mockRestore(); publish.mockRestore(); }
  }, 120_000);
});

describe("dialogue corpus training", () => {
  const ownerLabel: InformationLabel = {
    tenantId: "owner.tenant",
    principals: ["owner.principal"],
    compartments: [],
    exportClass: "restricted",
    mergePolicy: "isolated"
  };

  it("acquires creative source events through ordinary human dialogue training without a caller compiler", async () => {
    const root = await tempDir("dialogue-human-creative-");
    await writeFile(path.join(root, "dialogue.json"), JSON.stringify(humanCreativePair), "utf8");
    const fixture = memoryStorage();
    const result = await trainDialogueCorpus({ storage: fixture.storage, rootPath: root, authorship: "human_authored", informationLabel: ownerLabel,
      ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64, maxFilesPerRun: 1 });
    expect(result.filesSkipped).toEqual([]);
    expect(result.filesTrained).toBe(1);
    const patterns = fixture.state.patterns.filter(pattern => (pattern.patternJson as { schema?: string }).schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA);
    expect(patterns).toHaveLength(1);
    const restarted = createLanguageMemoryRuntime({ hasher: createHasher() }).hydrate({ models: [], patterns: JSON.parse(JSON.stringify(fixture.state.patterns)), constructionEvidence: fixture.state.evidence });
    expect(restarted.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []).length).toBeGreaterThan(0);
    expect(restarted.creativeEventCompatibilityModels.some(model => model.reliability === "source_observed")).toBe(true);
    expect(compileCreativeRequestFrameFromCompatibilityModels({ requestText: humanCreativePair.turns[0]!.surface,
      models: restarted.creativeEventCompatibilityModels, hasher: createHasher() })?.arguments.length).toBeGreaterThan(0);
    expect(patterns.every(pattern => informationLabelOf(pattern.informationLabel).exportClass === "restricted")).toBe(true);
  });

  it("trains human-authored dialogue as its own source system, never as corrections or gutenberg", async () => {
    const root = await tempDir("dialogue-fixture-");
    await writeFile(path.join(root, "session.txt"), [
      "so what do you think of that?",
      "honestly not much. it reads fine but it does not answer me.",
      "fair enough. want me to try again?",
      "yeah go on then."
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    const result = await trainDialogueCorpus({
      storage: fixture.storage,
      rootPath: root,
      authorship: "human_authored",
      informationLabel: ownerLabel,
      maxFilesPerRun: 1,
      maxFileBytes: 100_000,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.filesTrained).toBe(1);
    expect(result.totals.ngramModels).toBeGreaterThan(0);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["dialogue"]));
    expect(result.corpusRoleId).toBe(CORPUS_ROLE_IDS.dialogue);
    expect(result.totals.ngramObservations).toBe(0);
    expect(fixture.state.observations).toEqual([]);
    expect(result.corpusRoleId).not.toBe(CORPUS_ROLE_IDS.interactionCorrection);
    expect(fixture.state.models.every(row => informationLabelOf(row.informationLabel).exportClass !== "public")).toBe(true);
  });

  it("compiles declared source turns through the normal trainer and rehydrates exact antecedent-bound roles", async () => {
    const root = await tempDir("dialogue-declared-");
    const fixture = memoryStorage();
    fixture.storage.evidence.searchEvidence = async query => fixture.state.evidence
      .filter(span => !query.sourceVersionId || String(span.sourceVersionId) === String(query.sourceVersionId))
      .map(span => ({ span, score: 1, reason: "exact source version" }));
    for (const [document, filler] of ["pump", "supply", "return", "outlet"].entries()) {
      const lines = [`the ${filler} feed reads high`, `compare the ${filler} feed reading with the prior baseline before adjusting the setting`,
        "what value did the record show", "the record showed seven hundred units"];
      const record = "source log: first measurement = seven hundred units";
      const speechText = lines.join("\n");
      const text = `${speechText}\n${record}`;
      const recordStart = [...speechText].length + 1;
      let start = 0;
      const turns = lines.map((surface, index) => {
        const startCodePoint = start;
        start += [...surface].length + 1;
        return { index, speakerId: index % 2 ? "technician" : "operator", surface, startCodePoint, endCodePoint: start - 1,
          ...(index % 2 ? { replyToTurnIndex: index - 1, commitmentScope: index === lines.length - 1 ? "external" : "conversation" } : {}),
          ...(index === lines.length - 1 ? { supportingSourceRanges: [{ startCodePoint: recordStart, endCodePoint: [...text].length, surface: record }] } : {}) };
      });
      await writeFile(path.join(root, `${document}.json`), JSON.stringify({ schema: "scce.dialogue_transcript.v1", text, turns }), "utf8");
    }
    const result = await trainDialogueCorpus({ storage: fixture.storage, rootPath: root, authorship: "human_authored", informationLabel: ownerLabel,
      ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });
    expect(result.filesTrained).toBe(4);
    expect(result.filesSkipped).toEqual([]);
    expect(result.communicativeActs.induction.adjacentPairs).toBe(8);
    expect(result.conversationalConstructions.patternsPersisted).toBeGreaterThan(0);
    const persisted = JSON.parse(JSON.stringify(fixture.state.patterns)) as LanguagePatternRecord[];
    const hydrated = hydrateLanguageConstructionPatterns({ patterns: persisted.filter(isLanguageConstructionPattern), evidence: fixture.state.evidence, hasher: createHasher() });
    expect(hydrated.rejected).toEqual([]);
    expect(hydrated.bundles.length).toBeGreaterThan(0);
    const conversational = hydrated.bundles.filter(bundle => bundle.bindingId.startsWith("surface.conversational_act.binding."));
    expect(conversational.length).toBeGreaterThan(0);
    expect(conversational.flatMap(bundle => bundle.sourceExamples).every(example => Boolean(example.antecedent?.surface))).toBe(true);
    expect(classifyRequestCommunicativeAct("the pump feed reads high", requestCommunicativeActModelFromPatterns(persisted)).actId).not.toBe("actshape.neutral");
    expect(fixture.state.evidence.every(span => !span.text.includes('"schema"'))).toBe(true);
    const corrupted = JSON.parse(JSON.stringify(persisted)) as LanguagePatternRecord[];
    const changed = corrupted.find(pattern => pattern.id === conversational[0]!.id)!;
    const changedBundle = (changed.patternJson as any).bundle;
    changedBundle.sourceExamples[0].antecedent.surface = "forged preceding request";
    expect(hydrateLanguageConstructionPatterns({ patterns: [changed], evidence: fixture.state.evidence, hasher: createHasher() }).bundles).toEqual([]);
    const restarted = conversationalSession({ learned: { patterns: persisted, evidence: JSON.parse(JSON.stringify(fixture.state.evidence)) } });
    const turn = await restarted.turn("the pump feed reads high");
    expect(turn.result.evidence).toEqual([]);
    expect(turn.result.answer).toBe("compare the pump feed reading with the prior baseline before adjusting the setting");
    expect(turn.trace.some(row => row.stage === "mouth.conversational_act_binding.candidate" && row.support?.surface === turn.result.answer)).toBe(true);
  }, 120_000);

  it("learns lowercase multilingual request authority only from declared turns and binds it to owned evidence", async () => {
    const root = await tempDir("dialogue-authority-");
    const fixture = memoryStorage();
    fixture.storage.languageMemory.replaceRequestRequirementPatterns = async input => {
      fixture.state.patterns = fixture.state.patterns.filter(pattern => !(pattern.profileId === input.profileId
        && recordOf(pattern.patternJson).schema === input.schema
        && recordOf(pattern.patternJson).sourceSystem === input.sourceSystem
        && String(recordOf(pattern.patternJson).sourceVersionId) === String(input.sourceVersionId)));
      await fixture.storage.languageMemory.putLanguagePatterns!(input.patterns);
    };
    fixture.storage.evidence.searchEvidence = async query => fixture.state.evidence
      .filter(span => String(span.sourceVersionId) === String(query.sourceVersionId) && span.status === "promoted")
      .map(span => ({ span, score: 1, reason: "exact owner source" }));
    const utterances: Array<{ surface: string; authority?: "factual" | "creative" }> = [
      { surface: "où est le port ancien", authority: "factual" },
      { surface: "où se trouve le port ancien", authority: "factual" },
      { surface: "où est le port ancien", authority: "factual" },
      { surface: "imagine le port comme un jardin suspendu", authority: "creative" },
      { surface: "imagine le port comme un jardin lumineux", authority: "creative" },
      { surface: "imagine le port comme un jardin suspendu", authority: "creative" },
      { surface: "cette phrase déclarée sans autorité ne sera pas apprise" }
    ];
    const surfaces = utterances.flatMap(({ surface }) => [surface, surface.split(/\s+/u).at(-1)!]);
    const text = surfaces.join("\n");
    let cursor = 0;
    const turns = surfaces.map((surface, index) => {
      const startCodePoint = cursor;
      cursor += [...surface].length + 1;
      const label = utterances[Math.floor(index / 2)]!;
      return { index, speakerId: index % 2 ? "assistant" : "user", surface, startCodePoint, endCodePoint: cursor - 1,
        ...(index % 2 === 0 && label.authority ? { requestAuthority: label.authority } : {}),
        ...(index % 2 === 0 ? { sourceCategory: "declared-prompt" } : { replyToTurnIndex: index - 1, commitmentScope: "conversation" as const }) };
    });
    const sourceMetadata = { dataset: "declared-dialogue-fixture", uri: "fixture://dialogue/authority", pinnedRevision: "rev-1", license: "CC BY" };
    await writeFile(path.join(root, "authority.json"), JSON.stringify({ schema: "scce.dialogue_transcript.v1", text, turns, sourceMetadata }), "utf8");
    let sourceSerializations = 0;
    const canonical = kernelPrimitives.canonicalStringify;
    const stringify = vi.spyOn(kernelPrimitives, "canonicalStringify").mockImplementation(value => {
      if (value && typeof value === "object" && "schema" in value && value.schema === "scce.dialogue_transcript.v1") sourceSerializations++;
      return canonical(value);
    });
    const result = await trainDialogueCorpus({ storage: fixture.storage, rootPath: root, authorship: "human_authored", informationLabel: ownerLabel,
      ngramMaxOrder: 2, ngramMaxCountersPerOrder: 32 }).finally(() => stringify.mockRestore());
    expect(sourceSerializations).toBe(1);
    const patterns = fixture.state.patterns.filter(pattern => recordOf(pattern.patternJson).schema === "scce.request_requirement_pattern.v1");
    expect(result.requestAuthorities).toEqual({ examples: 6, evidenceBoundExamples: 6, patternsPersisted: patterns.length });
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.every(pattern => recordOf(pattern.patternJson).sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.dialogue)).toBe(true);
    expect(patterns.some(pattern => recordOf(pattern.patternJson).surface === "imagine"
      && recordOf(pattern.patternJson).requestSpanRole === "control")).toBe(true);
    expect(patterns.some(pattern => recordOf(pattern.patternJson).surface === "suspendu"
      && recordOf(pattern.patternJson).requestSpanRole === "content")).toBe(true);
    for (const pattern of patterns) {
      const record = recordOf(pattern.patternJson);
      expect(record.sourceMetadata).toEqual(sourceMetadata);
      const ranges = record.sourceTurnRanges as Array<{ turnIndex: number; authority: string; startCodePoint: number; endCodePoint: number; evidenceIds: string[];
        responseTurnRange?: { startCodePoint: number; endCodePoint: number; evidenceIds: string[] } }>;
      const featureKey = `${String(record.anchor)}:${String(record.surface)}`;
      const expectedOwners = turns.filter(turn => turn.requestAuthority
        && requestFeatures(turn.surface).some(feature => feature.key === featureKey));
      expect(ranges.map(range => range.turnIndex)).toEqual(expectedOwners.map(turn => turn.index));
      expect(ranges.length).toBeGreaterThanOrEqual(2);
      expect(ranges.every(range => range.authority === "factual" || range.authority === "creative")).toBe(true);
      for (const range of ranges) {
        const owners = fixture.state.evidence.filter(span => range.evidenceIds.includes(String(span.id)));
        expect(owners.length).toBeGreaterThan(0);
        expect(owners.every(span => String(span.sourceVersionId) === String(record.sourceVersionId)
          && span.charStart <= range.startCodePoint && span.charEnd >= range.endCodePoint && span.status === "promoted")).toBe(true);
        const replyOwners = fixture.state.evidence.filter(span => range.responseTurnRange?.evidenceIds.includes(String(span.id)));
        expect(replyOwners.length).toBeGreaterThan(0);
        expect(replyOwners.every(span => span.charStart <= range.responseTurnRange!.startCodePoint
          && span.charEnd >= range.responseTurnRange!.endCodePoint && span.status === "promoted")).toBe(true);
      }
    }
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["dialogue", CORPUS_SOURCE_SYSTEM_IDS.dialogue, REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM]));
    const originalModelIds = fixture.state.models.map(model => model.id);
    const originalVersionIds = fixture.state.sourceVersions.map(version => version.sourceVersionId);
    const revisedTurns = turns.map(turn => turn.requestAuthority ? { ...turn, requestAuthority: "factual" as const } : turn);
    await writeFile(path.join(root, "authority.json"), JSON.stringify({ schema: "scce.dialogue_transcript.v1", text, turns: revisedTurns, sourceMetadata }), "utf8");
    const revised = await trainDialogueCorpus({ storage: fixture.storage, rootPath: root, authorship: "human_authored", informationLabel: ownerLabel, actsOnly: true });
    const revisedPatterns = fixture.state.patterns.filter(pattern => recordOf(pattern.patternJson).schema === "scce.request_requirement_pattern.v1");
    expect(revised.requestAuthorities.examples).toBe(6);
    expect(revisedPatterns.length).toBeGreaterThan(0);
    expect(revisedPatterns.every(pattern => recordOf(pattern.patternJson).selectedAuthority === "factual"
      && (recordOf(pattern.patternJson).sourceTurnRanges as Array<{ authority: string }>).every(range => range.authority === "factual"))).toBe(true);
    const unlabeledTurns = turns.map(({ requestAuthority: _authority, ...turn }) => turn);
    await writeFile(path.join(root, "authority.json"), JSON.stringify({ schema: "scce.dialogue_transcript.v1", text, turns: unlabeledTurns, sourceMetadata }), "utf8");
    const removed = await trainDialogueCorpus({ storage: fixture.storage, rootPath: root, authorship: "human_authored", informationLabel: ownerLabel, actsOnly: true });
    expect(removed.requestAuthorities).toEqual({ examples: 0, evidenceBoundExamples: 0, patternsPersisted: 0 });
    expect(fixture.state.patterns.filter(pattern => recordOf(pattern.patternJson).schema === "scce.request_requirement_pattern.v1")).toEqual([]);
    expect(fixture.state.models.map(model => model.id)).toEqual(originalModelIds);
    expect(fixture.state.sourceVersions.map(version => version.sourceVersionId)).toEqual(originalVersionIds);
  }, 120_000);

  it("refuses to train on SCCE's own generations", async () => {
    const root = await tempDir("dialogue-selftrain-");
    await writeFile(path.join(root, "generated.txt"), "a surface this system produced", "utf8");
    const fixture = memoryStorage();

    await expect(trainDialogueCorpus({
      storage: fixture.storage,
      rootPath: root,
      authorship: "system_generated",
      informationLabel: ownerLabel
    })).rejects.toThrow(/self-training/);
    expect(fixture.state.models.length).toBe(0);
  });

  it("refuses a public export class for a transcript", async () => {
    const root = await tempDir("dialogue-public-");
    await writeFile(path.join(root, "session.txt"), "so what do you think of that?", "utf8");
    const fixture = memoryStorage();

    await expect(trainDialogueCorpus({
      storage: fixture.storage,
      rootPath: root,
      authorship: "human_authored",
      informationLabel: { ...ownerLabel, exportClass: "public" }
    })).rejects.toThrow(/owner-private/);
    expect(fixture.state.models.length).toBe(0);
  });
});

function informationLabelOf(value: InformationLabel | undefined): { exportClass?: string } {
  return value ?? {};
}

function configFixture(corpora: ScceRuntimeConfig["runtime"]["corpora"]): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873" },
    database: { url: "postgresql://user:pass@localhost:5432/scce", schema: "scce_test" },
    runtime: {
      workspaceRoot: ".",
      tempRoot: ".tmp",
      maxFileBytes: 1_000_000,
      maxChunkBytes: 64_000,
      allowedRoots: ["."],
      excludedPaths: ["node_modules", "dist"],
      tools: {},
      corpora
    },
    connectors: {},
    security: {
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" },
      defaultSourceInformationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["test"], exportClass: "restricted", mergePolicy: "isolated" }
    },
    policy: {
      allowMutation: false,
      requireTwoPhaseCommit: true,
      dryRunByDefault: true,
      maxNetworkRequests: 0,
      maxToolCalls: 0,
      maxSpendCents: 0,
      alphaRiskCeiling: 0.5,
      encryptSecretsAtRest: true
    }
  };
}

const corpusTestClock = createClock({ fixedTime: 101_000, stepMs: 1 });
const corpusTestHasher = createHasher();
const corpusTestIds = createIdFactory({
  clock: corpusTestClock,
  hasher: corpusTestHasher,
  deterministicReplay: true,
  namespace: "corpus-training-test"
});
const publicCorpusInformationLabel: InformationLabel = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public",
  mergePolicy: "same_owner"
};

function constructionFixtureText(): string {
  return [
    "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
    "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
  ].join(" ");
}

function corpusEvidenceSpan(sourceVersionKey: string, text: string, charStart: number): EvidenceSpan {
  const bytes = Buffer.from(text, "utf8");
  const contentHash = corpusTestIds.contentHash(bytes);
  const sourceVersionId = corpusTestIds.sourceVersionId(`${sourceVersionKey}\u001f${text}`) as SourceVersionId;
  return {
    id: corpusTestIds.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash: contentHash }),
    sourceId: corpusTestIds.sourceId("fixture", `fixture://${sourceVersionKey}`),
    sourceVersionId,
    chunkId: corpusTestIds.chunkId({ sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: contentHash }),
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: bytes.byteLength,
    charStart,
    charEnd: charStart + [...text].length,
    text,
    textPreview: text.slice(0, 200),
    languageHints: {},
    scriptHints: {},
    trustVector: {},
    provenance: {},
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: corpusTestClock.now(),
    informationLabel: publicCorpusInformationLabel
  };
}

function isConstructionBundle(pattern: LanguagePatternRecord): boolean {
  const row = pattern.patternJson;
  return Boolean(row && typeof row === "object" && !Array.isArray(row)
    && (row as Record<string, JsonValue>).schema === "scce.language_construction_pattern.v1");
}

function symbolPatternLearnedPayload(state: MemoryState): Record<string, JsonValue> | undefined {
  const payload = state.events.find(row => row.typeId === "SymbolPatternLearned")?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, JsonValue>
    : undefined;
}

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

interface MemoryState {
  events: ScceEvent[];
  sourceVersions: SourceVersion[];
  evidence: EvidenceSpan[];
  profiles: LanguageProfile[];
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  frames: SemanticFrameRecord[];
  blobs: Uint8Array[];
}

function memoryStorage(): { storage: ScceStorage; state: MemoryState } {
  const state: MemoryState = {
    events: [],
    sourceVersions: [],
    evidence: [],
    profiles: [],
    observations: [],
    models: [],
    units: [],
    patterns: [],
    frames: [],
    blobs: []
  };
  const storage = {
    events: {
      append: async (event: ScceEvent) => { state.events.push(event); },
      appendBatch: async (events: ScceEvent[]) => { state.events.push(...events); },
      readEpisode: async () => state.events,
      readRange: async () => state.events,
      latestLedgerHash: async () => state.events.at(-1)?.hash ?? ""
    },
    evidence: {
      putSourceVersion: async (source: SourceVersion) => { state.sourceVersions.push(source); },
      putEvidenceSpan: async (span: EvidenceSpan) => { state.evidence.push(span); },
      putEvidenceSpans: async (spans: readonly EvidenceSpan[]) => { state.evidence.push(...spans); },
      promoteEvidence: async (ids: EvidenceSpan["id"][]) => ids.length,
      getEvidence: async () => null,
      getEvidenceBatch: async () => [],
      searchEvidence: async () => [],
      sourceVersionsForEvidence: async () => []
    },
    model: {
      readModel: async () => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async (profile: LanguageProfile) => { state.profiles.push(profile); },
      listLanguageProfiles: async () => state.profiles
    },
    languageMemory: {
      listSourceCompilationArtifactIds: async (query: Parameters<NonNullable<ScceStorage["languageMemory"]["listSourceCompilationArtifactIds"]>>[0]) => compilationArtifactIds(query.family === "units" ? state.units : query.family === "patterns" ? state.patterns : state.frames, query),
      putNgramObservation: async (row: NgramObservation) => { state.observations.push(row); },
      putNgramObservationsBatch: async (rows: readonly NgramObservation[]) => { state.observations.push(...rows); },
      putNgramModel: async (row: NgramModelRecord) => { state.models.push(row); },
      putNgramModels: async (rows: readonly NgramModelRecord[]) => { state.models.push(...rows); },
      putLanguageUnit: async (row: LanguageUnitRecord) => { state.units.push(row); },
      putLanguageUnits: async (rows: readonly LanguageUnitRecord[]) => { state.units.push(...rows); },
      getLanguagePatternProjection: getFixtureLanguagePatternProjection,
      replaceLanguagePatternProjection: replaceFixtureLanguagePatternProjection,
      putLanguagePattern: async (row: LanguagePatternRecord) => { const index = state.patterns.findIndex(pattern => pattern.id === row.id); if (index < 0) state.patterns.push(row); else state.patterns[index] = row; },
      putLanguagePatterns: async (rows: readonly LanguagePatternRecord[]) => { for (const row of rows) { const index = state.patterns.findIndex(pattern => pattern.id === row.id); if (index < 0) state.patterns.push(row); else state.patterns[index] = row; } },
      putSemanticFrame: async (row: SemanticFrameRecord) => { state.frames.push(row); },
      putSemanticFrames: async (rows: readonly SemanticFrameRecord[]) => { state.frames.push(...rows); },
      putTranslationAlignment: async () => undefined,
      listNgramModels: async (query: Parameters<ScceStorage["languageMemory"]["listNgramModels"]>[0]) => state.models.filter(row => (!query?.sourceSystem || recordOf(row.modelJson).sourceSystem === query.sourceSystem) && (!query?.profileIds || query.profileIds.includes(String(recordOf(row.modelJson).profileId)))).slice(0, query?.limit ?? state.models.length),
      listNgramObservations: async () => state.observations,
      listLanguageUnits: async () => state.units,
      listLanguagePatterns: async (query: Parameters<ScceStorage["languageMemory"]["listLanguagePatterns"]>[0]) => state.patterns.filter(row => (!query?.patternIds || query.patternIds.includes(row.id)) && (query?.patternKind ? row.patternKind === query.patternKind : row.patternKind !== "source_compilation") && (!query?.profileIds || query.profileIds.includes(row.profileId)) && (!query?.sourceSystem || recordOf(row.patternJson).sourceSystem === query.sourceSystem) && (!query?.patternSchemas || query.patternSchemas.includes(String(recordOf(row.patternJson).schema)))).slice(0, query?.limit ?? state.patterns.length),
      listSemanticFrames: async () => state.frames,
      listTranslationAlignments: async () => []
    },
    init: async () => undefined,
    transaction: async <T>(fn: () => Promise<T>) => {
      const before = Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, [...rows]]));
      try { return await fn(); } catch (error) { Object.assign(state, before); throw error; }
    },
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined,
    conversation: unusedStore(),
    ingestion: unusedStore(),
    graph: { getSlice: async (query: unknown) => ({ bounded: true, query, nodes: [], edges: [], hyperedges: [] }),
      upsertNodes: async () => undefined, upsertEdges: async () => undefined, upsertHyperedges: async () => undefined },
    blobs: { put: async (bytes: Uint8Array) => { state.blobs.push(new Uint8Array(bytes)); return blobContentHash(bytes); } },
    quarantine: unusedStore(),
    proofs: unusedStore(),
    constructs: unusedStore(),
    capabilities: unusedStore(),
    forecasts: unusedStore(),
    benchmarks: unusedStore(),
    brainImports: unusedStore(),
    corrections: unusedStore(),
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore(),
    dialogueMemory: unusedStore()
  } as unknown as ScceStorage;
  return { storage, state };
}

function installDurableConstructionPool(fixture: ReturnType<typeof memoryStorage>) {
  const queries: Array<Parameters<NonNullable<ScceStorage["evidence"]["listEvidenceBackedSourceVersions"]>>[0]> = [];
  fixture.storage.evidence.listEvidenceBackedSourceVersions = async query => {
    queries.push(query);
    return fixture.state.sourceVersions.flatMap(version => {
      const spans = fixture.state.evidence.filter(span => span.sourceVersionId === version.sourceVersionId && span.status === "promoted"
        && sourceSystemOf(span.provenance) === query?.sourceSystem);
      return spans.length && (!query?.maxByteLength || version.byteLength <= query.maxByteLength)
        && (!query?.includeUriPrefixes?.length || query.includeUriPrefixes.some(prefix => version.canonicalUri.startsWith(prefix)))
        ? [{ sourceVersionId: version.sourceVersionId, contentHash: version.contentHash, canonicalUri: version.canonicalUri, byteLength: version.byteLength, maxAlpha: 1, promotedSpanCount: spans.length }] : [];
    });
  };
  fixture.storage.evidence.searchEvidence = async query => fixture.state.evidence.filter(span => span.sourceVersionId === query.sourceVersionId && span.status === "promoted")
    .sort((left, right) => query.sourceSampleSeed === undefined ? String(left.id).localeCompare(String(right.id))
      : createHash("md5").update(String(left.id) + query.sourceSampleSeed).digest("hex").localeCompare(createHash("md5").update(String(right.id) + query.sourceSampleSeed).digest("hex")))
    .slice(0, query.limit)
    .map(span => ({ span, score: 1, reason: "owned source" }));
  fixture.storage.evidence.getEvidenceBatch = async ids => fixture.state.evidence.filter(span => ids.includes(span.id));
  fixture.storage.evidence.sourceVersionsForEvidence = async ids => fixture.state.sourceVersions.filter(version =>
    fixture.state.evidence.some(span => ids.includes(span.id) && span.sourceVersionId === version.sourceVersionId));
  fixture.storage.model.listLanguageProfiles = async query => fixture.state.profiles.filter(profile => typeof query !== "object" || !query.sourceVersionIds || query.sourceVersionIds.includes(profile.sourceVersionId));
  return queries;
}

function allSourceSystems(state: MemoryState): Set<string> {
  const values = [
    ...state.observations.map(row => sourceSystemOf(row.metadata)),
    ...state.models.map(row => sourceSystemOf(row.modelJson)),
    ...state.units.map(row => sourceSystemOf(row.metadata)),
    ...state.patterns.map(row => sourceSystemOf(row.patternJson)),
    ...state.frames.map(row => sourceSystemOf(row.frameJson))
  ].filter((value): value is string => Boolean(value));
  return new Set(values);
}

function sourceSystemOf(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sourceSystem = (value as Record<string, JsonValue>).sourceSystem;
  return typeof sourceSystem === "string" ? sourceSystem : undefined;
}

function sourceSystemIdOf(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sourceSystemId = (value as Record<string, JsonValue>).sourceSystemId;
  return typeof sourceSystemId === "string" ? sourceSystemId : undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function recordOf(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function unusedStore(): Record<string, (...args: never[]) => Promise<unknown>> {
  return new Proxy({}, { get: () => async () => null }) as Record<string, (...args: never[]) => Promise<unknown>>;
}

async function seedStoredReplaySources(fixture: ReturnType<typeof memoryStorage>, sourceSystem = "wikipedia") {
  const versions = await fixture.storage.evidence.listEvidenceBackedSourceVersions!({});
  for (const version of versions) {
    const bytes = await fixture.storage.blobs.get(version.contentHash);
    const text = Buffer.from(bytes).toString("utf8");
    const informationLabel: InformationLabel = { tenantId: "stored.tenant", principals: ["stored.owner"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
    fixture.state.sourceVersions.push({ sourceId: `source.${version.sourceVersionId}` as SourceVersion["sourceId"], sourceVersionId: version.sourceVersionId,
      namespace: `corpus:${sourceSystem}`, canonicalUri: version.canonicalUri, contentHash: version.contentHash, byteLength: bytes.byteLength,
      mediaType: "text/plain", observedAt: 1, sourceTrust: {} as any, informationLabel, metadata: { sourceSystem } } as SourceVersion);
    fixture.state.profiles.push({ id: `profile.${version.sourceVersionId}`, sourceVersionId: version.sourceVersionId, scripts: [{ script: "Latn", mass: 1 }],
      symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 0, createdAt: 1, informationLabel });
    fixture.state.evidence.push({ id: `evidence.${version.sourceVersionId}`, sourceId: `source.${version.sourceVersionId}`, sourceVersionId: version.sourceVersionId,
      chunkId: `chunk.${version.sourceVersionId}`, contentHash: blobContentHash(bytes), mediaType: "text/plain", byteStart: 0, byteEnd: bytes.byteLength,
      charStart: 0, charEnd: [...text].length, text, textPreview: text, status: "promoted", alpha: 1, observedAt: 1, informationLabel } as EvidenceSpan);
  }
  fixture.storage.evidence.searchEvidence = async query => fixture.state.evidence.filter(span => !query.sourceVersionId || String(span.sourceVersionId) === String(query.sourceVersionId))
    .map(span => ({ span, score: 1, reason: "stored source version" }));
  fixture.storage.evidence.sourceVersionsForEvidence = async ids => fixture.state.sourceVersions.filter(source => fixture.state.evidence
    .some(span => ids.includes(span.id) && String(span.sourceVersionId) === String(source.sourceVersionId)));
  const checkpoints = new Map<string, IngestionCheckpoint>();
  fixture.storage.ingestion = { put: async (checkpoint: IngestionCheckpoint) => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
    get: async (id: string) => checkpoints.get(id) ?? null, list: async () => [...checkpoints.values()] } as any;
}
