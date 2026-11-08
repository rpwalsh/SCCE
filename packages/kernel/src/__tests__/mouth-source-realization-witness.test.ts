// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createClock, createHasher, featureSet, toJsonValue } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createEvidenceExtractor } from "../evidence.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { createCorrectionMemory } from "../correction-memory.js";
import { createMouth } from "../mouth.js";
import { sourceBoundFactSurfaceWitness } from "../mouth-source-realization-witness.js";
import { sourceOwnedSemanticSurfacePatterns } from "./fixtures/source-owned-semantic-surface.js";
import type { ConstructGraph, FieldState } from "../types.js";

function teaching(surface = "Aster counts the 42 nodes in 2024.", subject = "Aster", predicate = "counts", object = "42 nodes in 2024") {
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const sourceVersionId = ids.sourceVersionId(surface);
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: surface, createdAt: 1 });
  const evidence = createEvidenceExtractor({ idFactory: ids, hasher }).extract({ sourceId: ids.sourceId("test_authored", "fixture://surface-role-contract"),
    sourceVersionId, namespace: "test_authored", uri: "fixture://surface-role-contract", mediaType: "text/plain", text: surface,
    languageProfile: profile, observedAt: 1, maxChunkBytes: 4096, sourceTrust: { identity: 1, integrity: 1, parserReliability: 1,
      directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "fixture", licenseStatus: "fixture" } }).spans
    .map(span => ({ ...span, status: "promoted" as const, alpha: 1 }));
  expect(evidence).toHaveLength(1);
  const fact = { subject, predicate, object, relationId: "relation.opaque", sourceNodeId: "node.subject", targetNodeId: "node.value",
    forceClass: "learned_concept_prior" as const, score: 1, activation: 1, overlap: 1, support: 1 };
  const patterns = sourceOwnedSemanticSurfacePatterns({ evidence: evidence[0]!, profileId: profile.id, hasher, facts: [{ ...fact, surface }] });
  const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const memory = runtime.hydrate({ models: [], patterns, constructionEvidence: evidence });
  expect(memory.rejectedConstructionPatterns).toEqual([]);
  expect(memory.importedConstructionBundles).toHaveLength(1);
  const matrix = { nodes: [], values: [] };
  const field: FieldState = { requestFeatures: [], seeds: [], active: [], ppf: [], ppfDiagnostics: {}, causalMass: [], alphaTrace: {
    alpha: 1, thresholds: { virtual: 1, visible: 1, bonded: 1, structural: 1 }, relations: [], adjacency: matrix, laplacian: matrix,
    normalizedLaplacian: matrix, surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 }, contradictionMass: 0, bondedLeakage: 0 } };
  const construct: ConstructGraph = { id: ids.constructId({}), episodeId: ids.episodeId(), forceVector: {}, nodes: [{ id: "construct.source-facts",
    kind: "construct:semantic_answer", label: subject, metadata: toJsonValue({ schema: "scce.semantic_answer_construct.v1", selectedSubject: subject,
      selectedFacts: [fact], supportIds: [], forceId: "output.force.learned_concept_prior_answer", boundaryId: "output.force.import_bound",
      certificationBoundary: { directEvidenceCount: 0, evidenceSpanIds: [], sourceVersionIds: [], externalFactCertification: false } }) }], edges: [], artifacts: [] };
  const witness = (text: string, selectedFact: typeof fact & { sourceVersionId?: string; evidenceIds?: string[]; relationRoleId?: string; requestedSlotId?: string } = fact,
    bundles = memory.importedConstructionBundles) => sourceBoundFactSurfaceWitness({
    text, fact: selectedFact, bundles, profileIds: new Set([profile.id]) });
  const speak = async (text: string, aligned = true) => {
    const state = runtime.hydrate({ models: [], patterns: aligned ? patterns : [], constructionEvidence: evidence,
      units: [{ id: "unit.source-surface", profileId: profile.id, sourceVersionId, script: "Latin", unitKind: "phrase", text,
        features: featureSet(text, 64), competenceVector: [1], alpha: 1, evidenceIds: [], metadata: { sourceSystem: "test_authored", provenanceClass: "learned_language_prior" } }] });
    return createMouth({ languageMemory: runtime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text), hasher })
      .speak({ construct, field, languageProfile: profile, languageMemory: state, evidence: [], requestedAuthority: "factual",
        entailment: createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: subject, evidence: [], nodes: [], field, createdAt: 1 }) });
  };
  return { surface, fact, witness, speak, memory, profile };
}

