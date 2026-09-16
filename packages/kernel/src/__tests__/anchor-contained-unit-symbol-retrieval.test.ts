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

describe("a concentrated unit swallowed by its containing run still reaches a query", () => {
  afterEach(() => clearCorpusIdentitySignals());

  it("searches the identifier's own symbol when the named run contains it", async () => {
    // Measured on the live corpus 2026-09-16. "file defines bestevidencesentences" is carried by one source, so it
    // is concentrated, names the request, and swallows "bestevidencesentences" by containment. Every surviving
    // feature is then a bigram: anchor:bi:file|defines carries 17 postings and none in the defining file, while
    // anchor:sym:bestevidencesentences carries 69, sixteen of them in packages/kernel/src/local-evidence-runtime.ts.
    primeCorpusIdentitySignals({
      closedClass: new Set(["which"]),
      identities: new Set<string>(),
      spread: new Map([
        ["file defines bestevidencesentences", 1],
        ["file", 960],
        ["defines", 181],
        ["bestevidencesentences", 12]
      ]),
      concentration: 289
    });

    const features = (await anchorFeatureGroups("Which file defines bestEvidenceSentences?")).flat();

    expect(features).toContain("anchor:sym:bestevidencesentences");
    // Carried by the phrase group it rescues, never a query of its own: the phrase still leads.
    expect(features).toContain("anchor:bi:defines|bestevidencesentences");
  });

  it("carries only the rarest unit, not every unit the corpus concentrates", async () => {
    // "file" sits in 960 of the corpus's sources against an Otsu split of 289, and its symbol carries 4,186
    // postings -- past the cap that decides what may seed at all. "defines" is under the split at 181 sources and
    // still wrong: its 479 postings put 91 opening blocks in the same candidate set, and the opening-block prior
    // ranks ahead of the score, so the defining file left the 64-row limit entirely (measured 2026-09-16).
    primeCorpusIdentitySignals({
      closedClass: new Set(["which"]),
      identities: new Set<string>(),
      spread: new Map([
        ["file defines bestevidencesentences", 1],
        ["file", 960],
        ["defines", 181],
        ["bestevidencesentences", 12]
      ]),
      concentration: 289
    });

    const features = (await anchorFeatureGroups("Which file defines bestEvidenceSentences?")).flat();

    expect(features).not.toContain("anchor:sym:file");
    expect(features).not.toContain("anchor:sym:defines");
  });

  it("adds nothing to a group whose units are already searched on their own", async () => {
    // "albania" survives containment and leads its own anchor group; "capital" is over the concentration split and
    // already has the group the concept pass gives it. Both phrase groups stay exactly as they were.
    primeCorpusIdentitySignals({
      closedClass: new Set(["what", "is", "the", "of"]),
      identities: new Set(["albania"]),
      spread: new Map([["capital", 886], ["albania", 99], ["capital albania", 9]]),
      concentration: 289
    });

    const groups = await anchorFeatureGroups("What is the capital of Albania?");

    expect(groups.find(group => group[0] === "anchor:bi:capital|albania")).toEqual(["anchor:bi:capital|albania"]);
  });
});
