// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticAtom, SemanticConstraint } from "../semantic-proof-types.js";
import { SEMANTIC_SOURCE } from "../semantic-codes.js";
import { factualRoundTripGate } from "../semantic-round-trip.js";

// Isolate the acceptance contract from interpretation. These are supplied atom
// fixtures, not claims that arbitrary sentences have been parsed correctly.
// The companion soundness test exercises the actual atomizer on known fixtures.
const state = vi.hoisted(() => ({ interpreted: new Map<string, SemanticAtom[]>() }));
vi.mock("../semantic-proof-system.js", () => ({
  atomizeText: ({ text }: { text: string }) => {
    const atoms = state.interpreted.get(text);
    if (!atoms) throw new Error(`missing explicit interpretation fixture: ${text}`);
    return atoms;
  }
}));
afterEach(() => state.interpreted.clear());

function atom(id: string): SemanticAtom {
  return {
    id, predicate: "ships", predicateFeatures: [],
    roles: [
      { name: "arg0", value: "alice", normalized: "alice", type: "entity", features: [], weight: 1 },
      { name: "arg1", value: "crates", normalized: "crates", type: "entity", features: [], weight: 1 },
      { name: "arg2", value: "boston", normalized: "boston", type: "entity", features: [], weight: 1 }
    ],
    constraints: [], polarity: 1, alpha: 0.5, modality: "fixture.asserted",
    source: SEMANTIC_SOURCE.CLAIM, sourceText: "alice ships crates to boston.",
    evidenceIds: [], nodeIds: [], vector: [], proofClass: "", certifiesFactualProof: false
  };
}

function constraint(kind: string, value: SemanticConstraint["value"]): SemanticConstraint {
  return { id: "constraint.fixture", kind, subject: "arg1", operator: "eq", value, confidence: 1, evidenceIds: [] };
}

function gate(intended: SemanticAtom[], realized: SemanticAtom[], requireComplete = false) {
  state.interpreted.set("fixture:intended", intended);
  state.interpreted.set("fixture:realized", realized);
  return factualRoundTripGate({ intendedText: "fixture:intended", realizedText: "fixture:realized", requireComplete });
}

describe("full preservation is distinct from summary coverage", () => {
  it("rejects omitted whole facts when the caller requires complete preservation", () => {
    const other = atom("other");
    other.predicate = "invents";
    other.roles[0]!.normalized = "bob";
    const result = gate([atom("a"), other], [atom("b")], true);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/omits 1 required atom/);
    expect(result.cycleTrace.distance.missing).toHaveLength(1);
  });

  it("accepts complete preservation without imposing source order", () => {
    const other = atom("other");
    other.predicate = "invents";
    other.roles[0]!.normalized = "bob";
    expect(gate([atom("a"), other], [{ ...other, id: "other.realized" }, atom("b")], true).accepted).toBe(true);
  });

  it("complete coverage cannot excuse a mutation", () => {
    expect(gate([atom("a")], [{ ...atom("b"), polarity: -1 }], true).accepted).toBe(false);
  });
});

describe("semantic equality cannot use lossy storage normalization", () => {
  it("does not fold a NUL character into a space in a role binding", () => {
    const intended = atom("a");
    intended.roles[0]!.normalized = "alice\u0000smith";
    const realized = atom("b");
    realized.roles[0]!.normalized = "alice smith";
    expect(gate([intended], [realized]).accepted).toBe(false);
  });

  it("does not lose an own __proto__ key from a semantic constraint", () => {
    const intended = atom("a");
    intended.constraints = [constraint("fixture.semantic-json", JSON.parse('{"__proto__":{"scope":"all"},"value":42}'))];
    const realized = atom("b");
    realized.constraints = [constraint("fixture.semantic-json", JSON.parse('{"__proto__":{"scope":"some"},"value":42}'))];
    expect(gate([intended], [realized]).accepted).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite numeric meaning: %s", value => {
    const intended = atom("a");
    intended.constraints = [constraint("fixture.invalid", value)];
    const result = gate([intended], [{ ...intended, id: "b" }]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/invalid semantic interpretation/);
  });

  it("rejects undefined rather than silently treating it as null", () => {
    const intended = atom("a");
    intended.constraints = [constraint("fixture.invalid", undefined as never)];
    const realized = atom("b");
    realized.constraints = [constraint("fixture.invalid", null)];
    const result = gate([intended], [realized]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/invalid semantic interpretation/);
  });

  it("rejects a cyclic JSON value without throwing from the gate", () => {
    const value: Record<string, any> = {};
    value.self = value;
    const intended = atom("a");
    intended.constraints = [constraint("fixture.invalid", value)];
    const result = gate([intended], [{ ...intended, id: "b" }]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/cycle/);
    expect(JSON.parse(JSON.stringify(result)).accepted).toBe(false);
  });

  it("rejects a sparse array rather than filling holes with null", () => {
    const intended = atom("a");
    intended.constraints = [constraint("fixture.invalid", Array(2))];
    const result = gate([intended], [{ ...intended, id: "b" }]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/invalid semantic interpretation/);
  });

  it("does not invoke getters in a nested semantic JSON value", () => {
    let called = 0;
    const value = Object.defineProperty({}, "meaning", { enumerable: true, get: () => { called++; return "all"; } });
    const intended = atom("a");
    intended.constraints = [constraint("fixture.invalid", value)];
    const result = gate([intended], [{ ...intended, id: "b" }]);
    expect(result.accepted).toBe(false);
    expect(called).toBe(0);
    expect(JSON.parse(JSON.stringify(result)).accepted).toBe(false);
    expect(called).toBe(0);
  });

  it("accepts equivalent null-prototype JSON records", () => {
    const intended = atom("a");
    intended.constraints = [constraint("fixture.json", Object.assign(Object.create(null), { scope: "all", value: 42 }))];
    const realized = atom("b");
    realized.constraints = [constraint("fixture.json", { value: 42, scope: "all" })];
    expect(gate([intended], [realized]).accepted).toBe(true);
  });

  it("refuses an atom-ID collision rather than accepting the overwritten meaning", () => {
    const positive = atom("same-id");
    const negative = { ...atom("same-id"), polarity: -1 as const };
    const result = gate([positive, negative], [{ ...negative, id: "realized" }]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/one atom identity/);
  });

  it("still accepts repeated identical atom identities", () => {
    const intended = atom("a");
    expect(gate([intended, structuredClone(intended)], [atom("b")]).accepted).toBe(true);
  });
});
