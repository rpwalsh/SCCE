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
