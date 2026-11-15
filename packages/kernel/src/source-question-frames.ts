// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord } from "./kernel-answer-primitives.js";
import { requestLanguageFormScopeValue, setRequestLanguageFormScopeValue } from "./request-language-form-scope.js";
import { sourceOwnedLexicalPattern, type SourceLexicalPatternInput } from "./lexical-semantic-memory.js";

export const SOURCE_QUESTION_FRAME_SCHEMA = "scce.source_copular_question_frame.v1" as const;
export const SOURCE_QUESTION_FRAME_RECIPE = "kernel.ud_copular_question_frame.v1" as const;
interface QuestionFrame { prefix: string; suffix: string; patternId: string; evidenceIds: readonly string[] }
const KEY = "source-copular-question-frames.v1";
let resident: QuestionFrame[] = [];
const normalized = (text: string) => text.normalize("NFC").toLocaleLowerCase().replace(/\s+/gu, " ");

export function primeSourceQuestionFrames(patterns: readonly SourceLexicalPatternInput[]): number {
  const frames = patterns.flatMap(input => {
    const pattern = sourceOwnedLexicalPattern(input);
    if (!pattern) return [];
    const value = jsonRecord(pattern.patternJson);
    return value.schema === SOURCE_QUESTION_FRAME_SCHEMA && value.componentRecipe === SOURCE_QUESTION_FRAME_RECIPE
      && typeof value.prefix === "string" && typeof value.suffix === "string"
      && (value.prefix.trim() || value.suffix.trim()) && pattern.evidenceIds.length
      ? [{ prefix: normalized(value.prefix), suffix: normalized(value.suffix), patternId: pattern.id, evidenceIds: pattern.evidenceIds }] : [];
  });
  if (!setRequestLanguageFormScopeValue(KEY, frames)) resident = frames;
  return frames.length;
}

/** The complete request must fit an observed copular question; only its nominal argument is executable. */
export function sourceQuestionExpression(text: string): { expression: string; patternIds: string[]; evidenceIds: string[] } | undefined {
  const scoped = requestLanguageFormScopeValue<QuestionFrame[]>(KEY);
  const frames = scoped.active ? scoped.value ?? [] : resident;
  const surface = normalized(text).trim();
  const matches = frames.flatMap(frame => {
    if (!surface.startsWith(frame.prefix) || !surface.endsWith(frame.suffix)
      || surface.length <= frame.prefix.length + frame.suffix.length) return [];
    const expression = surface.slice(frame.prefix.length, frame.suffix ? -frame.suffix.length : undefined).trim();
    return expression ? [{ expression, frame }] : [];
  });
  const expressions = new Set(matches.map(match => match.expression));
  if (expressions.size !== 1) return undefined;
  return { expression: matches[0]!.expression, patternIds: [...new Set(matches.map(match => match.frame.patternId))],
    evidenceIds: [...new Set(matches.flatMap(match => match.frame.evidenceIds))] };
}
