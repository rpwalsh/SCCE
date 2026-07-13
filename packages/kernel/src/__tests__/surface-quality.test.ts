import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_QUALITY_ISSUE_IDS, SURFACE_QUALITY_KIND_IDS, detectCannedAnswerSpeech } from "../surface-quality.js";

describe("surface quality guard", () => {
  it("rejects certification-boundary boilerplate as canned answer speech", () => {
    const issues = detectCannedAnswerSpeech([
      "The current answer has no sentence certified by the available evidence.",
      "The hydrated brain has 1 active import run.",
      "I cannot certify external factual claims from this shard."
    ].join(" "));

    expect(issues.map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.canned);
    expect(issues.map(issue => issue.id)).toContain(SURFACE_QUALITY_ISSUE_IDS.certification);
  });

  it("rejects raw control IDs and proof boundary keys", () => {
    const issues = detectCannedAnswerSpeech("surface.boundary.unsupported_prior_only force.policy.learned_prior_summary");

    expect(issues.map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.controlId);
  });

  it("rejects unresolved runtime status tokens as final speech", () => {
    const issues = detectCannedAnswerSpeech("[scce:turn.source_anchor_miss]");

    expect(issues.map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.canned);
  });

  it("rejects import inventory telemetry instead of surfacing it", () => {
    const text = "scce2:wiki / run:1; import run count 1; active import run ids 1. imported graph prior count 6400; shard count 1; graph node count 3937; graph edge count 2461; hyperedge count 2. learned prior count 6400; language prior count 0; program prior count 0; direct evidence count 0; profile excerpt evidence count 0. usable for activation; association; alpha field pressure; ppf ranking; exploration. missing direct source spans; missing language priors.";

    const issues = detectCannedAnswerSpeech(text);

    expect(issues.map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.telemetry);
  });

  it("keeps localization out of normal hydrated answer templates", () => {
    const source = readFileSync(new URL("../localization.ts", import.meta.url), "utf8");

    for (const forbidden of [
      "surface.import_summary",
      "pca.boundary",
      "The hydrated brain has",
      "The current answer has no sentence certified",
      "Direct evidence spans available for factual certification",
      "I cannot certify external factual claims"
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
