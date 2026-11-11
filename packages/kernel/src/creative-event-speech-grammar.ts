// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  compileLanguageConstructionPatterns,
  SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  type DurableCreativeEventConstruction,
  type DurableLanguageConstructionBundle,
  type DurableSourceConstructionExample,
  type SourceBoundLanguageConstructionTrainingSet
} from "./language-construction-memory.js";
import { normalizeCanonicalSurface } from "./normalization-contract.js";
import type { SourceOwnedTextProjection } from "./pooled-language-profile-binding.js";
import { canonicalStringify } from "./primitives.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceSpan, Hasher } from "./types.js";

export const CREATIVE_EVENT_SPEECH_GRAMMAR_RECIPE = "scce.creative_event.speech_grammar.v1" as const;

export interface CreativeEventSpeechGrammarPublication {
  patterns: LanguagePatternRecord[];
  candidateCount: number;
  compiledCount: number;
  rejectionCodes: string[];
}

export interface CreativeEventSpeechGrammarWitness {
  bundle: DurableLanguageConstructionBundle;
  example: DurableSourceConstructionExample;
}

/**
 * Publishes the source sentence around each learned creative event as an
 * ordinary evidence-owned construction. Creative-event pages deliberately
 * keep only their typed event algebra; realization examples belong in the
 * existing construction algebra so Mouth has one verified realization path.
 *
 * This does not manufacture request compatibility. A prose corpus can teach
 * how an observed event was spoken without proving which future request may
 * select it; compatibility remains a separately learned, required gate.
 */
