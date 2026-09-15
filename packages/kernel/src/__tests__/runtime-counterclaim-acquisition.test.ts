import { describe, expect, it } from "vitest";
import { createRuntimeAcquisition } from "../runtime-acquisition.js";
import { createEventFactory } from "../events.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { ScceKernelDeps } from "../storage.js";
import type { EpisodeId, IngestInput, IngestResult, ScceEvent } from "../types.js";

function fixture() {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1000, stepMs: 1 });
  const idFactory = createIdFactory({ clock, hasher });
  const eventFactory = createEventFactory({ clock, hasher, idFactory });
  const episodeId = "episode.counterclaim" as EpisodeId;
  const queries: string[] = [];
  const ingests: IngestInput[] = [];
  const events: ScceEvent[] = [];
  const deps = {
    storage: {},
    approvals: { isApproved: () => true },
    connectors: {
      search: async (query: string) => {
        queries.push(query);
        const indices = queries.length === 1 ? [1, 2, 3, 4] : [5];
        return indices.map(index => ({ uri: `https://source${index}.example/paper`, title: `πηγή ${index}`, snippet: `μαρτυρία ${index}`, metadata: {} }));
      },
      fetch: async (uri: string) => ({
        uri,
        bytes: new TextEncoder().encode(uri),
        mediaType: "text/plain",
        metadata: { extractor: "fixture", structure: { sheets: [] }, typedExtraction: { workbook: { sheets: [] } } }
      })
    }
  } as unknown as ScceKernelDeps;
  const acquisition = createRuntimeAcquisition({
    deps, eventFactory, hasher, failures: [], now: clock.now,
    append: async event => event,
    ingest: async input => {
      ingests.push(input);
      return { sources: 1, evidence: 1, promotedEvidenceIds: [`evidence.${ingests.length}`], events: [eventFactory.create({ episodeId, typeId: "SourcePromoted", payload: {} })] } as IngestResult;
    }
  });
  return { acquisition, episodeId, queries, ingests, events, hasher };
}

describe("counterclaim acquisition boundary", () => {
  it("executes a distinct fifth-source query through canonical ingestion and preserves hashed intent receipts", async () => {
    const f = fixture();
    const originalQuery = "α β γ";
    const querySurface = "!α β γ";
    const motion = await f.acquisition.learnHydrateReplan({
      ownerInput: { text: originalQuery }, episodeId: f.episodeId, requestedAuthority: "reasoned", trigger: "coherence_support_failure", events: f.events,
      adversarialSearch: {
        searchKind: "counterclaim", querySurface, intentId: "intent.甲", claimHash: "claim.hash",
        originalQueryHash: f.hasher.digestHex(originalQuery), targetLanguageId: "language.乙",
        realizationAudit: { accepted: true, oppositePolarityPreserved: true }
      }
    });
    expect(f.queries).toEqual([originalQuery, querySurface]);
    expect(f.ingests).toHaveLength(5);
    expect(motion.ingestedEvidenceIds).toEqual(["evidence.1", "evidence.2", "evidence.3", "evidence.4", "evidence.5"]);
    expect(motion.adversarialSearch).toMatchObject({
      searchKind: "counterclaim", attempted: true, intentId: "intent.甲", claimHash: "claim.hash",
      originalQueryHash: motion.queryHash, querySurfaceHash: f.hasher.digestHex(querySurface),
      targetLanguageId: "language.乙", ingestedSourceCount: 1, ingestedEvidenceCount: 1,
      sourceUris: ["https://source5.example/paper"]
    });
    expect(motion.adversarialSearch?.querySurfaceHash).not.toBe(motion.queryHash);
    expect(f.ingests[4]?.metadata).toMatchObject({ acquisition: { phase: "adversarial" } });
    expect(f.ingests[0]?.metadata).toMatchObject({
      extractor: "fixture",
      structure: { sheets: [] },
      typedExtraction: { workbook: { sheets: [] } }
    });
    expect(JSON.stringify(motion.adversarialSearch)).not.toContain(querySurface);
  });

  it("does not relabel a whitespace/case variant of the primary query as an adversarial search", async () => {
    const f = fixture();
    const motion = await f.acquisition.learnHydrateReplan({
      ownerInput: { text: "α β γ" }, episodeId: f.episodeId, requestedAuthority: "reasoned", trigger: "coherence_support_failure", events: f.events,
      adversarialSearch: { searchKind: "counterclaim", querySurface: " Α   Β Γ " }
    });
    expect(f.queries).toEqual(["α β γ"]);
    expect(f.ingests).toHaveLength(4);
    expect(motion.adversarialSearch).toMatchObject({ attempted: false, failures: ["counterclaim.query_echo"], ingestedEvidenceCount: 0 });
  });
});
