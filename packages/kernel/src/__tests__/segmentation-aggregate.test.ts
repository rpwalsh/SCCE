import { describe, expect, it } from "vitest";
import {
  foldSegmentationAggregate,
  segmentationAggregateInformationLabel,
  segmentationAggregateKeyId,
  segmentationAggregateSpacedRatio,
  type SegmentationAggregateKey
} from "../segmentation-aggregate.js";
import { normalizeInformationLabel } from "../information-flow.js";
import { SEGMENTATION_SCHEMA_V2, segmentUnicodeSurfaceV2 } from "../unicode-segmentation-v2.js";

const KEY: SegmentationAggregateKey = {
  segmentationVersion: SEGMENTATION_SCHEMA_V2,
  languageCluster: "script:Hani",
  tenantId: "tenant.fixture",
  corpusRole: "role.fixture",
  activeImportVersion: "import.fixture"
};

describe("segmentation aggregate fold", () => {
  it("seeds a fresh aggregate from the first document's real boundary evidence", () => {
    const model = segmentUnicodeSurfaceV2("我爱北京天安门广场太阳升");
    const aggregate = foldSegmentationAggregate(undefined, KEY, model, 1_000);

    expect(aggregate.documentsObserved).toBe(1);
    expect(aggregate.lexicalSegmentsObserved).toBe(model.lexicalSegments.length);
    expect(aggregate.totalBoundaryObservations).toBeGreaterThan(0);
    expect(segmentationAggregateSpacedRatio(aggregate)).toBe(0);
    expect(aggregate.firstObservedAt).toBe(1_000);
    expect(aggregate.lastObservedAt).toBe(1_000);
  });

  it("accumulates across multiple documents rather than resetting on each fold", () => {
    const first = foldSegmentationAggregate(undefined, KEY, segmentUnicodeSurfaceV2("我爱北京天安门广场太阳升"), 1_000);
    const second = foldSegmentationAggregate(first, KEY, segmentUnicodeSurfaceV2("我们一起去公园散步吧朋友"), 2_000);

    expect(second.documentsObserved).toBe(2);
    expect(second.lexicalSegmentsObserved).toBeGreaterThan(first.lexicalSegmentsObserved);
    expect(second.totalBoundaryObservations).toBeGreaterThan(first.totalBoundaryObservations);
    expect(second.firstObservedAt).toBe(1_000); // preserved from the first document
    expect(second.lastObservedAt).toBe(2_000);
  });

  it("only folds boundary signals matching the aggregate's own languageCluster, not other scripts present in the same document", () => {
    const mixedKey: SegmentationAggregateKey = { ...KEY, languageCluster: "script:Latn" };
    const model = segmentUnicodeSurfaceV2("hello world 我爱北京天安门广场太阳升");
    const aggregate = foldSegmentationAggregate(undefined, mixedKey, model, 1_000);

    const latinSignal = model.boundarySignals.find(signal => signal.scriptId === "script:Latn");
    expect(latinSignal).toBeDefined();
    expect(aggregate.totalBoundaryObservations).toBe(latinSignal!.observations);
  });

  it("reports an undefined spaced ratio when no boundary observations exist yet", () => {
    const aggregate = foldSegmentationAggregate(undefined, KEY, segmentUnicodeSurfaceV2("孤"), 1_000);
    expect(segmentationAggregateSpacedRatio(aggregate)).toBeUndefined();
  });
});

describe("segmentationAggregateKeyId", () => {
  it("produces distinct ids for keys that would collide under naive string concatenation", () => {
    const a: SegmentationAggregateKey = { segmentationVersion: "v", languageCluster: "ab", tenantId: "c", corpusRole: "d", activeImportVersion: "e" };
    const b: SegmentationAggregateKey = { segmentationVersion: "v", languageCluster: "a", tenantId: "bc", corpusRole: "d", activeImportVersion: "e" };
    expect(segmentationAggregateKeyId(a)).not.toBe(segmentationAggregateKeyId(b));
  });

  it("is deterministic for the same key", () => {
    expect(segmentationAggregateKeyId(KEY)).toBe(segmentationAggregateKeyId({ ...KEY }));
  });

  // Plan item 89. This codebase has never formally shipped a distinct "v1"
  // schema constant (SEGMENTATION_SCHEMA_V2 is the only versioned id
  // defined anywhere) -- so this proves the *general* guarantee item 89
  // actually needs, not a fixed v1-vs-v2 pair that happens to exist today:
  // any two different segmentationVersion strings must produce completely
  // non-colliding keys, and folding real evidence under each must never
  // let one version's mass leak into the other's aggregate, for every
  // other key field held identical. A real future v1->v2 (or v2->v3)
  // migration is exactly this shape.
  it("never collides two different segmentation schema versions with every other key field identical", () => {
    const versionA: SegmentationAggregateKey = { ...KEY, segmentationVersion: SEGMENTATION_SCHEMA_V2 };
    const versionB: SegmentationAggregateKey = { ...KEY, segmentationVersion: "scce.segmentation.v3" };
    expect(segmentationAggregateKeyId(versionA)).not.toBe(segmentationAggregateKeyId(versionB));
  });
});

