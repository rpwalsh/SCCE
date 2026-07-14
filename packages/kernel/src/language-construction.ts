import { canonicalStringify } from "./primitives.js";
import type { Hasher } from "./types.js";

export type SurfaceRoleRealization = "spoken" | "null";

export interface AlignedSurfaceRoleSpan {
  roleId: string;
  occurrenceId?: string;
  start: number;
  end: number;
  surface: string;
  evidenceIds: readonly string[];
}

export interface AlignedNullRoleOccurrence {
  roleId: string;
  occurrenceId: string;
  evidenceIds: readonly string[];
}

export interface AlignedSurfaceExample {
  id: string;
  profileKey: string;
  surface: string;
  evidenceIds: readonly string[];
  roleSpans: readonly AlignedSurfaceRoleSpan[];
  nullRoleOccurrences?: readonly AlignedNullRoleOccurrence[];
}

export interface SurfaceRoleOccurrence {
  roleId: string;
  occurrenceId: string;
  realization: SurfaceRoleRealization;
}

export interface LearnedSurfaceOrigin {
  sourceExampleId: string;
  start: number;
  end: number;
  observedSurface: string;
  evidenceIds: readonly string[];
}

export interface UnverifiedSurfaceRecordProvenance {
  verification: "unverified";
  methodId: "surface.provenance.induction.v1" | "surface.provenance.caller.v1";
  sourceExampleIds: readonly string[];
  evidenceIds: readonly string[];
}

export interface SealedSurfaceRecordProvenance {
  verification: "sealed";
  methodId: string;
  sealId: string;
  digest: string;
  sourceExampleIds: readonly string[];
  evidenceIds: readonly string[];
}

export type SurfaceRecordProvenance =
  | UnverifiedSurfaceRecordProvenance
  | SealedSurfaceRecordProvenance;

export type SurfaceProvenanceRecordKind =
  | "construction"
  | "form_class"
  | "form_variant"
  | "meaning_variant"
  | "meaning_null";

export interface SurfaceProvenanceRecord {
  recordKind: SurfaceProvenanceRecordKind;
  recordId: string;
  provenance: SurfaceRecordProvenance;
}

export type SurfaceProvenanceVerifier = (record: SurfaceProvenanceRecord) => boolean;

export interface LearnedConstructionLiteral {
  kind: "literal";
  surface: string;
  origins: readonly LearnedSurfaceOrigin[];
  evidenceIds: readonly string[];
}

export interface LearnedConstructionSlot {
  kind: "slot";
  roleId: string;
  occurrenceId: string;
  formClassId: string;
  required: true;
  origins: readonly LearnedSurfaceOrigin[];
  evidenceIds: readonly string[];
}

export type LearnedConstructionPart = LearnedConstructionLiteral | LearnedConstructionSlot;

export interface LearnedConstruction {
  id: string;
  profileKey: string;
  roleSignature: readonly string[];
  roleOccurrences: readonly SurfaceRoleOccurrence[];
  sequence: readonly LearnedConstructionPart[];
  sourceExampleIds: readonly string[];
  patternEvidenceIds: readonly string[];
  provenance: SurfaceRecordProvenance;
  support: number;
}

export interface LearnedFormVariant {
  id: string;
  profileKey: string;
  surface: string;
  origins: readonly LearnedSurfaceOrigin[];
  evidenceIds: readonly string[];
  provenance: SurfaceRecordProvenance;
  support: number;
}

export interface LearnedFormClass {
  id: string;
  constructionId: string;
  profileKey: string;
  roleId: string;
  occurrenceId: string;
  variants: readonly LearnedFormVariant[];
  evidenceIds: readonly string[];
  provenance: SurfaceRecordProvenance;
  support: number;
}

export interface SurfaceMeaningSlotVariant {
  id: string;
  profileKey: string;
  surface: string;
  evidenceIds: readonly string[];
  support?: number;
  formClassId?: string;
  provenance?: SurfaceRecordProvenance;
}

export interface SurfaceMeaningSlot {
  roleId: string;
  occurrenceId?: string;
  realization?: SurfaceRoleRealization;
  variants: readonly SurfaceMeaningSlotVariant[];
  evidenceIds?: readonly string[];
  provenance?: SurfaceRecordProvenance;
}

export interface SurfaceIntentionalRepetition {
  id: string;
  occurrenceIds: readonly string[];
}

export interface SurfaceMeaningPlan {
  id: string;
  profileKey: string;
  roleSignature: readonly string[];
  slots: readonly SurfaceMeaningSlot[];
  intentionalRepetitions?: readonly SurfaceIntentionalRepetition[];
}

export interface LearnedRealizationTracePart {
  kind: "literal" | "slot";
  outputStart: number;
  outputEnd: number;
  surface: string;
  evidenceIds: readonly string[];
  sourceExampleIds: readonly string[];
  roleId?: string;
  occurrenceId?: string;
  formClassId?: string;
  variantId?: string;
}

export interface LearnedRealizationProvenance {
  verification: "unverified" | "sealed";
  records: readonly SurfaceProvenanceRecord[];
}

export interface LearnedRealization {
  id: string;
  planId: string;
  constructionId: string;
  profileKey: string;
  roleSignature: readonly string[];
  roleOccurrences: readonly SurfaceRoleOccurrence[];
  text: string;
  evidenceIds: readonly string[];
  trace: readonly LearnedRealizationTracePart[];
  provenance: LearnedRealizationProvenance;
  score: {
    constructionSupport: number;
    selectedVariantSupport: number;
    observedVariantSupport: number;
  };
}

