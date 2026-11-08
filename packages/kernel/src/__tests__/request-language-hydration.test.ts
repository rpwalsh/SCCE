// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { requestSeedLanguagePattern } from "../request-language-hydration.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { compileLanguageConstructionPattern, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE, type SourceBoundConstructionObservation, type SourceConstructionGraphBinding } from "../language-construction-memory.js";
import { compileRequestRequirementCorpus, REQUEST_REQUIREMENT_CORPUS_SCHEMA } from "../request-requirement-learning.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import { projectRequestAuthority } from "../request-authority.js";
import { sourceConstructionRequestValueResolver } from "../source-construction-request-binding.js";
import { resolveRequestValueBinding } from "../semantic-answer-construct.js";
import { learnedEntitySurfacesFromLanguageMemory } from "../kernel-answer-primitives.js";
import type { EvidenceSpan, LanguageProfile, RequestedAuthority, SourceVersionId } from "../types.js";
import type { LanguagePatternRecord, ScceKernelDeps, SemanticFrameRecord } from "../storage.js";

const hasher = createHasher();
const clock = createClock({ fixedTime: 1 });
const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
const profile: LanguageProfile = { id: "profile.seed", sourceVersionId: "version.seed" as SourceVersionId,
  scripts: [{ script: "script.opaque", mass: 1 }], symbolShapes: [], charNgrams: [], direction: "unknown", entropy: 0, createdAt: 1 };
const cluster = { id: "cluster.seed", members: [profile], profileIds: [profile.id], sourceVersionIds: [profile.sourceVersionId],
  discoveredNames: [], scripts: profile.scripts, symbolShapes: [], charNgrams: [], direction: "unknown" as const, artifactSupport: 1 };

function fixture(patterns: LanguagePatternRecord[], evidence: EvidenceSpan[] = []) {
  const calls = { frames: [] as unknown[], patterns: [] as NonNullable<Parameters<ScceKernelDeps["storage"]["languageMemory"]["listLanguagePatterns"]>[0]>[], evidence: 0 };
  let frameRows: SemanticFrameRecord[] = [];
  const storage = { brainImports: { active: async () => ({ activeImportRunIds: [] }) },
    model: { listLanguageProfiles: async () => [profile] },
    evidence: { getEvidenceBatch: async (wanted: readonly string[]) => { calls.evidence++; return evidence.filter(row => wanted.includes(String(row.id))); } },
    languageMemory: { listNgramModels: async () => [], listLanguageUnits: async () => [],
      listLanguagePatterns: async (query: NonNullable<Parameters<ScceKernelDeps["storage"]["languageMemory"]["listLanguagePatterns"]>[0]> = {}) => {
        calls.patterns.push(query);
        return patterns.filter(pattern => (!query.patternIds || query.patternIds.includes(pattern.id))
          && (!query.patternSchemas || query.patternSchemas.includes(String((pattern.patternJson as Record<string, unknown>).schema)))
          && (!query.profileIds || query.profileIds.includes(pattern.profileId)));
      },
      listSemanticFrames: async (query: unknown) => { calls.frames.push(query); return frameRows; } }
  } as unknown as ScceKernelDeps["storage"];
  const runtime = createSurfaceLanguageRuntime({ deps: { storage, corpusRegistry: [] }, languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }),
    clock, hasher, cacheMs: 100_000, profileLimit: 32 });
  return { runtime, calls, setFrames: (rows: SemanticFrameRecord[]) => { frameRows = rows; } };
}

const pattern = (id: string, patternJson: LanguagePatternRecord["patternJson"], patternKind: LanguagePatternRecord["patternKind"] = "semantic_role"): LanguagePatternRecord =>
  ({ id, profileId: profile.id, patternKind, patternJson, evidenceIds: [], support: 1, entropy: 0, updatedAt: 1 });

