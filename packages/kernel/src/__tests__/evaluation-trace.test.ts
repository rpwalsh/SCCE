import { describe, expect, it, vi } from "vitest";
import { createEvaluationCacheKey, createEvaluationCondition } from "../evaluation-flags.js";
import {
  createEvaluationTrace,
  currentEvaluationCacheOwner,
  executeEvaluationComponent,
  verifyEvaluationTrace
} from "../evaluation-trace.js";

const CLOCK = "2026-07-12T12:00:00.000Z";
const identity = { traceId: "trace-1", runId: "run-1", questionId: "q-1" };
const cacheIdentity = { brainHash: "brain", corpusHash: "corpus", sourceHash: "source", buildHash: "build", algorithmVersion: "v1" };

describe("sealed evaluation trace contract", () => {
  it("bypasses a disabled execution boundary and produces a verifiable trace", () => {
    const condition = createEvaluationCondition({ conditionId: "no_relation_potential", seed: "seed", clockIso: CLOCK });
    const trace = createEvaluationTrace(condition, identity);
    const execute = vi.fn(() => "entered");
    const result = executeEvaluationComponent({
      condition,
      trace,
      component: "relation-potential",
      boundary: "graph.resolve.relation-potential",
      execute,
      bypass: () => "bypassed"
    });
    expect(result).toBe("bypassed");
    expect(execute).not.toHaveBeenCalled();
    expect(trace.events()).toMatchObject([{ event: "componentBypassed", component: "relation-potential", reason: "condition-disabled" }]);
    expect(verifyEvaluationTrace(condition, trace.events()).valid).toBe(true);
  });

  it("rejects entry and cache access by a disabled component", () => {
    const condition = createEvaluationCondition({ conditionId: "no_support_engine", seed: "seed", clockIso: CLOCK });
    const trace = createEvaluationTrace(condition, identity);
    trace.componentBypassed("support-engine", "support.assess");
    trace.componentEntered("support-engine", "support.assess");
    trace.cacheRead({
      component: "support-engine",
      boundary: "support.cache",
      cacheKey: createEvaluationCacheKey(condition, cacheIdentity, "q-1"),
      owner: currentEvaluationCacheOwner(condition),
      hit: false
    });
    const result = verifyEvaluationTrace(condition, trace.events());
    expect(result.valid).toBe(false);
    expect(result.violations.map(item => item.code)).toEqual(expect.arrayContaining([
      "DISABLED_COMPONENT_ENTERED",
      "DISABLED_COMPONENT_CACHE_READ"
    ]));
  });

  it("rejects a full-condition cache marker planted in an ablated run", () => {
    const full = createEvaluationCondition({ conditionId: "full", seed: "seed", clockIso: CLOCK });
    const ablated = createEvaluationCondition({ conditionId: "no_relation_potential", seed: "seed", clockIso: CLOCK });
    const trace = createEvaluationTrace(ablated, identity);
    trace.componentBypassed("relation-potential", "graph.resolve.relation-potential");
    trace.cacheRead({
      component: "graph",
      boundary: "graph.cache",
      cacheKey: createEvaluationCacheKey(full, cacheIdentity, "full-only-marker"),
      owner: currentEvaluationCacheOwner(full),
      hit: true
    });
    const result = verifyEvaluationTrace(ablated, trace.events());
    expect(result.valid).toBe(false);
    expect(result.violations.map(item => item.code)).toEqual(expect.arrayContaining([
      "CACHE_KEY_NAMESPACE_MISMATCH",
      "CACHE_OWNER_CONDITION_MISMATCH",
      "CACHE_OWNER_CONFIG_MISMATCH",
      "CACHE_OWNER_NAMESPACE_MISMATCH"
    ]));
  });

  it("requires an explicit bypass for every structurally disabled graph component", () => {
    const condition = createEvaluationCondition({ conditionId: "no_graph", seed: "seed", clockIso: CLOCK });
    const trace = createEvaluationTrace(condition, identity);
    trace.componentBypassed("graph", "graph.resolve");
    const result = verifyEvaluationTrace(condition, trace.events());
    expect(result.valid).toBe(false);
    expect(result.violations.filter(item => item.code === "DISABLED_COMPONENT_BYPASS_MISSING").map(item => item.component)).toEqual([
      "relation-potential",
      "query-diffusion",
      "powerwalk"
    ]);
  });
});