export const LANGUAGE_CONSTRUCTION_REJECTION_IDS = {
  identity: "surface.construction.reject.identity",
  duplicateIdentity: "surface.construction.reject.duplicate_identity",
  normalization: "surface.construction.reject.normalization",
  evidence: "surface.construction.reject.evidence",
  provenance: "surface.construction.reject.provenance",
  roleSignature: "surface.construction.reject.role_signature",
  alignment: "surface.construction.reject.alignment",
  overlap: "surface.construction.reject.overlap",
  profile: "surface.construction.reject.profile",
  requiredSlot: "surface.construction.reject.required_slot",
  slotVariant: "surface.construction.reject.slot_variant",
  construction: "surface.construction.reject.construction",
  formClass: "surface.construction.reject.form_class",
  trace: "surface.construction.reject.trace",
  intentionalRepetition: "surface.construction.reject.intentional_repetition",
  duplicateFragment: "surface.construction.reject.duplicate_fragment"
} as const;

export type LanguageConstructionRejectionId =
  typeof LANGUAGE_CONSTRUCTION_REJECTION_IDS[keyof typeof LANGUAGE_CONSTRUCTION_REJECTION_IDS];

export interface LanguageConstructionIssue {
  code: LanguageConstructionRejectionId;
  sourceExampleId?: string;
  constructionId?: string;
  roleId?: string;
  occurrenceId?: string;
  start?: number;
  end?: number;
  fingerprints?: readonly string[];
}

export interface LearnedConstructionInduction {
  constructions: readonly LearnedConstruction[];
  formClasses: readonly LearnedFormClass[];
  rejected: readonly LanguageConstructionIssue[];
}

export interface LearnedRealizationRejection {
  code: LanguageConstructionRejectionId;
  planId: string;
  profileKey: string;
  constructionIds: readonly string[];
  issues: readonly LanguageConstructionIssue[];
}

export type LearnedSurfaceResult =
  | { status: "realized"; realization: LearnedRealization }
  | { status: "rejected"; rejection: LearnedRealizationRejection };

interface PreparedLiteral {
  kind: "literal";
  surface: string;
  origin: LearnedSurfaceOrigin;
}

interface PreparedSlot {
  kind: "slot";
  roleId: string;
  occurrenceId: string;
  surface: string;
  origin: LearnedSurfaceOrigin;
}

type PreparedPart = PreparedLiteral | PreparedSlot;

interface PreparedExample {
  source: AlignedSurfaceExample;
  roleSignature: string[];
  roleOccurrences: SurfaceRoleOccurrence[];
  sequence: PreparedPart[];
  structuralKey: string;
}

interface PreparedMeaningSlot {
  source: SurfaceMeaningSlot;
  roleId: string;
  occurrenceId: string;
  realization: SurfaceRoleRealization;
}

interface PreparedMeaningPlan {
  roleSignature: string[];
  roleOccurrences: SurfaceRoleOccurrence[];
  slots: PreparedMeaningSlot[];
  intentionalRepetitions: SurfaceIntentionalRepetition[];
}

interface CandidateRealization {
  construction: LearnedConstruction;
  text: string;
  trace: LearnedRealizationTracePart[];
  evidenceIds: string[];
  provenanceRecords: SurfaceProvenanceRecord[];
  selectedVariantSupport: number;
  observedVariantSupport: number;
  variantIds: string[];
}

interface ResolvedSpan extends AlignedSurfaceRoleSpan {
  occurrenceId: string;
  occurrenceExplicit: boolean;
}

interface DuplicateUnit {
  category: "fragment" | "slot";
  key: string;
  occurrenceIds: string[];
}

