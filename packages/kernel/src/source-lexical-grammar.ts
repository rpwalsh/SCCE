// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord } from "./kernel-answer-primitives.js";
import { requestLanguageFormScopeValue, setRequestLanguageFormScopeValue } from "./request-language-form-scope.js";
import { lexicalLookupUnits, normalizedLexicalSurface, sourceOwnedLexicalPattern, type SourceLexicalPatternInput } from "./lexical-semantic-memory.js";

export const LEXICAL_GRAMMAR_SCHEMA = "scce.source_lexical_grammar.v1" as const;
export const LEXICAL_GRAMMAR_RECIPE = "kernel.source_ud_lexical_grammar.v1" as const;
export interface LexicalGrammarForm {
  surface: string;
  features: Record<string, string>;
  dependency: string;
  count: number;
}
export interface LexicalGrammar {
  lexiconId: string;
  language: string;
  lemma: string;
  partOfSpeech: string;
  forms: LexicalGrammarForm[];
  evidenceIds: readonly string[];
  patternId: string;
}
interface GrammarMemory { bySurface: Map<string, LexicalGrammar[]> }
const KEY = "source-lexical-grammar.v1";
let resident: GrammarMemory = { bySurface: new Map() };
let generation = 0;
const normalized = normalizedLexicalSurface;

export function primeSourceLexicalGrammar(patterns: readonly SourceLexicalPatternInput[]): number {
  const memory: GrammarMemory = { bySurface: new Map() };
  let count = 0;
  for (const input of patterns) {
    const pattern = sourceOwnedLexicalPattern(input);
    if (!pattern) continue;
    const record = jsonRecord(pattern.patternJson);
    if (record.schema !== LEXICAL_GRAMMAR_SCHEMA || record.componentRecipe !== LEXICAL_GRAMMAR_RECIPE
      || !pattern.evidenceIds.length || typeof record.lemma !== "string" || typeof record.partOfSpeech !== "string"
      || !record.lemma || !record.partOfSpeech || typeof record.lexiconId !== "string" || typeof record.language !== "string"
      || !Array.isArray(record.forms)) continue;
    const forms = record.forms.flatMap(value => {
      const form = jsonRecord(value), features = jsonRecord(form.features);
      return typeof form.surface === "string" && typeof form.dependency === "string" && typeof form.count === "number"
        && normalized(form.surface) && Number.isSafeInteger(form.count) && form.count > 0 && Object.values(features).every(value => typeof value === "string")
        ? [{ surface: form.surface, dependency: form.dependency, count: form.count, features: features as Record<string, string> }] : [];
    });
    if (!forms.length || forms.length !== record.forms.length) continue;
    count++;
    const grammar = { lexiconId: record.lexiconId, language: record.language,
      lemma: record.lemma, partOfSpeech: record.partOfSpeech, forms, evidenceIds: pattern.evidenceIds, patternId: pattern.id };
    for (const surface of new Set([record.lemma, ...forms.map(form => form.surface)].map(normalized))) {
      const rows = memory.bySurface.get(surface) ?? [];
      rows.push(grammar); memory.bySurface.set(surface, rows);
    }
  }
  if (!setRequestLanguageFormScopeValue(KEY, memory)) { resident = memory; generation++; }
  return count;
}

function currentMemory(): GrammarMemory {
  const scoped = requestLanguageFormScopeValue<GrammarMemory>(KEY);
  return scoped.active ? scoped.value ?? { bySurface: new Map() } : resident;
}

export function sourceLexicalGrammarForSurface(surface: string): readonly LexicalGrammar[] {
  return currentMemory().bySurface.get(normalized(surface)) ?? [];
}

export function sourceLexicalGrammarGeneration(): number { return requestLanguageFormScopeValue(KEY).generation ?? generation; }

export function sourceLexicalLemmaWitnesses(left: string, right: string): string[] {
  const target = normalized(right);
  return sourceLexicalGrammarForSurface(left).filter(row => normalized(row.lemma) === target
    || row.forms.some(form => normalized(form.surface) === target)).map(row => row.patternId);
}

/** UD's annotated third-person nominal subjects can refer to the carried discourse object. */
export function sourceObservedDiscourseReference(text: string): boolean {
  return lexicalLookupUnits(text).some(unit => sourceLexicalGrammarForSurface(unit).some(grammar =>
    grammar.partOfSpeech === "PRON" && grammar.forms.some(form => normalized(form.surface) === unit
      && form.features.Person === "3" && form.features.PronType === "Prs"
      && (form.dependency === "nsubj" || form.dependency === "nsubj:pass"))));
}
