// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { kneserNeyPerplexity, type KneserNeyModel } from "./kneser-ney.js";
import type { CorpusRegistryEntry, CorpusRoleId, CorpusSourceSystemId } from "./corpus-registry.js";
import type { TurnRequirementField } from "./turn-requirements.js";
import type { JsonValue } from "./types.js";

/** Same vocabulary as the invariants table: a selector that cannot measure must never report `active`. */
export type LanguagePopulationSelectionStatus =
  | "active"
  | "bypassed_not_applicable"
  | "inert_unconfigured"
  | "disabled_explicitly"
  | "failed";

export type LanguagePopulationReasonId =
  | "population.authority_prior"
  | "population.conversation_displaced.measured_support"
  | "population.conversation_displaced.no_resident_support"
  | "population.none_eligible";

export interface LanguagePopulationCandidate {
  sourceSystem: string;
  sourceSystemId: CorpusSourceSystemId;
  corpusRoleId: CorpusRoleId;
}

/** One population's measured ability to realize the turn's own language state. */
export interface LanguagePopulationSupport {
  corpusRoleId: CorpusRoleId;
  sourceSystem: string;
  /** Kneser-Ney perplexity of the scored sequence under this population's best resident model. */
  perplexity: number;
  modelIds: string[];
}

export interface LanguagePopulationSelectionInput {
  requirementField: TurnRequirementField;
  /** The role the resolved authority asks for. Stays the answer unless the turn is conversation-displaced. */
  authorityPriorRoleId?: CorpusRoleId;
  registry: readonly CorpusRegistryEntry[];
  support?: readonly LanguagePopulationSupport[];
}

export interface LanguagePopulationSelection {
  schema: "scce.language_population.selection.v1";
  selectedCorpusRoleId?: CorpusRoleId;
  selectedSourceSystem?: string;
  consideredRoleIds: CorpusRoleId[];
  consideredSourceSystems: string[];
  authorityPriorRoleId?: CorpusRoleId;
  conversationDisplaced: boolean;
  quantities: {
    dialogueDependence: number;
    sourceDependence: number;
    externalTruthAuthority: number;
    /** Sign decides. Two dimensions of the same field, compared against each other, not against a constant. */
    conversationDisplacement: number;
    supportByRole: Record<string, number>;
    supportMargin: number;
  };
  hydratedModelIds: string[];
  reasonId: LanguagePopulationReasonId;
  status: LanguagePopulationSelectionStatus;
}

/**
 * Which corpus population realizes this turn.
 *
 * Reads only quantities the turn has already computed. `dialogueDependence` is accumulated conversation
 * structure -- prior answer-graph ids and unresolved graph slots, counted, never token-matched -- and
 * `sourceDependence`/`externalTruthAuthority` are the same field's pull toward documents. Their comparison is
 * the displacement: no word list, no act table, no threshold constant.
 *
 * This chooses a REALIZER population. It never returns authority and must never be read as one: a displaced
 * turn is not thereby non-factual, and a dialogue population is never evidence.
 */
