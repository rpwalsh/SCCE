import { describe, expect, it } from "vitest";
import {
  ALLEN_RELATION_INVERSE,
  allenRelation,
  allenRelationDisjoint,
  beliefsAsOf,
  conflictingTimelineFacts,
  recordTimelineFact,
  supersedeTimelineFact,
  type AllenRelation,
  type Interval,
  type TimelineFact
} from "../temporal-interval-algebra.js";

// Strictly positive-length only (start < end) -- Allen's algebra is not a
// well-defined extension for degenerate zero-length intervals, see
// assertValidInterval's doc comment. The dedicated rejection test below
// exercises that boundary explicitly instead.
function allIntervals(max: number): Interval[] {
  const intervals: Interval[] = [];
  for (let start = 0; start <= max; start++) {
    for (let end = start + 1; end <= max; end++) intervals.push({ start, end });
  }
  return intervals;
}

describe("Allen interval algebra (plan item 169)", () => {
  it("relation(a,b) and relation(b,a) are always exact inverses, over every interval pair up to length 5", () => {
    const intervals = allIntervals(5);
    for (const a of intervals) {
      for (const b of intervals) {
        const forward = allenRelation(a, b);
        const backward = allenRelation(b, a);
        expect(backward).toBe(ALLEN_RELATION_INVERSE[forward]);
      }
    }
  });

  it("every one of the 13 relations is actually reachable, not just theoretically defined", () => {
    const intervals = allIntervals(5);
    const seen = new Set<AllenRelation>();
    for (const a of intervals) for (const b of intervals) seen.add(allenRelation(a, b));
    const expectedRelations: AllenRelation[] = [
      "before", "after", "meets", "met_by", "overlaps", "overlapped_by",
      "during", "contains", "starts", "started_by", "finishes", "finished_by", "equals"
    ];
    for (const relation of expectedRelations) expect(seen.has(relation)).toBe(true);
  });

  it("distinguishes touching-at-a-point (meets) from genuine overlap", () => {
    expect(allenRelation({ start: 0, end: 5 }, { start: 5, end: 10 })).toBe("meets");
    expect(allenRelation({ start: 0, end: 6 }, { start: 5, end: 10 })).toBe("overlaps");
    expect(allenRelationDisjoint("meets")).toBe(false);
    expect(allenRelationDisjoint("before")).toBe(true);
  });

  it("hand-verified cases for starts/started_by, finishes/finished_by, during/contains, equals", () => {
    expect(allenRelation({ start: 0, end: 3 }, { start: 0, end: 8 })).toBe("starts");
    expect(allenRelation({ start: 0, end: 8 }, { start: 0, end: 3 })).toBe("started_by");
    expect(allenRelation({ start: 5, end: 8 }, { start: 0, end: 8 })).toBe("finishes");
    expect(allenRelation({ start: 0, end: 8 }, { start: 5, end: 8 })).toBe("finished_by");
    expect(allenRelation({ start: 2, end: 4 }, { start: 0, end: 8 })).toBe("during");
    expect(allenRelation({ start: 0, end: 8 }, { start: 2, end: 4 })).toBe("contains");
    expect(allenRelation({ start: 1, end: 4 }, { start: 1, end: 4 })).toBe("equals");
  });

  it("rejects an interval with start after end", () => {
    expect(() => allenRelation({ start: 5, end: 1 }, { start: 0, end: 1 })).toThrow(/positive length/);
  });

  it("rejects a degenerate zero-length (point) interval rather than inventing an arbitrary classification for it", () => {
    // A point sitting exactly at another interval's start would otherwise
    // satisfy both the textbook `meets` and `starts` conditions at once --
    // this is the real ambiguity the property test above caught (a point
    // equal to another point satisfied both `meets` and `equals`
    // simultaneously, breaking the inverse-relation invariant).
    expect(() => allenRelation({ start: 2, end: 2 }, { start: 2, end: 5 })).toThrow(/positive length/);
  });
});

