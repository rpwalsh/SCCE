import { pairwiseLabelFromEntailment } from "./sparse-ranking-labels.js";
import { createFtrlProximalRanker } from "./sparse-ranking.js";
import { FTRL_GRAPH_NODE_RANK_TASK_CLASS, type FtrlShadowRanking } from "./sparse-ranking-shadow.js";
import { RETRIEVAL_RANK_FEATURE_SCHEMA_V1 } from "./retrieval-rank-features.js";
import type { SparseRankingModelStore } from "./sparse-ranking-lifecycle.js";
import type { SparseRankingComparisonLogStore } from "./sparse-ranking-comparison-log.js";
import type { Clock, EvidenceId, GraphNode, SemanticEntailmentResult } from "./types.js";

export interface FtrlOutcomeUpdateResult {
  updated: boolean;
  reason: string;
}

/**
 * Outcome-based FTRL learning (Part A finding 9, stage 3): correlates one
 * turn's shadow-ranked candidates with that same turn's real proof/
 * certification result and, when a defensible contrast exists, applies a
 * real `updatePair` and persists it. Lifecycle is always written back as
 * "shadow" -- this never auto-promotes a model to "active"; that requires
 * a held-out evaluation pass (stage 6) explicitly marking it "approved"
 * first, which `activate()` structurally enforces.
 *
 * Every input here is resolved independently of the ranker's own output:
 * `shadowRanking` supplies which candidates existed and their feature
 * vectors (not their FTRL scores -- those are discarded), and
 * `pairwiseLabelFromEntailment` supplies which evidence the proof
 * actually certified. Failures here (no store configured, no shadow
 * ranking, no defensible label, transient store errors) are all
 * non-fatal to the turn -- the caller is expected to treat this as a
 * best-effort background update, never something that can fail a turn.
 */
export async function updateFtrlFromTurnOutcome(input: {
  store: SparseRankingModelStore | undefined;
  comparisonLog?: SparseRankingComparisonLogStore;
  shadowRanking: FtrlShadowRanking | undefined;
  nodesById: ReadonlyMap<string, GraphNode>;
  entailment: SemanticEntailmentResult;
  candidatePoolEvidenceIds: readonly EvidenceId[];
  clock: Clock;
}): Promise<FtrlOutcomeUpdateResult> {
  if (!input.store) return { updated: false, reason: "no sparse ranking model store configured" };
  if (!input.shadowRanking || !input.shadowRanking.ranked.length) {
    return { updated: false, reason: "no shadow ranking computed for this turn" };
  }
  const label = pairwiseLabelFromEntailment({
    entailment: input.entailment,
    candidatePoolEvidenceIds: input.candidatePoolEvidenceIds
  });
  if (!label) return { updated: false, reason: "no defensible pairwise label from this turn's verdict" };
  if (label.weight <= 0) return { updated: false, reason: "label weight is zero" };

  const preferredSet = new Set(label.preferredEvidenceIds.map(String));
  const rejectedSet = new Set(label.rejectedEvidenceIds.map(String));
  const preferredEntry = input.shadowRanking.ranked.find(entry => {
    const node = input.nodesById.get(entry.nodeId);
    return node ? node.evidenceIds.some(id => preferredSet.has(String(id))) : false;
  });
  const rejectedEntry = input.shadowRanking.ranked.find(entry => {
    const node = input.nodesById.get(entry.nodeId);
    return node ? node.evidenceIds.some(id => rejectedSet.has(String(id))) : false;
  });
  if (!preferredEntry || !rejectedEntry) {
    return { updated: false, reason: "shadow-ranked candidates did not cover both sides of the label" };
  }
  if (preferredEntry.nodeId === rejectedEntry.nodeId) {
    return { updated: false, reason: "preferred and rejected labels resolved to the same candidate node" };
  }

  const checkpoint = await input.store.readActive(FTRL_GRAPH_NODE_RANK_TASK_CLASS, RETRIEVAL_RANK_FEATURE_SCHEMA_V1);
  if (!checkpoint) return { updated: false, reason: "no active checkpoint to update" };

  const ranker = createFtrlProximalRanker({
    modelId: checkpoint.modelId,
    featureSchemaId: checkpoint.featureSchemaId,
    state: checkpoint.state,
    clock: input.clock
  });
  ranker.updatePair({
    preferred: preferredEntry.featureVector,
    rejected: rejectedEntry.featureVector,
    weight: label.weight
  });
  const now = input.clock.now();
  await input.store.putCheckpoint({
    ...checkpoint,
    state: ranker.snapshot(),
    lifecycle: "shadow",
    examplesSeen: checkpoint.examplesSeen + 1,
    trainingWindow: {
      firstExampleAt: checkpoint.examplesSeen > 0 ? checkpoint.trainingWindow.firstExampleAt : now,
      lastExampleAt: now
    }
  });
  if (input.comparisonLog) {
    const preferredIndex = input.shadowRanking.ranked.findIndex(entry => entry.nodeId === preferredEntry.nodeId);
    await input.comparisonLog.append({
      id: `ftrl-comparison:${checkpoint.modelId}:${now}:${checkpoint.examplesSeen}`,
      taskClass: FTRL_GRAPH_NODE_RANK_TASK_CLASS,
      featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
      recordedAt: now,
      candidates: input.shadowRanking.ranked.map(entry => entry.featureVector),
      preferredIndex,
      weight: label.weight,
      source: label.source,
      informationLabel: checkpoint.informationLabel
    });
  }
  return { updated: true, reason: label.reason };
}
