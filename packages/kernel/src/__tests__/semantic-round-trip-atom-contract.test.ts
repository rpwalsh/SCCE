// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticAtom, SemanticConstraint } from "../semantic-proof-types.js";
import { SEMANTIC_CONSTRAINT, SEMANTIC_SOURCE } from "../semantic-codes.js";
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

function gate(intended: SemanticAtom[], realized: SemanticAtom[]) {
  state.interpreted.set("fixture:intended", intended);
  state.interpreted.set("fixture:realized", realized);
  return factualRoundTripGate({ intendedText: "fixture:intended", realizedText: "fixture:realized" });
}

describe("factual acceptance checks meaning, not just correspondence", () => {
  const mutations: Array<[string, (value: SemanticAtom) => void]> = [
    ["polarity", value => { value.polarity = -1; }],
    ["modality", value => { value.modality = "fixture.possible"; }],
    ["discourse force", value => { value.sourceText = "alice ships crates to boston?"; }],
    ["predicate", value => { value.predicate = "receives"; }],
    ["subject", value => { value.roles[0]!.normalized = "bob"; }],
    ["object", value => { value.roles[1]!.normalized = "gadgets"; }],
    ["role type", value => { value.roles[0]!.type = "quantity"; }],
    ["role identity", value => { value.roles[0]!.nodeId = "node.bob" as NonNullable<typeof value.roles[number]["nodeId"]>; }],
    ["role removal", value => { value.roles.pop(); }],
    ["role addition", value => { value.roles.push({ ...value.roles[0]!, name: "arg3" }); }],
    ["role multiplicity", value => { value.roles.push({ ...value.roles[0]! }); }],
    ["role reversal", value => {
      value.roles[0]!.normalized = "crates";
      value.roles[1]!.normalized = "alice";
    }]
  ];
  it.each(mutations)("rejects changed %s even when the atoms match", (_name, mutate) => {
    const intended = atom("a");
    const realized = atom("b");
    mutate(realized);
    const result = gate([intended], [realized]);
    expect(result.cycleTrace.distance.matched).toHaveLength(1);
    expect(result.cycleTrace.distance.added).toHaveLength(0);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  const constraints: Array<[string, SemanticConstraint, (value: SemanticConstraint) => void]> = [
    ["quantity", constraint(SEMANTIC_CONSTRAINT.QUANTITY, 42), value => { value.value = 99; }],
    ["quantity unit", constraint(SEMANTIC_CONSTRAINT.QUANTITY, { value: 42, unit: "kg" }), value => { value.value = { value: 42, unit: "lb" }; }],
    ["quantity operator", constraint(SEMANTIC_CONSTRAINT.QUANTITY, 42), value => { value.operator = "gt"; }],
    ["quantity subject", constraint(SEMANTIC_CONSTRAINT.QUANTITY, 42), value => { value.subject = "arg0"; }],
    ["time", constraint(SEMANTIC_CONSTRAINT.TEMPORAL, { instant: 2024 }), value => { value.value = { instant: 2025 }; }],
    ["time scope", constraint(SEMANTIC_CONSTRAINT.TEMPORAL, { lower: 1, upper: 2 }), value => { value.value = { lower: 1, upper: 3 }; }],
    ["condition", constraint("fixture.condition", "valve-open"), value => { value.value = "valve-closed"; }],
    ["quantifier scope", constraint("fixture.scope", ["forall", "exists"]), value => { value.value = ["exists", "forall"]; }]
  ];
  it.each(constraints)("rejects changed %s without relying on a new atom", (_name, original, mutate) => {
    const intended = atom("a");
    intended.constraints = [structuredClone(original)];
    const realized = { ...structuredClone(intended), id: "b" };
    mutate(realized.constraints[0]!);
    const result = gate([intended], [realized]);
    expect(result.cycleTrace.distance.added).toHaveLength(0);
    expect(result.accepted).toBe(false);
  });

  it("does not treat removal of a retained claim's qualification as summary omission", () => {
    const intended = atom("a");
    intended.constraints = [constraint("fixture.condition", "valve-open")];
    expect(gate([intended], [atom("b")]).accepted).toBe(false);
  });

  it("rejects an added constraint on an otherwise matched claim", () => {
    const realized = atom("b");
    realized.constraints = [constraint("fixture.scope", "all")];
    expect(gate([atom("a")], [realized]).accepted).toBe(false);
  });

  it.each(["intended", "realized", "both"])("rejects empty %s interpretation rather than passing vacuously", side => {
    const result = gate(side === "realized" ? [atom("a")] : [], side === "intended" ? [atom("b")] : []);
    expect(result.accepted).toBe(false);
    expect(result.cycleTrace).toBeDefined();
  });
});

describe("preserved realization behavior and deterministic matching", () => {
  it("accepts represented meaning unchanged under reordered records and changed diagnostics", () => {
    const intended = atom("a");
    intended.constraints = [
      constraint(SEMANTIC_CONSTRAINT.QUANTITY, { value: 42, unit: "kg" }),
      constraint("fixture.condition", { state: "open", port: 2 })
    ];
    const realized = { ...structuredClone(intended), id: "b", alpha: 0.1, vector: [0.1], sourceText: "ALICE ships crates to BOSTON." };
    realized.roles.reverse();
    for (const role of realized.roles) { role.value = role.value.toUpperCase(); role.weight = 0.2; }
    realized.constraints = [
      { ...intended.constraints[1]!, id: "new.condition", confidence: 0.2, value: { port: 2, state: "open" } },
      { ...intended.constraints[0]!, id: "new.quantity", value: { unit: "kg", value: 42 } }
    ];
    const before = JSON.stringify([intended, realized]);
    const result = gate([intended], [realized]);
    expect(result.accepted).toBe(true);
    expect(result.cycleTrace.distance.quantityMismatches).toHaveLength(0);
    expect(JSON.stringify([intended, realized])).toBe(before);
  });

  it("still permits omission of a separate whole atom, leaving coverage to the caller", () => {
    const other = atom("other");
    other.predicate = "invents";
    other.roles[0]!.normalized = "bob";
    expect(gate([atom("a"), other], [atom("b")]).accepted).toBe(true);
  });

  it("still rejects an unrelated added atom with the existing diagnostic", () => {
    const other = atom("other");
    other.predicate = "invents";
    other.roles = [{ ...other.roles[0]!, name: "inventor", normalized: "bob" }];
    const result = gate([atom("a")], [atom("b"), other]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/1 atom/);
  });

  it("pairs exact meanings before lexical ties when same-shape facts change order", () => {
    const positive = atom("a1");
    const negative = { ...atom("a2"), polarity: -1 as const };
    // Lexical similarity cannot distinguish these pairs; ID ordering would pair them incorrectly.
    const realizedNegative = { ...structuredClone(negative), id: "b1" };
    const realizedPositive = { ...structuredClone(positive), id: "b2" };
    const result = gate([positive, negative], [realizedNegative, realizedPositive]);
    expect(result.accepted).toBe(true);
    expect(result.cycleTrace.distance.polarityMismatches).toHaveLength(0);
    expect(result.cycleTrace.distance.matched.map(pair => [pair.aId, pair.ahatId])).toEqual([["a1", "b2"], ["a2", "b1"]]);
  });

  it("pairs exact constraint semantics first even when lexical features are identical", () => {
    const first = atom("a1");
    first.constraints = [constraint(SEMANTIC_CONSTRAINT.QUANTITY, 42)];
    const second = atom("a2");
    second.constraints = [constraint(SEMANTIC_CONSTRAINT.QUANTITY, 99)];
    const result = gate([first, second], [{ ...structuredClone(second), id: "b1" }, { ...structuredClone(first), id: "b2" }]);
    expect(result.accepted).toBe(true);
    expect(result.cycleTrace.distance.quantityMismatches).toHaveLength(0);
  });

  it("does not change the public distance shape or leak internal matching keys", () => {
    const result = gate([atom("a")], [atom("b")]);
    expect(Object.keys(result.cycleTrace.distance).sort()).toEqual([
      "schema", "matched", "missing", "added", "reversed", "quantityMismatches", "timeMismatches",
      "polarityMismatches", "modalityMismatches", "discourseForceMismatches"
    ].sort());
    expect(Object.keys(result.cycleTrace.distance.matched[0]!).sort()).toEqual(["aId", "ahatId", "similarity"]);
  });
});
