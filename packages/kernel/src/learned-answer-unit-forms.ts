// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { corpusIdentitySurface } from "./corpus-identity.js";
import type { LanguageStructuralDelta } from "./language-state-delta.js";
import { allocateRequestLanguageFormGeneration, requestLanguageFormScopeValue, setRequestLanguageFormScopeValue } from "./request-language-form-scope.js";

export interface LearnedFormWitness {
  patternId: string;
  profileId: string;
  ruleId: string;
  evidenceIds: readonly string[];
}
let generation = 0;
let signature = "";
let forms = new Map<string, Map<string, readonly LearnedFormWitness[]>>();
const REQUEST_FORM_SCOPE_KEY = "learned-answer-unit-forms.v1";

interface ScopedLearnedForms {
  signature: string;
  forms: Map<string, Map<string, readonly LearnedFormWitness[]>>;
  attestedForms: Map<string, Set<string>>;
}

export interface LearnedAnswerUnitSharedBaseWitness {
  base: string;
  profileId: string;
  left: LearnedFormWitness;
  right: LearnedFormWitness;
}

/** Install only source-supported morphology retained by the current language scope. */
export function primeLearnedAnswerUnitForms(input: { deltas: readonly LanguageStructuralDelta[]; profileIds: ReadonlySet<string> }): void {
  const owned = input.deltas.filter(delta => delta.kind === "morphology" && input.profileIds.has(delta.profileId)
    && delta.patternId && delta.grammatical.ruleId && delta.evidenceIds.length > 0
    && delta.surface.from && delta.surface.to && delta.support > 0);
  const next = JSON.stringify(owned.map(delta => [delta.id, delta.patternId, delta.profileId, delta.grammatical.ruleId,
    delta.surface.from, delta.surface.to, [...delta.evidenceIds].sort()]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  const scoped = requestLanguageFormScopeValue<ScopedLearnedForms>(REQUEST_FORM_SCOPE_KEY);
  if (scoped.active) {
    if (scoped.value?.signature === next) return;
    const learned = buildLearnedForms(owned);
    setRequestLanguageFormScopeValue(REQUEST_FORM_SCOPE_KEY, { signature: next, ...learned });
    return;
  }
  if (next === signature) return;
  signature = next;
  const learned = buildLearnedForms(owned);
  forms = learned.forms;
  attestedForms = learned.attestedForms;
  generation = allocateRequestLanguageFormGeneration();
}

let attestedForms = new Map<string, Set<string>>();

function buildLearnedForms(owned: readonly LanguageStructuralDelta[]): {
  forms: Map<string, Map<string, readonly LearnedFormWitness[]>>;
  attestedForms: Map<string, Set<string>>;
} {
  const result = new Map<string, Map<string, readonly LearnedFormWitness[]>>();
  const observed = new Map<string, Set<string>>();
  for (const delta of owned) {
    const left = corpusIdentitySurface(delta.surface.from!);
    const right = corpusIdentitySurface(delta.surface.to!);
    if (!left || !right || left === right) continue;
    let profileForms = observed.get(delta.profileId);
    if (!profileForms) { profileForms = new Set(); observed.set(delta.profileId, profileForms); }
    profileForms.add(right);
    const witness = Object.freeze({ patternId: delta.patternId, profileId: delta.profileId, ruleId: delta.grammatical.ruleId!, evidenceIds: Object.freeze([...delta.evidenceIds].map(String)) });
    for (const [from, to] of [[left, right], [right, left]] as const) {
      let targets = result.get(from);
      if (!targets) { targets = new Map(); result.set(from, targets); }
      targets.set(to, Object.freeze([...(targets.get(to) ?? []), witness]));
    }
  }
  return { forms: result, attestedForms: observed };
}

export function learnedAnswerUnitFormsGeneration(): number { return requestLanguageFormScopeValue(REQUEST_FORM_SCOPE_KEY).generation ?? generation; }

export function learnedAnswerUnitFormVerdict(left: string, right: string): {
  status: "same" | "unresolved";
  witnesses: readonly LearnedFormWitness[];
} {
  const from = corpusIdentitySurface(left);
  const to = corpusIdentitySurface(right);
  if (!from || !to) return { status: "unresolved", witnesses: [] };
  if (from === to) return { status: "same", witnesses: [] };
  const scoped = requestLanguageFormScopeValue<ScopedLearnedForms>(REQUEST_FORM_SCOPE_KEY);
  const visibleForms = scoped.active ? scoped.value?.forms : forms;
  const witnesses = visibleForms?.get(from)?.get(to) ?? [];
  return { status: witnesses.length ? "same" : "unresolved", witnesses };
}

/** Returns exact observed morphology edges that share an independently source-attested base and profile. */
export function learnedAnswerUnitSharedBaseWitnesses(left: string, right: string): readonly LearnedAnswerUnitSharedBaseWitness[] {
  const leftSurface = corpusIdentitySurface(left);
  const rightSurface = corpusIdentitySurface(right);
  if (!leftSurface || !rightSurface || leftSurface === rightSurface) return [];
  const scoped = requestLanguageFormScopeValue<ScopedLearnedForms>(REQUEST_FORM_SCOPE_KEY);
  const visibleForms = scoped.active ? scoped.value?.forms : forms;
  const visibleAttested = scoped.active ? scoped.value?.attestedForms : attestedForms;
  if (!visibleForms || !visibleAttested) return [];
  const out: LearnedAnswerUnitSharedBaseWitness[] = [];
  for (const [base, targets] of visibleForms) {
    if (base === leftSurface || base === rightSurface) continue;
    const leftWitnesses = targets.get(leftSurface) ?? [];
    const rightWitnesses = targets.get(rightSurface) ?? [];
    if (!leftWitnesses.length || !rightWitnesses.length) continue;
    for (const leftWitness of leftWitnesses) {
      if (!visibleAttested.get(leftWitness.profileId)?.has(base)) continue;
      for (const rightWitness of rightWitnesses) {
        if (rightWitness.profileId === leftWitness.profileId) out.push({ base, profileId: leftWitness.profileId, left: leftWitness, right: rightWitness });
      }
    }
  }
  return out;
}