export function induceLearnedConstructions(input: {
  examples: readonly AlignedSurfaceExample[];
  hasher: Hasher;
}): LearnedConstructionInduction {
  const prepared: PreparedExample[] = [];
  const rejected: LanguageConstructionIssue[] = [];
  const identityCounts = new Map<string, number>();
  for (const example of input.examples) {
    identityCounts.set(example.id, (identityCounts.get(example.id) ?? 0) + 1);
  }
  const duplicateIds = new Set(
    [...identityCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
  );
  for (const id of [...duplicateIds].sort(compareText)) {
    rejected.push({ code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateIdentity, sourceExampleId: id });
  }

  for (const example of [...input.examples].sort((left, right) => compareText(left.id, right.id))) {
    if (duplicateIds.has(example.id)) continue;
    const result = prepareExample(example);
    if ("issue" in result) rejected.push(result.issue);
    else prepared.push(result.prepared);
  }

  const groups = new Map<string, PreparedExample[]>();
  for (const example of prepared) {
    const group = groups.get(example.structuralKey) ?? [];
    group.push(example);
    groups.set(example.structuralKey, group);
  }

  const constructions: LearnedConstruction[] = [];
  const formClasses: LearnedFormClass[] = [];
  for (const [structuralKey, unsortedGroup] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
    const group = [...unsortedGroup].sort((left, right) => compareText(left.source.id, right.source.id));
    const exemplar = group[0];
    if (!exemplar) continue;
    const constructionId = stableId(input.hasher, "surface.construction", structuralKey);
    const sequence: LearnedConstructionPart[] = [];

    for (let index = 0; index < exemplar.sequence.length; index += 1) {
      const exemplarPart = exemplar.sequence[index];
      if (!exemplarPart) continue;
      const corresponding = group.map(item => item.sequence[index]).filter((part): part is PreparedPart => part !== undefined);
      if (exemplarPart.kind === "literal") {
        const literalParts = corresponding.filter((part): part is PreparedLiteral => part.kind === "literal");
        const origins = sortOrigins(literalParts.map(part => part.origin));
        sequence.push({
          kind: "literal",
          surface: exemplarPart.surface,
          origins,
          evidenceIds: uniqueSorted(origins.flatMap(item => item.evidenceIds))
        });
        continue;
      }

      const slotParts = corresponding.filter((part): part is PreparedSlot => part.kind === "slot");
      const formClassId = stableId(input.hasher, "surface.form", [constructionId, exemplarPart.occurrenceId]);
      const origins = sortOrigins(slotParts.map(part => part.origin));
      sequence.push({
        kind: "slot",
        roleId: exemplarPart.roleId,
        occurrenceId: exemplarPart.occurrenceId,
        formClassId,
        required: true,
        origins,
        evidenceIds: uniqueSorted(origins.flatMap(item => item.evidenceIds))
      });

      const variantGroups = new Map<string, PreparedSlot[]>();
      for (const part of slotParts) {
        const variants = variantGroups.get(part.surface) ?? [];
        variants.push(part);
        variantGroups.set(part.surface, variants);
      }
      const variants: LearnedFormVariant[] = [...variantGroups.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([surface, parts]) => {
          const variantOrigins = sortOrigins(parts.map(part => part.origin));
          const sourceExampleIds = uniqueSorted(variantOrigins.map(item => item.sourceExampleId));
          const evidenceIds = uniqueSorted(variantOrigins.flatMap(item => item.evidenceIds));
          const id = stableId(input.hasher, "surface.form.variant", [formClassId, surface]);
          return {
            id,
            profileKey: exemplar.source.profileKey,
            surface,
            origins: variantOrigins,
            evidenceIds,
            provenance: inducedProvenance(sourceExampleIds, evidenceIds),
            support: normalizedSupport(sourceExampleIds.length)
          };
        });
      const formEvidenceIds = uniqueSorted(variants.flatMap(variant => variant.evidenceIds));
      const formSourceExampleIds = uniqueSorted(origins.map(item => item.sourceExampleId));
      formClasses.push({
        id: formClassId,
        constructionId,
        profileKey: exemplar.source.profileKey,
        roleId: exemplarPart.roleId,
        occurrenceId: exemplarPart.occurrenceId,
        variants,
        evidenceIds: formEvidenceIds,
        provenance: inducedProvenance(formSourceExampleIds, formEvidenceIds),
        support: normalizedSupport(formSourceExampleIds.length)
      });
    }

    const sourceExampleIds = uniqueSorted(group.map(item => item.source.id));
    const patternEvidenceIds = uniqueSorted(group.flatMap(item => [
      ...item.source.evidenceIds,
      ...item.source.roleSpans.flatMap(span => span.evidenceIds),
      ...(item.source.nullRoleOccurrences ?? []).flatMap(role => role.evidenceIds)
    ]));
    constructions.push({
      id: constructionId,
      profileKey: exemplar.source.profileKey,
      roleSignature: exemplar.roleSignature,
      roleOccurrences: exemplar.roleOccurrences,
      sequence,
      sourceExampleIds,
      patternEvidenceIds,
      provenance: inducedProvenance(sourceExampleIds, patternEvidenceIds),
      support: normalizedSupport(sourceExampleIds.length)
    });
  }

  return {
    constructions: constructions.sort(compareConstructions),
    formClasses: formClasses.sort((left, right) => compareText(left.id, right.id)),
    rejected: rejected.sort(compareIssues)
  };
}

export function realizeLearnedSurface(input: {
  plan: SurfaceMeaningPlan;
  constructions: readonly LearnedConstruction[];
  formClasses: readonly LearnedFormClass[];
  hasher: Hasher;
  verifySealedProvenance?: SurfaceProvenanceVerifier;
}): LearnedSurfaceResult {
  const planResult = prepareMeaningPlan(input.plan);
  if ("issue" in planResult) return rejectedResult(input.plan, planResult.issue, []);
  const preparedPlan = planResult.prepared;

  const matchingSignature = input.constructions.filter(construction => (
    sameStrings(canonicalRoleSignature(construction.roleSignature), preparedPlan.roleSignature)
    && sameRoleOccurrences(canonicalRoleOccurrences(construction.roleOccurrences), preparedPlan.roleOccurrences)
  ));
  const profileLocal = matchingSignature
    .filter(construction => construction.profileKey === input.plan.profileKey)
    .sort(compareConstructions);
  if (profileLocal.length === 0) {
    const code = matchingSignature.length > 0
      ? LANGUAGE_CONSTRUCTION_REJECTION_IDS.profile
      : LANGUAGE_CONSTRUCTION_REJECTION_IDS.construction;
    return rejectedResult(input.plan, { code }, matchingSignature.map(construction => construction.id));
  }

  const slots = new Map(preparedPlan.slots.map(slot => [slot.occurrenceId, slot]));
  const duplicateFormClassId = firstDuplicate(input.formClasses.map(formClass => formClass.id));
  if (duplicateFormClassId) {
    return rejectedResult(input.plan, {
      code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateIdentity,
      constructionId: duplicateFormClassId
    }, profileLocal.map(construction => construction.id));
  }
  const formClasses = new Map(input.formClasses.map(formClass => [formClass.id, formClass]));
  const candidates: CandidateRealization[] = [];
  const issues: LanguageConstructionIssue[] = [];

  for (const construction of profileLocal) {
    const candidate = instantiateConstruction({
      plan: input.plan,
      preparedPlan,
      construction,
      slots,
      formClasses,
      hasher: input.hasher,
      verifySealedProvenance: input.verifySealedProvenance
    });
    if ("issue" in candidate) {
      issues.push(candidate.issue);
      continue;
    }
    const duplicateFingerprints = duplicateFragmentFingerprints({
      text: candidate.candidate.text,
      trace: candidate.candidate.trace,
      intentionalRepetitions: preparedPlan.intentionalRepetitions,
      hasher: input.hasher
    });
    if (duplicateFingerprints.length > 0) {
      issues.push({
        code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateFragment,
        constructionId: construction.id,
        fingerprints: duplicateFingerprints
      });
      continue;
    }
    candidates.push(candidate.candidate);
  }

  candidates.sort(compareCandidateRealizations);
  const selected = candidates[0];
  if (!selected) {
    const orderedIssues = issues.sort(compareIssues);
    return {
      status: "rejected",
      rejection: {
        code: orderedIssues[0]?.code ?? LANGUAGE_CONSTRUCTION_REJECTION_IDS.construction,
        planId: input.plan.id,
        profileKey: input.plan.profileKey,
        constructionIds: profileLocal.map(construction => construction.id),
        issues: orderedIssues
      }
    };
  }

  const variantKey = canonicalStringify(selected.variantIds);
  const provenanceRecords = uniqueProvenanceRecords(selected.provenanceRecords);
  return {
    status: "realized",
    realization: {
      id: stableId(input.hasher, "surface.realization", [
        input.plan.id,
        selected.construction.id,
        preparedPlan.roleOccurrences,
        variantKey,
        selected.text
      ]),
      planId: input.plan.id,
      constructionId: selected.construction.id,
      profileKey: input.plan.profileKey,
      roleSignature: preparedPlan.roleSignature,
      roleOccurrences: preparedPlan.roleOccurrences,
      text: selected.text,
      evidenceIds: selected.evidenceIds,
      trace: selected.trace,
      provenance: {
        verification: provenanceRecords.every(record => record.provenance.verification === "sealed")
          ? "sealed"
          : "unverified",
        records: provenanceRecords
      },
      score: {
        constructionSupport: selected.construction.support,
        selectedVariantSupport: selected.selectedVariantSupport,
        observedVariantSupport: selected.observedVariantSupport
      }
    }
  };
}

function prepareExample(example: AlignedSurfaceExample):
  | { prepared: PreparedExample }
  | { issue: LanguageConstructionIssue } {
  if (!nonempty(example.id) || !nonempty(example.profileKey) || example.surface.length === 0) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.identity, sourceExampleId: example.id } };
  }
  if (example.surface !== example.surface.normalize("NFC")) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.normalization, sourceExampleId: example.id } };
  }
  if (!hasEvidenceReferences(example.evidenceIds)) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.evidence, sourceExampleId: example.id } };
  }

  const nullRoles = [...(example.nullRoleOccurrences ?? [])];
  if (example.roleSpans.length + nullRoles.length === 0) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.roleSignature, sourceExampleId: example.id } };
  }
  const roleCounts = new Map<string, number>();
  for (const role of [...example.roleSpans, ...nullRoles]) {
    roleCounts.set(role.roleId, (roleCounts.get(role.roleId) ?? 0) + 1);
  }
  const spans: ResolvedSpan[] = example.roleSpans.map(span => ({
    ...span,
    occurrenceId: span.occurrenceId ?? span.roleId,
    occurrenceExplicit: span.occurrenceId !== undefined
  }));
  for (const span of spans) {
    if (!nonempty(span.roleId)
      || !nonempty(span.occurrenceId)
      || ((roleCounts.get(span.roleId) ?? 0) > 1 && !span.occurrenceExplicit)) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.roleSignature,
          sourceExampleId: example.id,
          roleId: span.roleId,
          occurrenceId: span.occurrenceId
        }
      };
    }
  }
  for (const role of nullRoles) {
    if (!nonempty(role.roleId) || !nonempty(role.occurrenceId) || !hasEvidenceReferences(role.evidenceIds)) {
      return {
        issue: {
          code: !hasEvidenceReferences(role.evidenceIds)
            ? LANGUAGE_CONSTRUCTION_REJECTION_IDS.evidence
            : LANGUAGE_CONSTRUCTION_REJECTION_IDS.roleSignature,
          sourceExampleId: example.id,
          roleId: role.roleId,
          occurrenceId: role.occurrenceId
        }
      };
    }
  }

  const occurrenceIds = [...spans.map(span => span.occurrenceId), ...nullRoles.map(role => role.occurrenceId)];
  if (new Set(occurrenceIds).size !== occurrenceIds.length) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.roleSignature, sourceExampleId: example.id } };
  }

  const boundaries = graphemeBoundaries(example.surface);
  spans.sort((left, right) => (
    left.start - right.start
    || left.end - right.end
    || compareText(left.occurrenceId, right.occurrenceId)
  ));
  let previousEnd = 0;
  for (const span of spans) {
    if (!Number.isInteger(span.start)
      || !Number.isInteger(span.end)
      || span.start < 0
      || span.end <= span.start
      || span.end > example.surface.length
      || !boundaries.has(span.start)
      || !boundaries.has(span.end)
      || example.surface.slice(span.start, span.end) !== span.surface) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.alignment,
          sourceExampleId: example.id,
          roleId: span.roleId,
          occurrenceId: span.occurrenceId,
          start: span.start,
          end: span.end
        }
      };
    }
    if (span.surface !== span.surface.normalize("NFC")) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.normalization,
          sourceExampleId: example.id,
          roleId: span.roleId,
          occurrenceId: span.occurrenceId,
          start: span.start,
          end: span.end
        }
      };
    }
    if (!hasEvidenceReferences(span.evidenceIds)) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.evidence,
          sourceExampleId: example.id,
          roleId: span.roleId,
          occurrenceId: span.occurrenceId,
          start: span.start,
          end: span.end
        }
      };
    }
    if (span.start < previousEnd) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.overlap,
          sourceExampleId: example.id,
          roleId: span.roleId,
          occurrenceId: span.occurrenceId,
          start: span.start,
          end: span.end
        }
      };
    }
    previousEnd = span.end;
  }

  const sequence: PreparedPart[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      const surface = example.surface.slice(cursor, span.start);
      sequence.push({
        kind: "literal",
        surface,
        origin: origin(example.id, cursor, span.start, surface, example.evidenceIds)
      });
    }
    sequence.push({
      kind: "slot",
      roleId: span.roleId,
      occurrenceId: span.occurrenceId,
      surface: span.surface,
      origin: origin(example.id, span.start, span.end, span.surface, span.evidenceIds)
    });
    cursor = span.end;
  }
  if (cursor < example.surface.length) {
    const surface = example.surface.slice(cursor);
    sequence.push({
      kind: "literal",
      surface,
      origin: origin(example.id, cursor, example.surface.length, surface, example.evidenceIds)
    });
  }

  const roleOccurrences = canonicalRoleOccurrences([
    ...spans.map(span => ({ roleId: span.roleId, occurrenceId: span.occurrenceId, realization: "spoken" as const })),
    ...nullRoles.map(role => ({ roleId: role.roleId, occurrenceId: role.occurrenceId, realization: "null" as const }))
  ]);
  const roleSignature = canonicalRoleSignature(roleOccurrences.map(item => item.roleId));
  const structuralKey = canonicalStringify([
    example.profileKey,
    roleSignature,
    roleOccurrences,
    sequence.map(part => part.kind === "literal"
      ? [part.kind, part.surface]
      : [part.kind, part.roleId, part.occurrenceId])
  ]);
  return { prepared: { source: example, roleSignature, roleOccurrences, sequence, structuralKey } };
}

