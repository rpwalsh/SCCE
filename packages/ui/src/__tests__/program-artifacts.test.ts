// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { renderWorkbench } from "../index.js";
import { programArtifactsFromTurn } from "../workbench-model.js";

describe("program artifact presentation contract", () => {
  it("accepts only the file set named by a ready response", () => {
    const turn = readyTurn();
    expect(programArtifactsFromTurn(turn)).toEqual(turn.programArtifacts);
  });

  it("rejects unready, incomplete, mismatched, and unsafe file sets", () => {
    const turn = readyTurn();
    expect(programArtifactsFromTurn({ ...turn, programReadiness: { ...turn.programReadiness, status: "not_ready" } })).toEqual([]);
    expect(programArtifactsFromTurn({ ...turn, programReadiness: { ...turn.programReadiness, artifactCount: 3 } })).toEqual([]);
    expect(programArtifactsFromTurn({ ...turn, programArtifacts: [{ ...turn.programArtifacts[0]!, path: "../outside.ts" }] })).toEqual([]);
    expect(programArtifactsFromTurn({ ...turn, programArtifacts: [{ ...turn.programArtifacts[0]!, artifactId: "artifact.foreign" }] })).toEqual([]);
  });

  it("renders validated source and tests as text and revokes generated download URLs", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain("link.textContent = artifact.path");
    expect(html).toContain("preview.textContent = artifact.content");
    expect(html).toContain("programArtifactsFromTurn(r).length > 0");
    expect(html).toContain("URL.revokeObjectURL(url)");
  });
});

function readyTurn() {
  const programArtifacts = [
    { artifactId: "artifact.source", path: "src/program.ts", mediaType: "text/typescript", content: "export const value = 1;", contentHash: "sha256_source", role: "source" },
    { artifactId: "artifact.test", path: "test/program.test.ts", mediaType: "text/typescript", content: "if (value !== 1) throw new Error();", contentHash: "sha256_test", role: "test" }
  ];
  return {
    programReadiness: { schema: "scce.program.response_readiness.v1", status: "ready", reasonId: "program.readiness.verified", artifactCount: 2, artifactIds: programArtifacts.map(artifact => artifact.artifactId) },
    programArtifacts
  };
}
