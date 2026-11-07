// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { isFormalIdentifier, readFormalIdentifier } from "../formal-identifiers.js";
import { codeRequestSignal } from "../code-request.js";
import { parseStatefulBehaviorScenarios } from "../stateful-behavior-scenarios.js";

describe("shared formal identifiers", () => {
  it.each(["गणना", "𐐀मापन", "cafe\u0301", "_値", "$値"])("retains %s and UTF16 source offsets", name => {
    const text = `🧭 ${name}(2)=4`;
    const start = "🧭 ".length;
    expect(isFormalIdentifier(name)).toBe(true);
    expect(readFormalIdentifier(text, start)).toEqual({ value: name, end: start + name.length });
    const signal = codeRequestSignal(text);
    expect(signal.signals).toContain("code.signal.call_shape");
    const requirement = signal.behaviorRequirements[0]!;
    expect(requirement.callableId).toBe(name);
    expect(text.slice(requirement.sourceSpan.charStart, requirement.sourceSpan.charEnd)).toBe(`${name}(2)=4`);
  });

  it.each(["", "9गणना", "\u093fगणना", "bad-name", "a b", "a.値", "\ud800"])("rejects malformed whole identifiers %s", name => {
    expect(isFormalIdentifier(name)).toBe(false);
  });

  it.each(["9गणना", "\u093fगणना"])("does not acquire a valid-looking suffix from %s", name => {
    expect(codeRequestSignal(`${name}(2)=4`).behaviorRequirements).toEqual([]);
    expect(parseStatefulBehaviorScenarios(`${name}(मूल्य); ${name}(2)=>4`)).toBeUndefined();
  });

  it("carries combining and astral names through ordered state scenarios with exact spans", () => {
    const text = "🧭\nरखना(कुंजी,मूल्य); 𐐀पढ़ना(कुंजी);\nरखना(\"a\",4); 𐐀पढ़ना(\"a\")↦4";
    const parsed = parseStatefulBehaviorScenarios(text)!;
    expect(parsed.declaredCallableIds).toEqual(["रखना", "𐐀पढ़ना"].sort());
    expect(parsed.scenarios).toHaveLength(1);
    const scenario = parsed.scenarios[0]!;
    expect(scenario.invocations.map(call => call.callableId)).toEqual(["रखना", "𐐀पढ़ना"]);
    for (const call of scenario.invocations) expect(text.slice(call.sourceSpan.charStart, call.sourceSpan.charEnd))
      .toBe(`${call.callableId}(${call.arguments.map(argument => JSON.stringify(argument)).join(",")})`);
    expect(scenario.assertion.result).toBe(4);
  });
});
