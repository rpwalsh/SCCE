// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeGraphRetrieval } from "../runtime-graph-retrieval.js";
import { createClock, createHasher } from "../primitives.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import type { EvidenceSearchResult, ScceKernelDeps } from "../storage.js";
import type { GraphSlice, GraphSliceQuery } from "../types.js";

function retrievalFixture() {
  const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
  const getSlice = vi.fn(async (_query: GraphSliceQuery) => graph);
  const getEvidenceBatch = vi.fn(async () => []);
  const searchEvidence = vi.fn(async (): Promise<EvidenceSearchResult[]> => []);
  const kernelTrace = vi.fn();
  const storage = { graph: { getSlice }, evidence: { getEvidenceBatch, searchEvidence } } as unknown as ScceKernelDeps["storage"];
  const runtime = createRuntimeGraphRetrieval({
    deps: { storage },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures: [] as string[],
    cacheMs: 60_000,
    kernelTrace,
    sourceAnchorSemanticFramesCached: async () => []
  });
  return { runtime, kernelTrace };
}

async function anchorFeatureGroups(text: string): Promise<string[][]> {
  const fixture = retrievalFixture();
  await fixture.runtime.graphForText(text, { sourceAnchoringRequired: true, residentOnly: true });
  const event = fixture.kernelTrace.mock.calls
    .map(call => call[0] as { stage?: string; support?: { anchorFeatureGroups?: string[][] } })
    .find(candidate => candidate.stage === "graph.resolve.anchor_evidence_search");
  return event?.support?.anchorFeatureGroups ?? [];
}

describe("qualifier pairs in source-anchor retrieval", () => {
  afterEach(() => clearCorpusIdentitySignals());

  it("searches a named identity's qualifier bound to its subject, not the bare subject alone", async () => {
    // The corpus is titled "Apollo 11" and also "Apollo": the subject symbol alone cannot tell them apart, and
    // the pair is bounded by its rarer unit. Measured live before this: the request seeded anchor:sym:apollo and
    // answered from the Greek god's article.
    primeCorpusIdentitySignals({
      closedClass: new Set(["the", "in", "a", "of", "and", "to", "is", "was", "did", "on", "which", "when", "who"]),
      identities: new Set(["apollo 11", "apollo"]),
      spread: new Map(),
      concentration: 1
    });

    const groups = await anchorFeatureGroups("When did Apollo 11 land on the Moon?");
    const features = groups.flat();

    expect(features).toContain("anchor:bi:apollo|11");
    // Bound to the subject, never in place of it: the group still seeds as it did.
    expect(features).toContain("anchor:sym:apollo");
  });

  it("does not bind a split fragment of one unit as a qualifier", async () => {
    primeCorpusIdentitySignals({
      closedClass: new Set(["the", "in", "a", "of", "and", "to", "is", "was", "who"]),
      identities: new Set(["aristotle"]),
      spread: new Map(),
      concentration: 1
    });

    const features = (await anchorFeatureGroups("Who was Aristotle's teacher?")).flat();

    // "aristotle's" splits to aristotle|s; a one-character run narrows no posting list.
    expect(features).not.toContain("anchor:bi:aristotle|s");
    expect(features).toContain("anchor:sym:aristotle");
  });
});
