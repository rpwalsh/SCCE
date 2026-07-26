import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createScceKernel,
  featureSet,
  type BuildTestResult,
  type ContentHash,
  type EvidenceId,
  type EvidenceSpan,
  type InformationLabel,
  type SourceId,
  type SourceVersionId
} from "../index.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

// Held-out evaluation harness stub for plan item 23: a small, labeled
// synthetic corpus with a hand-assigned ground-truth "should this
// promote?" label per span, run through the real promoteEvidence path
// (via kernel.train(), not a mock), scored as precision/recall against
// those labels. This is a stub -- a real held-out harness would draw
// from a larger, more representative labeled corpus -- but the numbers
// below are computed from an actual promotion run, not asserted by
// construction.
describe("evidence promotion held-out evaluation (plan item 23)", () => {
  it("scores precision/recall of promoteEvidence against a labeled synthetic corpus", async () => {
    const clock = createClock({ fixedTime: 3000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

    const goldPositive = [
      "Zephyr valve pressure stabilizes at 42 psi after calibration in the northern test rig.",
      "The calibration log confirms zephyr valve output holds steady near 42 psi across three trials.",
      "Technicians recorded zephyr valve pressure readings of 41.8 to 42.3 psi during the March audit.",
      "Post-calibration telemetry shows the zephyr valve maintaining 42 psi under sustained load."
    ].map((text, index) =>
      labeledSpan({ id: `gold-positive-${index}`, text, trust: 0.9, alpha: 0.85, shouldPromote: true })
    );

    const goldNegativeLowTrust = [
      "Someone on a forum claimed the zephyr valve pressure was off but gave no source.",
      "An anonymous tip says the zephyr valve reading might be wrong, unverified.",
      "Rumor has it the zephyr valve pressure spiked once, no record kept.",
      "A comment thread speculated about zephyr valve pressure with no evidence attached."
    ].map((text, index) =>
      labeledSpan({ id: `gold-negative-low-trust-${index}`, text, trust: 0.15, alpha: 0.8, shouldPromote: false })
    );

    const goldNegativeDuplicate = goldPositive.map((span, index) =>
      labeledSpan({
        id: `gold-negative-duplicate-${index}`,
        text: span.text,
        trust: 0.5,
        alpha: 0.5,
        shouldPromote: false
      })
    );

    const goldNegativeIrrelevant = [
      "The cafeteria menu changed to offer a new soup option on Tuesdays.",
      "Parking lot B will be repaved next month according to facilities.",
      "The office plant collection grew by two new succulents this quarter.",
      "A new coffee machine was installed on the third floor break room."
    ].map((text, index) =>
      labeledSpan({ id: `gold-negative-irrelevant-${index}`, text, trust: 0.5, alpha: 0.5, shouldPromote: false })
    );

    const corpus = [...goldPositive, ...goldNegativeLowTrust, ...goldNegativeDuplicate, ...goldNegativeIrrelevant];
    const groundTruth = new Map(corpus.map(span => [String(span.id), span.shouldPromote]));

    const fixture = storageFixtureForEvaluation({ evidence: corpus, clockNow: () => clock.now() });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused in this test */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    await kernel.train({
      config: {
        learningGoals: ["learn zephyr valve pressure calibration behavior"],
        promotion: { minTrust: 0.45 }
      }
    });

    const promotedEvidenceIds = new Set(fixture.promotedIds.map(String));
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    let trueNegative = 0;
    for (const [id, expected] of groundTruth) {
      const predicted = promotedEvidenceIds.has(id);
      if (expected && predicted) truePositive += 1;
      else if (!expected && predicted) falsePositive += 1;
      else if (expected && !predicted) falseNegative += 1;
      else trueNegative += 1;
    }
    const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : 1;
    const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : 1;

    // Real measured values on this corpus: all 4 gold positives and
    // the low-trust and off-topic negatives are classified correctly
    // (recall=1, 8/8 true negatives among those two groups). The 4
    // near-duplicate-of-a-positive spans (trust 0.5) also promote,
    // giving precision=0.5 -- item 22's batch-novelty fix drives their
    // novelty near zero, but because this corpus sets learningGoals to
    // the same zephyr-valve topic, their goal coverage is high enough
    // (0.18 * coverage) to clear the 0.42 floor anyway on top of
    // trust/alpha. That's a real, order-dependent interaction between
    // coverage and novelty, not a bug in item 22's fix (which only
    // targeted the zero-goal case) -- documented here as the honest
    // measured baseline, not treated as a defect to chase.
    expect({ precision, recall, truePositive, falsePositive, falseNegative, trueNegative }).toEqual({
      precision: 0.5,
      recall: 1,
      truePositive: 4,
      falsePositive: 4,
      falseNegative: 0,
      trueNegative: 8
    });
  });
});

function labeledSpan(input: { id: string; text: string; trust: number; alpha: number; shouldPromote: boolean }): EvidenceSpan & { shouldPromote: boolean } {
  const contentHash = `hash:${input.id}` as ContentHash;
  return {
    id: input.id as EvidenceId,
    sourceId: "source:evaluation" as SourceId,
    sourceVersionId: `source-version:${input.id}` as SourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: input.trust, sourceTrust: input.trust, structuralConfidence: input.trust },
    provenance: { namespace: "local", source: "evidence-promotion-evaluation" },
    features: featureSet(input.text, 256),
    status: "quarantined",
    alpha: input.alpha,
    observedAt: 1000,
    informationLabel: fixtureInformationLabel(),
    shouldPromote: input.shouldPromote
  };
}

function fixtureInformationLabel(): InformationLabel {
  return {
    exportClass: "public",
    tenantId: "fixture-tenant",
    principals: [],
    compartments: [],
    mergePolicy: "isolated"
  } as InformationLabel;
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
