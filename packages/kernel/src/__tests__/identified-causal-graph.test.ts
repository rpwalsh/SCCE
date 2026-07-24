import { describe, expect, it } from "vitest";
import {
  createIdentifiedCausalGraphEngine,
  validateAssociationalGraph,
  type AssociationalGraph,
  type BackdoorIdentificationDesign,
  type CausalAssumptionDag,
  type CausalObservation,
  type RandomizedInterventionDesign
} from "../identified-causal-graph.js";
import { createClock, createHasher } from "../primitives.js";
import type { NodeId } from "../types.js";

const treatment = "variable.t" as NodeId;
const outcome = "variable.y" as NodeId;
const confounder = "variable.z" as NodeId;
const mediator = "variable.m" as NodeId;

describe("identified causal graph", () => {
  it("keeps an associational graph explicitly non-causal", () => {
    const association = associationGraph();
    expect(validateAssociationalGraph(association)).toEqual({ valid: true, reasons: [] });

    const result = engine().estimate({
      observations: confoundedObservations(),
      associationContext: association,
      targetRiskCoverage: 0.8
    });

    expect(result).toMatchObject({
      status: "rejected",
      claim: null,
      audit: {
        associationContextPresent: true,
        associationContextUsedForIdentification: false,
        associationContextValidation: { valid: true, reasons: [] },
        reasons: ["identification_design_required"]
      }
    });
  });

  it("identifies a backdoor-adjusted effect only with a valid adjustment set", () => {
    const result = engine().estimate({
      observations: confoundedObservations(),
      design: backdoorDesign([confounder]),
      associationContext: associationGraph(),
      targetRiskCoverage: 0.8
    });

    expect(result.status).toBe("identified");
    if (result.status !== "identified") return;
    expect(result.claim.estimate).toBe(2);
    expect(result.claim.identification).toEqual({
      kind: "backdoor_adjustment",
      assumptionSetId: "assumptions.1",
      adjustmentSet: [confounder],
      validatedBackdoorCriterion: true,
      empiricalPositivity: true
    });
    expect(result.claim.strata).toHaveLength(2);
    expect(result.audit).toMatchObject({
      causalDagValidated: true,
      explicitAssumptionsValidated: true,
      empiricalPositivityValidated: true,
      associationContextUsedForIdentification: false
    });
    expect(result.claim.riskInterval).toMatchObject({
      parameterConfidenceInterval: false,
      causalIdentificationEvidence: false
    });
  });

  it("rejects an adjustment set that leaves an open backdoor path", () => {
    const result = engine().estimate({
      observations: confoundedObservations(),
      design: backdoorDesign([]),
      targetRiskCoverage: 0.8
    });

    expect(result).toMatchObject({
      status: "rejected",
      claim: null
    });
    expect(result.audit.reasons).toContain("adjustment_set_does_not_block_all_backdoor_paths");
  });

  it("rejects adjustment for a treatment descendant", () => {
    const dag = causalDag([
      edge("t-m", treatment, mediator),
      edge("m-y", mediator, outcome),
      edge("t-y", treatment, outcome)
    ], [treatment, mediator, outcome]);
    const design = {
      ...backdoorDesign([]),
      adjustmentSet: [mediator],
      dag
    };
    const result = engine().estimate({
      observations: descendantObservations(),
      design,
      targetRiskCoverage: 0.8
    });

    expect(result.status).toBe("rejected");
    expect(result.audit.reasons).toContain(`adjustment_contains_treatment_descendant:${String(mediator)}`);
  });

  it("rejects a cyclic causal assumption graph", () => {
    const design = backdoorDesign([confounder]);
    design.dag.edges.push(edge("y-z", outcome, confounder));
    const result = engine().estimate({
      observations: confoundedObservations(),
      design,
      targetRiskCoverage: 0.8
    });

    expect(result.status).toBe("rejected");
    expect(result.audit.reasons).toContain("causal_dag_contains_cycle");
  });

  it("estimates a randomized intervention from explicit assignment evidence", () => {
    const result = engine().estimate({
      observations: randomizedObservations(),
      design: randomizedDesign(),
      associationContext: associationGraph(-0.9),
      targetRiskCoverage: 0.8
    });

    expect(result.status).toBe("identified");
    if (result.status !== "identified") return;
    expect(result.claim.estimate).toBe(3);
    expect(result.claim.identification).toEqual({
      kind: "randomized_intervention",
      assignmentMechanismId: "assignment.mechanism.1",
      assignmentEvidenceIds: ["evidence.randomization"],
      randomizedAssignmentAsserted: true
    });
    expect(result.audit.associationContextUsedForIdentification).toBe(false);
  });

  it("does not let malformed unused association context determine identification", () => {
    const malformedAssociation = associationGraph();
    malformedAssociation.edges[0]!.sampleSize = 0;
    const result = engine().estimate({
      observations: randomizedObservations(),
      design: randomizedDesign(),
      associationContext: malformedAssociation,
      targetRiskCoverage: 0.8
    });

    expect(result.status).toBe("identified");
    expect(result.audit.associationContextValidation).toEqual({
      valid: false,
      reasons: ["association_sample_size_invalid:association.1"]
    });
    expect(result.audit.associationContextUsedForIdentification).toBe(false);
  });

  it("rejects runtime-false assumptions even if malformed input bypasses static types", () => {
    const design = randomizedDesign();
    const malformed = {
      ...design,
      assumptions: { ...design.assumptions, randomizedAssignment: false }
    } as unknown as RandomizedInterventionDesign;
    const result = engine().estimate({
      observations: randomizedObservations(),
      design: malformed,
      targetRiskCoverage: 0.8
    });

    expect(result.status).toBe("rejected");
    expect(result.audit.reasons).toContain(
      "all_randomized_identification_assumptions_must_be_explicitly_true"
    );
  });

  it("produces deterministic claim identity and replay time", () => {
    const input = {
      observations: confoundedObservations(),
      design: backdoorDesign([confounder]),
      targetRiskCoverage: 0.8
    };
    const first = engine().estimate(input);
    const second = engine().estimate(input);

    expect(first.status).toBe("identified");
    expect(second.status).toBe("identified");
    if (first.status !== "identified" || second.status !== "identified") return;
    expect(first.claim.id).toBe(second.claim.id);
    expect(first.claim.createdAt).toBe(1_234);
    expect(second.claim.createdAt).toBe(1_234);
    expect(second.claim.riskInterval.interpretation).toContain("not a parameter confidence interval");
  });
});

