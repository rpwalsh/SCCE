// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { weightedJaccard, weightedJaccardFromSets } from "../primitives.js";

it.each([
  { left: [], right: [], expected: 1 },
  { left: ["λ"], right: [], expected: 0 },
  { left: ["λ", "λ"], right: ["λ", "μ"], expected: 0.5 },
  { left: ["👩🏽‍💻", "e\u0301"], right: ["👩🏽‍💻", "é"], expected: 1 / 3 },
  { left: ["constructor", "__proto__"], right: ["__proto__", "λ"], expected: 1 / 3 }
])("shares exact array and prepared-Set semantics for $left / $right", ({ left, right, expected }) => {
  const a: ReadonlySet<string> = new Set(left), b: ReadonlySet<string> = new Set(right);
  expect(weightedJaccardFromSets(a, b)).toBe(expected);
  expect(weightedJaccard(left, right)).toBe(expected);
  expect([...a]).toEqual([...new Set(left)]);
  expect([...b]).toEqual([...new Set(right)]);
});

it("uses the supplied membership index without reconstructing the right Set", () => {
  const right = new Set(["λ", "μ"]);
  Object.defineProperty(right, Symbol.iterator, { value: () => { throw new Error("unexpected Set copy"); } });
  expect(weightedJaccardFromSets(new Set(["λ"]), right)).toBe(0.5);
});
