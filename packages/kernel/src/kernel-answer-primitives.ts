// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";
import { corpusIdentityGeneration, corpusIdentitySignals, corpusIdentityUnits, corpusNamedRuns } from "./corpus-identity.js";
import { surfaceWords } from "./surface-linguistics.js";
import type { JsonValue } from "./types.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import type { InducedLanguageModel } from "./language-induction.js";




// Pure in its text, and called from inside per-span filters: one request's derivation ran once per candidate row.
const namedSubjectAnchorsByText = new Map<string, string[]>();
let memoizedGeneration = -1;

export function namedSubjectAnchors(text: string): string[] {
  // The answer is derived from the corpus signal, so it survives only as long as that signal does.
  if (memoizedGeneration !== corpusIdentityGeneration()) {
    namedSubjectAnchorsByText.clear();
    memoizedGeneration = corpusIdentityGeneration();
  }
  const memoized = namedSubjectAnchorsByText.get(text);
  if (memoized) return memoized;
  const derived = namedPriorSurfaceRuns(text)
    .map(normalizePriorKey)
    .filter(namedSourceAnchorSpecificEnough)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  if (namedSubjectAnchorsByText.size >= 512) namedSubjectAnchorsByText.clear();
  namedSubjectAnchorsByText.set(text, derived);
  return derived;
}



 function namedSourceAnchorSpecificEnough(anchor: string): boolean {
  const units = splitPriorUnits(anchor);
  if (units.length >= 2) return true;
  return units.some(unit => [...unit].length >= 3 && !genericQuestionSignal(unit));
}



/**
 * Source-neutral request units shared by graph retrieval and question-slot
 * selection. Punctuation does not identify a language-independent question
 * operator, so every observed unit remains available to downstream scoring.
 *
 * @internal Exported for focused routing-invariant tests; it is not re-exported
 * from the package entrypoint.
 */
export function requestContentPriorUnits(text: string): string[] {
  return splitPriorUnits(normalizePriorKey(text));
}



/** @internal See {@link requestContentPriorUnits}. */
export function requestContentSurface(text: string): string {
  const words = splitPriorSurfaceWords(text);
  return words.join(" ") || text;
}



const ALPHABETIC = /\p{Alphabetic}/u;

export function genericQuestionSignal(unit: string): boolean {
  if (!unit) return true;
  if (unit.length <= calibrated("units.generic_length_ceiling")) return true;
  let letters = 0;
  let repeated = 0;
  let previous = "";
  for (const char of unit) {
    // Alphabetic contains every cased code point, so only uncased scripts gain letters here.
    if (ALPHABETIC.test(char)) letters++;
    if (char === previous) repeated++;
    previous = char;
  }
  return letters <= 1 || repeated / Math.max(1, unit.length - 1) > calibrated("units.generic_repeated_character_ratio");
}



/**
 * What the request names when the corpus has not spoken: its content units, whole.
 *
 * This was a capitalization reader -- cased runs joined across short connectors, a sentence-initial capital shed,
 * a five-character bound on what counted as an opening word, and a length-based fallback for uncased input. It
 * decided that "What did he discover?" names the verb and that "Explain relativity." names the imperative, and
 * in Korean, Japanese, Chinese, Hebrew, Arabic or Devanagari it had no signal to read at all. corpus-identity.ts
 * answers the question from the corpus instead, in any script; this remains only for the moment before any
 * corpus signal exists, and it guesses in no language's favour.
 */
function namedPriorSurfaceRuns(text: string): string[] {
  return corpusNamedRuns(text);
}


 function splitPriorSurfaceWords(text: string): string[] {
  return surfaceWords(text);
}



