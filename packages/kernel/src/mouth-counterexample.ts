// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { literalResidueIsCorpusInvariant } from "./conversational-act-binding.js";
import { realizeLearnedSurface, type LearnedConstruction, type LearnedRealization, type SurfaceMeaningPlan } from "./language-construction.js";
import { languageConstructionRoleId, languageConstructionOccurrenceId, type DurableLanguageConstructionBundle } from "./language-construction-memory.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import { evidenceProofBoundary } from "./proof-boundary.js";
import { surfaceContainsBoundValue } from "./surface-linguistics.js";
import type { EvidenceId, EvidenceSpan, Hasher, SemanticEntailmentResult } from "./types.js";

export const COUNTEREXAMPLE_ROLE_IDS = {
  supported: "counterexample.role.supported_value",
  denied: "counterexample.role.denied_value"
} as const;

export function counterexampleConstructionBindingId(kind: string): string {
  return `surface.counterexample.contrast.v1:${kind}`;
}

export interface LearnedCounterexampleSurface {
  id: string;
  text: string;
  counterexampleId: string;
  supportedValue: string;
  deniedValue: string;
  evidenceIds: EvidenceId[];
  importedPieceIds: string[];
  formLiterals: Array<{ id: string; text: string }>;
  support: number;
  realization: LearnedRealization;
  construction: LearnedConstruction;
  bundle: DurableLanguageConstructionBundle;
}

export function realizeCounterexampleSurfaces(input: {
  entailment: SemanticEntailmentResult;
  evidence: readonly EvidenceSpan[];
  bundles: readonly DurableLanguageConstructionBundle[];
  hasher: Hasher;
}): LearnedCounterexampleSurface[] {
  if (input.entailment.semanticVerdict !== "contradicted") return [];
  const results: LearnedCounterexampleSurface[] = [];
  for (const counterexample of input.entailment.counterexamples) {
    const matched = jsonRecord(jsonRecord(jsonRecord(counterexample.audit).metadata).matched);
    const supportedValue = typeof matched.value === "string" ? matched.value.trim() : "";
    const deniedValue = counterexample.claimText.trim();
    if (!supportedValue || !deniedValue || matched.kind !== counterexample.kind
      || supportedValue.normalize("NFC") === deniedValue.normalize("NFC")
      || !surfaceContainsBoundValue(input.entailment.claim.text, deniedValue)) continue;
    const owners = input.evidence.filter(span => counterexample.evidenceIds.includes(span.id)
      && counterexample.sourceVersionIds.includes(span.sourceVersionId)
      && span.status === "promoted" && evidenceProofBoundary(span).exactSourceSemantics
      && !["learned_language_prior", "learned_concept_prior", "learned_program_prior", "unknown_prior"].includes(evidenceProofBoundary(span).forceClass)
      && surfaceContainsBoundValue(span.text, supportedValue));
    if (!owners.length) continue;
    const bindingId = counterexampleConstructionBindingId(counterexample.kind);
    const roleIds = [COUNTEREXAMPLE_ROLE_IDS.supported, COUNTEREXAMPLE_ROLE_IDS.denied];
    for (const bundle of input.bundles.filter(bundle => bundle.bindingId === bindingId)) {
      if (!bundle.sourceExamples.length || !bundle.sourceExamples.every(example => example.roles.length === roleIds.length
        && roleIds.every((roleId, slotIndex) => example.roles.some(role => role.slotIndex === slotIndex
          && role.graphBinding?.relationId === bindingId && role.graphBinding.roleId === roleId
          && role.graphBinding.valueKind === counterexample.kind)))) continue;
      for (const construction of bundle.constructions) {
        if (construction.profileKey !== bundle.targetProfileId || construction.roleOccurrences.length !== roleIds.length
          || construction.roleOccurrences.some(occurrence => occurrence.realization !== "spoken")) continue;
        const formClasses = bundle.formClasses.filter(form => form.constructionId === construction.id);
        const values = [supportedValue, deniedValue];
        const slots: SurfaceMeaningPlan["slots"][number][] = [];
        for (const [slotIndex, value] of values.entries()) {
          const roleId = languageConstructionRoleId(input.hasher, bindingId, slotIndex);
          const occurrenceId = languageConstructionOccurrenceId(input.hasher, bindingId, slotIndex, 0);
          const formClass = formClasses.find(form => form.occurrenceId === occurrenceId);
          if (!formClass || !construction.roleOccurrences.some(occurrence => occurrence.roleId === roleId && occurrence.occurrenceId === occurrenceId)) break;
          slots.push({ roleId, occurrenceId, variants: [{ id: input.hasher.digestHex(`${counterexample.id}:${roleId}:${value}`),
            profileKey: construction.profileKey, surface: value, evidenceIds: owners.map(owner => String(owner.id)),
            support: counterexample.contradiction, formClassId: formClass.id }] });
        }
        if (slots.length !== roleIds.length) continue;
        const realized = realizeLearnedSurface({ plan: { id: `counterexample:${counterexample.id}:${construction.id}`,
          profileKey: construction.profileKey, roleSignature: slots.map(slot => slot.roleId), slots },
          constructions: [construction], formClasses, hasher: input.hasher });
        if (realized.status !== "realized") continue;
        const literals = construction.sequence.filter(part => part.kind === "literal");
        if (literalResidueIsCorpusInvariant({ literals, sourceExamples: bundle.sourceExamples }).status === "invalid") continue;
        results.push({ id: realized.realization.id, text: realized.realization.text, counterexampleId: counterexample.id,
          supportedValue, deniedValue, evidenceIds: owners.map(owner => owner.id), importedPieceIds: [bundle.id, construction.id],
          formLiterals: literals.map((literal, index) => ({ id: `${construction.id}:literal:${index}`, text: literal.surface })),
          support: construction.support, realization: realized.realization, construction, bundle });
      }
    }
  }
  return results;
}
