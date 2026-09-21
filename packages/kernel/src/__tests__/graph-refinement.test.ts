// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createAlphaFieldEngine } from "../field.js";
import { clearProdCalibrations, installProdCalibrations } from "../calibrations/prod-calibrations.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { runGraphRefinement, type GraphRefinementSeedPrior } from "../graph-refinement.js";
import type { EvidenceSpan, FieldState, GraphNode, GraphSlice, TurnRequirementField } from "../index.js";

const evidence = [{ id: "evidence.one", provenance: { sourceFamilyId: "family.one" } }] as unknown as EvidenceSpan[];

function ids() {
  return createIdFactory({ clock: createClock({ fixedTime: 1_700_000_000_000 }), hasher: createHasher(), namespace: "graph-refinement-test", runSeed: "fixed", deterministicReplay: true });
}

function node(id: string): GraphNode {
  return {
    id: id as GraphNode["id"], typeId: "dimension.entity" as GraphNode["typeId"], representation: { id },
    alpha: 1, evidenceIds: ["evidence.one"] as GraphNode["evidenceIds"], features: [id],
    createdAt: 1, updatedAt: 1, metadata: {}
  };
}

function graph(temporal: "known" | "unknown" = "known"): GraphSlice {
  return {
    nodes: [node("node.a"), node("node.b")],
    edges: [{
      id: "edge.ab" as never, source: "node.a" as never, target: "node.b" as never,
      relationId: "relation.ab" as never, alpha: 1, weight: 1,
      temporalScope: temporal === "known" ? { status: "known", validFrom: 10 } : { status: "unknown", uncertainty: 1 },
      evidenceIds: ["evidence.one"] as never, createdAt: 1, updatedAt: 1, metadata: {}
    }], hyperedges: [], bounded: true, query: {}
  };
}

function field(): FieldState {
  return {
    requestFeatures: [], seeds: [], active: [{ nodeId: "node.a" as never, activation: 0.8 }],
    ppf: [], alphaTrace: {} as FieldState["alphaTrace"],
    causalMass: [{ nodeId: "node.a" as never, mass: 0.4, reason: "observed" }],
    contradictionMass: []
  };
}

function requirements(): TurnRequirementField {
  return {
    externalTruthAuthority: 0.4, sourceDependence: 0.2, noveltyDemand: 0.1, inferentialDepth: 0.2,
    semanticPreservation: 0.1, surfaceTransformation: 0.1, executableArtifactDemand: 0.1,
    actionCommitment: 0.1, dialogueDependence: 0.1, uncertaintyTolerance: 0.5, formatConstraintStrength: 0.1,
    audienceAdaptation: 0.1, brevityDetailBalance: 0.1, temporalReasoningDemand: 0.1,
    causalReasoningDemand: 0.1, counterfactualDemand: 0.1,
    requiredFeatures: [{ id: "required", dimension: "externalTruthAuthority", value: 0.9, confidence: 1, status: "explicit", origin: { requestSpan: { text: "fact", charStart: 0, charEnd: 4, byteStart: 0, byteEnd: 4 }, semanticRoleId: "role.fact", learnedFrameOrPatternId: "explicit" }, sourceActivationId: "explicit", trace: {} }],
    prohibitedFeatures: [{ id: "prohibited", dimension: "noveltyDemand", value: 0.1, confidence: 1, status: "explicit", origin: { requestSpan: { text: "fact", charStart: 0, charEnd: 4, byteStart: 0, byteEnd: 4 }, semanticRoleId: "role.fact", learnedFrameOrPatternId: "explicit" }, sourceActivationId: "explicit", trace: {} }],
    activatedFrameIds: [], activatedPatternIds: [], activatedPhraseUnitIds: [], activatedDialogueMoveIds: [], activatedConstructIds: [],
    learnedRequirementBounds: { temporalReasoningDemand: { lower: 0.05, upper: 0.6 } },
    confidence: 0.7, trace: { source: "fixture" }
  };
}

function run(overrides: Partial<Parameters<typeof runGraphRefinement>[0]> = {}) {
  const first = field();
  let callbackCount = 0;
  const result = runGraphRefinement({
    graph: graph(), evidence, initialRequirements: requirements(), firstField: first, idFactory: ids(),
    runSecondPass: (seedPriors: readonly GraphRefinementSeedPrior[]) => {
      callbackCount += 1;
      return { ...first, seeds: seedPriors.map(seed => ({ ...seed, feature: seed.feature ?? "graph-refinement.structural" })) };
    },
    ...overrides
  });
  return { result, callbackCount };
}

