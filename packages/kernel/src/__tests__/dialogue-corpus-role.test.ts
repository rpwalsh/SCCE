// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CORPUS_ROLE_IDS,
  CORPUS_SOURCE_SYSTEM_IDS,
  canonicalCorpusSourceSystemId,
  corpusRoleIdForSourceSystem,
  createCorpusRegistry,
  languageMemoryHydrationPlan
} from "../index.js";

describe("dialogue corpus role", () => {
  it("is its own role, not the interaction-correction control corpus", () => {
    expect(CORPUS_ROLE_IDS.dialogue).toBeTruthy();
    expect(CORPUS_ROLE_IDS.dialogue).not.toBe(CORPUS_ROLE_IDS.interactionCorrection);
    expect(CORPUS_ROLE_IDS.dialogue).not.toBe(CORPUS_ROLE_IDS.encyclopedic);
    expect(CORPUS_ROLE_IDS.dialogue).not.toBe(CORPUS_ROLE_IDS.publicDomainProse);
    expect(corpusRoleIdForSourceSystem("dialogue")).toBe(CORPUS_ROLE_IDS.dialogue);
    expect(canonicalCorpusSourceSystemId("dialogue")).toBe(CORPUS_SOURCE_SYSTEM_IDS.dialogue);
  });

  it("shares no source system with the corrections corpus that carries request-requirement control patterns", () => {
    // listLanguagePatterns ranks a bounded pool by an even share per pattern kind, so a second population
    // under "corrections" would shrink the request-requirement share on every hydration.
    expect(CORPUS_SOURCE_SYSTEM_IDS.dialogue).not.toBe(CORPUS_SOURCE_SYSTEM_IDS.corrections);
    const registry = createCorpusRegistry([]);
    const dialogue = registry.find(item => item.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue);
    expect(dialogue?.sourceSystem).toBe("dialogue");
  });

  it("hydrates like any other population, and carries no source authority when it does", () => {
    const plan = languageMemoryHydrationPlan(createCorpusRegistry([]));
    expect(plan.map(item => item.sourceSystem)).toContain("dialogue");
    expect(plan.map(item => item.sourceSystem)).toContain("wikipedia");
    const dialogue = createCorpusRegistry([]).find(entry => entry.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue);
    expect(dialogue?.graphEvidenceEligible).toBe(false);
  });

  it("joins the hydration plan under its own role once enabled, leaving the encyclopedic plan unchanged", () => {
    const before = languageMemoryHydrationPlan(createCorpusRegistry([]));
    const registry = createCorpusRegistry([{ sourceSystem: "dialogue", enabled: true }]);
    const after = languageMemoryHydrationPlan(registry);
    expect(after.map(item => item.sourceSystem)).toContain("dialogue");
    expect(after.find(item => item.sourceSystem === "wikipedia"))
      .toEqual(before.find(item => item.sourceSystem === "wikipedia"));

    // Role scoping is what a dialogue-role hydration filters on (surface-language-runtime's roleScopedCorpusPlan).
    const dialogueScoped = after.filter(item => registry.some(entry =>
      entry.sourceSystemId === item.sourceSystemId && entry.corpusRoleId === CORPUS_ROLE_IDS.dialogue
    ));
    expect(dialogueScoped.map(item => item.sourceSystem)).toEqual(["dialogue"]);

    const encyclopedicScoped = after.filter(item => registry.some(entry =>
      entry.sourceSystemId === item.sourceSystemId && entry.corpusRoleId === CORPUS_ROLE_IDS.encyclopedic
    ));
    expect(encyclopedicScoped.map(item => item.sourceSystem)).toEqual(["wikipedia"]);
  });

  it("is not graph-evidence eligible: dialogue is language, never a factual source", () => {
    const registry = createCorpusRegistry([{ sourceSystem: "dialogue", enabled: true }]);
    const dialogue = registry.find(item => item.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue);
    expect(dialogue?.graphEvidenceEligible).toBe(false);
    expect(dialogue?.languageMemoryEligible).toBe(true);
  });
});