describe("source-owned typed surface realization", () => {
  it("carries admitted source roles through Mouth without inventing a synthetic sentence", async () => {
    const fixture = teaching();
    expect(fixture.witness(fixture.surface)).toMatchObject({ sourceVersionId: fixture.memory.importedConstructionBundles[0]!.sourceVersionIds[0] });
    const spoken = await fixture.speak(fixture.surface);
    expect(spoken.text).toBe(fixture.surface);
    expect(spoken.realizationTrace.selected.id).toContain("candidate:learned-prior-surface");
    expect(spoken.evidenceRefs).toEqual([]);
  });

  it.each([
    ["quantity", "Aster counts the 99 nodes in 2024."],
    ["year", "Aster counts the 42 nodes in 2025."],
    ["question force", "Aster counts the 42 nodes in 2024?"],
    ["extra predicate", "Aster counts the 42 nodes in 2024 and sells them."],
    ["extra sentence", "Aster counts the 42 nodes in 2024. Aster sells nodes."]
  ])("rejects a changed %s through the actual Mouth consumer", async (_, surface) => {
    const fixture = teaching();
    expect(fixture.witness(surface)).toBeUndefined();
    expect((await fixture.speak(surface)).text).toBe("");
  });

  it("withholds an unaligned raw unit even when it contains every selected role value", async () => {
    const fixture = teaching();
    expect((await fixture.speak(fixture.surface, false)).text).toBe("");
  });

  it("preserves opaque Unicode role spans and attested punctuation", () => {
    const fixture = teaching("Άστερ μετρά τα 42 σημεία το 2024。", "Άστερ", "μετρά", "42 σημεία το 2024");
    expect(fixture.witness(fixture.surface)).toBeDefined();
    expect(fixture.witness(fixture.surface.replace("2024", "2025"))).toBeUndefined();
  });

  it("does not grant source meaning through a foreign relation, profile, or changed bundle retaining its old IDs", () => {
    const fixture = teaching();
    expect(fixture.witness(fixture.surface, { ...fixture.fact, relationId: "relation.other" })).toBeUndefined();
    expect(fixture.witness(fixture.surface, { ...fixture.fact, sourceVersionId: "source.foreign" })).toBeUndefined();
    expect(fixture.witness(fixture.surface, { ...fixture.fact, evidenceIds: ["evidence.foreign"] })).toBeUndefined();
    expect(fixture.witness(fixture.surface, { ...fixture.fact, relationRoleId: "source.role.2", requestedSlotId: "source.role.2" })).toBeDefined();
    expect(fixture.witness(fixture.surface, { ...fixture.fact, relationRoleId: "source.role.0", requestedSlotId: "source.role.0" })).toBeUndefined();
    expect(fixture.witness(fixture.surface, { ...fixture.fact, relationRoleId: "source.role.2", requestedSlotId: "source.role.0" })).toBeUndefined();
    expect(sourceBoundFactSurfaceWitness({ text: fixture.surface, fact: fixture.fact,
      bundles: fixture.memory.importedConstructionBundles, profileIds: new Set(["profile.foreign"]) })).toBeUndefined();
    const forged = structuredClone(fixture.memory.importedConstructionBundles);
    forged[0]!.sourceExamples[0]!.roles[1]!.graphBinding!.relationId = "relation.other";
    expect(fixture.witness(fixture.surface, fixture.fact, forged)).toBeUndefined();
    const changedSurface = structuredClone(fixture.memory.importedConstructionBundles);
    changedSurface[0]!.sourceExamples[0]!.surface = fixture.surface.replace("the", "any");
    expect(fixture.witness(fixture.surface.replace("the", "any"), fixture.fact, changedSurface)).toBeUndefined();
  });
});