function prepareMeaningPlan(plan: SurfaceMeaningPlan):
  | { prepared: PreparedMeaningPlan }
  | { issue: LanguageConstructionIssue } {
  if (!nonempty(plan.id) || !nonempty(plan.profileKey)) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.identity } };
  }
  if (plan.roleSignature.length === 0
    || plan.roleSignature.some(roleId => !nonempty(roleId))
    || new Set(plan.roleSignature).size !== plan.roleSignature.length) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.roleSignature } };
  }

  const requiredRoles = new Set(plan.roleSignature);
  const roleCounts = new Map<string, number>();
  for (const slot of plan.slots) roleCounts.set(slot.roleId, (roleCounts.get(slot.roleId) ?? 0) + 1);
  const slots: PreparedMeaningSlot[] = [];
  const occurrenceIds = new Set<string>();
  const observedRoles = new Set<string>();
  for (const slot of plan.slots) {
    const occurrenceId = slot.occurrenceId ?? slot.roleId;
    const realization = slot.realization ?? "spoken";
    if (!requiredRoles.has(slot.roleId)
      || !nonempty(occurrenceId)
      || occurrenceIds.has(occurrenceId)
      || ((roleCounts.get(slot.roleId) ?? 0) > 1 && slot.occurrenceId === undefined)) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.roleSignature,
          roleId: slot.roleId,
          occurrenceId
        }
      };
    }
    occurrenceIds.add(occurrenceId);
    observedRoles.add(slot.roleId);

    if (realization === "null") {
      if (slot.variants.length !== 0 || !hasEvidenceReferences(slot.evidenceIds ?? [])) {
        return {
          issue: {
            code: slot.variants.length !== 0
              ? LANGUAGE_CONSTRUCTION_REJECTION_IDS.slotVariant
              : LANGUAGE_CONSTRUCTION_REJECTION_IDS.evidence,
            roleId: slot.roleId,
            occurrenceId
          }
        };
      }
    } else {
      if (slot.variants.length === 0) {
        return {
          issue: {
            code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.requiredSlot,
            roleId: slot.roleId,
            occurrenceId
          }
        };
      }
      for (const variant of slot.variants) {
        if (!nonempty(variant.id) || variant.surface.length === 0) {
          return {
            issue: {
              code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.slotVariant,
              roleId: slot.roleId,
              occurrenceId
            }
          };
        }
        if (variant.profileKey !== plan.profileKey) {
          return {
            issue: {
              code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.profile,
              roleId: slot.roleId,
              occurrenceId
            }
          };
        }
        if (variant.surface !== variant.surface.normalize("NFC")) {
          return {
            issue: {
              code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.normalization,
              roleId: slot.roleId,
              occurrenceId
            }
          };
        }
        if (!hasEvidenceReferences(variant.evidenceIds)) {
          return {
            issue: {
              code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.trace,
              roleId: slot.roleId,
              occurrenceId
            }
          };
        }
        if (variant.support !== undefined && !isNormalizedSupport(variant.support)) {
          return {
            issue: {
              code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.slotVariant,
              roleId: slot.roleId,
              occurrenceId
            }
          };
        }
      }
    }
    slots.push({ source: slot, roleId: slot.roleId, occurrenceId, realization });
  }
  for (const roleId of plan.roleSignature) {
    if (!observedRoles.has(roleId)) return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.requiredSlot, roleId } };
  }

  const intentionalRepetitions = [...(plan.intentionalRepetitions ?? [])];
  const repetitionIds = new Set<string>();
  const repetitionKeys = new Set<string>();
  const spokenOccurrences = new Set(slots.filter(slot => slot.realization === "spoken").map(slot => slot.occurrenceId));
  for (const repetition of intentionalRepetitions) {
    const normalizedOccurrences = uniqueSorted(repetition.occurrenceIds);
    const repetitionKey = canonicalStringify(normalizedOccurrences);
    if (!nonempty(repetition.id)
      || repetitionIds.has(repetition.id)
      || normalizedOccurrences.length < 2
      || normalizedOccurrences.length !== repetition.occurrenceIds.length
      || normalizedOccurrences.some(occurrenceId => !spokenOccurrences.has(occurrenceId))
      || repetitionKeys.has(repetitionKey)) {
      return { issue: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.intentionalRepetition } };
    }
    repetitionIds.add(repetition.id);
    repetitionKeys.add(repetitionKey);
  }

  const roleOccurrences = canonicalRoleOccurrences(slots.map(slot => ({
    roleId: slot.roleId,
    occurrenceId: slot.occurrenceId,
    realization: slot.realization
  })));
  return {
    prepared: {
      roleSignature: canonicalRoleSignature(plan.roleSignature),
      roleOccurrences,
      slots,
      intentionalRepetitions: intentionalRepetitions.sort((left, right) => compareText(left.id, right.id))
    }
  };
}

