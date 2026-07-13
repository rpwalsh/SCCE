import { canonicalStringify, createHasher } from "./primitives.js";

export const EVALUATION_CONDITION_IDS = [
  "full",
  "no_relation_potential",
  "no_query_diffusion",
  "no_powerwalk",
  "no_graph",
  "lexical_only",
  "no_support_engine",
  "deterministic_mouth",
  "no_language_memory",
  "no_incremental_learning",
  "no_shard_router"
] as const;

export type EvaluationConditionId = (typeof EVALUATION_CONDITION_IDS)[number];

export const EVALUATION_COMPONENT_IDS = [
  "relation-potential",
  "query-diffusion",
  "powerwalk",
  "graph",
  "learned-semantics",
  "support-engine",
  "learned-mouth",
  "language-memory",
  "incremental-learning",
  "shard-router"
] as const;

export type EvaluationComponentId = (typeof EVALUATION_COMPONENT_IDS)[number];
export type EvaluationScope = "answer-quality" | "performance-recovery";

export interface EvaluationFeatureFlags {
  readonly disableRelationPotential: boolean;
  readonly disableQueryDiffusion: boolean;
  readonly disablePowerWalk: boolean;
  readonly disableGraph: boolean;
  readonly lexicalOnly: boolean;
  readonly disableLearnedSemantics: boolean;
  readonly disableSupportEngine: boolean;
  readonly deterministicMouth: boolean;
  readonly disableLanguageMemory: boolean;
  readonly disableIncrementalLearning: boolean;
  readonly disableShardRouter: boolean;
}

export interface EvaluationConditionHashMaterial {
  readonly schemaVersion: "1.0";
  readonly conditionId: EvaluationConditionId;
  readonly scope: EvaluationScope;
  readonly seed: string;
  readonly clockIso: string;
  readonly flags: EvaluationFeatureFlags;
  readonly disabledComponents: readonly EvaluationComponentId[];
}

export interface EvaluationConditionConfig extends EvaluationConditionHashMaterial {
  readonly configHash: string;
  readonly cacheNamespace: string;
}

export interface EvaluationConditionInput {
  readonly conditionId: EvaluationConditionId;
  readonly seed: string;
  readonly clockIso: string;
  readonly scope?: EvaluationScope;
}

export interface EvaluationCacheIdentity {
  readonly brainHash: string;
  readonly corpusHash: string;
  readonly sourceHash: string;
  readonly buildHash: string;
  readonly algorithmVersion: string;
}

export interface EvaluationCacheKeyMaterial extends EvaluationCacheIdentity {
  readonly conditionId: EvaluationConditionId;
  readonly configHash: string;
  readonly cacheNamespace: string;
  readonly seed: string;
  readonly clockIso: string;
  readonly logicalKey: string;
}

const ALL_ENABLED: EvaluationFeatureFlags = Object.freeze({
  disableRelationPotential: false,
  disableQueryDiffusion: false,
  disablePowerWalk: false,
  disableGraph: false,
  lexicalOnly: false,
  disableLearnedSemantics: false,
  disableSupportEngine: false,
  deterministicMouth: false,
  disableLanguageMemory: false,
  disableIncrementalLearning: false,
  disableShardRouter: false
});

const CONDITION_FLAGS: Readonly<Record<EvaluationConditionId, EvaluationFeatureFlags>> = Object.freeze({
  full: flags(),
  no_relation_potential: flags({ disableRelationPotential: true }),
  no_query_diffusion: flags({ disableQueryDiffusion: true }),
  no_powerwalk: flags({ disablePowerWalk: true }),
  // These graph-derived algorithms cannot execute honestly when graph access is disabled.
  no_graph: flags({ disableGraph: true, disableRelationPotential: true, disableQueryDiffusion: true, disablePowerWalk: true }),
  lexical_only: flags({
    disableGraph: true,
    lexicalOnly: true,
    disableLearnedSemantics: true,
    disableRelationPotential: true,
    disableQueryDiffusion: true,
    disablePowerWalk: true
  }),
  no_support_engine: flags({ disableSupportEngine: true }),
  deterministic_mouth: flags({ deterministicMouth: true }),
  no_language_memory: flags({ disableLanguageMemory: true }),
  no_incremental_learning: flags({ disableIncrementalLearning: true }),
  no_shard_router: flags({ disableShardRouter: true })
});

function flags(overrides: Partial<EvaluationFeatureFlags> = {}): EvaluationFeatureFlags {
  return Object.freeze({ ...ALL_ENABLED, ...overrides });
}

export function createEvaluationCondition(input: EvaluationConditionInput): EvaluationConditionConfig {
  assertNonEmpty(input.seed, "evaluation seed");
  assertClockIso(input.clockIso);
  const scope = input.scope ?? "answer-quality";
  if (input.conditionId === "no_shard_router" && scope !== "performance-recovery") {
    throw new Error("no_shard_router is valid only for performance-recovery evaluation");
  }
  const selectedFlags = CONDITION_FLAGS[input.conditionId];
  if (!selectedFlags) throw new Error(`unknown evaluation condition: ${String(input.conditionId)}`);
  const disabledComponents = Object.freeze(disabledComponentsForFlags(selectedFlags));
  const material: EvaluationConditionHashMaterial = Object.freeze({
    schemaVersion: "1.0",
    conditionId: input.conditionId,
    scope,
    seed: input.seed,
    clockIso: input.clockIso,
    flags: selectedFlags,
    disabledComponents
  });
  validateFeatureCombination(material.flags);
  const configHash = hashEvaluationConditionMaterial(material);
  const cacheNamespace = `eval-${input.conditionId.replaceAll("_", "-")}-${configHash}`;
  return Object.freeze({ ...material, configHash, cacheNamespace });
}

