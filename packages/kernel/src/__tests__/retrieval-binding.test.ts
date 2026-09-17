// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";

import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { retrievalBinding, retrievalBindingCarries, retrievalBindingRank, retrievalBindingSupports } from "../retrieval-binding.js";
import type { EvidenceSpan } from "../types.js";

const NL = String.fromCharCode(10);

const CLOSED = new Set(["the", "in", "a", "of", "and", "to", "was", "is", "as", "on", "for", "by", "at", "with", "s", "from", "which"]);

function corpusSpan(id: string, uri: string, title: string, mediaType: string, text: string): EvidenceSpan {
  return {
    id: `evidence_span.${id}`,
    sourceId: `source.${id}`,
    sourceVersionId: `source_version.${id}`,
    chunkId: `chunk.${id}`,
    contentHash: `sha256_${id}`,
    mediaType,
    text,
    languageHints: ["en"],
    scriptHints: ["Latn"],
    trustVector: { reliability: 1, corroboration: 1, recency: 1 },
    status: "promoted",
    alpha: 1,
    observedAt: new Date(1000).toISOString(),
    textPreview: text.slice(0, 80),
    features: [],
    provenance: { uri, metadata: { title } }
  } as unknown as EvidenceSpan;
}

const planner = corpusSpan("planner", "packages/kernel/src/program-planner.ts", "program planner", "text/plain; charset=utf-8", [
  "// Program planning over the corpus's own measured quantities.",
  "export function createProgramPlanner(options) {",
  "  const planner = buildPlanner(options);",
  "  return planner;",
  "}"
].join(NL));
const article = corpusSpan("albania", "https://en.wikipedia.org/wiki/Albania", "albania", "text/x-wiki",
  "Albania is a country in Southeast Europe. Its capital and largest city is Tirana.");
const unrelatedCode = corpusSpan("unrelated", "packages/kernel/src/mouth.ts", "mouth", "text/plain; charset=utf-8", [
  "// Ada Lovelace is used here only as an example name.",
  "export function realizeSurface(plan) {",
  "  return plan.surface;",
  "}"
].join(NL));

