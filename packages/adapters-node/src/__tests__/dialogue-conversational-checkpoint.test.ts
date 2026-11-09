// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as kernel from "@scce/kernel";
import type { EvidenceSpan, InformationLabel, IngestionCheckpoint, LanguagePatternProjection, ScceStorage, SourceVersion, LanguageIdentityRecord, LanguageProfileSignatureRow } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { requestSeedLanguagePattern } from "../../../kernel/src/request-language-hydration.js";
import { trainDialogueCorpus } from "../dialogue-corpus.js";
import { DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID, DIALOGUE_CONVERSATIONAL_CHECKPOINT_SCHEMA, conversationalCheckpointSources, prepareDialogueSourceComponentBinding } from "../dialogue-conversational-checkpoint.js";

const old = JSON.parse(readFileSync(new URL("./fixtures/conversation-multiline-old-empty.json", import.meta.url), "utf8"));
const label: InformationLabel = { tenantId: "owner.tenant", principals: ["owner.principal"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function fixture() {
  const evidence: EvidenceSpan[] = [], versions: SourceVersion[] = [], checkpoints = new Map<string, IngestionCheckpoint>();
  const base = storageFixtureForEvaluation({ evidence, clockNow: () => 0 }), storage = base.storage;
  let identities: LanguageIdentityRecord[] = [];
  const signatures = new Map<string, LanguageProfileSignatureRow>(), assignments = new Map<string, string>();
  const discover = vi.fn(async ({ afterId = "", limit }: { afterId?: string; limit: number }) => [...signatures.values()].filter(row => row.id > afterId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit));
  storage.languageIdentities = { putIdentities: async rows => { identities = [...rows]; }, replaceIdentities: async rows => { identities = [...rows]; },
    listIdentities: async () => identities, putProfileSignatures: async input => { for (const row of input.rows) signatures.set(row.id, row); }, listProfileSignatures: discover,
    assignProfileLanguages: async rows => { for (const row of rows) assignments.set(row.profileId, row.languageId); },
    listProfileLanguages: async query => [...assignments].filter(([id]) => !query || query.profileIds.includes(id)).map(([profileId, languageId]) => ({ profileId, languageId })) };
  const projections = new Map<string, LanguagePatternProjection>();
  const key = (p: Omit<LanguagePatternProjection, "patternIds">) => kernel.canonicalStringify([p.informationLabel, p.sourceId, p.sourceSystem, p.patternSchema, p.componentRecipe]);
  const putSpan = async (span: EvidenceSpan) => { const index = evidence.findIndex(row => row.id === span.id); if (index < 0) evidence.push(span); else evidence[index] = span; };
  storage.evidence.putSourceVersion = async row => { versions.push(row); };
  storage.evidence.putEvidenceSpan = putSpan;
  storage.evidence.putEvidenceSpans = async rows => { for (const row of rows) await putSpan(row); };
  storage.evidence.searchEvidence = async query => evidence.filter(span => (!query.sourceVersionId || span.sourceVersionId === query.sourceVersionId)
    && (!query.status || span.status === query.status)).map(span => ({ span, score: 1, reason: "exact source owner" }));
  storage.ingestion = { put: async row => { checkpoints.set(row.id, structuredClone(row)); }, get: async id => checkpoints.get(id) ?? null,
    list: async () => [...checkpoints.values()] } as ScceStorage["ingestion"];
  storage.languageMemory.replaceLanguagePatternProjection = async input => {
    for (const pattern of input.patterns) {
      expect(object(pattern.patternJson).sourceSystem).toBe(input.projection.sourceSystem);
      await storage.languageMemory.putLanguagePattern(pattern);
    }
    projections.set(key(input.projection), structuredClone(input.projection));
  };
  storage.languageMemory.getLanguagePatternProjection = async query => {
    const row = projections.get(key(query));
    if (!row || row.profileId !== query.profileId || row.sourceVersionId !== query.sourceVersionId) return undefined;
    if (query.sourceCompilationId) {
      const patterns = await storage.languageMemory.listLanguagePatterns({ profileIds: [query.profileId], patternSchemas: [query.patternSchema] });
      const ids = patterns.filter(pattern => object(pattern.patternJson).sourceCompilationId === query.sourceCompilationId).map(pattern => pattern.id).sort();
      if (kernel.canonicalStringify(ids) !== kernel.canonicalStringify(row.patternIds)) return undefined;
    }
    return structuredClone(row);
  };
  const list = storage.languageMemory.listLanguagePatterns.bind(storage.languageMemory);
  storage.languageMemory.listLanguagePatterns = async query => (await list(query)).map(pattern => query?.view === "request_seed" ? requestSeedLanguagePattern(pattern) : pattern);
  return { ...base, storage, evidence, versions, checkpoints, projections, assignments, discover };
}

describe("cached-source conversational component replay", () => {
  it.each(["old empty", "missing"])("upgrades genuine old multiline output once without source recompilation: %s", async mode => {
    expect(old.generatedFromRevision).toBe("bac281aa");
    expect(old.authorship).toBe("test_authored");
    expect(old.capturedInduction).toMatchObject({ adjacentPairs: 3, recurringFrames: 0, observations: 0, sets: [] });
    const root = await mkdtemp(path.join(tmpdir(), "dialogue-multi-upgrade-")), f = fixture();
    for (const [index, source] of old.sources.entries()) await writeFile(path.join(root, `${index}.json`), JSON.stringify(source));
    const options = { storage: f.storage, rootPath: root, authorship: "human_authored" as const, informationLabel: label,
      ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64, maxFilesPerRun: 3 };
    const compiler = vi.spyOn(kernel, "compileLanguageTrainingBatch"), induce = vi.spyOn(kernel, "induceConversationalActConstructionTrainingSets");
    const writer = f.storage.languageMemory as ScceStorage["languageMemory"] & {
      replaceLanguagePatternProjection: NonNullable<ScceStorage["languageMemory"]["replaceLanguagePatternProjection"]>;
    };
    const publish = vi.spyOn(writer, "replaceLanguagePatternProjection");
    try {
      const first = await trainDialogueCorpus(options);
      expect(first.filesSkipped).toEqual([]);
      expect(f.assignments.size).toBe(3);
      const discoveryReads = f.discover.mock.calls.length;
      expect(first.conversationalConstructions.bundles.some(bundle => bundle.constructions > bundle.oneSlotConstructions)).toBe(true);
      const receipt = [...f.checkpoints.values()].find(row => row.id.startsWith("dialogue_conversational_compilation_"))!;
      expect(receipt).toBeDefined();
      // Install the captured producer's empty auxiliary result; immutable source checkpoints remain genuine/current.
      for (const [key, projection] of f.projections) if (projection.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID) f.projections.delete(key);
      if (mode === "missing") f.checkpoints.delete(receipt.id);
      else f.checkpoints.set(receipt.id, { ...receipt, metadata: kernel.toJsonValue({ ...object(receipt.metadata),
        compilerFingerprint: "scce.dialogue_conversational_construction.v1", projections: [], capturedInduction: old.capturedInduction }) });
      const sourceState = structuredClone({ versions: f.versions, evidence: f.evidence, events: f.events,
        profiles: await f.storage.model.listLanguageProfiles(), models: await f.storage.languageMemory.listNgramModels(),
        sourceCheckpoints: [...f.checkpoints.values()].filter(row => !row.id.startsWith("dialogue_conversational_compilation_")) });
      compiler.mockClear(); induce.mockClear(); publish.mockClear();
      const upgraded = await trainDialogueCorpus(options);
      expect(upgraded.filesSkipped).toEqual([]);
      expect(upgraded.reports).toEqual(first.reports);
      expect(upgraded.conversationalConstructions.patternsPersisted).toBeGreaterThan(0);
      expect(compiler).not.toHaveBeenCalled(); expect(induce).toHaveBeenCalledTimes(1);
      expect(f.discover).toHaveBeenCalledTimes(discoveryReads);
      expect(publish).toHaveBeenCalled();
      const auxiliary = [...f.projections.values()].filter(row => row.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID);
      expect(auxiliary).toHaveLength(1);
      expect(object(auxiliary[0]).sourceDependencies).toHaveLength(upgraded.conversationalConstructions.bundles[0]!.sourceVersionIds);
      const after = { versions: f.versions, evidence: f.evidence, events: f.events, profiles: await f.storage.model.listLanguageProfiles(),
        models: await f.storage.languageMemory.listNgramModels(), sourceCheckpoints: [...f.checkpoints.values()].filter(row => !row.id.startsWith("dialogue_conversational_compilation_")) };
      expect(after).toEqual(sourceState);
      induce.mockClear(); publish.mockClear();
      const replay = await trainDialogueCorpus(options);
      expect(replay.conversationalConstructions.patternsPersisted).toBe(0);
      expect(compiler).not.toHaveBeenCalled(); expect(induce).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
      const savedAuxiliary = structuredClone(auxiliary);
      await trainDialogueCorpus({ ...options, maxFilesPerRun: 1 });
      expect(publish).not.toHaveBeenCalled();
      expect([...f.projections.values()].filter(row => row.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID)).toEqual(savedAuxiliary);
      induce.mockClear();
      // A recipe receipt cannot conceal a missing or superseded active publication.
      for (const [key, projection] of f.projections) if (projection.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID) f.projections.delete(key);
      await trainDialogueCorpus(options);
      expect(compiler).not.toHaveBeenCalled(); expect(induce).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalled();
    } finally { compiler.mockRestore(); induce.mockRestore(); publish.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

it("keeps genuine sixteen-pair compiler payload hashes exact while its conversational receipt retains only transcript digests", async () => {
  const source = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-sixteen-pairs.json", import.meta.url), "utf8")) as kernel.DeclaredTranscriptSource;
  expect(kernel.validateDeclaredTranscriptSource(source).turns).toHaveLength(32);
  expect(source.sourceMetadata?.originalJsonlSha256).toBe("2df9083338b4abd6bceb5635764dab5d833b393b55759dffb0959b6fcbf794ec");
  expect(source.sourceMetadata?.preparationManifestSha256).toBe("5127794bae91db70a325ff7529c5a8a1fc8ae788a1e89842483c6ca989c7c9cb");
  expect(new Set(source.turns.map(turn => turn.sourceRecordId)).size).toBe(16);
  const root = await mkdtemp(path.join(tmpdir(), "dialogue-genuine-checkpoint-")), f = fixture();
  await writeFile(path.join(root, "human.json"), JSON.stringify(source));
  const now = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  const compiler = vi.spyOn(kernel, "compileLanguageTrainingBatch"), induce = vi.spyOn(kernel, "induceConversationalActConstructionTrainingSets");
  const hasher = kernel.createHasher();
  const artifactHash = async () => hasher.digestHex(kernel.canonicalStringify({ versions: f.versions, evidence: f.evidence, events: f.events,
    profiles: await f.storage.model.listLanguageProfiles(), models: await f.storage.languageMemory.listNgramModels(),
    patterns: [...await f.storage.languageMemory.listLanguagePatterns(), ...await f.storage.languageMemory.listLanguagePatterns({ patternKind: "source_compilation" })],
    projections: [...f.projections.values()] }));
  const options = { storage: f.storage, rootPath: root, informationLabel: label, authorship: "human_authored" as const,
    ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128 };
  try {
    const first = await trainDialogueCorpus(options);
    expect(first.filesSkipped).toEqual([]); expect(first.filesTrained).toBe(1); expect(compiler).toHaveBeenCalledTimes(1);
    const receipt = [...f.checkpoints.values()].find(row => row.id.startsWith("dialogue_conversational_compilation_"))!;
    expect(object(receipt.metadata).schema).toBe(DIALOGUE_CONVERSATIONAL_CHECKPOINT_SCHEMA);
    const binding = object(receipt.metadata).binding;
    if (typeof binding !== "string") throw Error("missing exact checkpoint binding");
    const parsed = JSON.parse(binding) as { sources: Array<{ transcriptDigest: string; transcriptTurns?: unknown }> };
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]!.transcriptDigest).toBe(hasher.digestHex(kernel.canonicalStringify(source.turns)));
    expect(parsed.sources[0]!).not.toHaveProperty("transcriptTurns");
    expect(binding).not.toContain(source.turns[0]!.surface);
    expect(Buffer.byteLength(binding)).toBeLessThan(2048);
    const outputHash = await artifactHash(), inductionHash = hasher.digestHex(kernel.canonicalStringify(induce.mock.results.at(-1)!.value));
    f.checkpoints.delete(receipt.id); compiler.mockClear(); induce.mockClear();
    const rebuilt = await trainDialogueCorpus(options);
    expect(rebuilt.reports).toEqual(first.reports); expect(compiler).not.toHaveBeenCalled(); expect(induce).toHaveBeenCalledTimes(1);
    expect(hasher.digestHex(kernel.canonicalStringify(induce.mock.results[0]!.value))).toBe(inductionHash);
    expect(await artifactHash()).toBe(outputHash);
    expect(f.checkpoints.has(receipt.id)).toBe(true);
    induce.mockClear(); const write = vi.spyOn(f.storage.ingestion, "put");
    await trainDialogueCorpus(options);
    expect(induce).not.toHaveBeenCalled(); expect(compiler).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(await artifactHash()).toBe(outputHash);
  } finally { compiler.mockRestore(); induce.mockRestore(); now.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it("formats all 128 actual Dolly source headers without retaining the 15,011-pair source payload again", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/dolly-checkpoint-128-headers.json", import.meta.url), "utf8")) as {
    fileCount: number; turnCount: number; pairCount: number; textBytes: number; preparedFileInventoryDigest: string;
    sourceMetadata: { originalJsonlSha256: string; preparationManifestSha256: string }; preparedFileInventoryDigestContract: string;
    envelope: { rootUri: string; informationLabel: InformationLabel; authorship: string };
    headers: Array<{ sourceUri: string; sourceVersionId: string; contentHash: string; byteLength: number; transcriptDigest: string }>;
    compactBindingBytes: number; compactBindingSha256: string; expandedBindingBytes: number; expandedBindingSha256: string;
  };
  expect(fixture.sourceMetadata.originalJsonlSha256).toBe("2df9083338b4abd6bceb5635764dab5d833b393b55759dffb0959b6fcbf794ec");
  expect(fixture.sourceMetadata.preparationManifestSha256).toBe("5127794bae91db70a325ff7529c5a8a1fc8ae788a1e89842483c6ca989c7c9cb");
  expect(fixture.preparedFileInventoryDigestContract).toBe("sha256(canonical JSON of sorted [relative transcript filename, sha256(exact prepared file bytes)] pairs)");
  expect(fixture.headers.every(source => source.sourceUri.startsWith("fixture://dolly15k/"))).toBe(true);
  expect(fixture.fileCount).toBe(128); expect(fixture.turnCount).toBe(30022); expect(fixture.pairCount).toBe(15011);
  expect(fixture.headers).toHaveLength(128); expect(new Set(fixture.headers.map(row => row.sourceVersionId)).size).toBe(128);
  expect(fixture.headers.reduce((sum, source) => sum + source.byteLength, 0)).toBe(11812929);
  expect(fixture.preparedFileInventoryDigest).toBe("83d84e29d13089f84746b92dbc648bef53924b0b40a4b138adc638d68ef5aa34");
  const { binding, byteLength } = prepareDialogueSourceComponentBinding({ ...fixture.envelope, sources: fixture.headers });
  expect(byteLength).toBe(fixture.textBytes);
  expect(Buffer.byteLength(binding)).toBe(fixture.compactBindingBytes);
  expect(kernel.createHasher().digestHex(binding)).toBe(fixture.compactBindingSha256);
  expect(fixture.expandedBindingBytes).toBe(21018271); expect(fixture.compactBindingBytes).toBe(42854);
  expect(binding).not.toContain("transcriptTurns"); expect(binding).not.toContain('"surface":');
  const declared = kernel.validateDeclaredTranscriptSource(JSON.parse(readFileSync(new URL("./fixtures/dolly-human-sixteen-pairs.json", import.meta.url), "utf8")));
  const source = { sourceUri: "fixture://binding", sourceVersionId: "source-version", contentHash: "a".repeat(64), byteLength: Buffer.byteLength(declared.text) };
  const a = conversationalCheckpointSources([{ ...source, transcriptTurns: declared.turns }]);
  const changed = structuredClone(declared.turns); changed[0]!.sourceRecordId += ".changed";
  expect(conversationalCheckpointSources([{ ...source, transcriptTurns: changed }])[0]!.transcriptDigest).not.toBe(a[0]!.transcriptDigest);
  expect(conversationalCheckpointSources([source])[0]!.transcriptDigest).not.toBe(conversationalCheckpointSources([{ ...source, transcriptTurns: [] }])[0]!.transcriptDigest);
});
