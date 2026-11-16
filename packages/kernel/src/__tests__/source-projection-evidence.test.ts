// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { createHasher, createClock } from "../primitives.js";
import { resolveCanonicalSourceProjectionEvidence, sourceProjectionDocumentation } from "../source-projection-evidence.js";
import { evidenceIdentityBinding, evidenceWithGraphPreviewWindows, sourceIdentityAdmissibleEvidenceForRequest } from "../local-evidence-runtime.js";
import { retrievalBinding, retrievalBindingSupports } from "../retrieval-binding.js";
import { createRuntimeGraphRetrieval } from "../runtime-graph-retrieval.js";
import { codeIntentFromDocumentation } from "../code-intent.js";
import { createEvaluationCondition } from "../evaluation-flags.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";
import type { EvidenceStore, ScceKernelDeps } from "../storage.js";
import type { ContentHash, EvidenceSpan, GraphSliceQuery, InformationAccessContext, InformationLabel, JsonValue, SourceTrust, SourceVersion, SourceVersionId } from "../types.js";

afterEach(() => clearCorpusIdentitySignals());
const label: InformationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: ["owned"], exportClass: "internal", mergePolicy: "same_owner" };
const access: InformationAccessContext = { tenantId: label.tenantId, principalId: label.principals[0]!, compartments: ["owned"], maximumExportClass: "internal" };
const trust: SourceTrust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "owned", licenseStatus: "fixture" };
const digest = (text: string) => `sha256_${createHasher().digestHex(text)}` as ContentHash;
const record = (value: JsonValue) => value as Record<string, JsonValue>;

