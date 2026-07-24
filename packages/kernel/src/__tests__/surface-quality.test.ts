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

  it("rejects localization keys, proof markers, and symbolic construct notation", () => {
    for (const text of [
      "i18n:construct.family.answer",
      "[proof] source surface",
      "alpha → beta → gamma",
      "alpha · beta · gamma"
    ]) {
      expect(detectCannedAnswerSpeech(text).map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.controlId);
    }
  });

  it("rejects import inventory telemetry instead of surfacing it", () => {
    const text = "scce2:wiki / run:1; import run count 1; active import run ids 1. imported graph prior count 6400; shard count 1; graph node count 3937; graph edge count 2461; hyperedge count 2. learned prior count 6400; language prior count 0; program prior count 0; direct evidence count 0; profile excerpt evidence count 0. usable for activation; association; alpha field pressure; ppf ranking; exploration. missing direct source spans; missing language priors.";

    const issues = detectCannedAnswerSpeech(text);

    expect(issues.map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.telemetry);
  });

  it("rejects concentrated degenerate n-gram speech without matching prompt vocabulary", () => {
    const issues = detectCannedAnswerSpeech("Invent a the, a the,.");

    expect(issues.map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.degenerate);
    expect(issues.map(issue => issue.id)).toContain(SURFACE_QUALITY_ISSUE_IDS.repeatedNgram);
  });

  it("rejects high-concentration delimiter-separated fragment speech", () => {
    const issues = detectCannedAnswerSpeech("ocean; Invent; Invent a new kind of clock; for; Invent; a city; ocean; Invent a; for a; city.");

    expect(issues.map(issue => issue.kind)).toContain(SURFACE_QUALITY_KIND_IDS.degenerate);
    expect(issues.map(issue => issue.id)).toContain(SURFACE_QUALITY_ISSUE_IDS.fragmentedList);
  });

  it("preserves compact lists, prose, code, and multilingual delimiter surfaces", () => {
    const koreanList = "\ube68\uac15; \ucd08\ub85d; \ud30c\ub791; \ub178\ub791; \ud558\uc580; \uac80\uc815; \ubcf4\ub77c.";
    for (const text of [
      "red; green; blue; amber; black; white; violet.",
      "phase one; phase two; phase three; phase four; phase five; phase six; phase seven.",
      "Open the file; read the header; parse the rows; validate the schema; store the result; close the file; publish the report.",
      "let alpha = 1; let beta = 2; let gamma = 3; let delta = 4; let total = alpha + beta; return total; export default total;",
      koreanList
    ]) {
      expect(detectCannedAnswerSpeech(text)).toEqual([]);
    }
  });

  it("preserves clean short rhetoric and multilingual long-form surfaces", () => {
    for (const text of [
      "Never again, never again.",
      "Signal bridge",
      "ë¬¼ê¸¸ì€ ë„ì‹œì˜ ì—´ê¸°ë¥¼ ë®ì¶”ê³  ë¹—ë¬¼ì„ ì €ìž¥í•˜ë©° ì‚°ì±…ë¡œì™€ ì •ì›ì„ ì—°ê²°í•œë‹¤.",
      "ÙŠØ±Ø¨Ø· Ø§Ù„Ù…Ù…Ø± Ø§Ù„Ø£Ø®Ø¶Ø± Ø¨ÙŠÙ† Ø§Ù„Ù…Ø¯Ø±Ø³Ø© ÙˆØ§Ù„Ø­Ø¯ÙŠÙ‚Ø©ØŒ ÙˆÙŠØ®Ø²Ù† Ù…ÙŠØ§Ù‡ Ø§Ù„Ø£Ù…Ø·Ø§Ø± Ù„Ø±ÙŠ Ø§Ù„Ø£Ø´Ø¬Ø§Ø± Ø®Ù„Ø§Ù„ Ø§Ù„ØµÙŠÙ."
    ]) {
      expect(detectCannedAnswerSpeech(text)).toEqual([]);
    }
  });

  it("rejects a repeated multilingual cycle only after three concentrated occurrences", () => {
    const issues = detectCannedAnswerSpeech("ê°€ë‚˜ ë‹¤ë¼ ê°€ë‚˜ ë‹¤ë¼ ê°€ë‚˜ ë‹¤ë¼");

    expect(issues.map(issue => issue.id)).toContain(SURFACE_QUALITY_ISSUE_IDS.repeatedNgram);
  });

  it("keeps localization out of normal hydrated answer templates", () => {
    const source = readFileSync(new URL("../localization.ts", import.meta.url), "utf8");

    for (const forbidden of [
      "surface.import_summary",
      "pca.boundary",
      "The hydrated brain has",
      "The current answer has no sentence certified",
      "Direct evidence spans available for factual certification",
      "I cannot certify external factual claims",
      "Insufficient support."
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
