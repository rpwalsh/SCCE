// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, createLanguageInductionEngine } from "../index.js";

describe("plan item 128: translation seed induction rejects unrelated language pairs", () => {
  it("does not seed two same-script, unrelated-content documents via superficial n-gram/shape overlap alone", () => {
    const hasher = createHasher();
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const englishFinance = {
      id: "doc.en-finance",
      text: "The quarterly financial report shows strong revenue growth across every regional division this year.",
      languageHint: "lang.en-adversarial-a"
    };
    const spanishCooking = {
      id: "doc.es-cooking",
      text: "Hoy preparo una sopa de pollo con verduras frescas para toda la familia esta noche.",
      languageHint: "lang.es-adversarial-b"
    };
    const model = engine.induce({ documents: [englishFinance, spanishCooking] });

    const spuriousHighConfidence = model.translationSeeds.filter(seed => seed.score >= 0.55);
    expect(spuriousHighConfidence).toEqual([]);
  });

  it("does not seed two different-script, unrelated-content documents via superficial overlap alone", () => {
    const hasher = createHasher();
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const englishFinance = {
      id: "doc.en-finance-2",
      text: "The quarterly financial report shows strong revenue growth across every regional division this year.",
      languageHint: "lang.en-adversarial-c"
    };
    const russianCooking = {
      id: "doc.ru-cooking",
      text: "Сегодня я готовлю суп с курицей и свежими овощами для всей семьи сегодня вечером.",
      languageHint: "lang.ru-adversarial-d"
    };
    const model = engine.induce({ documents: [englishFinance, russianCooking] });

    const spuriousHighConfidence = model.translationSeeds.filter(seed => seed.score >= 0.55);
    expect(spuriousHighConfidence).toEqual([]);
  });

  it("positive control: genuinely correlated bilingual content (shared numbers) still seeds with real confidence", () => {
    const hasher = createHasher();
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const englishInvoice = {
      id: "doc.en-invoice",
      text: "Invoice number 48291 needs review today.",
      languageHint: "lang.en-control"
    };
    const spanishInvoice = {
      id: "doc.es-invoice",
      text: "48291 aparece en el informe meteorológico de ayer.",
      languageHint: "lang.es-control"
    };
    const model = engine.induce({ documents: [englishInvoice, spanishInvoice] });

    expect(model.translationSeeds.some(seed => seed.sourceSymbol === "48291" && seed.targetSymbol === "48291" && seed.score >= 0.55)).toBe(true);
  });
});
