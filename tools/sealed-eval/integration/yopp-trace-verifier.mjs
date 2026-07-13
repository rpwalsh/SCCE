#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONDITION_IDS = Object.freeze([
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
]);

export const COMPONENT_IDS = Object.freeze([
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
]);

const ENABLED = Object.freeze({
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

const matrix = Object.freeze({
  full: featureFlags(),
  no_relation_potential: featureFlags({ disableRelationPotential: true }),
  no_query_diffusion: featureFlags({ disableQueryDiffusion: true }),
  no_powerwalk: featureFlags({ disablePowerWalk: true }),
  no_graph: featureFlags({ disableGraph: true, disableRelationPotential: true, disableQueryDiffusion: true, disablePowerWalk: true }),
  lexical_only: featureFlags({
    disableGraph: true,
    lexicalOnly: true,
    disableLearnedSemantics: true,
    disableRelationPotential: true,
    disableQueryDiffusion: true,
    disablePowerWalk: true
  }),
  no_support_engine: featureFlags({ disableSupportEngine: true }),
  deterministic_mouth: featureFlags({ deterministicMouth: true }),
  no_language_memory: featureFlags({ disableLanguageMemory: true }),
  no_incremental_learning: featureFlags({ disableIncrementalLearning: true }),
  no_shard_router: featureFlags({ disableShardRouter: true })
});

export function verifyEvaluationConfiguration(config) {
  const violations = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, violations: [{ code: "CONFIG_INVALID", message: "condition configuration must be an object" }] };
  }
  if (!CONDITION_IDS.includes(config.conditionId)) add("CONFIG_CONDITION_UNKNOWN", `unknown condition: ${String(config.conditionId)}`);
  const expectedFlags = matrix[config.conditionId];
  if (expectedFlags && stableStringify(config.flags) !== stableStringify(expectedFlags)) {
    add("CONFIG_FEATURE_MATRIX_MISMATCH", `condition ${config.conditionId} does not match its required feature matrix`);
  }
  const expectedDisabled = expectedFlags ? disabledComponents(expectedFlags) : [];
  if (stableStringify(config.disabledComponents) !== stableStringify(expectedDisabled)) {
    add("CONFIG_DISABLED_COMPONENTS_MISMATCH", "disabled-component list does not match the feature matrix");
  }
  if (config.conditionId === "no_shard_router" && config.scope !== "performance-recovery") {
    add("CONFIG_SCOPE_INVALID", "no_shard_router is valid only for performance-recovery evaluation");
  }
  if (config.scope !== "answer-quality" && config.scope !== "performance-recovery") add("CONFIG_SCOPE_INVALID", "unknown evaluation scope");
  if (typeof config.seed !== "string" || config.seed.trim() === "") add("CONFIG_SEED_INVALID", "evaluation seed must be non-empty");
  if (typeof config.clockIso !== "string" || !Number.isFinite(Date.parse(config.clockIso))) add("CONFIG_CLOCK_INVALID", "evaluation clock must be an ISO-8601 timestamp");
  if (expectedFlags) {
    const expectedHash = sha256(stableStringify(hashMaterial(config)));
    if (config.configHash !== expectedHash) add("CONFIG_HASH_MISMATCH", "configHash does not match canonical condition material");
    const expectedNamespace = `eval-${config.conditionId.replaceAll("_", "-")}-${expectedHash}`;
    if (config.cacheNamespace !== expectedNamespace) add("CONFIG_NAMESPACE_MISMATCH", "cacheNamespace does not match condition/config identity");
  }
  return { valid: violations.length === 0, violations };

  function add(code, message) { violations.push({ code, message }); }
}

export function verifyCacheIsolation(config, events) {
  const violations = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event?.event !== "cacheRead") continue;
    if (typeof event.cacheKey !== "string" || !event.cacheKey.startsWith(`${config.cacheNamespace}:`)) add("CACHE_KEY_NAMESPACE_MISMATCH", "cache key is outside the active condition namespace", eventIndex, event.component);
    if (event.cacheOwnerConditionId !== config.conditionId) add("CACHE_OWNER_CONDITION_MISMATCH", "cache entry was produced by another condition", eventIndex, event.component);
    if (event.cacheOwnerConfigHash !== config.configHash) add("CACHE_OWNER_CONFIG_MISMATCH", "cache entry was produced by another configuration", eventIndex, event.component);
    if (event.cacheOwnerNamespace !== config.cacheNamespace) add("CACHE_OWNER_NAMESPACE_MISMATCH", "cache entry owner namespace does not match the active namespace", eventIndex, event.component);
  }
  return violations;

  function add(code, message, eventIndex, component) { violations.push({ code, message, eventIndex, ...(component ? { component } : {}) }); }
}

