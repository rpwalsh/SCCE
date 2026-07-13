import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyYoppEvaluationTrace } from "../../integration/yopp-trace-verifier.mjs";

test("trace verifier accepts an explicit disabled-component bypass", () => {
  const condition = makeCondition("no_relation_potential");
  const events = [event(condition, 0, "componentBypassed", "relation-potential", { reason: "condition-disabled" })];
  const result = verifyYoppEvaluationTrace(condition, events);
  assert.equal(result.valid, true);
  assert.deepEqual(result.bypassedDisabledComponents, ["relation-potential"]);
});

test("trace verifier rejects a planted full-condition cache marker", () => {
  const full = makeCondition("full");
  const ablated = makeCondition("no_relation_potential");
  const events = [
    event(ablated, 0, "componentBypassed", "relation-potential", { reason: "condition-disabled" }),
    event(ablated, 1, "cacheRead", "graph", {
      cacheKey: `${full.cacheNamespace}:full-only-marker`,
      cacheOwnerConditionId: full.conditionId,
      cacheOwnerConfigHash: full.configHash,
      cacheOwnerNamespace: full.cacheNamespace,
      hit: true
    })
  ];
  const result = verifyYoppEvaluationTrace(ablated, events);
  assert.equal(result.valid, false);
  assert.deepEqual(new Set(result.violations.map(item => item.code)), new Set([
    "CACHE_KEY_NAMESPACE_MISMATCH",
    "CACHE_OWNER_CONDITION_MISMATCH",
    "CACHE_OWNER_CONFIG_MISMATCH",
    "CACHE_OWNER_NAMESPACE_MISMATCH"
  ]));
});

test("trace verifier rejects a label-only ablation configuration", () => {
  const condition = makeCondition("no_support_engine");
  condition.flags.disableSupportEngine = false;
  const events = [event(condition, 0, "componentBypassed", "support-engine", { reason: "condition-disabled" })];
  const result = verifyYoppEvaluationTrace(condition, events);
  assert.equal(result.valid, false);
  assert.equal(result.violations.some(item => item.code === "CONFIG_FEATURE_MATRIX_MISMATCH"), true);
  assert.equal(result.violations.some(item => item.code === "CONFIG_HASH_MISMATCH"), true);
});

function makeCondition(conditionId) {
  const flags = {
    disableRelationPotential: conditionId === "no_relation_potential",
    disableQueryDiffusion: conditionId === "no_query_diffusion",
    disablePowerWalk: conditionId === "no_powerwalk",
    disableGraph: conditionId === "no_graph" || conditionId === "lexical_only",
    lexicalOnly: conditionId === "lexical_only",
    disableLearnedSemantics: conditionId === "lexical_only",
    disableSupportEngine: conditionId === "no_support_engine",
    deterministicMouth: conditionId === "deterministic_mouth",
    disableLanguageMemory: conditionId === "no_language_memory",
    disableIncrementalLearning: conditionId === "no_incremental_learning",
    disableShardRouter: conditionId === "no_shard_router"
  };
  if (flags.disableGraph) {
    flags.disableRelationPotential = true;
    flags.disableQueryDiffusion = true;
    flags.disablePowerWalk = true;
  }
  const disabledComponents = [
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
  ].filter(([flag]) => flags[flag]).map(([, component]) => component);
  const base = {
    schemaVersion: "1.0",
    conditionId,
    scope: conditionId === "no_shard_router" ? "performance-recovery" : "answer-quality",
    seed: "sealed-seed",
    clockIso: "2026-07-12T12:00:00.000Z",
    flags,
    disabledComponents
  };
  const configHash = createHash("sha256").update(Buffer.from(stableStringify(base), "utf8")).digest("hex");
  return { ...base, configHash, cacheNamespace: `eval-${conditionId.replaceAll("_", "-")}-${configHash}` };
}

function event(condition, sequence, eventName, component, extra = {}) {
  return {
    schemaVersion: "1.0",
    event: eventName,
    traceId: "trace-1",
    runId: "run-1",
    questionId: "q-1",
    conditionId: condition.conditionId,
    configHash: condition.configHash,
    cacheNamespace: condition.cacheNamespace,
    sequence,
    time: condition.clockIso,
    component,
    boundary: `${component}.boundary`,
    ...extra
  };
}

function stableStringify(value) {
  const stable = input => Array.isArray(input)
    ? input.map(stable)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]))
      : input;
  return JSON.stringify(stable(value));
}
