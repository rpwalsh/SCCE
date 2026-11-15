// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createHasher, createClock, createIdFactory, LEXICAL_GRAMMAR_SCHEMA, LEXICAL_SENSE_SCHEMA, SOURCE_QUESTION_FRAME_SCHEMA, verifySourceOwnedLexicalPattern,
  type EvidenceSpan, type InformationLabel, type IngestionCheckpoint, type LanguageIdentityRecord,
  type LanguagePatternRecord, type LanguageProfile, type SourceVersion, type EvidenceSpanReference, type NgramModelRecord, type NgramObservation } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { captureFixtureLanguagePatternProjections, removeFixtureLanguagePatternProjections } from "../../../kernel/src/__tests__/language-pattern-projection-fixture.js";
import { readBoundedLexicalCorpusSource, LexicalCorpusCapacityError } from "../lexical-corpus-store.js";
import { ingestUdLexicalCorpus, readUdLexicalGrammar } from "../ud-lexical-corpus.js";
import { ingestWordnetCorpus } from "../wordnet-corpus.js";
import { trainLanguageCorpusText, prepareLanguageCorpusTraining } from "../language-corpus-trainer.js";
import { createSourceArtifactMetadataCodec } from "../source-artifact-metadata.js";
import { isCanonicalSegmentationArchiveSchema, validateSourceCompilationReceipt, validateSourceCompilationArtifactInventory } from "../../../kernel/src/source-language-compilation.js";

