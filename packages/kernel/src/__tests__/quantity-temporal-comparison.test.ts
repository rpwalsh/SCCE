// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, createSemanticProofSystem, PROOF_CONTRADICTION_THRESHOLD } from "../index.js";

// Two defects met here, and both made a proposition disagree with itself.
//
// quantityContradiction compared every quantity against every other, so "commissioned on 11 April 1988" put 11
// against 1988, found them disjoint, and scored 0.75. The unit guard could not separate them because it only skips
// when BOTH sides name a unit, and a bare year names none.
//
// isTemporalConstraint asked temporalFromJson, which returned a scope for ANY object, so every quantity was also
// read as a time interval and the same two numbers were compared again as instants for another 0.55.
//
// Both are scaled by predicate and role similarity in contradictionScore, so the better a source matched the claim
// the more contradictory it scored: the answer's own source reached 0.63 while unrelated bigram atoms sat at 0.24.
describe("quantities and times are only compared with their own kind", () => {
  const hasher = createHasher();
  const proof = createSemanticProofSystem({ hasher });

  const twoNumbers = "The Drennish reactor was commissioned on 11 April 1988.";

  it("does not let a sentence contradict itself because it mentions two numbers", () => {
    const [claim] = proof.atomizeClaim(twoNumbers);
    const [same] = proof.atomizeClaim(twoNumbers);

    expect(proof.unify(claim!, same!).contradiction).toBe(0);
  });

  it("keeps both numbers as constraints rather than dropping one to avoid the clash", () => {
    const [claim] = proof.atomizeClaim(twoNumbers);
    const values = claim!.constraints.map(constraint => (constraint.value as { value?: number }).value);

    expect(values).toContain(11);
    expect(values).toContain(1988);
  });

  it("still contradicts a different value for the same measurement", () => {
    const [claim] = proof.atomizeClaim("Xylor-7 decomposes at 417 degrees Celsius.");
    const [rival] = proof.atomizeClaim("Xylor-7 decomposes at 431 degrees Celsius.");

    expect(proof.unify(claim!, rival!).contradiction).toBeGreaterThan(PROOF_CONTRADICTION_THRESHOLD);
  });

  it("still contradicts a different date for the same event", () => {
    const [claim] = proof.atomizeClaim("The Drennish reactor was commissioned on 11 April 1988.");
    const [rival] = proof.atomizeClaim("The Drennish reactor was commissioned on 2 May 2011.");

    expect(proof.unify(claim!, rival!).contradiction).toBeGreaterThan(0);
  });

  it("does not read a quantity as an instant", () => {
    // A measurement carries a unit and a value; a time carries a granularity or an instant. Confusing them made
    // "3,412 metres" and any other number in the same sentence look like disjoint intervals.
    const [claim] = proof.atomizeClaim("The summit is 3412 metres above the 1974 survey datum.");
    const [same] = proof.atomizeClaim("The summit is 3412 metres above the 1974 survey datum.");

    expect(proof.unify(claim!, same!).contradiction).toBe(0);
  });
});
