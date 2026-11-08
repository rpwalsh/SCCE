// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue, type ContentHash, type InformationLabel, type LanguagePatternProjection, type ScceStorage, type TranscriptTurn } from "@scce/kernel";

/** Changes only the conversational auxiliary component, never immutable source or base compilation identity. */
export const DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID = "scce.dialogue_conversational_construction.v2";

export async function runDialogueConversationalComponent<T>(input: {
  storage: ScceStorage;
  rootUri: string;
  informationLabel: InformationLabel;
  authorship: string;
  sources: readonly { sourceUri: string; sourceVersionId: string; contentHash: string; byteLength: number; transcriptTurns?: readonly TranscriptTurn[] }[];
  compile: () => Promise<{ report: T; projections: readonly LanguagePatternProjection[] }>;
  unchanged: () => T;
}): Promise<T> {
  if (!input.sources.length) return input.unchanged();
  const hasher = createHasher();
  const sources = [...input.sources].sort((a, b) => a.sourceVersionId.localeCompare(b.sourceVersionId) || a.sourceUri.localeCompare(b.sourceUri));
  const binding = canonicalStringify({ rootUri: input.rootUri, informationLabel: input.informationLabel, authorship: input.authorship, sources });
  const contentHash = hasher.digestHex(binding) as ContentHash;
  const id = `dialogue_conversational_compilation_${contentHash}`;
  const byteLength = sources.reduce((sum, source) => sum + source.byteLength, 0);
  const current = async () => {
    const row = await input.storage.ingestion.get(id), metadata = row?.metadata;
    const valid = row?.status === "complete" && row.phase === "stored" && row.rootUri === input.rootUri && row.itemUri === input.rootUri
      && row.contentHash === contentHash && row.byteLength === byteLength
      && metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      && metadata?.schema === "scce.dialogue_conversational_compilation.v1" && metadata.binding === binding
      && metadata.compilerFingerprint === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID;
    if (!valid || !metadata || typeof metadata !== "object" || Array.isArray(metadata) || !Array.isArray(metadata.projections)) return false;
    for (const raw of metadata.projections) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.profileId !== "string" || typeof raw.sourceId !== "string"
        || typeof raw.sourceVersionId !== "string" || raw.componentRecipe !== DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID
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
  return input.storage.transaction(async () => {
    if (await current()) return input.unchanged();
    const { report, projections } = await input.compile();
    await input.storage.ingestion.put({ id, rootUri: input.rootUri, itemUri: input.rootUri, phase: "stored", status: "complete",
      offsetBytes: byteLength, contentHash, byteLength, updatedAt: Date.now(), metadata: toJsonValue({
        schema: "scce.dialogue_conversational_compilation.v1", binding, compilerFingerprint: DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID, projections
      }) });
    return report;
  });
}
