// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { acquireSourceRequestEditPrograms, canonicalStringify, createHasher, toJsonValue,
  SOURCE_REQUEST_EDIT_SCHEMA, SOURCE_REQUEST_EDIT_RECIPE, LANGUAGE_IDENTITY_SCHEMA,
  type ConversationalConstructionDocument, type InformationLabel, type LanguagePatternProjection,
  type ScceStorage, type SourceVersionId, type TranscriptTurn } from "@scce/kernel";
import { corpusSourceVersionIdFor } from "./language-corpus-trainer.js";
import { runDialogueRequestEditComponent } from "./dialogue-conversational-checkpoint.js";

export interface DialogueRequestEditReport { schema: "scce.dialogue_request_edit_report.v1"; pairs: number; patternsPersisted: number;
  rejected: readonly { recordId: string; reason: string }[]; unchanged: boolean; }
export async function persistDialogueRequestEditComponent(input: { storage: ScceStorage; rootUri: string; informationLabel: InformationLabel;
  authorship: string; sources: readonly { sourceUri: string; text: string; sourceVersionId?: string; transcriptTurns?: readonly TranscriptTurn[] }[];
}): Promise<DialogueRequestEditReport> {
  const unchanged = (): DialogueRequestEditReport => ({ schema: "scce.dialogue_request_edit_report.v1", pairs: 0, patternsPersisted: 0, rejected: [], unchanged: true });
  const hasher = createHasher(), sources = input.sources.filter(source => source.transcriptTurns?.some(turn => turn.replyToTurnIndex !== undefined))
    .map(source => ({ ...source, sourceVersionId: source.sourceVersionId ?? String(corpusSourceVersionIdFor(source)) }));
  if (input.authorship !== "human_authored" || !sources.length) return unchanged();
  const profiles = await input.storage.model.listLanguageProfiles({ sourceVersionIds: sources.map(source => source.sourceVersionId as SourceVersionId), limit: sources.length + 1 });
  const assignments = await input.storage.languageIdentities?.listProfileLanguages({ profileIds: profiles.map(profile => profile.id) }) ?? [];
  const identities = await input.storage.languageIdentities?.listIdentities() ?? [];
  const documents: ConversationalConstructionDocument[] = [];
  for (const source of sources) {
    const owners = profiles.filter(profile => String(profile.sourceVersionId) === source.sourceVersionId);
    if (owners.length !== 1) throw Error("Source request edits require one exact current source profile");
    const profile = owners[0]!, assigned = assignments.filter(row => row.profileId === profile.id);
    const identity = assigned.length === 1 ? identities.find(row => row.id === assigned[0]!.languageId) : undefined;
    const verified = identity?.schema === LANGUAGE_IDENTITY_SCHEMA && identity.evidence && identity.evidence.status !== "source_observed"
      && canonicalStringify(identity.informationLabel) === canonicalStringify(input.informationLabel);
    const spans = (await input.storage.evidence.searchEvidence({ sourceVersionId: source.sourceVersionId as SourceVersionId,
      status: "promoted", limit: [...source.text].length + 1 })).map(row => row.span);
    if (!spans.length || spans.some(span => String(span.sourceVersionId) !== source.sourceVersionId
      || canonicalStringify(span.informationLabel) !== canonicalStringify(input.informationLabel))) throw Error("Source request edit evidence ownership changed");
    documents.push({ sourceVersionId: source.sourceVersionId, profileId: profile.id, spans, transcriptTurns: source.transcriptTurns,
      ...(verified ? { languageIdentityId: identity.id, languageIdentityDigest: hasher.digestHex(canonicalStringify([identity, profile.id])) } : {}) });
  }
  return runDialogueRequestEditComponent({ ...input, sources: sources.map(source => ({ sourceUri: source.sourceUri,
    sourceVersionId: source.sourceVersionId, contentHash: hasher.digestHex(source.text), byteLength: Buffer.byteLength(source.text),
    transcriptDigest: hasher.digestHex(canonicalStringify(source.transcriptTurns)),
    languageIdentityId: documents.find(doc => doc.sourceVersionId === source.sourceVersionId)?.languageIdentityId,
    languageIdentityDigest: documents.find(doc => doc.sourceVersionId === source.sourceVersionId)?.languageIdentityDigest })), unchanged,
    compile: async () => {
      const acquired = acquireSourceRequestEditPrograms({ documents, authorship: input.authorship, hasher, updatedAt: Date.now() });
      const projections: LanguagePatternProjection[] = []; let patternsPersisted = 0, deferred = false;
      const versions = new Set(documents.map(document => document.sourceVersionId));
      if (!input.storage.languageMemory.replaceLanguagePatternProjection) throw Error("Source request edits require active publication");
      for (const document of documents) {
        const owner = document.spans[0]!, families = acquired.families.filter(family => family.pattern.profileId === document.profileId);
        const patterns = families.map(family => ({ ...family.pattern, informationLabel: input.informationLabel,
          patternJson: toJsonValue({ ...(family.pattern.patternJson as Record<string, unknown>), sourceSystem: "dialogue" }) }));
        const dependencies = new Map<string, NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
        for (const dependency of families.flatMap(family => family.sourceDependencies)) {
          const prior = dependencies.get(String(dependency.sourceVersionId));
          dependencies.set(String(dependency.sourceVersionId), { ...dependency, evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...dependency.evidenceIds])] });
        }
        const projection: LanguagePatternProjection = { profileId: document.profileId, sourceId: owner.sourceId, sourceVersionId: owner.sourceVersionId,
          sourceSystem: "dialogue", patternSchema: SOURCE_REQUEST_EDIT_SCHEMA, componentRecipe: SOURCE_REQUEST_EDIT_RECIPE,
          informationLabel: input.informationLabel, patternIds: patterns.map(pattern => pattern.id).sort(), sourceDependencies: [...dependencies.values()] };
        const previous = await input.storage.languageMemory.getLanguagePatternProjection?.(projection);
        if (previous?.sourceDependencies?.some(dependency => !versions.has(String(dependency.sourceVersionId)))) {
          projections.push(previous); deferred = true; continue;
        }
        await input.storage.languageMemory.replaceLanguagePatternProjection({ patterns, projection });
        projections.push(projection); patternsPersisted += patterns.length;
      }
      return { projections, ...(deferred ? { deferred: true } : {}), report: { schema: "scce.dialogue_request_edit_report.v1" as const, pairs: acquired.pairs,
        patternsPersisted, rejected: acquired.rejected, unchanged: false } };
    } });
}