const label: InformationLabel = { tenantId: "lexical.tests", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const hasher = createHasher(), hash = (bytes: Uint8Array | string) => `sha256_${hasher.digestHex(bytes)}`;
const token = (form: string, feats = "Number=Sing", dependency = "root") => `1\t${form}\té\tNOUN\t_\t${feats}\t0\t${dependency}\t_\t_`;
const conllu = ["# source = 𐐀", "# text = é", token("é"), "", "# text = é", token("é"), "", "# text = é", token("é", "Number=Plur"), "", "# text = é", token("é", "Number=Sing", "obj"), ""].join("\r\n");
const wordnet = `<LexicalResource><Lexicon id="wn" version="1" language="fixture" license="test"><LexicalEntry id="one"><Lemma writtenForm="é"/><Form writtenForm="茶"/></LexicalEntry><LexicalEntry id="two"><Lemma writtenForm="𐐀"/></LexicalEntry><Synset id="sense" members="one two" partOfSpeech="n"><Definition>é 茶 𐐀</Definition><Example>é 茶</Example></Synset></Lexicon></LexicalResource>`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function fixture() {
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 1 });
  const storage = base.storage;
  let state = { sources: new Map<string, SourceVersion>(), spans: new Map<string, EvidenceSpan>(), blobs: new Map<string, Uint8Array>(),
    patterns: new Map<string, LanguagePatternRecord>(), profiles: new Map<string, LanguageProfile>(), checkpoints: new Map<string, IngestionCheckpoint>(),
    models: new Map<string, NgramModelRecord>(), observations: new Map<string, NgramObservation>(),
    assignments: [] as Array<{ profileId: string; languageId: string }> };
  const identity: LanguageIdentityRecord = { schema: "scce.language_identity.v2", id: "identity.measured", script: "", directions: [],
    closedClass: [{ word: "é", documentShare: 1 }], families: [], corpusRoles: [], profileCount: 1, membershipCut: 0, createdAt: 1, informationLabel: label };
  storage.languageIdentities = { putIdentities: async () => {}, listIdentities: async () => [identity],
    assignProfileLanguages: async rows => { state.assignments.push(...rows); }, listProfileLanguages: async () => state.assignments, listProfileSignatures: async () => [] };
  storage.evidence.putSourceVersion = async row => { state.sources.set(row.sourceVersionId, row); };
  storage.evidence.putEvidenceSpan = async row => { state.spans.set(row.id, row); };
  storage.evidence.putEvidenceSpans = async rows => { for (const row of rows) state.spans.set(row.id, row); };
  storage.evidence.getEvidenceBatch = async ids => ids.flatMap(id => state.spans.get(id) ?? []);
  storage.evidence.sourceVersionById = async id => state.sources.get(id) ?? null;
  storage.evidence.sourceVersionsForEvidence = async ids => [...new Set(ids.flatMap(id => state.spans.get(id)?.sourceVersionId ?? []))].flatMap(id => state.sources.get(id) ?? []);
  storage.evidence.resolveEvidenceSpanReferences = async input => input.spans.flatMap(expected => {
    const span = state.spans.get(expected.id) ?? [...state.spans.values()].filter(row => row.sourceVersionId === input.sourceVersionId
      && row.byteStart === expected.byteStart && row.byteEnd === expected.byteEnd && row.contentHash === expected.contentHash).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    return span ? [Object.fromEntries(["id", "chunkId", "sourceId", "sourceVersionId", "contentHash", "mediaType", "byteStart", "byteEnd", "charStart", "charEnd", "status", "alpha", "observedAt", "informationLabel"]
      .map(key => [key, span[key as keyof EvidenceSpan]])) as EvidenceSpanReference] : [];
  });
  storage.blobs.put = async bytes => { const id = hash(bytes); state.blobs.set(id, new Uint8Array(bytes)); return id as SourceVersion["contentHash"]; };
  storage.blobs.get = async id => { const bytes = state.blobs.get(id); if (!bytes) throw new Error("missing canonical blob"); return bytes; };
  storage.blobs.putRanges = async (rows, parent) => {
    expect(hash(parent.bytes)).toBe(parent.contentHash);
    expect(state.blobs.has(parent.contentHash)).toBe(true);
    for (const row of rows) { const bytes = parent.bytes.slice(row.byteStart, row.byteEnd); expect(hash(bytes)).toBe(row.contentHash); state.blobs.set(row.contentHash, bytes); }
  };
  storage.model.putLanguageProfile = async row => { state.profiles.set(row.id, row); };
  storage.model.listLanguageProfiles = async () => [...state.profiles.values()];
  storage.languageMemory.putLanguagePattern = async row => { state.patterns.set(row.id, row); };
  storage.languageMemory.putNgramModel = async row => { state.models.set(row.id, row); };
  storage.languageMemory.putNgramModels = async rows => { for (const row of rows) state.models.set(row.id, row); };
  storage.languageMemory.putNgramObservation = async row => { state.observations.set(row.id, row); };
  storage.languageMemory.putNgramObservationsBatch = async rows => { for (const row of rows) state.observations.set(row.id, row); };
  storage.languageMemory.listNgramModels = async () => [...state.models.values()];
  storage.languageMemory.listNgramObservations = async () => [...state.observations.values()];
  storage.languageMemory.listLanguagePatterns = async query => [...state.patterns.values()].filter(row => (!query?.patternIds || query.patternIds.includes(row.id))
    && (!query?.patternSchemas || query.patternSchemas.includes(String((row.patternJson as { schema?: string }).schema)))).slice(0, query?.limit);
  storage.ingestion = { get: async id => state.checkpoints.get(id) ?? null,
    put: async row => { state.checkpoints.set(row.id, row); }, list: async () => [...state.checkpoints.values()] };
  storage.transaction = async operation => {
    const before = structuredClone(state), events = base.events.slice(), restore = captureFixtureLanguagePatternProjections(storage.languageMemory);
    try { return await operation(); } catch (error) { state = before; base.events.splice(0, base.events.length, ...events); restore(); throw error; }
  };
  return { storage, state: () => state, events: base.events };
}
function udInput(storage: ReturnType<typeof fixture>["storage"]) { return { storage, text: conllu, sourceUri: "fixture://annotations/ud", lexiconId: "ud.fixture", language: "fixture", license: "test", informationLabel: label, maxSourceBytes: 65536, updatedAt: 1 }; }