function instantiateConstruction(input: {
  plan: SurfaceMeaningPlan;
  preparedPlan: PreparedMeaningPlan;
  construction: LearnedConstruction;
  slots: ReadonlyMap<string, PreparedMeaningSlot>;
  formClasses: ReadonlyMap<string, LearnedFormClass>;
  hasher: Hasher;
  verifySealedProvenance?: SurfaceProvenanceVerifier;
}): { candidate: CandidateRealization } | { issue: LanguageConstructionIssue } {
  if (!isNormalizedSupport(input.construction.support)
    || !hasEvidenceReferences(input.construction.patternEvidenceIds)
    || !validProvenanceRecord({
      recordKind: "construction",
      recordId: input.construction.id,
      provenance: input.construction.provenance
    }, input.construction.patternEvidenceIds, input.construction.sourceExampleIds, input.verifySealedProvenance)) {
    return {
      issue: {
        code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.provenance,
        constructionId: input.construction.id
      }
    };
  }

  let text = "";
  const selectedSupports: number[] = [];
  const observedSupports: number[] = [];
  const trace: LearnedRealizationTracePart[] = [];
  const variantIds: string[] = [];
  const provenanceRecords: SurfaceProvenanceRecord[] = [{
    recordKind: "construction",
    recordId: input.construction.id,
    provenance: input.construction.provenance
  }];

  for (const nullSlot of input.preparedPlan.slots.filter(slot => slot.realization === "null")) {
    const evidenceIds = uniqueSorted(nullSlot.source.evidenceIds ?? []);
    const record: SurfaceProvenanceRecord = {
      recordKind: "meaning_null",
      recordId: stableId(input.hasher, "surface.meaning.null", [input.plan.id, nullSlot.occurrenceId]),
      provenance: nullSlot.source.provenance ?? callerProvenance(evidenceIds)
    };
    if (!validProvenanceRecord(record, evidenceIds, [], input.verifySealedProvenance)) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.provenance,
          constructionId: input.construction.id,
          roleId: nullSlot.roleId,
          occurrenceId: nullSlot.occurrenceId
        }
      };
    }
    provenanceRecords.push(record);
  }

  for (const part of input.construction.sequence) {
    const outputStart = text.length;
    if (part.kind === "literal") {
      if (part.surface.length === 0
        || !traceableOrigins(part.origins, part.surface)
        || !hasEvidenceReferences(part.evidenceIds)) {
        return {
          issue: {
            code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.trace,
            constructionId: input.construction.id
          }
        };
      }
      text += part.surface;
      trace.push({
        kind: "literal",
        outputStart,
        outputEnd: text.length,
        surface: part.surface,
        evidenceIds: uniqueSorted(part.evidenceIds),
        sourceExampleIds: uniqueSorted(part.origins.map(item => item.sourceExampleId))
      });
      continue;
    }

    const slot = input.slots.get(part.occurrenceId);
    if (!slot || slot.realization !== "spoken" || slot.roleId !== part.roleId) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.requiredSlot,
          constructionId: input.construction.id,
          roleId: part.roleId,
          occurrenceId: part.occurrenceId
        }
      };
    }
    const formClass = input.formClasses.get(part.formClassId);
    const formRecord: SurfaceProvenanceRecord | undefined = formClass
      ? { recordKind: "form_class", recordId: formClass.id, provenance: formClass.provenance }
      : undefined;
    if (!formClass
      || formClass.constructionId !== input.construction.id
      || formClass.profileKey !== input.plan.profileKey
      || formClass.roleId !== part.roleId
      || formClass.occurrenceId !== part.occurrenceId
      || !isNormalizedSupport(formClass.support)
      || !hasEvidenceReferences(formClass.evidenceIds)
      || !formRecord
      || !validProvenanceRecord(
        formRecord,
        formClass.evidenceIds,
        uniqueSorted(formClass.variants.flatMap(variant => variant.origins.map(item => item.sourceExampleId))),
        input.verifySealedProvenance
      )) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.formClass,
          constructionId: input.construction.id,
          roleId: part.roleId,
          occurrenceId: part.occurrenceId
        }
      };
    }
    provenanceRecords.push(formRecord);

    const compatible: Array<{
      variant: SurfaceMeaningSlotVariant;
      variantRecord: SurfaceProvenanceRecord;
      observed?: LearnedFormVariant;
      observedRecord?: SurfaceProvenanceRecord;
    }> = [];
    for (const variant of slot.source.variants) {
      if (variant.formClassId !== undefined && variant.formClassId !== formClass.id) continue;
      const observedMatches = formClass.variants.filter(observed => observed.surface === variant.surface);
      if (observedMatches.length > 1) {
        return {
          issue: {
            code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateIdentity,
            constructionId: input.construction.id,
            roleId: part.roleId,
            occurrenceId: part.occurrenceId
          }
        };
      }
      const observed = observedMatches[0];
      const variantRecord: SurfaceProvenanceRecord = {
        recordKind: "meaning_variant",
        recordId: variant.id,
        provenance: variant.provenance ?? callerProvenance(variant.evidenceIds)
      };
      if (!validProvenanceRecord(variantRecord, variant.evidenceIds, [], input.verifySealedProvenance)) continue;
      let observedRecord: SurfaceProvenanceRecord | undefined;
      if (observed) {
        observedRecord = {
          recordKind: "form_variant",
          recordId: observed.id,
          provenance: observed.provenance
        };
        if (observed.profileKey !== input.plan.profileKey
          || observed.surface !== observed.surface.normalize("NFC")
          || !traceableOrigins(observed.origins, observed.surface)
          || !hasEvidenceReferences(observed.evidenceIds)
          || !isNormalizedSupport(observed.support)
          || !validProvenanceRecord(
            observedRecord,
            observed.evidenceIds,
            uniqueSorted(observed.origins.map(item => item.sourceExampleId)),
            input.verifySealedProvenance
          )) continue;
      }
      compatible.push({ variant, variantRecord, observed, observedRecord });
    }
    compatible.sort((left, right) => (
      (right.variant.support ?? 0) - (left.variant.support ?? 0)
      || (right.observed?.support ?? 0) - (left.observed?.support ?? 0)
      || compareText(left.variant.id, right.variant.id)
      || compareText(left.variant.surface, right.variant.surface)
    ));
    const selected = compatible[0];
    if (!selected) {
      return {
        issue: {
          code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.formClass,
          constructionId: input.construction.id,
          roleId: part.roleId,
          occurrenceId: part.occurrenceId
        }
      };
    }

    text += selected.variant.surface;
    selectedSupports.push(selected.variant.support ?? 0);
    observedSupports.push(selected.observed?.support ?? 0);
    variantIds.push(selected.variant.id);
    provenanceRecords.push(selected.variantRecord);
    if (selected.observedRecord) provenanceRecords.push(selected.observedRecord);
    trace.push({
      kind: "slot",
      outputStart,
      outputEnd: text.length,
      surface: selected.variant.surface,
      evidenceIds: uniqueSorted(selected.variant.evidenceIds),
      sourceExampleIds: uniqueSorted(selected.observed?.origins.map(item => item.sourceExampleId) ?? []),
      roleId: part.roleId,
      occurrenceId: part.occurrenceId,
      formClassId: formClass.id,
      variantId: selected.variant.id
    });
  }

  if (text.length === 0 || text !== text.normalize("NFC") || trace.some(part => part.outputEnd <= part.outputStart)) {
    return {
      issue: {
        code: text.length === 0
          ? LANGUAGE_CONSTRUCTION_REJECTION_IDS.construction
          : LANGUAGE_CONSTRUCTION_REJECTION_IDS.normalization,
        constructionId: input.construction.id
      }
    };
  }
  const evidenceIds = uniqueSorted(trace.flatMap(part => part.evidenceIds));
  if (!hasEvidenceReferences(evidenceIds) || !traceCoversText(text, trace)) {
    return {
      issue: {
        code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.trace,
        constructionId: input.construction.id
      }
    };
  }
  return {
    candidate: {
      construction: input.construction,
      text,
      trace,
      evidenceIds,
      provenanceRecords,
      selectedVariantSupport: meanSupport(selectedSupports),
      observedVariantSupport: meanSupport(observedSupports),
      variantIds
    }
  };
}