it("never reads generic frames or source evidence during request seeding, and keeps realization queries complete", async () => {
  const page = pattern("source.page", { schema: "scce.language_construction_pattern.v1", bundle: {
    sourceExamples: [{ surface: "source body", roles: [], nullRoles: [] }], constructions: [{ sourceBody: "source body" }] } });
  const syntax = pattern("syntax", { schema: "scce.induced_language_model.syntax_memory.v1", counts: { alpha: 2 }, boundarySignals: [],
    templates: [{ shape: ["alpha", "beta"] }], joinProgram: { histories: ["source program"] } }, "syntax");
  const f = fixture([page, syntax]);
  const seed = await f.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "seed", undefined, "", { purpose: "request_seed" });
  expect(f.calls.frames).toEqual([{ view: "request_seed", profileIds: [profile.id], sourceSystem: undefined, limit: 128 }]);
  expect(f.calls.evidence).toBe(0);
  expect(seed.state.importedConstructionBundles).toEqual([]);
  expect(seed.patterns.find(row => row.id === page.id)?.patternJson).not.toHaveProperty("bundle");
  expect(seed.patterns.find(row => row.id === syntax.id)?.patternJson).toEqual({ schema: "scce.induced_language_model.syntax_memory.v1", counts: { alpha: 2 }, boundarySignals: [], templates: [] });
  const reads = f.calls.patterns.length;
  expect(await f.runtime.requestConstructionBundles(seed.patterns, seed.state.scope)).toEqual([]);
  expect(f.calls.patterns).toHaveLength(reads);
  const realization = await f.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "realization");
  expect(f.calls.frames).toHaveLength(2);
  expect(f.calls.frames.at(-1)).not.toHaveProperty("view");
  expect(realization.patterns).toEqual([page, syntax]);
  expect(f.calls.patterns.at(-1)).not.toHaveProperty("view");
});

it("looks up only normalized exact request frames, preserving evidence-only and calibrated frames", async () => {
  const f = fixture([]);
  const row: SemanticFrameRecord = { id: "frame.exact", frameJson: { surface: "ΑΛΦΑ\tβήτα" }, evidenceIds: [], embedding: [], alpha: 1, createdAt: 1 };
  f.setFrames([row, { ...row, id: "generic", frameJson: { preview: "large unrelated source" } }]);
  expect(await f.runtime.requestSemanticFrames("  αλφα βήτα ")).toEqual([row]);
  expect(f.calls.frames).toEqual([{ requestSurface: "αλφα βήτα", limit: 128 }]);
  expect(await f.runtime.requestSemanticFrames("αλφα βήτα", { residentOnly: true })).toEqual([row]);
  expect(f.calls.frames).toHaveLength(1);
  expect(await f.runtime.requestSemanticFrames("αλφα\u2003βήτα")).toEqual([]);
});

it("preserves the fixed paired corpus's requirement fields and authority across factual, creative, code, and dialogue requests", async () => {
  const forms: Array<{ text: string; authority: RequestedAuthority; requirements?: { dialogueDependence: number } }> = [
    { text: "ψ α", authority: "factual" }, { text: "λ α", authority: "creative" },
    { text: "ξ α", authority: "program" }, { text: "μ α", authority: "factual", requirements: { dialogueDependence: 1 } }
  ];
  const compiled = compileRequestRequirementCorpus({ corpus: { schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA, language: "und",
    examples: forms.flatMap(form => ["α", "β", "γ", "δ", "ε", "ζ"].map(subject => ({ ...form, text: form.text.replace("α", subject), responseText: `${subject} r7.` }))) },
    profileId: profile.id, sourceVersionId: profile.sourceVersionId, evidenceIds: [], sourceSystem: "dialogue", updatedAt: 1,
    makeId: value => hasher.digestHex(JSON.stringify(value)) });
  const f = fixture(compiled.patterns);
  const seed = await f.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "seed", undefined, "", { purpose: "request_seed" });
  const full = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: compiled.patterns });
  for (const form of forms) {
    const seededField = deriveTurnRequirementField({ requestText: form.text, languageMemoryState: seed.state });
    const fullField = deriveTurnRequirementField({ requestText: form.text, languageMemoryState: full });
    expect(fullField.activatedPatternIds.length).toBeGreaterThan(0);
    expect(seededField).toEqual(fullField);
    expect(projectRequestAuthority({ requirementField: seededField })).toEqual(projectRequestAuthority({ requirementField: fullField }));
    expect(projectRequestAuthority({ requirementField: seededField }).requestedAuthority).toBe(form.authority);
    if (form.requirements) expect(seededField.dialogueDependence).toBeGreaterThan(0.5);
  }
});

