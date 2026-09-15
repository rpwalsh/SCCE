// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * Reads one opaque source relation token. The token is structural evidence
 * only: the kernel does not assign it a natural-language meaning.
 *
 * A sign immediately before a JSON number belongs to that result, so `↦-4`
 * yields relation `↦` and result `-4`; a sign followed by another operator
 * symbol remains part of a multi-character relation such as `->`.
 */
export function readSymbolicProgramRelation(text: string, start: number): { surface: string; end: number } | undefined {
  let end = start;
  while (end < text.length && /[\p{S}=<>+\-*/%|&^~:]/u.test(text[end]!)) {
    const char = text[end]!;
    const next = text[end + 1] ?? "";
    if (end > start && (char === "-" || char === "+") && /^\d$/u.test(next)) break;
    end += 1;
  }
  return end > start ? { surface: text.slice(start, end), end } : undefined;
}
