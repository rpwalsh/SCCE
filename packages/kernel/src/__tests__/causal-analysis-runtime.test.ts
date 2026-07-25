import { describe, expect, it } from "vitest";
import { CAUSAL_ANALYSIS_REQUEST_SCHEMA, createCausalAnalysisRuntime, type CausalAnalysisRequest } from "../causal-analysis-runtime.js";
import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher } from "../primitives.js";
import type { BackdoorIdentificationDesign, CausalAssumptionDag, CausalObservation } from "../identified-causal-graph.js";
import type { NodeId, ScceEvent } from "../types.js";

const treatment = "variable.t" as NodeId;
const outcome = "variable.y" as NodeId;
const confounder = "variable.z" as NodeId;

function fixture() {
  const clock = createClock({ fixedTime: 5_000, stepMs: 1 });
  const hasher = createHasher();
  const idFactory = createIdFactory({ clock, hasher, namespace: "causal-analysis-test", runSeed: "seed", deterministicReplay: true });
  const eventFactory = createEventFactory({ idFactory, clock, hasher });
  const appended: ScceEvent[] = [];
  const runtime = createCausalAnalysisRuntime({
    clock,
    hasher,
    idFactory,
    eventFactory,
    append: async event => {
      appended.push(event);
      return event;
    }
  });
  return { runtime, appended };
}

function dag(): CausalAssumptionDag {
  return {
    kind: "causal_assumption_dag",
    assumptionSetId: "assumptions.1",
    nodes: [treatment, outcome, confounder],
    edges: [
      { id: "z-t", cause: confounder, effect: treatment, evidenceIds: ["evidence.z-t"] },
      { id: "z-y", cause: confounder, effect: outcome, evidenceIds: ["evidence.z-y"] },
      { id: "t-y", cause: treatment, effect: outcome, evidenceIds: ["evidence.t-y"] }
    ],
    evidenceIds: ["evidence.dag"]
  };
}

function backdoorDesign(adjustmentSet: NodeId[]): BackdoorIdentificationDesign {
  return {
    kind: "backdoor_adjustment",
    treatment,
    outcome,
    adjustmentSet,
    dag: dag(),
    assumptions: {
      consistency: true,
      noInterference: true,
      noUnmeasuredConfoundingGivenAdjustment: true,
      temporalOrderEstablished: true,
      positivityExpected: true
    }
  };
}

function observation(id: string, treatmentValue: 0 | 1, outcomeValue: number, confounderValue: number): CausalObservation {
  return {
    id,
    values: { [String(treatment)]: treatmentValue, [String(outcome)]: outcomeValue, [String(confounder)]: confounderValue },
    evidenceIds: [`evidence.${id}`]
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

describe("causal analysis runtime", () => {
  it("identifies a real backdoor-adjusted effect and durably records CausalEffectIdentified with real evidence", async () => {
    const { runtime, appended } = fixture();
    const request: CausalAnalysisRequest = {
      schema: CAUSAL_ANALYSIS_REQUEST_SCHEMA,
      observations: confoundedObservations(),
      design: backdoorDesign([confounder]),
      targetRiskCoverage: 0.8
    };

    const result = await runtime.analyze(request);

    expect(result.status).toBe("identified");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.typeId).toBe("CausalEffectIdentified");
    expect(result.estimate.status).toBe("identified");
    if (result.estimate.status === "identified") {
      expect(result.estimate.claim.estimate).toBe(2);
      expect(result.estimate.claim.observationEvidenceIds.length).toBeGreaterThan(0);
    }
    expect(result.eventId).toBe(String(appended[0]!.id));
  });

  it("surfaces a transparent, event-backed rejection rather than fabricating a design", async () => {
    const { runtime, appended } = fixture();
    const request: CausalAnalysisRequest = {
      schema: CAUSAL_ANALYSIS_REQUEST_SCHEMA,
      observations: confoundedObservations(),
      targetRiskCoverage: 0.8
    };

    const result = await runtime.analyze(request);

    expect(result.status).toBe("rejected");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.typeId).toBe("CausalIdentificationRejected");
    expect(result.estimate.status).toBe("rejected");
    if (result.estimate.status === "rejected") {
      expect(result.estimate.audit.reasons).toContain("identification_design_required");
    }
  });

  it("rejects a malformed schema tag before touching the engine or the journal", async () => {
    const { runtime, appended } = fixture();
    await expect(runtime.analyze({
      schema: "not.the.right.schema" as typeof CAUSAL_ANALYSIS_REQUEST_SCHEMA,
      observations: confoundedObservations(),
      design: backdoorDesign([confounder]),
      targetRiskCoverage: 0.8
    })).rejects.toThrow(/unsupported causal analysis request schema/);
    expect(appended).toHaveLength(0);
  });

  it("gives each analysis its own episode, never reusing one across independent requests", async () => {
    const { runtime } = fixture();
    const request: CausalAnalysisRequest = {
      schema: CAUSAL_ANALYSIS_REQUEST_SCHEMA,
      observations: confoundedObservations(),
      design: backdoorDesign([confounder]),
      targetRiskCoverage: 0.8
    };
    const first = await runtime.analyze(request);
    const second = await runtime.analyze(request);
    expect(first.episodeId).not.toBe(second.episodeId);
  });
});