it("preserves source-owned entity and morphology metadata while excluding semantic output programs", () => {
  const semantic = pattern("semantic", { schema: "scce.induced_language_model.semantic_memory.v1", profileId: profile.id,
    sourceVersionId: profile.sourceVersionId, semanticFrames: [{ predicate: "not a request field" }], relationHypothesisModel: { observations: [1, 2, 3] },
    graphBoundConstructions: [{ evidenceIds: ["evidence.entity"], predicate: "r9", slots: [{ semanticRole: "entity", observedFillers: ["αλφα"], lexicalClassId: "class.entity" },
      { semanticRole: "quantity", observedFillers: ["9"], lexicalClassId: "class.quantity" }] }],
    lexicalClasses: [{ id: "class.entity", members: [{ symbol: "βήτα", count: 8 }] }, { id: "class.quantity", members: [{ symbol: "9" }] }] });
  semantic.evidenceIds = ["evidence.entity" as never];
  const morphology = pattern("morphology", { schema: "scce.induced_language_model.morphology_memory.v1",
    rules: [{ id: "rule.opaque", kind: "suffix", pattern: "STEM+¤", productivity: 1, examples: ["mira¤", "tavo¤"] }],
    classBindings: [{ ruleId: "rule.opaque", lexicalClassId: "class.opaque", confidence: 1 }] }, "morphology");
  const full = createLanguageMemoryRuntime().hydrate({ models: [], patterns: [semantic, morphology] });
  const projected = createLanguageMemoryRuntime().hydrate({ models: [], patterns: [semantic, morphology].map(requestSeedLanguagePattern) });
  const scope = { ...full.scope, profileIds: [profile.id], sourceVersionIds: [profile.sourceVersionId] };
  expect(learnedEntitySurfacesFromLanguageMemory({ ...projected, scope })).toEqual(learnedEntitySurfacesFromLanguageMemory({ ...full, scope }));
  expect(projected.structuralDeltas).toEqual(full.structuralDeltas);
  expect(projected.structuralDeltas).toHaveLength(2);
  expect(projected.importedPatterns.find(row => row.id === semantic.id)?.patternJson).not.toHaveProperty("semanticFrames");
  expect(projected.importedPatterns.find(row => row.id === semantic.id)?.patternJson).not.toHaveProperty("relationHypothesisModel");
  expect(requestSeedLanguagePattern(requestSeedLanguagePattern(semantic))).toEqual(requestSeedLanguagePattern(semantic));
});

it("preserves calibrated phrase-frame activations inside a request rather than requiring whole-request equality", async () => {
  const f = fixture([]);
  const frame: SemanticFrameRecord = { id: "frame.phrase", frameJson: { profileId: profile.id, sourceVersionId: profile.sourceVersionId,
    surface: "ψ", semanticRoleId: "role.opaque", requirementCoefficients: { noveltyDemand: 2 } }, evidenceIds: [], embedding: [], alpha: 1, createdAt: 1 };
  f.setFrames([frame]);
  const seed = await f.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "seed", undefined, "", { purpose: "request_seed" });
  const full = createLanguageMemoryRuntime().hydrate({ models: [], semanticFrames: [frame] });
  const expected = deriveTurnRequirementField({ requestText: "ψ α", languageMemoryState: full });
  expect(expected.activatedFrameIds).toEqual([frame.id]);
  expect(deriveTurnRequirementField({ requestText: "ψ α", languageMemoryState: seed.state })).toEqual(expected);
});

function span(text: string, version = "version.seed"): EvidenceSpan {
  const contentHash = ids.contentHash(text);
  return { id: ids.evidenceId({ sourceVersionId: version as SourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: contentHash }),
    sourceId: ids.sourceId("fixture", `fixture://${version}`), sourceVersionId: version as SourceVersionId,
    contentHash, charStart: 0, charEnd: [...text].length, byteStart: 0, byteEnd: Buffer.byteLength(text), text, textPreview: text,
    status: "promoted", alpha: 1 } as EvidenceSpan;
}