function rejectedResult(
  plan: SurfaceMeaningPlan,
  issue: LanguageConstructionIssue,
  constructionIds: readonly string[]
): LearnedSurfaceResult {
  return {
    status: "rejected",
    rejection: {
      code: issue.code,
      planId: plan.id,
      profileKey: plan.profileKey,
      constructionIds: uniqueSorted(constructionIds),
      issues: [issue]
    }
  };
}

function duplicateFragmentFingerprints(input: {
  text: string;
  trace: readonly LearnedRealizationTracePart[];
  intentionalRepetitions: readonly SurfaceIntentionalRepetition[];
  hasher: Hasher;
}): string[] {
  const allowed = new Set(input.intentionalRepetitions.map(item => (
    canonicalStringify(uniqueSorted(item.occurrenceIds))
  )));
  const units: DuplicateUnit[] = [];
  let fragmentStart = 0;
  let fragment = "";
  for (let index = 0; index < input.text.length;) {
    const codePoint = input.text.codePointAt(index);
    if (codePoint === undefined) break;
    const symbol = String.fromCodePoint(codePoint);
    const next = index + symbol.length;
    if (/\p{Sentence_Terminal}|\p{Terminal_Punctuation}|\r|\n/u.test(symbol)) {
      appendDuplicateUnit(units, fragment, fragmentStart, index, input.trace);
      fragment = "";
      fragmentStart = next;
    } else {
      fragment += symbol;
    }
    index = next;
  }
  appendDuplicateUnit(units, fragment, fragmentStart, input.text.length, input.trace);

  for (const part of input.trace) {
    if (part.kind !== "slot" || !part.occurrenceId) continue;
    const key = normalizeFragment(part.surface);
    if (key.length > 0) units.push({ category: "slot", key, occurrenceIds: [part.occurrenceId] });
  }

  const byKey = new Map<string, DuplicateUnit[]>();
  for (const unit of units) {
    const identity = canonicalStringify([unit.category, unit.key]);
    const group = byKey.get(identity) ?? [];
    group.push(unit);
    byKey.set(identity, group);
  }
  const fingerprints: string[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const occurrenceIds = uniqueSorted(group.flatMap(unit => unit.occurrenceIds));
    if (occurrenceIds.length >= 2 && allowed.has(canonicalStringify(occurrenceIds))) continue;
    const unit = group[0];
    if (unit) fingerprints.push(stableId(input.hasher, "surface.fragment", unit.key));
  }
  return uniqueSorted(fingerprints);
}

