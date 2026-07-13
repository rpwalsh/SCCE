import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { createProgramHydrationContract, hydrationSummary } from "../program-runtime.js";
import { materializeProgramRepair } from "../program-repair-kernel.js";
import type { ArtifactId, ContentHash, FileArtifact, ProgramGraph } from "../types.js";

describe("program repair full-file materialization", () => {
  it("turns a source-bound virtual repair into rehashed full-file ProgramGraph artifacts", () => {
    const hasher = createHasher();
    const source = artifact("src/index.ts", "export const value = (1;\n", hasher);
    const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
      id: "program.repair.fixture",
      language: "typescript",
      packageManager: "pnpm",
      entrypoint: source.path,
      nodes: [{ id: `artifact:${source.path}`, kind: "artifact:source", label: source.path, metadata: { contentHash: source.contentHash } }],
      edges: [],
      files: [source],
      build: { command: "pnpm", args: ["build"], cwd: "." },
      test: { command: "pnpm", args: ["test"], cwd: "." }
    };
    const hydration = createProgramHydrationContract({
      program: graphWithoutHydration,
      sourcePlanId: "program-plan.repair.fixture",
      evidenceIds: ["evidence.repair.fixture"]
    });
    const program: ProgramGraph = {
      ...graphWithoutHydration,
      hydration,
      nodes: [
        ...graphWithoutHydration.nodes,
        { id: "program-hydration", kind: "program_hydration_contract", label: hydration.schema, metadata: hydrationSummary(hydration) }
      ],
      edges: [{ source: "program-plan.repair.fixture", target: "program-hydration", relation: "hydrates_as", weight: 1 }]
    };

    const diagnosticInput = {
      program,
      stderr: "src/index.ts:1:20 syntax error: missing closing delimiter",
      requestText: "Repair the observed syntax error.",
      hasher
    };
    const result = materializeProgramRepair(diagnosticInput);

    expect(result.changedPaths).toEqual([source.path]);
    expect(result.program.files[0]?.content).not.toBe(source.content);
    expect(result.program.files[0]?.contentHash).not.toBe(source.contentHash);
    expect(result.program.hydration?.program.provenanceEvidenceIds).toEqual(["evidence.repair.fixture"]);
    expect(result.program.hydration?.valid).toBe(true);
    expect(result.program.nodes.find(node => node.id === `artifact:${source.path}`)?.metadata)
      .toMatchObject({ contentHash: result.program.files[0]?.contentHash });
    expect(result.program.nodes.filter(node => node.kind === "program_hydration_contract")).toHaveLength(1);
    expect(result.program.nodes.find(node => node.kind === "program_hydration_contract")?.metadata)
      .not.toMatchObject({ source: "stale" });
    expect(result.trace).toMatchObject({
      schema: "scce.program_repair.full_file_materialization.v1",
      sourceProgramId: program.id,
      mutatesRealWorkspace: false,
      validationState: "not_executed"
    });
    expect(result.program.nodes.find(node => node.kind === "program_repair_full_file_materialization")?.metadata)
      .toMatchObject({ schema: "scce.program_repair.full_file_lineage.v1" });

    expect(() => materializeProgramRepair({ ...diagnosticInput, patchSetId: "patchset_forged_arbitrary_bytes" }))
      .toThrow(/internally recomputed repair plan/u);
  });
});

function artifact(path: string, content: string, hasher: ReturnType<typeof createHasher>): FileArtifact {
  const digest = hasher.digestHex(content);
  return {
    artifactId: `artifact_${digest.slice(0, 24)}` as ArtifactId,
    path,
    mediaType: "text/typescript",
    content,
    contentHash: `sha256_${digest}` as ContentHash,
    role: "source"
  };
}
