import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  compileJoinProgram,
  compileJoinProgramMixture,
  createHasher,
  renderJoinedSurface
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

  it("reports unresolved boundaries and inserts nothing when no program is hydrated", () => {
    expect(renderJoinedSurface(["alpha", "beta"], undefined)).toEqual({
      text: "alphabeta",
      trace: [{
        left: "alpha",
        right: "beta",
        join: "",
        source: "unresolved",
        support: 0,
        evidenceIds: []
      }],
      unresolvedBoundaries: 1
    });
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
