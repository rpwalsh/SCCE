import { describe, expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createProgramGraphBuilder } from "../index.js";

describe("ProgramGraph source synthesis", () => {
  it("emits request-shaped source artifacts from proof/evidence pressure", () => {
    const clock = createClock({ fixedTime: 1000, stepMs: 1 });
    const hasher = createHasher();
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
    const builder = createProgramGraphBuilder({ idFactory, hasher });
    const evidenceId = idFactory.evidenceId({ sourceVersionId: idFactory.sourceVersionId("doc"), byteStart: 0, byteEnd: 4, spanHash: idFactory.contentHash("doc") });
    const construct = builder.build({
      episodeId: idFactory.episodeId(),
      text: "build a csv transformer that reads records and emits normalized json",
      createdAt: 1000,
      evidence: [{
        id: evidenceId,
        sourceId: idFactory.sourceId("local", "doc"),
        sourceVersionId: idFactory.sourceVersionId("doc"),
        chunkId: idFactory.chunkId({ sourceVersionId: idFactory.sourceVersionId("doc"), byteStart: 0, byteEnd: 4, chunkHash: idFactory.contentHash("doc") }),
        contentHash: idFactory.contentHash("doc"),
        mediaType: "text/plain",
        byteStart: 0,
        byteEnd: 4,
        charStart: 0,
        charEnd: 4,
        text: "id,value,timestamp\nA,42,2026-01-01\nB,17,2026-01-02",
        textPreview: "id,value,timestamp\nA,42,2026-01-01\nB,17,2026-01-02",
        languageHints: {},
        scriptHints: {},
        trustVector: { trust: 1 },
        provenance: {},
        features: ["sym:csv", "sym:transformer", "sym:json", "sym:value"],
        status: "promoted",
        alpha: 1,
        observedAt: 1000
      }],
      entailment: {
        claim: { id: idFactory.claimId("build a csv transformer"), text: "build a csv transformer", normalized: "build csv transformer", features: ["sym:build", "sym:csv", "sym:transformer", "sym:json"], polarity: 1 },
        verdict: "underdetermined",
        semanticVerdict: "underdetermined",
        force: "inferred",
        support: 0.5,
        contradiction: 0,
        faithfulnessLcb: 0.2,
        confidence: { verdict: "underdetermined", support: 0.5, contradiction: 0, faithfulnessLcb: 0.2, supportingEvidence: 1, sourceVersions: [], structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, causalMass: 0.1, stability: 0.8, satisfiedObligations: 0, requiredObligations: 0 },
        scores: { structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, causalMass: 0.1, faithfulnessLCB: 0.2, contradiction: 0, stability: 0.8 },
        obligations: [],
        mappings: [],
        transforms: [],
        counterexamples: [],
        missing: [],
        evidenceIds: [evidenceId],
        boundaries: [],
        proof: {
          id: idFactory.proofId({ claimId: idFactory.claimId("build a csv transformer"), evidenceIds: [evidenceId], transforms: ["t"], validatorVersion: "v" }),
          claimId: idFactory.claimId("build a csv transformer"),
          verdict: "inferred",
          confidence: {},
          proofGraph: { nodes: [], edges: [] },
          evidenceIds: [evidenceId],
          transformIds: [],
          scores: {},
          validatorVersion: "v",
          createdAt: 1000
        }
      }
    });
    expect(construct.program?.language).toBe("media-type:text/plain");
    expect(construct.program?.entrypoint).toBe("src/main.source");
    expect(construct.program?.files.map(f => f.path)).toContain("src/main.source");
    expect(construct.program?.files.map(f => f.path)).toContain("source.program.json");
    expect(construct.program?.files.map(f => f.path)).toContain("program.graph.json");
    const shape = construct.program?.nodes.find(node => node.id === "program-shape")?.metadata as {
      requiredInputs?: Array<{ mediaType: string }>;
      requiredOutputs?: Array<{ mediaType: string }>;
    };
    expect(shape.requiredInputs?.some(input => input.mediaType === "text/csv")).toBe(true);
    expect(shape.requiredOutputs?.some(output => output.mediaType === "application/json")).toBe(true);
  });
});
