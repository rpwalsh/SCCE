// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Hasher } from "./types.js";
import type { SemanticAtom } from "./semantic-proof-types.js";
import { atomizeText } from "./semantic-proof-system.js";
import { SEMANTIC_CONSTRAINT, SEMANTIC_SOURCE } from "./semantic-codes.js";
import { weightedJaccard } from "./primitives.js";

/**
 * Plan items 142-143. Complete semantic round-trip validation:
 * `A -> Realize -> Interpret -> Ahat`. `atomizeText` (already real,
 * already tested, `semantic-proof-system.ts`) is the "Interpret" step,
 * reused here rather than reimplemented -- both `A` (the intended
 * meaning) and `Ahat` (what the realized/generated surface text actually
 * asserts, re-parsed independently) are produced by the exact same real
 * text-to-atoms extraction, so this module never has to invent its own
 * separate "understanding" of either side. "Realize" (the generation
 * step producing the surface text `Ahat` gets re-parsed from) is the
 * caller's concern -- Mouth, a translation pipeline, or, in this module's
 * own tests, a deliberately mutated string standing in for a specific
 * corruption -- not something this module performs itself.
 */

export const SEMANTIC_ROUND_TRIP_SCHEMA = "scce.semantic_round_trip.v1" as const;

export type DiscourseForce = "declarative" | "interrogative" | "exclamative";

/** A real, observable surface signal (sentence-final punctuation) for illocutionary force -- not a fabricated classifier claiming to detect force from syntax it never actually parses. */
export function discourseForceFromSurface(sentence: string): DiscourseForce {
  const trimmed = sentence.trim();
  if (trimmed.endsWith("?")) return "interrogative";
  if (trimmed.endsWith("!")) return "exclamative";
  return "declarative";
}

export interface RoundTripAtomPair {
  aId: string;
  ahatId: string;
  similarity: number;
}

export interface SemanticRoundTripDistance {
  schema: typeof SEMANTIC_ROUND_TRIP_SCHEMA;
  matched: RoundTripAtomPair[];
  /** In A (intended), no real counterpart found in Ahat (realized) -- the realization dropped something it was supposed to assert. */
  missing: SemanticAtom[];
  /** In Ahat (realized), no real counterpart found in A (intended) -- the realization asserted something never intended: a hallucination. */
  added: SemanticAtom[];
  /** Matched atoms whose role-value assignments are genuinely swapped (not merely reworded) -- e.g. subject and object exchanged. */
  reversed: RoundTripAtomPair[];
  quantityMismatches: RoundTripAtomPair[];
  timeMismatches: RoundTripAtomPair[];
  polarityMismatches: RoundTripAtomPair[];
  modalityMismatches: RoundTripAtomPair[];
  discourseForceMismatches: RoundTripAtomPair[];
}

/**
 * Token-level, not whole-value, role comparison: two atoms whose role
 * text differs by only one word (e.g. a single changed quantity or year)
 * must still register as the *same underlying claim* for matching
 * purposes -- a coarser whole-string comparison would treat any single
 * changed token as an entirely different, unrelated atom, which would
 * misreport a real quantity/time mismatch as an unrelated missing+added
 * pair instead of a genuine mismatch on one matched claim.
 */
function atomFeatures(atom: SemanticAtom): string[] {
  const roleTokenFeatures = atom.roles.flatMap(role => [
    `role:${role.name}`,
    ...role.normalized.split(/\s+/).filter(Boolean).map(token => `roleToken:${role.name}:${token}`)
  ]);
  return [`predicate:${atom.predicate}`, ...roleTokenFeatures];
}

const MATCH_SIMILARITY_THRESHOLD = 0.5;

