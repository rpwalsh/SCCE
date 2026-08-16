import { describe, expect, it } from "vitest";
import { createHasher } from "../index.js";
import { clusterOpaqueFormClasses } from "../opaque-form-class-clustering.js";
import type { LearnedFormClass, LearnedFormVariant, SurfaceRecordProvenance } from "../language-construction.js";

// Plan item 101. Proves the complete-link anti-chain-collapse guard
// actually holds on a diverse corpus, and specifically proves it against
// the exact failure mode single-link clustering is known for: a bridging
// member that partially overlaps two genuinely unrelated groups must not
// drag them into one giant cluster.

function provenance(sourceExampleIds: readonly string[], evidenceIds: readonly string[]): SurfaceRecordProvenance {
  return { verification: "unverified", methodId: "surface.provenance.induction.v1", sourceExampleIds, evidenceIds };
}

function variant(surface: string, id: string): LearnedFormVariant {
  return {
    id,
    profileKey: "profile.fixture",
    surface,
    origins: [{ sourceExampleId: `example.${id}`, start: 0, end: surface.length, observedSurface: surface, evidenceIds: [`evidence.${id}`] }],
    evidenceIds: [`evidence.${id}`],
    provenance: provenance([`example.${id}`], [`evidence.${id}`]),
    support: 1
  };
}

function formClass(id: string, constructionId: string, surfaces: readonly string[]): LearnedFormClass {
  const variants = surfaces.map((surface, index) => variant(surface, `${id}.v${index}`));
  const evidenceIds = variants.flatMap(v => [...v.evidenceIds]);
  return {
    id,
    constructionId,
    profileKey: "profile.fixture",
    roleId: "role.fixture",
    occurrenceId: "occurrence.0",
    variants,
    evidenceIds,
    provenance: provenance(variants.map(v => v.origins[0]!.sourceExampleId), evidenceIds),
    support: 1
  };
}