export function verifyYoppEvaluationTrace(config, events) {
  const configuration = verifyEvaluationConfiguration(config);
  const violations = configuration.violations.map(item => ({ ...item }));
  const expectedDisabled = Array.isArray(config?.disabledComponents) ? config.disabledComponents : [];
  const bypassed = new Set();
  const identities = { traceId: undefined, runId: undefined, questionId: undefined };
  if (!Array.isArray(events) || events.length === 0) add("TRACE_EMPTY", "evaluation trace contains no component-boundary events");

  for (let eventIndex = 0; eventIndex < (Array.isArray(events) ? events.length : 0); eventIndex += 1) {
    const event = events[eventIndex];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      add("EVENT_INVALID", "trace event must be an object", eventIndex);
      continue;
    }
    if (!COMPONENT_IDS.includes(event.component)) add("EVENT_COMPONENT_UNKNOWN", `unknown component: ${String(event.component)}`, eventIndex);
    if (!["componentEntered", "componentBypassed", "cacheRead"].includes(event.event)) add("EVENT_TYPE_UNKNOWN", `unknown event type: ${String(event.event)}`, eventIndex, event.component);
    if (event.conditionId !== config?.conditionId) add("EVENT_CONDITION_MISMATCH", "event condition does not match evaluated condition", eventIndex, event.component);
    if (event.configHash !== config?.configHash) add("EVENT_CONFIG_MISMATCH", "event config hash does not match evaluated configuration", eventIndex, event.component);
    if (event.cacheNamespace !== config?.cacheNamespace) add("EVENT_NAMESPACE_MISMATCH", "event cache namespace does not match evaluated configuration", eventIndex, event.component);
    if (event.sequence !== eventIndex) add("EVENT_SEQUENCE_INVALID", "event sequence is not contiguous from zero", eventIndex, event.component);
    if (typeof event.time !== "string" || !Number.isFinite(Date.parse(event.time))) add("EVENT_TIME_INVALID", "event time is not an ISO-8601 timestamp", eventIndex, event.component);
    for (const key of Object.keys(identities)) {
      if (identities[key] === undefined) identities[key] = event[key];
      else if (identities[key] !== event[key]) add("EVENT_TRACE_IDENTITY_MISMATCH", `${key} changes within one trace`, eventIndex, event.component);
    }
    const disabled = expectedDisabled.includes(event.component);
    if (event.event === "componentBypassed" && disabled && event.reason === "condition-disabled") bypassed.add(event.component);
    if (event.event === "componentEntered" && disabled) add("DISABLED_COMPONENT_ENTERED", "disabled component was entered", eventIndex, event.component);
    if (event.event === "cacheRead" && disabled) add("DISABLED_COMPONENT_CACHE_READ", "disabled component attempted a cache read", eventIndex, event.component);
  }
  if (Array.isArray(events)) violations.push(...verifyCacheIsolation(config ?? {}, events));
  for (const component of expectedDisabled) {
    if (!bypassed.has(component)) add("DISABLED_COMPONENT_BYPASS_MISSING", "disabled component has no explicit condition-disabled bypass event", undefined, component);
  }
  return {
    schemaVersion: "1.0",
    valid: violations.length === 0,
    conditionId: config?.conditionId ?? null,
    configHash: config?.configHash ?? null,
    eventCount: Array.isArray(events) ? events.length : 0,
    disabledComponents: [...expectedDisabled],
    bypassedDisabledComponents: [...bypassed],
    violations
  };

  function add(code, message, eventIndex, component) {
    violations.push({ code, message, ...(eventIndex === undefined ? {} : { eventIndex }), ...(component === undefined ? {} : { component }) });
  }
}

export async function verifyYoppEvaluationTraceFiles({ conditionPath, tracePath, outPath }) {
  const config = JSON.parse(await readFile(path.resolve(conditionPath), "utf8"));
  const events = parseJsonl(await readFile(path.resolve(tracePath), "utf8"), tracePath);
  const result = verifyYoppEvaluationTrace(config, events);
  if (outPath) {
    const absolute = path.resolve(outPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(result)}\n`, "utf8");
  }
  return result;
}

function featureFlags(overrides = {}) { return Object.freeze({ ...ENABLED, ...overrides }); }

function disabledComponents(value) {
  return [
    ["disableRelationPotential", "relation-potential"],
    ["disableQueryDiffusion", "query-diffusion"],
    ["disablePowerWalk", "powerwalk"],
    ["disableGraph", "graph"],
    ["disableLearnedSemantics", "learned-semantics"],
    ["disableSupportEngine", "support-engine"],
    ["deterministicMouth", "learned-mouth"],
    ["disableLanguageMemory", "language-memory"],
    ["disableIncrementalLearning", "incremental-learning"],
    ["disableShardRouter", "shard-router"]
  ].filter(([flag]) => value[flag]).map(([, component]) => component);
}

function hashMaterial(config) {
  return {
    schemaVersion: "1.0",
    conditionId: config.conditionId,
    scope: config.scope,
    seed: config.seed,
    clockIso: config.clockIso,
    flags: config.flags,
    disabledComponents: config.disabledComponents
  };
}

function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function sha256(text) { return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"); }

function parseJsonl(text, file) {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

function argsMap(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const equals = value.indexOf("=");
    if (equals >= 0) args.set(value.slice(2, equals), value.slice(equals + 1));
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) args.set(value.slice(2), argv[++index]);
    else args.set(value.slice(2), "true");
  }
  return args;
}

async function main() {
  const args = argsMap(process.argv.slice(2));
  const conditionPath = args.get("condition");
  const tracePath = args.get("trace");
  if (!conditionPath || !tracePath) throw new Error("Use: yopp-trace-verifier.mjs --condition=<condition.json> --trace=<trace.jsonl> [--out=<verification.json>]");
  const result = await verifyYoppEvaluationTraceFiles({ conditionPath, tracePath, outPath: args.get("out") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
