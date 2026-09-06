// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { normalizePriorKey, splitPriorUnits, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import {
  ALLEN_RELATION_INVERSE,
  allenRelation,
  allenRelationDisjoint,
  recordTimelineFact,
  supersedeTimelineFact,
  type AllenRelation,
  type Interval,
  type TimelineFact
} from "./temporal-interval-algebra.js";
import type { EvidenceSpan } from "./types.js";

/**
 * Comparing two subjects in time, over the interval algebra that was already here.
 *
 * `temporal-interval-algebra.ts` implements all thirteen Allen relations, their inverses, disjointness, and a
 * timeline-fact store with supersession and as-of reconstruction. Nothing called any of it, so a request naming two
 * subjects and asking how their periods relate was answered by reading one subject's biography out: the relation was
 * never computed, because no caller ever built the intervals to compute it from.
 *
 * Interval extraction is digits, not language. A year is a run of digits in a plausible range, and the span of years
 * appearing in the sentence that binds a subject is the period this corpus associates with that subject. No month
 * names, no date formats, no parser that assumes a calendar convention or a writing system, so the same extraction
 * works on an English article, a German one, or a table.
 *
 * What this deliberately does not do is assert that the extracted period is a lifespan, a reign or an era. It is the
 * period the corpus associates with the subject, and the relation reported is the relation between those periods.
 */

/** Years outside this range are almost certainly quantities, identifiers or page numbers rather than dates. */
const PLAUSIBLE_YEAR_RANGE = { min: 1, max: 2999 } as const;

export interface SubjectPeriod {
  subject: string;
  interval: Interval;
  years: readonly number[];
  evidenceId: string;
  sentence: string;
  /** Whether this candidate came from the source's opening block, where a subject's period is stated. */
  fromSourceOpening?: boolean;
}

export interface SubjectTemporalComparison {
  left: SubjectPeriod;
  right: SubjectPeriod;
  relation: AllenRelation;
  /** The same relation seen from the right subject, so a caller can phrase it from either side. */
  inverseRelation: AllenRelation;
  /** True when the two periods share no instant at all. */
  disjoint: boolean;
  /** The years both periods contain, when they overlap. */
  sharedYears: readonly number[];
}

/** Every year in a plausible range, in order of appearance. Digits only, so no writing system is assumed. Pure. */
export function yearsInText(text: string): number[] {
  const years: number[] = [];
  for (const match of text.matchAll(/\b(\d{3,4})\b/gu)) {
    const year = Number(match[1]);
    if (!Number.isFinite(year)) continue;
    if (year < PLAUSIBLE_YEAR_RANGE.min || year > PLAUSIBLE_YEAR_RANGE.max) continue;
    years.push(year);
  }
  return years;
}

/** Sentences split on terminal punctuation shared across writing systems rather than on any language's rules. */
function spanSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。．！？])\s+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function sentenceBindsSubject(sentence: string, subjectUnits: readonly string[]): boolean {
  if (!subjectUnits.length) return false;
  const units = new Set(splitPriorUnits(normalizePriorKey(sentence)).filter(Boolean));
  return subjectUnits.every(unit => units.has(unit));
}

function uniqueYears(years: readonly number[]): number[] {
  return [...new Set(years)].sort((left, right) => left - right);
}

/**
 * The period this corpus associates with a subject, taken from the earliest sentence that both names the subject and
 * carries at least two years. Two are required because one year is a date rather than a period, and Allen's algebra is
 * defined only over non-degenerate intervals.
 */
export function subjectPeriodFromEvidence(
  subject: string,
  evidence: readonly EvidenceSpan[]
): SubjectPeriod | undefined {
  const subjectUnits = splitPriorUnits(normalizePriorKey(subject)).filter(Boolean);
  if (!subjectUnits.length) return undefined;
  const candidates: SubjectPeriod[] = [];
  for (const span of evidence) {
    const text = String(span.text ?? span.textPreview ?? "");
    if (!text) continue;
    for (const sentence of spanSentences(text.slice(0, 8000))) {
      if (!sentenceBindsSubject(sentence, subjectUnits)) continue;
      const years = uniqueYears(yearsNearSubject(sentence, subjectUnits));
      if (years.length < 2) continue;
      const start = years[0]!;
      const end = years[years.length - 1]!;
      if (start >= end) continue;
      candidates.push({
        subject,
        interval: { start, end },
        years,
        evidenceId: String(span.id),
        sentence,
        fromSourceOpening: Number(span.charStart ?? -1) === 0
      });
    }
  }
  if (!candidates.length) return undefined;
  // A source's opening block states what its subject is, including the period it is stated to span; anywhere else in
  // the document a year is as likely to belong to a citation as to the subject. The same `charStart === 0` signal
  // already decides opening-block preference in evidence ranking, so this is the existing notion of a definitional
  // block rather than a new one. Measured live without it: Ada Lovelace came back as 2015-2023 from a reference list
  // and Albert Einstein as 1096-2745, and preferring the narrowest candidate instead only traded those for tighter
  // nonsense (2015-2016). Width breaks ties within the opening block, where every candidate is already about the
  // subject.
  return candidates.sort((left, right) =>
    Number(right.fromSourceOpening) - Number(left.fromSourceOpening)
    || (left.interval.end - left.interval.start) - (right.interval.end - right.interval.start)
    || left.interval.start - right.interval.start)[0];
}