describe("timeline facts preserve conflicting/superseded beliefs (plan item 170)", () => {
  function baseFacts(): TimelineFact<string>[] {
    let facts = recordTimelineFact<string>([], {
      id: "fact.codename.v1",
      subjectId: "release.codename",
      interval: { start: 0, end: 1_000 },
      value: "Astra",
      recordedAt: 100
    });
    facts = recordTimelineFact(facts, {
      id: "fact.codename.v2",
      subjectId: "release.codename",
      interval: { start: 0, end: 1_000 },
      value: "Aster",
      recordedAt: 500
    });
    facts = supersedeTimelineFact(facts, {
      oldFactId: "fact.codename.v1",
      newFactId: "fact.codename.v2",
      supersededAt: 500
    });
    return facts;
  }

  it("a later correction does not change what SCCE believed at an earlier snapshot", () => {
    const facts = baseFacts();
    const asOf300 = beliefsAsOf(facts, "release.codename", 300);
    expect(asOf300.map(fact => fact.value)).toEqual(["Astra"]);

    const asOf700 = beliefsAsOf(facts, "release.codename", 700);
    expect(asOf700.map(fact => fact.value)).toEqual(["Aster"]);
  });

  it("querying exactly at the recordedAt/supersededAt boundary is consistent (recorded-at-or-before, superseded-strictly-after)", () => {
    const facts = baseFacts();
    expect(beliefsAsOf(facts, "release.codename", 500).map(fact => fact.value)).toEqual(["Aster"]);
    expect(beliefsAsOf(facts, "release.codename", 99).map(fact => fact.value)).toEqual([]);
  });

  it("supersession never mutates or deletes the old fact's own content", () => {
    const facts = baseFacts();
    const original = facts.find(fact => fact.id === "fact.codename.v1")!;
    expect(original.value).toBe("Astra");
    expect(original.supersededAt).toBe(500);
    expect(original.supersededByFactId).toBe("fact.codename.v2");
  });

  it("cannot supersede an already-superseded fact, or supersede with an unrecorded fact id", () => {
    const facts = baseFacts();
    expect(() => supersedeTimelineFact(facts, { oldFactId: "fact.codename.v1", newFactId: "fact.codename.v2", supersededAt: 600 }))
      .toThrow(/already superseded/);
    expect(() => supersedeTimelineFact(facts, { oldFactId: "fact.codename.v2", newFactId: "fact.codename.missing", supersededAt: 600 }))
      .toThrow(/must already be recorded/);
  });

  it("two genuinely conflicting (overlapping-interval) beliefs about the same subject are both preserved and reported, never silently merged", () => {
    let facts = recordTimelineFact<string>([], {
      id: "fact.a",
      subjectId: "meeting.room",
      interval: { start: 0, end: 100 },
      value: "booked by Alice",
      recordedAt: 1
    });
    facts = recordTimelineFact(facts, {
      id: "fact.b",
      subjectId: "meeting.room",
      interval: { start: 50, end: 150 },
      value: "booked by Bob",
      recordedAt: 2
    });
    const conflicts = conflictingTimelineFacts(facts);
    expect(conflicts).toHaveLength(1);
    expect(new Set(conflicts[0]!.map(fact => fact.id))).toEqual(new Set(["fact.a", "fact.b"]));
    // Both remain individually queryable -- neither disappeared.
    expect(beliefsAsOf(facts, "meeting.room", 10).map(fact => fact.id).sort()).toEqual(["fact.a", "fact.b"]);
  });

  it("facts that merely meet (touch at a point) or are fully sequential are not reported as conflicting", () => {
    let facts = recordTimelineFact<string>([], {
      id: "fact.morning",
      subjectId: "meeting.room.2",
      interval: { start: 0, end: 50 },
      value: "booked by Alice",
      recordedAt: 1
    });
    facts = recordTimelineFact(facts, {
      id: "fact.afternoon",
      subjectId: "meeting.room.2",
      interval: { start: 50, end: 100 },
      value: "booked by Bob",
      recordedAt: 2
    });
    expect(conflictingTimelineFacts(facts)).toHaveLength(0);
  });
});
