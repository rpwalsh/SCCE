// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";
import { claimBasisIsAdmissible, type PlannedClaim } from "./cognitive-planner.js";
import { deriveClosedClassWords } from "./closed-class-words.js";
import {
  SURFACE_AUTHORITY_CLASS_IDS,
  authorityClassMayAssertAsKnown,
  surfaceAuthorityClass,
  type SurfaceAuthorityClassId
} from "./conversational-act-binding.js";
import type { KneserNeyModel } from "./kneser-ney.js";
import type { ConversationTurnSurface } from "./language-construction.js";
import type { LanguageContinuationPopulation } from "./storage.js";
import { surfaceWords } from "./surface-linguistics.js";

/**
 * Which authority licenses one unit of a candidate. Documentary and conversation provenance are separate
 * members on purpose: a conversation span never becomes an evidence id, and neither stands in for the other.
 */
export const COMMITMENT_AUTHORITY_IDS = {
  /** Admitted documentary evidence carries this unit. */
  documentary: "commitment.authority.documentary",
  /** A verified span of a turn of this conversation carries it. */
  conversationSpan: "commitment.authority.conversation_span",
  /** A typed slot value the turn itself holds carries it. Turn state, never documentary and never a conversation span. */
  typedSlot: "commitment.authority.typed_slot",
  /** A frame literal of the construction being spoken, licensed by that construction's corpus provenance. Form, never claim support. */
  constructionForm: "commitment.authority.construction_form",
  /** A planned claim derived from licensed premises carries it. */
  derivedPremise: "commitment.authority.derived_premise",
  /** An explicitly hypothetical, non-assertive construction carries it. */
  hypothetical: "commitment.authority.hypothetical",
  /** Form, not content: the measured closed class of the resident language. Commits to nothing external. */
  form: "commitment.authority.form",
  /** An externally meaningful unit nothing licenses. */
  none: "commitment.authority.none"
} as const;

export type CommitmentAuthorityId = typeof COMMITMENT_AUTHORITY_IDS[keyof typeof COMMITMENT_AUTHORITY_IDS];

/** One unit of a candidate surface, with the provenance that decides what it may commit the system to. */
export interface CandidateCommitmentUnit {
  surface: string;
  startCodePoint: number;
  endCodePoint: number;
  /** Open-class under the resident language's measured closed class, so it can name something in the world. */
  externallyMeaningful: boolean;
  authorityId: CommitmentAuthorityId;
  /** Ids of the licensing artifacts, in the authority's own namespace. Never re-labelled across namespaces. */
  licenceIds: readonly string[];
}

export interface CandidateCommitmentInventory {
  units: readonly CandidateCommitmentUnit[];
  /** Externally meaningful units no authority licenses. Non-empty means the candidate asserts on air. */
  unlicensedUnits: readonly CandidateCommitmentUnit[];
  authorityIds: readonly CommitmentAuthorityId[];
  authorityClassId: SurfaceAuthorityClassId;
  /** False when the resident language was too small to name a closed class, so form could not be told from content. */
  closedClassMeasured: boolean;
}

export interface CandidateCommitmentInventoryInput {
  text: string;
  /** Admitted documentary evidence, as text the unit may be found in. */
  evidenceTexts: readonly { id: string; text: string }[];
  /** Turns of this conversation the caller observed, including the request now being answered. */
  conversationTurns: readonly ConversationTurnSurface[];
  /** The turn's planned commitments. Read for provenance only; a producer's own label is never consulted. */
  claimBases: readonly PlannedClaim[];
  /** Typed slot values the turn holds, in the slot's own id namespace. */
  slotValues?: readonly { id: string; text: string }[];
  /** Frame literals of the construction being spoken, keyed by its corpus source-version ids. Form, not evidence. */
  constructionFormLiterals?: readonly { id: string; text: string }[];
  /** The resident language the closed class is measured from. No word list. */
  models?: readonly KneserNeyModel[];
  continuationPopulation?: LanguageContinuationPopulation;
}

/**
 * The commitment inventory of a candidate: every unit that could become an externally meaningful assertion,
 * with the authority that licenses it. Units are judged one by one, so a candidate holding one licence does
 * not thereby license the rest of itself.
 */
