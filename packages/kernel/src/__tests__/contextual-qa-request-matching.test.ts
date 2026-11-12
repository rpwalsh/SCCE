// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { contextualQaRequestMatches } from "../contextual-qa-acquisition.js";
import type { ContextualQaRequestForm } from "../source-owned-contextual-qa.js";

const slot = (slotIndex: number) => ({ slotIndex });

describe("contextual QA request-family matching", () => {
  it("matches a unique learned Unicode surface structure without a language inventory", () => {
    const form: ContextualQaRequestForm = ["\u27e6", slot(0), "\u27e1", slot(1), "\u27e7"];
    expect(contextualQaRequestMatches(form, "\u27e6\u65b0\u6e2f\ud83e\udded\u27e1\u0967.\u096c\u0966\u27e7")).toBe(true);
    expect(contextualQaRequestMatches(form, "\u27e6\u65b0\u6e2f\ud83e\udded\u27e2\u0967.\u096c\u0966\u27e7")).toBe(false);
  });

  it("rejects a surface with more than one complete slot placement", () => {
    const form: ContextualQaRequestForm = [slot(0), "\u25c7", slot(1), "?"];
    expect(contextualQaRequestMatches(form, "\u7532\u25c7\u4e59?")).toBe(true);
    expect(contextualQaRequestMatches(form, "\u7532\u25c7\u4e59\u25c7\u4e19?")).toBe(false);
  });

  it("does not admit a polar surface through a learned missing-value family", () => {
    const form: ContextualQaRequestForm = ["\u2e2e", slot(0), "\u2237", slot(1), "?"];
    expect(contextualQaRequestMatches(form, "\u2e2e\u0432\u0435\u0440\u0441\u0438\u044f\u2237\u56fa\u5b9a?")).toBe(true);
    expect(contextualQaRequestMatches(form, "\u56fa\u5b9a\u0432\u0435\u0440\u0441\u0438\u044f?")).toBe(false);
  });
});
