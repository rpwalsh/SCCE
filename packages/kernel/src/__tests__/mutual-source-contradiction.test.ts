// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createSemanticProofSystem,
  PROOF_CONTRADICTION_THRESHOLD,
  SEMANTIC_VERDICT,
  toJsonValue,
  type EvidenceSpan,
  type SourceVersionId
} from "../index.js";

// searchProof unifies each claim atom against the support atoms, which answers "does the evidence refute this claim"
// and cannot answer "do these sources refute each other". The second is the question a reader has when two filings
// name different years for one appointment, and it is not reachable through the first: the claim is the cleaned
// answer excerpt and unifies with the prefixed source sentences below at 0.27, under the threshold, while the two
// sources unify with each other at 0.52 and disagree on the year.
describe("two admitted sources that refute each other", () => {
  const clock = createClock({ fixedTime: 100, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "mutual-contradiction" });
  const proof = createSemanticProofSystem({ hasher });

  function spanFor(uri: string, text: string, sourceVersionId: string): EvidenceSpan {
    const contentHash = ids.contentHash(text);
    const byteEnd = Buffer.byteLength(text);
    return {
      id: ids.evidenceId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd, spanHash: contentHash }),
      sourceId: ids.sourceId("mutual", uri),
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

  const filedIn2019 = spanFor(
    "session://filing-a",
    "Source A, filed 2019-03-02 by Halvern Dynamics: Alice Renner became chief executive of Halvern Dynamics in 2019.",
    "version.filing-a"
  );
  const filedIn2021 = spanFor(
    "session://filing-b",
    "Source B, press release dated 2021-07-14 from Halvern Dynamics: Alice Renner became chief executive of Halvern Dynamics in 2021.",
    "version.filing-b"
  );
  const answerExcerpt = "Alice Renner became chief executive of Halvern Dynamics in 2019.";

  it("is invisible to claim-versus-evidence comparison alone", () => {
    // The claim unifies with each prefixed source below the threshold, so no claim-side counterexample exists.
    // This is why the disagreement has to be looked for between the sources rather than against the answer.
    const claim = proof.atomizeClaim(answerExcerpt)[0]!;
    const source = proof.atomizeEvidence([filedIn2021])[0]!;

    expect(proof.unify(claim, source).contradiction).toBeLessThan(PROOF_CONTRADICTION_THRESHOLD);
  });

  it("is found when both sources are admitted, and names both of them", () => {
    const result = proof.prove({ claimText: answerExcerpt, evidence: [filedIn2019, filedIn2021], nodes: [] });

    expect(result.mutualSourceContradiction).toBe(true);
    expect(result.counterexamples.length).toBeGreaterThan(0);
    // Reported on its own channel, and NOT charged to the claim: `contradiction` answers "does the evidence refute
    // this claim", and the first test above established that nothing here does. Folding the mutual finding into that
    // scalar made two sources disagreeing look like the claim being refuted, which then blocked source excerpts that
    // nothing contradicted -- measured on "Who was Charles Babbage?", where eight mutual pairs among two admitted
    // articles set the claim's contradiction to 0.569 and suppressed the answer.
    expect(result.contradiction).toBeLessThanOrEqual(PROOF_CONTRADICTION_THRESHOLD);
    const cited = new Set(result.counterexamples.flatMap(item => item.evidenceIds.map(String)));
    expect(cited.has(String(filedIn2019.id))).toBe(true);
    expect(cited.has(String(filedIn2021.id))).toBe(true);
  });

  it("leaves the turn no ground to assert either side", () => {
    const result = proof.prove({ claimText: answerExcerpt, evidence: [filedIn2019, filedIn2021], nodes: [] });

    expect(result.verdict).toBe(SEMANTIC_VERDICT.CONTRADICTED);
  });

  it("does not fire on one source alone, however it is quoted", () => {
    const result = proof.prove({ claimText: answerExcerpt, evidence: [filedIn2019], nodes: [] });

    expect(result.mutualSourceContradiction).toBe(false);
    expect(result.verdict).not.toBe(SEMANTIC_VERDICT.CONTRADICTED);
  });

  it("does not fire on two sources that agree", () => {
    const agreeing = spanFor(
      "session://filing-c",
      "Source C, filed 2019-11-08 by Halvern Dynamics: Alice Renner became chief executive of Halvern Dynamics in 2019.",
      "version.filing-c"
    );
    const result = proof.prove({ claimText: answerExcerpt, evidence: [filedIn2019, agreeing], nodes: [] });

    expect(result.mutualSourceContradiction).toBe(false);
  });

  it("does not fire on two spans of one document that mention different figures", () => {
    // An article stating a figure in one place and a different one in another is not a corpus in disagreement.
    // Treating it as one would refuse to answer from any document that mentions two numbers.
    const sourceVersionId = "version.one-article";
    const lede = spanFor("corpus://article#lede", 
      "Source A, filed 2019-03-02 by Halvern Dynamics: Alice Renner became chief executive of Halvern Dynamics in 2019.",
      sourceVersionId);
    const table = spanFor("corpus://article#table",
      "Source B, press release dated 2021-07-14 from Halvern Dynamics: Alice Renner became chief executive of Halvern Dynamics in 2021.",
      sourceVersionId);
    const result = proof.prove({ claimText: answerExcerpt, evidence: [lede, table], nodes: [] });

    expect(result.mutualSourceContradiction).toBe(false);
  });

  it("treats two statements the owner made this session as two sources, not one", () => {
    // A session shares one source version by construction, so keying independence on it made two separate owner
    // statements look like one document and hid the disagreement. Each turn is its own assertion.
    const sessionVersion = "version.session";
    const first = { ...spanFor("session://turn-1",
      "Source A, filed 2019-03-02 by Halvern Dynamics: Alice Renner became chief executive of Halvern Dynamics in 2019.",
      sessionVersion), id: "evidence_session_a" as EvidenceSpan["id"] };
    const second = { ...spanFor("session://turn-2",
      "Source B, press release dated 2021-07-14 from Halvern Dynamics: Alice Renner became chief executive of Halvern Dynamics in 2021.",
      sessionVersion), id: "evidence_session_b" as EvidenceSpan["id"] };
    const result = proof.prove({ claimText: answerExcerpt, evidence: [first, second], nodes: [] });

    expect(result.mutualSourceContradiction).toBe(true);
  });

  it("does not let a source contradict its own restatement", () => {
    // The same span offered twice is one source, not two, and a document is not in conflict with itself here.
    const result = proof.prove({ claimText: answerExcerpt, evidence: [filedIn2021, filedIn2021], nodes: [] });

    expect(result.mutualSourceContradiction).toBe(false);
  });
});
