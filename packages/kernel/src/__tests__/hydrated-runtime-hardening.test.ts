import { describe, expect, it } from "vitest";
import {
  containsUnresolvedSurfaceKey,
  createClock,
  createHasher,
  createIdFactory,
  createProgramGraphBuilder,
  createProofCarryingAnswer,
  formatSurfaceMessage
} from "../index.js";
import type { ContentHash, EvidenceSpan, JsonValue, SemanticEntailmentResult, SourceId, SourceVersionId } from "../types.js";

describe("hydrated runtime surface hardening", () => {
  const clock = createClock({ fixedTime: 32000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "hydrated-hardening" });

  it("resolves missing surface messages without leaking runtime localization ids", () => {
    const missing = formatSurfaceMessage("surface.unregistered.runtime_key", { force: "inferred" });
    expect(missing.length).toBeGreaterThan(0);
    expect(containsUnresolvedSurfaceKey(missing)).toBe(false);

    const pca = createProofCarryingAnswer().certify({
      answer: "This answer is intentionally not certified by evidence.",
      evidence: [],
      force: "inferred"
    });
    expect(pca.releaseAnswer.length).toBeGreaterThan(0);
    expect(containsUnresolvedSurfaceKey(pca.releaseAnswer)).toBe(false);
  });

  it("does not emit ProgramGraph for a simple hydrated fact phrase", () => {
    const evidence = [evidenceSpan("azurite operator stabilizes cyan surface", {}, ["sym:azurite", "sym:operator", "sym:stabilizes", "sym:cyan", "sym:surface"])];
    const construct = createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text: "azurite operator stabilizes cyan surface",
      createdAt: clock.now(),
      entailment: entailment("azurite operator stabilizes cyan surface", evidence),
      evidence
    });
    const activation = activationFrom(construct.forceVector);
    expect(construct.program).toBeUndefined();
    expect(construct.artifacts).toEqual([]);
    expect(activation.activate).toBe(false);
    expect(activation.reasons).toEqual([]);
  });

  it("emits ProgramGraph for explicit artifact intent and records activation reasons", () => {
    const evidence = [evidenceSpan("stdin rows can be normalized into json lines", {}, ["sym:stdin", "sym:json", "sym:command", "sym:artifact"])];
    const construct = createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text: "create a command artifact that reads stdin and writes normalized json",
      createdAt: clock.now(),
      entailment: entailment("create command artifact", evidence),
      evidence
    });
    const activation = activationFrom(construct.forceVector);
    expect(construct.program).toBeDefined();
    expect(construct.artifacts.length).toBeGreaterThan(0);
    expect(activation.activate).toBe(true);
    expect(activation.reasons).toContain("program.activation.explicit_request");
  });

  it("keeps workspace engineering evidence able to activate ProgramGraph", () => {
    const evidence = [evidenceSpan("repository source exposes build and test commands", { metadata: { engineeringCorpus: true, repositoryFacts: true } }, ["sym:repository", "sym:source", "sym:build", "sym:test"])];
    const construct = createProgramGraphBuilder({ idFactory: ids, hasher }).build({
      episodeId: ids.episodeId(),
      text: "repository source build test",
      createdAt: clock.now(),
      entailment: entailment("repository source build test", evidence),
      evidence
    });
    const activation = activationFrom(construct.forceVector);
    expect(construct.program).toBeDefined();
    expect(activation.activate).toBe(true);
    expect(activation.reasons).toContain("program.activation.engineering_evidence");
  });

  function evidenceSpan(text: string, provenance: JsonValue, features: string[]): EvidenceSpan {
    const sourceVersionId = ids.sourceVersionId(text) as SourceVersionId;
    const contentHash = ids.contentHash(text) as ContentHash;
    return {
      id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: text.length, spanHash: contentHash }),
      sourceId: ids.sourceId("fixture", text) as SourceId,
      sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: text.length, chunkHash: contentHash }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: text.length,
      charStart: 0,
      charEnd: text.length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1, forceClass: "direct_evidence" },
      provenance,
      features,
      status: "promoted",
      alpha: 0.9,
      observedAt: clock.now()
    };
  }

  function entailment(text: string, evidence: EvidenceSpan[]): SemanticEntailmentResult {
    const evidenceIds = evidence.map(item => item.id);
    const sourceVersions = evidence.map(item => String(item.sourceVersionId));
    const claimId = ids.claimId(text);
    return {
      claim: { id: claimId, text, normalized: text, features: [], polarity: 1 },
      verdict: "underdetermined",
      semanticVerdict: "underdetermined",
      force: "inferred",
      support: 0.58,
      contradiction: 0,
      faithfulnessLcb: 0.34,
      confidence: { verdict: "underdetermined", support: 0.58, contradiction: 0, faithfulnessLcb: 0.34, supportingEvidence: evidence.length, sourceVersions, structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, causalMass: 0.1, stability: 0.8, satisfiedObligations: 0, requiredObligations: 0 },
      scores: { structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, causalMass: 0.1, faithfulnessLCB: 0.34, contradiction: 0, stability: 0.8 },
      obligations: [],
      mappings: [],
      transforms: [],
      counterexamples: [],
      missing: [],
      evidenceIds,
      boundaries: [],
      proof: {
        id: ids.proofId({ claimId, evidenceIds, transforms: ["hydrated-hardening"], validatorVersion: "test" }),
        claimId,
        verdict: "inferred",
        confidence: {},
        proofGraph: { nodes: [], edges: [] },
        evidenceIds,
        transformIds: [],
        scores: {},
        validatorVersion: "test",
        createdAt: clock.now()
      }
    };
  }

  function activationFrom(value: JsonValue): { activate?: boolean; reasons?: string[] } {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
    const activation = record.programActivation && typeof record.programActivation === "object" && !Array.isArray(record.programActivation)
      ? record.programActivation as Record<string, JsonValue>
      : {};
    return {
      activate: typeof activation.activate === "boolean" ? activation.activate : undefined,
      reasons: Array.isArray(activation.reasons) ? activation.reasons.filter((item): item is string => typeof item === "string") : undefined
    };
  }
});