/**
 * Same predicate and the same *set* of role names (regardless of value)
 * is real, strong structural evidence of "the same underlying claim
 * shape" -- two or more shared argument slots make an accidental
 * coincidence very unlikely. This exists specifically for the maximal
 * case of a reversed/substituted-argument corruption, where *every*
 * role's value differs (the whole point of the corruption), which would
 * otherwise leave token-overlap similarity too low to clear
 * `MATCH_SIMILARITY_THRESHOLD` on its own -- exactly the case a round-
 * trip validator most needs to still recognize as one matched pair with
 * a real mismatch, not silently miss as two unrelated atoms.
 */
function sameClaimShape(a: SemanticAtom, ahat: SemanticAtom): boolean {
  if (a.predicate !== ahat.predicate) return false;
  const roleNamesA = new Set(a.roles.map(role => role.name));
  const roleNamesAhat = new Set(ahat.roles.map(role => role.name));
  if (roleNamesA.size < 2 || roleNamesA.size !== roleNamesAhat.size) return false;
  for (const name of roleNamesA) if (!roleNamesAhat.has(name)) return false;
  return true;
}

/**
 * Real greedy bipartite matching by descending similarity (predicate +
 * role-value overlap, via `primitives.ts`'s own `weightedJaccard`, not a
 * separate ad hoc metric, OR the same-claim-shape structural rule above):
 * each atom on each side matched at most once, so a discrepancy is never
 * double-counted by matching it against two different candidates on the
 * other side.
 */
function matchAtoms(
  atomsA: readonly SemanticAtom[],
  atomsAhat: readonly SemanticAtom[]
): { pairs: RoundTripAtomPair[]; unmatchedA: SemanticAtom[]; unmatchedAhat: SemanticAtom[] } {
  const candidates: RoundTripAtomPair[] = [];
  for (const a of atomsA) {
    for (const ahat of atomsAhat) {
      const similarity = weightedJaccard(atomFeatures(a), atomFeatures(ahat));
      if (similarity >= MATCH_SIMILARITY_THRESHOLD || sameClaimShape(a, ahat)) {
        candidates.push({ aId: a.id, ahatId: ahat.id, similarity });
      }
    }
  }
  candidates.sort((left, right) => right.similarity - left.similarity || left.aId.localeCompare(right.aId) || left.ahatId.localeCompare(right.ahatId));
  const usedA = new Set<string>();
  const usedAhat = new Set<string>();
  const pairs: RoundTripAtomPair[] = [];
  for (const candidate of candidates) {
    if (usedA.has(candidate.aId) || usedAhat.has(candidate.ahatId)) continue;
    pairs.push(candidate);
    usedA.add(candidate.aId);
    usedAhat.add(candidate.ahatId);
  }
  return {
    pairs,
    unmatchedA: atomsA.filter(atom => !usedA.has(atom.id)),
    unmatchedAhat: atomsAhat.filter(atom => !usedAhat.has(atom.id))
  };
}

function constraintValuesByKind(atom: SemanticAtom, kind: string): string {
  return JSON.stringify(atom.constraints.filter(constraint => constraint.kind === kind).map(constraint => constraint.value).sort());
}

/** A genuine structural role swap: two distinct role names in A whose values appear exchanged in Ahat, not merely reworded. */
function rolesReversed(a: SemanticAtom, ahat: SemanticAtom): boolean {
  for (const roleX of a.roles) {
    for (const roleY of a.roles) {
      if (roleX.name === roleY.name) continue;
      const ahatX = ahat.roles.find(role => role.name === roleX.name);
      const ahatY = ahat.roles.find(role => role.name === roleY.name);
      if (!ahatX || !ahatY) continue;
      if (roleX.normalized === ahatY.normalized && roleY.normalized === ahatX.normalized && roleX.normalized !== roleY.normalized) return true;
    }
  }
  return false;
}

