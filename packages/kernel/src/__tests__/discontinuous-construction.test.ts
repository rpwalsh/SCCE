import { describe, expect, it } from "vitest";
import {
  interleaveConstructions,
  moveSpan,
  reassembleLogicalSurface,
  validateDiscontinuousConstruction,
  type DiscontinuousConstruction
} from "../discontinuous-construction.js";


describe("discontinuous construction validity (plan item 97)", () => {
  it("rejects a construction whose spans overlap in byte range", () => {
    const construction: DiscontinuousConstruction = {
      id: "c",
      spans: [
        { id: "a", order: 0, utf16Start: 0, utf16End: 10, portIds: [] },
        { id: "b", order: 1, utf16Start: 5, utf16End: 15, portIds: [] }
      ]
    };
    const result = validateDiscontinuousConstruction(construction);
    expect(result.valid).toBe(false);
    expect(result.reasons.some(reason => reason.includes("overlap"))).toBe(true);
  });

  it("rejects a construction with a zero-or-negative-length span", () => {
    const construction: DiscontinuousConstruction = { id: "c", spans: [{ id: "a", order: 0, utf16Start: 5, utf16End: 5, portIds: [] }] };
    expect(validateDiscontinuousConstruction(construction).valid).toBe(false);
  });

  it("rejects a construction with a duplicated logical order", () => {
    const construction: DiscontinuousConstruction = {
      id: "c",
      spans: [
        { id: "a", order: 0, utf16Start: 0, utf16End: 5, portIds: [] },
        { id: "b", order: 0, utf16Start: 10, utf16End: 15, portIds: [] }
      ]
    };
    expect(validateDiscontinuousConstruction(construction).valid).toBe(false);
  });

  it("accepts genuinely non-overlapping, uniquely-ordered spans regardless of byte order", () => {
    const construction: DiscontinuousConstruction = {
      id: "c",
      spans: [
        { id: "a", order: 0, utf16Start: 10, utf16End: 15, portIds: [] },
        { id: "b", order: 1, utf16Start: 0, utf16End: 5, portIds: [] }
      ]
    };
    expect(validateDiscontinuousConstruction(construction).valid).toBe(true);
  });
});

describe("logical reassembly uses reading order, not byte position (plan item 97)", () => {
  it("reassembles spans in logical order even when it differs from their byte-position order", () => {
    const construction: DiscontinuousConstruction = {
      id: "c",
      spans: [
        { id: "second-in-source", order: 0, utf16Start: 5, utf16End: 10, portIds: ["p1"] },
        { id: "first-in-source", order: 1, utf16Start: 0, utf16End: 5, portIds: ["p2"] }
      ]
    };
    const text = "AAAAABBBBB"; // first-in-source = "AAAAA" (0-5), second-in-source = "BBBBB" (5-10)
    expect(reassembleLogicalSurface(construction, text)).toBe("BBBBB AAAAA");
  });

  it("refuses to reassemble an invalid (overlapping) construction", () => {
    const construction: DiscontinuousConstruction = {
      id: "c",
      spans: [
        { id: "a", order: 0, utf16Start: 0, utf16End: 5, portIds: [] },
        { id: "b", order: 1, utf16Start: 3, utf16End: 8, portIds: [] }
      ]
    };
    expect(() => reassembleLogicalSurface(construction, "0123456789")).toThrow(/overlap/);
  });
});

describe("move: preserves byte coordinates and port bindings, changes only logical order (plan item 97)", () => {
  it("moving a span changes its order but preserves its byte coordinates and port bindings exactly", () => {
    const construction: DiscontinuousConstruction = {
      id: "c",
      spans: [
        { id: "a", order: 0, utf16Start: 0, utf16End: 5, portIds: ["subject"] },
        { id: "b", order: 1, utf16Start: 5, utf16End: 10, portIds: ["object"] }
      ]
    };
    const moved = moveSpan(construction, "a", 2);
    const movedSpan = moved.spans.find(span => span.id === "a")!;
    expect(movedSpan.order).toBe(2);
    expect(movedSpan.utf16Start).toBe(0);
    expect(movedSpan.utf16End).toBe(5);
    expect(movedSpan.portIds).toEqual(["subject"]);
    // The unmoved span is completely untouched.
    expect(moved.spans.find(span => span.id === "b")).toEqual(construction.spans[1]);
  });

  it("refuses a move that collides with another span's existing logical order", () => {
    const construction: DiscontinuousConstruction = {
      id: "c",
      spans: [
        { id: "a", order: 0, utf16Start: 0, utf16End: 5, portIds: [] },
        { id: "b", order: 1, utf16Start: 5, utf16End: 10, portIds: [] }
      ]
    };
    expect(() => moveSpan(construction, "a", 1)).toThrow(/duplicate logical order/);
  });

  it("rejects moving an unknown span", () => {
    const construction: DiscontinuousConstruction = { id: "c", spans: [] };
    expect(() => moveSpan(construction, "missing", 0)).toThrow(/unknown span/);
  });
});

describe("interleave: combines two constructions' spans, preserving each span's own coordinates and bindings (plan item 97)", () => {
  it("alternates spans from both inputs into one fresh, gap-free logical order", () => {
    const negation: DiscontinuousConstruction = {
      id: "negation",
      spans: [
        { id: "neg1", order: 0, utf16Start: 0, utf16End: 3, portIds: ["neg"] },
        { id: "neg2", order: 1, utf16Start: 10, utf16End: 13, portIds: ["neg-tail"] }
      ]
    };
    const contrast: DiscontinuousConstruction = {
      id: "contrast",
      spans: [
        { id: "con1", order: 0, utf16Start: 4, utf16End: 7, portIds: ["contrast"] },
        { id: "con2", order: 1, utf16Start: 14, utf16End: 17, portIds: ["contrast-tail"] }
      ]
    };
    const combined = interleaveConstructions(negation, contrast, "combined");
    expect(combined.spans.map(span => span.id)).toEqual(["neg1", "con1", "neg2", "con2"]);
    expect(combined.spans.map(span => span.order)).toEqual([0, 1, 2, 3]);
    // Byte coordinates and port bindings are exactly preserved.
    const neg1 = combined.spans.find(span => span.id === "neg1")!;
    expect(neg1.utf16Start).toBe(0);
    expect(neg1.utf16End).toBe(3);
    expect(neg1.portIds).toEqual(["neg"]);
  });

  it("refuses to interleave two constructions whose spans overlap each other in byte range", () => {
    const a: DiscontinuousConstruction = { id: "a", spans: [{ id: "a1", order: 0, utf16Start: 0, utf16End: 10, portIds: [] }] };
    const b: DiscontinuousConstruction = { id: "b", spans: [{ id: "b1", order: 0, utf16Start: 5, utf16End: 15, portIds: [] }] };
    expect(() => interleaveConstructions(a, b, "combined")).toThrow(/overlap/);
  });
});