function appendDuplicateUnit(
  units: DuplicateUnit[],
  fragment: string,
  start: number,
  end: number,
  trace: readonly LearnedRealizationTracePart[]
): void {
  const key = normalizeFragment(fragment);
  if (key.length === 0) return;
  const occurrenceIds = uniqueSorted(trace
    .filter(part => part.kind === "slot"
      && part.occurrenceId !== undefined
      && part.outputStart < end
      && part.outputEnd > start)
    .flatMap(part => part.occurrenceId ? [part.occurrenceId] : []));
  units.push({ category: "fragment", key, occurrenceIds });
}

function normalizeFragment(fragment: string): string {
  return fragment
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\p{C}\s]/gu, "");
}

function traceableOrigins(origins: readonly LearnedSurfaceOrigin[], expected: string): boolean {
  return origins.length > 0 && origins.every(item => (
    nonempty(item.sourceExampleId)
    && Number.isInteger(item.start)
    && Number.isInteger(item.end)
    && item.start >= 0
    && item.end > item.start
    && item.observedSurface === expected
    && hasEvidenceReferences(item.evidenceIds)
  ));
}

function traceCoversText(text: string, trace: readonly LearnedRealizationTracePart[]): boolean {
  if (trace.length === 0) return false;
  const boundaries = graphemeBoundaries(text);
  let cursor = 0;
  for (const part of trace) {
    if (part.outputStart !== cursor
      || part.outputEnd <= part.outputStart
      || !boundaries.has(part.outputStart)
      || !boundaries.has(part.outputEnd)
      || text.slice(part.outputStart, part.outputEnd) !== part.surface
      || !hasEvidenceReferences(part.evidenceIds)) return false;
    cursor = part.outputEnd;
  }
  return cursor === text.length;
}