/** Labels come from source identities or entity arguments observed in the active language memory. */
export function learnedEntitySurfacesFromLanguageMemory(state: Pick<LanguageMemoryRuntimeState, "importedPatterns" | "scope">): string[] {
  const ownedProfiles = new Set(state.scope.profileIds);
  const ownedSources = new Set(state.scope.sourceVersionIds);
  const surfaces = new Set<string>();
  for (const record of state.importedPatterns) {
    if (record.patternKind !== "semantic_role" || !ownedProfiles.has(record.profileId)) continue;
    const payload = entityRecord(record.patternJson);
    if (payload.schema !== "scce.induced_language_model.semantic_memory.v1" || payload.profileId !== record.profileId) continue;
    if (typeof payload.sourceVersionId === "string" && ownedSources.size && !ownedSources.has(payload.sourceVersionId)) {
      const parents = entityStringArray(payload.parentSourceVersionIds);
      if (typeof payload.profileBindingDigest !== "string" || !payload.profileBindingDigest
        || !parents.length || !parents.every(sourceVersionId => ownedSources.has(sourceVersionId))) continue;
    }
    const durableEvidence = new Set(record.evidenceIds.map(String));
    if (!durableEvidence.size) continue;
    const constructions = Array.isArray(payload.graphBoundConstructions) ? payload.graphBoundConstructions : [];
    const entityClassIds = new Set<string>();
    for (const item of constructions) {
      const construction = entityRecord(item);
      const evidenceIds = entityStringArray(construction.evidenceIds);
      if (!evidenceIds.some(id => durableEvidence.has(id))) continue;
      for (const slotValue of Array.isArray(construction.slots) ? construction.slots : []) {
        const slot = entityRecord(slotValue);
        if (slot.semanticRole !== "entity") continue;
        for (const filler of entityStringArray(slot.observedFillers)) addSurface(surfaces, filler);
        if (typeof slot.lexicalClassId === "string" && slot.lexicalClassId) entityClassIds.add(slot.lexicalClassId);
      }
    }
    if (!entityClassIds.size) continue;
    for (const classValue of Array.isArray(payload.lexicalClasses) ? payload.lexicalClasses : []) {
      const lexicalClass = entityRecord(classValue);
      if (typeof lexicalClass.id !== "string" || !entityClassIds.has(lexicalClass.id)) continue;
      for (const memberValue of Array.isArray(lexicalClass.members) ? lexicalClass.members : []) {
        const member = entityRecord(memberValue);
        if (typeof member.symbol === "string") addSurface(surfaces, member.symbol);
      }
    }
  }
  return [...surfaces].sort((left, right) => left.localeCompare(right));
}

export function observedEntitySurfacesFromInducedLanguageModel(
  model: Pick<InducedLanguageModel, "graphBoundConstructions" | "lexicalClasses">,
  ownedEvidenceIds: readonly string[]
): string[] {
  const ownedEvidence = new Set(ownedEvidenceIds);
  const surfaces = new Set<string>();
  const entityClassIds = new Set<string>();
  for (const construction of model.graphBoundConstructions) {
    if (!construction.evidenceIds.some(id => ownedEvidence.has(String(id)))) continue;
    for (const slot of construction.slots) {
      if (slot.semanticRole !== "entity") continue;
      for (const filler of slot.observedFillers) addSurface(surfaces, filler);
      if (slot.lexicalClassId) entityClassIds.add(slot.lexicalClassId);
    }
  }
  for (const lexicalClass of model.lexicalClasses) {
    if (!entityClassIds.has(lexicalClass.id)) continue;
    for (const member of lexicalClass.members) addSurface(surfaces, member.symbol);
  }
  return [...surfaces].sort((left, right) => left.localeCompare(right));
}

export function declaredEntitySurfacesFromMetadata(value: JsonValue): string[] {
  const metadata = entityRecord(value);
  const sourceIdentity = entityRecord(metadata.sourceIdentity);
  const surfaces = new Set<string>();
  for (const candidate of [metadata.title, metadata.identity, sourceIdentity.title, sourceIdentity.identity]) {
    if (typeof candidate === "string") addSurface(surfaces, candidate);
  }
  return [...surfaces].sort((left, right) => left.localeCompare(right));
}

