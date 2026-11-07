// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import * as induction from "../language-induction.js";
import { preparedLanguageInductionModel } from "../graph-surface-alignment.js";
import { compileUniversalCreativeEventConstructionPattern } from "../language-construction-memory.js";
import { scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { primeLearnedAnswerUnitForms } from "../learned-answer-unit-forms.js";
import { requestUnitMatchesSurface } from "../local-evidence-runtime.js";
import {
  compileLanguageTrainingBatch,
  CORPUS_SOURCE_SYSTEM_IDS,
  CORPUS_ROLE_IDS,
  createClock,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  prepareLanguageTrainingSegmentation,
  toJsonValue,
  type EvidenceSpan,
  type GraphNode,
  type Hyperedge,
  type NodeId
} from "../index.js";

describe("shared language training batch", () => {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 140_000, stepMs: 1 });
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "language-training-batch" });
  const language = createLanguageAcquisitionEngine({ idFactory: ids });
  const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

  it("projects the one source induction into canonical scoped forms and reuses it for creative compilation", () => {
    const text = "walla r0. wallawalla r0. tinu r0. tinutinu r0. kobo r0. kobokobo r0. "
      + "cat chased mouse. dog chased ball. cat chased ball. dog chased mouse. cat chased mouse. dog chased ball.";
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
    const evidence = [evidenceSpan(text, sourceVersionId)];
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    try {
      const compiled = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: "fixture://shared-induced", sourceSystem: "gutenberg", profile,
        sourceVersionId, text, evidence, createdAt: 140_000, retainNgramObservations: false } });
      expect(engine).toHaveBeenCalledTimes(1);
      const patterns = compiled.patterns.filter(pattern => (pattern.patternJson as { schema?: string }).schema === "scce.induced_language_model.morphology_memory.v1");
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.evidenceIds).toEqual([evidence[0]!.id]);
      const state = scopeLanguageMemoryStateToLanguage(runtime.hydrate({ models: compiled.models, patterns: compiled.patterns, units: compiled.units,
        semanticFrames: compiled.semanticFrames, constructionEvidence: evidence }), "language.fixture", { profile: () => "language.fixture", corpus: () => "language.fixture" });
      primeLearnedAnswerUnitForms({ deltas: state.structuralDeltas ?? [], profileIds: new Set(state.importedPatterns.map(pattern => pattern.profileId)) });
      expect(requestUnitMatchesSurface("walla", "wallawalla")).toBe(true);
      expect(requestUnitMatchesSurface("walla", "wallaxwalla")).toBe(false);
      expect(compileUniversalCreativeEventConstructionPattern({ profileId: profile.id, evidence, hasher, updatedAt: 140_000, preparedInduction: compiled.preparedInduction }).status).toBe("compiled");
      expect(engine).toHaveBeenCalledTimes(1);
      const documents = evidence.map(span => ({ id: String(span.id), sourceVersionId: span.sourceVersionId, evidenceIds: [span.id], text: span.text }));
      expect(preparedLanguageInductionModel({ documents, hasher, prepared: compiled.preparedInduction })?.morphology.length).toBeGreaterThan(0);
      expect(() => preparedLanguageInductionModel({ documents: documents.map(doc => ({ ...doc, text: doc.text + " changed" })), hasher, prepared: compiled.preparedInduction })).toThrow("inputs changed");
      expect(() => preparedLanguageInductionModel({ documents, hasher, prepared: { ...compiled.preparedInduction! } })).toThrow("inputs changed");
    } finally { engine.mockRestore(); primeLearnedAnswerUnitForms({ deltas: [], profileIds: new Set() }); }
  });

  it("dispatches formal source roles to token models without natural grammar induction", () => {
    const text = 'export const label = (value: string) => "two words" + value;';
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
    const evidence = [evidenceSpan(text, sourceVersionId)];
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    try {
      expect(prepareLanguageTrainingSegmentation({ batch: { text, createdAt: 140_000 }, tenantId: "fixture", corpusRole: CORPUS_ROLE_IDS.softwareSymbolic,
        activeImportVersion: "fixture", hasher })).toBeUndefined();
      expect(prepareLanguageTrainingSegmentation({ batch: { text: "Source documentation.", createdAt: 140_000 }, tenantId: "fixture", corpusRole: CORPUS_ROLE_IDS.softwareDocumentation,
        activeImportVersion: "fixture", hasher })).toBeDefined();
      for (const sourceSystem of ["oss_code", CORPUS_SOURCE_SYSTEM_IDS.ossCode]) {
        const compiled = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: "fixture://code", sourceSystem,
          profile, sourceVersionId, text, evidence, createdAt: 140_000 } });
        expect(compiled.models).toHaveLength(1);
        expect(compiled.observations.some(row => row.symbol === '"two words"')).toBe(true);
        expect(compiled.units).toEqual([]);
        expect(compiled.patterns).toEqual([]);
        expect(compiled.semanticFrames).toEqual([]);
        expect(compiled.constructionCandidates).toBe(0);
        expect(compiled.constructionPromotion.heldOutCoverage).toEqual([]);
      }
      expect(engine).not.toHaveBeenCalled();
    } finally { engine.mockRestore(); }
  });

  it("keeps construction induction out of a language-only batch with held-out evidence", () => {
    const text = "cat chased mouse. dog chased ball. cat pushed cart. dog pushed box.";
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
    const evidence = Array.from({ length: 4 }, (_, index) => evidenceSpan(text, ids.sourceVersionId(`source.${index}`)));
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    try {
      const compiled = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: "fixture://language-only", profile, sourceVersionId, text, evidence, createdAt: 140_000, languageOnly: true } });
      expect(compiled.constructionPromotion.heldOutEvidence).toBeGreaterThan(0);
      expect(compiled.constructionPromotion.heldOutCoverage).toEqual([]);
      expect(engine).not.toHaveBeenCalled();
    } finally { engine.mockRestore(); }
  });

  it("compiles evidence-owned semantic frames once across text chunks", () => {
    const text = "a".repeat(150_001);
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text: "fixture", createdAt: 140_000 });
    const frame = { id: "frame.fixture", frameJson: {}, embedding: [], evidenceIds: [], alpha: 1, createdAt: 140_000 };
    let emittedFrames = 0;
    const boundedRuntime = {
      train(input: { retainSemanticFrames?: boolean }) {
        const frames = input.retainSemanticFrames === false ? [] : [frame];
        emittedFrames += frames.length;
        return { observations: [], models: [], units: [], patterns: [], semanticFrames: frames, audit: {} };
      }
    } as unknown as typeof runtime;
    const compiled = compileLanguageTrainingBatch({ runtime: boundedRuntime, hasher, batch: { streamId: "fixture://chunks", profile, sourceVersionId, text, evidence: [], createdAt: 140_000, languageOnly: true } });
    expect(compiled.semanticFrames).toEqual([frame]);
    expect(emittedFrames).toBe(1);
  });

  it("compiles bounded typed-incidence candidate supports on the production training path", () => {
    const text = "Ada built engine.";
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
    const evidence = evidenceSpan(text, sourceVersionId);
    const node = {
      id: "node.ada" as NodeId,
      typeId: "dimension.fixture" as GraphNode["typeId"],
      representation: "Ada",
      alpha: 1,
      evidenceIds: [evidence.id],
      features: [],
      createdAt: 140_000,
      updatedAt: 140_000,
      metadata: {}
    } satisfies GraphNode;
    const hyperedge = {
      schema: "scce.hyperedge.v2",
      id: "hyperedge.ada" as Hyperedge["id"],
      relationId: "relation.built" as Hyperedge["relationId"],
      participantPorts: [{
        portId: "port.ada",
        roleId: "role.opaque",
        nodeId: node.id,
        valueKind: "observable.string",
        realization: "observed",
        evidenceIds: [evidence.id]
      }],
      memberNodeIds: [node.id],
      qualifiers: {},
      modality: {},
      evidenceIds: [evidence.id],
      weightVector: { alpha: 1 },
      temporalScope: {},
      provenanceRefs: [String(evidence.id)],
      createdAt: 140_000,
      updatedAt: 140_000
    } satisfies Hyperedge;
    const compiled = compileLanguageTrainingBatch({
      runtime,
      hasher,
      batch: {
        streamId: "fixture://typed-incidence-training",
        profile,
        sourceVersionId,
        text,
        evidence: [evidence],
        createdAt: 140_000,
        graphSnapshot: { nodes: [node], edges: [], hyperedges: [hyperedge] },
        maxAlignmentCandidateDegree: 2
      }
    });

    expect(compiled.sparseAlignmentCandidateSupports).toHaveLength(1);
    expect(compiled.sparseAlignmentCandidateSupports[0]!.maxCandidateDegree).toBe(2);
    expect(compiled.sparseAlignmentCandidateSupports[0]!.candidates.some(candidate =>
      candidate.supportKinds.includes("exact_observable_anchor"))).toBe(true);
    expect(compiled.sparseAlignmentCandidateSummaries).toHaveLength(1);
    expect(compiled.alignmentCommunityRoutings).toHaveLength(1);
    expect(compiled.alignmentCommunityRoutings[0]).toMatchObject({
      schema: "scce.alignment_community_routing.v2"
    });
    expect(compiled.alignmentCommunityRoutings[0]!.routedSupport.parentSupportId)
      .toBe(compiled.sparseAlignmentCandidateSupports[0]!.id);
    expect(compiled.coarseToFineAlignments).toHaveLength(1);
    expect(compiled.coarseToFineAlignments[0]).toMatchObject({
      schema: "scce.coarse_to_fine_alignment.v1",
      globalOptimalityClaimed: false
    });
    expect(compiled.alignmentCalibrationModel).toMatchObject({
      schema: "scce.alignment_calibration_model.v1",
      status: "insufficient_data",
      holdoutMetrics: null
    });
    expect(compiled.alignmentPromotionModel).toMatchObject({
      schema: "scce.alignment_heldout_promotion.v1"
    });
    expect(compiled.alignmentPromotionModel.decisions.every(decision =>
      !decision.promoted
      && decision.reasons.includes("independent_heldout_families_low"))).toBe(true);
    expect(compiled.reversibleConstructions).toEqual([]);
    expect(compiled.reversibleConstructionPatterns).toEqual([]);
    expect(compiled.pairedAntiUnifiedConstructions).toEqual([]);
    expect(compiled.pairedAntiUnifiedConstructionPatterns).toEqual([]);
    expect(compiled.admittedPairedAntiUnifiedConstructions).toEqual([]);
    expect(compiled.graphCorrelatedVariabilityModel).toMatchObject({
      schema: "scce.graph_correlated_surface_variability.v1",
      decisions: []
    });
    expect(compiled.optionalNullRealizationModel).toMatchObject({
      schema: "scce.optional_null_realization_model.v1",
      status: "insufficient_observations"
    });
    expect(compiled.optionalNullRealizationPatterns).toEqual([]);
    expect(compiled.sparseTransportPlans).toHaveLength(1);
    expect(compiled.sparseTransportPlans[0]!.cells).toHaveLength(
      compiled.sparseAlignmentCandidateSupports[0]!.candidates.length
    );
    expect(compiled.sparseTransportPlans[0]!.globalOptimalityClaimed).toBe(false);
    expect(compiled.typedNullCostModel).toMatchObject({
      schema: "scce.typed_null_alignment_cost_model.v1",
      calibrated: false
    });
    expect(compiled.sparseTransportPlans[0]!.typedNullCostModelId).toBe(
      compiled.typedNullCostModel!.id
    );
    expect(compiled.populationOrderingModel).toMatchObject({
      schema: "scce.population_relative_order_model.v2"
    });
    expect(compiled.sparseTransportPlans[0]!.populationOrderingModelId).toBe(
      compiled.populationOrderingModel!.id
    );
    expect(compiled.crossDocumentAlignmentModel).toMatchObject({
      schema: "scce.cross_document_alignment_consistency.v1"
    });
    expect(compiled.sparseTransportPlans[0]!.crossDocumentAlignmentModelId).toBe(
      compiled.crossDocumentAlignmentModel!.id
    );
    expect(compiled.alignmentAlternativeSets).toHaveLength(1);
    expect(compiled.alignmentAlternativeSets[0]).toMatchObject({
      schema: "scce.alignment_alternative_set.v1",
      posteriorScope: "retained_candidate_set_only",
      exactGlobalPosteriorClaimed: false
    });
    expect(compiled.alignmentAlternativeSets[0]!.hypotheses.some(hypothesis =>
      hypothesis.plan.id === compiled.sparseTransportPlans[0]!.id)).toBe(true);
    expect(compiled.alignmentAlternativeSets[0]!.hypotheses.reduce(
      (sum, hypothesis) => sum + hypothesis.restrictedGibbsWeight,
      0
    )).toBeCloseTo(1, 12);
    expect(compiled.sparseTransportPlans[0]!.rowMarginals.every(row =>
      row.surfaceNullMass >= 0)).toBe(true);
    expect(compiled.sparseTransportPlans[0]!.columnMarginals.every(column =>
      column.graphImplicitMass >= 0)).toBe(true);
    expect(compiled.transportEvidenceAllocations).toHaveLength(1);
    expect(compiled.transportEvidenceAllocations[0]!.status).toBe("conserved");
    expect(compiled.transportEvidenceAllocations[0]!.totalAllocatedMass).toBeCloseTo(
      compiled.transportEvidenceAllocations[0]!.totalTransportMass,
      12
    );
    expect(JSON.stringify(compiled.audit)).toContain("\"denseMatrixMaterialized\":false");
  });

  function evidenceSpan(text: string, sourceVersionId: ReturnType<typeof ids.sourceVersionId>): EvidenceSpan {
    const sourceId = ids.sourceId("fixture", `fixture://typed-incidence-training/${sourceVersionId}`);
    const contentHash = ids.contentHash(text);
    return {
      id: ids.evidenceId({
        sourceVersionId,
        byteStart: 0,
        byteEnd: Buffer.byteLength(text),
        spanHash: contentHash
      }),
      sourceId,
      sourceVersionId,
      chunkId: ids.chunkId({
        sourceVersionId,
        byteStart: 0,
        byteEnd: Buffer.byteLength(text),
        chunkHash: contentHash
      }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: Buffer.byteLength(text),
      charStart: 0,
      charEnd: [...text].length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ sourceFamilyId: `family.fixture.${sourceVersionId}` }),
      features: [],
      status: "promoted",
      alpha: 1,
      observedAt: 140_000
    };
  }
});
