// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  createDurableExecutiveEpisode,
  createExecutiveEpisodeMachine,
  createHasher,
  createScceKernel,
  type Clock,
  type DurableExecutiveEpisode,
  type EvaluationConditionConfig,
  type RelationPotentialModel,
  type ScceKernel,
  type ScceStorage,
  describeRelationPotentialCapability,
  type RelationPotentialArtifactRecord,
  type CognitiveCapability
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { createExecutiveEventJournal, createPostgresStorageAdapter } from "./postgres.js";
import { NodeFileIngestAdapter } from "./files.js";
import { NodeBuildTestAdapter } from "./process.js";
import { ConfiguredConnectorAdapter } from "./connectors.js";
import { createClipVisualEmbedder, registerVisualEmbedder } from "./visual-ingest.js";
import { createApprovalSession, type ApprovalSession } from "./approval-session.js";
import { createNodePostgresGovernanceProbe } from "./governance-probe.js";
import { corpusRegistryEntriesFromConfig } from "./config.js";

export interface NodeScceRuntime {
  storage: ScceStorage;
  kernel: ScceKernel;
  connectors: ConfiguredConnectorAdapter;
  approvals: ApprovalSession;
  /** Durable, crash-recoverable executive episode coordinator backed by Postgres. */
  executive: DurableExecutiveEpisode;
  /** Promoted relation-potential artifact resolution: await `hydrated` before claiming the component is active. */
  relationPotential: {
    hydrated: Promise<void>;
    capability(): CognitiveCapability;
    promotedModelId(): string | undefined;
  };
  close(): Promise<void>;
}

export interface NodeScceRuntimeOptions {
  /** Explicit, immutable condition injection for sealed evaluation runs. */
  evaluationCondition?: EvaluationConditionConfig;
  evaluationRunId?: string;
  /** Injected clock/seed make sealed replay independent of ambient process state. */
  clock?: Clock;
  runSeed?: string;
  deterministicReplay?: boolean;
  /** Override the config model; null explicitly selects the identity fallback. */
  relationPotentialModel?: RelationPotentialModel | null;
  /** Independent process-level governance controls; defaults to process.env. */
  governanceEnvironment?: Readonly<Record<string, string | undefined>>;
}

export function createNodeRuntime(config: ScceRuntimeConfig, options: NodeScceRuntimeOptions = {}): NodeScceRuntime {
  const informationAccess = config.security?.informationAccess;
  const sourceInformationLabel = config.security?.defaultSourceInformationLabel;
  if (!informationAccess || !sourceInformationLabel) {
    throw new Error("runtime requires security.informationAccess and security.defaultSourceInformationLabel");
  }
  const storage = createPostgresStorageAdapter({
    url: config.database.url,
    schema: config.database.schema,
    ssl: config.database.ssl,
    informationAccess
  });
  const files = new NodeFileIngestAdapter(config);
  const buildTest = new NodeBuildTestAdapter(config);
  const approvals = createApprovalSession();
  const connectors = new ConfiguredConnectorAdapter(config, () => approvals.policyPatch());
  const governance = createNodePostgresGovernanceProbe({
    storage,
    approvals,
    workspaceRoot: config.runtime.workspaceRoot,
    environment: options.governanceEnvironment
  });
  // Lifecycle, not a config paste: the promoted artifact is read from the durable store. The explicit option still
  // wins (sealed evaluation), then the config model, and only a promoted artifact can make the component active.
  let resolvedRelationPotentialModel = options.relationPotentialModel === undefined
    ? config.runtime.relationPotentialModel
    : options.relationPotentialModel ?? undefined;
  let relationPotentialArtifact: RelationPotentialArtifactRecord | undefined;
  const relationPotentialPinned = options.relationPotentialModel !== undefined;
  const relationPotentialHydrated = relationPotentialPinned
    ? Promise.resolve()
    : storage.relationPotentialModels.readPromoted()
      .then(record => {
        if (!record) return;
        relationPotentialArtifact = record;
        resolvedRelationPotentialModel = record.model;
      })
      .catch(error => { console.error(`[scce] relation-potential artifact hydration failed: ${error instanceof Error ? error.message : String(error)}`); });
  const executive = createDurableExecutiveEpisode({
    machine: createExecutiveEpisodeMachine(createHasher()),
    journal: createExecutiveEventJournal(storage),
    maxConflictRetries: 5
  });
  // Declared, config-gated visual embedder (Phase 3): registered for document extraction and
  // handed to the kernel only as a text->visual-space query function.
  const visualEmbeddings = config.ingestion?.visual?.embeddings;
  const visualEmbedder = visualEmbeddings?.enabled
    ? createClipVisualEmbedder({ modelId: visualEmbeddings.modelId, modelDir: visualEmbeddings.modelDir, log: message => console.error(`[scce] ${message}`) })
    : undefined;
  registerVisualEmbedder(visualEmbedder);
  const kernel = createScceKernel({
    storage,
    files,
    buildTest,
    governance,
    connectors,
    approvals,
    ...(visualEmbedder ? { visualQueryEmbedder: (text: string) => visualEmbedder.embedText(text) } : {}),
    policy: config.policy,
    maxChunkBytes: config.runtime.maxChunkBytes,
    informationAccess,
    sourceInformationLabel,
    namespace: "scce-v3-runtime",
    // Real, long-lived adapter-backed runtime (server or CLI) -- safe and
    // worth it to isolate the deferred functional-cognition self-projection
    // in its own heap-capped child process. See storage.ts's
    // ScceKernelDeps.functionalCognitionOffloadProcess for why this must
    // stay opt-in rather than the default.
    functionalCognitionOffloadProcess: true,
    // Explicit config opt-in only -- see ScceRuntimeConfig.runtime.
    allowSyntheticRequestRequirementBootstrap: config.runtime.allowSyntheticRequestRequirementBootstrap === true,
    // Live functional-consciousness authorization: with the standing
    // self-state register, authorized mode costs a turn nothing (the gate
    // reads the latest completed background projection under a freshness
    // bound), so it is config-driven rather than hardwired off.
    functionalCognitionAuthorizeCapabilities: config.runtime.functionalCognitionAuthorizeCapabilities === true,
    corpusRegistry: corpusRegistryEntriesFromConfig(config),
    evaluationCondition: options.evaluationCondition,
    evaluationRunId: options.evaluationRunId,
    clock: options.clock,
    runSeed: options.runSeed,
    deterministicReplay: options.deterministicReplay,
    relationPotentialModel: () => resolvedRelationPotentialModel,
    fieldOperatorRouting: config.runtime.fieldOperatorRouting,
    executive,
    sparseRankingModels: storage.sparseRanking,
    sparseRankingComparisons: storage.sparseRankingComparisons
  });
  const relationPotential = {
    hydrated: relationPotentialHydrated,
    capability: () => describeRelationPotentialCapability({
      artifact: relationPotentialArtifact ? "promoted" : "untrained",
      record: relationPotentialArtifact,
      note: relationPotentialArtifact
        ? `promoted artifact ${relationPotentialArtifact.modelId} selected`
        : relationPotentialPinned && resolvedRelationPotentialModel
          ? `model pinned by caller (${resolvedRelationPotentialModel.modelId}); not a promoted artifact`
          : "no promoted relation-potential artifact; field engine returns identity"
    }),
    promotedModelId: () => relationPotentialArtifact?.modelId
  };
  return { storage, kernel, connectors, approvals, executive, relationPotential, close: () => storage.close() };
}
