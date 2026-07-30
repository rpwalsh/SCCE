import { describe, expect, it } from "vitest";
import {
  priorRejectedHypothesesFromCandidates,
  reviveMatchingPriorRejectedHypothesis,
  metadataWithRuntimeReplanMotion,
  runtimeReplanMotionFromMetadata,
  type RuntimeReplanMotion
} from "../runtime-motion.js";
import { createHasher } from "../primitives.js";
import type { CandidateSurface } from "../candidate-contract.js";

function rejectedRow(kind: CandidateSurface["kind"], answer: string, reasons: readonly string[]): { candidate: Pick<CandidateSurface, "kind" | "answer">; reasons: readonly string[] } {
  return { candidate: { kind, answer }, reasons };
}

const hasher = createHasher();

function baseMotion(overrides: Partial<RuntimeReplanMotion> = {}): RuntimeReplanMotion {
  return {
    schema: "scce.runtime_motion.learn_hydrate_replan.v1",
    motionId: "motion.learn_hydrate_replan",
    guardId: "guard:fixture",
    attempt: 1,
    trigger: "coherence_support_failure",
    requestedAuthority: "factual",
    parentEpisodeId: "episode:fixture",
    queryHash: hasher.digestHex("what controls pump alpha?"),
    connectorConfigured: true,
    status: "hydrated",
    searchResultCount: 1,
    fetchedSourceCount: 1,
    ingestedSourceCount: 1,
    ingestedEvidenceCount: 1,
    sourceUris: [],
    sourceSurfaces: [],
    failures: [],
    priorRejectedHypotheses: [],
    ...overrides
  };
}

describe("priorRejectedHypothesesFromCandidates", () => {
  it("builds a bounded, content-addressed fingerprint per rejected candidate", () => {
    const rejected = [
      rejectedRow("proof-answer", "Pump Alpha is controlled by the manual valve.", ["insufficient_evidence"]),
      rejectedRow("dialogue-continuation", "Could you clarify which pump you mean?", ["low_actionability"])
    ];
    const fingerprints = priorRejectedHypothesesFromCandidates(rejected, hasher);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).toEqual({
      kind: "proof-answer",
      textHash: hasher.digestHex("pump alpha is controlled by the manual valve."),
      rejectionReasons: ["insufficient_evidence"]
    });
  });

  it("caps at 8 entries and 6 reasons per entry", () => {
    const rejected = Array.from({ length: 12 }, (_, index) =>
      rejectedRow("proof-answer", `candidate ${index}`, Array.from({ length: 10 }, (_, r) => `reason-${r}`)));
    const fingerprints = priorRejectedHypothesesFromCandidates(rejected, hasher);
    expect(fingerprints).toHaveLength(8);
    expect(fingerprints[0]!.rejectionReasons).toHaveLength(6);
  });
});

describe("reviveMatchingPriorRejectedHypothesis", () => {
  it("matches a candidate whose kind and normalized answer text match a prior rejection, ignoring case/whitespace", () => {
    const prior = priorRejectedHypothesesFromCandidates(
      [rejectedRow("proof-answer", "Pump Alpha is controlled by the manual valve.", ["insufficient_evidence"])],
      hasher
    );
    const revived = reviveMatchingPriorRejectedHypothesis(
      { kind: "proof-answer", answer: "  PUMP ALPHA   is controlled by the manual valve.  " },
      prior,
      hasher
    );
    expect(revived).toEqual({
      kind: "proof-answer",
      textHash: hasher.digestHex("pump alpha is controlled by the manual valve."),
      rejectionReasons: ["insufficient_evidence"]
    });
  });

  it("does not match when the kind differs, even with identical text", () => {
    const prior = priorRejectedHypothesesFromCandidates(
      [rejectedRow("proof-answer", "Same text.", ["insufficient_evidence"])],
      hasher
    );
    const revived = reviveMatchingPriorRejectedHypothesis({ kind: "dialogue-continuation", answer: "Same text." }, prior, hasher);
    expect(revived).toBeUndefined();
  });

  it("does not match when the text genuinely differs", () => {
    const prior = priorRejectedHypothesesFromCandidates(
      [rejectedRow("proof-answer", "Pump Alpha is controlled by the manual valve.", ["insufficient_evidence"])],
      hasher
    );
    const revived = reviveMatchingPriorRejectedHypothesis(
      { kind: "proof-answer", answer: "Pump Alpha is controlled by a digital controller." },
      prior,
      hasher
    );
    expect(revived).toBeUndefined();
  });

  it("returns undefined against an empty prior-rejected set", () => {
    expect(reviveMatchingPriorRejectedHypothesis({ kind: "proof-answer", answer: "anything" }, [], hasher)).toBeUndefined();
  });
});

describe("priorRejectedHypotheses metadata round-trip", () => {
  it("survives metadataWithRuntimeReplanMotion -> runtimeReplanMotionFromMetadata unchanged", () => {
    const prior = priorRejectedHypothesesFromCandidates(
      [rejectedRow("proof-answer", "Pump Alpha is controlled by the manual valve.", ["insufficient_evidence"])],
      hasher
    );
    const motion = baseMotion({ priorRejectedHypotheses: prior });
    const metadata = metadataWithRuntimeReplanMotion(undefined, motion);
    const parsed = runtimeReplanMotionFromMetadata(metadata, motion.queryHash);
    expect(parsed?.priorRejectedHypotheses).toEqual(prior);
  });

  it("defaults to an empty array when metadata carries no prior-rejected data", () => {
    const motion = baseMotion();
    const metadata = metadataWithRuntimeReplanMotion(undefined, motion);
    const parsed = runtimeReplanMotionFromMetadata(metadata, motion.queryHash);
    expect(parsed?.priorRejectedHypotheses).toEqual([]);
  });

  it("ignores malformed entries rather than throwing", () => {
    const motion = baseMotion();
    const metadata = metadataWithRuntimeReplanMotion(undefined, motion);
    const record = metadata as Record<string, unknown>;
    const runtimeMotion = record.runtimeMotion as Record<string, unknown>;
    runtimeMotion.priorRejectedHypotheses = [{ kind: "proof-answer" }, "not-an-object", { kind: 5, textHash: "x" }, { kind: "ok", textHash: "y", rejectionReasons: ["r"] }];
    const parsed = runtimeReplanMotionFromMetadata(metadata, motion.queryHash);
    expect(parsed?.priorRejectedHypotheses).toEqual([{ kind: "ok", textHash: "y", rejectionReasons: ["r"] }]);
  });
});
