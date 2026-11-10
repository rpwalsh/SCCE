// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { composeConstructionSurface, constructionSurfaceComplete, type ConstructionSurface } from "../construction-surface.js";

const literal = (surface: string) => ({ kind: "literal" as const, surface, evidenceIds: ["evidence.source"], sourceExampleIds: ["example.source"] });
it("preserves owned literals, Unicode, nonspaced scripts and code whitespace with complete shifted child traces", () => {
  const child = composeConstructionSurface([literal("雪🧵e\u0301\u0000")])!;
  const result = composeConstructionSurface([literal("if (x) {\n\t"), { kind: "slot", roleId: "body", constructionId: "child", surface: child }, literal(";\n}\n")])!;
  expect(result.text).toBe("if (x) {\n\t雪🧵e\u0301\u0000;\n}\n");
  expect(constructionSurfaceComplete(result)).toBe(true);
  expect(result.childBindings?.[0]).toMatchObject({ roleId: "body", constructionId: "child", outputStart: 10, outputEnd: 16 });
  expect(result.trace.map(part => result.text.slice(part.outputStart, part.outputEnd))).toEqual(result.trace.map(part => part.surface));
  child.text = "caller mutation";
  expect(result.childBindings?.[0]?.surface.text).toBe("雪🧵e\u0301\u0000");
});
it("retains empty explicit slots and ordered repeated children without aliasing their source metadata", () => {
  const empty = composeConstructionSurface([])!, child = composeConstructionSurface([literal("甲")])!;
  const result = composeConstructionSurface([{ kind: "slot", roleId: "omitted", surface: empty }, { kind: "slot", roleId: "first", surface: child },
    literal("→"), { kind: "slot", roleId: "second", surface: child }])!;
  expect(result.text).toBe("甲→甲"); expect(result.childBindings).toHaveLength(3);
  expect(result.childBindings?.[0]).toMatchObject({ outputStart: 0, outputEnd: 0 });
  (result.childBindings![1]!.surface.trace[0]!.evidenceIds as string[])[0] = "changed";
  expect(result.childBindings![2]!.surface.trace[0]!.evidenceIds).toEqual(["evidence.source"]);
  expect(child.trace[0]!.evidenceIds).toEqual(["evidence.source"]);
});
it("does not turn missing, overlapping, stale or cyclic traces into complete construction surfaces", () => {
  const good = composeConstructionSurface([literal("甲乙")])!;
  for (const invalid of [{ ...good, text: "甲丙" }, { ...good, trace: [] }, { ...good, trace: [...good.trace, ...good.trace] }]) {
    expect(constructionSurfaceComplete(invalid)).toBe(false);
    expect(composeConstructionSurface([{ kind: "slot", roleId: "role", surface: invalid }])).toBeUndefined();
  }
  const cycle = { ...good } as ConstructionSurface;
  cycle.childBindings = [{ roleId: "cycle", outputStart: 0, outputEnd: 2, surface: cycle }];
  expect(constructionSurfaceComplete(cycle)).toBe(false);
});
