// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { contextualQaRequestFeatures, contextualQaRequestMatches, verifyContextualQaConstruction } from "./contextual-qa-acquisition.js";
import { CONTEXTUAL_QA_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_SOURCE_SYSTEM, type ContextualQaRequestForm } from "./source-owned-contextual-qa.js";
import { LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type DurableLanguageConstructionBundle } from "./language-construction-memory.js";
import { sourceConstructionRequestValueResolver } from "./source-construction-request-binding.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import type { RequestValueBinding } from "./semantic-answer-construct.js";
import type { ScceStorage } from "./storage.js";
import type { EvidenceSpan, Hasher } from "./types.js";

/** Grammar is source-supervised; only this turn's current direct evidence can supply an asserted value. */
export async function contextualQaForRequest(input: {
  storage: ScceStorage; hasher: Hasher; requestText: string; evidence: readonly EvidenceSpan[];
}): Promise<{ binding: RequestValueBinding; bundles: DurableLanguageConstructionBundle[] } | undefined> {
  const direct = input.evidence.filter(span => {
    const admission = jsonRecord(jsonRecord(span.trustVector).admission);
    return span.status === "promoted" && admission.disposition === "promote"
      && jsonRecord(admission.context).intendedUse === "direct_evidence";
  });
  if (!direct.length) return undefined;
  const features = contextualQaRequestFeatures(input.requestText);
  if (!features.length) return undefined;
  const headers = await input.storage.languageMemory.listLanguagePatterns({ view: "request_seed",
    patternSchemas: [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA], sourceSystem: CONTEXTUAL_QA_SOURCE_SYSTEM,
    contextualQaRequestFeatures: features });
  const matching = headers.filter(pattern => {
    const metadata = jsonRecord(pattern.patternJson);
    return metadata.componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE && Array.isArray(metadata.contextualQaRequestForm)
      && contextualQaRequestMatches(metadata.contextualQaRequestForm as ContextualQaRequestForm, input.requestText);
  });
  if (!matching.length) return undefined;
  const ids = [...new Set(matching.map(pattern => pattern.id))];
  const patterns = await input.storage.languageMemory.listLanguagePatterns({ patternIds: ids,
    patternSchemas: [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA], sourceSystem: CONTEXTUAL_QA_SOURCE_SYSTEM, limit: ids.length });
  if (patterns.length !== ids.length || patterns.some(pattern => !ids.includes(pattern.id))) return undefined;
  const evidenceIds = [...new Set(patterns.flatMap(pattern => pattern.evidenceIds))];
  const evidence = await input.storage.evidence.getEvidenceBatch(evidenceIds);
  const bundles = patterns.flatMap(pattern => {
    const bundle = verifyContextualQaConstruction({ pattern, evidence, hasher: input.hasher });
    return bundle ? [bundle] : [];
  });
  if (bundles.length !== patterns.length) return undefined;
  const resolver = sourceConstructionRequestValueResolver({ bundles, graph: { nodes: [], hyperedges: [] } });
  const binding = resolver.resolve(input.requestText, direct);
  return binding && typeof binding !== "string" && typeof binding.subject === "string"
    ? { binding: { ...binding, subject: binding.subject, resolverId: resolver.id }, bundles } : undefined;
}
