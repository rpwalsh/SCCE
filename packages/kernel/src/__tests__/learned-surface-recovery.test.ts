import { describe, expect, it } from "vitest";
import {
  learnedSurfaceConsultsSourceBound,
  learnedSurfaceRealizesNothing,
  learnedSurfaceTruncatesSourceBound,
  sourceIndependentDialogueRequirements
} from "../production-turn-runtime.js";
import { compileRealizationContract } from "../semantic-answer-construct.js";

// Stands in for the corpus-measured closed class the runtime passes.
const closedClassWords = new Set(["what", "is", "the", "of", "that", "really", "it", "they", "were"]);

function yields(input: { learnedSurface: string; sourceBound: string; requestText: string; realizationContract?: ReturnType<typeof compileRealizationContract> }): boolean {
  const recovery = { ...input, closedClassWords };
  return learnedSurfaceConsultsSourceBound({ ...recovery, preserved: false, learnedNotAnExcerpt: false })
    && learnedSurfaceTruncatesSourceBound(recovery);
}

describe("learned surface against source-bound recovery", () => {
  it("keeps a short learned dialogue surface that carries what the request owes", () => {
    const requestText = "thanks, that really helps";
    const learnedSurface = "glad it helps";
    const sourceBound = "The crew said they were glad it helps the station keep running.";
    expect(sourceBound.includes(learnedSurface)).toBe(true);
    expect(yields({ learnedSurface, sourceBound, requestText })).toBe(false);
    expect(learnedSurfaceRealizesNothing({ learnedSurface, requestText, closedClassWords })).toBe(false);
  });

  it("still yields a short factual surface that drops the request's obligation", () => {
    const requestText = "What is the capital of Peru?";
    expect(yields({ learnedSurface: "the capital", sourceBound: "Lima is the capital of Peru.", requestText })).toBe(true);
    expect(learnedSurfaceRealizesNothing({ learnedSurface: "the capital", requestText, closedClassWords })).toBe(true);
    expect(learnedSurfaceRealizesNothing({ learnedSurface: "It", requestText, closedClassWords })).toBe(true);
    expect(learnedSurfaceRealizesNothing({ learnedSurface: "", requestText, closedClassWords })).toBe(true);
  });

  it("yields a surface that restates the request without the contract's bound value", () => {
    const requestText = "What is the capital of Peru?";
    const realizationContract = compileRealizationContract(requestText, {
      subject: "Peru", predicate: "capital", object: "Lima",
      sourceNodeId: "node.a", targetNodeId: "node.b", relationId: "relation.c",
      evidenceIds: ["evidence.d"], forceClass: "inference",
      score: 0.9, activation: 0.9, overlap: 0.9, support: 0.9
    }, undefined, closedClassWords);
    const sourceBound = "Lima is the capital of Peru.";
    expect(yields({ learnedSurface: "the capital of Peru", sourceBound, requestText, realizationContract })).toBe(true);
    expect(yields({ learnedSurface: "the capital of Peru", sourceBound, requestText })).toBe(false);
  });

  it("routes dialogue by dominance over the source dimensions, not a fixed divisor", () => {
    expect(sourceIndependentDialogueRequirements({ dialogueDependence: 0.5, externalTruthAuthority: 0.2, sourceDependence: 0.2, semanticPreservation: 0.1 })).toBe(true);
    expect(sourceIndependentDialogueRequirements({ dialogueDependence: 0.5, externalTruthAuthority: 0.2, sourceDependence: 0.2, semanticPreservation: 0.55 })).toBe(false);
    // Live code-discussion field: source and truth dominate, so the source path stands.
    expect(sourceIndependentDialogueRequirements({ dialogueDependence: 0.227, externalTruthAuthority: 0.996, sourceDependence: 0.955, semanticPreservation: 0 })).toBe(false);
  });
});
