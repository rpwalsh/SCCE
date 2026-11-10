// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { immutableRequestSourceFact } from "../request-source-facts.js";
it("retains shared source provenance immutably without changing Unicode or ownership", () => {
  const source = { text: "e\u0301\u0000?", evidenceIds: ["source.1"], reply: { start: 2, end: 6 } };
  const fact = immutableRequestSourceFact(source);
  expect(fact).toBe(source);
  expect(fact.text).toBe("e\u0301\u0000?");
  expect(() => fact.evidenceIds.push("forged")).toThrow();
  expect(() => { fact.reply.start = 0; }).toThrow();
});
