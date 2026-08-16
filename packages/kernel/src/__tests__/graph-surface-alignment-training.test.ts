import { describe, expect, it } from "vitest";
import {
  compileLanguageConstructionPattern,
  createHasher,
  createIdFactory,
  createClock,
  hydrateLanguageConstructionPatterns,
  induceSourceBoundConstructionTrainingSets
} from "../index.js";
import type { EvidenceSpan, SourceVersionId } from "../index.js";

describe("graph-surface alignment -> real corpus-training constructionSets wiring", () => {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 92_000, stepMs: 1 });
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "graph-surface-training" });

  it("produces real SourceBoundConstructionObservations that compile and hydrate into durable learned constructions", () => {
    const text = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
      "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
    ].join(" ");
    const evidence = evidenceSpan("source.univ", text, 0);

    const sets = induceSourceBoundConstructionTrainingSets({
      evidence: [evidence],
      profileId: "profile.univ",
      hasher
    });

    expect(sets.length).toBeGreaterThan(0);
    // Unsupervised graph-bound construction discovery over this tiny,
    // maximally-repetitive fixture (only 5 distinct words total) finds
    // several candidate "predicates" -- not just the real verb "chased",
    // but also "cat"/"dog"/"ball"/"mouse" themselves, since from pure
    // corpus statistics any frequent content word is a plausible anchor.
    // That ambiguity is real and expected; language-training-batch.ts's
    // real production caller resolves it downstream via
    // evaluateConstructionPromotion, never by blindly taking the first
    // candidate. This test is specifically about the transitive "X
    // chased Y" construction, so it selects the set the true predicate
    // must produce: by this fixture's own construction, "chased" appears
    // in every one of the 8 sentences while every noun appears in only
    // half, so the real relational construction is the one with the most
    // observations -- not whichever bindingId happened to be discovered
    // first.
    const set = sets.reduce((best, candidate) => candidate.observations.length > best.observations.length ? candidate : best);
    expect(set.observations.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(set.alignmentSummary)).toContain("scce.graph_surface_alignment.summary.v1");
    expect(JSON.stringify(set.alignmentSummary)).toContain("sparse_anchor_transport_v1");

    const compiled = compileLanguageConstructionPattern({
      bindingId: set.bindingId,
      profileId: "profile.univ",
      observations: set.observations,
      evidence: [evidence],
      hasher,
      updatedAt: 92_500
    });
    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") return;

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [compiled.pattern],
      evidence: [evidence],
      hasher
    });
    expect(hydrated.rejected).toEqual([]);
    expect(hydrated.bundles).toHaveLength(1);
    expect(hydrated.bundles[0]?.bindingId).toBe(set.bindingId);
    expect(hydrated.constructions.length).toBeGreaterThan(0);
    const agentFormClass = hydrated.formClasses.find(formClass =>
      formClass.constructionId === hydrated.constructions[0]!.id
    );
    expect(agentFormClass).toBeDefined();
    expect(agentFormClass!.variants.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fabricate observations from unpromoted (quarantined) evidence", () => {
    const text = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball."
    ].join(" ");
    const evidence = { ...evidenceSpan("source.quarantined", text, 0), status: "quarantined" as const };

    const sets = induceSourceBoundConstructionTrainingSets({
      evidence: [evidence],
      profileId: "profile.univ",
      hasher
    });

    expect(sets).toEqual([]);
  });

  it("keeps induced observation sets within the construction compiler's 256-example contract", () => {
    const text = Array.from(
      { length: 320 },
      (_, index) => `${index % 2 ? "dog" : "cat"} chased ${index % 3 ? "mouse" : "ball"}.`
    ).join(" ");
    const evidence = evidenceSpan("source.frequent", text, 0);

    const sets = induceSourceBoundConstructionTrainingSets({
      evidence: [evidence],
      profileId: "profile.univ",
      hasher,
      maxObservationsPerConstruction: 512
    });

    expect(sets.length).toBeGreaterThan(0);
    expect(Math.max(...sets.map(set => set.observations.length))).toBeLessThanOrEqual(256);
    const compiled = compileLanguageConstructionPattern({
      bindingId: sets[0]!.bindingId,
      profileId: "profile.univ",
      observations: sets[0]!.observations,
      evidence: [evidence],
      hasher,
      updatedAt: 92_500
    });
    expect(compiled.status).toBe("compiled");
  });

  function evidenceSpan(sourceVersionId: string, text: string, charStart: number): EvidenceSpan {
    const bytes = new TextEncoder().encode(text);
    const contentHash = ids.contentHash(bytes);
    const sourceId = ids.sourceId("fixture", `fixture://${sourceVersionId}`);
    return {
      id: ids.evidenceId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash: contentHash }),
      sourceId,
      sourceVersionId: sourceVersionId as SourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: contentHash }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: bytes.byteLength,
      charStart,
      charEnd: charStart + [...text].length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { forceClass: "profile_excerpt_evidence" },
      provenance: {},
      features: [],
      status: "promoted",
      alpha: 0.9,
      observedAt: 92_000
    };
  }
});