export function evaluationConditionHashMaterial(config: EvaluationConditionHashMaterial): EvaluationConditionHashMaterial {
  return {
    schemaVersion: "1.0",
    conditionId: config.conditionId,
    scope: config.scope,
    seed: config.seed,
    clockIso: config.clockIso,
    flags: { ...config.flags },
    disabledComponents: [...config.disabledComponents]
  };
}

export function hashEvaluationConditionMaterial(config: EvaluationConditionHashMaterial): string {
  return createHasher().digestHex(canonicalStringify(evaluationConditionHashMaterial(config)));
}

export function assertValidEvaluationCondition(config: EvaluationConditionConfig): void {
  assertNonEmpty(config.seed, "evaluation seed");
  assertClockIso(config.clockIso);
  if (!EVALUATION_CONDITION_IDS.includes(config.conditionId)) throw new Error(`unknown evaluation condition: ${String(config.conditionId)}`);
  if (config.conditionId === "no_shard_router" && config.scope !== "performance-recovery") {
    throw new Error("no_shard_router is valid only for performance-recovery evaluation");
  }
  validateFeatureCombination(config.flags);
  const expectedFlags = CONDITION_FLAGS[config.conditionId];
  if (canonicalStringify(config.flags) !== canonicalStringify(expectedFlags)) {
    throw new Error(`condition ${config.conditionId} does not match its required feature matrix`);
  }
  const expectedDisabled = disabledComponentsForFlags(expectedFlags);
  if (canonicalStringify(config.disabledComponents) !== canonicalStringify(expectedDisabled)) {
    throw new Error(`condition ${config.conditionId} has an incompatible disabled-component list`);
  }
  const expectedHash = hashEvaluationConditionMaterial(config);
  if (config.configHash !== expectedHash) throw new Error("evaluation config hash does not match its canonical material");
  const expectedNamespace = `eval-${config.conditionId.replaceAll("_", "-")}-${expectedHash}`;
  if (config.cacheNamespace !== expectedNamespace) throw new Error("evaluation cache namespace does not match the condition/config hash");
}

export function disabledComponentsForCondition(config: EvaluationConditionConfig): readonly EvaluationComponentId[] {
  assertValidEvaluationCondition(config);
  return config.disabledComponents;
}

export function conditionDisablesComponent(config: EvaluationConditionConfig, component: EvaluationComponentId): boolean {
  assertValidEvaluationCondition(config);
  return config.disabledComponents.includes(component);
}

export function evaluationCacheKeyMaterial(
  config: EvaluationConditionConfig,
  identity: EvaluationCacheIdentity,
  logicalKey: string
): EvaluationCacheKeyMaterial {
  assertValidEvaluationCondition(config);
  for (const [name, value] of Object.entries(identity)) assertNonEmpty(value, name);
  assertNonEmpty(logicalKey, "logical cache key");
  return {
    brainHash: identity.brainHash,
    corpusHash: identity.corpusHash,
    sourceHash: identity.sourceHash,
    buildHash: identity.buildHash,
    algorithmVersion: identity.algorithmVersion,
    conditionId: config.conditionId,
    configHash: config.configHash,
    cacheNamespace: config.cacheNamespace,
    seed: config.seed,
    clockIso: config.clockIso,
    logicalKey
  };
}

export function createEvaluationCacheKey(
  config: EvaluationConditionConfig,
  identity: EvaluationCacheIdentity,
  logicalKey: string
): string {
  const material = evaluationCacheKeyMaterial(config, identity, logicalKey);
  const digest = createHasher().digestHex(canonicalStringify(material));
  return `${config.cacheNamespace}:${digest}`;
}

function disabledComponentsForFlags(value: EvaluationFeatureFlags): EvaluationComponentId[] {
  const disabled: EvaluationComponentId[] = [];
  if (value.disableRelationPotential) disabled.push("relation-potential");
  if (value.disableQueryDiffusion) disabled.push("query-diffusion");
  if (value.disablePowerWalk) disabled.push("powerwalk");
  if (value.disableGraph) disabled.push("graph");
  if (value.disableLearnedSemantics) disabled.push("learned-semantics");
  if (value.disableSupportEngine) disabled.push("support-engine");
  if (value.deterministicMouth) disabled.push("learned-mouth");
  if (value.disableLanguageMemory) disabled.push("language-memory");
  if (value.disableIncrementalLearning) disabled.push("incremental-learning");
  if (value.disableShardRouter) disabled.push("shard-router");
  return disabled;
}

function validateFeatureCombination(value: EvaluationFeatureFlags): void {
  if (value.lexicalOnly && (!value.disableGraph || !value.disableLearnedSemantics || !value.disableRelationPotential || !value.disableQueryDiffusion || !value.disablePowerWalk)) {
    throw new Error("lexicalOnly requires graph, learned semantics, relation potential, query diffusion, and PowerWalk to be disabled");
  }
  if (value.disableGraph && (!value.disableRelationPotential || !value.disableQueryDiffusion || !value.disablePowerWalk)) {
    throw new Error("disableGraph requires graph-derived relation potential, query diffusion, and PowerWalk to be disabled");
  }
}

function assertClockIso(value: string): void {
  assertNonEmpty(value, "evaluation clock");
  if (!Number.isFinite(Date.parse(value))) throw new Error("evaluation clock must be an ISO-8601 timestamp");
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
}
