import type { JsonValue } from "./types.js";

/**
 * Plan items 223-224. Real narrative-state tracking for generation tasks:
 * per-subject world/character state threaded through an ordered sequence
 * of events with explicit causality, plus two concrete, checkable
 * consistency properties -- an event claiming a fact changed *from* a
 * value that was never actually established (an unexplained state
 * change), and a setup ("Chekhov's gun") that no later event ever pays
 * off. Neither check is a language-model judgment call; both are
 * structural, deterministic checks over the declared event graph.
 */

export interface NarrativeStateChange {
  subjectId: string;
  factId: string;
  fromValue?: JsonValue;
  toValue: JsonValue;
}

export interface NarrativeEvent {
  id: string;
  order: number;
  description: string;
  causedByEventIds: string[];
  stateChanges: NarrativeStateChange[];
  setupIds: string[];
  payoffForSetupIds: string[];
}

export interface NarrativeState {
  events: NarrativeEvent[];
}

export interface InitialFact {
  subjectId: string;
  factId: string;
  value: JsonValue;
}

export interface UnexplainedStateChange {
  eventId: string;
  subjectId: string;
  factId: string;
  claimedFromValue: JsonValue | undefined;
  actualEstablishedValue: JsonValue | undefined;
}

export interface NarrativeConsistencyReport {
  unexplainedStateChanges: UnexplainedStateChange[];
  undischargedSetupIds: string[];
  consistent: boolean;
}

function factKey(subjectId: string, factId: string): string {
  return `${subjectId}${factId}`;
}

function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Threads world/character state through the events in story order,
 * flagging every event whose declared `fromValue` for a fact does not
 * match what was actually established by the events before it (including
 * the initial facts), and every setup that no later event ever pays off.
 */
export function evaluateNarrativeConsistency(
  narrative: NarrativeState,
  initialFacts: readonly InitialFact[] = []
): NarrativeConsistencyReport {
  const ordered = [...narrative.events].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const established = new Map<string, JsonValue>();
  for (const fact of initialFacts) established.set(factKey(fact.subjectId, fact.factId), fact.value);

  const unexplainedStateChanges: UnexplainedStateChange[] = [];
  const openSetups = new Set<string>();
  const paidOffSetups = new Set<string>();

  for (const event of ordered) {
    for (const setupId of event.setupIds) openSetups.add(setupId);
    for (const setupId of event.payoffForSetupIds) paidOffSetups.add(setupId);
    for (const change of event.stateChanges) {
      const key = factKey(change.subjectId, change.factId);
      const actual = established.get(key);
      if (change.fromValue !== undefined && !deepEqual(change.fromValue, actual)) {
        unexplainedStateChanges.push({
          eventId: event.id,
          subjectId: change.subjectId,
          factId: change.factId,
          claimedFromValue: change.fromValue,
          actualEstablishedValue: actual
        });
      }
      established.set(key, change.toValue);
    }
  }

  const undischargedSetupIds = [...openSetups].filter(setupId => !paidOffSetups.has(setupId)).sort();

  return {
    unexplainedStateChanges,
    undischargedSetupIds,
    consistent: unexplainedStateChanges.length === 0 && undischargedSetupIds.length === 0
  };
}
