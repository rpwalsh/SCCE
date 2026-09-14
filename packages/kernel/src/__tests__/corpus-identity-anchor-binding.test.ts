// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCorpusIdentitySignals,
  corpusIdentitySurface,
  primeCorpusIdentitySignals
} from "../corpus-identity.js";
import { evidenceIdentityBindsRequest, sourceAnchoredEvidenceForRequest, sourceEvidenceAnchorsForRequest } from "../local-evidence-runtime.js";
import { featureSet } from "../primitives.js";
import type { ContentHash, EvidenceId, EvidenceSpan, SourceId, SourceVersionId } from "../types.js";

function prime(input: { closedClass?: Iterable<string>; identities?: Iterable<string> }): void {
  primeCorpusIdentitySignals({
    closedClass: new Set(input.closedClass ?? []),
    identities: new Set(input.identities ?? []),
    spread: new Map(),
    concentration: 0
  });
}

function span(input: { id: string; title: string; text: string; uri?: string }): EvidenceSpan {
  return {
    id: input.id as EvidenceId,
    sourceId: `source:${input.id}` as SourceId,
    sourceVersionId: `version:${input.id}` as SourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${input.id}` as ContentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.9, sourceTrust: 0.9, structuralConfidence: 0.9, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "corpus-identity-anchor-binding-test", title: input.title, uri: input.uri ?? `urn:${input.id}` },
    features: featureSet(input.text, 256),
    status: "promoted",
    alpha: 0.8,
    observedAt: 1000
  };
}

afterEach(() => clearCorpusIdentitySignals());

describe("what the corpus names reaches the anchors", () => {
  it("re-derives a request's anchors when the corpus signal changes", () => {
    // A turn asks for these anchors once before the corpus has been primed for the request and many times after.
    // Memoized for the life of the process, the identity-free first answer was the only one anything ever saw:
    // live, "When did Apollo 11 land on the Moon?" anchored on the content run "did apollo 11 land" while the
    // corpus carries "apollo 11" as a whole source title, and the Apollo 11 spans lost admission to Apollo the
    // Greek god.
    const request = "When did Apollo 11 land on the Moon?";
    prime({ closedClass: ["when", "on", "the"] });
    expect(sourceEvidenceAnchorsForRequest(request)).toContain("did apollo 11 land");

    prime({ closedClass: ["when", "on", "the"], identities: ["apollo 11", "apollo"] });
    expect(sourceEvidenceAnchorsForRequest(request)[0]).toBe("apollo 11");
  });

  it("reads a title the way a request is read, so its punctuation cannot hide it", () => {
    expect(corpusIdentitySurface("Star Trek: Deep Space Nine")).toBe("star trek deep space nine");
    expect(corpusIdentitySurface("Halifax, Nova Scotia")).toBe("halifax nova scotia");
    // The separator the writing system supplies, not a punctuation list: units keep the marks that bind them.
    expect(corpusIdentitySurface("Anglo-Saxon England")).toBe("anglo-saxon england");
  });

  it("prefers the source the request names exactly over the one whose title merely contains it", () => {
    // "Star Trek: Deep Space Nine" is the exact source for this request. Compared with the title's own colon in
    // place it never matched the anchor, so it competed on equal footing with "Star Trek" and lost.
    const request = "Who created Star Trek: Deep Space Nine?";
    prime({
      closedClass: ["who", "the", "of", "is", "an"],
      identities: ["star trek deep space nine", "star trek"]
    });
    const franchise = span({
      id: "evidence_franchise",
      title: "Star Trek",
      text: "Star Trek is an American science fiction media franchise created by Gene Roddenberry."
    });
    const series = span({
      id: "evidence_ds9",
      title: "Star Trek: Deep Space Nine",
      text: "Star Trek: Deep Space Nine is an American science fiction television series created by Rick Berman and Michael Piller."
    });

    const admitted = sourceAnchoredEvidenceForRequest(request, [franchise, series]);
    // The primary anchor is the identity the request named, not the shorter title it contains.
    expect(admitted.anchors[0]).toBe("star trek deep space nine");
    // The franchise article stays reachable on its own identity; it no longer leads the pool it used to own.
    expect(String(admitted.evidence[0]?.id)).toBe("evidence_ds9");
  });

  it("binds a code question to a source file when the requested declaration is in its body", () => {
    const request = "Which file defines bestEvidenceSentences?";
    const source = span({
      id: "evidence_local_runtime",
      title: "",
      uri: "packages/kernel/src/local-evidence-runtime.ts",
      text: "export function bestEvidenceSentences(requestText: string): string[] { return []; }"
    });
    expect(evidenceIdentityBindsRequest(source, request)).toBe(true);
    expect(evidenceIdentityBindsRequest({
      ...source,
      text: "// defines several helpers\nexport function unrelated(value: string): string { return value; }",
      textPreview: "// defines several helpers\nexport function unrelated(value: string): string { return value; }"
    }, "Which file defines helper?")).toBe(false);
  });
});