export function surfaceEntityRuns(text: string, observedSurfaces?: readonly string[]): string[] {
  const surfaces = new Set<string>(observedSurfaces ?? corpusIdentitySignals()?.identities ?? []);
  const vocabulary = new Map<string, string[][]>();
  for (const surface of surfaces) {
    const units = corpusIdentityUnits(surface);
    if (!units.length) continue;
    const initial = units[0]!;
    const candidates = vocabulary.get(initial) ?? [];
    candidates.push(units);
    vocabulary.set(initial, candidates);
  }
  if (!vocabulary.size) return [];

  const wordSpans: Array<{ start: number; end: number; units: string[] }> = [];
  let cursor = 0;
  for (const word of surfaceWords(text)) {
    const start = text.indexOf(word, cursor);
    if (start < 0) continue;
    const end = start + word.length;
    const units = corpusIdentityUnits(word);
    if (units.length) wordSpans.push({ start, end, units });
    cursor = end;
  }
  const flattened = wordSpans.flatMap((word, wordIndex) => word.units.map(unit => ({ unit, wordIndex })));
  const matches: Array<{ start: number; end: number; surface: string }> = [];
  for (let start = 0; start < flattened.length; start++) {
    const choices = vocabulary.get(flattened[start]!.unit) ?? [];
    for (const candidate of choices) {
      if (candidate.some((unit, offset) => flattened[start + offset]?.unit !== unit)) continue;
      const firstWord = flattened[start]!.wordIndex;
      const lastWord = flattened[start + candidate.length - 1]!.wordIndex;
      const first = wordSpans[firstWord]!;
      const last = wordSpans[lastWord]!;
      matches.push({ start: first.start, end: last.end, surface: text.slice(first.start, last.end) });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end || left.surface.localeCompare(right.surface));
  const selected: typeof matches = [];
  for (const match of matches) {
    const previous = selected[selected.length - 1];
    if (previous && match.start < previous.end) continue;
    selected.push(match);
  }
  return uniqueKernelStrings(selected.map(match => match.surface));
}

function addSurface(surfaces: Set<string>, value: string): void {
  const surface = value.trim();
  if (surface && corpusIdentityUnits(surface).length) surfaces.add(surface);
}

function entityStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function entityRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}



export function boundedEditDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  // Banded Levenshtein (Ukkonen). A cell (i, j) with |i - j| > maxDistance
  // can never hold a value <= maxDistance, so only the diagonal band of
  // width 2*maxDistance+1 is computed: O(n * maxDistance) instead of the
  // full O(n * m) row this previously filled. Profiled at 8.7% of a turn's
  // CPU via requestUnitSimilarity, which calls this pairwise in a loop.
  //
  // Values are clamped at maxDistance+1. That preserves exactness for every
  // result <= maxDistance (costs along an optimal DP path are
  // non-decreasing, so a path to a small final value never crosses a
  // clamped cell) and collapses everything larger into the single
  // "too far" answer the callers already treat as a miss.
  const cap = maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => Math.min(index, cap));
  for (let i = 1; i <= left.length; i++) {
    const current: number[] = new Array(right.length + 1).fill(cap);
    const from = Math.max(1, i - maxDistance);
    const to = Math.min(right.length, i + maxDistance);
    if (from === 1) current[0] = Math.min(i, cap);
    // Column 0 is a live cell of the row (deleting all of `left` so far);
    // seeding rowMin from cap alone made a row whose band lies entirely
    // past `right`'s end look exhausted and return early -- caught by the
    // oracle test on ("b", "", 1), where the true distance is 1.
    let rowMin = from === 1 ? (current[0] ?? cap) : cap;
    for (let j = from; j <= to; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? cap) + 1,
        (current[j - 1] ?? cap) + 1,
        (previous[j - 1] ?? cap) + cost,
        cap
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return cap;
    previous = current;
  }
  return Math.min(previous[right.length] ?? cap, cap);
}



export function kernelClamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}



export function hasPriorAnchorSignal(value: string): boolean {
  return surfaceEntityRuns(value).length > 0;
}



export function stripOuterPriorSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isPriorSeparator(value[start] ?? "")) start++;
  while (end > start && isPriorSeparator(value[end - 1] ?? "")) end--;
  return value.slice(start, end).trim();
}



export function isPriorSeparator(char: string): boolean {
  return char === "\\" || char === "\"" || char === "'" || char === ":" || char === "," || char === "." || char === ";" || char === "?" || char === "!" || char === "{" || char === "}" || char === "[" || char === "]" || isPriorWhitespace(char);
}



export function collapsePriorWhitespace(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    out += char;
    pendingSpace = false;
  }
  return out.trim();
}



 function isPriorWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}



export function splitPriorUnits(value: string): string[] {
  const units: string[] = [];
  let current = "";
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      if (current) units.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) units.push(current);
  return units;
}



export function normalizePriorKey(value: string): string {
  return collapsePriorWhitespace(value.toLocaleLowerCase());
}



export function kernelString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}



export function kernelNumber(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}



export function kernelStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}



export function uniqueKernelStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}



export function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
