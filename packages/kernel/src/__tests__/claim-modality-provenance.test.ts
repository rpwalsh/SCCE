// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createSemanticProofSystem,
  SEMANTIC_MODALITY,
  SEMANTIC_VERDICT,
  toJsonValue,
  type EvidenceSpan,
  type SourceVersionId
} from "../index.js";

// Modality is the epistemic status of a proposition, not which side of a proof comparison it sits on. Deriving it
// from the side made every claim ASSERTED and every piece of evidence OBSERVED, so modalityCompatibility ranked the
// claim above its own source on every factual turn in the product, raised an obligation, and charged contradiction
// for it. Because unifyAtoms scales contradiction by predicate and role similarity, the atom that WAS the answer's
// source scored as the most contradictory thing in the pool: measured at 0.63 against 0.24 for unrelated bigram
// atoms, which carried the turn to "contradicted" and then to insufficient_support over a correct cited answer.
describe("a claim's modality comes from its provenance, not from being the claim", () => {
  const clock = createClock({ fixedTime: 100, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "claim-modality" });
  const proof = createSemanticProofSystem({ hasher });

  function spanFor(uri: string, text: string, sourceVersionId: string): EvidenceSpan {
    const contentHash = ids.contentHash(text);
    const byteEnd = Buffer.byteLength(text);
    return {
      id: ids.evidenceId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd, spanHash: contentHash }),
      sourceId: ids.sourceId("claim-modality", uri),
      sourceVersionId: sourceVersionId as SourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd, chunkHash: contentHash }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd,
      charStart: 0,
      charEnd: [...text].length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ uri }),
      features: [],
      status: "promoted",
      alpha: 0.9,
      observedAt: 100
    } as EvidenceSpan;
  }

  const commissioning = "The Drennish reactor was commissioned on 11 April 1988.";
  const source = spanFor("session://commissioning", commissioning, "version.commissioning");

  it("does not contradict the source a claim was read out of", () => {
    // Identical predicate, polarity, roles and constraints. There is nothing here to disagree about.
    const result = proof.prove({ claimText: commissioning, evidence: [source], nodes: [] });

    expect(result.verdict).not.toBe(SEMANTIC_VERDICT.CONTRADICTED);
    expect(result.contradiction).toBeLessThan(0.42);
    expect(result.counterexamples).toHaveLength(0);
  });

  it("carries the modality of the evidence that grounds it", () => {
    const [claim] = proof.atomizeClaim(commissioning, [source]);
    const [evidence] = proof.atomizeEvidence([source]);

    expect(evidence!.modality).toBe(SEMANTIC_MODALITY.OBSERVED);
    expect(claim!.modality).toBe(SEMANTIC_MODALITY.OBSERVED);
  });

  it("stays asserted when no evidence grounds it", () => {
    // Nothing in the pool says this, so the system would be asserting it on its own authority.
    const [claim] = proof.atomizeClaim("The Drennish reactor was decommissioned on 2 May 2011.", [source]);

    expect(claim!.modality).toBe(SEMANTIC_MODALITY.ASSERTED);
  });

  it("keeps the modality ladder: a claim that outranks its evidence still owes an obligation", () => {
    // The check must still do its job. "must" is REQUIRED, the evidence only OBSERVED, so the claim asserts a
    // necessity the source does not establish and the proof has to say so. Disabling the check would pass the
    // first test here too, which is why this one exists.
    const necessity = "The Drennish reactor must be commissioned on 11 April 1988!";
    const [claim] = proof.atomizeClaim(necessity, [source]);

    expect(claim!.modality).toBe(SEMANTIC_MODALITY.REQUIRED);
    const [evidence] = proof.atomizeEvidence([source]);
    expect(proof.unify(claim!, evidence!).contradiction).toBeGreaterThan(0);
  });

  it("keeps a question possible rather than observed, however well the evidence matches it", () => {
    const [claim] = proof.atomizeClaim("Was the Drennish reactor commissioned on 11 April 1988?", [source]);

    expect(claim!.modality).toBe(SEMANTIC_MODALITY.POSSIBLE);
  });
});