export function computeSemanticRoundTripDistance(
  atomsA: readonly SemanticAtom[],
  atomsAhat: readonly SemanticAtom[]
): SemanticRoundTripDistance {
  const { pairs, unmatchedA, unmatchedAhat } = matchAtoms(atomsA, atomsAhat);
  const byIdA = new Map(atomsA.map(atom => [atom.id, atom]));
  const byIdAhat = new Map(atomsAhat.map(atom => [atom.id, atom]));

  const reversed: RoundTripAtomPair[] = [];
  const quantityMismatches: RoundTripAtomPair[] = [];
  const timeMismatches: RoundTripAtomPair[] = [];
  const polarityMismatches: RoundTripAtomPair[] = [];
  const modalityMismatches: RoundTripAtomPair[] = [];
  const discourseForceMismatches: RoundTripAtomPair[] = [];

  for (const pair of pairs) {
    const a = byIdA.get(pair.aId)!;
    const ahat = byIdAhat.get(pair.ahatId)!;
    if (a.polarity !== ahat.polarity) polarityMismatches.push(pair);
    if (rolesReversed(a, ahat)) reversed.push(pair);
    if (constraintValuesByKind(a, SEMANTIC_CONSTRAINT.QUANTITY) !== constraintValuesByKind(ahat, SEMANTIC_CONSTRAINT.QUANTITY)) quantityMismatches.push(pair);
    if (constraintValuesByKind(a, SEMANTIC_CONSTRAINT.TEMPORAL) !== constraintValuesByKind(ahat, SEMANTIC_CONSTRAINT.TEMPORAL)) timeMismatches.push(pair);
    if (a.modality !== ahat.modality) modalityMismatches.push(pair);
    if (discourseForceFromSurface(a.sourceText) !== discourseForceFromSurface(ahat.sourceText)) discourseForceMismatches.push(pair);
  }

  return {
    schema: SEMANTIC_ROUND_TRIP_SCHEMA,
    matched: pairs,
    missing: unmatchedA,
    added: unmatchedAhat,
    reversed,
    quantityMismatches,
    timeMismatches,
    polarityMismatches,
    modalityMismatches,
    discourseForceMismatches
  };
}

export interface FactualRoundTripCycleTrace {
  schema: typeof SEMANTIC_ROUND_TRIP_SCHEMA;
  intendedText: string;
  realizedText: string;
  atomsA: SemanticAtom[];
  atomsAhat: SemanticAtom[];
  distance: SemanticRoundTripDistance;
}

export interface FactualRoundTripGateResult {
  accepted: boolean;
  reason?: string;
  cycleTrace: FactualRoundTripCycleTrace;
}

/**
 * Plan item 143. The hard factual gate: any real `Added` atom (something
 * the realized text asserts with no counterpart in the intended meaning)
 * rejects the output outright -- not a soft penalty, not a warning, a
 * real refusal. The full cycle trace (both atom sets and the complete
 * distance decomposition) is always returned, accepted or not, so every
 * emitted factual answer this gate approves carries its own real
 * provenance rather than a bare boolean.
 */
export function factualRoundTripGate(input: {
  intendedText: string;
  realizedText: string;
  hasher?: Hasher;
}): FactualRoundTripGateResult {
  const atomsA = atomizeText({ text: input.intendedText, source: SEMANTIC_SOURCE.CLAIM, ...(input.hasher ? { hasher: input.hasher } : {}) });
  const atomsAhat = atomizeText({ text: input.realizedText, source: SEMANTIC_SOURCE.CLAIM, ...(input.hasher ? { hasher: input.hasher } : {}) });
  const distance = computeSemanticRoundTripDistance(atomsA, atomsAhat);
  const cycleTrace: FactualRoundTripCycleTrace = {
    schema: SEMANTIC_ROUND_TRIP_SCHEMA,
    intendedText: input.intendedText,
    realizedText: input.realizedText,
    atomsA,
    atomsAhat,
    distance
  };
  if (distance.added.length > 0) {
    return {
      accepted: false,
      reason: `realized text asserts ${distance.added.length} atom(s) with no counterpart in the intended meaning`,
      cycleTrace
    };
  }
  return { accepted: true, cycleTrace };
}