describe("bounded structural refinement", () => {
  afterEach(() => clearProdCalibrations());
  it("is deterministic and calls exactly one second pass", () => {
    const first = run();
    const second = run();
    expect(first.callbackCount).toBe(1);
    expect(second.callbackCount).toBe(1);
    expect(first.result).toEqual(second.result);
  });

  it("does nothing when disabled or the caller reports no graph", () => {
    for (const option of [{ disabled: true }, { noGraph: true }]) {
      const { result, callbackCount } = run(option);
      expect(callbackCount).toBe(0);
      expect(result.refinedRequirements).toBe(result.initialRequirements);
      expect(result.finalField.seeds).toEqual([]);
      expect(result.trace.executed).toBe(false);
    }
  });

  it("uses known temporal support and activated nodes, never observation time or unknown validity", () => {
    const known = run().result;
    const unknown = run({ graph: graph("unknown") }).result;
    expect(known.refinedRequirements.temporalReasoningDemand).toBeGreaterThan(unknown.refinedRequirements.temporalReasoningDemand);
    expect(known.structuralContext.activatedNodeIds).toContain("node.a");
    expect(known.seedBias.map(seed => String(seed.nodeId))).toContain("node.a");
    expect(unknown.structuralContext.support.temporalObjectIds).toEqual([]);
  });

  it("preserves explicit and prohibited requirements, bounds, and confidence", () => {
    const initial = requirements();
    const { result } = run({ initialRequirements: initial });
    expect(result.refinedRequirements.requiredFeatures).toEqual(initial.requiredFeatures);
    expect(result.refinedRequirements.prohibitedFeatures).toEqual(initial.prohibitedFeatures);
    expect(result.refinedRequirements.learnedRequirementBounds).toEqual(initial.learnedRequirementBounds);
    expect(result.refinedRequirements.confidence).toBe(initial.confidence);
    expect(result.refinedRequirements.noveltyDemand).toBe(initial.noveltyDemand);
    expect(result.refinedRequirements.externalTruthAuthority).toBe(initial.externalTruthAuthority);
  });

  it("requires actual activation and ignores unrelated source families", () => {
    const unrelated = { id: "evidence.unrelated", provenance: { sourceFamilyId: "family.two" } } as unknown as EvidenceSpan;
    const inactive = run({ firstField: { ...field(), active: [] }, evidence: [...evidence, unrelated] }).result;
    expect(inactive.structuralContext.logitShifts).toEqual({ temporalReasoningDemand: 0, causalReasoningDemand: 0, inferentialDepth: 0, sourceDependence: 0 });
    expect(inactive.seedBias).toEqual([]);
    expect(inactive.trace.evidenceIds).toEqual([]);
    const active = run({ evidence: [...evidence, unrelated] }).result;
    expect(active.structuralContext.activatedSourceFamilyIds).toEqual(["family.one"]);
    expect(active.refinedRequirements.sourceDependence).toBe(active.initialRequirements.sourceDependence);
    expect(active.trace.evidenceIds).toEqual(["evidence.one"]);
  });

  it("clamps learned ranges and freezes explicit, prohibited, and endpoint values", () => {
    const initial = requirements();
    initial.learnedRequirementBounds = { temporalReasoningDemand: { lower: 0.05, upper: 0.11 } };
    initial.requiredFeatures.push({ ...initial.requiredFeatures[0]!, dimension: "inferentialDepth" });
    initial.prohibitedFeatures.push({ ...initial.prohibitedFeatures[0]!, dimension: "causalReasoningDemand" });
    const result = run({ initialRequirements: initial }).result;
    expect(result.refinedRequirements.temporalReasoningDemand).toBe(0.11);
    expect(result.refinedRequirements.inferentialDepth).toBe(initial.inferentialDepth);
    expect(result.refinedRequirements.causalReasoningDemand).toBe(initial.causalReasoningDemand);
    expect(result.refinedRequirements.contributedDimensions).toEqual(["temporalReasoningDemand"]);
    for (const value of [0, 1]) {
      expect(run({ initialRequirements: { ...requirements(), causalReasoningDemand: value } }).result.refinedRequirements.causalReasoningDemand).toBe(value);
    }
  });

  it("does not refine a field twice and binds bypass reasons into factory IDs", () => {
    const once = run().result;
    const again = run({ initialRequirements: once.refinedRequirements, firstField: once.finalField });
    expect(again.callbackCount).toBe(0);
    expect(again.result.trace.refinement).toBe("already_refined");
    expect(again.result.refinedRequirements).toBe(once.refinedRequirements);
    expect(run({ disabled: true }).result.trace.id).not.toBe(run({ noGraph: true }).result.trace.id);
    const normalFactory = () => createIdFactory({ clock: createClock(), hasher: createHasher(), namespace: "same" });
    expect(run({ idFactory: normalFactory() }).result.trace.id).toBe(run({ idFactory: normalFactory() }).result.trace.id);
  });

  it("changes the real second field when requirements change on the same first field", () => {
    const slice = graph();
    const engine = createAlphaFieldEngine({ clock: createClock({ fixedTime: 20 }) });
    const first = engine.activate({ text: "", ...slice, seedPriors: [{ nodeId: slice.nodes[0]!.id, weight: 0.8 }] });
    const execute = (temporalReasoningDemand: number) => run({
      graph: slice, firstField: first, initialRequirements: { ...requirements(), temporalReasoningDemand },
      runSecondPass: seedPriors => engine.activate({ text: "", ...slice, previous: first, seedPriors: [...seedPriors] })
    }).result;
    const low = execute(0.1);
    const high = execute(0.5);
    expect(low.seedBias).not.toEqual(high.seedBias);
    expect(low.finalField.ppf).not.toEqual(high.finalField.ppf);
    expect(high.finalField).not.toBe(first);
    expect(high.trace.callbackCount).toBe(1);
    expect(high.seedBias.every(seed => slice.nodes.some(node => node.id === seed.nodeId))).toBe(true);
  });

  it("keeps contradictory structure visible while increasing source scrutiny", () => {
    const baseline = run().result;
    const conflicted = run({ firstField: { ...field(), contradictionMass: [{ nodeId: "node.a" as never, mass: 1, reserved: true }] } }).result;
    const weight = (result: typeof baseline) => result.seedBias.find(seed => seed.nodeId === "node.a")!.weight;
    expect(conflicted.structuralContext.contradictionMass).toBeGreaterThan(0);
    expect(conflicted.refinedRequirements.sourceDependence).toBeGreaterThan(baseline.refinedRequirements.sourceDependence);
    expect(weight(conflicted)).toBeGreaterThanOrEqual(weight(baseline));
    expect(conflicted.refinedRequirements.externalTruthAuthority).toBe(baseline.refinedRequirements.externalTruthAuthority);
    expect(conflicted.refinedRequirements.confidence).toBe(baseline.refinedRequirements.confidence);
  });

  it("uses installed calibration settings for shifts, weights and bounded seed counts", () => {
    const baseline = run().result;
    const settings = {
      "graph_refinement.max_logit_shift": 0,
      "graph_refinement.max_structural_seeds": 1,
      "graph_refinement.max_seeds": 1,
      "graph_refinement.seed_weight.active": 0,
      "graph_refinement.seed_weight.temporal": 1,
      "graph_refinement.seed_weight.causal": 0,
      "graph_refinement.seed_weight.composition": 0,
      "graph_refinement.seed_weight.source_diversity": 0
    };
    expect(installProdCalibrations(settings).ignored).toEqual([]);
    const configured = run().result;
    expect(configured.seedBias).toHaveLength(1);
    expect(configured.seedBias).not.toEqual(baseline.seedBias);
    expect(configured.refinedRequirements.temporalReasoningDemand).toBe(configured.initialRequirements.temporalReasoningDemand);
    expect(configured.trace.normalization).toMatchObject({ maxLogitShift: 0, maxSeeds: 1,
      productionOverrideIds: expect.arrayContaining(Object.keys(settings)), seedWeights: { temporal: 1, active: 0 } });
    expect(configured.trace.calibration).toBe("uncalibrated_structural_applicability");
    installProdCalibrations({ "graph_refinement.max_seeds": 1000, "graph_refinement.max_structural_seeds": 1000 });
    expect(run().result.trace.normalization).toMatchObject({ maxSeeds: 48, maxStructuralSeeds: 48 });
  });
});
