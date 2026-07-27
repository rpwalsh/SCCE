import type { EpisodeId, EventId, JsonValue, ScceEvent } from "./types.js";

/**
 * Plan items 211-212. Compresses one episode's raw event history into a
 * bounded consolidated summary (goal/context/actions/outcomes/corrections/
 * lessons) while keeping the exact source event ids linked, never copied --
 * so replay volume drops (a consolidated episode is one small record, not
 * every event) while every claim it makes stays traceable back to a real
 * event in `sourceEventIds`. This module never invents lesson text: a
 * "lesson" is only ever a real string already present in a failure/
 * correction event's own payload, extracted verbatim, not summarized or
 * paraphrased by this code.
 */

export interface ConsolidatedEpisode {
  episodeId: EpisodeId;
  /** The `OwnerAsked` event's payload, if the episode has one -- the episode's originating goal/request, not re-derived. */
  goal?: JsonValue;
  contextEventIds: EventId[];
  actionEventIds: EventId[];
  outcomeEventIds: EventId[];
  correctionEventIds: EventId[];
  /** Verbatim reason/correction strings pulled from real event payloads -- never fabricated. */
  lessons: string[];
  /** Every event id this consolidation was built from, for exact source recoverability. */
  sourceEventIds: EventId[];
  eventCount: number;
  firstT: number;
  lastT: number;
}

const CONTEXT_EVENT_TYPES = new Set([
  "SourceObserved",
  "SourceVersionObserved",
  "SourceQuarantined",
  "SourcePromoted",
  "GraphUpdated",
  "EvidenceLinked",
  "LanguagePatternLearned",
  "SymbolPatternLearned"
]);

const ACTION_EVENT_TYPES = new Set([
  "CapabilityPlanned",
  "CapabilityInvoked",
  "ActionPrepared",
  "ActionCommitted",
  "BuildExecuted",
  "TestExecuted",
  "ExecutiveCapabilityDispatched",
  "CandidateGenerated"
]);

const OUTCOME_EVENT_TYPES = new Set([
  "CapabilitySucceeded",
  "CapabilityFailed",
  "ActionRolledBack",
  "CandidateSelected",
  "CandidateRejected",
  "MouthSpoken"
]);

const CORRECTION_EVENT_TYPES = new Set(["UserCorrected", "CorrectionApplied"]);

export function consolidateEpisode(events: readonly ScceEvent[]): ConsolidatedEpisode {
  if (!events.length) throw new Error("cannot consolidate an empty event list");
  const episodeId = events[0]!.episodeId;
  for (const event of events) {
    if (event.episodeId !== episodeId) {
      throw new Error(`consolidateEpisode requires events from exactly one episode, got ${event.episodeId} and ${episodeId}`);
    }
  }
  const ordered = [...events].sort((left, right) => left.t - right.t || left.id.localeCompare(right.id));
  const goalEvent = ordered.find(event => event.typeId === "OwnerAsked");
  const contextEventIds: EventId[] = [];
  const actionEventIds: EventId[] = [];
  const outcomeEventIds: EventId[] = [];
  const correctionEventIds: EventId[] = [];
  const lessons: string[] = [];
  for (const event of ordered) {
    if (CONTEXT_EVENT_TYPES.has(event.typeId)) contextEventIds.push(event.id);
    if (ACTION_EVENT_TYPES.has(event.typeId)) actionEventIds.push(event.id);
    if (OUTCOME_EVENT_TYPES.has(event.typeId)) outcomeEventIds.push(event.id);
    if (CORRECTION_EVENT_TYPES.has(event.typeId)) correctionEventIds.push(event.id);
    if (event.typeId === "CapabilityFailed" || event.typeId === "ActionRolledBack") {
      lessons.push(...verbatimReasonStrings(event.payload));
    }
    if (CORRECTION_EVENT_TYPES.has(event.typeId)) {
      lessons.push(...verbatimReasonStrings(event.payload));
    }
  }
  return {
    episodeId,
    ...(goalEvent ? { goal: goalEvent.payload } : {}),
    contextEventIds,
    actionEventIds,
    outcomeEventIds,
    correctionEventIds,
    lessons: [...new Set(lessons)],
    sourceEventIds: ordered.map(event => event.id),
    eventCount: ordered.length,
    firstT: ordered[0]!.t,
    lastT: ordered[ordered.length - 1]!.t
  };
}

/**
 * Every real, non-fabricated recoverable-source claim a consolidated
 * episode makes reduces to "this event id is in `sourceEventIds`". This
 * checks that invariant against a real event set -- the plan's explicit
 * "exact source events remain recoverable via the stored links" property.
 */
export function verifyConsolidatedEpisodeRecoverable(
  consolidated: ConsolidatedEpisode,
  events: readonly ScceEvent[]
): boolean {
  const byId = new Set(events.map(event => String(event.id)));
  const referenced = [
    ...consolidated.contextEventIds,
    ...consolidated.actionEventIds,
    ...consolidated.outcomeEventIds,
    ...consolidated.correctionEventIds,
    ...consolidated.sourceEventIds
  ];
  return referenced.every(id => byId.has(String(id)));
}

function verbatimReasonStrings(payload: JsonValue): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, JsonValue>;
  const out: string[] = [];
  if (typeof record.reason === "string" && record.reason.trim()) out.push(record.reason.trim());
  if (Array.isArray(record.reasons)) {
    for (const reason of record.reasons) if (typeof reason === "string" && reason.trim()) out.push(reason.trim());
  }
  if (typeof record.correctedOutput === "string" && record.correctedOutput.trim()) out.push(record.correctedOutput.trim());
  return out;
}
