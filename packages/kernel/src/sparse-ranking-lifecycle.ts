import type { InformationLabel } from "./types.js";
import type { FtrlProximalRankerState } from "./sparse-ranking.js";
import type { JsonValue } from "./types.js";

/**
 * Durable model lifecycle (Part A finding 9, stage 5): candidate -> shadow
 * -> evaluated -> approved -> active, with an explicit rolled_back
 * terminal state. Nothing in this module decides *when* a model should
 * move between stages -- that judgment (shadow-mode comparison volume,
 * held-out evaluation results) is deliberately kept out of the storage
 * layer so a store implementation can never quietly promote a model on its
 * own. `activate()` is the one place that structurally enforces the
 * held-out-evaluation-gate requirement: it must refuse to activate
 * anything not already marked "approved".
 */
export type SparseRankingModelLifecycle = "candidate" | "shadow" | "evaluated" | "approved" | "active" | "rolled_back";

export interface SparseRankingCheckpoint {
  modelId: string;
  /** Retrieval task this model reranks within, e.g. "graph.node_rank.v1" -- distinct task classes never share an active model. */
  taskClass: string;
  featureSchemaId: string;
  lifecycle: SparseRankingModelLifecycle;
  state: FtrlProximalRankerState;
  trainingWindow: { firstExampleAt: number; lastExampleAt: number };
  examplesSeen: number;
  /** Held-out evaluation results once computed -- absent before stage 6 runs. */
  evaluation?: JsonValue;
  previousActiveModelId?: string;
  rollbackReason?: string;
  createdAt: number;
  informationLabel: InformationLabel;
}

export interface SparseRankingModelStore {
  readActive(taskClass: string, featureSchemaId: string): Promise<SparseRankingCheckpoint | undefined>;
  putCheckpoint(checkpoint: SparseRankingCheckpoint): Promise<void>;
  /** Refuses (throws) unless the target checkpoint's lifecycle is already "approved". */
  activate(input: { modelId: string; taskClass: string; featureSchemaId: string; expectedCurrentModelId?: string }): Promise<void>;
  rollback(input: { taskClass: string; featureSchemaId: string; reason: string }): Promise<void>;
}
