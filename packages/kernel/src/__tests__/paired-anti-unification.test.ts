import { describe, expect, it } from "vitest";
import {
  compilePairedAntiUnifiedConstructions,
  createHasher,
  interpretAntiUnifiedConstruction,
  realizeAntiUnifiedConstruction,
  type AntiUnifiedBinding,
  type ReversibleConstruction
} from "../index.js";

describe("paired graph/surface anti-unification", () => {
  it("keeps common material fixed and realizes an unseen compatible binding", () => {
    const hasher = createHasher();
    const compiled = compilePairedAntiUnifiedConstructions({
      constructions: [
        example("construction.ada", "family.a", "Ada", "target.ada", "target.writes.a"),
        example("construction.grace", "family.b", "Grace", "target.grace", "target.writes.b")
      ],
      createdAt: 10,
      creationSnapshotId: "snapshot.anti-unified.1",
      hasher
    });
    expect(compiled.rejections).toEqual([]);
    expect(compiled.constructions).toHaveLength(1);
    const construction = compiled.constructions[0]!;
    expect(construction.surfaceProgram.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "slot",
        mode: "variable",
        observedSurfaces: ["Ada", "Grace"]
      }),
      { kind: "literal", surface: " " },
      expect.objectContaining({
        kind: "slot",
        mode: "fixed",
        fixedSurface: "writes"
      })
    ]));
    const bindings = unseenBindings(construction);
    const realized = realizeAntiUnifiedConstruction({
      construction,
      bindings
    });
    expect(realized).toMatchObject({
      status: "realized",
      text: "Lin writes"
    });
    const interpreted = interpretAntiUnifiedConstruction({
      construction,
      surface: "Lin writes",
      bindingCandidates: bindings
    });
    expect(interpreted).toMatchObject({
      status: "interpreted",
      graphTargetIds: ["target.lin", "target.writes.unseen"]
    });
  });

  it("rejects a surface delta that has no paired graph delta", () => {
    const compiled = compilePairedAntiUnifiedConstructions({
      constructions: [
        example("construction.ada", "family.a", "Ada", "target.same", "target.writes.a"),
        example("construction.grace", "family.b", "Grace", "target.same", "target.writes.b")
      ],
      createdAt: 10,
      creationSnapshotId: "snapshot.anti-unified.bad"
    });
    expect(compiled.constructions).toEqual([]);
    expect(compiled.rejections[0]!.reasons).toContain(
      "surface_variation_without_graph_delta"
    );
  });

  it("does not count copied examples as independent or accept relation-mismatched bindings", () => {
    const copied = compilePairedAntiUnifiedConstructions({
      constructions: [
        example("construction.ada.1", "family.copy", "Ada", "target.ada", "target.writes.a"),
        example("construction.ada.2", "family.copy", "Grace", "target.grace", "target.writes.b")
      ],
      createdAt: 10,
      creationSnapshotId: "snapshot.anti-unified.copy"
    });
    expect(copied.constructions).toEqual([]);
    expect(copied.rejections[0]!.reasons).toContain(
      "independent_source_families_low"
    );

    const compiled = compilePairedAntiUnifiedConstructions({
      constructions: [
        example("construction.ada", "family.a", "Ada", "target.ada", "target.writes.a"),
        example("construction.grace", "family.b", "Grace", "target.grace", "target.writes.b")
      ],
      createdAt: 10,
      creationSnapshotId: "snapshot.anti-unified.relation"
    });
    const construction = compiled.constructions[0]!;
    const bindings = unseenBindings(construction);
    bindings[0] = { ...bindings[0]!, relationId: "relation.other" };
    const rejected = realizeAntiUnifiedConstruction({
      construction,
      bindings
    });
    expect(rejected).toMatchObject({ status: "rejected" });
    expect(rejected.status === "rejected" ? rejected.reasons : [])
      .toContain("incompatible_graph_variable_binding");
  });

  it("refuses exact artifacts that have not passed the held-out promotion floor", () => {
    const weak = example(
      "construction.weak",
      "family.weak",
      "Ada",
      "target.ada",
      "target.writes"
    );
    weak.support = {
      ...weak.support,
      independentHeldoutSourceFamilyIds: ["family.holdout.a"],
      cycleRecall: 0.97
    };
    const compiled = compilePairedAntiUnifiedConstructions({
      constructions: [weak],
      createdAt: 10,
      creationSnapshotId: "snapshot.anti-unified.weak"
    });
    expect(compiled.constructions).toEqual([]);
    expect(compiled.rejections).toEqual([
      expect.objectContaining({
        constructionIds: ["construction.weak"],
        reasons: ["source_construction_not_promoted"]
      })
    ]);
  });
});

