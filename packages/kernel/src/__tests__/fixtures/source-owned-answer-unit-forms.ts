// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createLanguageInductionEngine } from "../../language-induction.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "../../language-induction-memory.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToLanguage } from "../../language-memory-runtime.js";
import { primeLearnedAnswerUnitForms } from "../../learned-answer-unit-forms.js";
import { createClock, createHasher } from "../../primitives.js";
import { createIdFactory } from "../../ids.js";
import type { LanguageProfile } from "../../types.js";

export function sourceOwnedAnswerUnitForms(sourceText?: string) {
  const hasher = createHasher();
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
  const text = sourceText ?? "walla r0. wallawalla r0. tinu r0. tinutinu r0. kobo r0. kobokobo r0. 東京湾岸港 r0. 東京湾岸港東京湾岸港 r0. 大阪航海船 r0. 大阪航海船大阪航海船 r0. 神戸調査艇 r0. 神戸調査艇神戸調査艇 r0. סירה r0. סירהסירה r0. מפרש r0. מפרשמפרש r0. נמלית r0. נמליתנמלית r0.";
  const bytes = new TextEncoder().encode(text);
  const sourceVersionId = ids.sourceVersionId(bytes);
  const evidenceId = ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: ids.contentHash(bytes) });
  const profile: LanguageProfile = { id: "profile.learned-answer-forms", sourceVersionId, scripts: [], symbolShapes: [], charNgrams: [], direction: "unknown", entropy: 0, createdAt: 1 };
  const model = createLanguageInductionEngine({ hasher }).induce({ documents: [{ id: "document.learned-answer-forms", sourceVersionId, evidenceIds: [evidenceId], text }] });
  const projection = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory: ids, updatedAt: 1 });
  const runtime = createLanguageMemoryRuntime({ hasher });
  const state = scopeLanguageMemoryStateToLanguage(runtime.hydrate({ models: [], patterns: projection.patterns }), "language.learned-answer-forms", {
    profile: id => id === profile.id ? "language.learned-answer-forms" : "language.foreign", corpus: () => undefined
  });
  const prime = () => primeLearnedAnswerUnitForms({ deltas: state.structuralDeltas ?? [], profileIds: new Set(state.importedPatterns.map(pattern => pattern.profileId)) });
  return { profile, model, projection, runtime, state, prime };
}
