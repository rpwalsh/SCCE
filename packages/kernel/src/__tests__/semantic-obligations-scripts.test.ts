import { describe, expect, it } from "vitest";
import { evaluateSemanticObligations } from "../semantic-obligations.js";
import { createHasher } from "../primitives.js";
import type { Claim, EvidenceSpan, FieldState, GraphNode } from "../types.js";

describe("semantic obligation extraction across scripts", () => {
  it("extracts a real entity obligation from an uncased-script (Korean) claim, the same as it would a capitalized Latin one", () => {
    const text = "세종대왕은 한글을 창제했다.";
    const claim = claimFor(text);
    const evidence = evidenceSpan("evidence.korean", text);
    const result = evaluateSemanticObligations({
      claim,
      evidence: [evidence],
      nodes: [],
      field: emptyField(),
      hasher: createHasher()
    });

    const entityObligations = result.obligations.filter(item => item.kind === "entity");
    expect(entityObligations.length).toBeGreaterThan(0);
    expect(entityObligations.some(item => item.claimText.includes("세종대왕"))).toBe(true);
    // The exact same evidence text is present, so a real entity obligation
    // extracted from it must actually be satisfiable, not merely detected.
    expect(entityObligations.every(item => item.status === "satisfied")).toBe(true);
  });

  it("does not manufacture a spurious 'symbol' obligation from an ordinary abbreviation like 'e.g.'", () => {
    const text = "The pump reads normally, e.g. within spec, today.";
    const claim = claimFor(text);
    const evidence = evidenceSpan("evidence.abbrev", text);
    const result = evaluateSemanticObligations({
      claim,
      evidence: [evidence],
      nodes: [],
      field: emptyField(),
      hasher: createHasher()
    });

    const symbolObligations = result.obligations.filter(item => item.kind === "symbol");
    expect(symbolObligations.some(item => item.claimText.includes("e.g."))).toBe(false);
  });
});

function claimFor(text: string): Claim {
  return {
    id: "claim.scripts" as Claim["id"],
    text,
    normalized: text.toLocaleLowerCase(),
    features: [],
    polarity: 1
  };
}

function evidenceSpan(id: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: `source.${id}` as EvidenceSpan["sourceId"],
    sourceVersionId: `source-version.${id}` as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk.${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash.${id}` as EvidenceSpan["contentHash"],
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
      uri: `https://example.invalid/${id}`,
      sourceVersionId: `source-version.${id}`,
      byteRange: [0, Buffer.byteLength(text)]
    },
    features: [],
    status: "promoted",
    alpha: 1,
    observedAt: 1
  };
}

function emptyField(): FieldState {
  const matrix = { nodes: [] as GraphNode["id"][], values: [] as number[][] };
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
