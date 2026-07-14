import { describe, expect, it } from "vitest";
import { createIdFactory } from "../ids.js";
import {
  POWERWALK_TRANSITION_OBSERVATION_SCHEMA,
  fitPowerWalkParameters,
  initializePowerWalkParameters,
  powerWalkTransitionDistribution,
  type PowerWalkParams,
  type PowerWalkTransitionObservation
} from "../powerwalk.js";
import { createClock, createHasher } from "../primitives.js";
import type { GraphEdge, GraphNode, NodeId } from "../types.js";

describe("PowerWalk parameter fitting", () => {
  const DAY_MS = 86_400_000;
  const NOW = 2_000_000_000_000;
  const TYPE_ID = "type.opaque.7";
  const TYPE_PAIR = `${TYPE_ID}->${TYPE_ID}`;

  it("labels graph statistics as initialization and normalizes p/q/lambda transition semantics", () => {
    const clock = createClock({ fixedTime: NOW, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "powerwalk-fit-initializer" });
    const typeId = ids.dimensionId(TYPE_ID);
    const relationId = ids.relationId("relation.opaque.11");
    const left: GraphNode = { id: ids.nodeId("left"), typeId, representation: "left", alpha: 1, evidenceIds: [], features: [], createdAt: NOW, updatedAt: NOW, metadata: {} };
    const right: GraphNode = { id: ids.nodeId("right"), typeId, representation: "right", alpha: 1, evidenceIds: [], features: [], createdAt: NOW, updatedAt: NOW, metadata: {} };
    const graphEdge: GraphEdge = {
      id: ids.edgeId({ source: left.id, target: right.id, relationId, provenanceHash: "opaque-source" }),
      source: left.id,
      target: right.id,
      relationId,
      alpha: 1,
      weight: 1,
      temporalScope: { validFrom: NOW },
      evidenceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
      metadata: {}
    };
    const initialized = initializePowerWalkParameters([left, right], [graphEdge], NOW);
    expect(initialized.audit).toMatchObject({
      schema: "scce.powerwalk_parameter_initialization.v1",
      method: "graph_statistics_bootstrap",
      fitted: false,
      claimBoundary: "deterministic_initializer_only"
    });

    const observation = transitionObservation({
      id: "observation.normalization",
      sourceRecordId: "source.normalization",
      candidates: [
        { suffix: "return", target: "previous", distance: 0, ageDays: 0 },
        { suffix: "neighbor", target: "neighbor", distance: 1, ageDays: 0 },
        { suffix: "outward", target: "outward", distance: 2, ageDays: 10 }
      ],
      selectedIndex: 2
    });
    const params = parameters(2, 4, Math.log(2) / 10);
    const distribution = powerWalkTransitionDistribution(observation, params);
    const probability = (suffix: string) => distribution.candidates.find(row => row.edgeId.endsWith(suffix))!.probability;
    expect(distribution.candidates.reduce((sum, row) => sum + row.probability, 0)).toBeCloseTo(1, 14);
    expect(probability("return")).toBeCloseTo(0.5 / 1.625, 12);
    expect(probability("neighbor")).toBeCloseTo(1 / 1.625, 12);
    expect(probability("outward")).toBeCloseTo(0.125 / 1.625, 12);

    const largerP = powerWalkTransitionDistribution(observation, parameters(4, 4, Math.log(2) / 10));
    const largerQ = powerWalkTransitionDistribution(observation, parameters(2, 8, Math.log(2) / 10));
    const largerLambda = powerWalkTransitionDistribution(observation, parameters(2, 4, Math.log(2) / 5));
    expect(candidateProbability(largerP, "return")).toBeLessThan(probability("return"));
    expect(candidateProbability(largerQ, "outward")).toBeLessThan(probability("outward"));
    expect(candidateProbability(largerLambda, "outward")).toBeLessThan(probability("outward"));
  });

  it("preserves weighted first-order semantics at unit p/q with no decay and has directional p/q effects", () => {
    const observation = transitionObservation({
      id: "observation.directional-semantics",
      sourceRecordId: "source.directional-semantics",
      candidates: [
        { suffix: "return", target: "previous", distance: 0, ageDays: 0, edgeWeight: 2, edgeAlpha: 0.5 },
        { suffix: "local", target: "local", distance: 1, ageDays: 0, edgeWeight: 3, edgeAlpha: 1 },
        { suffix: "outward", target: "outward", distance: 2, ageDays: 0, edgeWeight: 4, edgeAlpha: 0.5 }
      ],
      selectedIndex: 1
    });

    const firstOrder = powerWalkTransitionDistribution(observation, parameters(1, 1, 0));
    expect(candidateProbability(firstOrder, "return")).toBeCloseTo(1 / 6, 12);
    expect(candidateProbability(firstOrder, "local")).toBeCloseTo(3 / 6, 12);
    expect(candidateProbability(firstOrder, "outward")).toBeCloseTo(2 / 6, 12);

    const lowerP = powerWalkTransitionDistribution(observation, parameters(0.5, 1, 0));
    expect(candidateProbability(lowerP, "return")).toBeGreaterThan(candidateProbability(firstOrder, "return"));

    const lowerQ = powerWalkTransitionDistribution(observation, parameters(1, 0.5, 0));
    expect(candidateProbability(lowerQ, "outward")).toBeGreaterThan(candidateProbability(firstOrder, "outward"));

    const higherQ = powerWalkTransitionDistribution(observation, parameters(1, 2, 0));
    expect(candidateProbability(higherQ, "local")).toBeGreaterThan(candidateProbability(firstOrder, "local"));
  });

  it("approximately recovers p, q, and lambda from deterministic source-disjoint observations", () => {
    const hasher = createHasher();
    const observations: PowerWalkTransitionObservation[] = [];
    for (let group = 0; group < 10; group++) {
      const sourceRecordId = `source.recovery.${group}`;
      for (let index = 0; index < 40; index++) {
        observations.push(transitionObservation({
          id: `recovery.${group}.p.${index}`,
          sourceRecordId,
          candidates: [
            { suffix: "return", target: "previous", distance: 0, ageDays: 0 },
            { suffix: "neighbor", target: "neighbor", distance: 1, ageDays: 0 }
          ],
          selectedIndex: index < 10 ? 0 : 1
        }));
        observations.push(transitionObservation({
          id: `recovery.${group}.q.${index}`,
          sourceRecordId,
          candidates: [
            { suffix: "outward", target: "outward", distance: 2, ageDays: 0 },
            { suffix: "neighbor", target: "neighbor", distance: 1, ageDays: 0 }
          ],
          selectedIndex: index < 30 ? 0 : 1
        }));
        observations.push(transitionObservation({
          id: `recovery.${group}.lambda.${index}`,
          sourceRecordId,
          candidates: [
            { suffix: "old", target: "old", distance: 1, ageDays: 8 },
            { suffix: "fresh", target: "fresh", distance: 1, ageDays: 0 }
          ],
          selectedIndex: index < 10 ? 0 : 1
        }));
      }
    }

    const result = fitPowerWalkParameters({
      observations,
      initialParameters: parameters(1, 1, 0.01),
      hasher,
      options: { seed: "recovery-fit", holdoutFraction: 0.25 }
    });

    expect(result.audit.status).toBe("accepted_held_out_improvement");
    expect(result.audit.accepted).toBe(true);
    expect(result.audit.observationOrigins).toEqual([
      { origin: "supplied_typed_observation", count: observations.length }
    ]);
    expect(result.initializedParameters.p.get(TYPE_PAIR)).toBe(1);
    expect(result.fittedParameters.p.get(TYPE_PAIR)).toBeCloseTo(3, 1);
    expect(result.activeParameters).toBe(result.params);
    expect(result.params.p.get(TYPE_PAIR)).toBeCloseTo(3, 1);
    expect(result.params.q.get(TYPE_PAIR)).toBeCloseTo(1 / 3, 1);
    expect(result.params.lambda.get(TYPE_PAIR)).toBeCloseTo(Math.log(3) / 8, 2);
    expect(result.audit.likelihood.fitMeanNllImprovement).toBeGreaterThan(0);
    expect(result.audit.likelihood.heldOutMeanNllImprovement).toBeGreaterThan(0);
    expect(intersection(result.audit.split.fitSourceRecordIds, result.audit.split.heldOutSourceRecordIds)).toEqual([]);
    expect(result.audit.likelihood.fit.initialized.observations).toHaveLength(result.audit.split.fitObservationIds.length);
    expect(result.audit.likelihood.heldOut.fittedCandidate.observations).toHaveLength(result.audit.split.heldOutObservationIds.length);
    expect(result.initializedParameters.audit).toMatchObject({ schema: "scce.powerwalk_parameter_fit_input.v1", parameterRole: "initialized_fit_input", fitted: false });
    expect(result.fittedParameters.audit).toMatchObject({
      schema: "scce.powerwalk_parameter_fit_candidate.v1",
      parameterRole: "optimizer_fit_candidate",
      fitted: true,
      active: false,
      acceptedForActivation: true
    });
    expect(result.activeParameters.audit).toMatchObject({
      schema: "scce.powerwalk_parameter_fit.v1",
      parameterRole: "active_parameters",
      accepted: true
    });
    expect(result.fittedParameters.audit).not.toEqual(result.initializedParameters.audit);
    expect(result.fittedParameters.audit).not.toEqual(result.activeParameters.audit);
  });

  it("rejects a training-only improvement when untouched source groups get worse", () => {
    const hasher = createHasher();
    const seed = "overfit-fit";
    const sourceRecordIds = Array.from({ length: 8 }, (_, index) => `source.overfit.${index}`);
    const ranked = [...sourceRecordIds].sort((left, right) =>
      hasher.digestHex(`${seed}\u001f${left}`).localeCompare(hasher.digestHex(`${seed}\u001f${right}`)) || left.localeCompare(right));
    const heldOut = new Set(ranked.slice(0, 2));
    const observations: PowerWalkTransitionObservation[] = [];
    for (const sourceRecordId of sourceRecordIds) {
      const selectedReturns = heldOut.has(sourceRecordId) ? 20 : 4;
      for (let index = 0; index < 40; index++) {
        observations.push(transitionObservation({
          id: `${sourceRecordId}.${index}`,
          sourceRecordId,
          candidates: [
            { suffix: "return", target: "previous", distance: 0, ageDays: 0 },
            { suffix: "neighbor", target: "neighbor", distance: 1, ageDays: 0 }
          ],
          selectedIndex: index < selectedReturns ? 0 : 1
        }));
      }
    }

    const initialized = parameters(1, 1, 0.01);
    const result = fitPowerWalkParameters({
      observations,
      initialParameters: initialized,
      hasher,
      options: { seed, holdoutFraction: 0.25 }
    });

    expect(result.audit.status).toBe("rejected_no_held_out_improvement");
    expect(result.audit.accepted).toBe(false);
    expect(result.audit.likelihood.fitMeanNllImprovement).toBeGreaterThan(0);
    expect(result.audit.likelihood.heldOutMeanNllImprovement).toBeLessThan(0);
    expect(result.audit.parameters.find(row => row.kind === "p")?.fittedCandidate).toBeGreaterThan(1);
    expect(result.fittedParameters.p.get(TYPE_PAIR)).toBeGreaterThan(1);
    expect(result.fittedParameters.audit).toMatchObject({ fitted: true, active: false, acceptedForActivation: false });
    expect(result.activeParameters.p.get(TYPE_PAIR)).toBe(1);
    expect(result.params.p.get(TYPE_PAIR)).toBe(1);
    expect(result.audit.reasons).toContain("held_out_mean_nll_improvement_not_above_threshold");
  });

  it("falls back deterministically below the minimum informative sample counts", () => {
    const observations = Array.from({ length: 12 }, (_, index) => transitionObservation({
      id: `small.${index}`,
      sourceRecordId: index < 6 ? "source.small.0" : "source.small.1",
      candidates: [
        { suffix: "return", target: "previous", distance: 0, ageDays: 0 },
        { suffix: "neighbor", target: "neighbor", distance: 1, ageDays: 0 }
      ],
      selectedIndex: index % 2
    }));
    const initial = parameters(1.5, 0.75, 0.02);
    const result = fitPowerWalkParameters({ observations, initialParameters: initial, hasher: createHasher() });

    expect(result.audit.status).toBe("fallback_insufficient_observations");
    expect(result.initializedParameters.p.get(TYPE_PAIR)).toBe(1.5);
    expect(result.fittedParameters.p.get(TYPE_PAIR)).toBe(1.5);
    expect(result.fittedParameters.audit).toMatchObject({ fitted: false, active: false, acceptedForActivation: false });
    expect(result.activeParameters).toBe(result.params);
    expect(result.params.p.get(TYPE_PAIR)).toBe(1.5);
    expect(result.params.q.get(TYPE_PAIR)).toBe(0.75);
    expect(result.params.lambda.get(TYPE_PAIR)).toBe(0.02);
    expect(result.audit.reasons).toContain("fit_informative_observations_below_minimum");
    expect(result.audit.reasons).toContain("held_out_informative_observations_below_minimum");
  });

  function parameters(p: number, q: number, lambda: number): PowerWalkParams {
    return { p: new Map([[TYPE_PAIR, p]]), q: new Map([[TYPE_PAIR, q]]), lambda: new Map([[TYPE_PAIR, lambda]]), epsilon: 0.01 };
  }

  function transitionObservation(input: {
    id: string;
    sourceRecordId: string;
    candidates: Array<{ suffix: string; target: string; distance: 0 | 1 | 2; ageDays: number; edgeWeight?: number; edgeAlpha?: number }>;
    selectedIndex: number;
  }): PowerWalkTransitionObservation {
    const previousNodeId = nodeId(`${input.id}.previous`);
    return {
      schema: POWERWALK_TRANSITION_OBSERVATION_SCHEMA,
      id: input.id,
      sourceRecordId: input.sourceRecordId,
      observedAt: NOW,
      previousNodeId,
      previousTypeId: TYPE_ID,
      currentNodeId: nodeId(`${input.id}.current`),
      currentTypeId: TYPE_ID,
      selectedEdgeId: `${input.id}.edge.${input.candidates[input.selectedIndex]!.suffix}`,
      candidates: input.candidates.map(candidate => ({
        edgeId: `${input.id}.edge.${candidate.suffix}`,
        targetNodeId: candidate.target === "previous" ? previousNodeId : nodeId(`${input.id}.${candidate.target}`),
        targetTypeId: TYPE_ID,
        distance: candidate.distance,
        edgeWeight: candidate.edgeWeight ?? 1,
        edgeAlpha: candidate.edgeAlpha ?? 1,
        edgeUpdatedAt: NOW - candidate.ageDays * DAY_MS
      }))
    };
  }

  function candidateProbability(distribution: ReturnType<typeof powerWalkTransitionDistribution>, suffix: string): number {
    return distribution.candidates.find(row => row.edgeId.endsWith(suffix))!.probability;
  }

  function nodeId(value: string): NodeId {
    return value as NodeId;
  }

  function intersection(left: readonly string[], right: readonly string[]): string[] {
    const rightSet = new Set(right);
    return left.filter(value => rightSet.has(value));
  }
});
