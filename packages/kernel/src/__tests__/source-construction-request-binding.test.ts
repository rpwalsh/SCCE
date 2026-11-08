// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { requestValueBindingConstructFact } from "../source-bound-semantic-fact.js";
import { semanticAnswerConstructFacts } from "../semantic-answer-construct.js";
import { semanticAnswerConstructState } from "../mouth-source-facts.js";
import { attachSourceBoundAnswerConstruct } from "../local-evidence-runtime.js";
import { resolveRequestValueBinding } from "../semantic-answer-construct.js";
import { sourceConstructionRequestValueResolver } from "../source-construction-request-binding.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import { CORPUS_ROLE_IDS } from "../corpus-registry.js";
import { induceSourceBoundConstructionTrainingSets } from "../graph-surface-alignment.js";
import { answerCoversRequest } from "../local-evidence-runtime.js";
import { createEvidenceExtractor } from "../evidence.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import type { BuildTestResult, EvidenceSpan, GraphNode, GraphSnapshot, GraphSlice, Hyperedge } from "../types.js";
import { createScceKernel } from "../kernel.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";
import { surfaceSentenceRanges } from "../surface-linguistics.js";
import { sourceOwnedAnswerhoodLanguage } from "./fixtures/source-owned-answerhood-language.js";
import { createTrace } from "../debug/trace.js";
import type { SourceBoundConstructionObservation, SourceConstructionGraphBinding } from "../language-construction-memory.js";
import type { ScceKernelDeps } from "../storage.js";

const hasher = createHasher();
const clock = createClock({ fixedTime: 140_000, stepMs: 1 });
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "typed-request-transfer" });

function evidenceSpan(text: string): EvidenceSpan {
  const sourceVersionId = ids.sourceVersionId(text);
  const languageProfile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 140_000 });
  const extracted = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
    sourceId: ids.sourceId("fixture", "fixture://declared-source"), sourceVersionId, namespace: "fixture", uri: "fixture://declared-source",
    mediaType: "text/plain", text, languageProfile, observedAt: 140_000, maxChunkBytes: Buffer.byteLength(text) + 1,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "fixture", licenseStatus: "fixture" }
  });
  expect(extracted.spans).toHaveLength(1);
  const span = extracted.spans[0]!;
  expect(span.text).toBe(text);
  expect([...text].slice(span.charStart, span.charEnd).join("")).toBe(span.text);
  expect(Buffer.from(text).subarray(span.byteStart, span.byteEnd).toString()).toBe(span.text);
  return { ...span, status: "promoted", alpha: 1 };
}

function teach(input: { subjects: [string, string, string]; marker: string; value: string; valueKind: string; statement?: string; semanticRole?: "entity" | "quantity"; question?: (subject: string) => string }) {
  const questionFor = input.question ?? ((subject: string) => `${subject} ${input.marker}\uFF1F`);
  const questions = input.subjects.slice(0, 2).map(questionFor);
  const text = `${questions.join("\n")}\n${input.statement ?? `${input.subjects[2]} ${input.value}。`}`;
  const evidence = evidenceSpan(text);
  const sourceVersionId = evidence.sourceVersionId;
  const subjectBinding = { relationId: "relation.opaque", roleId: "role.anchor", valueKind: "opaque.entity", semanticRole: "entity" as const };
  const answerBinding = { relationId: "relation.opaque", roleId: "role.answer", valueKind: input.valueKind, semanticRole: input.semanticRole ?? "quantity" as const };
  let start = 0;
  const observations: SourceBoundConstructionObservation[] = questions.map((question, index) => {
    const observation: SourceBoundConstructionObservation = {
      sourceVersionId: String(sourceVersionId), evidenceId: String(evidence.id),
      surfaceStartCodePoint: start, surfaceEndCodePoint: start + [...question].length,
      roles: [{ slotIndex: 0, startCodePoint: [...question.slice(0, question.indexOf(input.subjects[index]!))].length, endCodePoint: [...question.slice(0, question.indexOf(input.subjects[index]!))].length + [...input.subjects[index]!].length, graphBinding: subjectBinding }],
      nullRoles: [{ slotIndex: 1, graphBinding: answerBinding }]
    };
    start += [...question].length + 1;
    return observation;
  });
  const node = (id: string, surface: string) => ({ id, representation: { surface }, metadata: {}, evidenceIds: [evidence.id] }) as unknown as GraphNode;
  const port = (nodeId: string, roleId: string, valueKind: string) => ({
    nodeId, portId: roleId, roleId, valueKind, realization: "observed", evidenceIds: [evidence.id]
  });
  const graph = {
    nodes: [node("node.subject", input.subjects[2]), node("node.value", input.value)], edges: [],
    hyperedges: [{
      schema: "scce.hyperedge.v2", memberNodeIds: ["node.subject", "node.value"],
      qualifiers: {}, modality: {}, weightVector: {}, temporalScope: {}, provenanceRefs: [], createdAt: 140_000, updatedAt: 140_000,
      id: "hyperedge.fact", relationId: "relation.opaque", evidenceIds: [evidence.id],
      participantPorts: [port("node.subject", "role.anchor", "opaque.entity"), port("node.value", "role.answer", input.valueKind)]
    } as unknown as Hyperedge]
  } satisfies GraphSnapshot;
  const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 140_000 });
  const trained = compileLanguageTrainingBatch({
    runtime, hasher,
    batch: {
      streamId: "fixture://typed-request", profile, sourceVersionId, text, evidence: [evidence], createdAt: 140_000,
      constructionSets: [{ bindingId: "request.opaque", observations }], graphSnapshot: graph
    }
  });
  const restarted = createLanguageMemoryRuntime({ idFactory: ids, hasher }).hydrate({
    models: [], patterns: trained.constructionPatterns, constructionEvidence: [evidence]
  });
  expect(restarted.rejectedConstructionPatterns).toEqual([]);
  const bundle = restarted.importedConstructionBundles.find(bundle => bundle.bindingId === "request.opaque");
  expect(bundle).toBeDefined();
  expect(bundle!.sourceExamples[0]!.nullRoles[0]!.graphBinding).toEqual(answerBinding);
  const requestText = questionFor(input.subjects[2]);
  const resolve = (candidateGraph = graph, spans: EvidenceSpan[] = [evidence], request = requestText) => resolveRequestValueBinding({
    requestText: request, evidence: spans,
    resolvers: [sourceConstructionRequestValueResolver({ bundles: restarted.importedConstructionBundles, graph: candidateGraph })]
  });
  return { resolve, graph, evidence, profile, requestText, value: input.value, patterns: trained.constructionPatterns };
}

