// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, corpusIdentitySurface, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { createAlphaFieldEngine } from "../field.js";
import { createIdFactory } from "../ids.js";
import { localEvidenceAnswerClaimSurface, localEvidenceAnswerProofExcerpts, proposeSourceExactEvidenceAnswer, requestContentEvidenceUnits } from "../local-evidence-runtime.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import type { EvidenceSpan } from "../types.js";

afterEach(() => clearCorpusIdentitySignals());

describe("short source evidence proposals", () => {
  it("preserves short request content rather than deleting its subject or relation", () => {
    expect(requestContentEvidenceUnits("What is the name of Alice's cat?")).toContain("cat");
    expect(requestContentEvidenceUnits("Describe the gas and the fox.")).toEqual(expect.arrayContaining(["gas", "fox"]));
    expect(requestContentEvidenceUnits("what did he win")).toEqual(["what", "did", "he", "win"]);
  });

  const language = new Set(["what", "is", "was"]);
  const cases = [
    { subject: "Alice's cat", request: "what is alice's cat", text: "Alice's cat was Dinah." },
    { subject: "Qevra", request: "What is Qevra?", text: "Qevra is Nulom." },
    { subject: "Σείριος", request: "What is Σείριος?", text: "Σείριος is Ζήτα." },
    { subject: "Кевра", request: "What is Кевра?", text: "Кевра is Нулом." },
    { subject: "星湖", request: "What is 星湖?", text: "星湖 is 雲城." }
  ];

  it.each(cases)("checks the owned short declaration for $subject instead of the request", ({ subject, request, text }) => {
    const { evidence, ids, hasher } = source(subject, text);
    expect(text.length).toBeLessThan(24);
    const proposal = proposeSourceExactEvidenceAnswer({ requestText: request, selectedEvidence: [evidence],
      closedClassWords: language, functionSymbols: language });
    expect(proposal).toBeDefined();
    const claimText = localEvidenceAnswerClaimSurface(proposal!);
    const excerpts = localEvidenceAnswerProofExcerpts(proposal!);
    expect(claimText).toBe(text);
    expect(claimText).not.toBe(request);
    expect(excerpts).toEqual([{ text, evidenceId: evidence.id }]);
    const result = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: claimText, evidence: proposal!.evidence, nodes: [],
      field: createAlphaFieldEngine().activate({ text: claimText, nodes: [], edges: [] }),
      sourceExcerpts: excerpts, createdAt: 1
    });
    expect(result.claim.text).toBe(text);
    expect(result.evidenceIds).toContain(evidence.id);
    expect(jsonRecord(result.proof.scores).sourceExcerptExact).toBe(true);
  });

  it.each(["== Qevra ==", "Qevra is Nulom?"])("still rejects a non-answer surface: %s", text => {
    const { evidence } = source("Qevra", text);
    expect(proposeSourceExactEvidenceAnswer({ requestText: "What is Qevra?", selectedEvidence: [evidence],
      closedClassWords: language, functionSymbols: language })).toBeUndefined();
  });

  it("does not render a bare topic as its own answer", () => {
    const { evidence } = source("Qevra", "Qevra.");
    const proposal = proposeSourceExactEvidenceAnswer({ requestText: "What is Qevra?", selectedEvidence: [evidence],
      closedClassWords: language, functionSymbols: language });
    expect(proposal?.answer ?? "").toBe("");
  });

  it("does not borrow a short declaration from another owner", () => {
    const { evidence } = source("Zorvan", "Zorvan is Nulom.");
    expect(proposeSourceExactEvidenceAnswer({ requestText: "What is Qevra?", selectedEvidence: [evidence],
      closedClassWords: language, functionSymbols: language })).toBeUndefined();
  });

  it.each([
    { requested: "Σείριος", actual: "Σίρειος", text: "Σίρειος is Ζήτα." },
    { requested: "星湖", actual: "湖星", text: "湖星 is 雲城." }
  ])("does not let shared graphemes bind $requested to a different owner", ({ requested, actual, text }) => {
    const { evidence } = source(actual, text);
    expect(proposeSourceExactEvidenceAnswer({ requestText: `What is ${requested}?`, selectedEvidence: [evidence],
      closedClassWords: language, functionSymbols: language })).toBeUndefined();
  });

  it("does not promote quarantined short evidence into a proof proposal", () => {
    const { evidence } = source("Qevra", "Qevra is Nulom.");
    expect(proposeSourceExactEvidenceAnswer({ requestText: "What is Qevra?", selectedEvidence: [{ ...evidence, status: "quarantined" }],
      closedClassWords: language, functionSymbols: language })).toBeUndefined();
  });
});

function source(title: string, text: string) {
  const hasher = createHasher();
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
  const uri = `fixture://short-source/${encodeURIComponent(title)}`;
  const sourceId = ids.sourceId("fixture", uri), sourceVersionId = ids.sourceVersionId(text);
  const hash = ids.contentHash(text), byteEnd = Buffer.byteLength(text);
  const evidence: EvidenceSpan = {
    id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd, spanHash: hash }),
    sourceId, sourceVersionId, chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd, chunkHash: hash }),
    contentHash: hash, mediaType: "text/plain", byteStart: 0, byteEnd, charStart: 0, charEnd: text.length,
    text, textPreview: text, languageHints: {}, scriptHints: {},
    trustVector: { forceClass: "direct_evidence", sourceTrust: {
      identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: uri, accessScope: "fixture", licenseStatus: "fixture"
    } },
    provenance: { title, uri, canonicalUri: uri, sourceVersionId, byteRange: [0, byteEnd], charRange: [0, text.length] },
    features: featureSet(text, 256), status: "promoted", alpha: 1, observedAt: 1
  };
  // The ordinary turn primes these measured source identities before candidate admission. The source's exact
  // title is the identity; individual graphemes are not substitute owners.
  primeCorpusIdentitySignals({ closedClass: new Set(["what", "is", "was"]), identities: new Set([corpusIdentitySurface(title)]),
    spread: new Map(), concentration: 0 });
  return { evidence, ids, hasher };
}