/**
 * Years appearing close enough to the subject's own mention to be stated about it.
 *
 * A sentence can name a subject and then list years belonging to something else entirely. Proximity is measured in
 * characters from the nearest occurrence of any subject unit, which needs no grammar and no word order convention:
 * "(10 December 1815 - 27 November 1852)" sits beside the name it belongs to in every language this corpus contains.
 */
function yearsNearSubject(sentence: string, subjectUnits: readonly string[]): number[] {
  const folded = sentence.toLocaleLowerCase();
  const mentions: number[] = [];
  for (const unit of subjectUnits) {
    let index = folded.indexOf(unit);
    while (index >= 0) {
      mentions.push(index);
      index = folded.indexOf(unit, index + Math.max(1, unit.length));
    }
  }
  if (!mentions.length) return [];
  const years: number[] = [];
  for (const match of sentence.matchAll(/\b(\d{3,4})\b/gu)) {
    const year = Number(match[1]);
    if (!Number.isFinite(year)) continue;
    if (year < PLAUSIBLE_YEAR_RANGE.min || year > PLAUSIBLE_YEAR_RANGE.max) continue;
    const at = match.index ?? 0;
    const distance = Math.min(...mentions.map(mention => Math.abs(mention - at)));
    if (distance <= SUBJECT_YEAR_PROXIMITY_CHARS) years.push(year);
  }
  return years;
}

/** How far from the subject's own mention a year may sit and still be read as stated about it. */
const SUBJECT_YEAR_PROXIMITY_CHARS = 120;

/**
 * Every subject period the request's anchors can be given, recorded as timeline facts so a later period supersedes an
 * earlier one rather than silently replacing it. Supersession is what lets an audit reconstruct what the turn believed
 * and when, instead of only what it ended up with.
 */
export function subjectPeriodsForAnchors(
  anchors: readonly string[],
  evidence: readonly EvidenceSpan[],
  recordedAt: number
): { periods: SubjectPeriod[]; facts: TimelineFact<SubjectPeriod>[] } {
  const subjects = uniqueKernelStrings(anchors.map(anchor => normalizePriorKey(anchor)).filter(Boolean));
  const distinct: string[] = [];
  for (const subject of subjects) {
    if (distinct.some(kept => kept.includes(subject) || subject.includes(kept))) continue;
    distinct.push(subject);
  }
  const periods: SubjectPeriod[] = [];
  let facts: TimelineFact<SubjectPeriod>[] = [];
  const factIdBySubject = new Map<string, string>();
  for (const subject of distinct) {
    const period = subjectPeriodFromEvidence(subject, evidence);
    if (!period) continue;
    periods.push(period);
    const factId = `timeline.subject.${subject.replace(/[^\p{L}\p{N}]+/gu, "_")}.${period.interval.start}_${period.interval.end}`;
    if (facts.some(fact => fact.id === factId)) continue;
    facts = recordTimelineFact(facts, {
      id: factId,
      subjectId: subject,
      interval: period.interval,
      value: period,
      recordedAt
    });
    const previous = factIdBySubject.get(subject);
    if (previous) facts = supersedeTimelineFact(facts, { oldFactId: previous, newFactId: factId, supersededAt: recordedAt });
    factIdBySubject.set(subject, factId);
  }
  return { periods, facts };
}

/** The Allen relation between two subjects' periods, with the inverse and the years they share. Pure. */
export function compareSubjectPeriods(left: SubjectPeriod, right: SubjectPeriod): SubjectTemporalComparison {
  const relation = allenRelation(left.interval, right.interval);
  const overlapStart = Math.max(left.interval.start, right.interval.start);
  const overlapEnd = Math.min(left.interval.end, right.interval.end);
  const sharedYears = allenRelationDisjoint(relation)
    ? []
    : Array.from({ length: Math.max(0, overlapEnd - overlapStart + 1) }, (_, offset) => overlapStart + offset);
  return {
    left,
    right,
    relation,
    inverseRelation: ALLEN_RELATION_INVERSE[relation],
    disjoint: allenRelationDisjoint(relation),
    sharedYears
  };
}

/** The first comparable pair among the request's subjects, or nothing when fewer than two have periods. */
export function subjectTemporalComparison(
  anchors: readonly string[],
  evidence: readonly EvidenceSpan[],
  recordedAt: number
): { comparison?: SubjectTemporalComparison; periods: SubjectPeriod[]; facts: TimelineFact<SubjectPeriod>[] } {
  const { periods, facts } = subjectPeriodsForAnchors(anchors, evidence, recordedAt);
  if (periods.length < 2) return { periods, facts };
  return { comparison: compareSubjectPeriods(periods[0]!, periods[1]!), periods, facts };
}
