// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { CORPUS_SOURCE_SYSTEM_IDS, createSourceAdmissionController, type SourceTrust, type SourceVersion } from "@scce/kernel";
import { corpusSourceTrustForTest } from "../language-corpus-trainer.js";

// corpusSourceTrust was a table of 42 numbers: six per corpus across seven corpora and a fallback, varying in
// ways nothing measured. identity read 0.98 for Wikipedia and 0.9 for OSS docs, though a content hash either
// identifies a source or it does not. directness read 0.72 for Gutenberg and 0.84 for Wikipedia, though the
// text IS the artifact in both. parserReliability read 0.88 to 1, though this trainer receives text that is
// already text.
//
// Four of the six are now facts about how a source was stored and are identical for every corpus. Authority and
// freshness remain the owner's declarations, because neither is readable from the bytes.

const CORPORA = Object.values(CORPUS_SOURCE_SYSTEM_IDS);

describe("a corpus trust vector separates what is measured from what is declared", () => {
  it("derives the same four dimensions for every corpus", () => {
    for (const corpus of CORPORA) {
      const trust = corpusSourceTrustForTest(corpus);
      // Content addressing identifies and verifies a source, whichever corpus it came from.
      expect(trust.identity, corpus).toBe(1);
      expect(trust.integrity, corpus).toBe(1);
      // The trainer is handed text, so there is no parse here that could have gone wrong.
      expect(trust.parserReliability, corpus).toBe(1);
      // The text is the artifact: 1/(1 + derivation depth) at depth 0.
      expect(trust.directness, corpus).toBe(1);
    }
  });

  it("keeps authority coarse, because vouching for a corpus has no decimals in it", () => {
    for (const corpus of CORPORA) {
      const trust = corpusSourceTrustForTest(corpus);
      expect([0, 1], corpus).toContain(trust.authority);
    }
    // Dialogue is owner-authored and current but is never a factual authority; that distinction survives.
    expect(corpusSourceTrustForTest(CORPUS_SOURCE_SYSTEM_IDS.dialogue).authority).toBe(0);
    expect(corpusSourceTrustForTest(CORPUS_SOURCE_SYSTEM_IDS.wikipedia).authority).toBe(1);
  });

  it("still declares each corpus's own independence group, scope and licence", () => {
    const groups = CORPORA.map(corpus => corpusSourceTrustForTest(corpus).independenceGroup);
    // Independence groups must stay distinct: relation promotion counts independent FAMILIES, so collapsing
    // them would hand every corpus the same family and make cross-source corroboration impossible.
    expect(new Set(groups).size).toBe(CORPORA.length);
    expect(corpusSourceTrustForTest(CORPUS_SOURCE_SYSTEM_IDS.gutenberg).licenseStatus).toBe("public_domain");
  });

  it("refuses an unrecognised corpus as direct evidence, where the old fallback scraped past", () => {
    // The retired fallback declared authority exactly 0.4, and the gate is `>= 0.4`. An unknown corpus is not
    // a factual authority, so it now declares none and fails -- the one gate this change strengthens.
    const unknown = corpusSourceTrustForTest("corpus.unheard.of");
    expect(unknown.authority).toBe(0);
    expect(unknown.accessScope).toBe("unknown");

    const source = {
      sourceId: "source_unknown", sourceVersionId: "source_version_unknown", namespace: "corpus",
      canonicalUri: "file://unknown", contentHash: "sha256_unknown", mediaType: "text/plain",
      observedAt: 1_000, byteLength: 64, sourceTrust: unknown as SourceTrust, metadata: {}
    } as unknown as SourceVersion;
    const evidence = [{
      id: "evidence_unknown", sourceId: "source_unknown", sourceVersionId: "source_version_unknown",
      chunkId: "chunk_unknown", contentHash: "sha256_chunk", mediaType: "text/plain",
      byteStart: 0, byteEnd: 8, charStart: 0, charEnd: 8, text: "eight by", textPreview: "eight by",
      languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {},
      features: [], status: "quarantined", alpha: 0.5, observedAt: 1_000
    }] as never[];

    const asDirect = createSourceAdmissionController().decide({
      source, evidence,
      context: { sourceClass: "trusted_corpus", intendedUse: "direct_evidence", promotionAuthority: "training" }
    });
    expect(asDirect.trustChecks.authority).toBe(false);
    expect(asDirect.disposition).not.toBe("promote");

    // It can still be learned from as a prior, which is what an unvouched corpus is good for.
    const asPrior = createSourceAdmissionController().decide({
      source, evidence,
      context: { sourceClass: "trusted_corpus", intendedUse: "learned_prior", promotionAuthority: "training" }
    });
    expect(asPrior.trustChecks.authority).toBe(true);
  });
});
