import { describe, expect, it } from "vitest";
import {
  allocateTransportEvidence,
  buildSurfaceLattice,
  compileAlignmentCalibrationModel,
  compileAlignmentPromotionModel,
  compileReversibleConstructionPattern,
  compileReversibleConstructions,
  createLanguageMemoryRuntime,
  createHasher,
  interpretReversibleConstruction,
  realizeReversibleConstruction,
  reversibleConstructionCycle,
  type AlignmentAlternativeSet,
  type AlignmentPromotionObservation,
  type SparseAlignmentCandidateSupport,
  type SparseAlignmentTargetIndex,
  type SparseFusedTransportPlan
} from "../index.js";

describe("first reversible construction schema", () => {
  it("executes interpretation and realization from the same promoted artifact", () => {
    const hasher = createHasher();
    const lattice = buildSurfaceLattice({
      documentId: "document.1",
      sourceFamilyId: "family.train",
      sourceVersionId: "source.version.1",
      text: "Ada writes",
      evidenceIds: ["evidence.1"],
      hasher
    });
    const ada = lattice.units.find(unit =>
      unit.proposalSources.includes("lexical") && unit.normalized === "ada")!;
    const writes = lattice.units.find(unit =>
      unit.proposalSources.includes("lexical") && unit.normalized === "writes")!;
    const targetIndex = {
      id: "target-index.1",
      targets: [
        target("target.ada", "port.ada", "role.opaque.1"),
        target("target.writes", "port.writes", "role.opaque.2"),
        target(
          "target.implicit",
          "port.implicit",
          "role.opaque.3",
          "omitted"
        )
      ]
    } as unknown as SparseAlignmentTargetIndex;
    const support = {
      id: "support.1",
      latticeId: lattice.id,
      sourceFamilyId: lattice.sourceFamilyId,
      targetIndexId: targetIndex.id,
      incidenceGraphId: "incidence.1",
      populationPosterior: [{ populationId: "population.1", probability: 1 }],
      candidates: [
        candidate("candidate.ada", ada, "target.ada"),
        candidate("candidate.writes", writes, "target.writes")
      ],
      rows: [
        { surfaceUnitId: ada.id, candidateIds: ["candidate.ada"], omittedCandidateCount: 0 },
        {
          surfaceUnitId: writes.id,
          candidateIds: ["candidate.writes"],
          omittedCandidateCount: 0
        }
      ]
    } as unknown as SparseAlignmentCandidateSupport;
    const plan = {
      id: "plan.1",
      supportId: support.id,
      targetIndexId: targetIndex.id,
      cells: [
        transportCell("candidate.ada", ada.id, "target.ada"),
        transportCell("candidate.writes", writes.id, "target.writes")
      ],
      columnMarginals: [{
        graphTargetId: "target.implicit",
        graphImplicitMass: 1
      }]
    } as unknown as SparseFusedTransportPlan;
    const alternativeSet = {
      seriesId: "series.1",
      hypotheses: [{ plan }]
    } as unknown as AlignmentAlternativeSet;
    const promotionModel = compileAlignmentPromotionModel({
      alternativeSets: [alternativeSet],
      observations: [
        promotion("induction", "family.train", "induction"),
        promotion("heldout.a", "family.heldout.a", "heldout"),
        promotion("heldout.b", "family.heldout.b", "heldout")
      ],
      hasher
    });
    const allocation = allocateTransportEvidence({ plan, support, hasher });
    const compiled = compileReversibleConstructions({
      alternativeSets: [alternativeSet],
      promotionModel,
      calibrationModel: compileAlignmentCalibrationModel({
        observations: [],
        hasher
      }),
      supports: [support],
      targetIndex,
      lattices: [lattice],
      evidenceAllocations: [allocation],
      profileId: "profile.opaque",
      creationSnapshotId: "snapshot.1",
      createdAt: 42,
      hasher
    });

    expect(compiled.rejections).toEqual([]);
    expect(compiled.constructions).toHaveLength(1);
    const construction = compiled.constructions[0]!;
    expect(construction).toMatchObject({
      schema: "scce.reversible_construction.v1",
      profileId: "profile.opaque",
      surface: { sourceSurface: "Ada writes" },
      executableDirections: ["interpretation", "realization"]
    });
    expect(construction.graph.ports).toHaveLength(3);
    expect(construction.graph.ports.find(port =>
      port.graphTargetId === "target.implicit")).toMatchObject({
        realization: "omitted",
        surfaceSlotIds: []
      });
    expect(construction.surface.slots).toHaveLength(2);
    expect(construction.surface.slots.every(slot =>
      slot.evidence.reduce((sum, row) =>
        sum + row.conditionalProbability, 0) === 1)).toBe(true);
    expect(construction.support.independentHeldoutSourceFamilyIds).toEqual([
      "family.heldout.a",
      "family.heldout.b"
    ]);

    const interpreted = interpretReversibleConstruction({
      construction,
      surface: "Ada writes",
      profileId: "profile.opaque"
    });
    expect(interpreted.status).toBe("interpreted");
    const realized = realizeReversibleConstruction({
      construction,
      graphTargetIds: ["target.writes", "target.ada", "target.implicit"],
      profileId: "profile.opaque"
    });
    expect(realized).toMatchObject({
      status: "realized",
      text: "Ada writes"
    });
    expect(reversibleConstructionCycle({
      construction,
      profileId: "profile.opaque"
    })).toMatchObject({
      exactSurfaceRecovered: true,
      exactGraphFragmentRecovered: true
    });
    expect(interpretReversibleConstruction({
      construction,
      surface: "Ada edits",
      profileId: "profile.opaque"
    })).toMatchObject({
      status: "rejected",
      reasons: ["surface_program_mismatch"]
    });
    const pattern = compileReversibleConstructionPattern(construction);
    const hydrated = createLanguageMemoryRuntime({ hasher }).hydrate({
      models: [],
      patterns: [pattern]
    });
    expect(hydrated.importedReversibleConstructions).toEqual([construction]);
    expect(hydrated.importedPatterns).toEqual([]);
  });

  function promotion(
    id: string,
    sourceFamilyId: string,
    partition: AlignmentPromotionObservation["partition"]
  ): AlignmentPromotionObservation {
    return {
      id,
      seriesId: "series.1",
      planId: "plan.1",
      sourceFamilyId,
      partition,
      requiredGraphTargetCount: 3,
      recoveredGraphTargetCount: 3,
      exactAnchorsPreserved: true,
      cycleRecall: 1,
      unsupportedAdditionCount: 0
    };
  }
});

