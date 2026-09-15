// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceId, JsonValue } from "./types.js";

/** A persisted, language-neutral change between two structural language states. */
export interface LanguageStructuralDelta {
  id: string;
  patternId: string;
  profileId: string;
  kind: "morphology" | "construction" | "interpretation";
  surface: {
    from?: string;
    to?: string;
  };
  grammatical: {
    fromRoleId?: string;
    toRoleId?: string;
    ruleId?: string;
    lexicalClassId?: string;
  };
  /** Optional typed context inside the profile/construction scope. */
  contextKey?: string;
  semantic: {
    fromRoleId?: string;
    toRoleId?: string;
  };
  support: number;
  evidenceIds: EvidenceId[];
}

/**
 * Read structural deltas from durable pattern records. The parser accepts
 * only typed fields supplied by the learner; it never infers an ontology or
 * a language-specific rule from English text.
 */
export function languageStructuralDeltasFromPatterns(
  patterns: readonly LanguagePatternRecord[]
): LanguageStructuralDelta[] {
  const out: LanguageStructuralDelta[] = [];
  for (const pattern of patterns) {
    const row = asRecord(pattern.patternJson);
    if (!row) continue;
    const raw = asRecord(row.structuralDelta);
    if (raw) {
      const parsed = explicitStructuralDelta(pattern, raw);
      if (parsed) out.push(parsed);
    }
    out.push(...inducedMorphologyDeltas(pattern, row));
  }
  const unique = new Map<string, LanguageStructuralDelta>();
  for (const delta of out) {
    const prior = unique.get(delta.id);
    if (!prior || delta.support > prior.support) unique.set(delta.id, delta);
  }
  return [...unique.values()].sort((left, right) => right.support - left.support || left.id.localeCompare(right.id));
}