export function candidateCommitmentInventory(
  input: CandidateCommitmentInventoryInput
): CandidateCommitmentInventory {
  const closedClass = measuredClosedClass(input);
  const documentary = wordIndex(input.evidenceTexts.map(row => [row.id, row.text] as const));
  const conversation = wordIndex(input.conversationTurns.map(turn => [turn.turnId, turn.surface] as const));
  const slot = wordIndex((input.slotValues ?? []).map(row => [row.id, row.text] as const));
  const frameForm = wordIndex((input.constructionFormLiterals ?? []).map(row => [row.id, row.text] as const));
  const premise = wordIndex(input.claimBases
    .filter(claim => claimBasisIsAdmissible(claim) && claim.externallyFactual && !claim.hypothetical
      && (claim.graphEdgeIds.length > 0 || claim.priorIds.length > 0 || claim.evidenceIds.length > 0))
    .map(claim => [claim.id, claim.text] as const));
  const hypothetical = wordIndex(input.claimBases
    .filter(claim => claimBasisIsAdmissible(claim) && !claim.externallyFactual)
    .map(claim => [claim.id, claim.text] as const));

  const units = commitmentUnits(input.text).map((unit): CandidateCommitmentUnit => {
    const key = unit.surface.toLocaleLowerCase();
    if (closedClass.has(key)) {
      return { ...unit, externallyMeaningful: false, authorityId: COMMITMENT_AUTHORITY_IDS.form, licenceIds: [] };
    }
    // Order is provenance strength, not preference: a documented unit stays documented even if the user also said it.
    const documented = documentary.get(key);
    if (documented) return { ...unit, externallyMeaningful: true, authorityId: COMMITMENT_AUTHORITY_IDS.documentary, licenceIds: documented };
    const said = conversation.get(key);
    if (said) return { ...unit, externallyMeaningful: true, authorityId: COMMITMENT_AUTHORITY_IDS.conversationSpan, licenceIds: said };
    // A corpus frame literal is form the construction's own provenance licenses; it names nothing and cites nothing.
    const framed = frameForm.get(key);
    if (framed) return { ...unit, externallyMeaningful: true, authorityId: COMMITMENT_AUTHORITY_IDS.constructionForm, licenceIds: framed };
    const held = slot.get(key);
    if (held) return { ...unit, externallyMeaningful: true, authorityId: COMMITMENT_AUTHORITY_IDS.typedSlot, licenceIds: held };
    const derived = premise.get(key);
    if (derived) return { ...unit, externallyMeaningful: true, authorityId: COMMITMENT_AUTHORITY_IDS.derivedPremise, licenceIds: derived };
    const proposed = hypothetical.get(key);
    if (proposed) return { ...unit, externallyMeaningful: true, authorityId: COMMITMENT_AUTHORITY_IDS.hypothetical, licenceIds: proposed };
    return { ...unit, externallyMeaningful: true, authorityId: COMMITMENT_AUTHORITY_IDS.none, licenceIds: [] };
  });

  const unlicensedUnits = units.filter(unit => unit.authorityId === COMMITMENT_AUTHORITY_IDS.none);
  const authorityIds = [...new Set(units.map(unit => unit.authorityId))].sort();
  return {
    units,
    unlicensedUnits,
    authorityIds,
    authorityClassId: inventoryAuthorityClass(units, unlicensedUnits),
    closedClassMeasured: closedClass.size > 0
  };
}

/**
 * The class the inventory as a whole holds, read off the units through the same discriminators `PlannedClaim`
 * carries. Nothing here is declared by a producer: `externallyFactual` is whether any unit names the world,
 * `hypothetical` is whether the only thing licensing those units is a proposed construction.
 */
function inventoryAuthorityClass(
  units: readonly CandidateCommitmentUnit[],
  unlicensedUnits: readonly CandidateCommitmentUnit[]
): SurfaceAuthorityClassId {
  const meaningful = units.filter(unit => unit.externallyMeaningful);
  if (meaningful.length === 0) return SURFACE_AUTHORITY_CLASS_IDS.conversationBound;
  if (unlicensedUnits.length > 0) return SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual;
  const authorities = new Set(meaningful.map(unit => unit.authorityId));
  if (authorities.has(COMMITMENT_AUTHORITY_IDS.documentary) || authorities.has(COMMITMENT_AUTHORITY_IDS.derivedPremise)) {
    return surfaceAuthorityClass({
      externallyFactual: true,
      hypothetical: false,
      evidenceIds: meaningful.flatMap(unit => (unit.authorityId === COMMITMENT_AUTHORITY_IDS.documentary ? unit.licenceIds : []))
    });
  }
  if (authorities.has(COMMITMENT_AUTHORITY_IDS.hypothetical)) return SURFACE_AUTHORITY_CLASS_IDS.hypotheticalProposed;
  return SURFACE_AUTHORITY_CLASS_IDS.conversationBound;
}

/** A candidate may be realized when no unit of it commits the system to an unlicensed external fact. */
export function candidateCommitmentsLicensed(inventory: CandidateCommitmentInventory): boolean {
  return inventory.unlicensedUnits.length === 0;
}

/** Whether what this candidate would say may stand as known. Conversation-bound speech is admissible, not known. */
export function candidateMayAssertAsKnown(inventory: CandidateCommitmentInventory): boolean {
  return authorityClassMayAssertAsKnown(inventory.authorityClassId);
}

/**
 * The resident language's closed class, or nothing when the language is too small to name one. A ranked cut of
 * a vocabulary shorter than the rank limit calls every content word a function word, which would excuse every
 * unit as form and admit anything: below that population the safe answer is that no unit is form.
 */
function measuredClosedClass(input: CandidateCommitmentInventoryInput): ReadonlySet<string> {
  const limit = calibrated("closed_class.rank_limit");
  const derived = deriveClosedClassWords({
    models: input.models ?? [],
    ...(input.continuationPopulation ? { continuationPopulation: input.continuationPopulation } : {})
  });
  return derived.size >= limit ? derived : new Set<string>();
}

function commitmentUnits(text: string): Array<Omit<CandidateCommitmentUnit, "externallyMeaningful" | "authorityId" | "licenceIds">> {
  const points = [...text];
  const out: Array<{ surface: string; startCodePoint: number; endCodePoint: number }> = [];
  let cursor = 0;
  for (const word of surfaceWords(text)) {
    const wordPoints = [...word];
    const found = indexOfPoints(points, wordPoints, cursor);
    if (found < 0) continue;
    out.push({ surface: word, startCodePoint: found, endCodePoint: found + wordPoints.length });
    cursor = found + wordPoints.length;
  }
  return out;
}

function indexOfPoints(haystack: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0) return -1;
  for (let start = from; start + needle.length <= haystack.length; start++) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) { match = false; break; }
    }
    if (match) return start;
  }
  return -1;
}

function wordIndex(sources: readonly (readonly [string, string])[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, text] of sources) {
    for (const word of surfaceWords(text)) {
      const key = word.toLocaleLowerCase();
      const ids = out.get(key);
      if (ids) { if (!ids.includes(id)) ids.push(id); } else out.set(key, [id]);
    }
  }
  return out;
}
