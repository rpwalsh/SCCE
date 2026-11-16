// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue, type ContentHash, type InformationLabel, type LanguagePatternProjection, type ScceStorage, type TranscriptTurn, SOURCE_COMPUTATION_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_COMPILER_FINGERPRINT, CONTEXTUAL_QA_SOURCE_SYSTEM, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, SOURCE_REQUEST_EDIT_RECIPE } from "@scce/kernel";

/** Changes only the conversational auxiliary component, never immutable source or base compilation identity. */
export const DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID = "scce.dialogue_conversational_construction.v2";
export const DIALOGUE_CONVERSATIONAL_CHECKPOINT_SCHEMA = "scce.dialogue_conversational_compilation.v2";
const EMPTY_RESULT_SCHEMA = "scce.dialogue_source_component_empty_result.v1";

export interface DialogueSourceComponentInput<T, Prepared = undefined> {
  storage: ScceStorage;
  rootUri: string;
  informationLabel: InformationLabel;
  authorship: string;
  sources: readonly { sourceUri: string; sourceVersionId: string; contentHash: string; byteLength: number; transcriptDigest?: string;
    /** Optional verified language-owner binding; when present it is part of the checkpoint identity. */
    languageIdentityId?: string; languageIdentityDigest?: string }[];
  /** Optional read/compute phase kept outside the short atomic publication transaction. */
  prepare?: () => Promise<Prepared>;
  compile: (prepared: Prepared) => Promise<{ report: T; projections: readonly LanguagePatternProjection[]; deferred?: boolean }>;
  unchanged: (completedEmptyReport?: T) => T;
}
export function conversationalCheckpointSources(sources: readonly { sourceUri: string; sourceVersionId: string; contentHash: string; byteLength: number; transcriptTurns?: readonly TranscriptTurn[] }[]): DialogueSourceComponentInput<unknown>["sources"] {
  const hasher = createHasher();
  return sources.map(({ sourceUri, sourceVersionId, contentHash, byteLength, transcriptTurns }) => ({ sourceUri, sourceVersionId, contentHash, byteLength,
    transcriptDigest: hasher.digestHex(canonicalStringify(transcriptTurns ?? null)) }));
}
export function prepareDialogueSourceComponentBinding(input: Pick<DialogueSourceComponentInput<unknown>, "rootUri" | "informationLabel" | "authorship" | "sources">): { binding: string; byteLength: number } {
  const sources = [...input.sources].sort((a, b) => a.sourceVersionId.localeCompare(b.sourceVersionId) || a.sourceUri.localeCompare(b.sourceUri));
  return { binding: canonicalStringify({ rootUri: input.rootUri, informationLabel: input.informationLabel, authorship: input.authorship, sources }),
    byteLength: sources.reduce((sum, source) => sum + source.byteLength, 0) };
}
export function runDialogueConversationalComponent<T, Prepared = undefined>(input:DialogueSourceComponentInput<T, Prepared>):Promise<T>{
  return runDialogueSourceComponent(input,DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID,DIALOGUE_CONVERSATIONAL_CHECKPOINT_SCHEMA,"dialogue_conversational_compilation");
}
export function runDialogueComputationComponent<T, Prepared = undefined>(input:DialogueSourceComponentInput<T, Prepared>):Promise<T>{
  return runDialogueSourceComponent(input,SOURCE_COMPUTATION_CONSTRUCTION_RECIPE,"scce.dialogue_computation_compilation.v1","dialogue_computation_compilation");
}
export function runDialogueContextualQaComponent<T, Prepared = undefined>(input:DialogueSourceComponentInput<T, Prepared>):Promise<T>{
  return runDialogueSourceComponent(input,CONTEXTUAL_QA_CONSTRUCTION_RECIPE,"scce.dialogue_contextual_qa_compilation.v1","dialogue_contextual_qa_compilation",CONTEXTUAL_QA_COMPILER_FINGERPRINT,true);
}
export function runDialogueRequestEditComponent<T, Prepared = undefined>(input:DialogueSourceComponentInput<T, Prepared>):Promise<T>{
  return runDialogueSourceComponent(input,SOURCE_REQUEST_EDIT_RECIPE,"scce.dialogue_request_edit_compilation.v1","dialogue_request_edit_compilation");
}
async function runDialogueSourceComponent<T, Prepared = undefined>(input:DialogueSourceComponentInput<T, Prepared>,recipe:string,schema:string,idPrefix:string,compilerFingerprint=recipe,requireOwnedPublication=false):Promise<T>{
  if (!input.sources.length) return input.unchanged();
  const hasher = createHasher();
  const { binding, byteLength } = prepareDialogueSourceComponentBinding(input);
  const contentHash = hasher.digestHex(binding) as ContentHash;
  const id = `${idPrefix}_${contentHash}`;
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const emptyReport = (value: unknown): value is T => {
    const report = object(value);
    return report.schema === "scce.dialogue_contextual_qa_report.v1" && report.compilerFingerprint === compilerFingerprint
      && Number.isSafeInteger(report.pairs) && Number(report.pairs) >= 0 && report.patternsPersisted === 0 && report.qualifiedFamilies === 0
      && Array.isArray(report.familyApplicability) && report.familyApplicability.length === 0 && report.unchanged === false
      && report.deferredProjections === undefined && Array.isArray(report.rejected)
      && report.rejected.every(raw => { const row = object(raw); return typeof row.bindingId === "string" && row.bindingId.length > 0
        && typeof row.reason === "string" && row.reason.length > 0; });
  };
  const verifyProjections = async (values: readonly unknown[], completeEmpty: boolean): Promise<boolean> => {
    if (requireOwnedPublication && values.length === 0) return false;
    const remaining = new Map(input.sources.map(source => [source.sourceVersionId, source]));
    if (completeEmpty && (remaining.size !== input.sources.length || values.length !== remaining.size || !input.storage.evidence.sourceVersionById)) return false;
    for (const raw of values) {
      const row = object(raw);
      if (typeof row.profileId !== "string" || typeof row.sourceId !== "string" || typeof row.sourceVersionId !== "string" || row.componentRecipe !== recipe
        || !Array.isArray(row.patternIds) || !row.patternIds.every(id => typeof id === "string") || !input.storage.languageMemory.getLanguagePatternProjection) return false;
      const projection = raw as LanguagePatternProjection;
      const active = await input.storage.languageMemory.getLanguagePatternProjection(projection);
      if (!active || canonicalStringify(active) !== canonicalStringify(projection)) return false;
      if (projection.patternIds.length) {
        const rows = await input.storage.languageMemory.listLanguagePatterns({ view: "request_seed", patternIds: projection.patternIds, limit: projection.patternIds.length });
        if (canonicalStringify(rows.map(row => row.id).sort()) !== canonicalStringify([...projection.patternIds].sort())) return false;
      }
      if (completeEmpty) {
        const source = remaining.get(projection.sourceVersionId);
        if (!source || projection.patternIds.length || projection.sourceSystem !== CONTEXTUAL_QA_SOURCE_SYSTEM
          || projection.patternSchema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA
          || canonicalStringify(projection.informationLabel) !== canonicalStringify(input.informationLabel)) return false;
        const owner = await input.storage.evidence.sourceVersionById!(projection.sourceVersionId);
        const digest = (value: string) => value.replace(/^sha256[_:]/u, "");
        if (!owner || owner.sourceId !== projection.sourceId || owner.sourceVersionId !== projection.sourceVersionId
          || owner.canonicalUri !== source.sourceUri || owner.byteLength !== source.byteLength
          || !/^[a-f0-9]{64}$/u.test(digest(source.contentHash)) || digest(String(owner.contentHash)) !== digest(source.contentHash)
          || canonicalStringify(owner.informationLabel) !== canonicalStringify(input.informationLabel)) return false;
        remaining.delete(projection.sourceVersionId);
      }
    }
    return !completeEmpty || remaining.size === 0;
  };
  const current = async () => {
    const row = await input.storage.ingestion.get(id), metadata = row?.metadata;
    const valid = row?.status === "complete" && row.phase === "stored" && row.rootUri === input.rootUri && row.itemUri === input.rootUri
      && row.contentHash === contentHash && row.byteLength === byteLength
      && metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      && metadata?.schema === schema && metadata.binding === binding
      && metadata.compilerFingerprint === compilerFingerprint;
    if (!valid || !metadata || typeof metadata !== "object" || Array.isArray(metadata) || !Array.isArray(metadata.projections)) return undefined;
    const completeEmpty = requireOwnedPublication && !metadata.projections.some(raw => Array.isArray(object(raw).patternIds) && (object(raw).patternIds as unknown[]).length > 0);
    const result = object(metadata.emptyResult);
    if (completeEmpty && (row?.offsetBytes !== byteLength || metadata.preparation !== undefined
      || result.schema !== EMPTY_RESULT_SCHEMA || !emptyReport(result.report)
      || result.reportDigest !== hasher.digestHex(canonicalStringify(result.report)))) return undefined;
    if (!await verifyProjections(metadata.projections, completeEmpty)) return undefined;
    return { ...(completeEmpty ? { completedEmptyReport: structuredClone(result.report) as T } : {}) };
  };
  const prior = await current();
  if (prior) return input.unchanged(prior.completedEmptyReport);
  const running = { id, rootUri: input.rootUri, itemUri: input.rootUri, phase: "extracting" as const, status: "running" as const,
    offsetBytes: 0, contentHash, byteLength, updatedAt: Date.now(), metadata: toJsonValue({
      schema, binding, compilerFingerprint, projections: [], preparation: "running"
    }) };
  let prepared = undefined as Prepared;
  if (input.prepare) {
    await input.storage.ingestion.put(running);
    try { prepared = await input.prepare(); }
    catch (error) {
      await input.storage.ingestion.put({ ...running, phase: "failed", status: "failed", updatedAt: Date.now(),
        reason: String(error instanceof Error ? error.message : error).slice(0, 500),
        metadata: toJsonValue({ schema, binding, compilerFingerprint, projections: [], preparation: "failed" }) });
      throw error;
    }
  }
  try {
    return await input.storage.transaction(async () => {
      const prior = await current();
      if (prior) return input.unchanged(prior.completedEmptyReport);
      const { report, projections, deferred } = await input.compile(prepared);
      if (deferred) return report;
      const completeEmpty = requireOwnedPublication && !projections.some(projection => projection.patternIds.length > 0);
      if (completeEmpty && (!emptyReport(report) || !await verifyProjections(projections, true))) return report;
      await input.storage.ingestion.put({ id, rootUri: input.rootUri, itemUri: input.rootUri, phase: "stored", status: "complete",
        offsetBytes: byteLength, contentHash, byteLength, updatedAt: Date.now(), metadata: toJsonValue({
          schema: schema, binding, compilerFingerprint, projections,
          ...(completeEmpty ? { emptyResult: { schema: EMPTY_RESULT_SCHEMA, report, reportDigest: hasher.digestHex(canonicalStringify(report)) } } : {})
        }) });
      return report;
    });
  } catch (error) {
    if (input.prepare) await input.storage.ingestion.put({ ...running, phase: "failed", status: "failed", updatedAt: Date.now(),
      reason: String(error instanceof Error ? error.message : error).slice(0, 500),
      metadata: toJsonValue({ schema, binding, compilerFingerprint, projections: [], preparation: "published_failed" }) });
    throw error;
  }
}
