// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { compileOpaqueRoleModel, compileRelationPromotionModel, createTypedIngestProjector, graphFromStructuredSemanticCandidates,
  observedEntitySurfacesFromInducedLanguageModel, relationObservationsFromCandidates, relationPromotionNeedsPriors,
  type EvidenceSpan, type GraphSnapshot, type Hasher, type IdFactory, type InducedLanguageModel, type InformationLabel,
  type JsonValue, type ScceStorage, type SourceId, type SourceVersionId } from "@scce/kernel";

export const SOURCE_ENTITY_GRAPH_COMPONENT_RECIPE_ID = "kernel.source_entity_graph_projection.v1" as const;

/** Project the admitted source through the existing candidate, promotion, and typed graph producers. */
export async function prepareCorpusSourceGraphProjection(input: {
  storage: ScceStorage; sourceId: SourceId; sourceVersionId: SourceVersionId; uri: string; mediaType: string; text: string;
  metadata: JsonValue; evidence: EvidenceSpan[]; model?: InducedLanguageModel; informationLabel: InformationLabel;
  ids: IdFactory; hasher: Hasher; observedAt: number;
}) {
  const typed = createTypedIngestProjector({ idFactory: input.ids, hasher: input.hasher }).project({ ...input,
    entityConstructions: input.model?.graphBoundConstructions,
    entitySurfaces: input.model ? observedEntitySurfacesFromInducedLanguageModel(input.model, input.evidence.map(span => String(span.id))) : [] });
  const candidates = typed.semanticCandidates;
  const batch = relationObservationsFromCandidates(candidates);
  const store = input.storage.relationObservations;
  const prior = store && batch.length && (!store.sourceFamilyCountsForSeeds || relationPromotionNeedsPriors({ batch,
    familyCountsOnFile: await store.sourceFamilyCountsForSeeds([...new Set(batch.map(row => row.relationSeedId))]) })) ? await store.list({}) : [];
  const promotion = compileRelationPromotionModel({ candidates, hasher: input.hasher, priorObservations: prior.map(row => ({
    candidateId: row.candidateId, relationSeedId: row.relationSeedId, channel: row.channel as typeof candidates[number]["channel"],
    sourceId: row.sourceId, sourceFamilyId: row.sourceFamilyId, signature: row.signature
  })) });
  const roles = compileOpaqueRoleModel({ candidates, promotionModel: promotion, hasher: input.hasher });
  const promoted = graphFromStructuredSemanticCandidates({ candidates, observations: typed.observations, evidence: input.evidence,
    sourceMetadata: input.metadata, observedAt: input.observedAt, ids: input.ids, hasher: input.hasher, relationPromotionModel: promotion, opaqueRoleModel: roles });
  const merge = <T extends { id: unknown }>(left: readonly T[], right: readonly T[]) => [...new Map([...left, ...right].map(row => [String(row.id), { ...row, informationLabel: input.informationLabel }])).values()];
  const graph: GraphSnapshot = { nodes: merge(typed.graphNodes, promoted.nodes), edges: merge(typed.graphEdges, promoted.edges), hyperedges: merge(typed.graphHyperedges, promoted.hyperedges) };
  return { graph, observations: batch.map(row => ({ ...row, observedAt: input.observedAt })) };
}