it.each(["ud", "wordnet"])("publishes %s artifacts through the production metadata codec with a truthful empty ngram inventory", async format => {
  const f = fixture(), units: import("@scce/kernel").LanguageUnitRecord[] = [], frames: import("@scce/kernel").SemanticFrameRecord[] = [],
    logical: unknown[] = [], physical: Array<{ value: unknown; profileId?: string; sourceVersionId?: string; informationLabel: InformationLabel }> = [];
  const codec = () => createSourceArtifactMetadataCodec({ table: name => `"codec"."${name}"`,
    requireWritableInformationLabel: value => { if (!value) throw Error("fixture requires an explicit information label"); return value; },
    informationAccessPredicate: () => ({ sql: "TRUE", params: [] }),
    query: async <T>(_sql: string, params: unknown[] = []): Promise<T[]> => [...f.state().patterns.values()].flatMap(row => {
      const root = row.patternJson as Record<string, unknown>, compilation = root.compilation as Record<string, string> | undefined;
      const profile = f.state().profiles.get(row.profileId), owner = compilation?.sourceVersionId ? f.state().sources.get(compilation.sourceVersionId) : undefined;
      return (params[0] as string[]).includes(row.id) && row.patternKind === "source_compilation" && profile && owner
        && profile.sourceVersionId === owner.sourceVersionId && compilation!.sourceId === owner.sourceId && compilation!.contentHash === owner.contentHash
        ? [{ id: row.id, profile_id: row.profileId, pattern_json: structuredClone(root), information_label: row.informationLabel } as T] : [];
    }) });
  f.storage.languageMemory.putLanguageUnit = async unit => {
    const input = { artifactFamily: "language_unit" as const, value: unit.metadata, profileId: unit.profileId, sourceVersionId: unit.sourceVersionId, informationLabel: label };
    const [encoded] = await codec().encodeMany([input]);
    physical.push({ ...input, value: JSON.parse(JSON.stringify(encoded)) }); logical.push(unit.metadata); units.push(unit);
  };
  f.storage.languageMemory.putSemanticFrame = async frame => {
    const input = { value: frame.frameJson, informationLabel: label }, [encoded] = await codec().encodeMany([input]);
    physical.push({ ...input, value: JSON.parse(JSON.stringify(encoded)) }); logical.push(frame.frameJson); frames.push(frame);
  };
  const result = format === "ud" ? await ingestUdLexicalCorpus(udInput(f.storage)) : await ingestWordnetCorpus({ storage: f.storage, text: wordnet,
    sourceUri: "fixture://codec/wordnet", informationLabel: label, maxSourceBytes: 65536, updatedAt: 1 });
  expect(units.length).toBeGreaterThan(0);
  expect(await codec().decodeMany(physical)).toEqual(logical);
  const receipts = [...f.state().patterns.values()].filter(row => (row.patternJson as { schema?: string }).schema === "scce.source_language_compilation_receipt.v1");
  expect(receipts).toHaveLength(1);
  const compilation = (receipts[0]!.patternJson as Record<string, import("@scce/kernel").JsonValue>).compilation!;
  expect(compilation).toMatchObject({ chunkCount: 0, modelInventory: [], sourceVersionId: result.sourceVersionId, options: { artifactScope: "artifacts_only" } });
  expect(() => validateSourceCompilationReceipt(compilation, [], hasher)).not.toThrow();
  await validateSourceCompilationArtifactInventory({ compilation: compilation as unknown as Parameters<typeof validateSourceCompilationArtifactInventory>[0]["compilation"],
    profileId: result.profileId, hasher, list: async ({ family, afterId, limit }) => {
    const ids = (family === "units" ? units.map(row => row.id) : family === "patterns" ? [...f.state().patterns.values()].filter(row => row.patternKind !== "source_compilation"
      && !isCanonicalSegmentationArchiveSchema((row.patternJson as { schema?: string }).schema)).map(row => row.id) : frames.map(row => row.id))
      .filter(id => afterId === undefined || id > afterId).sort();
    expect(ids, family).toHaveLength(Number(((compilation as Record<string, unknown>).artifacts as Record<string, { count: number }>)[family]!.count));
    return ids.slice(0, limit);
  } });
  const events = f.events.length;
  expect(format === "ud" ? await ingestUdLexicalCorpus(udInput(f.storage)) : await ingestWordnetCorpus({ storage: f.storage, text: wordnet,
    sourceUri: "fixture://codec/wordnet", informationLabel: label, maxSourceBytes: 65536, updatedAt: 1 })).toEqual(result);
  expect(f.events).toHaveLength(events); expect(f.state().models.size).toBe(0);
});

it("counts every UD occurrence while retaining a witness for each distinct surface, feature set and dependency", () => {
  const parsed = readUdLexicalGrammar(conllu), row = parsed.patterns[0]!;
  expect(row.support).toBe(4);
  expect(row.ranges).toHaveLength(3);
  expect((row.patternJson as { forms: unknown[] }).forms).toEqual([
    { surface: "é", features: { Number: "Sing" }, dependency: "root", count: 2 },
    { surface: "é", features: { Number: "Plur" }, dependency: "root", count: 1 },
    { surface: "é", features: { Number: "Sing" }, dependency: "obj", count: 1 }
  ]);
  expect(row.ranges[0]!.start).toBe(conllu.indexOf(token("é")));
});

