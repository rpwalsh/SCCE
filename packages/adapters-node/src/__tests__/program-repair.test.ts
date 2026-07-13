import { describe, expect, it } from "vitest";
import { repairProgramArtifacts } from "../program-repair.js";
import type { FileArtifact } from "@scce/kernel";

describe("program repair planner", () => {
  it("normalizes syntax failures without inventing new files", () => {
    const artifact: FileArtifact = { artifactId: "artifact_test" as never, path: "src/index.mjs", mediaType: "text/javascript", role: "source", contentHash: "sha256_old" as never, content: "export const x = { a: 1, }" };
    const result = repairProgramArtifacts([artifact], "SyntaxError: Unexpected token");
    expect(result.changed).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.applied[0]?.path).toBe("src/index.mjs");
  });

  it("never changes test assertions to make an assertion failure pass", () => {
    const content = [
      'import assert from "node:assert/strict";',
      'assert.equal(result.count, 17);',
      'assert.match(result.message, /promoted evidence/);',
      ""
    ].join("\n");
    const artifact: FileArtifact = {
      artifactId: "artifact_test_contract" as never,
      path: "test/runtime.test.mjs",
      mediaType: "text/javascript",
      role: "test",
      contentHash: "sha256_test_contract" as never,
      content
    };

    const result = repairProgramArtifacts([artifact], "AssertionError: expected 12 to equal 17\ntest/runtime.test.mjs:2");

    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.artifacts[0]?.content).toBe(content);
  });
});
