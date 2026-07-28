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
