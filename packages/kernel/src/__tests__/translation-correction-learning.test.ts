import { describe, expect, it } from "vitest";
import { createCorrectionEngine, createIdFactory, createTranslationEngine, createClock, createHasher, translationCorrectionPriorFromJson, translationCorrectionPriorFromRecord, translationCorrectionPriorToJson } from "../index.js";
import type { EvidenceSpan } from "../types.js";

function evidence(id: string, text: string, language: string, sourceVersionId: string): EvidenceSpan {
  return {
    id: id as never,
    sourceId: `source.${id}` as never,
    sourceVersionId: sourceVersionId as never,
    chunkId: `chunk.${id}` as never,
    contentHash: `hash.${id}` as never,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: text.length,
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.8,
    languageHints: { language },
    scriptHints: { script: "unknown" },
    trustVector: { provenance: 0.8, directness: 0.8, authority: 0.8, freshness: 0.8 },
    provenance: { source: id },
    features: [],
    observedAt: 1
  } as EvidenceSpan;
}

function translation() {
  const clock = createClock({ fixedTime: 100 });
  const hasher = createHasher();
  const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
  return createTranslationEngine({ idFactory, hasher });
}

describe("translation correction learning", () => {
  it("projects a correction into a typed prior without making corrected text an answer", () => {
    const record = createCorrectionEngine({ clock: { now: () => 7 } }).recordFeedback({
      episodeId: "episode.1" as never,
      sourceLanguage: "lang.src",
      targetLanguage: "lang.tgt",
      sourceText: "the quick brown fox",
      generatedTranslation: "la rapida zorro marron",
      correctedTranslation: "la veloce volpe marrone",
      protectedTerms: [],
      changedTerms: [{ original: "rapida", corrected: "veloce", reason: "owner_alignment" }],
      sourceProfileId: "profile.src",
      targetProfileId: "profile.tgt",
      evidenceIds: []
    });
    const prior = translationCorrectionPriorFromRecord(record);
    expect(prior.schema).toBe("scce.translation.correction_prior.v1");
    expect(prior.sourceSymbols.length).toBeGreaterThan(0);
    expect(prior.correctedTargetSymbols).toContain("veloce");
    expect(prior.id).toBe(record.id);
    expect(translationCorrectionPriorFromJson(translationCorrectionPriorToJson(prior))).toEqual(prior);
  });

  it("uses a restored correction prior to select the corrected admitted evidence", () => {
    const engine = translation();
    const sourceText = "the quick brown fox";
    const generated = "la rapida zorro marron";
    const corrected = "la veloce volpe marrone";
    const generatedEvidence = evidence("target.generated", generated, "lang.tgt", "version.generated");
    const correctedEvidence = evidence("target.corrected", corrected, "lang.tgt", "version.corrected");
    const base = {
      text: sourceText,
      sourceLanguage: "lang.src",
      targetLanguage: "lang.tgt",
      evidence: [generatedEvidence, correctedEvidence] as EvidenceSpan[],
      profiles: [] as never[],
      createdAt: 100
    } as const;
    const correction = createCorrectionEngine({ clock: { now: () => 7 } }).recordFeedback({
      episodeId: "episode.1" as never,
      sourceLanguage: "lang.src",
      targetLanguage: "lang.tgt",
      sourceText,
      generatedTranslation: generated,
      correctedTranslation: corrected,
      protectedTerms: [],
      changedTerms: [{ original: "rapida", corrected: "veloce", reason: "owner_alignment" }],
      sourceProfileId: "profile.src",
      targetProfileId: "profile.tgt",
      evidenceIds: []
    });
    // Simulate a process restart: only the serialized durable correction is
    // available to the new planner instance.
    const restoredPrior = translationCorrectionPriorFromRecord(JSON.parse(JSON.stringify(correction)));
    const plan = engine.plan({ ...base, correctionPriors: [restoredPrior] });
    const selected = plan.alignments[0];
    expect(selected?.targetFrameId).toBe(plan.targetFrames.find(frame => frame.text === corrected)?.id);
    expect(selected?.audit).toMatchObject({ correctionBoost: expect.any(Number) });
    expect((selected?.audit as { correctionBoost: number }).correctionBoost).toBeGreaterThan(0);
  });
});
