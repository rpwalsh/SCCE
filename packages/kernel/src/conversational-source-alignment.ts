// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ConversationalSlotFiller } from "./conversational-act-binding.js";
import type { ConversationTurnSurface, LearnedConstruction } from "./language-construction.js";
import type { DurableLanguageConstructionBundle } from "./language-construction-memory.js";
import { unicodeLexicalSegments } from "./unicode-segmentation.js";

/** Align a live turn with the request frame that supplied a construction's observed reply role. */
export function sourceAlignedConversationalFillers(input: {
  bundle: DurableLanguageConstructionBundle;
  construction: LearnedConstruction;
  turn: ConversationTurnSurface;
}): { fillers: ConversationalSlotFiller[]; matchedContextUnits: number } | undefined {
  if (input.construction.roleOccurrences.length > 1) return jointlyAlignedConversationalFillers(input);
  const live = unicodeLexicalSegments(input.turn.surface);
  const origins = new Set(input.construction.sequence.flatMap(part => part.kind === "literal" ? part.origins.map(origin => origin.sourceExampleId) : []));
  const rows: Array<{ fillers: ConversationalSlotFiller[]; matchedContextUnits: number }> = [];
  for (const example of input.bundle.sourceExamples) {
    if (!origins.has(example.id) || !example.antecedent) continue;
    const request = unicodeLexicalSegments(example.antecedent.surface);
    const fillers: ConversationalSlotFiller[] = [];
    let matchedContextUnits = 0;
    for (const [slotIndex, occurrence] of input.construction.roleOccurrences.entries()) {
      const role = example.roles.find(item => item.roleId === occurrence.roleId && item.occurrenceId === occurrence.occurrenceId);
      if (!role) break;
      const observed = unicodeLexicalSegments(role.surface).map(unit => unit.normalized);
      for (let start = 0; start + observed.length <= request.length; start++) {
        if (!observed.length || !observed.every((word, index) => request[start + index]?.normalized === word)) continue;
        const suffix = request.length - start - observed.length;
        const liveEnd = live.length - suffix;
        if (liveEnd <= start) continue;
        if (!request.slice(0, start).every((unit, index) => live[index]?.normalized === unit.normalized)
          || !request.slice(start + observed.length).every((unit, index) => live[liveEnd + index]?.normalized === unit.normalized)) continue;
        // An unanchored identity can only reuse its exact observed request, never swallow an unrelated live turn.
        if (start + suffix === 0 && (live.length !== request.length || !request.every((unit, index) => live[index]?.normalized === unit.normalized))) continue;
        const startCodePoint = live[start]!.codePointStart;
        const endCodePoint = live[liveEnd - 1]!.codePointEnd;
        fillers.push({ slotIndex, sourceTurnId: input.turn.turnId, startCodePoint, endCodePoint,
          surface: [...input.turn.surface].slice(startCodePoint, endCodePoint).join("") });
        matchedContextUnits += start + suffix || request.length;
        break;
      }
      if (fillers.length !== slotIndex + 1) break;
    }
    if (fillers.length === input.construction.roleOccurrences.length && fillers.length) rows.push({ fillers, matchedContextUnits });
  }
  return rows.sort((left, right) => right.matchedContextUnits - left.matchedContextUnits
    || JSON.stringify(left.fillers).localeCompare(JSON.stringify(right.fillers)))[0];
}

/** Match all antecedent variables together; other variables are never treated as immutable context. */
function jointlyAlignedConversationalFillers(input: Parameters<typeof sourceAlignedConversationalFillers>[0]) {
  const origins = new Set(input.construction.sequence.flatMap(part => part.kind === "literal" ? part.origins.map(origin => origin.sourceExampleId) : []));
  const accepted = new Map<string, { fillers: ConversationalSlotFiller[]; matchedContextUnits: number }>();
  for (const example of input.bundle.sourceExamples) {
    if (!origins.has(example.id) || !example.antecedent) continue;
    const request = [...example.antecedent.surface];
    const owners = new Map<string, { start: number; end: number; roleId: string }>();
    let valid = true;
    for (const occurrence of input.construction.roleOccurrences) {
      const role = example.roles.find(row => row.roleId === occurrence.roleId && row.occurrenceId === occurrence.occurrenceId);
      if (!role) { valid = false; break; }
      const needle = [...role.surface], matches: number[] = [];
      for (let index = 0; needle.length && index + needle.length <= request.length; index++) {
        if (needle.every((point, offset) => request[index + offset] === point)) matches.push(index);
      }
      if (matches.length !== 1) { valid = false; break; }
      const owner = { start: matches[0]!, end: matches[0]! + needle.length, roleId: occurrence.roleId };
      const prior = owners.get(owner.roleId);
      if (prior && (prior.start !== owner.start || prior.end !== owner.end)) { valid = false; break; }
      owners.set(owner.roleId, owner);
    }
    if (!valid || !owners.size) continue;
    const ordered = [...owners.values()].sort((a, b) => a.start - b.start);
    if (ordered.some((owner, index) => index > 0 && owner.start <= ordered[index - 1]!.end)) continue;
    const literals = ordered.map((owner, index) => request.slice(index ? ordered[index - 1]!.end : 0, owner.start).join(""));
    literals.push(request.slice(ordered.at(-1)!.end).join(""));
    if (!literals.some(literal => unicodeLexicalSegments(literal).length)) continue;
    const live = input.turn.surface;
    const bindings = new Map<string, { start: number; end: number }>();
    const solutions: Array<Map<string, { start: number; end: number }>> = [];
    const impossible = new Set<string>();
    // Source anchors bound every search. A second distinct solution is proof of ambiguity, not a search budget.
    const walk = (index: number, offset: number): void => {
      const state = `${index}:${offset}`;
      if (solutions.length > 1 || impossible.has(state) || !live.startsWith(literals[index]!, offset)) return;
      const before = solutions.length;
      const start = offset + literals[index]!.length;
      if (index === ordered.length) { if (start === live.length) solutions.push(new Map(bindings)); return; }
      const next = literals[index + 1]!;
      if (!next && index + 1 < ordered.length) return;
      for (let end = next ? live.indexOf(next, start + 1) : live.length; end >= start + 1 && end <= live.length; end = next ? live.indexOf(next, end + 1) : -1) {
        // Source anchor punctuation stays literal; every code point inside the live variable keeps its turn owner.
        const surface = live.slice(start, end), segments = unicodeLexicalSegments(surface);
        if (!segments.length || !surface.trim()) continue;
        bindings.set(ordered[index]!.roleId, { start: [...live.slice(0, start)].length, end: [...live.slice(0, end)].length });
        walk(index + 1, end);
        bindings.delete(ordered[index]!.roleId);
        if (solutions.length > 1) return;
      }
      if (solutions.length === before) impossible.add(state);
    };
    walk(0, 0);
    if (solutions.length > 1) return undefined;
    if (!solutions.length) continue;
    const resolved = solutions[0]!;
    const fillers = input.construction.roleOccurrences.map((occurrence, slotIndex) => {
      const range = resolved.get(occurrence.roleId)!;
      return { slotIndex, sourceTurnId: input.turn.turnId, startCodePoint: range.start, endCodePoint: range.end,
        surface: [...live].slice(range.start, range.end).join("") };
    });
    const key = JSON.stringify(fillers);
    accepted.set(key, { fillers, matchedContextUnits: unicodeLexicalSegments(literals.join(" ")).length });
    if (accepted.size > 1) return undefined;
  }
  return accepted.values().next().value;
}