it.each([
  { request: (name: string) => `Where is ${name} located?`, source: (name: string, value: string) => `${name} r9 ${value}.` },
  { request: (name: string) => `${name} の尺度を示して？`, source: (name: string, value: string) => `${name} の尺度は ${value} です。` }
])("loads exact acquired request and declarative companions after seed for $request without graph facts", async ({ request, source }) => {
  const statements = [source("Luma", "Tora"), source("Vela", "Nora")];
  const requests = [request("Luma"), request("Vela")];
  const text = [...statements, ...requests].join("\n");
  const evidence = span(text);
  const anchor: SourceConstructionGraphBinding = { relationId: "relation.opaque", roleId: "role.anchor", valueKind: "entity", semanticRole: "entity" };
  const answer: SourceConstructionGraphBinding = { ...anchor, roleId: "role.answer", valueKind: "place" };
  let offset = 0;
  const observe = (surface: string, fields: Array<{ surface: string; binding: SourceConstructionGraphBinding }>, omitted: boolean): SourceBoundConstructionObservation => {
    const result = { sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id), surfaceStartCodePoint: offset, surfaceEndCodePoint: offset + [...surface].length,
      roles: fields.map((field, slotIndex) => ({ slotIndex, startCodePoint: [...surface.slice(0, surface.indexOf(field.surface))].length,
        endCodePoint: [...surface.slice(0, surface.indexOf(field.surface))].length + [...field.surface].length, graphBinding: field.binding })),
      nullRoles: omitted ? [{ slotIndex: 1, graphBinding: answer }] : [] };
    offset += [...surface].length + 1;
    return result;
  };
  const sourceObservations = statements.map((surface, index) => observe(surface, [{ surface: ["Luma", "Vela"][index]!, binding: anchor }, { surface: ["Tora", "Nora"][index]!, binding: answer }], false));
  const requestObservations = requests.map((surface, index) => observe(surface, [{ surface: ["Luma", "Vela"][index]!, binding: anchor }], true));
  const patterns = [sourceObservations, requestObservations].map((observations, index) => {
    const result = compileLanguageConstructionPattern({ bindingId: `binding.${index}`, profileId: profile.id, observations, evidence: [evidence], hasher,
      updatedAt: 1, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
    if (result.status !== "compiled") throw new Error(JSON.stringify(result));
    return result.pattern;
  });
  const f = fixture(patterns, [evidence]);
  const seed = await f.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "seed", undefined, "", { purpose: "request_seed" });
  expect(f.calls.evidence).toBe(0);
  expect(seed.state.importedConstructionBundles).toEqual([]);
  const bundles = await f.runtime.requestConstructionBundles(seed.patterns, seed.state.scope);
  expect(bundles).toHaveLength(2);
  const declaratives = bundles.filter(bundle => bundle.bindingId === "binding.0");
  expect(await f.runtime.constructionBundlesForScope(declaratives, seed.state.scope)).toEqual(declaratives);
  expect(await f.runtime.constructionBundlesForScope(declaratives, { ...seed.state.scope, profileIds: ["profile.foreign"] })).toEqual([]);
  expect(f.calls.patterns.at(-1)).toMatchObject({ patternIds: patterns.map(row => row.id).sort() });
  const fresh = span(source("Zora", "Bora"), "version.fresh");
  const resolver = sourceConstructionRequestValueResolver({ bundles, graph: { nodes: [], hyperedges: [] } });
  expect(resolveRequestValueBinding({ requestText: request("Zora"), evidence: [fresh], resolvers: [resolver] })).toMatchObject({ value: "Bora", subject: "Zora" });
  expect(resolveRequestValueBinding({ requestText: request("Zora"), evidence: [{ ...fresh, status: "quarantined" }], resolvers: [resolver] })).toBeUndefined();
  const reads = f.calls.patterns.length;
  expect(await f.runtime.requestConstructionBundles(seed.patterns, seed.state.scope)).toBe(bundles);
  expect(f.calls.patterns).toHaveLength(reads);
  expect(await f.runtime.requestConstructionBundles(seed.patterns, { ...seed.state.scope, profileIds: ["profile.foreign"] })).toEqual([]);
  expect(f.calls.patterns).toHaveLength(reads);
  expect(await f.runtime.requestConstructionBundles(seed.patterns, { ...seed.state.scope, sourceVersionIds: ["version.foreign"] })).toEqual([]);
  const sourceCheckedReads = f.calls.patterns.length;
  expect(await f.runtime.requestConstructionBundles(seed.patterns.filter(row => row.id === patterns[0]!.id), seed.state.scope)).toEqual([]);
  expect(f.calls.patterns).toHaveLength(sourceCheckedReads);
  for (const invalid of [{ ...evidence, text: evidence.text.replace("Luma", "Mira") }, { ...evidence, status: "quarantined" as const },
    { ...evidence, sourceVersionId: "version.wrong" as SourceVersionId }]) {
    const broken = fixture(patterns, [invalid]);
    const remaining = await broken.runtime.requestConstructionBundles(seed.patterns, seed.state.scope);
    expect(remaining.some(bundle => bundle.bindingId === "binding.0")).toBe(false);
    expect(resolveRequestValueBinding({ requestText: request("Zora"), evidence: [fresh],
      resolvers: [sourceConstructionRequestValueResolver({ bundles: remaining, graph: { nodes: [], hyperedges: [] } })] })).toBeUndefined();
  }
  const malformed = fixture(patterns.map(row => ({ ...row, patternJson: { ...row.patternJson as object, contentDigest: "wrong" } })), [evidence]);
  expect(await malformed.runtime.requestConstructionBundles(seed.patterns, seed.state.scope)).toEqual([]);
});