function fixture(kind: "yaml" | "javascript" = "yaml", declaredAlias?: string) {
  const alias = declaredAlias ?? (kind === "yaml" ? "δοκιμή" : "設定資料"), path = kind === "yaml" ? "資料/opaque.yml" : "δομή/opaque.js";
  const rawText = kind === "yaml" ? "enabled: true\nlimits:\n  retries: 17\n" : "export function opaque() {\n  return 17;\n}\n";
  const docText = `${alias}\nopaque document identifiers\n`, rawHash = digest(rawText), canonicalUri = "fixture://opaque-owner/source";
  const metadata = (projection: string, title: string) => ({ projection, title, identity: title, relativePath: path,
    sourceHash: rawHash, repository: { identityKind: "local_root", ownerUri: "fixture://opaque-owner" } });
  const source = (lane: string, projection: string, text: string, title: string): SourceVersion => ({ sourceId: `source.${lane}` as SourceVersion["sourceId"],
    sourceVersionId: `version.${lane}` as SourceVersionId, namespace: `corpus.${lane}`, canonicalUri, contentHash: digest(text),
    mediaType: kind === "yaml" ? "application/yaml" : "application/javascript", observedAt: 1, byteLength: new TextEncoder().encode(text).length,
    sourceTrust: trust, metadata: metadata(projection, title), informationLabel: label, role: "evidence-derivative",
    derivation: { kind: "extracted-text", transformId: `fixture.${projection}`, derivedFromSourceVersionId: `version.${lane}.original` as SourceVersionId,
      originalCoordinateSpace: "source-bytes", redactionMap: [] } });
  const docOwner = source("doc", "code_adjacent_prose", docText, alias), rawOwner = source("raw", "code_surface_tokens", rawText, "opaque");
  const original = (owner: SourceVersion): SourceVersion => ({ ...owner, sourceVersionId: owner.derivation!.derivedFromSourceVersionId,
    contentHash: rawHash, byteLength: new TextEncoder().encode(rawText).length, role: "original", derivation: undefined });
  const docOriginal = original(docOwner), rawOriginal = original(rawOwner);
  const span = (owner: SourceVersion, text: string): EvidenceSpan => ({ id: `evidence.${owner.sourceId}` as EvidenceSpan["id"], sourceId: owner.sourceId,
    sourceVersionId: owner.sourceVersionId, chunkId: `chunk.${owner.sourceId}` as EvidenceSpan["chunkId"], contentHash: digest(text),
    mediaType: owner.mediaType, byteStart: 0, byteEnd: new TextEncoder().encode(text).length, charStart: 0, charEnd: [...text].length,
    text, textPreview: text, languageHints: [], scriptHints: [], trustVector: {}, provenance: { ...record(owner.metadata), sourceKind: "developer_intelligence" },
    features: [], status: "promoted", alpha: 1, observedAt: 1, informationLabel: label });
  const doc = span(docOwner, docText), raw = span(rawOwner, rawText), spans = new Map([[doc.id, doc], [raw.id, raw]]);
  const versions = new Map([docOwner, rawOwner, docOriginal, rawOriginal].map(row => [row.sourceVersionId, row]));
  const searches: Array<Parameters<EvidenceStore["searchEvidence"]>[0]> = [];
  const store: EvidenceStore = {
    async putSourceVersion() { throw Error("unexpected write"); }, async putEvidenceSpan() { throw Error("unexpected write"); }, async promoteEvidence() { throw Error("unexpected write"); },
    async getEvidence(id) { return structuredClone(spans.get(id) ?? null); },
    async getEvidenceBatch(ids) { return structuredClone(ids.flatMap(id => spans.has(id) ? [spans.get(id)!] : [])); },
    async sourceVersionsForEvidence(ids) { return structuredClone([...new Set(ids.flatMap(id => spans.get(id)?.sourceVersionId ?? []))].flatMap(id => versions.has(id) ? [versions.get(id)!] : [])); },
    async sourceVersionById(id) { return structuredClone(versions.get(id) ?? null); },
    async sourceVersionsByContentHashes(hashes) { return structuredClone([...versions.values()].filter(row => hashes.includes(row.contentHash))); },
    async listEvidenceBackedSourceVersions(query) { return [...versions.values()].filter(row => query?.sourceVersionIds?.includes(row.sourceVersionId)).map(row => ({
      sourceVersionId: row.sourceVersionId, contentHash: row.contentHash, canonicalUri: row.canonicalUri, byteLength: row.byteLength, maxAlpha: 1,
      promotedSpanCount: [...spans.values()].filter(span => span.sourceVersionId === row.sourceVersionId && span.status === "promoted").length })); },
    async searchEvidence(query) { searches.push(query); return structuredClone([...spans.values()].filter(row => query.sourceVersionId ? row.sourceVersionId === query.sourceVersionId : row.id === doc.id)
      .map(span => ({ span, score: 1, reason: "fixture" }))); }
  };
  const prime = () => primeCorpusIdentitySignals({ closedClass: new Set(), identities: new Set([alias]), spread: new Map([[alias, 1]]), concentration: 1 });
  return { alias, path, doc, raw, docOwner, rawOwner, docOriginal, rawOriginal, versions, spans, store, searches, prime,
    resolve: () => resolveCanonicalSourceProjectionEvidence({ store, evidence: [doc], informationAccess: access }) };
}

it.each(["yaml", "javascript"] as const)("binds canonical %s bytes through the existing exact documentation reference", async kind => {
  const f = fixture(kind); f.prime(); const result = await f.resolve(), raw = result.evidence[0]!;
  expect(result.refusals).toEqual([]); expect(result.bindings).toHaveLength(1); expect(result.contextEvidenceIds).toEqual([f.doc.id]);
  expect(result.evidence.map(span => span.id)).toEqual([f.raw.id]);
  expect([raw.text, raw.contentHash, raw.byteStart, raw.byteEnd, raw.charStart, raw.charEnd]).toEqual([
    f.raw.text, f.raw.contentHash, f.raw.byteStart, f.raw.byteEnd, f.raw.charStart, f.raw.charEnd]);
  expect(result.bindings[0]).toMatchObject({ relativePath: f.path, sourceContentHash: f.rawOwner.contentHash,
    documentationEvidenceId: f.doc.id, canonicalEvidenceIds: [f.raw.id] });
  expect(evidenceIdentityBinding(raw, f.alias)).toBe("projection");
  expect(retrievalBinding(raw, { requestText: f.alias }).mechanism).toBe("source_projection");
  expect(retrievalBindingSupports(retrievalBinding(raw, { requestText: f.alias }))).toBe(true);
  expect(sourceIdentityAdmissibleEvidenceForRequest(f.alias, [raw]).evidence.map(span => span.id)).toEqual([f.raw.id]);
  expect(f.searches[0]).toEqual({ sourceVersionId: f.rawOwner.sourceVersionId, status: "promoted", limit: 1 });
  expect(codeIntentFromDocumentation({ requestText: f.alias, documentation: [raw] }).references[0]).toMatchObject({
    relativePath: f.path, sourceFamily: "fixture://opaque-owner", sourceHash: f.rawOwner.contentHash });
});