it.each(["ud", "wordnet"])("publishes %s through ordinary canonical training with raw Unicode witnesses accepted by factual readers", async format => {
  const f = fixture(), raw = format === "ud" ? conllu : wordnet;
  const result = format === "ud" ? await ingestUdLexicalCorpus(udInput(f.storage)) : await ingestWordnetCorpus({ storage: f.storage, text: raw, sourceUri: "fixture://annotations/wn", informationLabel: label, maxSourceBytes: 65536, updatedAt: 1 });
  const state = f.state(), source = state.sources.get(result.sourceVersionId)!, original = state.sources.get(result.annotationSourceVersionId)!;
  expect(state.sources.size).toBe(2);
  expect(source.sourceId).not.toBe(original.sourceId);
  expect(source.canonicalUri).not.toBe(original.canonicalUri);
  expect(original.role).toBe("original");
  expect(original.contentHash).toBe(hash(raw));
  expect(Buffer.from(await f.storage.blobs.get(original.contentHash)).toString("utf8")).toBe(raw);
  expect(source.derivation?.derivedFromSourceVersionId).toBe(original.sourceVersionId);
  const schema = format === "ud" ? LEXICAL_GRAMMAR_SCHEMA : LEXICAL_SENSE_SCHEMA;
  const patterns = [...state.patterns.values()].filter(row => (row.patternJson as { schema?: string }).schema === schema);
  expect(patterns).toHaveLength(1);
  for (const pattern of patterns) {
    const spans = pattern.evidenceIds.map(id => state.spans.get(id)!);
    expect(verifySourceOwnedLexicalPattern({ pattern, source, evidenceOwners: [original], evidence: spans }, {
      hasher, informationAccess: { tenantId: label.tenantId, principalId: "reader", compartments: [], maximumExportClass: "public" }
    })).toBeDefined();
    for (const span of spans) {
      expect(Buffer.from(raw).subarray(span.byteStart, span.byteEnd).toString("utf8")).toBe(span.text);
      expect([...raw].slice(span.charStart, span.charEnd).join("")).toBe(span.text);
      expect(Buffer.from(await f.storage.blobs.get(span.contentHash))).toEqual(Buffer.from(span.text));
    }
  }
  const projection = await f.storage.languageMemory.getLanguagePatternProjection!({ profileId: result.profileId, sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId, sourceSystem: "workspace", patternSchema: schema, componentRecipe: String((patterns[0]!.patternJson as { componentRecipe: string }).componentRecipe), informationLabel: label });
  expect(projection?.sourceDependencies?.map(row => row.contentHash).sort()).toEqual([source.contentHash, original.contentHash].sort());
  expect(state.assignments).toEqual([{ profileId: result.profileId, languageId: "identity.measured" }]);
  expect([...state.checkpoints.values()].map(row => row.status)).toEqual(["complete"]);
});

it("rolls back interrupted publication, resumes completely and verifies active publication before cached replay", async () => {
  const f = fixture(), input = udInput(f.storage), publish = f.storage.languageMemory.replaceLanguagePatternProjection!;
  let interrupt = true;
  f.storage.languageMemory.replaceLanguagePatternProjection = async value => { await publish.call(f.storage.languageMemory, value); if (interrupt) { interrupt = false; throw new Error("interrupted publication"); } };
  await expect(ingestUdLexicalCorpus(input)).rejects.toThrow("interrupted publication");
  expect(f.state().sources.size).toBe(0);
  expect(f.state().patterns.size).toBe(0);
  expect([...f.state().checkpoints.values()].every(row => row.status !== "complete")).toBe(true);
  const report = await ingestUdLexicalCorpus(input), eventCount = f.events.length;
  const checkpointReport = ([...f.state().checkpoints.values()][0]!.metadata as unknown as { report: { sourceOwnedPatternProjections: import("@scce/kernel").LanguagePatternProjection[] } }).report;
  for (const projection of checkpointReport.sourceOwnedPatternProjections) {
    expect(await f.storage.languageMemory.getLanguagePatternProjection!(projection)).toEqual(projection);
    expect((await f.storage.languageMemory.listLanguagePatterns({ view: "request_seed", patternIds: projection.patternIds, limit: projection.patternIds.length })).map(row => row.id).sort()).toEqual(projection.patternIds);
  }
  expect(await ingestUdLexicalCorpus(input)).toEqual(report);
  expect(f.events).toHaveLength(eventCount);
  removeFixtureLanguagePatternProjections(f.storage.languageMemory);
  const repaired = await ingestUdLexicalCorpus(input);
  expect(repaired.sourceVersionId).toBe(report.sourceVersionId);
  expect(f.events.length).toBeGreaterThan(eventCount);
  expect(await ingestUdLexicalCorpus(input)).toEqual(repaired);
});