export function compileCreativeEventSpeechGrammarPatterns(input: {
  eventBundles: readonly DurableLanguageConstructionBundle[];
  profileId: string;
  evidence: readonly EvidenceSpan[];
  textProjection?: SourceOwnedTextProjection;
  hasher: Hasher;
  updatedAt: number;
}): CreativeEventSpeechGrammarPublication {
  const evidenceById = new Map(input.evidence.filter(span => span.status === "promoted")
    .map(span => [String(span.id), span] as const));
  const grouped = new Map<string, Array<{ event: DurableCreativeEventConstruction; observation: SourceBoundLanguageConstructionTrainingSet["observations"][number] }>>();
  const seenEvents = new Map<string, string>();
  const rejectionCodes: string[] = [];
  for (const event of input.eventBundles.flatMap(bundle => bundle.creativeEvents ?? [])
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal || compareText(left.id, right.id))) {
    const eventMaterial = canonicalStringify(event);
    const priorMaterial = seenEvents.get(event.id);
    if (priorMaterial !== undefined) {
      if (priorMaterial !== eventMaterial) {
        throw new Error(`creative-event speech grammar has conflicting duplicate event id ${event.id}`);
      }
      continue;
    }
    seenEvents.set(event.id, eventMaterial);
    const evidence = evidenceById.get(event.evidenceId);
    const start = event.argumentFrame.sourceSentenceStartCodePoint;
    const end = event.argumentFrame.sourceSentenceEndCodePoint;
    const roles = [
      { slotIndex: 0, occurrenceIndex: 0, startCodePoint: event.labelStartCodePoint - start, endCodePoint: event.labelEndCodePoint - start },
      ...event.argumentFrame.bindings.map((binding, index) => ({
        slotIndex: index + 1,
        occurrenceIndex: 0,
        startCodePoint: binding.startCodePoint - start,
        endCodePoint: binding.endCodePoint - start
      }))
    ];
    if (!evidence
      || event.profileId !== input.profileId
      || String(evidence.sourceVersionId) !== event.sourceVersionId
      || String(evidence.contentHash) !== event.evidenceContentHash
      || evidence.charStart !== event.evidenceCharStart
      || evidence.charEnd !== event.evidenceCharEnd
      || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end <= start
      || end > [...evidence.text].length
      || roles.some(role => role.startCodePoint < 0 || role.endCodePoint <= role.startCodePoint || role.endCodePoint > end - start)) {
      rejectionCodes.push("creative_event_speech_grammar_source_mismatch");
      continue;
    }
    const sourceSentenceStart = evidence.charStart + start;
    const sourceSentenceEnd = evidence.charStart + end;
    if (input.textProjection?.ranges.some(range => String(range.sourceVersionId) === String(evidence.sourceVersionId)
      && range.startCodePoint < sourceSentenceEnd && range.endCodePoint > sourceSentenceStart)) {
      rejectionCodes.push("creative_event_speech_grammar_projected_source_overlap");
      continue;
    }
    const shape = canonicalStringify([
      CREATIVE_EVENT_SPEECH_GRAMMAR_RECIPE,
      input.profileId,
      event.compilerId,
      event.constructionId,
      event.argumentFrame.bindings.map(binding => binding.roleId)
    ]);
    const rows = grouped.get(shape) ?? [];
    rows.push({ event, observation: {
      sourceVersionId: event.sourceVersionId,
      evidenceId: event.evidenceId,
      surfaceStartCodePoint: start,
      surfaceEndCodePoint: end,
      roles
    } });
    grouped.set(shape, rows);
  }

  const sets: Array<SourceBoundLanguageConstructionTrainingSet & { eventCount: number; acquisitionStatus: "source_observed" }> = [];
  for (const [shape, rows] of [...grouped].sort(([left], [right]) => compareText(left, right))) {
    const unique = [...new Map(rows.map(row => [canonicalStringify([
      row.observation.evidenceId,
      row.observation.surfaceStartCodePoint,
      row.observation.surfaceEndCodePoint,
      row.observation.roles
    ]), row])).values()];
    for (let offset = 0; offset < unique.length; offset += 256) {
      const chunk = unique.slice(offset, offset + 256);
      const chunkIndex = Math.floor(offset / 256);
      sets.push({
        bindingId: `surface.creative_event.speech.${input.hasher.digestHex(shape)}.${chunkIndex}`,
        acquisitionStatus: "source_observed",
        observations: chunk.map(row => row.observation),
        eventCount: chunk.length
      });
    }
  }

  const results = [...compileLanguageConstructionPatterns({
    profileId: input.profileId,
    evidence: input.evidence,
    hasher: input.hasher,
    updatedAt: input.updatedAt,
    storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
    sets
  })];
  if (results.length !== sets.length) {
    throw new Error("creative-event speech grammar compiler changed the requested set cardinality");
  }
  const eventCountByBinding = new Map(sets.map(set => [set.bindingId, set.eventCount] as const));
  const patterns: LanguagePatternRecord[] = [];
  let compiledCount = 0;
  for (const result of results) {
    if (result.status === "compiled") {
      const eventCount = eventCountByBinding.get(result.bundle.bindingId);
      if (eventCount === undefined) throw new Error("creative-event speech grammar compiler returned an unowned binding");
      patterns.push(result.pattern);
      compiledCount += eventCount;
    } else {
      rejectionCodes.push(...result.issues.map(issue => issue.code));
    }
  }
  return {
    patterns,
    candidateCount: sets.reduce((sum, set) => sum + set.eventCount, 0),
    compiledCount,
    rejectionCodes: [...new Set(rejectionCodes)].sort(compareText)
  };
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
  for (const rows of bySourceOccurrence.values()) rows.sort((a, b) => compareText(a.bundle.id, b.bundle.id) || compareText(a.example.id, b.example.id));
  return {
    forEvent(event: DurableCreativeEventConstruction): CreativeEventSpeechGrammarWitness[] {
      const key = sourceOccurrenceKey(event.profileId, event.evidenceId, event.sourceVersionId, event.evidenceContentHash,
        event.argumentFrame.sourceSentenceStartCodePoint, event.argumentFrame.sourceSentenceEndCodePoint);
      return (bySourceOccurrence.get(key) ?? []).filter(({ example }) => example.roles.some(role =>
        example.surfaceStartCodePoint + role.startCodePoint === event.labelStartCodePoint
        && example.surfaceStartCodePoint + role.endCodePoint === event.labelEndCodePoint && sourceLabelMatches(role.surface, event.sourceLabel))
        && event.argumentFrame.bindings.every(port => example.roles.some(role =>
          example.surfaceStartCodePoint + role.startCodePoint === port.startCodePoint
          && example.surfaceStartCodePoint + role.endCodePoint === port.endCodePoint && role.surface === port.surface)));
    }
  };
}

function sourceOccurrenceKey(profileId: string, evidenceId: string, sourceVersionId: string, contentHash: string, start: number, end: number): string {
  return canonicalStringify([profileId, evidenceId, sourceVersionId, contentHash, start, end]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceLabelMatches(observed: string, compiled: string): boolean {
  return observed === compiled || normalizeCanonicalSurface(observed) === normalizeCanonicalSurface(compiled);
}
