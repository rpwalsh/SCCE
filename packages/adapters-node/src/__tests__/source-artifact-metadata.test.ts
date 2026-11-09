// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { canonicalDigestHex, createClock, createHasher, createIdFactory, sourceLanguageTrainingStreamId,
  stampSourceLanguageCompilation, toJsonValue, type InformationLabel, type JsonValue } from "@scce/kernel";
import { createSourceArtifactMetadataCodec, SOURCE_ARTIFACT_METADATA_KEY } from "../source-artifact-metadata.js";
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, durableJoinProgramJsonByteLengths } from "../durable-join-program-storage.js";
import type { CreativeEventStorageHost } from "../canonical-creative-event-store.js";

const hasher = createHasher(), label: InformationLabel = { tenantId: "owner", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
function fixture() {
  const text = "A public source records ? and ??.", ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "metadata" });
  const owner = { sourceId: ids.sourceId("fixture", "fixture://public-source"), sourceVersionId: ids.sourceVersionId(text), contentHash: ids.contentHash(text) };
  const metadata = { links: Array.from({ length: 120 }, (_, index) => ({ index, target: `source-${index}-` + "???".repeat(120) })),
    arbitraryNestedProvenance: { authors: ["Human author"], license: { name: "Public fixture" } },
    requirementTargets: { factual: 1 }, sourceIds: ["source-a", "source-b"], scalar: "kept", nullValue: null };
  Object.defineProperty(metadata, "constructor", { value: { sourceOwned: "opaque property" }, enumerable: true });
  const body = { ...metadata, profileId: "profile", sourceVersionId: owner.sourceVersionId, sourceSystem: "fixture", schema: "test.authored.learned.v1",
    joinProgram: { unrelatedLearnedValue: [2, 3] }, templates: [{ surface: "attested ?" }] };
  const streamId = sourceLanguageTrainingStreamId({ ...owner, sourceSystem: "fixture", hasher });
  const stamped = stampSourceLanguageCompilation({ owner, profileId: "profile", sourceSystem: "fixture", streamId, text, chunks: [text], inheritedMetadata: toJsonValue(metadata),
    options: { maxOrder: 1, maxCountersPerOrder: 100, vocabularyLimit: 100, languageOnly: false, retainNgramObservations: false }, hasher,
    models: [{ id: "model", streamId, languageHint: "und", maxOrder: 1, discount: 0.5, updatedAt: 1, modelJson: toJsonValue({ ...body, model: { learned: [1, 2] } }) }],
    artifacts: { units: [{ id: "unit", profileId: "profile", sourceVersionId: owner.sourceVersionId, script: "Latin", unitKind: "symbol", text: "?", features: ["opaque"], competenceVector: [1], alpha: 1, evidenceIds: [], metadata: toJsonValue(body) }],
      patterns: [{ id: "pattern", profileId: "profile", patternKind: "syntax", support: 1, entropy: 0, updatedAt: 1, evidenceIds: [], patternJson: toJsonValue(body) }],
      semanticFrames: [{ id: "frame", frameJson: toJsonValue(body), embedding: [], evidenceIds: [], alpha: 1, createdAt: 1 }] } });
  const receipt = stamped.patterns.find(pattern => pattern.patternKind === "source_compilation")!;
  const row = { id: receipt.id, profile_id: receipt.profileId, pattern_json: clone(object(receipt.patternJson)), information_label: label };
  const state = { accessible: true, row }, calls: Array<{ sql: string; params: unknown[] }> = [];
  const host: CreativeEventStorageHost = { table: name => `"fixture"."${name}"`, requireWritableInformationLabel: value => value ?? label,
    informationAccessPredicate: (alias, first) => ({ sql: `${alias}.information_label->>'tenantId'=$${first}`, params: [label.tenantId] }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return state.accessible && (params[0] as string[]).includes(state.row.id) ? [clone(state.row) as T] : []; } };
  const codec = createSourceArtifactMetadataCodec(host);
  const originals = [stamped.units[0]!.metadata, stamped.patterns[0]!.patternJson, stamped.semanticFrames[0]!.frameJson, stamped.models[0]!.modelJson];
  return { codec, originals, stamped, metadata, row, state, calls, host, owner };
}

