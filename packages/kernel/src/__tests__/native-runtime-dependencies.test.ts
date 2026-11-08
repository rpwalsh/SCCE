// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createProgramHydrationContract } from "../program-runtime.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { ProgramGraph } from "../types.js";

function hydration(language: string, source: string) {
  const hasher = createHasher(), ids = createIdFactory({ hasher, clock: createClock(), deterministicReplay: true });
  const path = language === "go" ? "src/program.go" : "src/program.mjs";
  const program: Omit<ProgramGraph, "hydration"> = { id: "program.native-dependencies", language, packageManager: language === "go" ? "go" : "node",
    entrypoint: path, nodes: [], edges: [], files: [{ artifactId: ids.artifactId(source), path,
      mediaType: language === "go" ? "text/x-go" : "text/javascript", content: source, contentHash: ids.contentHash(source), role: "source" }],
    build: { command: language === "go" ? "go" : "node", args: ["check"], cwd: "." },
    test: { command: language === "go" ? "go" : "node", args: ["test"], cwd: "." } };
  return createProgramHydrationContract({ program, sourcePlanId: "plan.native-dependency-unit", ownerRequirementIds: ["owner.native-dependency-unit"] });
}

describe("native runtime dependency scope", () => {
  it("binds actual Go import grammar to the native emitter's declared standard-library modules", () => {
    const result = hydration("go", 'package opaque\nimport (\n checked "testing"\n _ `math/big`\n)\nvar _ = checked.T{}\n');
    expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.dependencies.map(row => [row.packageName, row.dependencyKind, row.missing])).toEqual([
      ["math/big", "program.dependency.native_standard_library", false], ["testing", "program.dependency.native_standard_library", false]
    ]);
  });
  it("does not claim an undeclared third-party Go import is a standard-library dependency", () => {
    const result = hydration("go", 'package opaque\nimport _ "third-party.example/missing"\n');
    expect(result.valid).toBe(false);
    expect(result.dependencies).toMatchObject([{ packageName: "third-party.example/missing", missing: true }]);
  });
  it("retains JavaScript dependency checks for the same module spelling", () => {
    const result = hydration("javascript", 'import "testing";\n');
    expect(result.valid).toBe(false);
    expect(result.dependencies).toMatchObject([{ packageName: "testing", missing: true }]);
  });
  it("does not turn Go comments or raw-string contents into module imports", () => {
    const result = hydration("go", 'package opaque\nimport (\n // "third-party.example/comment"\n _ "math"\n)\nvar text = `import "third-party.example/text"`\n');
    expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.dependencies.map(row => row.packageName)).toEqual(["math"]);
  });
  it("decodes native Go escaped import paths without hiding foreign dependencies",()=>{
    expect(hydration("go",'package opaque\nimport _ "\\x74esting"\n').dependencies).toMatchObject([{packageName:"testing",missing:false}]);
    const foreign=hydration("go",'package opaque\nimport _ "\\164hird-party.example/missing"\n');
    expect(foreign.valid).toBe(false);
    expect(foreign.dependencies).toMatchObject([{packageName:"third-party.example/missing",missing:true}]);
  });

});
