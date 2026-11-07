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
  from: string;
  to: string;
}
let generation = 0;
let signature = "";
let forms = new Map<string, Map<string, readonly LearnedFormWitness[]>>();
const REQUEST_FORM_SCOPE_KEY = "learned-answer-unit-forms.v1";

interface ScopedLearnedForms {
  signature: string;
  forms: Map<string, Map<string, readonly LearnedFormWitness[]>>;
  attestedForms: Map<string, Set<string>>;
  parallelRulePairs: Map<string, Map<string, readonly ParallelParadigmSupport[]>>;
}

export interface LearnedAnswerUnitSharedBaseWitness {
  base: string;
  profileId: string;
  left: LearnedFormWitness;
  right: LearnedFormWitness;
  basis: "attested-base" | "parallel-paradigm";
  corroborating?: { base: string; left: LearnedFormWitness; right: LearnedFormWitness };
}

interface ParallelParadigmSupport {
  base: string;
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
  parallelRulePairs = learned.parallelRulePairs;
  generation = allocateRequestLanguageFormGeneration();
}

let attestedForms = new Map<string, Set<string>>();
let parallelRulePairs = new Map<string, Map<string, readonly ParallelParadigmSupport[]>>();

function buildLearnedForms(owned: readonly LanguageStructuralDelta[]): {
  forms: Map<string, Map<string, readonly LearnedFormWitness[]>>;
  attestedForms: Map<string, Set<string>>;
  parallelRulePairs: Map<string, Map<string, readonly ParallelParadigmSupport[]>>;
} {
  const result = new Map<string, Map<string, readonly LearnedFormWitness[]>>();
  const observed = new Map<string, Set<string>>();
  const directedByProfile = new Map<string, Map<string, LearnedFormWitness[]>>();
  for (const delta of owned) {
    const left = corpusIdentitySurface(delta.surface.from!);
    const right = corpusIdentitySurface(delta.surface.to!);
    if (!left || !right || left === right) continue;
    let profileForms = observed.get(delta.profileId);
    if (!profileForms) { profileForms = new Set(); observed.set(delta.profileId, profileForms); }
    profileForms.add(right);
    const witness = Object.freeze({ patternId: delta.patternId, profileId: delta.profileId, ruleId: delta.grammatical.ruleId!, evidenceIds: Object.freeze([...delta.evidenceIds].map(String)), from: left, to: right });
    let profileEdges = directedByProfile.get(delta.profileId);
    if (!profileEdges) { profileEdges = new Map(); directedByProfile.set(delta.profileId, profileEdges); }
    const baseEdges = profileEdges.get(left) ?? [];
    baseEdges.push(witness);
    profileEdges.set(left, baseEdges);
    for (const [from, to] of [[left, right], [right, left]] as const) {
      let targets = result.get(from);
      if (!targets) { targets = new Map(); result.set(from, targets); }
      targets.set(to, Object.freeze([...(targets.get(to) ?? []), witness]));
    }
  }
  const parallelRulePairs = new Map<string, Map<string, readonly ParallelParadigmSupport[]>>();
  for (const [profileId, bases] of directedByProfile) {
    const byPair = new Map<string, ParallelParadigmSupport[]>();
    for (const [base, edges] of bases) {
      for (let leftIndex = 0; leftIndex < edges.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < edges.length; rightIndex++) {
          const left = edges[leftIndex]!;
          const right = edges[rightIndex]!;
          if (left.to === right.to || !observed.get(profileId)?.has(left.to) || !observed.get(profileId)?.has(right.to)) continue;
          const key = rulePairKey(left.ruleId, right.ruleId);
          const support = byPair.get(key) ?? [];
          support.push({ base, left, right });
          byPair.set(key, support);
        }
      }
    }
    parallelRulePairs.set(profileId, byPair);
  }
  return { forms: result, attestedForms: observed, parallelRulePairs };
}

function rulePairKey(left: string, right: string): string {
  return JSON.stringify([left, right].sort());
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
  const visibleParallel = scoped.active ? scoped.value?.parallelRulePairs : parallelRulePairs;
  if (!visibleForms || !visibleAttested || !visibleParallel) return [];
  const out: LearnedAnswerUnitSharedBaseWitness[] = [];
  const leftTargets = visibleForms.get(leftSurface);
  if (!leftTargets) return [];
  for (const [base, leftWitnesses] of leftTargets) {
    if (base === leftSurface || base === rightSurface) continue;
    const rightWitnesses = visibleForms.get(base)?.get(rightSurface) ?? [];
    if (!leftWitnesses.length || !rightWitnesses.length) continue;
    for (const leftWitness of leftWitnesses) {
      if (leftWitness.from !== base || leftWitness.to !== leftSurface) continue;
      for (const rightWitness of rightWitnesses) {
        if (rightWitness.profileId !== leftWitness.profileId || rightWitness.from !== base || rightWitness.to !== rightSurface) continue;
        if (visibleAttested.get(leftWitness.profileId)?.has(base)) {
          out.push({ base, profileId: leftWitness.profileId, left: leftWitness, right: rightWitness, basis: "attested-base" });
          continue;
        }
        const supports = visibleParallel.get(leftWitness.profileId)?.get(rulePairKey(leftWitness.ruleId, rightWitness.ruleId)) ?? [];
        const corroborating = supports.find(support => support.base !== base
          && ((support.left.ruleId === leftWitness.ruleId && support.right.ruleId === rightWitness.ruleId)
            || (support.left.ruleId === rightWitness.ruleId && support.right.ruleId === leftWitness.ruleId)));
        if (corroborating) out.push({ base, profileId: leftWitness.profileId, left: leftWitness, right: rightWitness,
          basis: "parallel-paradigm", corroborating: { base: corroborating.base, left: corroborating.left, right: corroborating.right } });
      }
    }
  }
  return out;
}