it("keeps supported documentation intact when an exact owner reader is unavailable", async () => {
  const f = fixture(); f.store.sourceVersionById = undefined;
  const result = await f.resolve();
  expect(result.bindings).toEqual([]); expect(result.evidence).toEqual([f.doc]); expect(f.searches).toEqual([]);
  expect(result.refusals[0]?.reason).toBe("source_projection.owner_reader_unavailable");
});

it.each(["界線", "ξψ", "ci"])("binds the complete two-character identity %s and refuses a different measured whole anchor sharing its prefix", async alias => {
  const f = fixture("javascript", alias); f.prime(); const result = await f.resolve(), raw = result.evidence[0]!;
  const bound = retrievalBinding(raw, { requestText: alias });
  expect(bound.mechanism).toBe("source_projection"); expect(bound.sourceConstituents).toEqual([alias]);
  expect(bound.requestConstituents).toContain(alias);
  const differentAnchor = alias + "x";
  expect(evidenceIdentityBinding(f.doc, differentAnchor, undefined, [differentAnchor])).toBe("none");
  expect(evidenceIdentityBinding(raw, differentAnchor, undefined, [differentAnchor])).toBe("none");
  expect(retrievalBindingSupports(retrievalBinding(raw, { requestText: differentAnchor, anchors: [differentAnchor] }))).toBe(false);
});

it.each(["different_hash", "different_uri", "different_family", "missing_original", "conflicting_owners", "stale_documentation", "inaccessible_documentation", "inaccessible_source", "quarantined_raw", "missing_label", "redacted_lineage", "incomplete_inventory", "tampered_bytes"] as const)("refuses %s without manufacturing canonical evidence", async damage => {
  const f = fixture("javascript");
  if (damage === "different_hash") record(f.rawOwner.metadata).sourceHash = digest("another source");
  if (damage === "different_uri") f.rawOwner.canonicalUri += "/another";
  if (damage === "different_family") record(f.rawOwner.metadata).repository = { ownerUri: "fixture://different" };
  if (damage === "missing_original") f.versions.delete(f.docOriginal.sourceVersionId);
  if (damage === "conflicting_owners") {
    const other = structuredClone(f.rawOwner); other.sourceVersionId = "version.conflicting" as SourceVersionId; other.sourceId = "source.conflicting" as SourceVersion["sourceId"];
    f.versions.set(other.sourceVersionId, other);
  }
  if (damage === "stale_documentation") f.spans.set(f.doc.id, { ...f.doc, status: "quarantined" });
  if (damage === "inaccessible_documentation") f.spans.set(f.doc.id, { ...f.doc, informationLabel: { ...label, tenantId: "different" } });
  if (damage === "inaccessible_source") f.rawOwner.informationLabel = { ...label, tenantId: "different" };
  if (damage === "quarantined_raw") f.raw.status = "quarantined";
  if (damage === "missing_label") f.rawOriginal.informationLabel = undefined;
  if (damage === "redacted_lineage") f.docOwner.derivation!.kind = "redacted-text";
  if (damage === "incomplete_inventory") { const read = f.store.listEvidenceBackedSourceVersions!; f.store.listEvidenceBackedSourceVersions = async query => (await read(query)).map(row => ({ ...row, promotedSpanCount: 2 })); }
  if (damage === "tampered_bytes") f.raw.text = f.raw.text.replace("17", "19");
  const result = await f.resolve();
  expect(result.bindings).toEqual([]); expect(result.contextEvidenceIds).toEqual([]); expect(result.evidence.map(span => span.id)).toEqual([f.doc.id]);
  expect(result.refusals).toHaveLength(1); expect(sourceProjectionDocumentation(f.raw)).toBeUndefined();
});

