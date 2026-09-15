import { describe, expect, it } from "vitest";
import { planTypedDiscourse, type TypedDiscourseClaim } from "../index.js";

describe("typed discourse planning", () => {
  it("increases supported claim coverage with detail while retaining uncertainty and contradiction", () => {
    const claims: TypedDiscourseClaim[] = [
      claim("claim.primary", "relation.primary", 0.94, { answerGrade: true }),
      claim("claim.secondary", "relation.secondary", 0.82),
      claim("claim.tertiary", "relation.tertiary", 0.74),
      claim("claim.quaternary", "relation.quaternary", 0.68),
      { ...claim("claim.uncertain", "relation.uncertain", 0.48), forceClass: "learned_concept_prior" },
      { ...claim("claim.conflict", "relation.conflict", 0.62), forceClass: "contradicted", contradiction: 1 },
      claim("claim.unsupported", "relation.unsupported", 0, { activation: 0.99, score: 0.99 })
    ];
    const compact = planTypedDiscourse({ claims, relationOrder: ["relation.primary", "relation.secondary", "relation.tertiary", "relation.quaternary"], maxSupportPoints: 1, maxCaveats: 1 });
    const detailed = planTypedDiscourse({ claims, relationOrder: ["relation.primary", "relation.secondary", "relation.tertiary", "relation.quaternary"], maxSupportPoints: 3, maxCaveats: 2 });

    const compactSupported = compact.units.filter(unit => unit.epistemicState === "supported");
    const detailedSupported = detailed.units.filter(unit => unit.epistemicState === "supported");
    expect(detailedSupported.length).toBeGreaterThan(compactSupported.length);
    expect(detailed.admittedClaimIds).toContain("claim.uncertain");
    expect(detailed.admittedClaimIds).toContain("claim.conflict");
    expect(detailed.excludedClaimIds).toContain("claim.unsupported");
    expect(detailed.units.find(unit => unit.claimId === "claim.uncertain")?.role).toBe("caveat");
    expect(detailed.units.find(unit => unit.claimId === "claim.conflict")?.epistemicState).toBe("contradicted");
    expect(detailed.units.map(unit => unit.relationId)).toEqual([
      "relation.primary",
      "relation.secondary",
      "relation.tertiary",
      "relation.quaternary",
      "relation.uncertain",
      "relation.conflict"
    ]);
  });
});

function claim(id: string, relationId: string, score: number, overrides: Partial<TypedDiscourseClaim> = {}): TypedDiscourseClaim {
  return { id, relationId, forceClass: "direct_evidence", support: score, activation: score, score, ...overrides };
}
