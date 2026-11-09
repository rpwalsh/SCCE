// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  acquireContextualQaConstructions, canonicalStringify, createHasher, CONTEXTUAL_QA_CONSTRUCTION_RECIPE as RECIPE,
  CONTEXTUAL_QA_SOURCE_SYSTEM as SYSTEM, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA as SCHEMA, CONTEXTUAL_QA_COMPILER_FINGERPRINT,
  type ConversationalConstructionDocument, type InformationLabel, type LanguagePatternProjection,
  type ScceStorage, type SourceVersionId, type TranscriptTurn
} from "@scce/kernel";
import { corpusSourceVersionIdFor } from "./language-corpus-trainer.js";
import { runDialogueContextualQaComponent } from "./dialogue-conversational-checkpoint.js";

export interface DialogueContextualQaReport {
  schema: "scce.dialogue_contextual_qa_report.v1";
  compilerFingerprint: typeof CONTEXTUAL_QA_COMPILER_FINGERPRINT;
  pairs: number;
  patternsPersisted: number;
  qualifiedFamilies: number;
  familyApplicability: readonly { fitBindings: number; heldOutBindings: number; outOfApplicability: number }[];
  rejected: readonly { bindingId: string; reason: string }[];
  deferredProjections?: readonly { sourceVersionId: string; reason: "dependencies_outside_pool" }[];
  unchanged: boolean;
}

export async function persistDialogueContextualQaComponent(input: {
  storage: ScceStorage; rootUri: string; informationLabel: InformationLabel; authorship: string;
  sources: readonly { sourceUri: string; text: string; sourceVersionId?: string; transcriptTurns?: readonly TranscriptTurn[] }[];
}): Promise<DialogueContextualQaReport> {
  const unchanged = (): DialogueContextualQaReport => ({ schema: "scce.dialogue_contextual_qa_report.v1", pairs: 0,
    compilerFingerprint: CONTEXTUAL_QA_COMPILER_FINGERPRINT,
    patternsPersisted: 0, qualifiedFamilies: 0, familyApplicability: [], rejected: [], unchanged: true });
  const hasher = createHasher();
  const eligible = input.sources.filter(source => source.transcriptTurns?.some(turn => turn.commitmentScope === "external" && turn.supportingSourceRanges?.length));
  if (input.authorship !== "human_authored" || !eligible.length) return unchanged();
  const sources = eligible.map(source => ({ ...source, sourceVersionId: source.sourceVersionId ?? String(corpusSourceVersionIdFor(source)),
    contentHash: hasher.digestHex(source.text), byteLength: Buffer.byteLength(source.text, "utf8") }));
  return runDialogueContextualQaComponent({ storage: input.storage, rootUri: input.rootUri,
    informationLabel: input.informationLabel, authorship: input.authorship,
    sources: sources.map(({ sourceUri, sourceVersionId, contentHash, byteLength, transcriptTurns }) => ({ sourceUri, sourceVersionId,
      contentHash, byteLength, transcriptDigest: hasher.digestHex(canonicalStringify(transcriptTurns ?? [])) })), unchanged,
    compile: async () => {
      const memory = input.storage.languageMemory;
      if (!memory.replaceLanguagePatternProjection) throw Error("Contextual QA requires canonical active projection publication");
      const versions = sources.map(source => source.sourceVersionId as SourceVersionId);
      const profiles = await input.storage.model.listLanguageProfiles({ sourceVersionIds: versions, limit: versions.length + 1 });
      const documents: ConversationalConstructionDocument[] = [];
      for (const source of sources) {
        const owners = profiles.filter(profile => String(profile.sourceVersionId) === source.sourceVersionId);
        if (owners.length !== 1) throw Error("Contextual QA requires one exact profile per source version");
        const spans = (await input.storage.evidence.searchEvidence({ sourceVersionId: source.sourceVersionId as SourceVersionId,
          status: "promoted", limit: 4096 })).map(row => row.span);
        if (!spans.length || spans.some(span => String(span.sourceVersionId) !== source.sourceVersionId)) throw Error("Contextual QA requires promoted owner evidence");
        documents.push({ sourceVersionId: source.sourceVersionId, profileId: owners[0]!.id, spans, transcriptTurns: source.transcriptTurns });
      }
      const acquired = acquireContextualQaConstructions({ documents, hasher, updatedAt: Date.now(), authorship: input.authorship });
      const projections: LanguagePatternProjection[] = [], pooledVersions = new Set(versions.map(String));
      const deferredProjections: Array<{ sourceVersionId: string; reason: "dependencies_outside_pool" }> = [];
      let persisted = 0;
      for (const document of documents) {
        const owner = document.spans[0]!;
        const key = { profileId: document.profileId, sourceId: owner.sourceId, sourceVersionId: owner.sourceVersionId,
          sourceSystem: SYSTEM, patternSchema: SCHEMA, componentRecipe: RECIPE, informationLabel: input.informationLabel };
        const previous = await memory.getLanguagePatternProjection?.(key);
        if (previous?.sourceDependencies?.some(dependency => !pooledVersions.has(String(dependency.sourceVersionId)))) {
          deferredProjections.push({ sourceVersionId: String(owner.sourceVersionId), reason: "dependencies_outside_pool" });
          projections.push(previous); continue;
        }
        const families = acquired.families.filter(family => family.pattern.profileId === document.profileId);
        const patterns = families.map(family => ({ ...family.pattern, informationLabel: input.informationLabel }));
        if (!patterns.length && !previous) continue;
        const dependencies = new Map<string, NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
        for (const dependency of families.flatMap(family => family.sourceDependencies)) {
          const prior = dependencies.get(String(dependency.sourceVersionId));
          if (prior && prior.sourceId !== dependency.sourceId) throw Error("Contextual QA dependency has conflicting source ownership");
          dependencies.set(String(dependency.sourceVersionId), { ...dependency,
            evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...dependency.evidenceIds])].sort() });
        }
        const projection: LanguagePatternProjection = { ...key, patternIds: patterns.map(pattern => pattern.id).sort(),
          sourceDependencies: [...dependencies.values()].sort((a, b) => String(a.sourceVersionId).localeCompare(String(b.sourceVersionId))) };
        await memory.replaceLanguagePatternProjection({ patterns, projection });
        persisted += patterns.length; projections.push(projection);
      }
      return { projections, ...(deferredProjections.length ? { deferred: true } : {}), report: { schema: "scce.dialogue_contextual_qa_report.v1" as const, pairs: acquired.pairs,
        compilerFingerprint: CONTEXTUAL_QA_COMPILER_FINGERPRINT,
        ...(deferredProjections.length ? { deferredProjections } : {}),
        patternsPersisted: persisted, qualifiedFamilies: acquired.families.length, familyApplicability: acquired.families.map(family => family.applicability), rejected: acquired.rejected, unchanged: false } };
    } });
}