describe("segmentation-version isolation across a hydration path (plan item 89)", () => {
  it("folding real evidence under two different segmentation versions, into a real keyed store, never mixes their aggregates -- a version-isolated hydration path, not just a key-string difference", () => {
    // A minimal but real Map-keyed store, standing in for the durable
    // Postgres-backed SegmentationAggregateStore -- the same
    // segmentationAggregateKeyId this test also checks directly is what a
    // real store implementation keys its rows by, so this exercises the
    // identical isolation mechanism a real hydration path relies on.
    const store = new Map<string, ReturnType<typeof foldSegmentationAggregate>>();
    function observe(key: SegmentationAggregateKey, text: string, observedAt: number): void {
      const id = segmentationAggregateKeyId(key);
      const previous = store.get(id);
      store.set(id, foldSegmentationAggregate(previous, key, segmentUnicodeSurfaceV2(text), observedAt));
    }

    const versionA: SegmentationAggregateKey = { ...KEY, segmentationVersion: SEGMENTATION_SCHEMA_V2 };
    const versionB: SegmentationAggregateKey = { ...KEY, segmentationVersion: "scce.segmentation.v3" };

    // Two real documents observed under version A, one under version B --
    // interleaved, not grouped, so an accidental shared-key bug would show
    // up as cross-contamination regardless of call order.
    observe(versionA, "我爱北京天安门广场太阳升", 1_000);
    observe(versionB, "我们一起去公园散步吧朋友", 2_000);
    observe(versionA, "他每天早上都喝一杯咖啡今天", 3_000);

    const aggregateA = store.get(segmentationAggregateKeyId(versionA))!;
    const aggregateB = store.get(segmentationAggregateKeyId(versionB))!;

    expect(aggregateA.documentsObserved).toBe(2);
    expect(aggregateB.documentsObserved).toBe(1);
    // Real, distinct evidence: version A's total must be exactly the sum of
    // its own two real documents' boundary observations, never inflated by
    // version B's document, and vice versa.
    const soloA1 = foldSegmentationAggregate(undefined, versionA, segmentUnicodeSurfaceV2("我爱北京天安门广场太阳升"), 1_000);
    const soloA2 = foldSegmentationAggregate(soloA1, versionA, segmentUnicodeSurfaceV2("他每天早上都喝一杯咖啡今天"), 3_000);
    expect(aggregateA.totalBoundaryObservations).toBe(soloA2.totalBoundaryObservations);
    expect(aggregateA.lexicalSegmentsObserved).toBe(soloA2.lexicalSegmentsObserved);

    const soloB = foldSegmentationAggregate(undefined, versionB, segmentUnicodeSurfaceV2("我们一起去公园散步吧朋友"), 2_000);
    expect(aggregateB.totalBoundaryObservations).toBe(soloB.totalBoundaryObservations);
    expect(aggregateB.lexicalSegmentsObserved).toBe(soloB.lexicalSegmentsObserved);

    // firstObservedAt/lastObservedAt are also per-version, not globally
    // shared -- version B's single document must own both timestamps.
    expect(aggregateB.firstObservedAt).toBe(2_000);
    expect(aggregateB.lastObservedAt).toBe(2_000);
    expect(aggregateA.firstObservedAt).toBe(1_000);
    expect(aggregateA.lastObservedAt).toBe(3_000);
  });
});

describe("segmentationAggregateInformationLabel", () => {
  it("degrades to public rather than producing a non-public label with no principal when called with no principals", () => {
    // normalizeInformationLabel throws for exactly this combination (a
    // non-public exportClass paired with an empty principals array) --
    // this was a real bug (every persisted row using this label crashed on
    // its next read). The default parameter must never reintroduce it.
    const label = segmentationAggregateInformationLabel(KEY);
    expect(() => normalizeInformationLabel(label)).not.toThrow();
    expect(label.exportClass).toBe("public");
  });

  it("stays internal and valid when real principals are supplied", () => {
    const label = segmentationAggregateInformationLabel(KEY, ["owner.fixture"]);
    expect(() => normalizeInformationLabel(label)).not.toThrow();
    expect(label.exportClass).toBe("internal");
    expect(label.principals).toEqual(["owner.fixture"]);
  });
});