describe("acquired typed request construction transfer", () => {
  it("hydrates admitted source constructions for factual binding despite a separate wording corpus", async () => {
    const fixture = teach({ subjects: ["Luma", "Vela", "Zora"], marker: "HAS TOKEN", value: "Bora", valueKind: "opaque.token" });
    const gutenbergPatterns = fixture.patterns.map(pattern => ({ ...pattern,
      patternJson: { ...jsonRecord(pattern.patternJson), sourceSystem: "gutenberg" } }));
    const queries: Array<{ profileIds?: readonly string[]; sourceSystem?: string; patternSchemas?: readonly string[] }> = [];
    const storage = {
      brainImports: { active: async () => ({ activeImportRunIds: [] }) },
      model: { listLanguageProfiles: async (query: { sourceVersionIds?: readonly string[] }) =>
        query.sourceVersionIds?.includes(String(fixture.evidence.sourceVersionId)) ? [fixture.profile] : [] },
      languageMemory: { listNgramModels: async () => [], listLanguageUnits: async () => [], listSemanticFrames: async () => [],
        listLanguagePatterns: async (query: { profileIds?: readonly string[]; sourceSystem?: string; patternSchemas?: readonly string[] }) => {
        queries.push(query);
        return query.profileIds?.includes(fixture.profile.id) ? gutenbergPatterns : [];
      } },
      evidence: { getEvidenceBatch: async (ids: readonly string[]) =>
        ids.includes(String(fixture.evidence.id)) ? [fixture.evidence] : [] }
    } as unknown as ScceKernelDeps["storage"];
    const runtime = createSurfaceLanguageRuntime({ deps: { storage, corpusRegistry: [] },
      languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }), clock, hasher, cacheMs: 100_000, profileLimit: 32 });
    const wikipediaWording = await runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "wording", CORPUS_ROLE_IDS.encyclopedic, fixture.requestText);
    const bundles = await runtime.sourceOwnedConstructionsForEvidence([fixture.evidence]);
    expect(wikipediaWording.state.importedConstructionBundles).toEqual([]);
    expect(gutenbergPatterns.every(pattern => jsonRecord(pattern.patternJson).sourceSystem === "gutenberg")).toBe(true);
    const sourceQueries = queries.filter(query => query.profileIds?.includes(fixture.profile.id));
    expect(sourceQueries).toHaveLength(1);
    expect(sourceQueries[0]).toMatchObject({ profileIds: [fixture.profile.id], patternSchemas: ["scce.language_construction_pattern.v1"] });
    expect(sourceQueries[0]?.sourceSystem).toBeUndefined();
    const binding = resolveRequestValueBinding({ requestText: fixture.requestText, evidence: [fixture.evidence],
      resolvers: [sourceConstructionRequestValueResolver({ bundles, graph: fixture.graph })] });
    expect(binding).toMatchObject({ value: "Bora", evidenceIds: [String(fixture.evidence.id)] });
    expect(await runtime.sourceOwnedConstructionsForEvidence([fixture.evidence])).toBe(bundles);
    expect(queries.filter(query => query.profileIds?.includes(fixture.profile.id))).toHaveLength(1);
  });

  it("does not repopulate the owned semantic cache with a read invalidated during source recompilation", async () => {
    const fixture = teach({ subjects: ["Luma", "Vela", "Zora"], marker: "HAS TOKEN", value: "Bora", valueKind: "opaque.token" });
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    let patternReads = 0;
    const storage = {
      model: { listLanguageProfiles: async () => [fixture.profile] },
      languageMemory: { listLanguagePatterns: async () => {
        patternReads++;
        if (patternReads !== 1) return [];
        const rows = fixture.patterns;
        started();
        await pending;
        return rows;
      } },
      evidence: { getEvidenceBatch: async () => [fixture.evidence] }
    } as unknown as ScceKernelDeps["storage"];
    const runtime = createSurfaceLanguageRuntime({ deps: { storage, corpusRegistry: [] },
      languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }), clock, hasher, cacheMs: 100_000, profileLimit: 32 });
    const obsoleteRead = runtime.sourceOwnedConstructionsForEvidence([fixture.evidence]);
    await reading;
    runtime.invalidate();
    release();
    const obsolete = await obsoleteRead;
    expect(obsolete.length).toBeGreaterThan(0);
    const bind = (bundles: typeof obsolete) => sourceConstructionRequestValueResolver({ bundles, graph: fixture.graph }).resolve(fixture.requestText, [fixture.evidence]);
    expect(bind(obsolete)).toMatchObject({ value: "Bora" });
    const current = await runtime.sourceOwnedConstructionsForEvidence([fixture.evidence]);
    expect(current).toEqual([]);
    expect(bind(current)).toBeUndefined();
    expect(patternReads).toBe(2);
    expect(await runtime.sourceOwnedConstructionsForEvidence([fixture.evidence])).toBe(current);
    expect(patternReads).toBe(2);
  });

  it("keeps exact Unicode sentence ranges through astral and combining code points", () => {
    const prefix = "\u{1f9f6}e\u0301: ";
    const text = `${prefix}ada visited london\u3002${prefix}ada visited paris\u3002`;
    const ranges = surfaceSentenceRanges(text);
    expect(ranges.map(range => text.slice(range.startUtf16, range.endUtf16))).toEqual([
      `${prefix}ada visited london\u3002`, `${prefix}ada visited paris\u3002`
    ]);
    expect(ranges.every(range => text.slice(range.startUtf16, range.endUtf16).length > 0)).toBe(true);
  });

  it("matches lowercased learned request literals and subjects while preserving the source value", () => {
    const fixture = teach({ subjects: ["Luma", "Vela", "Zora"], marker: "HAS TOKEN", value: "Bora", valueKind: "opaque.token" });
    const state = createLanguageMemoryRuntime({ idFactory: ids, hasher }).hydrate({ models: [], patterns: fixture.patterns, constructionEvidence: [fixture.evidence] });
    expect(state.rejectedConstructionPatterns).toEqual([]);
    expect(state.importedConstructionBundles.length).toBeGreaterThan(0);
    const binding = resolveRequestValueBinding({ requestText: fixture.requestText.toLowerCase(), evidence: [fixture.evidence],
      resolvers: [sourceConstructionRequestValueResolver({ bundles: state.importedConstructionBundles, graph: fixture.graph })] });
    expect(binding).toMatchObject({ value: "Bora", subject: "zora", evidenceIds: [String(fixture.evidence.id)] });
    expect(binding?.requestedRoleId).toBe("role.answer");
    expect(binding?.relation).toBeUndefined();
  });


  it("projects a learned role-only binding through the actual cold factual turn and owned answer readers", async () => {
    const lesson = teach({ subjects: ["Luma", "Vela", "Zora"], marker: "", value: "Bora", valueKind: "entity.place",
      statement: "Zora is located in Bora.", question: subject => `Where is ${subject} located?` });
    const binding = lesson.resolve();
    expect(binding).toMatchObject({ subject: "Zora", value: "Bora", requestedRoleId: "role.answer" });
    expect(binding?.relation).toBeUndefined();
    const resident = sourceOwnedAnswerhoodLanguage();
    const fixture = storageFixtureForEvaluation({ evidence: [lesson.evidence, ...resident.evidence], clockNow: () => 140_000 });
    fixture.storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
    fixture.storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
    fixture.storage.model.listLanguageProfiles = async query => {
      const profiles = [lesson.profile, ...resident.profiles];
      return typeof query === "number" ? profiles.slice(0, query)
        : profiles.filter(row => !query?.sourceVersionIds || query.sourceVersionIds.includes(row.sourceVersionId)).slice(0, query?.limit);
    };
    fixture.storage.languageMemory.listNgramModels = async query => resident.models.filter(model =>
      !query?.profileIds || query.profileIds.includes(String((model.modelJson as { profileId: string }).profileId)));
    fixture.storage.languageMemory.listLanguagePatterns = async query => [...lesson.patterns, ...resident.patterns].filter(pattern =>
      (!query?.profileIds || query.profileIds.includes(pattern.profileId)) && (!query?.patternKind || query.patternKind === pattern.patternKind));
    fixture.storage.graph.getSlice = async query => ({ bounded: true, query: query as GraphSlice["query"],
      nodes: lesson.graph.nodes.map(node => ({ ...node, typeId: "entity" as GraphNode["typeId"], features: [], alpha: 1, createdAt: 140_000, updatedAt: 140_000 })), edges: [], hyperedges: lesson.graph.hyperedges });
    const turnClock = createClock({ fixedTime: 141_000, stepMs: 1 });
    const kernel = createScceKernel({ storage: fixture.storage, files: { streamPath: async function* () {} },
      buildTest: { executeProgram: async () => { throw new Error("A factual turn must not execute a program"); } },
      idFactory: createIdFactory({ clock: turnClock, hasher, deterministicReplay: true, namespace: "role-only-cold-turn" }), clock: turnClock, deterministicReplay: true });
    const traceGlobal = globalThis as unknown as { __sccTrace?: unknown };
    const previousTrace = traceGlobal.__sccTrace;
    traceGlobal.__sccTrace = createTrace("role-only-cold-turn");
    const turned = await kernel.turn({ text: lesson.requestText, requestedAuthority: "factual" });
    traceGlobal.__sccTrace = previousTrace;
    const fact = requestValueBindingConstructFact(binding, [lesson.evidence]);
    expect(fact).toMatchObject({ predicate: "", relationId: "relation.opaque", relationRoleId: "role.answer", requestedSlotId: "role.answer" });
    const attached = attachSourceBoundAnswerConstruct({ construct: { ...turned.constructGraph, nodes: [], edges: [] },
      requestText: lesson.requestText, brainMarker: {}, hasher, facts: [fact!], evidence: [lesson.evidence] });
    expect(semanticAnswerConstructFacts(attached)?.facts).toEqual(expect.arrayContaining([expect.objectContaining({ predicate: "", relationRoleId: "role.answer" })]));
    expect(semanticAnswerConstructState(attached)?.selectedFacts).toEqual(expect.arrayContaining([expect.objectContaining({ predicate: "", relationRoleId: "role.answer" })]));
    expect(semanticAnswerConstructFacts(turned.constructGraph)?.facts).toEqual(expect.arrayContaining([expect.objectContaining({
      subject: "Zora", predicate: "", object: "Bora", relationId: "relation.opaque", relationRoleId: "role.answer",
      evidenceIds: [String(lesson.evidence.id)], sourceVersionId: String(lesson.evidence.sourceVersionId)
    })]));
    expect(turned.answer).toBe("Bora");
    expect(turned.withheld).toBeUndefined();
    const authority = jsonRecord(jsonRecord(jsonRecord(jsonRecord(turned.mouth).trace).selected).audit).producerAuthority;
    expect(authority).toMatchObject({ kind: "evidence_bound_proposition", evidenceIds: [String(lesson.evidence.id)], claims: [{
      text: "Bora", graphNodeIds: [], trace: { schema: "scce.mouth.typed_bound_value.v1", subject: "Zora", relationId: "relation.opaque",
        relationRoleId: "role.answer", requestedSlotId: "role.answer", sourceVersionId: String(lesson.evidence.sourceVersionId), evidenceIds: [String(lesson.evidence.id)] }
    }] });
  });

  it("does not scan facts or source bodies when no acquired request form matches", () => {
    const fixture = teach({ subjects: ["Luma", "Vela", "Zora"], marker: "HAS TOKEN", value: "Bora", valueKind: "opaque.token" });
    const state = createLanguageMemoryRuntime({ idFactory: ids, hasher }).hydrate({ models: [], patterns: fixture.patterns, constructionEvidence: [fixture.evidence] });
    let graphReads = 0;
    let sourceReads = 0;
    const graph = { get nodes() { graphReads++; return fixture.graph.nodes; }, get hyperedges() { graphReads++; return fixture.graph.hyperedges; } };
    const evidence = { ...fixture.evidence, get text() { sourceReads++; return fixture.evidence.text; } };
    const resolver = sourceConstructionRequestValueResolver({ bundles: state.importedConstructionBundles, graph });
    expect(resolver.resolve("an unseen instruction", [evidence])).toBeUndefined();
    expect(graphReads).toBe(0);
    expect(sourceReads).toBe(0);
    expect(resolver.resolve(fixture.requestText.toLowerCase(), [evidence])).toMatchObject({ value: "Bora" });
    expect(graphReads).toBeGreaterThan(0);
    expect(sourceReads).toBeGreaterThan(0);
  });

  it.each([
    { subjects: ["Luma", "Vela", "Zora"], values: ["3-bit", "5-bit", "9-bit"], valueKind: "opaque.width",
      source: (subject: string, value: string) => `${subject} encodes each code-point as a ${value} integer.`,
      request: (subject: string) => `How many bits does ${subject} use to encode each code point?` },
    { subjects: ["甲", "乙", "丙"], values: ["０から１", "２から３", "４から８"], valueKind: "opaque.scale",
      source: (subject: string, value: string) => `${subject} の尺度は ${value} です。`,
      request: (subject: string) => `${subject} の尺度を示して？` }
  ])("learns graph-conditioned source prose and answers a new source's $valueKind through the acquired request form", input => {
    const anchor: SourceConstructionGraphBinding = { relationId: "relation.conditioned", roleId: "role.subject", valueKind: "opaque.entity" };
    const valueRole: SourceConstructionGraphBinding = { relationId: "relation.conditioned", roleId: "role.measure", valueKind: input.valueKind };
    const statements = input.subjects.slice(0, 2).map((subject, index) => input.source(subject, input.values[index]!));
    const requests = input.subjects.slice(0, 2).map(input.request);
    const text = [...statements, ...requests].join("\n");
    const lesson = evidenceSpan(text);
    const observation = (surface: string, start: number, fields: Array<{ surface: string; binding: SourceConstructionGraphBinding }>, omitted = false): SourceBoundConstructionObservation => ({
      sourceVersionId: String(lesson.sourceVersionId), evidenceId: String(lesson.id), surfaceStartCodePoint: start, surfaceEndCodePoint: start + [...surface].length,
      roles: fields.map((field, slotIndex) => {
        expect(surface.indexOf(field.surface)).toBe(surface.lastIndexOf(field.surface));
        const startCodePoint = [...surface.slice(0, surface.indexOf(field.surface))].length;
        return { slotIndex, startCodePoint, endCodePoint: startCodePoint + [...field.surface].length, graphBinding: field.binding };
      }),
      nullRoles: omitted ? [{ slotIndex: 1, graphBinding: valueRole }] : []
    });
    let offset = 0;
    const sourceObservations = statements.map((surface, index) => {
      const result = observation(surface, offset, [{ surface: input.subjects[index]!, binding: anchor }, { surface: input.values[index]!, binding: valueRole }]);
      offset += [...surface].length + 1;
      return result;
    });
    const requestObservations = requests.map((surface, index) => {
      const result = observation(surface, offset, [{ surface: input.subjects[index]!, binding: anchor }], true);
      offset += [...surface].length + 1;
      return result;
    });
    const nodes = input.subjects.slice(0, 2).flatMap((subject, index) => [
      { id: `subject.${index}`, representation: { surface: subject } }, { id: `value.${index}`, representation: { surface: input.values[index]! } }
    ]) as unknown as GraphNode[];
    const graph: GraphSnapshot = { nodes, edges: [], hyperedges: statements.map((_, index) => ({
      schema: "scce.hyperedge.v2", id: `fact.${index}`, relationId: anchor.relationId, evidenceIds: [lesson.id], memberNodeIds: [`subject.${index}`, `value.${index}`],
      qualifiers: {}, modality: {}, temporalScope: {}, weightVector: {}, provenanceRefs: [], createdAt: 140_000, updatedAt: 140_000,
      participantPorts: [anchor, valueRole].map((binding, slotIndex) => ({
        roleId: binding.roleId, valueKind: binding.valueKind, portId: binding.roleId,
        nodeId: `${slotIndex === 0 ? "subject" : "value"}.${index}`, realization: "observed", evidenceIds: [lesson.id]
      }))
    } as unknown as Hyperedge)) };
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: lesson.sourceVersionId, text, createdAt: 140_000 });
    const trained = compileLanguageTrainingBatch({ hasher, runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), batch: {
      streamId: "fixture://conditioned-prose", profile, sourceVersionId: lesson.sourceVersionId, text, evidence: [lesson], graphSnapshot: graph, createdAt: 140_000,
      constructionSets: [{ bindingId: "source.conditioned", observations: sourceObservations }, { bindingId: "request.conditioned", observations: requestObservations }]
    } });
    const restarted = createLanguageMemoryRuntime({ hasher, idFactory: ids }).hydrate({ models: [], patterns: trained.constructionPatterns, constructionEvidence: [lesson] });
    expect(restarted.rejectedConstructionPatterns).toEqual([]);
    const fresh = evidenceSpan(input.source(input.subjects[2]!, input.values[2]!));
    const resolver = sourceConstructionRequestValueResolver({ bundles: restarted.importedConstructionBundles, graph: { nodes: [], hyperedges: [] } });
    const requestText = input.request(input.subjects[2]!);
    const resolve = (evidence: EvidenceSpan[]) => resolveRequestValueBinding({ requestText, evidence, resolvers: [resolver] });
    expect(resolve([fresh])).toMatchObject({ value: input.values[2], subject: input.subjects[2], evidenceIds: [String(fresh.id)] });
    expect(resolve([])).toBeUndefined();
    expect(resolve([lesson])).toBeUndefined();
    expect(resolve([evidenceSpan(`${input.subjects[2]} unrelated ${input.values[2]}.`)])).toBeUndefined();
    expect(resolve([evidenceSpan(input.source(input.subjects[2]!, ""))])).toBeUndefined();
    expect(resolve([evidenceSpan(input.source(input.subjects[0]!, input.values[2]!))])).toBeUndefined();
    expect(resolve([evidenceSpan(input.source(input.values[2]!, input.subjects[2]!))])).toBeUndefined();
    expect(resolve([evidenceSpan(input.source(`¬ ${input.subjects[2]}`, input.values[2]!))])).toBeUndefined();
    const ambiguous = evidenceSpan(input.source(input.subjects[2]!, input.source(input.subjects[0]!, input.values[2]!)));
    expect(resolve([ambiguous])).toBeUndefined();
    expect(resolve([{ ...fresh, status: "quarantined" }])).toBeUndefined();
    const rival = evidenceSpan(input.source(input.subjects[2]!, input.values[0]!));
    expect(resolve([fresh, rival])).toBeUndefined();
    const requestOnly = sourceConstructionRequestValueResolver({ bundles: restarted.importedConstructionBundles.filter(bundle => bundle.bindingId !== "source.conditioned"), graph: { nodes: [], hyperedges: [] } });
    expect(resolveRequestValueBinding({ requestText, evidence: [fresh], resolvers: [requestOnly] })).toBeUndefined();
  });

  it("passes a learned category binding into answerhood instead of guessing from the final word or a cased name", () => {
    const sentence = "Athens is the capital and largest city of Greece.";
    const fixture = teach({
      subjects: ["Rome", "Paris", "Athens"], marker: "is the capital of which country", value: "Greece", valueKind: "opaque.country",
      semanticRole: "entity", statement: sentence
    });
    const binding = fixture.resolve();
    expect(binding?.value).toBe("Greece");
    const evidence = { ...fixture.evidence, provenance: { ...jsonRecord(fixture.evidence.provenance), title: "Athens" } };
    const units = ["athens", "capital", "country"];
    const options = { relationRequired: true, languageClosedClassWords: new Set(["is", "the", "of", "which"]) };
    expect(answerCoversRequest([sentence], evidence, units, fixture.requestText, options)).toBe(false);
    expect(answerCoversRequest([sentence], evidence, units, fixture.requestText, { ...options, boundValues: binding ? [binding.value] : [] })).toBe(true);
    const unrelated = "Athens has ferry services to OtherCity.";
    expect(answerCoversRequest([unrelated], evidence, units, fixture.requestText, { ...options, boundValues: binding ? [binding.value] : [] })).toBe(false);
  });

  it("carries available graph-port value kinds into automatically aligned source observations", () => {
    const evidence = evidenceSpan("甲 結 7。乙 結 9。甲 連 7。乙 連 9。");
    const graph: GraphSnapshot = {
      nodes: ["7", "9"].map(value => ({ id: value, representation: { surface: value } } as unknown as GraphNode)), edges: [],
      hyperedges: ["7", "9"].map(value => ({
        id: `fact.${value}`, relationId: "relation.opaque", evidenceIds: [evidence.id], qualifiers: {}, modality: {}, temporalScope: {},
        participantPorts: [{ nodeId: value, portId: "port.value", roleId: "role.quantity", valueKind: "opaque.quantity", realization: "observed", evidenceIds: [evidence.id] }]
      } as unknown as Hyperedge))
    };
    const sets = induceSourceBoundConstructionTrainingSets({ evidence: [evidence], profileId: "profile.opaque", hasher, graphSnapshot: graph });
    const typedRoles = sets.flatMap(set => set.observations.flatMap(observation => observation.roles.filter(role => role.graphBinding)));
    expect(typedRoles.length).toBeGreaterThan(0);
    expect(typedRoles.every(role => role.graphBinding?.roleId === "role.quantity" && role.graphBinding?.valueKind === "opaque.quantity")).toBe(true);
    const ambiguous = structuredClone(graph);
    ambiguous.hyperedges.push(...graph.hyperedges.map(edge => ({
      ...edge, id: `${edge.id}.other` as Hyperedge["id"], participantPorts: edge.participantPorts.map(port => ({ ...port, roleId: "role.other" }))
    })));
    const ambiguousSets = induceSourceBoundConstructionTrainingSets({ evidence: [evidence], profileId: "profile.opaque", hasher, graphSnapshot: ambiguous });
    expect(ambiguousSets.flatMap(set => set.observations.flatMap(observation => observation.roles.filter(role => role.graphBinding)))).toEqual([]);
  });

  it.each([
    { subjects: ["甲", "乙", "丙"] as [string, string, string], marker: "幅", value: "０–１", valueKind: "opaque.scale" },
    { subjects: ["z1", "z2", "z3"] as [string, string, string], marker: "qv", value: "7", valueKind: "opaque.quantity" },
    { subjects: ["\u{10400}", "\u{10401}", "\u{10402}"] as [string, string, string], marker: "\u03be", value: "第十六", valueKind: "opaque.ordinal" }
  ])("learns a request and binds a new subject's exact $valueKind port after restart", input => {
    const fixture = teach(input);
    expect(fixture.resolve()).toMatchObject({ value: fixture.value, resolverId: "resolver.acquired_source_construction", evidenceIds: [String(fixture.evidence.id)] });
    const wrongRole = structuredClone(fixture.graph);
    wrongRole.hyperedges[0]!.participantPorts[1]!.roleId = "role.other";
    expect(fixture.resolve(wrongRole)).toBeUndefined();
    const wrongKind = structuredClone(fixture.graph);
    wrongKind.hyperedges[0]!.participantPorts[1]!.valueKind = "opaque.unrelated";
    expect(fixture.resolve(wrongKind)).toBeUndefined();
    const missingValue = structuredClone(fixture.graph);
    missingValue.hyperedges[0]!.participantPorts[1]!.realization = "omitted";
    expect(fixture.resolve(missingValue)).toBeUndefined();
    const negated = structuredClone(fixture.graph);
    negated.hyperedges[0]!.modality = { polarity: "negative" };
    expect(fixture.resolve(negated)).toBeUndefined();
    const qualified = structuredClone(fixture.graph);
    qualified.hyperedges[0]!.qualifiers = { scope: "unrelated" };
    expect(fixture.resolve(qualified)).toBeUndefined();
    const dated = structuredClone(fixture.graph);
    dated.hyperedges[0]!.temporalScope = { status: "known", validFrom: 10 };
    expect(fixture.resolve(dated)).toBeUndefined();
    expect(fixture.resolve(fixture.graph, [{ ...fixture.evidence, text: "unknown" }])).toBeUndefined();
    expect(fixture.resolve(fixture.graph, [{ ...fixture.evidence, id: "unowned" as EvidenceSpan["id"] }])).toBeUndefined();
    expect(fixture.resolve(fixture.graph, [fixture.evidence], `${input.subjects[2]} unseen？`)).toBeUndefined();
  });

  it("rejects type declarations changed after the source-bound construction was compiled", () => {
    const fixture = teach({ subjects: ["甲", "乙", "丙"], marker: "幅", value: "０–１", valueKind: "opaque.scale" });
    const patterns = structuredClone(fixture.patterns.filter(pattern => (pattern.patternJson as { bundle: { bindingId: string } }).bundle.bindingId === "request.opaque"));
    const pattern = patterns.find(pattern => JSON.stringify(pattern.patternJson).includes('"request.opaque"'))!;
    const content = pattern.patternJson as unknown as { bundle: { sourceExamples: Array<{ nullRoles: Array<{ graphBinding: { valueKind: string } }> }> } };
    content.bundle.sourceExamples[0]!.nullRoles[0]!.graphBinding.valueKind = "opaque.unrelated";
    const restarted = createLanguageMemoryRuntime({ idFactory: ids, hasher }).hydrate({ models: [], patterns, constructionEvidence: [fixture.evidence] });
    expect(restarted.importedConstructionBundles).toEqual([]);
    expect(restarted.rejectedConstructionPatterns.length).toBeGreaterThan(0);
  });

  it("acquires, persists, hydrates, and applies a graph-owned omitted role to a cold request", async () => {
    const prefix = "\u{1f9f6}: ";
    const text = `${prefix}ada visited london\u3002 ${prefix}ada visited paris\u3002 ${prefix}eve visited london\u3002 ${prefix}eve visited paris\u3002 ${prefix}ada visited\u3002 ${prefix}eve visited\u3002`;
    const evidence = evidenceSpan(text);
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: evidence.sourceVersionId, text, createdAt: 140_000 });
    const nodeRows: GraphNode[] = [];
    const addNode = (key: string, surface: string) => {
      const id = `node.${key}`;
      nodeRows.push({ id: id as GraphNode["id"], representation: { surface }, metadata: {}, evidenceIds: [evidence.id] } as unknown as GraphNode);
      return id;
    };
    const fact = (id: string, subject: string, object?: string): Hyperedge => {
      const participantPorts = [
        { nodeId: addNode(`${id}.subject`, subject), portId: "role.visitor", roleId: "role.visitor", valueKind: "entity.person", realization: "observed", evidenceIds: [evidence.id] },
        object === undefined
          ? { nodeId: null, portId: "role.destination", roleId: "role.destination", valueKind: "entity.place", realization: "omitted", evidenceIds: [evidence.id] }
          : { nodeId: addNode(`${id}.object`, object), portId: "role.destination", roleId: "role.destination", valueKind: "entity.place", realization: "observed", evidenceIds: [evidence.id] }
      ];
      return {
        schema: "scce.hyperedge.v2", id: `fact.${id}`, relationId: "relation.visit", evidenceIds: [evidence.id],
        participantPorts, memberNodeIds: participantPorts.flatMap(port => port.nodeId ? [port.nodeId] : []),
        qualifiers: {}, modality: {}, temporalScope: {}, weightVector: {}, provenanceRefs: [], createdAt: 140_000, updatedAt: 140_000
      } as unknown as Hyperedge;
    };
    const graph: GraphSnapshot = { nodes: nodeRows, edges: [], hyperedges: [
      fact("ada-london", "ada", "london"), fact("ada-paris", "ada", "paris"), fact("eve-london", "eve", "london"),
      fact("eve-paris", "eve", "paris"), fact("ada-request", "ada"), fact("eve-request", "eve")
    ] };
    const trained = compileLanguageTrainingBatch({ hasher, runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), batch: {
      streamId: "fixture://null-role-transfer", profile, sourceVersionId: evidence.sourceVersionId, text, evidence: [evidence], graphSnapshot: graph, createdAt: 140_000
    } });
    const restarted = createLanguageMemoryRuntime({ hasher, idFactory: ids }).hydrate({ models: [], patterns: trained.patterns, constructionEvidence: [evidence] });
    expect(restarted.rejectedConstructionPatterns).toEqual([]);
    const bundle = restarted.importedConstructionBundles.find(candidate => candidate.sourceExamples.some(example =>
      example.nullRoles.some(role => role.graphBinding?.roleId === "role.destination")));
    expect(bundle).toBeDefined();
    expect(bundle!.sourceExamples.some(example => example.roles.some(role => role.graphBinding?.roleId === "role.destination"))).toBe(true);
    expect(bundle!.sourceExamples.filter(example => example.nullRoles.some(role => role.graphBinding?.roleId === "role.destination"))).toHaveLength(2);
    for (const example of bundle!.sourceExamples) {
      const owner = [evidence].find(span => String(span.id) === example.evidenceId)!;
      expect([...owner.text].slice(example.surfaceStartCodePoint, example.surfaceEndCodePoint).join("")).toBe(example.surface);
    }

    const fresh = evidenceSpan("zoe visited tokyo.");
    const freshNode = (id: string, surface: string): GraphNode => ({ id: id as GraphNode["id"], typeId: "type.entity" as GraphNode["typeId"],
      representation: { surface }, alpha: 1, features: [], evidenceIds: [fresh.id], createdAt: 140_000, updatedAt: 140_000, metadata: {} });
    const freshGraph: GraphSnapshot = {
      nodes: [freshNode("node.zoe", "zoe"), freshNode("node.tokyo", "tokyo")], edges: [], hyperedges: [{
        schema: "scce.hyperedge.v2", id: "fact.fresh", relationId: "relation.visit", evidenceIds: [fresh.id], memberNodeIds: ["node.zoe", "node.tokyo"],
        participantPorts: [
          { nodeId: "node.zoe", portId: "role.visitor", roleId: "role.visitor", valueKind: "entity.person", realization: "observed", evidenceIds: [fresh.id] },
          { nodeId: "node.tokyo", portId: "role.destination", roleId: "role.destination", valueKind: "entity.place", realization: "observed", evidenceIds: [fresh.id] }
        ], qualifiers: {}, modality: {}, temporalScope: {}, weightVector: {}, provenanceRefs: [], createdAt: 140_000, updatedAt: 140_000
      } as unknown as Hyperedge]
    };
    const request = resolveRequestValueBinding({ requestText: "zoe visited?", evidence: [fresh],
      resolvers: [sourceConstructionRequestValueResolver({ bundles: restarted.importedConstructionBundles, graph: freshGraph })] });
    expect(request).toMatchObject({ value: "tokyo", subject: "zoe", relation: "visited", requestedRoleId: "role.destination",
      relationId: "relation.visit", evidenceIds: [String(fresh.id)] });

    const residentLanguage = sourceOwnedAnswerhoodLanguage();
    const storedEvidence = [evidence, fresh, ...residentLanguage.evidence];
    const fixture = storageFixtureForEvaluation({ evidence: storedEvidence, clockNow: () => 140_000 });
    fixture.storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
    fixture.storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
    fixture.storage.model.listLanguageProfiles = async query => {
      const profiles = [profile, ...residentLanguage.profiles];
      return typeof query === "number" ? profiles.slice(0, query)
        : profiles.filter(row => !query?.sourceVersionIds || query.sourceVersionIds.includes(row.sourceVersionId)).slice(0, query?.limit);
    };
    const storedModels = [...trained.models, ...residentLanguage.models];
    fixture.storage.languageMemory.listNgramModels = async query => storedModels.filter(model =>
      !query?.profileIds || query.profileIds.includes(String((model.modelJson as { profileId: string }).profileId)));
    const storedPatterns = [...trained.patterns, ...residentLanguage.patterns];
    fixture.storage.languageMemory.listLanguagePatterns = async query => storedPatterns.filter(pattern =>
      (!query?.profileIds || query.profileIds.includes(pattern.profileId))
      && (!query?.patternKind || query.patternKind === pattern.patternKind));
    fixture.storage.graph.getSlice = async query => ({ bounded: true, query: query as GraphSlice["query"],
      nodes: freshGraph.nodes, edges: [], hyperedges: freshGraph.hyperedges });
    const clock = createClock({ fixedTime: 141_000, stepMs: 1 });
    const kernel = createScceKernel({ storage: fixture.storage, files: { streamPath: async function* () {} },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: { code: 0, stdout: "", stderr: "", durationMs: 0 },
        test: { code: 0, stdout: "", stderr: "", durationMs: 0 }, repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "null-role-cold-turn" }), clock, deterministicReplay: true });
    const traceGlobal = globalThis as unknown as { __sccTrace?: unknown };
    const previousTrace = traceGlobal.__sccTrace;
    traceGlobal.__sccTrace = createTrace("null-role-cold-turn");
    const turned = await kernel.turn({ text: "zoe visited?", requestedAuthority: "factual" });
    traceGlobal.__sccTrace = previousTrace;
    expect(turned.evidence.map(span => String(span.id))).toContain(String(fresh.id));
    const semanticAnswer = turned.constructGraph.nodes.find(node => node.kind === "construct:semantic_answer");
    expect(semanticAnswer).toBeDefined();
    const semanticAnswerMetadata = jsonRecord(semanticAnswer!.metadata);
    expect(semanticAnswerMetadata.supportIds).toEqual([String(fresh.id)]);
    expect(semanticAnswerMetadata.selectedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "zoe", predicate: "visited", object: "tokyo", relationRoleId: "role.destination",
        evidenceIds: [String(fresh.id)], sourceVersionId: String(fresh.sourceVersionId) })
    ]));
    expect(turned.constructGraph.edges.filter(edge => edge.source === semanticAnswer!.id).every(edge => Boolean(edge.target))).toBe(true);
    expect(turned.answer.toLocaleLowerCase()).toContain("tokyo");
  });

  it("keeps null-role candidates unbound when graph ownership or the omitted port is ambiguous", () => {
    const prefix = "🪶: ";
    const text = `${prefix}ada visited london。 ${prefix}ada visited paris。 ${prefix}eve visited london。 ${prefix}eve visited paris。 ${prefix}ada visited。 ${prefix}eve visited。`;
    const evidence = evidenceSpan(text);
    const node = (id: string, surface: string) => ({ id, representation: { surface }, metadata: {}, evidenceIds: [evidence.id] }) as unknown as GraphNode;
    const edge = (id: string, subject: string, object?: string, evidenceId: string = String(evidence.id)): Hyperedge => ({
      schema: "scce.hyperedge.v2", id, relationId: "relation.visit", evidenceIds: [evidenceId], memberNodeIds: [id],
      participantPorts: [
        { nodeId: `node.${id}.subject`, portId: "role.visitor", roleId: "role.visitor", valueKind: "entity.person", realization: "observed", evidenceIds: [evidenceId] },
        ...(object === undefined ? [{ nodeId: null, portId: "role.destination", roleId: "role.destination", valueKind: "entity.place", realization: "omitted", evidenceIds: [evidenceId] }] : [
          { nodeId: `node.${id}.object`, portId: "role.destination", roleId: "role.destination", valueKind: "entity.place", realization: "observed", evidenceIds: [evidenceId] }
        ])
      ], qualifiers: {}, modality: {}, temporalScope: {}, weightVector: {}, provenanceRefs: [], createdAt: 140_000, updatedAt: 140_000
    } as unknown as Hyperedge);
    const baseEdges = [edge("ada-london", "ada", "london"), edge("ada-paris", "ada", "paris"), edge("eve-london", "eve", "london"),
      edge("eve-paris", "eve", "paris"), edge("ada-request", "ada"), edge("eve-request", "eve")];
    const align = (hyperedges: Hyperedge[]) => induceSourceBoundConstructionTrainingSets({
      evidence: [evidence], profileId: "profile.null-role", hasher,
      graphSnapshot: { nodes: [node("node.ada-london.subject", "ada"), node("node.ada-london.object", "london"),
        node("node.ada-paris.subject", "ada"), node("node.ada-paris.object", "paris"), node("node.eve-london.subject", "eve"),
        node("node.eve-london.object", "london"), node("node.eve-paris.subject", "eve"), node("node.eve-paris.object", "paris"),
        node("node.ada-request.subject", "ada"), node("node.eve-request.subject", "eve")], edges: [], hyperedges }
    });
    const rowsForSubject = (sets: ReturnType<typeof align>, subject: string) => sets.flatMap(set => set.observations
      .filter(observation => [...evidence.text].slice(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint).join("").includes(subject))
      .flatMap(observation => observation.nullRoles ?? []));
    const withTwoOmissions = structuredClone(baseEdges);
    withTwoOmissions[4]!.participantPorts.push({ nodeId: null, portId: "role.other", roleId: "role.other", valueKind: "entity.other", realization: "omitted", evidenceIds: [evidence.id] } as never);
    const ambiguousSets = align(withTwoOmissions);
    const ambiguous = rowsForSubject(ambiguousSets, "ada");
    expect(ambiguous.some(row => row.graphBinding)).toBe(false);
    expect(ambiguous.length).toBeGreaterThan(0);
    expect(rowsForSubject(ambiguousSets, "eve").some(row => row.graphBinding?.roleId === "role.destination")).toBe(true);
    expect(JSON.stringify(ambiguousSets.map(set => set.alignmentSummary))).toContain("ambiguous_omitted_ports");

    const reversed = baseEdges.map((row, index) => index >= 4 ? {
      ...row,
      participantPorts: row.participantPorts.map(port => port.realization === "omitted"
        ? { ...port, roleId: "role.visitor", portId: "role.visitor", valueKind: "entity.person" }
        : port)
    } as Hyperedge : row);
    const reversedRows = rowsForSubject(align(reversed), "ada");
    expect(reversedRows.some(row => row.graphBinding)).toBe(false);
    expect(JSON.stringify(align(reversed).map(set => set.alignmentSummary))).toContain("slot_binding_mismatch");

    const foreign = baseEdges.map((row, index) => index >= 4
      ? { ...row, evidenceIds: ["evidence.foreign" as never], participantPorts: row.participantPorts.map(port => ({ ...port, evidenceIds: ["evidence.foreign" as never] })) } as Hyperedge
      : row);
    const foreignRows = rowsForSubject(align(foreign), "ada");
    expect(foreignRows.some(row => row.graphBinding)).toBe(false);
    expect(JSON.stringify(align(foreign).map(set => set.alignmentSummary)).toLowerCase()).toContain("no_matching_fact");
  });
});
