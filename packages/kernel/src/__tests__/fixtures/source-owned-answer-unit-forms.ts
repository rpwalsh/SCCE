// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createLanguageInductionEngine } from "../../language-induction.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "../../language-induction-memory.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToLanguage } from "../../language-memory-runtime.js";
import { primeLearnedAnswerUnitForms } from "../../learned-answer-unit-forms.js";
import { createClock, createHasher } from "../../primitives.js";
import { createIdFactory } from "../../ids.js";
import { createLanguageAcquisitionEngine } from "../../language.js";
import { createEvidenceExtractor } from "../../evidence.js";
import { canonicalStringify } from "../../primitives.js";

export function sourceOwnedAnswerUnitForms(sourceText?: string) {
  const hasher = createHasher();
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
  const text = sourceText ?? "walla r0. wallawalla r0. tinu r0. tinutinu r0. kobo r0. kobokobo r0. 東京湾岸港 r0. 東京湾岸港東京湾岸港 r0. 大阪航海船 r0. 大阪航海船大阪航海船 r0. 神戸調査艇 r0. 神戸調査艇神戸調査艇 r0. סירה r0. סירהסירה r0. מפרש r0. מפרשמפרש r0. נמלית r0. נמליתנמלית r0.";
  const bytes = new TextEncoder().encode(text);
  const uri = "fixture://source-owned-answer-forms";
  const sourceId = ids.sourceId("workspace", uri);
  const sourceVersionId = ids.sourceVersionId(canonicalStringify({ sourceId, contentHash: ids.contentHash(bytes), role: "original" }));
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 });
  const evidence = createEvidenceExtractor({ hasher, idFactory: ids }).extract({ sourceId, sourceVersionId, uri, namespace: "workspace",
    mediaType: "text/plain", text, languageProfile: profile, observedAt: 1, exactSourceText: true,
    metadata: { sourceSystem: "workspace", purpose: "authored_language_examples" }, sourceTrust: { identity: 1, integrity: 1, parserReliability: 1,
      directness: 1, authority: 1, freshness: 1, independenceGroup: uri, accessScope: "fixture", licenseStatus: "fixture" } }).spans
    .map(span => ({ ...span, status: "promoted" as const }));
  const model = createLanguageInductionEngine({ hasher }).induce({ documents: evidence.map(span => ({
    id: String(span.id), sourceVersionId, evidenceIds: [span.id], text: span.text
  })) });
  const projection = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory: ids, updatedAt: 1, sourceSystem: "workspace" });
  const runtime = createLanguageMemoryRuntime({ hasher });
  const state = scopeLanguageMemoryStateToLanguage(runtime.hydrate({ models: [], patterns: projection.patterns }), "language.learned-answer-forms", {
    profile: id => id === profile.id ? "language.learned-answer-forms" : "language.foreign", corpus: () => undefined
  });
  const prime = () => primeLearnedAnswerUnitForms({ deltas: state.structuralDeltas ?? [], profileIds: new Set(state.importedPatterns.map(pattern => pattern.profileId)) });
  return { profile, evidence, model, projection, runtime, state, prime };
}