function explicitStructuralDelta(
  pattern: LanguagePatternRecord,
  raw: Record<string, JsonValue>
): LanguageStructuralDelta | undefined {
  const surface = asRecord(raw.surface);
  const grammatical = asRecord(raw.grammatical ?? raw.grammar);
  const semantic = asRecord(raw.semantic ?? raw.semantics);
  const from = stringValue(surface?.from ?? surface?.before);
  const to = stringValue(surface?.to ?? surface?.after);
  const fromRoleId = stringValue(grammatical?.fromRoleId ?? grammatical?.from);
  const toRoleId = stringValue(grammatical?.toRoleId ?? grammatical?.to);
  const ruleId = stringValue(grammatical?.ruleId);
  const lexicalClassId = stringValue(grammatical?.lexicalClassId);
  const fromSemanticRoleId = stringValue(semantic?.fromRoleId ?? semantic?.from);
  const toSemanticRoleId = stringValue(semantic?.toRoleId ?? semantic?.to);
  const contextKey = stringValue(raw.contextKey);
  if (!from && !to && !fromRoleId && !toRoleId && !ruleId && !lexicalClassId && !fromSemanticRoleId && !toSemanticRoleId) return undefined;
  const kind = kindForPattern(pattern, raw);
  // Construction deltas require the typed construction scope that produced
  // them. A durable record with only a sentence pair is not a grammar rule;
  // accepting it here would turn sentence memorization into global language
  // behavior after a cold restart.
  if (kind === "construction" && !ruleId) return undefined;
  return {
    id: `${pattern.id}:structural-delta`,
    patternId: pattern.id,
    profileId: pattern.profileId,
    kind,
    surface: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
    grammatical: {
      ...(fromRoleId ? { fromRoleId } : {}),
      ...(toRoleId ? { toRoleId } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(lexicalClassId ? { lexicalClassId } : {})
    },
    ...(contextKey ? { contextKey } : {}),
    semantic: {
      ...(fromSemanticRoleId ? { fromRoleId: fromSemanticRoleId } : {}),
      ...(toSemanticRoleId ? { toRoleId: toSemanticRoleId } : {})
    },
    support: clamp01(pattern.support),
    evidenceIds: [...pattern.evidenceIds].slice(0, 128)
  };
}

/**
 * The production induction pipeline already persists morphology `rules` and
 * `classBindings` in `scce.induced_language_model.morphology_memory.v1`.
 * Project those real records into (surface, grammar) transitions during
 * hydration, rather than requiring a second writer or a fixture-only shape.
 */
function inducedMorphologyDeltas(
  pattern: LanguagePatternRecord,
  row: Record<string, JsonValue>
): LanguageStructuralDelta[] {
  if (row.schema !== "scce.induced_language_model.morphology_memory.v1" || !Array.isArray(row.rules)) return [];
  const bindings = Array.isArray(row.classBindings) ? row.classBindings.map(asRecord).filter((value): value is Record<string, JsonValue> => Boolean(value)) : [];
  const bestBindingByRule = new Map<string, { lexicalClassId?: string; confidence: number }>();
  for (const binding of bindings) {
    const ruleId = stringValue(binding.ruleId);
    if (!ruleId) continue;
    const candidate = {
      lexicalClassId: stringValue(binding.lexicalClassId),
      confidence: clamp01(numberValue(binding.confidence))
    };
    const prior = bestBindingByRule.get(ruleId);
    if (!prior || candidate.confidence > prior.confidence) bestBindingByRule.set(ruleId, candidate);
  }
  const deltas: LanguageStructuralDelta[] = [];
  for (const rawRule of row.rules) {
    const rule = asRecord(rawRule);
    const ruleId = stringValue(rule?.id);
    const ruleKind = stringValue(rule?.kind);
    const rulePattern = stringValue(rule?.pattern);
    const examples = stringArray(rule?.examples).slice(0, 16);
    if (!rule || !ruleId || !rulePattern || !isMorphologyKind(ruleKind)) continue;
    const binding = bestBindingByRule.get(ruleId);
    const productivity = clamp01(numberValue(rule.productivity));
    const support = clamp01(pattern.support * productivity * (binding ? Math.max(0.25, binding.confidence) : 1));
    for (const [index, derived] of examples.entries()) {
      const base = morphologyBaseSurface(ruleKind, rulePattern, derived);
      if (!base || normalizeSurface(base) === normalizeSurface(derived)) continue;
      deltas.push({
        id: `${pattern.id}:${ruleId}:${index}`,
        patternId: pattern.id,
        profileId: pattern.profileId,
        kind: "morphology",
        surface: { from: base, to: derived },
        grammatical: {
          ruleId,
          ...(binding?.lexicalClassId ? { lexicalClassId: binding.lexicalClassId } : {})
        },
        semantic: {},
        support,
        evidenceIds: [...pattern.evidenceIds].slice(0, 128)
      });
    }
  }
  return deltas;
}

/**
 * Score whether a candidate realizes a learned structural transition for a
 * request. Surface evidence is exact and boundary-aware; role IDs are
 * matched against typed candidate metadata when present by the caller.
 */
export function structuralDeltaRealizationFit(
  delta: LanguageStructuralDelta,
  requestText: string,
  candidateText: string,
  context: LanguageStructuralDeltaMatchContext = {}
): number {
  const request = normalizeSurface(requestText);
  const candidate = normalizeSurface(candidateText);
  // A round-trip correction is scoped to the exact typed construction and
  // profile that produced it. Surface equality alone is not authority: the
  // same target can be a valid realization for another construction.
  if (delta.kind === "construction" && delta.grammatical.ruleId) {
    const scopeMatches = context.constructionId === delta.grammatical.ruleId
      && context.profileId === delta.profileId
      && (!delta.contextKey || context.contextKey === delta.contextKey);
    if (!scopeMatches) return 0;
    // A complete sentence pair is an observed correction, not yet a general
    // construction law. Without an explicit typed context key, require the
    // same failed source surface to be active. This prevents one remembered
    // sentence from winning every later use of an otherwise shared grammar.
    const sourceMatches = Boolean(delta.surface.from
      && containsSurface(request, normalizeSurface(delta.surface.from)));
    if (!delta.contextKey && !sourceMatches) return 0;
    return delta.surface.to && containsSurface(candidate, normalizeSurface(delta.surface.to))
      ? delta.support
      : 0;
  }
  let signals = 0;
  let matched = 0;
  if (delta.surface.from) {
    signals++;
    if (containsSurface(request, normalizeSurface(delta.surface.from))) matched++;
  }
  if (delta.surface.to) {
    signals++;
    if (containsSurface(candidate, normalizeSurface(delta.surface.to))) matched++;
  }
  // A typed role transition without a surface is still durable evidence of a
  // change, but it cannot decide between untyped strings on its own. The
  // candidate API intentionally carries no invented role labels. A surfaced
  // transition is atomic: a candidate that only matches one endpoint has not
  // realized the learned change and must not receive half credit.
  if (signals > 1 && matched !== signals) return 0;
  return signals > 0 ? clamp01(matched / signals) * delta.support : 0;
}

export interface LanguageStructuralDeltaMatchContext {
  constructionId?: string;
  profileId?: string;
  contextKey?: string;
}

function kindForPattern(pattern: LanguagePatternRecord, delta: Record<string, JsonValue>): LanguageStructuralDelta["kind"] {
  const declared = stringValue(delta.kind);
  if (declared === "morphology" || declared === "construction" || declared === "interpretation") return declared;
  if (pattern.patternKind === "morphology") return "morphology";
  if (pattern.patternKind === "syntax" || pattern.patternKind === "cadence") return "construction";
  return "interpretation";
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isMorphologyKind(value: string | undefined): value is "prefix" | "suffix" | "infix" | "compound" | "reduplication" {
  return value === "prefix" || value === "suffix" || value === "infix" || value === "compound" || value === "reduplication";
}

function morphologyBaseSurface(
  kind: "prefix" | "suffix" | "infix" | "compound" | "reduplication",
  pattern: string,
  derived: string
): string | undefined {
  const units = pattern.split("+").filter(Boolean);
  if (kind === "prefix") {
    const affix = units[0];
    return affix && derived.startsWith(affix) ? derived.slice(affix.length) : undefined;
  }
  if (kind === "suffix") {
    const affix = units.at(-1);
    return affix && derived.endsWith(affix) ? derived.slice(0, -affix.length) : undefined;
  }
  if (kind === "infix") {
    const affix = units.find(unit => unit !== "STEM1" && unit !== "STEM2");
    if (!affix) return undefined;
    const index = derived.indexOf(affix, 1);
    return index > 0 && index < derived.length - affix.length
      ? derived.slice(0, index) + derived.slice(index + affix.length)
      : undefined;
  }
  if (kind === "compound") {
    const parts = units.filter(unit => !unit.startsWith("STEM"));
    return parts.length > 1 && parts.join("") === derived ? parts.join(" ") : undefined;
  }
  const graphemes = Array.from(derived);
  const midpoint = graphemes.length / 2;
  if (Number.isInteger(midpoint)) {
    const left = graphemes.slice(0, midpoint).join("");
    const right = graphemes.slice(midpoint).join("");
    if (left === right) return left;
  }
  return undefined;
}

function normalizeSurface(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function containsSurface(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack === needle || haystack.includes(` ${needle} `) || haystack.startsWith(`${needle} `) || haystack.endsWith(` ${needle}`);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