function target(
  id: string,
  portId: string,
  roleId: string,
  realization: "observed" | "omitted" = "observed"
) {
  return {
    id,
    kind: "incidence",
    relationId: "relation.writes",
    relationNodeId: "relation.1",
    hyperedgeId: "hyperedge.1",
    incidenceId: `incidence.${id}`,
    participantNodeId: `participant.${id}`,
    portId,
    roleId,
    valueKind: "opaque",
    realization,
    evidenceIds: ["evidence.1"],
    observableSurfaceKeys: []
  };
}

function candidate(
  id: string,
  unit: ReturnType<typeof buildSurfaceLattice>["units"][number],
  graphTargetId: string
) {
  return {
    id,
    surfaceUnitId: unit.id,
    surfaceFormClassId: unit.surfaceFormClassId,
    graphTargetId,
    graphTargetKind: "incidence",
    graphOrderKey: `order.${graphTargetId}`,
    supportKinds: ["exact_observable_anchor"],
    score: 1,
    surfaceEvidenceIds: ["evidence.1"],
    graphEvidenceIds: ["evidence.1"],
    sharedEvidenceIds: ["evidence.1"],
    sourceCoordinates: {
      byteStart: unit.byteStart,
      byteEnd: unit.byteEnd,
      utf16Start: unit.utf16Start,
      utf16End: unit.utf16End,
      codePointStart: unit.codePointStart,
      codePointEnd: unit.codePointEnd,
      graphemeStart: unit.graphemeStart,
      graphemeEnd: unit.graphemeEnd
    }
  };
}

function transportCell(
  candidateId: string,
  surfaceUnitId: string,
  graphTargetId: string
) {
  return {
    candidateId,
    surfaceUnitId,
    graphTargetId,
    mass: 0.5,
    featureCost: 0,
    structuralCost: 0,
    orderingCost: 0,
    crossDocumentCost: 0,
    anchorCost: 0,
    effectiveCost: 0,
    exactAnchor: true
  };
}
