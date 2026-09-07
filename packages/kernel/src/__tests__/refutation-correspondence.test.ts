// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, createSemanticProofSystem, PROOF_CONTRADICTION_THRESHOLD } from "../index.js";

// searchProof picks the best supporting atom by support and the strongest counterexample by contradiction, over the
// same candidates, independently. Nothing in that selection requires the two to be about the same proposition, so
// the guard has to come from the scores themselves: a refutation must never exceed the correspondence it rests on.
//
// It did. Every term inside contradictionScore was multiplied by correspondence and the transform boost was added
// afterwards, so two individually bounded quantities summed past the bound -- measured at 0.11 over on ordinary
// sentences. Disagreement and aboutness are now separate quantities multiplied once, which makes the bound hold by
// construction rather than by luck, and an atom about another proposition cannot reach the threshold however
// strongly it disagrees about its own subject.
describe("a refutation never exceeds the correspondence it rests on", () => {
  const hasher = createHasher();
  const proof = createSemanticProofSystem({ hasher });

  const sentences = [
    "Xylor-7 decomposes at 417 degrees Celsius.",
    "Xylor-7 decomposes at 431 degrees Celsius.",
    "The Ostry tunnel was opened in 1974.",
    "Factory A had 12 machines on Monday.",
    "Two machines were retired from Factory A on Tuesday.",
    "The Drennish reactor was commissioned on 11 April 1988.",
    "Was the reactor commissioned in 1988?",
    "The reactor must be commissioned on 11 April 1988!",
    "Alice Renner became chief executive of Halvern Dynamics in 2019.",
    "Survey record K-11: the summit of Mount Verrick is 3412 metres above sea level.",
    "Survey record K-12: the summit of Mount Verrick is 3388 metres above sea level."
  ];
  const atoms = sentences.flatMap(sentence => proof.atomizeClaim(sentence));

  it("holds for every pair, including the modality and polarity paths", () => {
    let worst = { gap: -1, left: "", right: "" };
    for (const left of atoms) {
      for (const right of atoms) {
        if (left.id === right.id) continue;
        const unified = proof.unify(left, right);
        const gap = unified.contradiction - unified.correspondence;
        if (gap > worst.gap) worst = { gap, left: left.sourceText, right: right.sourceText };
      }
    }

    expect(worst.gap, `worst pair:\n  ${worst.left}\n  ${worst.right}`).toBeLessThanOrEqual(1e-9);
  });

  it("reports correspondence as its own relation", () => {
    const [claim] = proof.atomizeClaim("Xylor-7 decomposes at 417 degrees Celsius.");
    const [sameSubject] = proof.atomizeClaim("Xylor-7 decomposes at 431 degrees Celsius.");
    const [otherSubject] = proof.atomizeClaim("The Ostry tunnel was opened in 1974.");

    expect(proof.unify(claim!, sameSubject!).correspondence)
      .toBeGreaterThan(proof.unify(claim!, otherSubject!).correspondence);
  });

  it("still admits a real disagreement about the same measurement", () => {
    const [claim] = proof.atomizeClaim("Xylor-7 decomposes at 417 degrees Celsius.");
    const [rival] = proof.atomizeClaim("Xylor-7 decomposes at 431 degrees Celsius.");

    expect(proof.unify(claim!, rival!).contradiction).toBeGreaterThan(PROOF_CONTRADICTION_THRESHOLD);
  });

  it("still admits a real disagreement about the same height", () => {
    const [claim] = proof.atomizeClaim("Survey record K-11: the summit of Mount Verrick is 3412 metres above sea level.");
    const [rival] = proof.atomizeClaim("Survey record K-12: the summit of Mount Verrick is 3388 metres above sea level.");

    expect(proof.unify(claim!, rival!).contradiction).toBeGreaterThan(PROOF_CONTRADICTION_THRESHOLD);
  });
});
