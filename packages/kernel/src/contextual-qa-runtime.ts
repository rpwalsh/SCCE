// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { contextualQaRequestFeatures, contextualQaRequestMatches, verifyContextualQaConstruction } from "./contextual-qa-acquisition.js";
import { CONTEXTUAL_QA_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_SOURCE_SYSTEM, type ContextualQaRequestForm } from "./source-owned-contextual-qa.js";
import { LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type DurableLanguageConstructionBundle } from "./language-construction-memory.js";
import { sourceConstructionRequestValueResolver } from "./source-construction-request-binding.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import { canonicalStringify } from "./primitives.js";
import type { RequestValueBinding } from "./semantic-answer-construct.js";
import type { ScceStorage } from "./storage.js";
import type { EvidenceSpan, Hasher } from "./types.js";
import { SOURCE_CONSTRUCTION_READ_BUDGET } from "./request-language-hydration.js";
import { canonicalJsonByteLength } from "./canonical-json-digest.js";
import { evidenceProofBoundary } from "./proof-boundary.js";

export interface VerifiedContextualQaConstructions {
  readonly requestDigest: string;
  readonly bundles: DurableLanguageConstructionBundle[];
  readonly patternIds: string[];
}
export interface VerifiedContextualQaBinding extends VerifiedContextualQaConstructions {
  readonly binding: RequestValueBinding;
}
const constructionReceipts = new WeakMap<VerifiedContextualQaConstructions, { storage: ScceStorage; generation: number | undefined }>();
const bindingReceipts = new WeakMap<VerifiedContextualQaBinding, { storage: ScceStorage; generation: number | undefined; authorityContext: object | undefined; sources: string }>();
function freezeQaValue<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeQaValue(child); Object.freeze(value); }
  return value;
}
function directEvidence(span: EvidenceSpan): boolean {
  const admission = jsonRecord(jsonRecord(span.trustVector).admission);
  // The proof boundary is the repository-wide authority for whether a
  // promoted, exact source span can certify a factual claim.  Dialogue
  // corpora are admitted for language learning but stamp their retained
  // source spans as direct evidence; requiring the corpus-wide intended-use
  // label here contradicted that authoritative per-span classification and
  // made source-observed QA unusable after a cold restart.
  return admission.disposition === "promote" && evidenceProofBoundary(span).certifiesFactualProof;
}
function sourceReceipts(evidence: readonly EvidenceSpan[], hasher: Hasher): string {
  return canonicalStringify(evidence.map(span => [String(span.id), String(span.sourceId), String(span.sourceVersionId), String(span.contentHash),
    hasher.digestHex(span.text), span.charStart, span.charEnd, span.informationLabel ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
export function contextualQaBindingVerified(input: { result: VerifiedContextualQaBinding; storage: ScceStorage; requestText: string;
  evidence: readonly EvidenceSpan[]; hasher: Hasher; generation: number; authorityContext: object }): boolean {
  const result = input.result;
  if (!result || typeof result !== "object") return false;
  const receipt = bindingReceipts.get(result);
  if (!receipt || receipt.storage !== input.storage || receipt.generation !== input.generation || receipt.authorityContext !== input.authorityContext
    || result.requestDigest !== input.hasher.digestHex(input.requestText)) return false;
  const ids = new Set(result.binding.evidenceIds), current = input.evidence.filter(span => ids.has(String(span.id)) && directEvidence(span));
  return ids.size > 0 && current.length === ids.size && sourceReceipts(current, input.hasher) === receipt.sources;
}

/** Header matching is nongenerative; full body hydration still replays exact human supervision. */
export async function contextualQaConstructionsForRequest(input: {
  storage: ScceStorage; hasher: Hasher; requestText: string; generation?: number;
}): Promise<VerifiedContextualQaConstructions | undefined> {
  const features = contextualQaRequestFeatures(input.requestText);
  if (!features.length) return undefined;
  const headers = await input.storage.languageMemory.listLanguagePatterns({ view: "request_seed",
    patternSchemas: [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA], sourceSystem: CONTEXTUAL_QA_SOURCE_SYSTEM,
    contextualQaRequestFeatures: features, ...SOURCE_CONSTRUCTION_READ_BUDGET, requireComplete: true });
  if (headers.length > SOURCE_CONSTRUCTION_READ_BUDGET.limit) return undefined;
  if (canonicalJsonByteLength(headers.map(row => row.patternJson), SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) > SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) return undefined;
  const matching = headers.filter(pattern => {
    const metadata = jsonRecord(pattern.patternJson);
    return metadata.componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE && Array.isArray(metadata.contextualQaRequestForm)
      && contextualQaRequestMatches(metadata.contextualQaRequestForm as ContextualQaRequestForm, input.requestText);
  });
  if (!matching.length) return undefined;
  const ids = [...new Set(matching.map(pattern => pattern.id))];
  const patterns = await input.storage.languageMemory.listLanguagePatterns({ patternIds: ids,
    patternSchemas: [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA], sourceSystem: CONTEXTUAL_QA_SOURCE_SYSTEM, limit: ids.length,
    maxTotalJsonBytes: SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes, requireComplete: true });
  if (patterns.length !== ids.length || patterns.some(pattern => !ids.includes(pattern.id))) return undefined;
  if (canonicalJsonByteLength(patterns.map(row => row.patternJson), SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) > SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) return undefined;
  const evidenceIds = [...new Set(patterns.flatMap(pattern => pattern.evidenceIds))];
  const evidence = await input.storage.evidence.getEvidenceBatch(evidenceIds);
  const bundles = patterns.flatMap(pattern => {
    const bundle = verifyContextualQaConstruction({ pattern, evidence, hasher: input.hasher });
    return bundle ? [bundle] : [];
  });
  if (bundles.length !== patterns.length) return undefined;
  if (canonicalJsonByteLength(bundles, SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) > SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) return undefined;
  const value = freezeQaValue({ requestDigest: input.hasher.digestHex(input.requestText), bundles, patternIds: ids });
  constructionReceipts.set(value, { storage: input.storage, generation: input.generation }); return value;
}

/** Grammar is source-supervised; only this turn's current direct evidence can supply an asserted value. */
export async function contextualQaForRequest(input: {
  storage: ScceStorage; hasher: Hasher; requestText: string; evidence: readonly EvidenceSpan[]; generation?: number;
  constructions?: VerifiedContextualQaConstructions; sourceVersionAllowlist?: readonly string[];
  authorityContext?: object;
}): Promise<VerifiedContextualQaBinding | undefined> {
  const allowed = input.sourceVersionAllowlist ? new Set(input.sourceVersionAllowlist) : undefined;
  const direct = input.evidence.filter(span => directEvidence(span) && (!allowed || allowed.has(String(span.sourceVersionId))));
  if (!direct.length) return undefined;
  const constructions = input.constructions ?? await contextualQaConstructionsForRequest(input);
  if (!constructions) return undefined;
  const receipt = constructionReceipts.get(constructions);
  if (!receipt || receipt.storage !== input.storage || receipt.generation !== input.generation
    || constructions.requestDigest !== input.hasher.digestHex(input.requestText)) return undefined;
  const resolver = sourceConstructionRequestValueResolver({ bundles: constructions.bundles, graph: { nodes: [], hyperedges: [] } });
  const binding = resolver.resolve(input.requestText, direct);
  if (!binding || typeof binding === "string" || typeof binding.subject !== "string" || !binding.subject) return undefined;
  const value = freezeQaValue({ ...constructions, binding: { ...binding, subject: binding.subject, resolverId: resolver.id } });
  const ids = new Set(binding.evidenceIds);
  bindingReceipts.set(value, { storage: input.storage, generation: input.generation, authorityContext: input.authorityContext,
    sources: sourceReceipts(direct.filter(span => ids.has(String(span.id))), input.hasher) });
  return value;
}