function unseenBindings(
  construction: ReturnType<
    typeof compilePairedAntiUnifiedConstructions
  >["constructions"][number]
): AntiUnifiedBinding[] {
  return construction.graphVariables.map(variable =>
    variable.roleId === "role.subject"
      ? {
        graphVariableId: variable.id,
        graphTargetId: "target.lin",
        relationId: variable.relationId,
        participantNodeId: "node.lin",
        valueKind: "opaque.entity",
        surface: "Lin"
      }
      : {
        graphVariableId: variable.id,
        graphTargetId: "target.writes.unseen",
        relationId: variable.relationId,
        participantNodeId: "node.writes",
        valueKind: "opaque.relation",
        surface: "writes"
      });
}

function example(
  id: string,
  sourceFamilyId: string,
  subject: string,
  subjectTargetId: string,
  predicateTargetId: string
): ReversibleConstruction {
  const subjectSlotId = `${id}.slot.subject`;
  const predicateSlotId = `${id}.slot.predicate`;
  const subjectPortId = `${id}.port.subject`;
  const predicatePortId = `${id}.port.predicate`;
  return {
    schema: "scce.reversible_construction.v1",
    id,
    seriesId: `${id}.series`,
    planId: `${id}.plan`,
    promotionModelId: "promotion.1",
    profileId: `profile.${sourceFamilyId}`,
    graph: {
      hyperedgeIds: [`${id}.hyperedge`],
      relationNodeIds: [`${id}.relation`],
      ports: [
        {
          id: subjectPortId,
          graphTargetId: subjectTargetId,
          kind: "incidence",
          relationId: "relation.writes",
          relationNodeId: `${id}.relation`,
          hyperedgeId: `${id}.hyperedge`,
          participantNodeId: `${id}.node.subject`,
          portId: "port.subject",
          roleId: "role.subject",
          valueKind: "opaque.entity",
          realization: "observed",
          boundary: true,
          surfaceSlotIds: [subjectSlotId],
          evidenceIds: [`${id}.evidence`]
        },
        {
          id: predicatePortId,
          graphTargetId: predicateTargetId,
          kind: "relation",
          relationId: "relation.writes",
          relationNodeId: `${id}.relation`,
          hyperedgeId: `${id}.hyperedge`,
          portId: "port.predicate",
          roleId: "role.predicate",
          valueKind: "opaque.relation",
          realization: "observed",
          boundary: false,
          surfaceSlotIds: [predicateSlotId],
          evidenceIds: [`${id}.evidence`]
        }
      ],
      boundaryPortIds: [subjectPortId]
    },
    surface: {
      latticeId: `${id}.lattice`,
      sourceFamilyId,
      sourceVersionId: `${id}.source-version`,
      sourceUtf16Start: 0,
      sourceUtf16End: subject.length + 7,
      sourceSurface: `${subject} writes`,
      slots: [
        {
          id: subjectSlotId,
          surfaceUnitId: `${id}.unit.subject`,
          occurrenceId: `${id}.occurrence.subject`,
          surfaceFormClassId: `${id}.class.subject`,
          graphPortIds: [subjectPortId],
          relativeUtf16Start: 0,
          relativeUtf16End: subject.length,
          observedSurface: subject,
          evidence: []
        },
        {
          id: predicateSlotId,
          surfaceUnitId: `${id}.unit.predicate`,
          occurrenceId: `${id}.occurrence.predicate`,
          surfaceFormClassId: `${id}.class.predicate`,
          graphPortIds: [predicatePortId],
          relativeUtf16Start: subject.length + 1,
          relativeUtf16End: subject.length + 7,
          observedSurface: "writes",
          evidence: []
        }
      ],
      boundarySlotIds: [subjectSlotId, predicateSlotId]
    },
    discourseConditions: {
      status: "unconditioned",
      requiredStateIds: [],
      excludedStateIds: []
    },
    populationPosterior: [
      { populationId: "population.opaque", probability: 1 }
    ],
    support: {
      inductionSourceFamilyIds: ["family.train"],
      independentHeldoutSourceFamilyIds: ["family.holdout.a", "family.holdout.b"],
      heldoutCoverage: 1,
      cycleRecall: 1,
      exactAnchorsPreserved: true,
      unsupportedAdditionCount: 0,
      transportMass: 1
    },
    provenance: {
      supportId: `${id}.support`,
      targetIndexId: "target-index.1",
      evidenceAllocationId: `${id}.allocation`,
      evidenceIds: [`${id}.evidence`]
    },
    calibration: {
      modelId: "calibration.1",
      status: "insufficient_data",
      probability: null
    },
    creationSnapshot: {
      id: `${id}.snapshot`,
      createdAt: 1
    },
    executableDirections: ["interpretation", "realization"],
    audit: {}
  };
}
