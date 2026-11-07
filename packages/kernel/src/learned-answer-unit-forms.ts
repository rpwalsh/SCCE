// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { corpusIdentitySurface } from "./corpus-identity.js";
import type { LanguageStructuralDelta } from "./language-state-delta.js";

interface LearnedFormWitness {
  patternId: string;
  profileId: string;
  ruleId: string;
  evidenceIds: readonly string[];
}
let generation = 0;
let signature = "";
let forms = new Map<string, Map<string, readonly LearnedFormWitness[]>>();

/** Install only source-supported morphology retained by the current language scope. */
export function primeLearnedAnswerUnitForms(input: { deltas: readonly LanguageStructuralDelta[]; profileIds: ReadonlySet<string> }): void {
  const owned = input.deltas.filter(delta => delta.kind === "morphology" && input.profileIds.has(delta.profileId)
    && delta.patternId && delta.grammatical.ruleId && delta.evidenceIds.length > 0
    && delta.surface.from && delta.surface.to && delta.support > 0);
  const next = JSON.stringify(owned.map(delta => [delta.id, delta.patternId, delta.profileId, delta.grammatical.ruleId,
    delta.surface.from, delta.surface.to, [...delta.evidenceIds].sort()]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  if (next === signature) return;
  signature = next;
  forms = new Map();
  for (const delta of owned) {
    const left = corpusIdentitySurface(delta.surface.from!);
    const right = corpusIdentitySurface(delta.surface.to!);
    if (!left || !right || left === right) continue;
    const witness = Object.freeze({ patternId: delta.patternId, profileId: delta.profileId, ruleId: delta.grammatical.ruleId!, evidenceIds: Object.freeze([...delta.evidenceIds].map(String)) });
    for (const [from, to] of [[left, right], [right, left]] as const) {
      let targets = forms.get(from);
      if (!targets) { targets = new Map(); forms.set(from, targets); }
      targets.set(to, Object.freeze([...(targets.get(to) ?? []), witness]));
    }
  }
  generation++;
}

export function learnedAnswerUnitFormsGeneration(): number { return generation; }

export function learnedAnswerUnitFormVerdict(left: string, right: string): {
  status: "same" | "unresolved";
  witnesses: readonly LearnedFormWitness[];
} {
  const from = corpusIdentitySurface(left);
  const to = corpusIdentitySurface(right);
  if (!from || !to) return { status: "unresolved", witnesses: [] };
  if (from === to) return { status: "same", witnesses: [] };
  const witnesses = forms.get(from)?.get(to) ?? [];
  return { status: witnesses.length ? "same" : "unresolved", witnesses };
}