function graphemeBoundaries(surface: string): Set<number> {
  const boundaries = new Set<number>([0, surface.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const part of segmenter.segment(surface)) {
    boundaries.add(part.index);
    boundaries.add(part.index + part.segment.length);
  }
  return boundaries;
}

function origin(
  sourceExampleId: string,
  start: number,
  end: number,
  observedSurface: string,
  evidenceIds: readonly string[]
): LearnedSurfaceOrigin {
  return {
    sourceExampleId,
    start,
    end,
    observedSurface,
    evidenceIds: uniqueSorted(evidenceIds)
  };
}

function inducedProvenance(
  sourceExampleIds: readonly string[],
  evidenceIds: readonly string[]
): UnverifiedSurfaceRecordProvenance {
  return {
    verification: "unverified",
    methodId: "surface.provenance.induction.v1",
    sourceExampleIds: uniqueSorted(sourceExampleIds),
    evidenceIds: uniqueSorted(evidenceIds)
  };
}

function callerProvenance(evidenceIds: readonly string[]): UnverifiedSurfaceRecordProvenance {
  return {
    verification: "unverified",
    methodId: "surface.provenance.caller.v1",
    sourceExampleIds: [],
    evidenceIds: uniqueSorted(evidenceIds)
  };
}

function validProvenanceRecord(
  record: SurfaceProvenanceRecord,
  requiredEvidenceIds: readonly string[],
  requiredSourceExampleIds: readonly string[],
  verifier: SurfaceProvenanceVerifier | undefined
): boolean {
  const provenance = record.provenance;
  if (!nonempty(record.recordId)
    || !nonempty(provenance.methodId)
    || !hasEvidenceReferences(provenance.evidenceIds)
    || requiredEvidenceIds.some(id => !provenance.evidenceIds.includes(id))
    || requiredSourceExampleIds.some(id => !provenance.sourceExampleIds.includes(id))
    || provenance.sourceExampleIds.some(id => !nonempty(id))) return false;
  if (provenance.verification === "unverified") {
    return provenance.methodId === "surface.provenance.induction.v1"
      || provenance.methodId === "surface.provenance.caller.v1";
  }
  return nonempty(provenance.sealId)
    && nonempty(provenance.digest)
    && verifier !== undefined
    && verifier(record);
}

function uniqueProvenanceRecords(records: readonly SurfaceProvenanceRecord[]): SurfaceProvenanceRecord[] {
  const byIdentity = new Map<string, SurfaceProvenanceRecord>();
  for (const record of records) {
    byIdentity.set(canonicalStringify([record.recordKind, record.recordId]), record);
  }
  return [...byIdentity.values()].sort((left, right) => (
    compareText(left.recordKind, right.recordKind) || compareText(left.recordId, right.recordId)
  ));
}

function canonicalRoleSignature(roleIds: readonly string[]): string[] {
  return uniqueSorted(roleIds);
}

function canonicalRoleOccurrences(occurrences: readonly SurfaceRoleOccurrence[]): SurfaceRoleOccurrence[] {
  return [...occurrences]
    .map(item => ({ ...item }))
    .sort((left, right) => (
      compareText(left.occurrenceId, right.occurrenceId)
      || compareText(left.roleId, right.roleId)
      || compareText(left.realization, right.realization)
    ));
}

function sameRoleOccurrences(
  left: readonly SurfaceRoleOccurrence[],
  right: readonly SurfaceRoleOccurrence[]
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return other !== undefined
      && value.roleId === other.roleId
      && value.occurrenceId === other.occurrenceId
      && value.realization === other.realization;
  });
}

function stableId(hasher: Hasher, prefix: string, value: unknown): string {
  return `${prefix}.${hasher.digestHex(canonicalStringify([prefix, value])).slice(0, 32)}`;
}

function normalizedSupport(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count / (count + 1);
}

function meanSupport(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isNormalizedSupport(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sortOrigins(origins: readonly LearnedSurfaceOrigin[]): LearnedSurfaceOrigin[] {
  return [...origins].sort((left, right) => (
    compareText(left.sourceExampleId, right.sourceExampleId)
    || left.start - right.start
    || left.end - right.end
    || compareText(left.observedSurface, right.observedSurface)
  ));
}

function compareConstructions(left: LearnedConstruction, right: LearnedConstruction): number {
  return right.support - left.support || compareText(left.id, right.id);
}

function compareCandidateRealizations(left: CandidateRealization, right: CandidateRealization): number {
  return right.construction.support - left.construction.support
    || right.selectedVariantSupport - left.selectedVariantSupport
    || right.observedVariantSupport - left.observedVariantSupport
    || compareText(left.construction.id, right.construction.id)
    || compareText(canonicalStringify(left.variantIds), canonicalStringify(right.variantIds))
    || compareText(left.text, right.text);
}

function compareIssues(left: LanguageConstructionIssue, right: LanguageConstructionIssue): number {
  return compareText(left.code, right.code)
    || compareText(left.sourceExampleId ?? "", right.sourceExampleId ?? "")
    || compareText(left.constructionId ?? "", right.constructionId ?? "")
    || compareText(left.roleId ?? "", right.roleId ?? "")
    || compareText(left.occurrenceId ?? "", right.occurrenceId ?? "")
    || (left.start ?? -1) - (right.start ?? -1)
    || (left.end ?? -1) - (right.end ?? -1);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function hasEvidenceReferences(evidenceIds: readonly string[]): boolean {
  return evidenceIds.length > 0 && evidenceIds.every(nonempty);
}

function nonempty(value: string): boolean {
  return value.length > 0;
}
