import { describe, expect, it } from "vitest";
import {
  compileOptionalNullRealizationModel,
  compileOptionalNullRealizationPatterns,
  decideOptionalNullRealization,
  observeOptionalNullRealization,
  optionalComponentKey,
  optionalConstructionContextId,
  optionalPopulationContextId,
  optionalNullRealizationModelsFromPatterns
} from "../optional-null-realization.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import type { ReversibleConstruction } from "../reversible-construction.js";

describe("learned optional and null realization", () => {
  it("keeps absent meaning distinct from present but unrealized meaning", () => {
    const rows = [
      exact("omitted.a", "family.a", "unrealized", ["disc.given"]),
      exact("omitted.b", "family.b", "unrealized", ["disc.given"]),
      exact("omitted.c", "family.c", "unrealized", ["disc.given"]),
      exact("absent.d", "family.d", "absent", ["disc.given"])
    ];
    const model = compileOptionalNullRealizationModel({
      constructions: rows
    });
    const componentKey = targetComponentKey();
    const populationContextId = optionalPopulationContextId([
      { populationId: "population.test", probability: 1 }
    ]);
    const contextId = optionalConstructionContextId({
      populationContextId,
      relationId: "relation.test"
    });

    expect(observeOptionalNullRealization({
      constructions: rows
    }).map(row => [row.sourceFamilyId, row.meaningStatus, row.surfaceStatus]))
      .toEqual(expect.arrayContaining([
        ["family.a", "present", "unrealized"],
        ["family.d", "absent", "not_applicable"]
      ]));
    expect(decideOptionalNullRealization({
      model,
      profileId: "profile.test",
      relationId: "relation.test",
      componentKey,
      constructionContextId: contextId,
      populationContextId,
      meaningStatus: "absent",
      discourseStateIds: ["disc.given"]
    }).status).toBe("absent_meaning");
    expect(decideOptionalNullRealization({
      model,
      profileId: "profile.test",
      relationId: "relation.test",
      componentKey,
      constructionContextId: contextId,
      populationContextId,
      meaningStatus: "present",
      discourseStateIds: ["disc.given"]
    }).status).toBe("unrealized_meaning");
  });

  it("refuses omission outside learned discourse conditions", () => {
    const model = compileOptionalNullRealizationModel({
      constructions: [
        exact("omitted.a", "family.a", "unrealized", ["disc.given"]),
        exact("omitted.b", "family.b", "unrealized", ["disc.given"]),
        exact("omitted.c", "family.c", "unrealized", ["disc.given"])
      ]
    });
    const decision = decideOptionalNullRealization({
      model,
      profileId: "profile.test",
      relationId: "relation.test",
      componentKey: targetComponentKey(),
      meaningStatus: "present",
      discourseStateIds: ["disc.new"]
    });
    expect(decision).toMatchObject({
      status: "unresolved",
      reasons: ["supported_context_missing"]
    });
  });

  it("requires independent source-family support before omitting", () => {
    const model = compileOptionalNullRealizationModel({
      constructions: [
        exact("copy.a", "family.copy", "unrealized"),
        exact("copy.b", "family.copy", "unrealized")
      ]
    });
    const decision = decideOptionalNullRealization({
      model,
      profileId: "profile.test",
      relationId: "relation.test",
      componentKey: targetComponentKey(),
      meaningStatus: "present"
    });
    expect(decision.status).toBe("unresolved");
    expect(model.estimates.find(row =>
      row.componentKey === targetComponentKey())?.independentSourceFamilies)
      .toBe(1);
  });

  it("learns supported realization instead of treating every component as nullable", () => {
    const model = compileOptionalNullRealizationModel({
      constructions: [
        exact("realized.a", "family.a", "realized"),
        exact("realized.b", "family.b", "realized"),
        exact("realized.c", "family.c", "realized")
      ]
    });
    expect(decideOptionalNullRealization({
      model,
      profileId: "profile.test",
      relationId: "relation.test",
      componentKey: targetComponentKey(),
      meaningStatus: "present"
    }).status).toBe("realized");
  });

  it("persists content-addressed observations and merges hydrated shards", () => {
    const left = compileOptionalNullRealizationModel({
      constructions: [
        exact("omitted.a", "family.a", "unrealized"),
        exact("omitted.b", "family.b", "unrealized")
      ]
    });
    const right = compileOptionalNullRealizationModel({
      constructions: [
        exact("omitted.c", "family.c", "unrealized")
      ]
    });
    const patterns = [
      ...compileOptionalNullRealizationPatterns(left, 10),
      ...compileOptionalNullRealizationPatterns(right, 20)
    ];
    const hydrated = optionalNullRealizationModelsFromPatterns(patterns);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]!.observations.filter(row =>
      row.componentKey === targetComponentKey())).toHaveLength(3);
    expect(decideOptionalNullRealization({
      model: hydrated[0]!,
      profileId: "profile.test",
      relationId: "relation.test",
      componentKey: targetComponentKey(),
      meaningStatus: "present"
    }).status).toBe("unrealized_meaning");

    const runtimeState = createLanguageMemoryRuntime().hydrate({
      models: [],
      observations: [],
      units: [],
      patterns,
      semanticFrames: []
    });
    expect(runtimeState.optionalNullRealizationModels).toHaveLength(1);
    expect(runtimeState.importedPatterns).toEqual([]);
  });

  it("pools independent source profiles only inside the same learned population", () => {
    const model = compileOptionalNullRealizationModel({
      constructions: [
        exact("omitted.a", "family.a", "unrealized", [], "profile.a"),
        exact("omitted.b", "family.b", "unrealized", [], "profile.b"),
        exact("omitted.c", "family.c", "unrealized", [], "profile.c")
      ]
    });
    const estimate = model.estimates.find(row =>
      row.componentKey === targetComponentKey())!;
    expect(estimate.profileIds).toEqual([
      "profile.a",
      "profile.b",
      "profile.c"
    ]);
    expect(estimate.independentSourceFamilies).toBe(3);
    expect(decideOptionalNullRealization({
      model,
      profileId: "profile.b",
      relationId: "relation.test",
      componentKey: targetComponentKey(),
      populationContextId: optionalPopulationContextId([
        { populationId: "population.test", probability: 1 }
      ]),
      meaningStatus: "present"
    }).status).toBe("unrealized_meaning");
  });
});