function engine() {
  return createIdentifiedCausalGraphEngine({
    clock: createClock({ fixedTime: 1_234, stepMs: 0 }),
    hasher: createHasher()
  });
}

function backdoorDesign(adjustmentSet: NodeId[]): BackdoorIdentificationDesign {
  return {
    kind: "backdoor_adjustment",
    treatment,
    outcome,
    adjustmentSet,
    dag: causalDag([
      edge("z-t", confounder, treatment),
      edge("z-y", confounder, outcome),
      edge("t-y", treatment, outcome)
    ], [treatment, outcome, confounder]),
    assumptions: {
      consistency: true,
      noInterference: true,
      noUnmeasuredConfoundingGivenAdjustment: true,
      temporalOrderEstablished: true,
      positivityExpected: true
    }
  };
}

function randomizedDesign(): RandomizedInterventionDesign {
  return {
    kind: "randomized_intervention",
    treatment,
    outcome,
    assignmentMechanismId: "assignment.mechanism.1",
    assignmentEvidenceIds: ["evidence.randomization"],
    assumptions: {
      randomizedAssignment: true,
      consistency: true,
      noInterference: true,
      outcomeObservedAfterAssignment: true
    }
  };
}

function causalDag(edges: CausalAssumptionDag["edges"], nodes: NodeId[]): CausalAssumptionDag {
  return {
    kind: "causal_assumption_dag",
    assumptionSetId: "assumptions.1",
    nodes,
    edges,
    evidenceIds: ["evidence.dag"]
  };
}

function edge(id: string, cause: NodeId, effect: NodeId): CausalAssumptionDag["edges"][number] {
  return { id, cause, effect, evidenceIds: [`evidence.${id}`] };
}

function associationGraph(value = 0.95): AssociationalGraph {
  return {
    kind: "associational_graph",
    nodes: [{ id: treatment }, { id: outcome }],
    edges: [{
      id: "association.1",
      left: treatment,
      right: outcome,
      statisticId: "statistic.source_defined",
      value,
      sampleSize: 8,
      evidenceIds: ["evidence.association"]
    }]
  };
}

function confoundedObservations(): CausalObservation[] {
  return [
    observation("z0-c1", 0, 0, 0),
    observation("z0-c2", 0, 0, 0),
    observation("z0-t1", 1, 2, 0),
    observation("z0-t2", 1, 2, 0),
    observation("z1-c1", 0, 10, 1),
    observation("z1-c2", 0, 10, 1),
    observation("z1-t1", 1, 12, 1),
    observation("z1-t2", 1, 12, 1)
  ];
}

function randomizedObservations(): CausalObservation[] {
  return [
    observation("c1", 0, 1),
    observation("c2", 0, 2),
    observation("c3", 0, 3),
    observation("c4", 0, 4),
    observation("t1", 1, 4),
    observation("t2", 1, 5),
    observation("t3", 1, 6),
    observation("t4", 1, 7)
  ];
}

function descendantObservations(): CausalObservation[] {
  return [
    descendantObservation("c1", 0, 0, 0),
    descendantObservation("c2", 0, 0, 0),
    descendantObservation("t1", 1, 1, 2),
    descendantObservation("t2", 1, 1, 2)
  ];
}

function observation(id: string, treatmentValue: number, outcomeValue: number, z?: number): CausalObservation {
  return {
    id,
    values: {
      [String(treatment)]: treatmentValue,
      [String(outcome)]: outcomeValue,
      ...(z === undefined ? {} : { [String(confounder)]: z })
    },
    evidenceIds: [`evidence.${id}`]
  };
}

function descendantObservation(
  id: string,
  treatmentValue: number,
  mediatorValue: number,
  outcomeValue: number
): CausalObservation {
  return {
    id,
    values: {
      [String(treatment)]: treatmentValue,
      [String(mediator)]: mediatorValue,
      [String(outcome)]: outcomeValue
    },
    evidenceIds: [`evidence.${id}`]
  };
}
