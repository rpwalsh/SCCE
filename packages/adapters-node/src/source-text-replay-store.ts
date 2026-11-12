// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher, validateLanguageSegmentationWitness, LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA,
  INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA, SYNTAX_SOURCE_REPLAY_KEY, SEMANTIC_SOURCE_REPLAY_SCHEMA,
  encodeSyntaxSourceReplay, decodeSyntaxSourceReplay, syntaxSourceReplayBindingSetReference,
  encodeSemanticSourceReplay, decodeSemanticSourceReplay, semanticSourceReplayBindingSetReference,
  captureSourceTextReplayBindings, resolveSourceTextReplayBindingSet,
  validateSourceTextReplayBindingSet, validateSourceTextReplayBindingSetReference,
  sourceTextReplayJson as exact, sourceTextReplayRecord as record,
  type LanguageInductionDocument, type LanguageSegmentationWitness, type SemanticInductionFactors,
  type SourceTextReplayBinding, type SourceTextReplayBindingSet, type SourceTextReplayBindingSetReference,
  type ResolvedSourceTextReplayBindingSet, type SourceTextReplayContext, type EvidenceId, type SourceVersionId
} from "@scce/kernel";
import type { SegmentationArchiveStorageAccess } from "./segmentation-witness-archive-storage.js";
import { DECODED_JSON_BYTE_LEDGER_KEY, decodedJsonByteLedger, isDecodedJsonByteLedger,
  verifyDecodedJsonByteLedger } from "./decoded-json-byte-ledger.js";

export interface SourceReplayScope { modelId: string; profileId?: string; sourceCompilationId?: string }
export interface SourceTextReplayStorageHost extends SegmentationArchiveStorageAccess {
  /** Resolve and authorize the existing canonical manifest/source-witness archive, never another text copy. */
  loadWitness(scope: SourceReplayScope, reference?: unknown): Promise<LanguageSegmentationWitness>;
  /** Needed only for standalone syntax writes; original order is absent from sorted witness populations. */
  loadSemanticFactors?(scope: SourceReplayScope): Promise<unknown>;
  /** Publish exactly one access-controlled binding set for this model/profile/manifest scope. */
  publishBindingSet(input: { scope: SourceReplayScope; witnessReference?: unknown;
    bindings: readonly SourceTextReplayBinding[] }): Promise<SourceTextReplayBindingSetReference>;
  /** Resolve an access-controlled set; missing, inaccessible, or changed rows fail closed. */
  loadBindingSet(scope: SourceReplayScope, reference: SourceTextReplayBindingSetReference): Promise<SourceTextReplayBindingSet>;
}
export interface SourceTextReplayStorageInput { value: unknown; logicalValue?: unknown; scope?: SourceReplayScope }
const hasher = createHasher(), fail = (): never => { throw Error("invalid or unavailable source text replay storage"); };
const factorSchema = "scce.semantic_induction_factors.v1", projectionSchema = "scce.semantic_induction_projection.v1";
const tapeSchema = "scce.semantic_projection.json.v1";
const scopeKey = (scope: SourceReplayScope) => exact([scope.modelId, scope.profileId ?? null, scope.sourceCompilationId ?? null]);
function scopeOf(node: Record<string, unknown>, inherited?: SourceReplayScope): SourceReplayScope {
  const modelId = typeof node.modelId === "string" ? node.modelId : typeof node.id === "string" ? node.id : inherited?.modelId;
  const profileId = typeof node.profileId === "string" ? node.profileId : inherited?.profileId;
  const sourceCompilationId = typeof node.sourceCompilationId === "string" ? node.sourceCompilationId : inherited?.sourceCompilationId;
  if (!modelId) return fail(); return { modelId, ...(profileId ? { profileId } : {}), ...(sourceCompilationId ? { sourceCompilationId } : {}) };
}
function projection(node: Record<string, unknown>): { value: Record<string, unknown>; opaque: boolean } | undefined {
  const value = record(node.semanticInductionProjection); if (!value) return undefined;
  if (value.schema === projectionSchema) return { value, opaque: false };
  if (value.schema !== tapeSchema || Object.keys(value).sort().join(",") !== "digest,schema,text"
    || typeof value.text !== "string" || value.text.length > 64 * 1024 * 1024 || hasher.digestHex(value.text) !== value.digest) return fail();
  let parsed: unknown; try { parsed = JSON.parse(value.text); } catch { return fail(); }
  const decoded = record(parsed); if (decoded?.schema !== projectionSchema) return fail();
  return { value: decoded, opaque: true };
}
function withProjection(node: Record<string, unknown>, value: Record<string, unknown>, opaque: boolean): Record<string, unknown> {
  if (!opaque) return { ...node, semanticInductionProjection: value };
  const text = JSON.stringify(value); return { ...node, semanticInductionProjection: { schema: tapeSchema, text, digest: hasher.digestHex(text) } };
}
function factorsOf(node: Record<string, unknown>): unknown {
  return node.semanticInductionFactors ?? projection(node)?.value.factors;
}
function syntaxNode(node: Record<string, unknown>): boolean {
  return node.schema === INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA && Object.hasOwn(node, "templates")
    || Object.hasOwn(node, "syntaxTemplates");
}
function eligible(node: Record<string, unknown>, decoding: boolean): boolean {
  if (Object.hasOwn(node, SYNTAX_SOURCE_REPLAY_KEY) || !decoding && syntaxNode(node)) return true;
  const factors = record(factorsOf(node));
  return factors?.schema === (decoding ? SEMANTIC_SOURCE_REPLAY_SCHEMA : factorSchema);
}
function inspect(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  let count = 0; const active = new WeakSet<object>();
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object") return;
    if (++count > 1_000_000 || depth > 128 || active.has(value)
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => item.get || item.set)) return fail();
    active.add(value);
    try { const node = record(value); if (node) visit(node); for (const child of Object.values(value)) walk(child, depth + 1); }
    finally { active.delete(value); }
  }; walk(value, 0);
}

