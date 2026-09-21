// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Hasher } from "./types.js";
import type { SemanticAtom } from "./semantic-proof-types.js";
import { atomizeText } from "./semantic-proof-system.js";
import { SEMANTIC_CONSTRAINT, SEMANTIC_SOURCE } from "./semantic-codes.js";
import { canonicalStringify, weightedJaccard } from "./primitives.js";

/**
 * Plan items 142-143. Semantic round-trip validation over extracted atoms:
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
 * corruption -- not something this module performs itself. Acceptance is
 * conditional on this interpreter retaining the meaning-bearing distinctions;
 * it is not a proof of arbitrary natural-language interpretation.
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

/** Meaning-bearing fields only. Scores, provenance and record order cannot authorize a different claim. */
function roleMeaning(atom: SemanticAtom): string {
  return JSON.stringify(atom.roles.map(role => canonicalStringify({
    name: role.name,
    normalized: role.normalized,
    type: role.type,
    nodeId: role.nodeId ?? null
  })).sort());
}

function constraintMeaning(atom: SemanticAtom, kind?: string): string {
  return JSON.stringify(atom.constraints.filter(constraint => kind === undefined || constraint.kind === kind)
    .map(constraint => canonicalStringify({
      kind: constraint.kind,
      subject: constraint.subject,
      operator: constraint.operator,
      value: constraint.value
    })).sort());
}

function atomMeaning(atom: SemanticAtom): string {
  return JSON.stringify([
    atom.predicate, roleMeaning(atom), constraintMeaning(atom), atom.polarity,
    atom.modality, discourseForceFromSurface(atom.sourceText)
  ]);
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
 * Exact represented meanings are paired first; remaining atoms use descending
 * similarity for diagnostics (predicate +
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
  // Cache per atom, not per candidate pair. Same-shape claims can differ only in
  // polarity or constraints, so lexical ties must not steal an exact counterpart.
  const meaningsA = new Map(atomsA.map(atom => [atom.id, atomMeaning(atom)]));
  const meaningsAhat = new Map(atomsAhat.map(atom => [atom.id, atomMeaning(atom)]));
  for (const a of atomsA) {
    for (const ahat of atomsAhat) {
      const similarity = weightedJaccard(atomFeatures(a), atomFeatures(ahat));
      if (similarity >= MATCH_SIMILARITY_THRESHOLD || sameClaimShape(a, ahat)) {
        candidates.push({ aId: a.id, ahatId: ahat.id, similarity });
      }
    }
  }
  const exactMeaning = (pair: RoundTripAtomPair): number =>
    Number(meaningsA.get(pair.aId) === meaningsAhat.get(pair.ahatId));
  candidates.sort((left, right) => exactMeaning(right) - exactMeaning(left)
    || right.similarity - left.similarity
    || left.aId.localeCompare(right.aId) || left.ahatId.localeCompare(right.ahatId));
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
  return constraintMeaning(atom, kind);
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
 * Plan item 143. Reject additions and mutations of represented meaning, not
 * merely unmatched atoms. Similarity establishes correspondence for diagnostics;
 * it does not prove equivalence. Uninterpretable output cannot pass vacuously.
 * Whole-atom omission retains the existing summary contract; answer/translation
 * coverage remains the caller's separate obligation. Removing a constraint or a
 * role from a retained atom is a mutation, not a permitted whole-atom omission.
 * Return the existing cycle-trace schema on every path. No policy flag bypasses
 * these checks and no source/brain data is rewritten.
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
  if (atomsA.length === 0 || atomsAhat.length === 0) {
    return { accepted: false, reason: "semantic round trip has no interpreted intended or realized claim", cycleTrace };
  }
  const mutations = [
    ["role reversal", distance.reversed],
    ["quantity constraint", distance.quantityMismatches],
    ["temporal constraint", distance.timeMismatches],
    ["polarity", distance.polarityMismatches],
    ["modality", distance.modalityMismatches],
    ["discourse force", distance.discourseForceMismatches]
  ] as const;
  const mutation = mutations.find(([, pairs]) => pairs.length > 0);
  if (mutation) {
    return { accepted: false, reason: `realized text changes ${mutation[0]} on ${mutation[1].length} matched atom(s)`, cycleTrace };
  }
  const meaningsA = new Map(atomsA.map(atom => [atom.id, atomMeaning(atom)]));
  const meaningsAhat = new Map(atomsAhat.map(atom => [atom.id, atomMeaning(atom)]));
  const changed = distance.matched.filter(pair => meaningsA.get(pair.aId) !== meaningsAhat.get(pair.ahatId));
  if (changed.length > 0) {
    return {
      accepted: false,
      reason: `realized text changes a predicate, role binding or constraint on ${changed.length} matched atom(s)`,
      cycleTrace
    };
  }
  return { accepted: true, cycleTrace };
}