it("retains the original label boundary, and serialized or byte-mutated relations have no authority", async () => {
  const f = fixture("javascript"); f.prime(); const result = await f.resolve(), raw = result.evidence[0]!;
  expect(raw.informationLabel).toEqual(label); expect(sourceProjectionDocumentation({ ...raw })).toBeDefined();
  expect(sourceProjectionDocumentation(structuredClone(raw))).toBeUndefined();
  expect(sourceProjectionDocumentation({ ...raw, text: raw.text.replace("17", "19") })).toBeUndefined();
  expect(sourceProjectionDocumentation({ ...raw, informationLabel: { ...label, exportClass: "public" } })).toBeUndefined();
  const graphNode = { id: "node.fixture", evidenceIds: [raw.id], representation: { preview: "a different graph preview" } };
  expect(evidenceWithGraphPreviewWindows(f.alias, [raw], [graphNode as never])[0]).toBe(raw);
});

it("uses the common text retrieval handoff, retaining documentation context while facts cite the canonical span", async () => {
  const f = fixture("javascript"); f.prime(); const graphQueries: GraphSliceQuery[] = [];
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 1 });
  const storage: ScceKernelDeps["storage"] = { ...base.storage, evidence: f.store, graph: { ...base.storage.graph,
    async getSlice(query: GraphSliceQuery) { graphQueries.push(query); return { nodes: [], edges: [], hyperedges: [], bounded: true, query }; } } };
  const retrieval = createRuntimeGraphRetrieval({ deps: { storage, informationAccess: access }, clock: createClock({ fixedTime: 1 }), hasher: createHasher(),
    candidates: undefined as never, failures: [], cacheMs: 0, kernelTrace: vi.fn(), sourceAnchorSemanticFramesCached: async () => [] });
  const result = await retrieval.graphForTextUncached(f.alias, ["anchor:sym:" + f.alias], [], false, false);
  expect(result.evidence.map(span => span.id)).toEqual([f.raw.id]); expect(result.evidence[0]!.text).toBe(f.raw.text);
  expect(result.sourceProjectionBindings).toHaveLength(1);
  expect(graphQueries.some(query => query.evidenceIds?.includes(f.doc.id) && query.evidenceIds.includes(f.raw.id))).toBe(true);
});

it("honors graph ablation at the common handoff while retaining canonical source evidence", async () => {
  const f = fixture("javascript"); f.prime(); const graphQueries: GraphSliceQuery[] = [];
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 1 });
  const storage: ScceKernelDeps["storage"] = { ...base.storage, evidence: f.store, graph: { ...base.storage.graph,
    async getSlice(query: GraphSliceQuery) { graphQueries.push(query); return { nodes: [], edges: [], hyperedges: [], bounded: true, query }; } } };
  const evaluationCondition = createEvaluationCondition({ conditionId: "no_graph", seed: "projection.fixture", clockIso: "2026-01-01T00:00:00.000Z" });
  const retrieval = createRuntimeGraphRetrieval({ deps: { storage, informationAccess: access, evaluationCondition }, clock: createClock({ fixedTime: 1 }), hasher: createHasher(),
    candidates: undefined as never, failures: [], cacheMs: 0, kernelTrace: vi.fn(), sourceAnchorSemanticFramesCached: async () => [] });
  const result = await retrieval.graphForTextUncached(f.alias, ["anchor:sym:" + f.alias], [], false, false);
  expect(result.evidence.map(span => span.id)).toEqual([f.raw.id]); expect(result.sourceProjectionBindings).toHaveLength(1);
  // The original graph-enabled method's one query remains; source resolution must not add another graph read.
  expect(graphQueries).toHaveLength(1); expect(graphQueries[0]!.evidenceIds).toEqual([f.doc.id]);
  graphQueries.length = 0;
  await retrieval.evidenceOnlyForText(f.alias, false);
  expect(graphQueries).toEqual([]);
});
