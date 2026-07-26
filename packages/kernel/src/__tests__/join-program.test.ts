import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  compileJoinProgram,
  compileJoinProgramMixture,
  createHasher,
  renderJoinedSurface,
  renderJoinedSurfaceAlternatives
} from "../index.js";

function trainedMixture(documentId: string, text: string) {
  const hasher = createHasher();
  const program = compileJoinProgram({
    populationId: `population.${documentId}`,
    documents: [{
      documentId,
      text,
      lattice: buildSurfaceLattice({
        documentId,
        text,
        evidenceIds: [`evidence.${documentId}`],
        segmentationPathLimit: 64,
        hasher
      })
    }],
    hasher
  });
  return compileJoinProgramMixture({
    populationModelId: `population_model.${documentId}`,
    components: [{
      populationId: program.populationId,
      weight: 1,
      program
    }],
    hasher
  });
}

describe("learned join programs", () => {
  it("recovers source-exact spaced and unspaced boundaries without a language fallback", () => {
    const spaced = trainedMixture("spaced", "alpha beta alpha beta");
    const unspaced = trainedMixture("unspaced", "猫追鼠猫追鼠");

    const spacedSurface = renderJoinedSurface(["alpha", "beta"], spaced);
    expect(spacedSurface.text).toBe("alpha beta");
    expect(spacedSurface.trace[0]).toMatchObject({
      left: "alpha",
      right: "beta",
      join: " ",
      source: "exact"
    });

    const unspacedSurface = renderJoinedSurface(["猫", "追"], unspaced);
    expect(unspacedSurface.text).toBe("猫追");
    expect(unspacedSurface.trace[0]?.join).toBe("");
  });

  it("uses posterior mass from competing segmentation paths and retains evidence", () => {
    const mixture = trainedMixture("punctuated", "red—blue red—blue");
    const surface = renderJoinedSurface(["red", "—", "blue"], mixture);

    expect(surface.text).toBe("red—blue");
    expect(surface.trace.flatMap(step => step.evidenceIds)).toContain("evidence.punctuated");
    expect(surface.trace.every(step => step.support > 0)).toBe(true);
  });

  it("conditions joins on unit classes, scales, boundary posterior, and derivation shape", () => {
    const hasher = createHasher();
    const documentId = "doc.conditioned";
    const text = "alpha beta";
    const lattice = buildSurfaceLattice({
      documentId,
      text,
      evidenceIds: ["evidence.conditioned"],
      segmentationPathLimit: 64,
      hasher
    });
    const program = compileJoinProgram({
      populationId: "population.conditioned",
      documents: [{ documentId, text, lattice }],
      hasher
    });
    const mixture = compileJoinProgramMixture({
      populationModelId: "population-model.conditioned",
      components: [{ populationId: program.populationId, weight: 1, program }],
      hasher
    });
    const byId = new Map(lattice.units.map(unit => [unit.id, unit]));
    const units = lattice.segmentationForest.paths[0]!.unitIds
      .map(id => byId.get(id)!)
      .filter(unit => unit.surface.length > 0 && !/^\s+$/u.test(unit.surface));
    const derivationShapeId = units.map(unit =>
      `${unit.kind}:${Math.max(1, unit.graphemeEnd - unit.graphemeStart)}`).join("\u001f");
    const rendered = renderJoinedSurface(
      units.map(unit => unit.surface),
      mixture,
      {
        units: units.map(unit => ({
          surfaceFormClassId: unit.surfaceFormClassId,
          scaleId: unit.kind,
          graphemeWidth: Math.max(1, unit.graphemeEnd - unit.graphemeStart)
        })),
        boundaries: units.slice(0, -1).map(unit => ({
          boundaryProbability: unit.boundaryAfter.boundaryProbability,
          derivationShapeId
        }))
      }
    );

    expect(Object.keys(program.conditionedIndex).length).toBeGreaterThan(0);
    expect(rendered.status).toBe("resolved");
    expect(rendered.trace.length).toBeGreaterThan(0);
    expect(rendered.trace.every(step => step.source === "conditioned")).toBe(true);
  });

  it("makes low-confidence join uncertainty explicit instead of taking a global join", () => {
    const base = trainedMixture("uncertain", "alpha beta alpha beta");
    const exactKey = JSON.stringify(["alpha", "beta"]);
    const ambiguous = {
      ...base,
      components: base.components.map(component => ({
        ...component,
        program: {
          ...component.program,
          exactIndex: {
            ...component.program.exactIndex,
            [exactKey]: [
              { surface: " ", count: 1, probability: 0.5, evidenceIds: ["evidence.space"] },
              { surface: "", count: 1, probability: 0.5, evidenceIds: ["evidence.zero"] }
            ]
          }
        }
      }))
    };
    const rendered = renderJoinedSurface(["alpha", "beta"], ambiguous);

    expect(rendered.status).toBe("unresolved");
    expect(rendered.text).toBe("");
    expect(rendered.trace[0]!.support).toBe(0.5);
    expect(rendered.trace[0]!.alternatives).toHaveLength(2);
    expect(JSON.stringify(ambiguous)).not.toContain("globalChoices");
  });

  it("reports unresolved boundaries and inserts nothing when no program is hydrated", () => {
    expect(renderJoinedSurface(["alpha", "beta"], undefined)).toEqual({
      text: "",
      trace: [{
        left: "alpha",
        right: "beta",
        join: "",
        source: "unresolved",
        support: 0,
        alternatives: [],
        evidenceIds: []
      }],
      unresolvedBoundaries: 1,
      status: "unresolved",
      requiredAction: "try_alternate_derivation"
    });
  });

  it("tries another derivation, then preserves an observed larger span before requesting evidence", () => {
    const mixture = trainedMixture("alternatives", "alpha beta alpha beta");
    const selected = renderJoinedSurfaceAlternatives({
      derivations: [["unknown", "pair"], ["alpha", "beta"]],
      mixture
    });
    expect(selected.status).toBe("resolved");
    expect(selected.selectedDerivationIndex).toBe(1);
    expect(selected.text).toBe("alpha beta");

    const preserved = renderJoinedSurface(["Washington", "did", "not", "invent"], undefined, {
      observedSourceSpan: {
        text: "Washington did not invent",
        evidenceIds: ["evidence.source-span"]
      }
    });
    expect(preserved.status).toBe("preserved_source_span");
    expect(preserved.text).toBe("Washington did not invent");
    expect(preserved.text).not.toBe("Washingtondidnotinvent");

    const unresolved = renderJoinedSurfaceAlternatives({
      derivations: [["Washington", "did", "not", "invent"]],
      mixture: undefined
    });
    expect(unresolved).toMatchObject({
      text: "",
      status: "unresolved",
      requiredAction: "request_additional_evidence"
    });
  });

  it("reports source-disjoint held-out likelihood, calibration, reconstruction, and error classes", () => {
    const hasher = createHasher();
    const documents = Array.from({ length: 6 }, (_, index) => {
      const documentId = `doc.heldout.${index}`;
      const text = "alpha beta. alpha beta.";
      return {
        documentId,
        text,
        lattice: buildSurfaceLattice({
          documentId,
          text,
          evidenceIds: [`evidence.${documentId}`],
          segmentationPathLimit: 64,
          hasher
        })
      };
    });
    const program = compileJoinProgram({
      populationId: "population.heldout",
      documents,
      hasher
    });

    expect(program.schema).toBe("scce.join_program.v2");
    expect(program.evaluation.heldoutDocumentIds.length).toBeGreaterThan(0);
    expect(program.evaluation.observations).toBeGreaterThan(0);
    expect(program.evaluation.exactAccuracy).not.toBeNull();
    expect(program.evaluation.negativeLogLikelihood).not.toBeNull();
    expect(program.evaluation.expectedCalibrationError).not.toBeNull();
    expect(program.evaluation.reconstructionAccuracy).toBe(program.evaluation.exactAccuracy);
    expect(program.evaluation.whitespaceInsertionErrors).toBeGreaterThanOrEqual(0);
    expect(program.evaluation.whitespaceDeletionErrors).toBeGreaterThanOrEqual(0);
    expect(program.evaluation.punctuationErrors).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(program.audit)).toContain("\"globalJoinFallback\":false");
  });

  it("is deterministic under document order", () => {
    const hasher = createHasher();
    const documents = ["a", "b"].map(documentId => {
      const text = documentId === "a" ? "one two one two" : "three four three four";
      return {
        documentId,
        text,
        lattice: buildSurfaceLattice({
          documentId,
          text,
          segmentationPathLimit: 64,
          hasher
        })
      };
    });
    const left = compileJoinProgram({
      populationId: "population.stable",
      documents,
      hasher
    });
    const right = compileJoinProgram({
      populationId: "population.stable",
      documents: [...documents].reverse(),
      hasher
    });

    expect(right).toEqual(left);
  });
});
