// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue, type ContentHash, type InformationLabel, type ScceStorage, type TranscriptTurn } from "@scce/kernel";

/** Changes only the conversational auxiliary component, never immutable source or base compilation identity. */
export const DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID = "scce.dialogue_conversational_construction.v2";

export async function runDialogueConversationalComponent<T>(input: {
  storage: ScceStorage;
  rootUri: string;
  informationLabel: InformationLabel;
  authorship: string;
  sources: readonly { sourceUri: string; sourceVersionId: string; contentHash: string; byteLength: number; transcriptTurns?: readonly TranscriptTurn[] }[];
  compile: () => Promise<T>;
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
    return row?.status === "complete" && row.phase === "stored" && row.rootUri === input.rootUri && row.itemUri === input.rootUri
      && row.contentHash === contentHash && row.byteLength === byteLength
      && metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      && metadata?.schema === "scce.dialogue_conversational_compilation.v1" && metadata.binding === binding
      && metadata.compilerFingerprint === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID;
  };
  if (await current()) return input.unchanged();
  return input.storage.transaction(async () => {
    if (await current()) return input.unchanged();
    const report = await input.compile();
    await input.storage.ingestion.put({ id, rootUri: input.rootUri, itemUri: input.rootUri, phase: "stored", status: "complete",
      offsetBytes: byteLength, contentHash, byteLength, updatedAt: Date.now(), metadata: toJsonValue({
        schema: "scce.dialogue_conversational_compilation.v1", binding, compilerFingerprint: DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID
      }) });
    return report;
  });
}
