// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import * as kernel from "@scce/kernel";
import { canonicalDigestHex, createClock, createHasher, createIdFactory, sourceLanguageTrainingStreamId,
  stampSourceLanguageCompilation, toJsonValue, type InformationLabel, type JsonValue } from "@scce/kernel";
import { createSourceArtifactMetadataCodec, SOURCE_ARTIFACT_METADATA_KEY } from "../source-artifact-metadata.js";
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, durableJoinProgramJsonByteLengths } from "../durable-join-program-storage.js";
import type { CreativeEventStorageHost } from "../canonical-creative-event-store.js";

const hasher = createHasher(), label: InformationLabel = { tenantId: "owner", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
function fixture(suffix = "", inherited: Record<string, JsonValue> = {}, schema = "test.authored.learned.v1") {
  const text = "A public source records ? and ??." + suffix, profileId = `profile${suffix}`, ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "metadata" });
  const owner = { sourceId: ids.sourceId("fixture", "fixture://public-source"), sourceVersionId: ids.sourceVersionId(text), contentHash: ids.contentHash(text) };
  const metadata = { links: Array.from({ length: 120 }, (_, index) => ({ index, target: `source-${index}-` + "???".repeat(120) })),
    arbitraryNestedProvenance: { authors: ["Human author"], license: { name: "Public fixture" } },
    requirementTargets: { factual: 1 }, sourceIds: ["source-a", "source-b"], scalar: "kept", nullValue: null, ...inherited };
  Object.defineProperty(metadata, "constructor", { value: { sourceOwned: "opaque property" }, enumerable: true });
  const body = { ...metadata, profileId, sourceVersionId: owner.sourceVersionId, sourceSystem: "fixture", schema,
    joinProgram: { unrelatedLearnedValue: [2, 3] }, templates: [{ surface: "attested ?" }] };
  const streamId = sourceLanguageTrainingStreamId({ ...owner, sourceSystem: "fixture", hasher });
  const stamped = stampSourceLanguageCompilation({ owner, profileId, sourceSystem: "fixture", streamId, text, chunks: [text], inheritedMetadata: toJsonValue(metadata),
    options: { maxOrder: 1, maxCountersPerOrder: 100, vocabularyLimit: 100, languageOnly: false, retainNgramObservations: false }, hasher,
    models: [{ id: "model", streamId, languageHint: "und", maxOrder: 1, discount: 0.5, updatedAt: 1, modelJson: toJsonValue({ ...body, model: { learned: [1, 2] } }) }],
    artifacts: { units: [{ id: "unit", profileId, sourceVersionId: owner.sourceVersionId, script: "Latin", unitKind: "symbol", text: "?", features: ["opaque"], competenceVector: [1], alpha: 1, evidenceIds: [], metadata: toJsonValue(body) }],
      patterns: [{ id: "pattern", profileId, patternKind: "syntax", support: 1, entropy: 0, updatedAt: 1, evidenceIds: [], patternJson: toJsonValue(body) }],
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
  it.each(["scce.language_construction_pattern.v1", "scce.induced_language_model.semantic_memory.v1"])("shares only exact allowed inherited scalar provenance in %s", async schema => {
    const provenance = { sourceUri: "fixture://human/\u96ea/e\u0301", sourceHash: "sha256:owned", sourceSystemId: "source:owned", title: "Original e\u0301 title",
      authorship: "human_authored", corpusRole: "opaque.corpus.role", forceClass: "learned_language_prior", provenanceClass: "source_owned",
      transcriptSchema: "scce.dialogue_transcript.v1", annotatedTurns: 222 };
    const inline = { relativePath: "original.rs", streamUri: "fixture://original.rs", formalLanguage: "rust", parameterCount: 3, language: "opaque.language",
      unknownScalar: "not opted in", scalar: "kept", nullValue: null, sourceSystem: "fixture" };
    const f=fixture("provenance", {...provenance,...inline}, schema), value=f.originals[1];
    const [encoded]=await f.codec.encodeMany([{artifactFamily:"language_pattern",value,informationLabel:label}]);
    for(const key of Object.keys(provenance))expect(object(encoded)).not.toHaveProperty(key);
    for(const [key,member] of Object.entries(inline))expect(object(encoded)[key]).toEqual(member);
    const restored=(await f.codec.decodeMany([{value:JSON.parse(JSON.stringify(encoded)),informationLabel:label}]))[0];
    expect(restored).toEqual(value);expect(canonicalDigestHex(restored,hasher)).toBe(canonicalDigestHex(value,hasher));
    for(const familyValue of [f.originals[0],f.originals[2],f.originals[3]]){
      const [other]=await f.codec.encodeMany([{value:familyValue,informationLabel:label}]);
      for(const [key,member] of Object.entries(provenance))expect(object(other)[key]).toEqual(member);
    }
    const changed:Record<string,unknown>={...object(value),title:"locally learned override"};delete changed.sourceUri;
    const [different]=await f.codec.encodeMany([{artifactFamily:"language_pattern",value:changed,informationLabel:label}]);
    expect(object(different).title).toBe(changed.title);expect(object(object(different)[SOURCE_ARTIFACT_METADATA_KEY]).keys).not.toContain("sourceUri");
    expect(await f.codec.decodeMany([{value:different,informationLabel:label}])).toEqual([changed]);
    const unbound={...object(value)};delete unbound.sourceCompilationId;
    expect((await f.codec.encodeMany([{artifactFamily:"language_pattern",value:unbound,informationLabel:label}]))[0]).toBe(unbound);
  });
  it("keeps scalar provenance inline for arbitrary pattern schemas",async()=>{
    const f=fixture("other",{title:"attested title",sourceUri:"fixture://owned"});
    const [encoded]=await f.codec.encodeMany([{artifactFamily:"language_pattern",value:f.originals[1],informationLabel:label}]);
    expect(object(encoded).title).toBe("attested title");expect(object(encoded).sourceUri).toBe("fixture://owned");
  });
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

  it("validates each unique holder once per invocation and revalidates it on the next call", async () => {
    const f = fixture(), second = fixture("second"), rows = [f.row, second.row];
    const codec = createSourceArtifactMetadataCodec({ ...f.host, query: async <T>(_sql: string, params: unknown[] = []): Promise<T[]> =>
      rows.filter(row => (params[0] as string[]).includes(row.id)).map(row => clone(row) as T) });
    const headerValidation = vi.spyOn(kernel, "validateSourceLanguageCompilationHeader"), digests = vi.spyOn(kernel, "canonicalDigestHex");
    const metadataDigests = () => digests.mock.calls.filter(([value]) => value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.hasOwn(value, "links") && !Object.hasOwn(value, "profileId")).length;
    const inputs = [...f.originals, ...second.originals, ...f.originals].map(value => ({ value, informationLabel: label }));
    try {
      const encoded = await codec.encodeMany(inputs);
      expect(headerValidation).toHaveBeenCalledTimes(2); expect(metadataDigests()).toBe(2);
      headerValidation.mockClear(); digests.mockClear();
      const decoded = await codec.decodeMany(encoded.map(value => ({ value, informationLabel: label })));
      expect(headerValidation).toHaveBeenCalledTimes(2); expect(metadataDigests()).toBe(2);
      expect(decoded.map(value => canonicalDigestHex(value, hasher))).toEqual(inputs.map(input => canonicalDigestHex(input.value, hasher)));
      // A new call must read and validate a new owner snapshot, including a now-corrupt holder.
      object(object(f.row.pattern_json.inheritedMetadata).value).links = [];
      await expect(codec.decodeMany([{ value: encoded[0], informationLabel: label }])).rejects.toThrow("metadata");
    } finally { headerValidation.mockRestore(); digests.mockRestore(); }
  });

  it.each(["profile", "source", "label", "digest"])("still checks each %s binding after the holder is memoized", async mismatch => {
    const f = fixture(), [encoded] = await f.codec.encodeMany([{ value: f.originals[0], informationLabel: label }]);
    const second = { value: clone(encoded), informationLabel: label, profileId: "profile", sourceVersionId: String(f.owner.sourceVersionId) };
    if (mismatch === "profile") second.profileId = "foreign";
    if (mismatch === "source") second.sourceVersionId = "foreign";
    if (mismatch === "label") second.informationLabel = { ...label, tenantId: "foreign" };
    if (mismatch === "digest") object(object(second.value)[SOURCE_ARTIFACT_METADATA_KEY]).digest = "foreign";
    await expect(f.codec.decodeMany([{ value: encoded, informationLabel: label }, second])).rejects.toThrow("metadata");
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