describe("clusterOpaqueFormClasses (plan item 101)", () => {
  it("merges genuinely overlapping form classes from different constructions into one cluster", () => {
    const hasher = createHasher();
    const weekdaysA = formClass("weekday.a", "construction.schedule_meeting", ["Monday", "Tuesday", "Wednesday", "Thursday"]);
    const weekdaysB = formClass("weekday.b", "construction.reminder_on_day", ["Tuesday", "Wednesday", "Thursday", "Friday"]);

    const clusters = clusterOpaqueFormClasses({ formClasses: [weekdaysA, weekdaysB], minClusterSimilarity: 0.4, hasher });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.formClassIds).toEqual(["weekday.a", "weekday.b"]);
    expect(clusters[0]!.minPairwiseSimilarity).toBeCloseTo(3 / 5, 5); // {Tue,Wed,Thu} intersect / {Mon,Tue,Wed,Thu,Fri} union
  });

  it("does not collapse three genuinely unrelated categories into one giant cluster on a diverse corpus", () => {
    const hasher = createHasher();
    const weekdays = formClass("weekday", "construction.schedule_meeting", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
    const numbers = formClass("number", "construction.count_items", ["3", "7", "12", "42", "100"]);
    const names = formClass("name", "construction.greet_person", ["Alice", "Bob", "Carla", "David"]);

    const clusters = clusterOpaqueFormClasses({ formClasses: [weekdays, numbers, names], minClusterSimilarity: 0.4, hasher });

    // Every pair here has zero variant overlap (Jaccard 0) -- there is no
    // real distributional evidence they belong together, so the anti-
    // collapse guard must keep all three as singleton clusters, not one
    // giant cluster covering the whole diverse corpus.
    expect(clusters).toHaveLength(3);
    for (const cluster of clusters) expect(cluster.formClassIds).toHaveLength(1);
  });

  it("a bridging form class that partially overlaps two unrelated groups does not chain them together -- the specific failure mode single-link clustering is prone to", () => {
    const hasher = createHasher();
    // weekdayLike and numberLike share zero variants directly -- genuinely
    // unrelated. bridge shares real variants with *both* (a construction
    // that happens to accept both a weekday name and a small ordinal
    // number in the same slot, e.g. "see you <weekday|number>") -- under
    // single-link clustering, bridge-to-weekdayLike and bridge-to-numberLike
    // similarity alone would be enough to chain weekdayLike and numberLike
    // into one cluster through bridge. Complete-link must refuse this: the
    // weekdayLike-to-numberLike cross-pair itself has zero similarity, so
    // no merge that would put them in the same cluster can ever clear the
    // threshold, regardless of how well bridge connects to each alone.
    const weekdayLike = formClass("weekdayLike", "construction.schedule_meeting", ["Monday", "Tuesday", "Wednesday"]);
    const numberLike = formClass("numberLike", "construction.count_items", ["3", "7", "12"]);
    const bridge = formClass("bridge", "construction.see_you_on", ["Monday", "Tuesday", "3"]);

    const clusters = clusterOpaqueFormClasses({ formClasses: [weekdayLike, numberLike, bridge], minClusterSimilarity: 0.3, hasher });

    const clusterContaining = (formClassId: string) => clusters.find(cluster => cluster.formClassIds.includes(formClassId))!;
    const weekdayCluster = clusterContaining("weekdayLike");
    const numberCluster = clusterContaining("numberLike");
    // The real assertion: weekdayLike and numberLike must never land in the
    // same cluster, no matter which cluster bridge itself joins (or stays
    // singleton in).
    expect(weekdayCluster.formClassIds).not.toContain("numberLike");
    expect(numberCluster.formClassIds).not.toContain("weekdayLike");
  });

  it("real similarity above threshold merges, exactly at the boundary does not (a real, non-fuzzy cutoff)", () => {
    const hasher = createHasher();
    // Jaccard = 2/4 = 0.5 exactly.
    const a = formClass("a", "construction.x", ["p", "q", "r"]);
    const b = formClass("b", "construction.y", ["q", "r", "s"]);

    const merges = clusterOpaqueFormClasses({ formClasses: [a, b], minClusterSimilarity: 0.5, hasher });
    expect(merges).toHaveLength(1);

    const staysApart = clusterOpaqueFormClasses({ formClasses: [a, b], minClusterSimilarity: 0.51, hasher });
    expect(staysApart).toHaveLength(2);
  });

  it("a singleton form class reports minPairwiseSimilarity 1 and a stable, deterministic id", () => {
    const hasher = createHasher();
    const solo = formClass("solo", "construction.z", ["only"]);
    const first = clusterOpaqueFormClasses({ formClasses: [solo], minClusterSimilarity: 0.5, hasher: createHasher() });
    const second = clusterOpaqueFormClasses({ formClasses: [solo], minClusterSimilarity: 0.5, hasher: createHasher() });
    expect(first).toHaveLength(1);
    expect(first[0]!.minPairwiseSimilarity).toBe(1);
    expect(first[0]!.id).toBe(second[0]!.id);
  });

  it("rejects an out-of-range minClusterSimilarity rather than silently clamping it", () => {
    const hasher = createHasher();
    const a = formClass("a", "construction.x", ["p"]);
    expect(() => clusterOpaqueFormClasses({ formClasses: [a], minClusterSimilarity: 1.5, hasher })).toThrow();
    expect(() => clusterOpaqueFormClasses({ formClasses: [a], minClusterSimilarity: -0.1, hasher })).toThrow();
  });

  it("fails loudly on an unexpectedly large input rather than silently degrading", () => {
    const hasher = createHasher();
    const many = Array.from({ length: 501 }, (_, index) => formClass(`fc.${index}`, "construction.x", [`v${index}`]));
    expect(() => clusterOpaqueFormClasses({ formClasses: many, minClusterSimilarity: 0.5, hasher })).toThrow();
  });
});
