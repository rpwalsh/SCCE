import {
  createScceKernel,
  type Clock,
  type EvaluationConditionConfig,
  type RelationPotentialModel,
  type ScceKernel,
  type ScceStorage
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { createPostgresStorageAdapter } from "./postgres.js";
import { NodeFileIngestAdapter } from "./files.js";
import { NodeBuildTestAdapter } from "./process.js";
import { ConfiguredConnectorAdapter } from "./connectors.js";
import { createApprovalSession, type ApprovalSession } from "./approval-session.js";
import { createNodePostgresGovernanceProbe } from "./governance-probe.js";
import { corpusRegistryEntriesFromConfig } from "./config.js";

export interface NodeScceRuntime {
  storage: ScceStorage;
  kernel: ScceKernel;
  connectors: ConfiguredConnectorAdapter;
  approvals: ApprovalSession;
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
  const relationPotentialModel = options.relationPotentialModel === undefined
    ? config.runtime.relationPotentialModel
    : options.relationPotentialModel ?? undefined;
  const kernel = createScceKernel({
    storage,
    files,
    buildTest,
    governance,
    connectors,
    approvals,
    policy: config.policy,
    maxChunkBytes: config.runtime.maxChunkBytes,
    informationAccess,
    sourceInformationLabel,
    namespace: "scce-v3-runtime",
    corpusRegistry: corpusRegistryEntriesFromConfig(config),
    evaluationCondition: options.evaluationCondition,
    evaluationRunId: options.evaluationRunId,
    clock: options.clock,
    runSeed: options.runSeed,
    deterministicReplay: options.deterministicReplay,
    relationPotentialModel
  });
  return { storage, kernel, connectors, approvals, close: () => storage.close() };
}
