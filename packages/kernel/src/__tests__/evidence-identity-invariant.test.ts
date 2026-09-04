// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, featureSet } from "../primitives.js";
import { evidenceRetrievalSurface, evidenceWindowText } from "../evidence-retrieval-surface.js";
import {
  evidenceWithGraphPreviewWindows,
  runtimeEvidenceWindowsForRequest
} from "../local-evidence-runtime.js";
import type { EvidenceSpan, GraphNode } from "../types.js";

/**
 * Sealed-eval finding (rehearsal-20260816): every answer emitted zero
 * verified citations. Root cause was an identity violation, not a renderer
 * bug -- the retrieval-time window builders replaced `span.text` with a
 * re-joined, truncated string while leaving `byteStart`/`byteEnd`/
 * `contentHash` describing the original span, so no consumer could ever
 * reconstruct the quoted bytes from the span's own coordinates.
 *
 * These tests pin the invariant end to end: source bytes -> stored span ->
 * retrieval windowing -> citation reconstruction must all agree.
 */
describe("evidence identity invariant (byte range always reconstructs text)", () => {
  const hasher = createHasher();
  const sourceText = [
    "Ada Lovelace was an English mathematician and writer.",
    "She is known for her work on the Analytical Engine.",
    "Lovelace is often considered the first computer programmer.",
    "She died in 1852 at the age of thirty-six.",
    "Her notes were rediscovered much later."
  ].join(" ");
  const sourceBytes = Buffer.from(sourceText, "utf8");

  const span = (): EvidenceSpan => ({
    id: "evidence.identity" as EvidenceSpan["id"],
    sourceId: "source.identity" as EvidenceSpan["sourceId"],
    sourceVersionId: "sv.identity" as EvidenceSpan["sourceVersionId"],
    chunkId: "chunk.identity" as EvidenceSpan["chunkId"],
    contentHash: hasher.digestHex(sourceText) as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: sourceBytes.byteLength,
    charStart: 0,
    charEnd: [...sourceText].length,
    text: sourceText,
    textPreview: sourceText.slice(0, 120),
    languageHints: {},
    scriptHints: {},
    trustVector: { trust: 1 },
    provenance: { title: "Ada Lovelace" },
    features: featureSet(sourceText, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  });

  /** The real citation check: slice the source by the span's own coordinates and require an exact match. */
  const citationReconstructs = (candidate: EvidenceSpan): boolean => {
    const slice = sourceBytes.subarray(candidate.byteStart, candidate.byteEnd);
    return slice.toString("utf8") === candidate.text
      && Buffer.byteLength(candidate.text, "utf8") === slice.length
      && hasher.digestHex(candidate.text) === String(candidate.contentHash);
  };

  it("a stored span reconstructs from its own byte range before any windowing", () => {
    expect(citationReconstructs(span())).toBe(true);
  });

  it("runtimeEvidenceWindowsForRequest never breaks reconstruction", () => {
    // Long enough to trigger real windowing rather than the short-circuit.
    const long = span();
    const padded = `${sourceText} ${"Additional corpus sentence for padding. ".repeat(400)}`;
    long.text = padded;
    long.byteEnd = Buffer.byteLength(padded, "utf8");
    long.charEnd = [...padded].length;
    long.contentHash = hasher.digestHex(padded) as EvidenceSpan["contentHash"];
    const paddedBytes = Buffer.from(padded, "utf8");

    const [windowed] = runtimeEvidenceWindowsForRequest("who is considered the first computer programmer?", [long]);
    expect(windowed).toBeDefined();
    const slice = paddedBytes.subarray(windowed!.byteStart, windowed!.byteEnd);
    expect(slice.toString("utf8")).toBe(windowed!.text);
    expect(hasher.digestHex(windowed!.text)).toBe(String(windowed!.contentHash));
  });

  it("evidenceWithGraphPreviewWindows never breaks reconstruction", () => {
    const node = {
      id: "node.preview" as GraphNode["id"],
      typeId: "dimension.fixture" as GraphNode["typeId"],
      representation: { preview: "Lovelace is often considered the first computer programmer." },
      alpha: 1,
      evidenceIds: ["evidence.identity" as EvidenceSpan["id"]],
      features: [],
      createdAt: 1,
      updatedAt: 1,
      metadata: {}
    } as unknown as GraphNode;

    const [windowed] = evidenceWithGraphPreviewWindows(
      "who is the first computer programmer?",
      [span()],
      [node]
    );
    expect(windowed).toBeDefined();
    expect(citationReconstructs(windowed!)).toBe(true);
  });

  it("a narrowed window is still readable for relevance, but only through the window accessor", () => {
    const node = {
      id: "node.preview2" as GraphNode["id"],
      typeId: "dimension.fixture" as GraphNode["typeId"],
      representation: { preview: "Lovelace is often considered the first computer programmer." },
      alpha: 1,
      evidenceIds: ["evidence.identity" as EvidenceSpan["id"]],
      features: [],
      createdAt: 1,
      updatedAt: 1,
      metadata: {}
    } as unknown as GraphNode;

    const [windowed] = evidenceWithGraphPreviewWindows("first computer programmer", [span()], [node]);
    expect(windowed).toBeDefined();
    // Whatever the window selected, it is reachable for scoring...
    expect(evidenceWindowText(windowed!).length).toBeGreaterThan(0);
    expect(evidenceRetrievalSurface(windowed!).length).toBeGreaterThan(0);
    // ...and the citable text is untouched.
    expect(windowed!.text).toBe(sourceText);
  });

  it("the window is transient: it is never part of the citable identity", () => {
    const withWindow: EvidenceSpan = { ...span(), retrievalWindow: "a re-joined non-contiguous window" };
    expect(citationReconstructs(withWindow)).toBe(true);
    expect(evidenceWindowText(withWindow)).toBe("a re-joined non-contiguous window");
  });
});