describe("retrievalBinding is the one answer to why evidence is relevant", () => {
  afterEach(() => clearCorpusIdentitySignals());

  it("reports the declaration mechanism and the constituent that bound", () => {
    primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set(["program planner", "createprogramplanner"]),
      spread: new Map([["createprogramplanner", 10], ["file", 960]]),
      concentration: 289
    });
    const binding = retrievalBinding(planner, { requestText: "Which file defines createProgramPlanner?", closedClassWords: CLOSED });

    expect(binding.mechanism).toBe("source_declaration");
    expect(binding.sourceConstituents).toEqual(["createProgramPlanner"]);
    expect(binding.sourceKind.sourceCode).toBe(true);
    expect(binding.admissibility).toBe("admissible");
    expect(binding.specificity.bindingSourceCount).toBe(10);
    expect(binding.specificity.concentrated).toBe(true);
  });

  it("reports the identity mechanism for a source the request is titled with", () => {
    primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set(["albania"]),
      spread: new Map([["albania", 99]]),
      concentration: 289
    });
    const binding = retrievalBinding(article, { requestText: "what is the capital of Albania?", closedClassWords: CLOSED });

    expect(binding.mechanism).toBe("source_identity");
    expect(binding.provenance.title).toBe("albania");
    expect(binding.sourceKind.sourceCode).toBe(false);
    expect(binding.admissibility).toBe("admissible");
  });

  it("refuses a code span the request measurably does not name", () => {
    primeCorpusIdentitySignals({ closedClass: CLOSED, identities: new Set(["albania"]), spread: new Map(), concentration: 289 });
    const binding = retrievalBinding(unrelatedCode, { requestText: "what is the capital of Albania?", closedClassWords: CLOSED });

    expect(binding.mechanism).toBe("unbound");
    expect(binding.admissibility).toBe("inadmissible_unbound");
    expect(retrievalBindingCarries(binding)).toBe(false);
  });

  it("separates unmeasured from refused when the request names no constituent", () => {
    // Law 1. The request produced no anchor, so no binding was measured; three retrieval paths reported that as
    // a refusal and erased every code span on it.
    primeCorpusIdentitySignals({ closedClass: CLOSED, identities: new Set(), spread: new Map(), concentration: 289 });
    const binding = retrievalBinding(unrelatedCode, { requestText: "", closedClassWords: CLOSED });

    expect(binding.requestConstituents).toEqual([]);
    expect(binding.mechanism).toBe("unmeasured");
    expect(binding.admissibility).toBe("undetermined");
    expect(retrievalBindingCarries(binding)).toBe(true);
    expect(binding.specificity.bindingSourceCount).toBeUndefined();
    expect(binding.specificity.concentrated).toBeUndefined();
  });

  it("ranks the titled source first, prose ahead of a declaration match, and an unmeasured code span last", () => {
    // A source file whose comment names the subject must not unseat the article about it (33e4c64); the rank
    // states that order where no admission tier runs.
    primeCorpusIdentitySignals({ closedClass: CLOSED, identities: new Set(["albania"]), spread: new Map(), concentration: 289 });
    const request = { requestText: "what is the capital of Albania?", closedClassWords: CLOSED };
    const titled = retrievalBinding(article, request);
    const prose = retrievalBinding(
      corpusSpan("tirana", "https://en.wikipedia.org/wiki/Tirana", "tirana", "text/x-wiki", "Tirana is the capital of Albania."),
      request
    );
    const declaring = retrievalBinding(
      corpusSpan("names_albania", "packages/kernel/src/fixture.ts", "fixture", "text/plain; charset=utf-8", [
        "// Albania is named in this comment only as an example.",
        "export function albania(options) {",
        "  return options;",
        "}"
      ].join(NL)),
      request
    );
    const unmeasured = retrievalBinding(unrelatedCode, { requestText: "", closedClassWords: CLOSED });

    expect(declaring.mechanism).toBe("source_declaration");
    expect([retrievalBindingRank(titled), retrievalBindingRank(prose), retrievalBindingRank(declaring), retrievalBindingRank(unmeasured)])
      .toEqual([0, 1, 2, 3]);
  });

  it("supports a claim only on a measured binding, while retrieval still carries the unmeasured one", () => {
    // The turn's access policy and the retrieval lanes now read one contract; they differ only in how they
    // resolve `undetermined`, and that difference is stated here rather than in two hand-written filters.
    primeCorpusIdentitySignals({ closedClass: CLOSED, identities: new Set(["createprogramplanner"]), spread: new Map(), concentration: 289 });
    const declaring = retrievalBinding(planner, { requestText: "Which file defines createProgramPlanner?", closedClassWords: CLOSED });
    const unmeasured = retrievalBinding(planner, { requestText: "", closedClassWords: CLOSED });

    expect([retrievalBindingSupports(declaring), retrievalBindingCarries(declaring)]).toEqual([true, true]);
    expect([retrievalBindingSupports(unmeasured), retrievalBindingCarries(unmeasured)]).toEqual([false, true]);
  });

  it("binds a declaration in a code-media span the URI does not name as code", () => {
    // The declaration half read the URI alone while the binding also reads media type and content shape, so a
    // repository span ingested with a bare path and a code media type was source code that could never declare.
    primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set(["createprogramplanner"]),
      spread: new Map([["createprogramplanner", 10]]),
      concentration: 289
    });
    const mediaOnly = corpusSpan("media_only", "packages/kernel/src/program-planner", "", "text/x-source.ts", [
      "export function createProgramPlanner(options) {",
      "  const planner = buildPlanner(options);",
      "  return planner;",
      "}"
    ].join(NL));

    const binding = retrievalBinding(mediaOnly, { requestText: "Which file defines createProgramPlanner?", closedClassWords: CLOSED });

    expect(binding.sourceKind.sourceCode).toBe(true);
    expect(binding.mechanism).toBe("source_declaration");
    expect(binding.admissibility).toBe("admissible");
  });

  it("grants an operator-allowed source kind admissibility without erasing the measurement", () => {
    primeCorpusIdentitySignals({ closedClass: CLOSED, identities: new Set(["albania"]), spread: new Map(), concentration: 289 });
    const binding = retrievalBinding(unrelatedCode, {
      requestText: "what is the capital of Albania?",
      closedClassWords: CLOSED,
      sourceCodeEvidenceAllowed: true
    });

    expect(binding.admissibility).toBe("admissible");
    expect(binding.mechanism).toBe("unbound");
  });
});
