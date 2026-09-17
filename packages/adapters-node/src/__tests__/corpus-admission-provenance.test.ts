// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { trainLanguageCorpusText } from "../language-corpus-trainer.js";
import { createHasher } from "@scce/kernel";
import type {
  EvidenceSpan,
  JsonValue,
  LanguagePatternRecord,
  LanguageProfile,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  ScceEvent,
  ScceStorage,
  SemanticFrameRecord,
  SourceVersion
} from "@scce/kernel";

interface QuarantineRecord {
  sourceVersionId: string;
  decision: string;
  decisionJson: JsonValue;
  permissionVector: JsonValue;
}

interface MemoryState {
  events: ScceEvent[];
  sourceVersions: SourceVersion[];
  evidence: EvidenceSpan[];
  quarantine: QuarantineRecord[];
  blobs: Map<string, Uint8Array>;
}

const OSS_INFORMATION_LABEL = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public" as const,
  mergePolicy: "same_owner" as const
};

/** Long enough to clear the stored-corpus lane's 2000-byte article floor and to induce more than one chunk. */
function corpusText(subject: string): string {
  const sentence = `The ${subject} module resolves a declared symbol to the file that declares it, and the resolver records the span it read. `;
  return sentence.repeat(40);
}

function provenanceOf(span: EvidenceSpan): Record<string, JsonValue> {
  const value = span.provenance;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

describe("corpus trainer admission and provenance", () => {
  it("records an admission decision for every corpus source version it promotes", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "oss_code",
      streamUri: "oss_code:packages/kernel/src/resolver.ts",
      sourceUri: "repo://example/repo@abc123#path=packages/kernel/src/resolver.ts",
      text: corpusText("resolver"),
      mediaType: "text/x-typescript",
      informationLabel: OSS_INFORMATION_LABEL,
      corpusMetadata: { title: "resolver.ts", identity: "resolver", relativePath: "packages/kernel/src/resolver.ts" }
    });

    expect(fixture.state.evidence.length).toBeGreaterThan(0);
    // Law 1: a promoted span must carry a decision that was actually taken, not the absence of one.
    expect(fixture.state.quarantine.map(row => row.sourceVersionId))
      .toEqual(fixture.state.sourceVersions.map(row => String(row.sourceVersionId)));
    expect(fixture.state.quarantine[0]?.decision).toBe("promoted");
    expect(fixture.state.evidence.every(span => span.status === "promoted")).toBe(true);
  });

  it("names the corpus a span came from instead of labelling every lane construction_training", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "oss_code",
      streamUri: "oss_code:packages/kernel/src/resolver.ts",
      sourceUri: "repo://example/repo@abc123#path=packages/kernel/src/resolver.ts",
      text: corpusText("resolver"),
      mediaType: "text/x-typescript",
      informationLabel: OSS_INFORMATION_LABEL,
      corpusMetadata: { title: "resolver.ts", identity: "resolver" }
    });

    const kinds = new Set(fixture.state.evidence.map(span => provenanceOf(span).sourceKind));
    expect(kinds).not.toContain("construction_training");
    expect(kinds).toEqual(new Set(["developer_intelligence"]));
  });

  it("refuses to promote a corpus whose admission context is unmeasured, and records that state", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "an-undeclared-corpus",
      streamUri: "an-undeclared-corpus:doc/1",
      sourceUri: "scce://undeclared/doc/1",
      text: corpusText("undeclared"),
      mediaType: "text/plain",
      informationLabel: OSS_INFORMATION_LABEL
    });

    // Unmeasured is neither a refusal nor a promotion: the state is written, and it is not "promoted".
    expect(fixture.state.evidence.length).toBeGreaterThan(0);
    expect(fixture.state.evidence.every(span => span.status === "promoted")).toBe(false);
    expect(fixture.state.quarantine[0]?.decision).toBe("pending");
    expect(JSON.stringify(fixture.state.quarantine[0]?.decisionJson)).toContain("unmeasured");
  });

});