describe("canonical source artifact metadata", () => {
  it("stores inherited objects once and reconstructs all four artifact families exactly", async () => {
    const f = fixture(), before = clone(f.originals);
    const encoded = await f.codec.encodeMany(f.originals.map(value => ({ value, informationLabel: label })));
    for (const [index, value] of encoded.entries()) {
      expect(JSON.stringify(value).length).toBeLessThan(JSON.stringify(f.originals[index]).length / 5);
      const stored = object(value);
      expect(stored.links).toBeUndefined(); expect(stored.arbitraryNestedProvenance).toBeUndefined();
      expect(stored.templates).toEqual(object(f.originals[index]).templates);
      expect(stored.joinProgram).toEqual(object(f.originals[index]).joinProgram);
      expect(stored.requirementTargets).toEqual(f.metadata.requirementTargets);
      expect(stored.sourceIds).toEqual(f.metadata.sourceIds);
      expect(object(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY])).toMatchObject(durableJoinProgramJsonByteLengths(f.originals[index]));
    }
    expect(f.calls).toHaveLength(1);
    const decoded = await f.codec.decodeMany(encoded.map(value => ({ value, informationLabel: label })));
    expect(decoded).toEqual(f.originals); expect(f.originals).toEqual(before);
    expect(Object.hasOwn(object(decoded[0]), "constructor")).toBe(true);
    expect(Object.getPrototypeOf(decoded[0])).toBe(Object.prototype);
    expect(decoded.map(value => canonicalDigestHex(value, hasher))).toEqual(f.originals.map(value => canonicalDigestHex(value, hasher)));
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.sql).toContain("version.content_hash=receipt.pattern_json->'compilation'->>'contentHash'");
    expect(f.calls[0]!.sql).toContain("profile.source_version_id=version.id");
    const firstLinks = object(decoded[0]).links as Array<Record<string, unknown>>;
    firstLinks[0]!.target = "caller mutation";
    expect((object(decoded[1]).links as Array<Record<string, unknown>>)[0]!.target).not.toBe("caller mutation");
    expect((object(object(f.row.pattern_json.inheritedMetadata).value).links as Array<Record<string, unknown>>)[0]!.target).not.toBe("caller mutation");
  });

  it("binds metadata into the canonical compilation identity and keeps its holder nonrecursive", async () => {
    const f = fixture(), receipt = object(f.row.pattern_json), header = object(receipt.compilation), shared = object(receipt.inheritedMetadata);
    expect(object(header.options).artifactMetadataDigest).toBe(canonicalDigestHex(f.metadata, hasher));
    expect(shared.value).toEqual(f.metadata);
    const { compilationId, modelInventory: _models, ...common } = header;
    expect(compilationId).toBe(canonicalDigestHex(common, hasher));
    expect(await f.codec.encodeMany([{ value: receipt, informationLabel: label }])).toEqual([receipt]);
  });

  it("does not hoist learned values that override the inherited value", async () => {
    const f = fixture(), value = { ...object(f.originals[0]), links: [{ learned: "different" }] };
    const [encoded] = await f.codec.encodeMany([{ value, informationLabel: label }]);
    expect(object(encoded).links).toEqual(value.links);
    expect(await f.codec.decodeMany([{ value: encoded, informationLabel: label }])).toEqual([value]);
  });

  it.each(["holder", "access", "digest", "profile", "label", "payload", "reference", "collision", "ledger"])("refuses %s mutation or unavailable ownership", async mutation => {
    const f = fixture(); const [encoded] = await f.codec.encodeMany([{ value: f.originals[0], informationLabel: label }]);
    const stored = clone(object(encoded)); let informationLabel = label;
    if (mutation === "holder") f.state.row = { ...f.row, id: "missing" };
    if (mutation === "access") f.state.accessible = false;
    if (mutation === "digest") object(object(f.row.pattern_json.inheritedMetadata).value).links = [];
    if (mutation === "profile") stored.profileId = "foreign";
    if (mutation === "label") informationLabel = { ...label, tenantId: "foreign" };
    if (mutation === "payload") stored.templates = [{ surface: "fabricated" }];
    if (mutation === "reference") object(stored[SOURCE_ARTIFACT_METADATA_KEY]).receiptId = "foreign";
    if (mutation === "collision") stored.links = [];
    if (mutation === "ledger") object(stored[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).decodedJsonbBytes = 1;
    await expect(f.codec.decodeMany([{ value: stored, informationLabel }])).rejects.toThrow("metadata");
  });

  it("retains an existing JOIN/creative byte ledger until that codec reconstructs its payload", async () => {
    const f = fixture(), value = { ...object(f.originals[0]), [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA,
      ...durableJoinProgramJsonByteLengths(f.originals[0]) } };
    const [encoded] = await f.codec.encodeMany([{ value, logicalValue: f.originals[0], informationLabel: label }]);
    expect(object(encoded)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toEqual(value[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]);
    expect(await f.codec.decodeMany([{ value: encoded, informationLabel: label }])).toEqual([value]);
  });

  it("rejects caller supplied byte ledgers instead of licensing an under-budget read", async () => {
    const f = fixture(), value = { ...object(f.originals[0]), [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: {
      schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, decodedJsonBytes: 1, decodedJsonbBytes: 1 } };
    await expect(f.codec.encodeMany([{ value, informationLabel: label }])).rejects.toThrow("metadata");
    await expect(f.codec.encodeMany([{ value, logicalValue: f.originals[0], informationLabel: label }])).rejects.toThrow("metadata");
    await expect(f.codec.encodeMany([{ value, logicalValue: value, informationLabel: label }])).rejects.toThrow("metadata");
  });

  it("leaves unbound bare records and projected request seeds body-free", async () => {
    const f = fixture(), projected = { schema: "test.seed", sourceCompilationId: object(f.originals[0]).sourceCompilationId, requirementTargets: { factual: 1 } };
    expect(await f.codec.decodeMany([{ value: projected }])).toEqual([projected]);
    expect(f.calls).toHaveLength(0);
    const bare = { schema: "test.bare", arbitrary: { value: 2 } };
    expect(await f.codec.encodeMany([{ value: bare }])).toEqual([bare]); expect(f.calls).toHaveLength(0);
    const collision = { ...bare, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: { schema: "caller.owned", arbitrary: 1 } };
    const [untouched] = await f.codec.encodeMany([{ value: collision }]);
    expect(untouched).toBe(collision); expect(f.calls).toHaveLength(0);
  });
});
