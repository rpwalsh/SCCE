import { describe, expect, it } from "vitest";
import { consolidateSemanticClaims, type SemanticClaimObservation } from "../semantic-memory-consolidation.js";

function observation(input: Partial<SemanticClaimObservation> & Pick<SemanticClaimObservation, "id" | "subjectId" | "canonicalValue" | "sourceId" | "observedAt">): SemanticClaimObservation {
  return { evidenceIds: [], ...input };
}

describe("semantic memory consolidation (plan items 213-214)", () => {
  it("merges repeated equivalent observations of the same subject into one canonical claim", () => {
    const observations: SemanticClaimObservation[] = [
      observation({ id: "o1", subjectId: "release.codename", canonicalValue: "Aster", sourceId: "source.a", observedAt: 100, evidenceIds: ["e1"] }),
      observation({ id: "o2", subjectId: "release.codename", canonicalValue: "Aster", sourceId: "source.b", observedAt: 200, evidenceIds: ["e2"] }),
      observation({ id: "o3", subjectId: "release.codename", canonicalValue: "Aster", sourceId: "source.a", observedAt: 300, evidenceIds: ["e3"] })
    ];
    const [result] = consolidateSemanticClaims(observations);
    expect(result!.contradictory).toBe(false);
    expect(result!.claims).toHaveLength(1);
    expect(result!.claims[0]!.supportingObservationIds).toEqual(["o1", "o2", "o3"]);
    expect(result!.claims[0]!.sourceIds).toEqual(["source.a", "source.b"]);
    expect(result!.claims[0]!.evidenceIds).toEqual(["e1", "e2", "e3"]);
    expect(result!.claims[0]!.firstObservedAt).toBe(100);
    expect(result!.claims[0]!.lastObservedAt).toBe(300);
  });

  it("never turns genuine disagreement into false consensus: two contradicting sources both remain visible after merge", () => {
    const observations: SemanticClaimObservation[] = [
      observation({ id: "o1", subjectId: "release.codename", canonicalValue: "Aster", sourceId: "source.a", observedAt: 100 }),
      observation({ id: "o2", subjectId: "release.codename", canonicalValue: "Astra", sourceId: "source.b", observedAt: 150 })
    ];
    const [result] = consolidateSemanticClaims(observations);
    expect(result!.contradictory).toBe(true);
    expect(result!.claims).toHaveLength(2);
    const values = result!.claims.map(claim => claim.canonicalValue).sort();
    expect(values).toEqual(["Aster", "Astra"]);
    // Neither claim silently absorbed the other's support.
    expect(result!.claims.find(claim => claim.canonicalValue === "Aster")!.supportingObservationIds).toEqual(["o1"]);
    expect(result!.claims.find(claim => claim.canonicalValue === "Astra")!.supportingObservationIds).toEqual(["o2"]);
  });

  it("compares structured (object/array) canonical values by deep equality, not reference identity", () => {
    const observations: SemanticClaimObservation[] = [
      observation({ id: "o1", subjectId: "config.limits", canonicalValue: { max: 10, min: 1 }, sourceId: "source.a", observedAt: 1 }),
      observation({ id: "o2", subjectId: "config.limits", canonicalValue: { min: 1, max: 10 }, sourceId: "source.b", observedAt: 2 })
    ];
    const [result] = consolidateSemanticClaims(observations);
    expect(result!.contradictory).toBe(false);
    expect(result!.claims).toHaveLength(1);
    expect(result!.claims[0]!.supportingObservationIds).toEqual(["o1", "o2"]);
  });

  it("keeps separate subjects entirely independent", () => {
    const observations: SemanticClaimObservation[] = [
      observation({ id: "o1", subjectId: "subject.a", canonicalValue: "x", sourceId: "s", observedAt: 1 }),
      observation({ id: "o2", subjectId: "subject.b", canonicalValue: "y", sourceId: "s", observedAt: 2 })
    ];
    const results = consolidateSemanticClaims(observations);
    expect(results).toHaveLength(2);
    expect(results.map(result => result.subjectId)).toEqual(["subject.a", "subject.b"]);
  });
});