function seedStoredArticle(state: MemoryState, uri: string, text: string): { sourceVersionId: string; contentHash: string } {
  const hasher = createHasher();
  const bytes = Buffer.from(text, "utf8");
  const contentHash = hasher.digestHex(bytes);
  const sourceVersionId = `source_version.${hasher.digestHex(Buffer.from(uri, "utf8")).slice(0, 24)}`;
  state.blobs.set(contentHash, bytes);
  state.sourceVersions.push({
    sourceId: `source.${sourceVersionId}`,
    sourceVersionId,
    namespace: "corpus:wikipedia",
    canonicalUri: uri,
    contentHash,
    mediaType: "text/plain",
    observedAt: 1,
    byteLength: bytes.byteLength,
    sourceTrust: {
      identity: 0.98, integrity: 1, parserReliability: 0.92, directness: 0.84,
      authority: 0.88, freshness: 0.68, independenceGroup: "wikimedia:wikipedia",
      accessScope: "public", licenseStatus: "licensed"
    },
    informationLabel: OSS_INFORMATION_LABEL,
    metadata: { title: uri }
  } as unknown as SourceVersion);
  return { sourceVersionId, contentHash };
}

function memoryStorage(): { storage: ScceStorage; state: MemoryState } {
  const state: MemoryState = { events: [], sourceVersions: [], evidence: [], quarantine: [], blobs: new Map() };
  const hasher = createHasher();
  const seeded = new Set<string>();
  const storage = {
    events: {
      append: async (event: ScceEvent) => { state.events.push(event); },
      appendBatch: async (events: ScceEvent[]) => { state.events.push(...events); },
      readEpisode: async () => state.events,
      readRange: async () => state.events,
      latestLedgerHash: async () => state.events.at(-1)?.hash ?? ""
    },
    evidence: {
      putSourceVersion: async (source: SourceVersion) => { state.sourceVersions.push(source); },
      putEvidenceSpan: async (span: EvidenceSpan) => { state.evidence.push(span); },
      putEvidenceSpans: async (spans: readonly EvidenceSpan[]) => { state.evidence.push(...spans); },
      promoteEvidence: async (ids: EvidenceSpan["id"][]) => ids.length,
      getEvidence: async () => null,
      getEvidenceBatch: async () => [],
      searchEvidence: async () => [],
      sourceVersionsForEvidence: async () => [],
      listEvidenceBackedSourceVersions: async () => state.sourceVersions
        .filter(row => seeded.has(String(row.sourceVersionId)) || state.blobs.has(String(row.contentHash)))
        .map(row => ({ sourceVersionId: row.sourceVersionId, contentHash: row.contentHash, byteLength: row.byteLength, canonicalUri: row.canonicalUri }))
    },
    blobs: {
      put: async (bytes: Uint8Array) => { const hash = hasher.digestHex(Buffer.from(bytes)); state.blobs.set(hash, bytes); return hash; },
      get: async (hash: string) => { const found = state.blobs.get(hash); if (!found) throw new Error(`no blob ${hash}`); return found; }
    },
    quarantine: {
      put: async (record: { sourceVersionId: string; decision: string; decisionJson: JsonValue; permissionVector: JsonValue }) => {
        state.quarantine.push({
          sourceVersionId: String(record.sourceVersionId),
          decision: record.decision,
          decisionJson: record.decisionJson,
          permissionVector: record.permissionVector
        });
      },
      get: async () => null,
      list: async () => [],
      decide: async () => undefined
    },
    model: {
      readModel: async () => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async (_profile: LanguageProfile) => undefined,
      listLanguageProfiles: async () => []
    },
    languageMemory: {
      putNgramObservation: async (_row: NgramObservation) => undefined,
      putNgramObservationsBatch: async (_rows: readonly NgramObservation[]) => undefined,
      putNgramModel: async (_row: NgramModelRecord) => undefined,
      putNgramModels: async (_rows: readonly NgramModelRecord[]) => undefined,
      putLanguageUnit: async (_row: LanguageUnitRecord) => undefined,
      putLanguageUnits: async (_rows: readonly LanguageUnitRecord[]) => undefined,
      putLanguagePattern: async (_row: LanguagePatternRecord) => undefined,
      putLanguagePatterns: async (_rows: readonly LanguagePatternRecord[]) => undefined,
      putSemanticFrame: async (_row: SemanticFrameRecord) => undefined,
      putSemanticFrames: async (_rows: readonly SemanticFrameRecord[]) => undefined,
      putTranslationAlignment: async () => undefined,
      listNgramModels: async () => [],
      listNgramObservations: async () => [],
      listLanguageUnits: async () => [],
      listLanguagePatterns: async () => [],
      listSemanticFrames: async () => [],
      listTranslationAlignments: async () => []
    },
    graph: { getSlice: async () => { throw new Error("no graph in this fixture"); } },
    init: async () => undefined,
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined
  } as unknown as ScceStorage;
  return { storage, state };
}