it("replays a complete durable checkpoint after a lost commit acknowledgement without duplicating publication", async () => {
  const f = fixture(), input = udInput(f.storage), transaction = f.storage.transaction;
  let interrupt = true;
  f.storage.transaction = async operation => { const result = await transaction(operation); if (interrupt) { interrupt = false; throw new Error("lost commit acknowledgement"); } return result; };
  await expect(ingestUdLexicalCorpus(input)).rejects.toThrow("lost commit acknowledgement");
  expect([...f.state().checkpoints.values()].map(row => row.status)).toEqual(["complete"]);
  const eventCount = f.events.length, assignments = f.state().assignments.slice();
  const result = await ingestUdLexicalCorpus(input);
  expect(f.state().sources.size).toBe(2);
  expect(f.events).toHaveLength(eventCount);
  expect(f.state().assignments).toEqual(assignments);
  expect(result.checkpointed).toBe(true);
});

it("reuses exact retained raw owners and aliased evidence while adding only newly observed annotation ranges", async () => {
  const seed = fixture();
  await trainLanguageCorpusText({ storage: seed.storage, sourceSystem: "gutenberg", streamUri: "fixture://prior-language", sourceUri: "fixture://prior-language",
    text: "é links tea. é links coffee.", createdAt: 1, informationLabel: label, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
  const text = await readFile(new URL("./fixtures/ud-ewt-question-excerpt.conllu", import.meta.url), "utf8");
  const identity = (await seed.storage.languageIdentities!.listIdentities())[0]!;
  seed.storage.languageIdentities!.listIdentities = async () => [{ ...identity, closedClass: [{ word: "what", documentShare: 1 }] }];
  const first = await ingestUdLexicalCorpus({ ...udInput(seed.storage), text });
  const raw = seed.state().sources.get(first.annotationSourceVersionId)!, ids = createIdFactory({ clock: createClock(), hasher });
  const retained: SourceVersion = { ...structuredClone(raw), sourceId: ids.sourceId("retained.annotations", raw.canonicalUri),
    sourceVersionId: ids.sourceVersionId(`retained-owner:${raw.contentHash}`), namespace: "retained.annotations", role: undefined,
    metadata: { retainedMetadata: "keep exactly", license: "test", lexiconId: "ud.fixture", language: "fixture" } };
  const prior = fixture(); Object.assign(prior.state(), structuredClone(seed.state())); prior.events.push(...structuredClone(seed.events));
  prior.state().checkpoints.clear(); prior.state().sources.set(retained.sourceVersionId, retained);
  prior.storage.languageIdentities!.listIdentities = seed.storage.languageIdentities!.listIdentities;
  const retainedSpans = [...seed.state().spans.values()].filter(span => span.sourceVersionId === raw.sourceVersionId && !span.text.startsWith("# text ="))
    .map((span, index): EvidenceSpan => ({ ...structuredClone(span), id: `${span.id}.retained.${index}` as EvidenceSpan["id"],
      sourceId: retained.sourceId, sourceVersionId: retained.sourceVersionId, features: ["opaque.retained.feature"], provenance: { retained: "verbatim" } }));
  for (const span of retainedSpans) prior.state().spans.set(span.id, span);
  const rawBefore = structuredClone(retained), spansBefore = structuredClone(retainedSpans), ngrams = structuredClone([...prior.state().models]), observations = structuredClone([...prior.state().observations]);
  const putSource = prior.storage.evidence.putSourceVersion, putSpans = prior.storage.evidence.putEvidenceSpans!, putBlob = prior.storage.blobs.put;
  prior.storage.evidence.putSourceVersion = async row => { expect(row.sourceVersionId).not.toBe(retained.sourceVersionId); await putSource(row); };
  prior.storage.evidence.putEvidenceSpans = async rows => { expect(rows.some(row => retainedSpans.some(old => old.id === row.id))).toBe(false); await putSpans(rows); };
  prior.storage.blobs.put = async (bytes, mediaType) => { expect(hash(bytes)).not.toBe(retained.contentHash); return putBlob(bytes, mediaType); };
  const result = await ingestUdLexicalCorpus({ ...udInput(prior.storage), text, retainedSourceVersionId: retained.sourceVersionId });
  expect(result.annotationSourceVersionId).toBe(retained.sourceVersionId);
  expect(result.sourceVersionId).not.toBe(first.sourceVersionId);
  expect(prior.state().sources.get(retained.sourceVersionId)).toEqual(rawBefore);
  for (const span of spansBefore) expect(prior.state().spans.get(span.id)).toEqual(span);
  const rawSpans = [...prior.state().spans.values()].filter(span => span.sourceVersionId === retained.sourceVersionId);
  expect(rawSpans).toHaveLength(retainedSpans.length + 1);
  expect(rawSpans.filter(span => !retainedSpans.some(old => old.id === span.id)).map(span => span.text)).toEqual(["# text = What is the problem?"]);
  expect([...prior.state().models]).toEqual(ngrams); expect([...prior.state().observations]).toEqual(observations);
  const cold = structuredClone(prior.state()), source = cold.sources.get(result.sourceVersionId)!;
  const lexicalSchemas: readonly string[] = [LEXICAL_GRAMMAR_SCHEMA, SOURCE_QUESTION_FRAME_SCHEMA];
  const published = [...cold.patterns.values()].filter(row => row.profileId === result.profileId && lexicalSchemas.includes(String((row.patternJson as { schema?: string }).schema)));
  expect(published).toHaveLength(result.patterns);
  for (const pattern of published) expect(verifySourceOwnedLexicalPattern({ pattern, source, evidenceOwners: [cold.sources.get(retained.sourceVersionId)!],
    evidence: pattern.evidenceIds.map(id => cold.spans.get(id)!) }, { hasher, informationAccess: { tenantId: label.tenantId, principalId: "reader", compartments: [], maximumExportClass: "public" } })).toBeDefined();
  const counts = { sources: prior.state().sources.size, spans: prior.state().spans.size, profiles: prior.state().profiles.size, events: prior.events.length };
  expect(await ingestUdLexicalCorpus({ ...udInput(prior.storage), text, retainedSourceVersionId: retained.sourceVersionId })).toEqual(result);
  expect({ sources: prior.state().sources.size, spans: prior.state().spans.size, profiles: prior.state().profiles.size, events: prior.events.length }).toEqual(counts);
});

it("uses one exact derivative identity for fresh and retained instances of the same raw owner", async () => {
  const f = fixture();
  const input = { storage: f.storage, sourceSystem: "workspace", streamUri: "fixture://derivative", sourceUri: "fixture://derivative", text: "é", exactSourceText: true,
    informationLabel: label, createdAt: 1, languageOnly: true, skipNgramPersistence: true,
    corpusCheckpoint: { rootUri: "fixture://projection-root", itemUri: "fixture://derivative", contentHash: hash(conllu), byteLength: Buffer.byteLength(conllu) },
    originalSource: { bytes: Buffer.from(conllu), sourceUri: "fixture://raw", mediaType: "text/plain", transformId: "fixture.source_projection.v1" } };
  const fresh = await trainLanguageCorpusText(input), original = f.state().sources.get(fresh.originalSourceVersionId)!;
  const retained = await prepareLanguageCorpusTraining({ ...input, originalSource: { ...input.originalSource, retainedSourceVersionId: original.sourceVersionId } });
  expect(retained.sourceVersionId).toBe(fresh.sourceVersionId);
  expect(retained.inputBinding).toBe((await prepareLanguageCorpusTraining(input)).inputBinding);
  const eventCount = f.events.length;
  expect(await trainLanguageCorpusText({ ...input, originalSource: { ...input.originalSource, retainedSourceVersionId: original.sourceVersionId } })).toEqual(fresh);
  expect(f.events).toHaveLength(eventCount);
  const ids = createIdFactory({ clock: createClock(), hasher }), other = { ...original, sourceId: ids.sourceId("another.canonical.owner", original.canonicalUri),
    sourceVersionId: ids.sourceVersionId("another canonical owner") };
  f.state().sources.set(other.sourceVersionId, other);
  const changed = { ...input, originalSource: { ...input.originalSource, retainedSourceVersionId: other.sourceVersionId } };
  expect((await prepareLanguageCorpusTraining(changed)).sourceVersionId).not.toBe(fresh.sourceVersionId);
  await expect(trainLanguageCorpusText(changed)).rejects.toThrow("checkpoint binding mismatch");
  await expect(prepareLanguageCorpusTraining({ ...changed, sourceVersionId: original.sourceVersionId })).rejects.toThrow("canonical lineage");
  await expect(prepareLanguageCorpusTraining({ ...changed, informationLabel: { ...label, exportClass: "restricted", principals: ["reader"] } })).rejects.toThrow("exact source binding");
});

it("reuses an already canonical computed original owner without requiring an execution-mode flag", async () => {
  const seed = fixture(), first = await ingestUdLexicalCorpus(udInput(seed.storage)), raw = seed.state().sources.get(first.annotationSourceVersionId)!;
  const f = fixture(), original = { ...structuredClone(raw), role: undefined, metadata: { ...raw.metadata as object, acquiredEarlier: true } };
  f.state().sources.set(original.sourceVersionId, original);
  for (const [id, bytes] of seed.state().blobs) f.state().blobs.set(id, new Uint8Array(bytes));
  const spans = [...seed.state().spans.values()].filter(span => span.sourceVersionId === original.sourceVersionId)
    .map(span => ({ ...structuredClone(span), id: `${span.id}.opaque` as EvidenceSpan["id"], provenance: { earlier: "retain verbatim" } }));
  for (const span of spans) f.state().spans.set(span.id, span);
  const rawBefore = structuredClone(original), spansBefore = structuredClone(spans);
  const putSource = f.storage.evidence.putSourceVersion, putSpans = f.storage.evidence.putEvidenceSpans!;
  f.storage.evidence.putSourceVersion = async row => { expect(row.sourceVersionId).not.toBe(original.sourceVersionId); await putSource(row); };
  f.storage.evidence.putEvidenceSpans = async rows => { expect(rows.some(row => row.sourceVersionId === original.sourceVersionId)).toBe(false); await putSpans(rows); };
  const result = await ingestUdLexicalCorpus(udInput(f.storage));
  expect(result.sourceVersionId).toBe(first.sourceVersionId);
  expect(f.state().sources.get(original.sourceVersionId)).toEqual(rawBefore);
  for (const span of spansBefore) expect(f.state().spans.get(span.id)).toEqual(span);
  expect([...f.state().spans.values()].filter(span => span.sourceVersionId === original.sourceVersionId)).toHaveLength(spans.length);
  const events = f.events.length;
  expect(await ingestUdLexicalCorpus({ ...udInput(f.storage), retainedSourceVersionId: original.sourceVersionId })).toEqual(result);
  expect(f.events).toHaveLength(events);
});

it("reuses retained WordNet annotation rows during current-projection repair without rewriting the raw owner", async () => {
  const f = fixture(), input = { storage: f.storage, text: wordnet, sourceUri: "fixture://retained/wordnet", informationLabel: label, maxSourceBytes: 65536, updatedAt: 1 };
  const first = await ingestWordnetCorpus(input), original = f.state().sources.get(first.annotationSourceVersionId)!;
  const rawBefore = structuredClone(original), spansBefore = structuredClone([...f.state().spans.values()].filter(span => span.sourceVersionId === original.sourceVersionId));
  const counts = { sources: f.state().sources.size, spans: f.state().spans.size, profiles: f.state().profiles.size };
  const putSource = f.storage.evidence.putSourceVersion, putSpans = f.storage.evidence.putEvidenceSpans!, putBlob = f.storage.blobs.put;
  f.storage.evidence.putSourceVersion = async row => { expect(row.sourceVersionId).not.toBe(original.sourceVersionId); await putSource(row); };
  f.storage.evidence.putEvidenceSpans = async rows => { expect(rows.some(row => spansBefore.some(old => old.id === row.id))).toBe(false); await putSpans(rows); };
  f.storage.blobs.put = async (bytes, mediaType) => { expect(hash(bytes)).not.toBe(original.contentHash); return putBlob(bytes, mediaType); };
  removeFixtureLanguagePatternProjections(f.storage.languageMemory);
  const repaired = await ingestWordnetCorpus({ ...input, retainedSourceVersionId: original.sourceVersionId });
  expect(repaired).toEqual(first);
  expect({ sources: f.state().sources.size, spans: f.state().spans.size, profiles: f.state().profiles.size }).toEqual(counts);
  expect(f.state().sources.get(original.sourceVersionId)).toEqual(rawBefore);
  for (const span of spansBefore) expect(f.state().spans.get(span.id)).toEqual(span);
  const cold = structuredClone(f.state()), source = cold.sources.get(repaired.sourceVersionId)!;
  for (const pattern of [...cold.patterns.values()].filter(row => row.profileId === repaired.profileId && (row.patternJson as { schema?: string }).schema === LEXICAL_SENSE_SCHEMA)) {
    expect(verifySourceOwnedLexicalPattern({ pattern, source, evidenceOwners: [cold.sources.get(original.sourceVersionId)!],
      evidence: pattern.evidenceIds.map(id => cold.spans.get(id)!) }, { hasher, informationAccess: { tenantId: label.tenantId, principalId: "reader", compartments: [], maximumExportClass: "public" } })).toBeDefined();
  }
});

it.each(["quarantined", "coordinates", "label"])("does not replace a retained annotation whose %s port is invalid", async failure => {
  const f = fixture(), first = await ingestUdLexicalCorpus(udInput(f.storage)), original = f.state().sources.get(first.annotationSourceVersionId)!;
  const span = [...f.state().spans.values()].find(row => row.sourceVersionId === original.sourceVersionId)!;
  if (failure === "quarantined") span.status = "quarantined";
  if (failure === "coordinates") span.charEnd++;
  if (failure === "label") span.informationLabel = { ...label, exportClass: "restricted", principals: ["reader"] };
  const before = structuredClone({ sources: [...f.state().sources], spans: [...f.state().spans], profiles: [...f.state().profiles] });
  removeFixtureLanguagePatternProjections(f.storage.languageMemory);
  await expect(ingestUdLexicalCorpus({ ...udInput(f.storage), retainedSourceVersionId: original.sourceVersionId })).rejects.toThrow("retained source evidence range");
  expect({ sources: [...f.state().sources], spans: [...f.state().spans], profiles: [...f.state().profiles] }).toEqual(before);
});

it("compiles genuine UD HEAD-aligned question frames through the same verified raw annotation publication", async () => {
  const text = await readFile(new URL("./fixtures/ud-ewt-question-excerpt.conllu", import.meta.url), "utf8");
  const provenance = JSON.parse(await readFile(new URL("./fixtures/ud-ewt-question-excerpt.provenance.json", import.meta.url), "utf8"));
  expect(hasher.digestHex(text)).toBe(provenance.excerptSha256);
  const repeated = `${text}${text}`, parsed = readUdLexicalGrammar(repeated);
  const question = parsed.patterns.find(row => (row.patternJson as { schema?: string }).schema === SOURCE_QUESTION_FRAME_SCHEMA)!;
  expect(question.support).toBe(2);
  expect(question.patternJson).toMatchObject({ prefix: "What is ", suffix: "?", lexicalUnits: ["what", "is"] });
  expect(question.ranges).toHaveLength(6);
  expect(question.ranges.every(range => range.end <= text.length)).toBe(true);
  const damaged = readUdLexicalGrammar(text.replace("\t1\tnsubj\t", "\t2\tnsubj\t"));
  expect(damaged.patterns.some(row => (row.patternJson as { schema?: string }).schema === SOURCE_QUESTION_FRAME_SCHEMA)).toBe(false);
  const f = fixture();
  const identity = (await f.storage.languageIdentities!.listIdentities())[0]!;
  f.storage.languageIdentities!.listIdentities = async () => [{ ...identity, closedClass: [{ word: "what", documentShare: 1 }] }];
  const result = await ingestUdLexicalCorpus({ ...udInput(f.storage), text: repeated });
  const state = f.state(), source = state.sources.get(result.sourceVersionId)!, original = state.sources.get(result.annotationSourceVersionId)!;
  const pattern = [...state.patterns.values()].find(row => (row.patternJson as { schema?: string }).schema === SOURCE_QUESTION_FRAME_SCHEMA)!;
  expect(verifySourceOwnedLexicalPattern({ pattern, source, evidenceOwners: [original], evidence: pattern.evidenceIds.map(id => state.spans.get(id)!) }, {
    hasher, informationAccess: { tenantId: label.tenantId, principalId: "reader", compartments: [], maximumExportClass: "public" }
  })).toBeDefined();
});

it("rejects missing caller labels and explicit source-capacity overruns before storage access", async () => {
  const storage = new Proxy({}, { get() { throw new Error("storage accessed"); } }) as ReturnType<typeof fixture>["storage"];
  await expect(ingestUdLexicalCorpus({ ...udInput(storage), maxSourceBytes: 1 })).rejects.toBeInstanceOf(LexicalCorpusCapacityError);
  await expect(ingestUdLexicalCorpus({ ...udInput(storage), informationLabel: undefined! })).rejects.toThrow(/explicit source information label/);
});

it("bounds raw and decompressed bytes before accepting exact UTF-8 source input", async () => {
  const root = await mkdtemp(join(tmpdir(), "scce-lexical-")); roots.push(root);
  const plain = join(root, "source"), compressed = join(root, "gzip"), malformed = join(root, "malformed");
  await writeFile(plain, conllu); await writeFile(compressed, gzipSync(conllu)); await writeFile(malformed, Buffer.from([0xff]));
  expect(await readBoundedLexicalCorpusSource({ path: plain, maxSourceBytes: Buffer.byteLength(conllu) })).toBe(conllu);
  expect(await readBoundedLexicalCorpusSource({ path: compressed, maxSourceBytes: Buffer.byteLength(conllu) })).toBe(conllu);
  await expect(readBoundedLexicalCorpusSource({ path: plain, maxSourceBytes: 1 })).rejects.toBeInstanceOf(LexicalCorpusCapacityError);
  await expect(readBoundedLexicalCorpusSource({ path: compressed, maxSourceBytes: gzipSync(conllu).length })).rejects.toBeInstanceOf(LexicalCorpusCapacityError);
  await expect(readBoundedLexicalCorpusSource({ path: malformed, maxSourceBytes: 1 })).rejects.toThrow();
});