export function selectLanguagePopulation(input: LanguagePopulationSelectionInput): LanguagePopulationSelection {
  const field = input.requirementField;
  const dialogueDependence = finite(field.dialogueDependence);
  const sourceDependence = finite(field.sourceDependence);
  const externalTruthAuthority = finite(field.externalTruthAuthority);
  const conversationDisplacement = dialogueDependence - Math.max(sourceDependence, externalTruthAuthority);
  const eligible = input.registry.filter(entry => entry.enabled && entry.languageMemoryEligible);
  // A documentary population is the one the registry already lets into the evidence graph. Nothing new is declared.
  const displacedCandidates = eligible.filter(entry => !entry.graphEvidenceEligible);
  const considered: LanguagePopulationCandidate[] = (conversationDisplacement > 0 ? displacedCandidates : eligible)
    .map(entry => ({ sourceSystem: entry.sourceSystem, sourceSystemId: entry.sourceSystemId, corpusRoleId: entry.corpusRoleId }))
    .sort((left, right) => left.sourceSystem.localeCompare(right.sourceSystem));

  const supportByRole: Record<string, number> = {};
  for (const row of input.support ?? []) {
    const key = String(row.corpusRoleId);
    if (!Number.isFinite(row.perplexity)) continue;
    if (supportByRole[key] === undefined || row.perplexity < supportByRole[key]!) supportByRole[key] = row.perplexity;
  }

  const base = {
    schema: "scce.language_population.selection.v1",
    consideredRoleIds: considered.map(item => item.corpusRoleId),
    consideredSourceSystems: considered.map(item => item.sourceSystem),
    authorityPriorRoleId: input.authorityPriorRoleId,
    conversationDisplaced: conversationDisplacement > 0,
    quantities: { dialogueDependence, sourceDependence, externalTruthAuthority, conversationDisplacement, supportByRole, supportMargin: 0 }
  } as const;

  if (conversationDisplacement <= 0) {
    return {
      ...base,
      selectedCorpusRoleId: input.authorityPriorRoleId,
      selectedSourceSystem: roleSourceSystem(eligible, input.authorityPriorRoleId),
      hydratedModelIds: [],
      reasonId: "population.authority_prior",
      status: "bypassed_not_applicable"
    };
  }
  if (!considered.length) {
    return {
      ...base,
      selectedCorpusRoleId: input.authorityPriorRoleId,
      selectedSourceSystem: roleSourceSystem(eligible, input.authorityPriorRoleId),
      hydratedModelIds: [],
      reasonId: "population.none_eligible",
      status: "inert_unconfigured"
    };
  }

  const scored = considered
    .map(item => ({ item, perplexity: supportByRole[String(item.corpusRoleId)] }))
    .filter((row): row is { item: LanguagePopulationCandidate; perplexity: number } => Number.isFinite(row.perplexity))
    .sort((left, right) => left.perplexity - right.perplexity || left.item.sourceSystem.localeCompare(right.item.sourceSystem));

  if (!scored.length) {
    // One displaced population needs no measurement to be the only one; more than one, unmeasured, is not a choice.
    const only = considered.length === 1 ? considered[0] : undefined;
    return {
      ...base,
      selectedCorpusRoleId: only?.corpusRoleId ?? input.authorityPriorRoleId,
      selectedSourceSystem: only?.sourceSystem ?? roleSourceSystem(eligible, input.authorityPriorRoleId),
      hydratedModelIds: [],
      reasonId: "population.conversation_displaced.no_resident_support",
      status: only ? "bypassed_not_applicable" : "inert_unconfigured"
    };
  }

  const best = scored[0]!;
  const runnerUp = scored[1];
  const supportMargin = runnerUp ? runnerUp.perplexity - best.perplexity : 0;
  return {
    ...base,
    quantities: { ...base.quantities, supportMargin },
    selectedCorpusRoleId: best.item.corpusRoleId,
    selectedSourceSystem: best.item.sourceSystem,
    hydratedModelIds: (input.support ?? [])
      .filter(row => String(row.corpusRoleId) === String(best.item.corpusRoleId))
      .flatMap(row => row.modelIds)
      .sort(),
    reasonId: "population.conversation_displaced.measured_support",
    status: "active"
  };
}

/**
 * Held-out support of one population for a sequence: the best resident model, not a mixture.
 * A mixture would need weights nothing has fitted; "the best realizer this population offers" needs none.
 */
export function measureLanguagePopulationSupport(
  populations: readonly { corpusRoleId: CorpusRoleId; sourceSystem: string; modelId: string; model: KneserNeyModel }[],
  text: string | readonly string[]
): LanguagePopulationSupport[] {
  const byRole = new Map<string, LanguagePopulationSupport>();
  for (const row of populations) {
    const perplexity = kneserNeyPerplexity(row.model, text);
    if (!Number.isFinite(perplexity)) continue;
    const key = String(row.corpusRoleId);
    const current = byRole.get(key);
    if (!current) {
      byRole.set(key, { corpusRoleId: row.corpusRoleId, sourceSystem: row.sourceSystem, perplexity, modelIds: [row.modelId] });
      continue;
    }
    current.modelIds.push(row.modelId);
    if (perplexity < current.perplexity) {
      current.perplexity = perplexity;
      current.sourceSystem = row.sourceSystem;
    }
  }
  return [...byRole.values()].map(row => ({ ...row, modelIds: [...row.modelIds].sort() }));
}

export function languagePopulationSelectionTrace(selection: LanguagePopulationSelection): JsonValue {
  return {
    schema: selection.schema,
    selectedCorpusRoleId: selection.selectedCorpusRoleId ?? null,
    selectedSourceSystem: selection.selectedSourceSystem ?? null,
    consideredRoleIds: selection.consideredRoleIds.map(String),
    consideredSourceSystems: selection.consideredSourceSystems,
    authorityPriorRoleId: selection.authorityPriorRoleId ? String(selection.authorityPriorRoleId) : null,
    conversationDisplaced: selection.conversationDisplaced,
    quantities: { ...selection.quantities },
    hydratedModelIds: selection.hydratedModelIds,
    reasonId: selection.reasonId,
    status: selection.status
  } as unknown as JsonValue;
}

function roleSourceSystem(entries: readonly CorpusRegistryEntry[], roleId?: CorpusRoleId): string | undefined {
  if (!roleId) return undefined;
  return entries.find(entry => entry.corpusRoleId === roleId)?.sourceSystem;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
