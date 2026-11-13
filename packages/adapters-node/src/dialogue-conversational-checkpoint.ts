// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue, type ContentHash, type InformationLabel, type LanguagePatternProjection, type ScceStorage, type TranscriptTurn, SOURCE_COMPUTATION_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_COMPILER_FINGERPRINT, SOURCE_REQUEST_EDIT_RECIPE } from "@scce/kernel";

/** Changes only the conversational auxiliary component, never immutable source or base compilation identity. */
export const DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID = "scce.dialogue_conversational_construction.v2";
export const DIALOGUE_CONVERSATIONAL_CHECKPOINT_SCHEMA = "scce.dialogue_conversational_compilation.v2";

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
  unchanged: () => T;
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
async function runDialogueSourceComponent<T, Prepared = undefined>(input:DialogueSourceComponentInput<T, Prepared>,recipe:string,schema:string,idPrefix:string,compilerFingerprint=recipe,requirePublishedPattern=false):Promise<T>{
  if (!input.sources.length) return input.unchanged();
  const hasher = createHasher();
  const { binding, byteLength } = prepareDialogueSourceComponentBinding(input);
  const contentHash = hasher.digestHex(binding) as ContentHash;
  const id = `${idPrefix}_${contentHash}`;
  const current = async () => {
    const row = await input.storage.ingestion.get(id), metadata = row?.metadata;
    const valid = row?.status === "complete" && row.phase === "stored" && row.rootUri === input.rootUri && row.itemUri === input.rootUri
      && row.contentHash === contentHash && row.byteLength === byteLength
      && metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      && metadata?.schema === schema && metadata.binding === binding
      && metadata.compilerFingerprint === compilerFingerprint;
    if (!valid || !metadata || typeof metadata !== "object" || Array.isArray(metadata) || !Array.isArray(metadata.projections)
      || requirePublishedPattern && !metadata.projections.some(raw => raw && typeof raw === "object" && !Array.isArray(raw)
        && Array.isArray(raw.patternIds) && raw.patternIds.length > 0)) return false;
    for (const raw of metadata.projections) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.profileId !== "string" || typeof raw.sourceId !== "string"
        || typeof raw.sourceVersionId !== "string" || raw.componentRecipe !== recipe
        || !Array.isArray(raw.patternIds) || !raw.patternIds.every(id => typeof id === "string")) return false;
      if (!input.storage.languageMemory.getLanguagePatternProjection) return false;
      const projection = raw as unknown as LanguagePatternProjection;
      const active = await input.storage.languageMemory.getLanguagePatternProjection(projection);
      if (!active || canonicalStringify(active) !== canonicalStringify(projection)) return false;
      if (projection.patternIds.length) {
        const rows = await input.storage.languageMemory.listLanguagePatterns({ view: "request_seed", patternIds: projection.patternIds, limit: projection.patternIds.length });
        if (canonicalStringify(rows.map(row => row.id).sort()) !== canonicalStringify([...projection.patternIds].sort())) return false;
      }
    }
    return true;
  };
  if (await current()) return input.unchanged();
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
      if (await current()) return input.unchanged();
      const { report, projections, deferred } = await input.compile(prepared);
      if (deferred) return report;
      if (requirePublishedPattern && !projections.some(projection => projection.patternIds.length > 0)) return report;
      await input.storage.ingestion.put({ id, rootUri: input.rootUri, itemUri: input.rootUri, phase: "stored", status: "complete",
        offsetBytes: byteLength, contentHash, byteLength, updatedAt: Date.now(), metadata: toJsonValue({
          schema: schema, binding, compilerFingerprint, projections
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
