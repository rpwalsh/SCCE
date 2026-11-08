// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import type { LearnedConstruction } from "../language-construction.js";
import { createLearnedSurfaceInterpreter, type SurfaceEnumerationResult } from "../learned-surface-interpretation.js";

const literal = (surface: string) => ({ kind: "literal" as const, surface, origins: [], evidenceIds: [] });
const slot = (occurrenceId: string) => ({ kind: "slot" as const, occurrenceId, roleId: `role:${occurrenceId}`,
  formClassId: `form:${occurrenceId}`, required: true as const, origins: [], evidenceIds: [] });
const construction = (...sequence: LearnedConstruction["sequence"]) => ({ sequence });
const ambiguous = construction(literal("["), slot("a"), literal("|"), slot("b"), literal("]"));

it("preserves unique and ambiguous legacy interpretation while constraining exact occurrences", () => {
  const parser = createLearnedSurfaceInterpreter("[α|β|γ]");
  expect(parser.interpret(ambiguous)).toBeUndefined();
  expect(createLearnedSurfaceInterpreter("[α|γ]").interpret(ambiguous)?.map(role => role.surface)).toEqual(["α", "γ"]);
  const all = parser.enumerate(ambiguous, { maxTransitions: 100 });
  expect(all).toMatchObject({ complete: true, truncated: false });
  expect(all.interpretations.map(roles => roles.map(role => role.surface))).toEqual([["α", "β|γ"], ["α|β", "γ"]]);
  const known = parser.enumerate(ambiguous, { maxTransitions: 100, knownSurfaces: new Map([["a", "α|β"]]) });
  expect(known).toMatchObject({ complete: true, truncated: false });
  expect(known.interpretations.map(roles => roles.map(role => role.surface))).toEqual([["α|β", "γ"]]);
  expect(parser.enumerate(ambiguous, { maxTransitions: 100, knownSurfaces: new Map([["a", "unrelated"]]) }))
    .toMatchObject({ interpretations: [], complete: true, truncated: false });
});

it("searches adjacent slots only at original grapheme boundaries and preserves Unicode code-point spans", () => {
  const value = "e\u0301👩🏽‍💻";
  const parser = createLearnedSurfaceInterpreter(`[${value}Ω]`, true);
  const shape = construction(literal("["), slot("a"), slot("b"), literal("]"));
  const result = parser.enumerate(shape, { maxTransitions: 100, knownSurfaces: new Map([["a", "É👩🏽‍💻"]]) });
  expect(result).toMatchObject({ complete: true, truncated: false });
  expect(result.interpretations).toEqual([[{ roleId: "role:a", occurrenceId: "a", surface: value, startCodePoint: 1, endCodePoint: 7 },
    { roleId: "role:b", occurrenceId: "b", surface: "Ω", startCodePoint: 7, endCodePoint: 8 }]]);
  const all = parser.enumerate(shape, { maxTransitions: 100 });
  expect(all.interpretations.map(roles => roles.map(role => role.surface))).toEqual([["e\u0301", "👩🏽‍💻Ω"], [value, "Ω"]]);
  expect(parser.enumerate(shape, { maxTransitions: 100, knownSurfaces: new Map([["a", "e"]]) }).interpretations).toEqual([]);
});

it("reports exact transition exhaustion instead of certifying a partial unique parse", () => {
  const parser = createLearnedSurfaceInterpreter("[α|β|γ]");
  const complete = parser.enumerate(ambiguous, { maxTransitions: 100 });
  for (const cap of [1, 3, complete.visited - 1]) {
    const partial = parser.enumerate(ambiguous, { maxTransitions: cap });
    expect(partial).toMatchObject({ complete: false, truncated: true, visited: cap });
  }
  expect(parser.enumerate(ambiguous, { maxTransitions: complete.visited - 1 }).interpretations).toHaveLength(1);
  expect(parser.enumerate(ambiguous, { maxTransitions: complete.visited })).toEqual(complete);
  for (const maxTransitions of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parser.enumerate(ambiguous, { maxTransitions })).toThrow("positive safe integer");
  }
});

it("filters finite values before descending and streams without collecting exponential parse sets", () => {
  const parser = createLearnedSurfaceInterpreter("[α|β|γ]");
  const allowed = new Set(["α|β", "γ"]);
  expect(parser.enumerate(ambiguous, { maxTransitions: 100, acceptRole: role => allowed.has(role.surface) }).interpretations)
    .toEqual([
      [{ roleId: "role:a", occurrenceId: "a", surface: "α|β", startCodePoint: 1, endCodePoint: 4 },
        { roleId: "role:b", occurrenceId: "b", surface: "γ", startCodePoint: 5, endCodePoint: 6 }]
    ]);
  const many = construction(literal("["), ...Array.from({ length: 14 }, (_, index) => slot(String(index))), literal("]"));
  const original = structuredClone(many);
  let seen = 0;
  const streamed = createLearnedSurfaceInterpreter(`[${"λ".repeat(40)}]`).enumerate(many, { maxTransitions: 200,
    collect: false, visit: roles => { expect(roles).toHaveLength(14); seen++; } });
  expect(streamed).toMatchObject({ interpretations: [], complete: false, truncated: true, visited: 200 });
  expect(seen).toBeGreaterThan(0);
  expect(many).toEqual(original);
});

it("distinguishes explicit visitor stop from budget truncation and keeps construction and bindings unchanged", () => {
  const before = structuredClone(ambiguous), known = new Map([["a", "α"]]);
  const result = createLearnedSurfaceInterpreter("[α|β|γ]").enumerate(ambiguous, { maxTransitions: 100, knownSurfaces: known,
    collect: false, visit: roles => { expect(roles.map(role => role.surface)).toEqual(["α", "β|γ"]); return false; } });
  expect(result).toMatchObject({ interpretations: [], complete: false, truncated: false });
  expect(result.visited).toBeLessThan(100);
  expect(ambiguous).toEqual(before);
  expect([...known]).toEqual([["a", "α"]]);
});

it("charges a shared nested-join budget before each transition without overshooting it", () => {
  let remaining = 12, charged = 0;
  const consumeTransition = () => { if (!remaining) return false; remaining--; charged++; return true; };
  const parser = createLearnedSurfaceInterpreter("[α|β|γ]");
  let inner: SurfaceEnumerationResult | undefined;
  const outer = parser.enumerate(ambiguous, { maxTransitions: 100, consumeTransition, collect: false, visit: () => {
    inner = parser.enumerate(ambiguous, { maxTransitions: 100, consumeTransition, collect: false });
    return false;
  } });
  expect(inner).toMatchObject({ complete: false, truncated: true });
  expect(outer).toMatchObject({ complete: false, truncated: false });
  expect(outer.visited + inner!.visited).toBe(12);
  expect(charged).toBe(12);
  expect(remaining).toBe(0);
  expect(parser.enumerate(ambiguous, { maxTransitions: 100, consumeTransition }))
    .toEqual({ interpretations: [], complete: false, truncated: true, visited: 0 });
});
