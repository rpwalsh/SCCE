/**
 * Plan items 169-170. Real Allen interval-algebra relations between two
 * closed real-valued intervals, plus a timeline fact store that preserves
 * conflicting/superseded beliefs instead of overwriting them -- so a query
 * "what did SCCE believe as of time T" answers correctly for a T *before*
 * a later correction happened, without that correction retroactively
 * changing the earlier snapshot.
 */

export type AllenRelation =
  | "before" | "after"
  | "meets" | "met_by"
  | "overlaps" | "overlapped_by"
  | "during" | "contains"
  | "starts" | "started_by"
  | "finishes" | "finished_by"
  | "equals";

export interface Interval {
  start: number;
  end: number;
}

/**
 * Requires a genuinely positive-length interval (`start < end`, not just
 * `<=`). Allen's algebra is classically defined only for non-degenerate
 * intervals -- a zero-length "point" interval is not a documented
 * extension, it is a real ambiguity: a point sitting exactly at another
 * interval's start simultaneously satisfies the textbook conditions for
 * both `meets` and `starts` (and, against an equal point, both `meets` and
 * `equals`), so no classification of it would be "the" correct one rather
 * than an arbitrary tie-break invented for this codebase alone. Rejecting
 * degenerate intervals outright avoids fabricating a non-standard
 * extension of a well-established formalism.
 */
function assertValidInterval(interval: Interval, label: string): void {
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)) {
    throw new Error(`${label} must have finite start/end`);
  }
  if (interval.start >= interval.end) throw new Error(`${label} must have a positive length (start < end); degenerate zero-length intervals are not a well-defined extension of Allen's algebra`);
}

/**
 * The 13 mutually exclusive, jointly exhaustive Allen relations between two
 * closed intervals. Boundary-touching cases (`meets`/`met_by`) are
 * distinguished from genuine overlap (`overlaps`/`overlapped_by`) so a
 * caller that needs "these periods share no instant" can tell it apart
 * from "these periods share exactly one instant" -- collapsing that
 * distinction is a common, real source of off-by-one temporal bugs.
 */
export function allenRelation(a: Interval, b: Interval): AllenRelation {
  assertValidInterval(a, "interval a");
  assertValidInterval(b, "interval b");
  if (a.end < b.start) return "before";
  if (a.start > b.end) return "after";
  if (a.end === b.start) return "meets";
  if (a.start === b.end) return "met_by";
  if (a.start === b.start && a.end === b.end) return "equals";
  if (a.start === b.start && a.end < b.end) return "starts";
  if (a.start === b.start && a.end > b.end) return "started_by";
  if (a.end === b.end && a.start > b.start) return "finishes";
  if (a.end === b.end && a.start < b.start) return "finished_by";
  if (a.start > b.start && a.end < b.end) return "during";
  if (a.start < b.start && a.end > b.end) return "contains";
  if (a.start < b.start && a.end < b.end) return "overlaps";
  if (a.start > b.start && a.end > b.end) return "overlapped_by";
  throw new Error(`unreachable: intervals [${a.start},${a.end}] and [${b.start},${b.end}] matched no Allen relation`);
}

export const ALLEN_RELATION_INVERSE: Record<AllenRelation, AllenRelation> = {
  before: "after",
  after: "before",
  meets: "met_by",
  met_by: "meets",
  overlaps: "overlapped_by",
  overlapped_by: "overlaps",
  during: "contains",
  contains: "during",
  starts: "started_by",
  started_by: "starts",
  finishes: "finished_by",
  finished_by: "finishes",
  equals: "equals"
};

/** True for relations that mean the two intervals share no instant at all. */
export function allenRelationDisjoint(relation: AllenRelation): boolean {
  return relation === "before" || relation === "after";
}

export interface TimelineFact<V> {
  id: string;
  subjectId: string;
  /** The real-world period this fact is *about* -- distinct from `recordedAt`, which is when SCCE came to hold this belief. */
  interval: Interval;
  value: V;
  recordedAt: number;
  /** Undefined while this fact is SCCE's current belief; set once a later fact supersedes it. */
  supersededAt?: number;
  supersededByFactId?: string;
}

export function recordTimelineFact<V>(
  facts: readonly TimelineFact<V>[],
  input: { id: string; subjectId: string; interval: Interval; value: V; recordedAt: number }
): TimelineFact<V>[] {
  if (facts.some(fact => fact.id === input.id)) throw new Error(`timeline fact id already recorded: ${input.id}`);
  assertValidInterval(input.interval, `fact ${input.id}'s interval`);
  return [...facts, { ...input }];
}

/**
 * Marks `oldFactId` as superseded by `newFactId` at `supersededAt`. This
 * never deletes or mutates the old fact's own content -- it only stamps
 * when it stopped being SCCE's current belief, which is exactly what lets
 * `beliefsAsOf` reconstruct an earlier snapshot correctly (plan item 170).
 */
export function supersedeTimelineFact<V>(
  facts: readonly TimelineFact<V>[],
  input: { oldFactId: string; newFactId: string; supersededAt: number }
): TimelineFact<V>[] {
  const old = facts.find(fact => fact.id === input.oldFactId);
  if (!old) throw new Error(`cannot supersede unknown timeline fact: ${input.oldFactId}`);
  if (!facts.some(fact => fact.id === input.newFactId)) throw new Error(`superseding fact must already be recorded: ${input.newFactId}`);
  if (old.supersededAt !== undefined) throw new Error(`timeline fact already superseded: ${input.oldFactId}`);
  return facts.map(fact => fact.id === input.oldFactId
    ? { ...fact, supersededAt: input.supersededAt, supersededByFactId: input.newFactId }
    : fact);
}

/**
 * What SCCE believed about `subjectId` as of `asOf` (a point in *recorded*
 * time, not the facts' own interval time) -- every fact recorded by then
 * that had not yet been superseded by then. A later supersession, recorded
 * after `asOf`, correctly has no effect on this result.
 */
export function beliefsAsOf<V>(
  facts: readonly TimelineFact<V>[],
  subjectId: string,
  asOf: number
): TimelineFact<V>[] {
  return facts
    .filter(fact => fact.subjectId === subjectId
      && fact.recordedAt <= asOf
      && (fact.supersededAt === undefined || fact.supersededAt > asOf))
    .sort((left, right) => left.recordedAt - right.recordedAt || left.id.localeCompare(right.id));
}

/**
 * Among a subject's currently-believed facts, which pairs describe
 * genuinely overlapping (non-disjoint) real-world periods -- i.e. two
 * beliefs that conflict about the same span of time rather than one simply
 * following the other. Both facts remain individually queryable; this
 * function only reports the conflict, it never merges or drops either one.
 */
export function conflictingTimelineFacts<V>(facts: readonly TimelineFact<V>[]): Array<[TimelineFact<V>, TimelineFact<V>]> {
  const pairs: Array<[TimelineFact<V>, TimelineFact<V>]> = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const left = facts[i]!;
      const right = facts[j]!;
      if (left.subjectId !== right.subjectId) continue;
      const relation = allenRelation(left.interval, right.interval);
      if (!allenRelationDisjoint(relation) && relation !== "meets" && relation !== "met_by") pairs.push([left, right]);
    }
  }
  return pairs;
}
