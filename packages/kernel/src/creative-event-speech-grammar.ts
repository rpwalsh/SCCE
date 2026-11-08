// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { DurableCreativeEventConstruction, DurableLanguageConstructionBundle, DurableSourceConstructionExample } from "./language-construction-memory.js";
import { canonicalStringify } from "./primitives.js";

export interface CreativeEventSpeechGrammarWitness {
  bundle: DurableLanguageConstructionBundle;
  example: DurableSourceConstructionExample;
}

/** The event and its speech grammar must name the same source occurrence and every selected role. */
export function createCreativeEventSpeechGrammarIndex(bundles: readonly DurableLanguageConstructionBundle[]) {
  const bySourceOccurrence = new Map<string, CreativeEventSpeechGrammarWitness[]>();
  for (const bundle of bundles) for (const example of bundle.sourceExamples) {
    const key = sourceOccurrenceKey(bundle.targetProfileId, example.evidenceId, example.sourceVersionId,
      example.evidenceContentHash, example.surfaceStartCodePoint, example.surfaceEndCodePoint);
    const rows = bySourceOccurrence.get(key) ?? [];
    rows.push({ bundle, example });
    bySourceOccurrence.set(key, rows);
  }
  for (const rows of bySourceOccurrence.values()) rows.sort((a, b) => a.bundle.id.localeCompare(b.bundle.id) || a.example.id.localeCompare(b.example.id));
  return {
    forEvent(event: DurableCreativeEventConstruction): CreativeEventSpeechGrammarWitness[] {
      const key = sourceOccurrenceKey(event.profileId, event.evidenceId, event.sourceVersionId, event.evidenceContentHash,
        event.argumentFrame.sourceSentenceStartCodePoint, event.argumentFrame.sourceSentenceEndCodePoint);
      return (bySourceOccurrence.get(key) ?? []).filter(({ example }) => example.roles.some(role =>
        example.surfaceStartCodePoint + role.startCodePoint === event.labelStartCodePoint
        && example.surfaceStartCodePoint + role.endCodePoint === event.labelEndCodePoint && role.surface === event.sourceLabel)
        && event.argumentFrame.bindings.every(port => example.roles.some(role =>
          example.surfaceStartCodePoint + role.startCodePoint === port.startCodePoint
          && example.surfaceStartCodePoint + role.endCodePoint === port.endCodePoint && role.surface === port.surface)));
    }
  };
}

function sourceOccurrenceKey(profileId: string, evidenceId: string, sourceVersionId: string, contentHash: string, start: number, end: number): string {
  return canonicalStringify([profileId, evidenceId, sourceVersionId, contentHash, start, end]);
}
