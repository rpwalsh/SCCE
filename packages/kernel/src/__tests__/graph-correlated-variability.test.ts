import { describe, expect, it } from "vitest";
import {
  admittedPairedAntiUnifiedConstructions,
  compileGraphCorrelatedVariabilityModel,
  compilePairedAntiUnifiedConstructions,
  compilePairedAntiUnifiedPatterns,
  createHasher,
  createLanguageMemoryRuntime,
  type ReversibleConstruction
} from "../index.js";

describe("graph-correlated surface variability", () => {
  it("admits repeated independent correlation and rejects the shuffled null", () => {
    const hasher = createHasher();
    const correlated = paired([
      ...Array.from({ length: 4 }, (_, index) => ({
        family: `family.ada.${index}`,
        surface: "Ada",
        graphTargetId: "target.entity.ada"
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        family: `family.grace.${index}`,
        surface: "Grace",
        graphTargetId: "target.entity.grace"
      }))
    ]);
    const model = compileGraphCorrelatedVariabilityModel({
      constructions: [correlated],
      hasher
    });
    const callerWeakened = compileGraphCorrelatedVariabilityModel({
      constructions: [correlated],
      minimumIndependentSourceFamilies: 1,
      minimumConditionalMutualInformation: 0,
      minimumCrossValidatedPredictiveGain: 0,
      maximumPermutationPValue: 1,
      maximumShuffledControlPromotionRate: 1,
      permutationControls: 1,
      hasher
    });
    expect(callerWeakened).toMatchObject({
      minimumIndependentSourceFamilies: 4,
      minimumConditionalMutualInformation: 0.02,
      minimumCrossValidatedPredictiveGain: 0.02,
      maximumPermutationPValue: 0.05,
      maximumShuffledControlPromotionRate: 0.1,
      permutationControls: 32
    });
    expect(model.decisions).toEqual([
      expect.objectContaining({
        constructionId: correlated.id,
        passed: true,
        reasons: []
      })
    ]);
    expect(model.slotDecisions[0]).toMatchObject({
      independentSourceFamilies: 8,
      passed: true
    });
    expect(model.slotDecisions[0]!.conditionalMutualInformation)
      .toBeGreaterThan(0.02);
    expect(model.slotDecisions[0]!.crossValidatedPredictiveGain)
      .toBeGreaterThan(0.02);
    expect(model.slotDecisions[0]!.permutationPValue)
      .toBeLessThanOrEqual(0.05);

    const admitted = admittedPairedAntiUnifiedConstructions({
      constructions: [correlated],
      model
    });
    expect(admitted).toHaveLength(1);
    const patterns = admitted.flatMap(({ construction, admission }) =>
      compilePairedAntiUnifiedPatterns(construction, admission));
    expect(patterns).toHaveLength(8);
    expect(createLanguageMemoryRuntime({ hasher }).hydrate({
      models: [],
      observations: [],
      units: [],
      patterns,
      semanticFrames: []
    }).importedPairedAntiUnifiedConstructions).toEqual([correlated]);

    const shuffled = paired(Array.from({ length: 8 }, (_, index) => ({
      family: `family.shuffled.${index}`,
      surface: index < 4 ? "Ada" : "Grace",
      graphTargetId: index % 2
        ? "target.entity.ada"
        : "target.entity.grace"
    })));
    const shuffledModel = compileGraphCorrelatedVariabilityModel({
      constructions: [shuffled],
      hasher
    });
    expect(shuffledModel.decisions[0]).toMatchObject({ passed: false });
    expect(admittedPairedAntiUnifiedConstructions({
      constructions: [shuffled],
      model: shuffledModel
    })).toEqual([]);
  });

  it("does not treat all-unique surface/graph pairs as cross-validated evidence", () => {
    const construction = paired(Array.from({ length: 8 }, (_, index) => ({
      family: `family.unique.${index}`,
      surface: `surface.${index}`,
      graphTargetId: `target.${index}`
    })));
    const model = compileGraphCorrelatedVariabilityModel({
      constructions: [construction]
    });
    expect(model.decisions[0]).toMatchObject({ passed: false });
    expect(model.slotDecisions[0]!.reasons).toEqual(expect.arrayContaining([
      "surface_delta_classes_missing",
      "graph_delta_classes_missing"
    ]));
  });
});

function paired(examples: Array<{
  family: string;
  surface: string;
  graphTargetId: string;
}>) {
  const compiled = compilePairedAntiUnifiedConstructions({
    constructions: examples.map((example, index) =>
      exactConstruction(
        `construction.${index}.${example.family}`,
        example.family,
        example.surface,
        example.graphTargetId
      )),
    createdAt: 20,
    creationSnapshotId: "snapshot.variability"
  });
  expect(compiled.rejections).toEqual([]);
  expect(compiled.constructions).toHaveLength(1);
  return compiled.constructions[0]!;
}

function exactConstruction(
  id: string,
  sourceFamilyId: string,
  subject: string,
  subjectTargetId: string
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
    promotionModelId: "promotion.variability",
    profileId: `profile.${sourceFamilyId}`,
    graph: {
      hyperedgeIds: [`${id}.hyperedge`],
      relationNodeIds: [`${id}.relation-node`],
      ports: [
        {
          id: subjectPortId,
          graphTargetId: subjectTargetId,
          kind: "incidence",
          relationId: "relation.writes",
          relationNodeId: `${id}.relation-node`,
          hyperedgeId: `${id}.hyperedge`,
          participantNodeId: subjectTargetId,
          portId: "port.writer",
          roleId: "role.opaque.writer",
          valueKind: "opaque.entity",
          realization: "observed",
          boundary: true,
          surfaceSlotIds: [subjectSlotId],
          evidenceIds: [`${id}.evidence`]
        },
        {
          id: predicatePortId,
          graphTargetId: "target.relation.writes",
          kind: "relation",
          relationId: "relation.writes",
          relationNodeId: `${id}.relation-node`,
          hyperedgeId: `${id}.hyperedge`,
          portId: "port.predicate",
          roleId: "role.opaque.predicate",
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
      inductionSourceFamilyIds: ["family.induction"],
      independentHeldoutSourceFamilyIds: ["family.holdout.a", "family.holdout.b"],
      heldoutCoverage: 1,
      cycleRecall: 1,
      exactAnchorsPreserved: true,
      unsupportedAdditionCount: 0,
      transportMass: 1
    },
    provenance: {
      supportId: `${id}.support`,
      targetIndexId: "target-index.variability",
      evidenceAllocationId: `${id}.allocation`,
      evidenceIds: [`${id}.evidence`]
    },
    calibration: {
      modelId: "calibration.variability",
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
