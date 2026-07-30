import { describe, expect, it } from "vitest";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher } from "../primitives.js";
import type { EvidenceSpan, FieldState } from "../types.js";

describe("exact source assessment", () => {
  it("certifies source fidelity without inventing external truth, causality, stability, or corroboration", () => {
    const clock = createClock({ fixedTime: 1_700_000_000_000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({
      clock,
      hasher,
      namespace: "exact-source-assessment",
      deterministicReplay: true,
      runSeed: "fixture"
    });
    const text = "The source states this exact proposition.";
    const evidence = evidenceSpan(text);
    const result = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text,
      evidence: [evidence],
      nodes: [],
      field: emptyField(),
      createdAt: clock.now(),
      sourceExcerpts: [{ text, evidenceId: evidence.id }]
    });

    // Not "observed": with an empty graph (nodes: []) and no construct/typed
    // observations, textIdentityGate's verbatim text match is real source
    // fidelity (asserted below) but not independent corroboration -- text
    // matching itself to itself, however exact, must not alone earn
    // "observed"/"proved". See entailment.ts's forceFromSemantic and
    // mouth-runtime.test.ts's "uses the bounded exact-excerpt entailment
    // route" for the same, deliberate design applied to an identical
    // claim-equals-evidence-verbatim scenario.
    expect(result.force).toBe("inferred");
    expect(result.sourceAssessment).toEqual({
      sourceFidelity: 1,
      sourceAttribution: 1,
      externalTruth: "unknown",
      causalSupport: "not_applicable",
      independentCorroboration: {
        status: "not_measured",
        independentGroupCount: null
      }
    });
    expect(result.scores.causalMass).toBe(0);
    // Not 0: scores.stability measures alpha-field volatility (1 - drift -
    // bondedLeakage - contradiction pressure), not multi-observation
    // temporal/causal stability -- an inert, untouched field genuinely has
    // no volatility to detect, so 1 is the real computed value, not a
    // fabricated one. The honest "we didn't measure repeated-observation
    // stability" signal lives in sourceAssessment.independentCorroboration
    // (asserted above as "not_measured"), which is the field this test's
    // anti-fabrication guarantee is actually about.
    expect(result.scores.stability).toBe(1);
    expect(result.confidence.causalMass).toBe(0);
    expect(result.confidence.stability).toBe(1);
  });
});

function evidenceSpan(text: string): EvidenceSpan {
  return {
    id: "evidence.exact" as EvidenceSpan["id"],
    sourceId: "source.exact" as EvidenceSpan["sourceId"],
    sourceVersionId: "source-version.exact" as EvidenceSpan["sourceVersionId"],
    chunkId: "chunk.exact" as EvidenceSpan["chunkId"],
    contentHash: "hash.exact" as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: Buffer.byteLength(text),
    charStart: 0,
    charEnd: [...text].length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: {},
    provenance: {
      uri: "https://example.invalid/exact",
      sourceVersionId: "source-version.exact",
      byteRange: [0, Buffer.byteLength(text)]
    },
    features: [],
    status: "promoted",
    alpha: 1,
    observedAt: 1
  };
}

function emptyField(): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    causalMass: [],
    alphaTrace: {
      alpha: 0.5,
      thresholds: { virtual: 0.2, visible: 0.4, bonded: 0.6, structural: 0.8 },
      relations: [],
      adjacency: matrix,
      laplacian: matrix,
      normalizedLaplacian: matrix,
      surfaces: {
        pressure: 0,
        drift: 0,
        contradiction: 0,
        bond: 0,
        risk: 0,
        actionability: 0
      },
      contradictionMass: 0,
      bondedLeakage: 0
    }
  };
}