function targetComponentKey(): string {
  return optionalComponentKey({
    kind: "incidence",
    relationId: "relation.test",
    portId: "port.target",
    roleId: "role.target",
    valueKind: "entity"
  });
}

function exact(
  id: string,
  sourceFamilyId: string,
  state: "absent" | "realized" | "unrealized",
  requiredStateIds: string[] = [],
  profileId = "profile.test"
): ReversibleConstruction {
  const targetPort = state === "absent"
    ? []
    : [{
      id: `graph-port.target.${id}`,
      graphTargetId: `target.${id}`,
      kind: "incidence" as const,
      relationId: "relation.test",
      relationNodeId: "relation-node.test",
      hyperedgeId: `hyperedge.${id}`,
      incidenceId: `incidence.${id}`,
      participantNodeId: `participant.${id}`,
      portId: "port.target",
      roleId: "role.target",
      valueKind: "entity",
      realization: state === "unrealized"
        ? "omitted" as const
        : "observed" as const,
      boundary: false,
      surfaceSlotIds: state === "realized" ? [`slot.target.${id}`] : [],
      evidenceIds: [`evidence.${id}`]
    }];
  const sourcePort = {
    id: `graph-port.source.${id}`,
    graphTargetId: `source.${id}`,
    kind: "incidence" as const,
    relationId: "relation.test",
    relationNodeId: "relation-node.test",
    hyperedgeId: `hyperedge.${id}`,
    incidenceId: `incidence.source.${id}`,
    participantNodeId: `source-participant.${id}`,
    portId: "port.source",
    roleId: "role.source",
    valueKind: "entity",
    realization: "observed" as const,
    boundary: false,
    surfaceSlotIds: [`slot.source.${id}`],
    evidenceIds: [`evidence.${id}`]
  };
  const slots = [{
    id: `slot.source.${id}`,
    surfaceUnitId: `unit.source.${id}`,
    occurrenceId: `occurrence.source.${id}`,
    surfaceFormClassId: "surface.source",
    graphPortIds: [sourcePort.id],
    relativeUtf16Start: 0,
    relativeUtf16End: 6,
    observedSurface: "source",
    evidence: [{
      evidenceId: `evidence.${id}`,
      basis: "shared_exact_evidence" as const,
      conditionalProbability: 1,
      allocatedMass: 1
    }]
  }, ...(state === "realized" ? [{
    id: `slot.target.${id}`,
    surfaceUnitId: `unit.target.${id}`,
    occurrenceId: `occurrence.target.${id}`,
    surfaceFormClassId: "surface.target",
    graphPortIds: [`graph-port.target.${id}`],
    relativeUtf16Start: 7,
    relativeUtf16End: 13,
    observedSurface: "target",
    evidence: [{
      evidenceId: `evidence.${id}`,
      basis: "shared_exact_evidence" as const,
      conditionalProbability: 1,
      allocatedMass: 1
    }]
  }] : [])];
  const sourceSurface = state === "realized" ? "source target" : "source";
  return {
    schema: "scce.reversible_construction.v1",
    id: `construction.${id}`,
    seriesId: `series.${id}`,
    planId: `plan.${id}`,
    promotionModelId: "promotion.test",
    profileId,
    graph: {
      hyperedgeIds: [`hyperedge.${id}`],
      relationNodeIds: ["relation-node.test"],
      ports: [sourcePort, ...targetPort],
      boundaryPortIds: []
    },
    surface: {
      latticeId: `lattice.${id}`,
      sourceFamilyId,
      sourceVersionId: `source-version.${id}`,
      sourceUtf16Start: 0,
      sourceUtf16End: sourceSurface.length,
      sourceSurface,
      slots,
      boundarySlotIds: slots.map(slot => slot.id)
    },
    discourseConditions: {
      status: "unconditioned",
      requiredStateIds,
      excludedStateIds: []
    },
    populationPosterior: [{ populationId: "population.test", probability: 1 }],
    support: {
      inductionSourceFamilyIds: [sourceFamilyId],
      independentHeldoutSourceFamilyIds: ["heldout.a", "heldout.b"],
      heldoutCoverage: 1,
      cycleRecall: 1,
      exactAnchorsPreserved: true,
      unsupportedAdditionCount: 0,
      transportMass: 1
    },
    provenance: {
      supportId: `support.${id}`,
      targetIndexId: "target-index.test",
      evidenceAllocationId: `allocation.${id}`,
      evidenceIds: [`evidence.${id}`]
    },
    calibration: {
      modelId: "calibration.test",
      status: "calibrated",
      probability: 1
    },
    creationSnapshot: {
      id: `snapshot.${id}`,
      createdAt: 1
    },
    executableDirections: ["interpretation", "realization"],
    audit: {}
  };
}
