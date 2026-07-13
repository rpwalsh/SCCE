import { describe, expect, it } from "vitest";
import { createHasher, createSourceCodeFileFacts, createSourceRepositoryFacts } from "../index.js";
import { createCandidateEngine } from "../candidate.js";
import { hybridRecall } from "../retrieval.js";
import { scoreSurfaceEnergy } from "../walsh-surface-energy.js";
import { createRepoSnapshot } from "../developer-intelligence.js";

describe("score trace integration", () => {
  it("candidate engine emits score traces", () => {
    const engine = createCandidateEngine();
    const result = engine.generate({
      requestText: "what is pressure",
      entailment: {
        verdict: "supported",
        support: 0.8,
        contradiction: 0.1,
        faithfulnessLcb: 0.76,
        force: "observed",
        boundaries: [],
        evidenceIds: [],
        supporting: [],
        contradicting: [],
        confidence: {
          verdict: "supported",
          support: 0.8,
          contradiction: 0.1,
          faithfulnessLcb: 0.76,
          lexicalCoverage: 0.5,
          semanticCoverage: 0.5,
          sourceCoverage: 0.5,
          relationCoverage: 0.5,
          transformCoverage: 0.5,
          contradictionPressure: 0.1,
          residualUncertainty: 0.2,
          stabilityScore: 0.6,
          confidenceClass: "medium"
        },
        proof: {
          id: "proof-1",
          claim: {
            id: "claim-1",
            hash: "h",
            atomIds: [],
            text: "pressure is stable",
            normalizedText: "pressure is stable",
            languageId: "language.und",
            symbols: [],
            metadata: {}
          },
          verdict: "source_bound_only",
          obligations: [],
          observations: [],
          admitted: [],
          rejected: [],
          contradictions: [],
          confidenceLcb: 0.65,
          supportMass: 0.8,
          contradictionMass: 0.1,
          trace: []
        }
      },
      evidence: [],
      field: {
        alpha: [],
        alphaTrace: {
          queryFeatures: [],
          surfaces: {
            pressure: 0.5,
            contradictionMass: 0.1,
            drift: 0.2,
            actionability: 0.6,
            risk: 0.2
          },
          evidence: [],
          causalMass: []
        },
        causalMass: []
      },
      ccr: {
        accepted: false,
        l1: { snippets: [] },
        l2: { survivors: [] },
        l3: { answer: "", confidence: 0, abstentions: [], sentences: [] },
        audit: {}
      },
      proofAnswer: "pressure is stable",
      learningNeeds: []
    } as any);

    expect(result.scoreTrace.length).toBeGreaterThan(0);
    expect(result.candidates.some((candidate) => (candidate.scoreTrace?.length ?? 0) > 0)).toBe(true);
  });

  it("retrieval emits score traces", () => {
    const hasher = createHasher();
    const evidence = [{
      id: "e1",
      sourceVersionId: "sv1",
      sourceId: "s1",
      spanStart: 0,
      spanEnd: 10,
      textPreview: "pump pressure stable",
      text: "pump pressure stable",
      symbols: ["pump", "pressure", "stable"],
      features: ["pump", "pressure"],
      alpha: 0.8,
      status: "promoted",
      metadata: {}
    }] as any;
    const plan = hybridRecall({ query: "pump pressure", evidence, hasher });
    expect(plan.recall[0]?.scoreTrace.length).toBeGreaterThan(0);
    expect(plan.recall[0]?.evidenceRole).toBeDefined();
    expect(plan.recall[0]?.reason).toContain("role=");
  });

  it("surface energy emits score traces", () => {
    const result = scoreSurfaceEnergy(
      { id: "c1", text: "pump pressure 42 stable" },
      {
        proofVerdict: "certified",
        surfacePlan: {
          thesis: "construct:test",
          orderedPoints: [{
            id: "p1",
            constructNodeId: "construct:test",
            proposition: "pump pressure 42 stable",
            force: "observed",
            evidenceIds: [],
            role: "answer",
            support: 0.8,
            contradiction: 0.1,
            realizationConstraints: {}
          }],
          realizationFrames: [],
          requiredTerms: [],
          forbiddenSurfaces: [],
          evidenceBindings: [],
          forceBindings: [],
          caveatBindings: [],
          constructForces: [{ id: "FactualConstruct", weight: 0.8, source: "test" }],
          targetLanguage: "language.und",
          targetScript: "script.latn",
          styleProfileId: "style.test",
          style: { name: "test", density: 0.5, formality: 0.5, creativity: 0.1, exposeProofTerms: false },
          registerId: "register.test",
          registerVector: [0.5, 0.2, 0.1],
          detailProfileId: "surface.detail.profile.1",
          boundaryProfile: { hold: 0.5, split: 0.5, merge: 0.5 },
          audit: {}
        } as any
      }
    );
    expect(result.scoreTrace.length).toBeGreaterThan(0);
  });

  it("developer intelligence records include score traces", () => {
    const hasher = createHasher();
    const facts = createSourceCodeFileFacts({
      path: "src/pump.ts",
      mediaType: "text/typescript",
      text: "export const pressure = 42;",
      parser: { id: "typescript-compiler-api", ok: true, diagnostics: [] },
      hasher
    });
    const repositoryFacts = createSourceRepositoryFacts({
      rootUri: "repo",
      files: [{ path: "src/pump.ts", mediaType: facts.mediaType, byteLength: facts.metrics.bytes, contentHash: facts.contentHash, facts }],
      hasher
    });
    const snapshot = createRepoSnapshot({
      rootUri: "repo",
      repositoryFacts,
      fileFacts: [facts],
      hasher
    });
    expect(snapshot.files.length).toBeGreaterThan(0);
    expect(snapshot.files.every((file) => (file.scoreTrace?.length ?? 0) > 0)).toBe(true);
  });
});