/** Async source-loader boundary composed AFTER durable encode and BEFORE durable decode. */
export function createSourceTextReplayStore(host: SourceTextReplayStorageHost) {
  async function run(inputs: readonly SourceTextReplayStorageInput[], decoding: boolean): Promise<unknown[]> {
    const references = new Map<string, unknown>(), factorsByScope = new Map<string, unknown>();
    let found = false;
    for (const input of inputs) {
      // Raw arrays have no durable parent ledger envelope; preserve them inline.
      if (Array.isArray(input.value)) continue;
      inspect(input.value, node => {
        if (!eligible(node, decoding)) return; found = true;
        const scope = scopeOf(node, input.scope), key = scopeKey(scope);
        if (node.segmentationWitness !== undefined) references.set(key, node.segmentationWitness);
        const factors = factorsOf(node); if (factors !== undefined) factorsByScope.set(key, factors);
      });
    }
    if (!found) return inputs.map(input => input.value);
    const witnessCache = new Map<string, Promise<LanguageSegmentationWitness>>();
    const ownerCache = new Map<string, Promise<SourceTextReplayContext>>();
    const bindingSetCache = new Map<string, Promise<SourceTextReplayBindingSet>>();
    const resolvedReadCache = new Map<string, Promise<ResolvedSourceTextReplayBindingSet>>();
    const resolvedWriteCache = new Map<string, Promise<ResolvedSourceTextReplayBindingSet>>();
    const witnessFor = (scope: SourceReplayScope, manifestPatternId?: string): Promise<LanguageSegmentationWitness> => {
      const key = exact([scopeKey(scope), manifestPatternId ?? null]); let pending = witnessCache.get(key);
      if (!pending) { pending = (async () => {
        const ownedReference = references.get(scopeKey(scope));
        const reference = manifestPatternId === undefined ? ownedReference
          : { schema: LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA, manifestPatternId };
        if (manifestPatternId !== undefined && record(ownedReference)?.schema === LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA
          && record(ownedReference)?.manifestPatternId !== manifestPatternId) return fail();
        const witness = manifestPatternId === undefined && record(reference)?.schema === LANGUAGE_SEGMENTATION_WITNESS_SCHEMA
          ? reference as LanguageSegmentationWitness : await host.loadWitness(scope, reference);
        validateLanguageSegmentationWitness(witness); return witness;
      })(); witnessCache.set(key, pending); }
      return pending;
    };
    const contextFor = async (scope: SourceReplayScope, manifestPatternId?: string): Promise<SourceTextReplayContext> => {
      const key = exact([scopeKey(scope), manifestPatternId ?? null]); let pending = ownerCache.get(key);
      if (!pending) { pending = (async () => {
        const witness = await witnessFor(scope, manifestPatternId), documents = witness.populations.flatMap(population => population.documents);
        const ids = [...new Set(documents.map(document => document.ownerDocumentId))];
        const loaded = await host.getOwnerDocuments(ids);
        if (loaded.size !== ids.length || ids.some(id => !loaded.has(id))) return fail();
        for (const document of documents) {
          const owner = loaded.get(document.ownerDocumentId)!;
          if (typeof owner.text !== "string" || !owner.sourceVersionId
            || document.sourceVersionId !== undefined && document.sourceVersionId !== owner.sourceVersionId
            || owner.text.slice(document.sourceUtf16Start, document.sourceUtf16End) !== document.text) return fail();
        }
        return { hasher, owners: new Map([...loaded].map(([id, owner]) => [id, { text: owner.text, sourceVersionId: owner.sourceVersionId as SourceVersionId }])) };
      })(); ownerCache.set(key, pending); }
      return pending;
    };
    const bindingSetFor = (scope: SourceReplayScope, reference: SourceTextReplayBindingSetReference): Promise<SourceTextReplayBindingSet> => {
      const normalized = validateSourceTextReplayBindingSetReference(reference), key = exact([scopeKey(scope), normalized.id]);
      let pending = bindingSetCache.get(key);
      if (!pending) { pending = host.loadBindingSet(scope, normalized).then(value => {
        const bindingSet = validateSourceTextReplayBindingSet(value);
        if (bindingSet.modelId !== scope.modelId || scope.profileId !== undefined && bindingSet.profileId !== scope.profileId) return fail();
        return bindingSet;
      }); bindingSetCache.set(key, pending); }
      return pending;
    };
    const resolvedForRead = (scope: SourceReplayScope, reference: SourceTextReplayBindingSetReference): Promise<ResolvedSourceTextReplayBindingSet> => {
      const normalized = validateSourceTextReplayBindingSetReference(reference), key = exact([scopeKey(scope), normalized.id]);
      let pending = resolvedReadCache.get(key);
      if (!pending) { pending = (async () => {
        const bindingSet = await bindingSetFor(scope, normalized), witness = await witnessFor(scope, bindingSet.manifestPatternId);
        const context = await contextFor(scope, bindingSet.manifestPatternId);
        const byId = new Map(witness.populations.flatMap(population => population.documents).map(document => [document.documentId, document]));
        if (byId.size !== bindingSet.documents.length) return fail();
        const documents = bindingSet.documents.map(header => {
          const source = byId.get(header.documentId), owner = source && context.owners.get(source.ownerDocumentId);
          if (!source || !owner || source.sourceVersionId !== undefined && source.sourceVersionId !== owner.sourceVersionId
            || !header.windowed && (source.ownerDocumentId !== source.documentId || source.sourceUtf16Start !== 0
              || source.sourceUtf16End !== owner.text.length)) return fail();
          return { id: source.documentId, text: source.text, sourceVersionId: owner.sourceVersionId!,
            sourceFamilyId: source.sourceFamilyId, evidenceIds: [...source.evidenceIds] as EvidenceId[],
            ...(header.trust !== null ? { trust: header.trust } : {}),
            ...(header.windowed ? { sourceWindow: { ownerDocumentId: source.ownerDocumentId,
              startUtf16: source.sourceUtf16Start, endUtf16: source.sourceUtf16End } } : {}) } as LanguageInductionDocument;
        });
        const bindings = captureSourceTextReplayBindings(documents, context);
        resolveSourceTextReplayBindingSet({ reference: normalized, bindingSet, bindings, hasher });
        return { hasher, bindingSet: normalized, documents };
      })(); resolvedReadCache.set(key, pending); }
      return pending;
    };
    const documentsFor = async (scope: SourceReplayScope): Promise<LanguageInductionDocument[]> => {
      const key = scopeKey(scope); let factors = factorsByScope.get(key);
      if (factors === undefined) factors = await host.loadSemanticFactors?.(scope);
      if (record(factors)?.schema === SEMANTIC_SOURCE_REPLAY_SCHEMA) {
        return [...(await resolvedForRead(scope, semanticSourceReplayBindingSetReference(factors, hasher))).documents];
      }
      const header = record(factors), headers = header?.documents;
      if (!header || !Array.isArray(headers) || typeof header.trackSourceWindows !== "boolean") return fail();
      const context = await contextFor(scope), witness = await witnessFor(scope);
      const byId = new Map(witness.populations.flatMap(population => population.documents).map(document => [document.documentId, document]));
      if (byId.size !== headers.length || new Set(headers.map(item => record(item)?.id)).size !== headers.length) return fail();
      return headers.map(raw => {
        const item = record(raw), source = typeof item?.id === "string" ? byId.get(item.id) : undefined;
        if (!item || !source || typeof item.sourceId !== "string" || typeof item.trust !== "number" || !Number.isFinite(item.trust)
          || !Array.isArray(item.evidenceIds) || !item.evidenceIds.every(id => typeof id === "string")
          || exact([...new Set(item.evidenceIds)].sort()) !== exact(source.evidenceIds)) return fail();
        const owner = context.owners.get(source.ownerDocumentId)!;
        const window = header.trackSourceWindows ? record(item.sourceWindow) : undefined;
        if (header.trackSourceWindows && (!window || window.ownerDocumentId !== source.ownerDocumentId
          || window.startUtf16 !== source.sourceUtf16Start || window.endUtf16 !== source.sourceUtf16End)) return fail();
        return { id: source.documentId, text: source.text, sourceVersionId: owner.sourceVersionId!, sourceFamilyId: item.sourceId,
          evidenceIds: [...item.evidenceIds] as EvidenceId[], trust: item.trust,
          ...(window ? { sourceWindow: { ownerDocumentId: source.ownerDocumentId, startUtf16: source.sourceUtf16Start, endUtf16: source.sourceUtf16End } } : {}) };
      });
    };
    const resolvedForWrite = (scope: SourceReplayScope): Promise<ResolvedSourceTextReplayBindingSet> => {
      const key = scopeKey(scope); let pending = resolvedWriteCache.get(key);
      if (!pending) { pending = (async () => {
        const documents = await documentsFor(scope), context = await contextFor(scope);
        const bindingSet = await host.publishBindingSet({ scope, witnessReference: references.get(key),
          bindings: captureSourceTextReplayBindings(documents, context) });
        return { hasher, bindingSet: validateSourceTextReplayBindingSetReference(bindingSet), documents };
      })(); resolvedWriteCache.set(key, pending); }
      return pending;
    };
    const change = async (value: unknown, inherited?: SourceReplayScope): Promise<unknown> => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { const next = []; let changed = false; for (const item of value) { const result = await change(item, inherited); changed ||= result !== item; next.push(result); } return changed ? next : value; }
      const node = record(value)!;
      if (eligible(node, decoding)) {
        const scope = scopeOf(node, inherited);
        let next = node;
        if (decoding) {
          if (Object.hasOwn(next, SYNTAX_SOURCE_REPLAY_KEY)) {
            const reference = syntaxSourceReplayBindingSetReference(next, hasher) ?? fail();
            next = decodeSyntaxSourceReplay(next, await resolvedForRead(scope, reference));
          }
          const rawFactors = record(next.semanticInductionFactors);
          if (rawFactors?.schema === SEMANTIC_SOURCE_REPLAY_SCHEMA) {
            const resolved = await resolvedForRead(scope, semanticSourceReplayBindingSetReference(rawFactors, hasher));
            next = { ...next, semanticInductionFactors: decodeSemanticSourceReplay(rawFactors, resolved) };
          }
          const projected = projection(next);
          if (record(projected?.value.factors)?.schema === SEMANTIC_SOURCE_REPLAY_SCHEMA) {
            const resolved = await resolvedForRead(scope, semanticSourceReplayBindingSetReference(projected!.value.factors, hasher));
            next = withProjection(next, { ...projected!.value, factors: decodeSemanticSourceReplay(projected!.value.factors, resolved) }, projected!.opaque);
          }
        } else {
          if (Object.hasOwn(next, SYNTAX_SOURCE_REPLAY_KEY)) return fail();
          const resolved = await resolvedForWrite(scope);
          if (syntaxNode(next)) next = encodeSyntaxSourceReplay(next, resolved);
          const rawFactors = record(next.semanticInductionFactors);
          if (rawFactors?.schema === factorSchema) next = { ...next, semanticInductionFactors: encodeSemanticSourceReplay(rawFactors as unknown as SemanticInductionFactors, resolved) };
          const projected = projection(next);
          if (record(projected?.value.factors)?.schema === factorSchema) {
            next = withProjection(next, { ...projected!.value, factors: encodeSemanticSourceReplay(projected!.value.factors as SemanticInductionFactors, resolved) }, projected!.opaque);
          }
        }
        let changed = next !== node; const children: Array<[string, unknown]> = [];
        for (const [key, child] of Object.entries(next)) {
          if (key === SYNTAX_SOURCE_REPLAY_KEY || key === "semanticInductionFactors" || key === "semanticInductionProjection") {
            children.push([key, child]); continue;
          }
          const result = await change(child, scope); changed ||= result !== child; children.push([key, result]);
        }
        return changed ? Object.fromEntries(children) : node;
      }
      let modified = false; const entries: Array<[string, unknown]> = [];
      for (const [key, child] of Object.entries(node)) { const result = await change(child, inherited); modified ||= result !== child; entries.push([key, result]); }
      return modified ? Object.fromEntries(entries) : value;
    };
    const results = [];
    for (const input of inputs) {
      if (Array.isArray(input.value)) { results.push(input.value); continue; }
      const next = await change(input.value, input.scope);
      if (!decoding && next !== input.value) {
        const root = record(next) ?? fail(), original = record(input.value) ?? fail();
        const ledger = original[DECODED_JSON_BYTE_LEDGER_KEY];
        if (ledger !== undefined) {
          if (!isDecodedJsonByteLedger(ledger)) return fail();
          if (input.logicalValue !== undefined) verifyDecodedJsonByteLedger(original, input.logicalValue);
          results.push(root);
        } else results.push({ ...root, [DECODED_JSON_BYTE_LEDGER_KEY]: decodedJsonByteLedger(input.logicalValue ?? input.value) });
      } else results.push(next);
    }
    return results;
  }
  return {
    encodeMany: (inputs: readonly SourceTextReplayStorageInput[]) => run(inputs, false),
    /** Leaves the original parent ledger for the subsequent durable decoder to verify and remove. */
    decodeMany: (values: readonly unknown[], scopes: readonly (SourceReplayScope | undefined)[] = []) =>
      run(values.map((value, index) => ({ value, scope: scopes[index] })), true)
  };
}
